// POST /api/webhook-bold
// Fuente de verdad para el estado de pagos Bold.
// Referencia oficial: https://developers.bold.co/webhook

const catalogo = require('../lib/catalogo');
const { leerCuerpoCrudo, verificarFirmaWebhook } = require('../lib/bold');
const { processBoldEvent } = require('../lib/bold-orders');
const { enviarEventoCompra } = require('../lib/meta');
const { notificarPedidoAprobado } = require('../lib/telegram');
const { notifyOrder } = require('../lib/email');

const TIPOS_CONOCIDOS = ['SALE_APPROVED', 'SALE_REJECTED', 'VOID_APPROVED', 'VOID_REJECTED'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });

  // El HMAC cubre los bytes exactos enviados por Bold. No acceder a req.body
  // antes de leer el stream crudo.
  const rawBody = await leerCuerpoCrudo(req);
  const secret = process.env.BOLD_WEBHOOK_SECRET;
  if (secret === undefined) {
    console.error('BOLD_WEBHOOK_SECRET no configurado: no se puede validar el webhook');
    return res.status(500).json({ ok: false, error: 'Webhook no configurado' });
  }
  if (!verificarFirmaWebhook(rawBody, req.headers['x-bold-signature'], secret)) {
    console.error('Webhook de Bold con firma invalida, ignorado');
    return res.status(400).json({ ok: false, error: 'Firma invalida' });
  }

  let payload;
  try { payload = JSON.parse(rawBody.toString('utf8')); }
  catch { return res.status(400).json({ ok: false, error: 'JSON invalido' }); }

  const type = payload.type;
  if (!TIPOS_CONOCIDOS.includes(type)) {
    return res.status(200).json({ ok: true, ignorado: type || 'desconocido' });
  }

  const data = payload.data;
  const reference = data?.metadata?.reference;
  if (!reference) return res.status(200).json({ ok: true, ignorado: 'sin referencia' });

  try {
    // processBoldEvent comparte lock con la limpieza de vencimientos. Guarda
    // el pedido antes de cualquier llamada externa y deduplica reintentos.
    const result = await processBoldEvent(String(reference), {
      type,
      eventId: payload.id || null,
      paymentId: data.payment_id || null,
      amount: data.amount || null,
      createdAt: data.created_at || null,
    });

    if (result.review && !result.duplicate) {
      console.error(`Pago Bold requiere revision manual (${reference}): ${result.order.motivoRevision}`);
      try { await notifyOrder(result.order); }
      catch (emailError) { console.error(`No se pudo notificar la revision ${reference}:`, emailError.message); }
    }

    if (result.approved && !result.duplicate) {
      const order = result.order;
      const eventTimeMs = data.created_at ? new Date(data.created_at).getTime() : Date.now();
      const eventTime = Number.isFinite(eventTimeMs) ? Math.floor(eventTimeMs / 1000) : Math.floor(Date.now() / 1000);

      // Estas integraciones ya no corren una tras otra. El pedido y el stock
      // quedaron confirmados primero; un fallo de aviso no revierte la venta.
      const notifications = await Promise.allSettled([
        enviarEventoCompra({
          referencia: String(reference),
          total: order.total,
          moneda: catalogo.moneda,
          email: order.cliente.email,
          telefono: order.cliente.telefono,
          ip: order.ip,
          userAgent: order.userAgent,
          eventTime,
        }),
        notificarPedidoAprobado({
          referencia: String(reference),
          total: order.total,
          items: order.items,
          cliente: order.cliente,
        }),
        notifyOrder(order),
      ]);
      notifications.forEach((notification, index) => {
        if (notification.status === 'rejected') {
          console.error(`Fallo la notificacion ${index + 1} de ${reference}:`, notification.reason?.message || notification.reason);
        }
      });
    }
  } catch (error) {
    console.error('Error procesando webhook de Bold:', error);
    // 500 pide a Bold reintentar si Redis tuvo un fallo transitorio.
    return res.status(500).json({ ok: false });
  }

  return res.status(200).json({ ok: true });
};
