// POST /api/webhook-wompi
// Wompi llama esta URL cuando una transaccion cambia de estado (evento
// `transaction.updated`). Esta es la UNICA fuente de verdad para dar una
// venta por confirmada: la redireccion al cliente es solo informativa.
//
// Referencia: https://docs.wompi.co/docs/colombia/eventos/
//
// Configurar en el dashboard de Wompi -> Eventos:
//   https://marketplusx.com/api/webhook-wompi

const kv = require('../lib/kv');
const { validarChecksumEvento } = require('../lib/wompi');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });

  let payload = req.body;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch {
      return res.status(400).json({ ok: false, error: 'JSON invalido' });
    }
  }
  if (!payload || typeof payload !== 'object') return res.status(400).json({ ok: false });

  // Solo nos interesa la actualizacion de transacciones.
  if (payload.event !== 'transaction.updated') {
    return res.status(200).json({ ok: true, ignorado: payload.event || 'desconocido' });
  }

  const secretoEventos = process.env.WOMPI_EVENTS_SECRET;
  if (!secretoEventos) {
    console.error('WOMPI_EVENTS_SECRET no configurado: no se puede validar el webhook');
    return res.status(200).json({ ok: true }); // 200 para que Wompi no reintente sin parar
  }

  const checksumValido = validarChecksumEvento(payload, secretoEventos);
  if (!checksumValido) {
    console.error('Webhook de Wompi con checksum invalido, ignorado', payload.data && payload.data.transaction && payload.data.transaction.id);
    return res.status(200).json({ ok: true, aceptado: false });
  }

  const tx = payload.data && payload.data.transaction;
  if (!tx || !tx.reference) return res.status(200).json({ ok: true });

  const { id: transaccionId, status, reference, amount_in_cents: amountInCents } = tx;

  try {
    const reservaRaw = await kv.get(`reserva:${reference}`);

    if (reservaRaw) {
      const reserva = JSON.parse(reservaRaw);

      if (status === 'APPROVED') {
        for (const item of reserva.items) {
          await kv.incrby(`vendido:${item.sku}`, item.qty);
        }
      }

      await kv.set(
        `pedido:${reference}`,
        JSON.stringify({
          referencia: reference,
          transaccionId,
          estado: status,
          amountInCents,
          ...reserva,
          confirmadoEn: new Date().toISOString(),
        })
      );
      await kv.del(`reserva:${reference}`);
    } else {
      // La reserva ya no existe: o se proceso antes (idempotencia) o expiro (15 min)
      // antes de que llegara este evento. Guardamos igual para no perder el registro
      // de una venta real y marcamos para revision manual si aprueba.
      const pedidoExistente = await kv.get(`pedido:${reference}`);
      if (!pedidoExistente) {
        await kv.set(
          `pedido:${reference}`,
          JSON.stringify({
            referencia: reference,
            transaccionId,
            estado: status,
            amountInCents,
            confirmadoEn: new Date().toISOString(),
            advertencia: status === 'APPROVED'
              ? 'Sin reserva asociada (probablemente expiró antes del pago). Revisar manualmente qué producto correspondía a esta referencia.'
              : null,
          })
        );
      }
    }
  } catch (err) {
    console.error('Error procesando webhook de Wompi:', err);
    // Igual respondemos 200: si es un error transitorio de KV, Wompi reintentara
    // (hasta 3 veces en 24h) y el proximo intento puede tener exito.
  }

  return res.status(200).json({ ok: true });
};
