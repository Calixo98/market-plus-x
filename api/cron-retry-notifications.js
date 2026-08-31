const kv = require('../../lib/kv');
const { notifyOrder } = require('../../lib/email');
const catalogo = require('../../lib/catalogo');
const { expireCodOrders } = require('../../lib/orders');
const { enviarEventoCompra } = require('../../lib/meta');
const { notificarPedidoAprobado } = require('../../lib/telegram');

const STALE_CLAIM_MS = 10 * 60 * 1000;

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  const production = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
  if (!secret && production) return false;
  return !secret || req.headers.authorization === `Bearer ${secret}`;
}

function retryable(order, channel) {
  if (!order || !order.referencia) return false;
  const status = order[`${channel}NotificationStatus`];
  if (status === 'pending' || status === 'failed') return true;
  return status === 'sending'
    && Date.now() - new Date(order[`${channel}NotificationClaimedAt`] || 0).getTime() >= STALE_CLAIM_MS;
}

function notificationCall(channel, order) {
  if (channel === 'email') return notifyOrder(order);
  if (channel === 'meta') return enviarEventoCompra({
    referencia: order.referencia,
    total: order.total,
    moneda: catalogo.moneda,
    email: order.cliente?.email,
    telefono: order.cliente?.telefono,
    ip: order.ip,
    userAgent: order.userAgent,
    eventTime: Math.floor(new Date(order.confirmadoEn || order.creadoEn || Date.now()).getTime() / 1000),
  });
  return notificarPedidoAprobado({ referencia: order.referencia, total: order.total, items: order.items, cliente: order.cliente });
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ ok: false });
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'No autorizado' });

  // La limpieza corre fuera de las rutas públicas. Las reservas activas no
  // tienen TTL físico; solo después de liberar inventario se aplica el TTL de
  // respaldo, evitando que una clave desaparezca con stock aún descontado.
  await catalogo.liberarReservasVencidas();
  await expireCodOrders();

  const keys = (await kv.scanAll('pedido:*')).filter(key => /^pedido:[^:]+$/.test(key));
  let retried = 0;
  let sent = 0;
  let failed = 0;

  for (const key of keys) {
    const raw = await kv.get(key);
    let order;
    try { order = raw ? JSON.parse(raw) : null; } catch { continue; }
    if (!['email', 'meta', 'telegram'].some(channel => retryable(order, channel))) continue;

    await kv.withLock(`lock:${key}`, async () => {
      const currentRaw = await kv.get(key);
      let current;
      try { current = currentRaw ? JSON.parse(currentRaw) : null; } catch { return; }
      for (const channel of ['email', 'meta', 'telegram']) {
        if (!retryable(current, channel)) continue;
        retried++;
        const prefix = `${channel}Notification`;
        current[`${prefix}Status`] = 'sending';
        current[`${prefix}ClaimedAt`] = new Date().toISOString();
        current[`${prefix}Attempts`] = Number(current[`${prefix}Attempts`] || 0) + 1;
        await kv.set(key, JSON.stringify(current));
        try {
          const result = await notificationCall(channel, current);
          if (channel !== 'email' && result === false) throw new Error(`${channel} rechazo la notificacion`);
          if (channel === 'email') current.emailNotificationId = result;
          current[`${prefix}Status`] = 'sent';
          current[`${prefix}Error`] = null;
          current[`${prefix}ClaimedAt`] = null;
          sent++;
        } catch (error) {
          current[`${prefix}Status`] = 'failed';
          current[`${prefix}Error`] = String(error.message || error);
          failed++;
        }
        await kv.set(key, JSON.stringify(current));
      }
    }, { ttlSeconds: 120 });
  }

  return res.status(200).json({ ok: true, scanned: keys.length, retried, sent, failed });
};
