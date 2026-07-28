// POST /api/webhook-wompi
// Wompi llama esta URL cuando una transaccion cambia de estado (evento
// `transaction.updated`). Esta es la UNICA fuente de verdad para dar una
// venta por confirmada: la redireccion al cliente es solo informativa.
//
// Referencia: https://docs.wompi.co/docs/colombia/eventos/
//
// Configurar en el dashboard de Wompi -> Eventos:
//   https://marketplusx.com/api/webhook-wompi
//
// Estados posibles de `transaction.status` y como los tratamos:
//   APPROVED  -> venta confirmada. Se queda el stock descontado (ya se resto
//                al reservar) y se registra en vendido:{sku} para reportes.
//   PENDING   -> tipico de PSE/Nequi/Bancolombia mientras el banco confirma.
//                NO se libera el stock: solo se extiende la ventana de espera,
//                porque la confirmacion puede tardar mas que el checkout con tarjeta.
//   DECLINED / VOIDED / ERROR -> se libera el stock retenido.

const kv = require('../lib/kv');
const catalogo = require('../lib/catalogo');
const { validarChecksumEvento } = require('../lib/wompi');

const EXTENSION_PENDING_SEGUNDOS = 2 * 60 * 60; // 2h de margen para que el banco confirme

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });

  let payload = req.body;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch {
      return res.status(400).json({ ok: false, error: 'JSON invalido' });
    }
  }
  if (!payload || typeof payload !== 'object') return res.status(400).json({ ok: false });

  // Solo nos interesa la actualizacion de transacciones. Otros eventos se
  // confirman con 200 para que Wompi no los reintente (no hay nada que hacer).
  if (payload.event !== 'transaction.updated') {
    return res.status(200).json({ ok: true, ignorado: payload.event || 'desconocido' });
  }

  const secretoEventos = process.env.WOMPI_EVENTS_SECRET;
  if (!secretoEventos) {
    console.error('WOMPI_EVENTS_SECRET no configurado: no se puede validar el webhook');
    // 500 (no 200): esto es un error NUESTRO de configuracion. Queremos que
    // Wompi reintente durante 24h por si lo arreglamos a tiempo, en vez de
    // perder la venta en silencio.
    return res.status(500).json({ ok: false, error: 'Webhook no configurado' });
  }

  const checksumValido = validarChecksumEvento(payload, secretoEventos);
  if (!checksumValido) {
    console.error('Webhook de Wompi con checksum invalido, ignorado', payload.data && payload.data.transaction && payload.data.transaction.id);
    // 400, no 200: es un payload no autenticado (o un secreto mal copiado).
    // Reintentar no ayuda si es un ataque, y si es un secreto mal copiado
    // preferimos verlo fallar alto y claro en los logs, no silenciarlo con 200.
    return res.status(400).json({ ok: false, error: 'Checksum invalido' });
  }

  const tx = payload.data && payload.data.transaction;
  if (!tx || !tx.reference) return res.status(200).json({ ok: true });

  const { id: transaccionId, status, reference, amount_in_cents: amountInCents } = tx;

  try {
    const reservaRaw = await kv.get(`reserva:${reference}`);

    if (reservaRaw) {
      const reserva = JSON.parse(reservaRaw);

      if (status === 'APPROVED') {
        const montoEsperado = Math.round(reserva.total * 100);
        const montoCoincide = amountInCents === montoEsperado;
        if (!montoCoincide) {
          console.error(`Discrepancia de monto en ${reference}: esperado ${montoEsperado}, recibido ${amountInCents}`);
        }

        for (const item of reserva.items) {
          await kv.incrby(`vendido:${item.sku}`, item.qty);
        }
        await kv.set(
          `pedido:${reference}`,
          JSON.stringify({
            referencia: reference,
            transaccionId,
            estado: status,
            amountInCents,
            montoCoincide,
            ...reserva,
            confirmadoEn: new Date().toISOString(),
          })
        );
        await kv.del(`reserva:${reference}`);
      } else if (status === 'PENDING') {
        // El pago sigue en proceso (comun en PSE/Nequi/Bancolombia). NO se
        // libera el stock: solo se extiende el plazo de la reserva para que
        // la confirmacion tardía del banco no choque con la ventana original.
        reserva.expiraEn = new Date(Date.now() + EXTENSION_PENDING_SEGUNDOS * 1000).toISOString();
        reserva.ultimoEstadoConocido = 'PENDING';
        await kv.set(`reserva:${reference}`, JSON.stringify(reserva));
        await kv.expire(`reserva:${reference}`, catalogo.RESERVA_TTL_RESPALDO_SEGUNDOS);
      } else {
        // DECLINED / VOIDED / ERROR: liberar el stock retenido.
        await catalogo.liberarStock(reserva.items);
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
      }
    } else {
      // La reserva ya no existe: se proceso antes (idempotencia), o expiro y
      // fue reconciliada antes de que llegara este evento. Guardamos igual
      // para no perder el registro de una venta real y marcamos para revision
      // manual si aprueba (el stock de esa reconciliacion ya se liberó solo,
      // asi que aqui NO se debe volver a tocar el contador).
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
              ? 'Sin reserva asociada (probablemente expiró antes del pago). Revisar manualmente qué producto correspondía a esta referencia; el stock pudo haberse liberado de más.'
              : null,
          })
        );
      }
    }
  } catch (err) {
    console.error('Error procesando webhook de Wompi:', err);
    // 500, no 200: si es un fallo transitorio de Redis, Wompi reintentara
    // (hasta 3 veces en 24h) y el proximo intento puede tener exito. Devolver
    // 200 aqui perderia la venta en silencio.
    return res.status(500).json({ ok: false });
  }

  return res.status(200).json({ ok: true });
};
