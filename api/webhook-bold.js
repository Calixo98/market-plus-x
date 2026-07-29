// POST /api/webhook-bold
// Bold llama esta URL cuando una venta hecha por Link de Pagos cambia de
// estado. Esta es la UNICA fuente de verdad para dar una venta por
// confirmada: la redireccion al cliente (bold-order-id/bold-tx-status) es
// solo informativa.
//
// Referencia: https://developers.bold.co/webhook
//
// Configurar en el Panel de Comercios -> Integraciones -> Webhooks:
//   https://marketplusx.com/api/webhook-bold
//
// A diferencia de Wompi, Bold solo notifica 4 estados (no existe "pendiente"
// para este tipo de pago):
//   SALE_APPROVED -> venta confirmada. El stock ya se desconto al reservar;
//                    aqui solo se registra en vendido:{sku} para reportes.
//   SALE_REJECTED / VOID_APPROVED / VOID_REJECTED -> se libera el stock retenido.
//
// Bold exige responder 200 en menos de 2 segundos o reintenta (hasta 5 veces
// en 24h) — por eso el trabajo aqui es minimo (unas pocas idas a Redis).

const kv = require('../lib/kv');
const catalogo = require('../lib/catalogo');
const { leerCuerpoCrudo, verificarFirmaWebhook } = require('../lib/bold');

const TIPOS_CONOCIDOS = ['SALE_APPROVED', 'SALE_REJECTED', 'VOID_APPROVED', 'VOID_REJECTED'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });

  // Importante: no tocar req.body en ningun punto de este archivo (ni antes
  // ni despues). El getter de @vercel/node consume el stream para parsearlo
  // el mismo, y si lo dispara primero, leerCuerpoCrudo() ya no tiene nada
  // que leer. El HMAC de Bold firma los bytes crudos, no un JSON reconstruido.
  const cuerpoCrudo = await leerCuerpoCrudo(req);

  // El secreto vive SOLO en esta variable de entorno. En sandbox, Bold firma
  // con clave vacia sin importar el valor de tu llave secreta de pruebas
  // (documentado explicitamente por Bold): por eso BOLD_WEBHOOK_SECRET se
  // deja en '' mientras se prueba, y se reemplaza por el secreto real de
  // produccion recien al pasar a produccion.
  const secreto = process.env.BOLD_WEBHOOK_SECRET;
  if (secreto === undefined) {
    console.error('BOLD_WEBHOOK_SECRET no configurado: no se puede validar el webhook');
    // 500 (no 200): error NUESTRO de configuracion. Queremos que Bold
    // reintente en vez de perder la venta en silencio.
    return res.status(500).json({ ok: false, error: 'Webhook no configurado' });
  }

  const firmaRecibida = req.headers['x-bold-signature'];
  if (!verificarFirmaWebhook(cuerpoCrudo, firmaRecibida, secreto)) {
    console.error('Webhook de Bold con firma invalida, ignorado');
    // 400, no 200: payload no autenticado (o secreto mal copiado). Reintentar
    // no ayuda si es un ataque, y si es un secreto mal copiado preferimos
    // verlo fallar alto y claro en los logs, no silenciarlo con 200.
    return res.status(400).json({ ok: false, error: 'Firma invalida' });
  }

  let payload;
  try {
    payload = JSON.parse(cuerpoCrudo.toString('utf8'));
  } catch {
    return res.status(400).json({ ok: false, error: 'JSON invalido' });
  }

  const tipo = payload.type;
  if (!TIPOS_CONOCIDOS.includes(tipo)) {
    return res.status(200).json({ ok: true, ignorado: tipo || 'desconocido' });
  }

  const datos = payload.data;
  const referencia = datos && datos.metadata && datos.metadata.reference;
  if (!referencia) return res.status(200).json({ ok: true });

  const paymentId = datos.payment_id;
  const montoRecibido = datos.amount && datos.amount.total;

  try {
    const reservaRaw = await kv.get(`reserva:${referencia}`);

    if (reservaRaw) {
      const reserva = JSON.parse(reservaRaw);

      if (tipo === 'SALE_APPROVED') {
        const montoCoincide = montoRecibido === reserva.total;
        if (!montoCoincide) {
          console.error(`Discrepancia de monto en ${referencia}: esperado ${reserva.total}, recibido ${montoRecibido}`);
        }

        for (const item of reserva.items) {
          await kv.incrby(`vendido:${item.sku}`, item.qty);
        }
        await kv.set(
          `pedido:${referencia}`,
          JSON.stringify({
            referencia,
            paymentId,
            estado: tipo,
            montoRecibido,
            montoCoincide,
            ...reserva,
            confirmadoEn: new Date().toISOString(),
          })
        );
        await kv.del(`reserva:${referencia}`);
      } else {
        // SALE_REJECTED / VOID_APPROVED / VOID_REJECTED: liberar el stock retenido.
        await catalogo.liberarStock(reserva.items);
        await kv.set(
          `pedido:${referencia}`,
          JSON.stringify({
            referencia,
            paymentId,
            estado: tipo,
            montoRecibido,
            ...reserva,
            confirmadoEn: new Date().toISOString(),
          })
        );
        await kv.del(`reserva:${referencia}`);
      }
    } else {
      // La reserva ya no existe: se proceso antes (idempotencia — Bold puede
      // reenviar la misma notificacion hasta 5 veces), o expiro y fue
      // reconciliada antes de que llegara este evento.
      const pedidoExistente = await kv.get(`pedido:${referencia}`);
      if (!pedidoExistente) {
        await kv.set(
          `pedido:${referencia}`,
          JSON.stringify({
            referencia,
            paymentId,
            estado: tipo,
            montoRecibido,
            confirmadoEn: new Date().toISOString(),
            advertencia: tipo === 'SALE_APPROVED'
              ? 'Sin reserva asociada (probablemente expiró antes del pago). Revisar manualmente qué producto correspondía a esta referencia; el stock pudo haberse liberado de más.'
              : null,
          })
        );
      }
    }
  } catch (err) {
    console.error('Error procesando webhook de Bold:', err);
    // 500, no 200: si es un fallo transitorio de Redis, Bold reintentara
    // (hasta 5 veces en 24h) y el proximo intento puede tener exito.
    return res.status(500).json({ ok: false });
  }

  return res.status(200).json({ ok: true });
};
