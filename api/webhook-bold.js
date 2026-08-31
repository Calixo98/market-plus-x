// POST /api/webhook-bold
// Fuente de verdad para el estado de pagos Bold.
// Referencia oficial: https://developers.bold.co/webhook

const catalogo = require('../lib/catalogo');
const kv = require('../lib/kv');
const { leerCuerpoCrudo, verificarFirmaWebhook } = require('../lib/bold');
const { processBoldEvent } = require('../lib/bold-orders');
const { saveNotificationResult } = require('../lib/orders');
const { enviarEventoCompra } = require('../lib/meta');
const { notificarPedidoAprobado } = require('../lib/telegram');
const { notifyOrder } = require('../lib/email');

const TIPOS_CONOCIDOS = ['SALE_APPROVED', 'SALE_REJECTED', 'VOID_APPROVED', 'VOID_REJECTED'];
const NOTIFICATION_DEADLINE_MS = 1100;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });

  // El HMAC cubre los bytes exactos enviados por Bold. No acceder a req.body
  // antes de leer el stream crudo.
  const rawBody = await leerCuerpoCrudo(req);
  const secret = process.env.BOLD_WEBHOOK_SECRET;
  const production = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
  if (secret === undefined || (production && !String(secret).trim())) {
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
  let reference = data?.metadata?.reference || data?.reference || data?.external_reference;
  if (reference && !String(reference).startsWith('MPX-')) {
    // API Link puede reportar el identificador LNK_* en metadata.reference;
    // el checkout guarda la correspondencia con la referencia MPX externa.
    reference = await kv.get(`bold-link:${String(reference)}`) || reference;
  }
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
      const emailWork = notifyOrder(result.order)
        .then(emailNotificationId => ({ status: 'sent', emailNotificationId }))
        .catch(emailError => ({ status: 'failed', emailNotificationError: String(emailError.message || emailError) }));
      const emailResult = await Promise.race([
        emailWork,
        new Promise(resolve => setTimeout(() => resolve({ status: 'pending' }), NOTIFICATION_DEADLINE_MS)),
      ]);
      await saveNotificationResult(`pedido:${String(reference)}`, emailResult.status === 'sent'
        ? { emailNotificationId: emailResult.emailNotificationId, emailNotificationStatus: 'sent', emailNotificationError: null }
        : emailResult.status === 'failed'
          ? { emailNotificationStatus: 'failed', emailNotificationError: emailResult.emailNotificationError }
          : { emailNotificationStatus: 'pending', notificationDeferredAt: new Date().toISOString() });
      if (emailResult.status === 'failed') console.error(`No se pudo notificar la revision ${reference}:`, emailResult.emailNotificationError);
    }

    if (result.approved && !result.duplicate) {
      const order = result.order;
      const eventTimeMs = data.created_at ? new Date(data.created_at).getTime() : Date.now();
      const eventTime = Number.isFinite(eventTimeMs) ? Math.floor(eventTimeMs / 1000) : Math.floor(Date.now() / 1000);

      // Estas integraciones ya no corren una tras otra. El pedido y el stock
      // quedaron confirmados primero; un fallo de aviso no revierte la venta.
      const notificationWork = Promise.allSettled([
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
      const notifications = await Promise.race([
        notificationWork,
        new Promise(resolve => setTimeout(() => resolve(null), NOTIFICATION_DEADLINE_MS)),
      ]);
      const notificationResult = notifications
        ? (() => {
          notifications.forEach((notification, index) => {
            if (notification.status === 'rejected') {
              console.error(`Fallo la notificacion ${index + 1} de ${reference}:`, notification.reason?.message || notification.reason);
            }
          });
          const [metaNotification, telegramNotification, emailNotification] = notifications;
          return {
            metaNotificationStatus: metaNotification.status === 'fulfilled' && metaNotification.value !== false ? 'sent' : 'failed',
            metaNotificationError: metaNotification.status === 'rejected' ? String(metaNotification.reason?.message || metaNotification.reason) : null,
            telegramNotificationStatus: telegramNotification.status === 'fulfilled' && telegramNotification.value !== false ? 'sent' : 'failed',
            telegramNotificationError: telegramNotification.status === 'rejected' ? String(telegramNotification.reason?.message || telegramNotification.reason) : null,
            ...(emailNotification.status === 'fulfilled'
              ? { emailNotificationId: emailNotification.value, emailNotificationStatus: 'sent', emailNotificationError: null }
              : { emailNotificationStatus: 'failed', emailNotificationError: String(emailNotification.reason?.message || emailNotification.reason) }),
          };
        })()
        : {
          metaNotificationStatus: 'pending',
          telegramNotificationStatus: 'pending',
          emailNotificationStatus: 'pending',
          notificationDeferredAt: new Date().toISOString(),
        };
      await saveNotificationResult(`pedido:${String(reference)}`, notificationResult);
    }
  } catch (error) {
    console.error('Error procesando webhook de Bold:', error);
    // 500 pide a Bold reintentar si Redis tuvo un fallo transitorio.
    return res.status(500).json({ ok: false });
  }

  return res.status(200).json({ ok: true });
};
