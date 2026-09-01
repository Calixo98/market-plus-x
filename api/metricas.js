// GET /api/metricas
// Agregados operativos de solo lectura para la sección de métricas de Agente X.

const kv = require('../lib/kv');
const { getOrderWithCrm } = require('../lib/crm-orders');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BOLD_STATES = new Set(['SALE_APPROVED', 'SALE_REJECTED', 'SALE_APPROVED_REVIEW', 'SALE_APPROVED_STOCK_REVIEW', 'VOID_APPROVED', 'VOID_REJECTED']);
const CONFIRMED_CRM_STATES = new Set(['CONFIRMED', 'IN_FOLLOW_UP', 'DISPATCHED', 'COMPLETED']);

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store');
}

function isAuthorized(req) {
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const allowed = [process.env.ADMIN_TOKEN, process.env.MARKETPLUS_INTERNAL_SECRET]
    .filter(Boolean);
  return Boolean(provided && allowed.includes(provided));
}

function dateKey(value) {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'America/Bogota',
  }).format(new Date(value));
}

function todayKey() {
  return dateKey(new Date());
}

function shiftDate(date, days) {
  const value = new Date(`${date}T12:00:00-05:00`);
  value.setUTCDate(value.getUTCDate() + days);
  return dateKey(value);
}

function rangeFromQuery(req) {
  const today = todayKey();
  const from = String(req.query?.from || shiftDate(today, -29));
  const to = String(req.query?.to || today);
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) throw Object.assign(new Error('Rango de fechas invalido'), { statusCode: 400 });

  const fromDate = new Date(`${from}T00:00:00-05:00`);
  const toExclusive = new Date(`${shiftDate(to, 1)}T00:00:00-05:00`);
  if (!Number.isFinite(fromDate.getTime()) || !Number.isFinite(toExclusive.getTime()) || fromDate >= toExclusive) {
    throw Object.assign(new Error('Rango de fechas invalido'), { statusCode: 400 });
  }
  if ((toExclusive.getTime() - fromDate.getTime()) > 366 * 24 * 60 * 60 * 1000) {
    throw Object.assign(new Error('El rango no puede superar 366 dias'), { statusCode: 400 });
  }
  return { from, to, fromMs: fromDate.getTime(), toMs: toExclusive.getTime() };
}

function addToMap(map, key, total) {
  const current = map.get(key) || { count: 0, totalCop: 0 };
  current.count += 1;
  current.totalCop += Number.isFinite(total) ? total : 0;
  map.set(key, current);
}

function emptyDay(date) {
  return { date, orders: 0, confirmed: 0, completed: 0, salesCop: 0 };
}

function orderMethod(order) {
  if (order.metodo === 'contraentrega') return 'contraentrega';
  if (!order.metodo && BOLD_STATES.has(order.estado)) return 'bold';
  return String(order.metodo || 'otro').toLowerCase();
}

function isConfirmed(order, crmStatus) {
  return order.estado === 'SALE_APPROVED'
    || order.estado === 'COD_CONFIRMED'
    || CONFIRMED_CRM_STATES.has(crmStatus);
}

function isCancelled(order, crmStatus) {
  return order.estado === 'COD_CANCELLED'
    || order.estado === 'VOID_APPROVED'
    || crmStatus === 'CANCELLED';
}

function isRejected(order, crmStatus) {
  return Boolean(order.requiereRevision)
    || order.estado === 'SALE_REJECTED'
    || order.estado === 'SALE_APPROVED_REVIEW'
    || order.estado === 'SALE_APPROVED_STOCK_REVIEW'
    || crmStatus === 'REJECTED';
}

module.exports = async (req, res) => {
  noStore(res);
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Metodo no permitido' });
  if (!isAuthorized(req)) return res.status(401).json({ ok: false, error: 'No autorizado' });

  try {
    const range = rangeFromQuery(req);
    const keys = (await kv.scanAll('pedido:*')).filter(key => /^pedido:[^:]+$/.test(key));
    const orders = (await Promise.all(keys.map(async key => {
      const reference = key.slice('pedido:'.length);
      const order = await getOrderWithCrm(reference);
      if (!order) return null;
      const createdAt = new Date(order.creadoEn || order.confirmadoEn || 0).getTime();
      return Number.isFinite(createdAt) && createdAt >= range.fromMs && createdAt < range.toMs ? order : null;
    }))).filter(Boolean);

    const daily = new Map();
    for (let date = range.from; date <= range.to; date = shiftDate(date, 1)) daily.set(date, emptyDay(date));
    const byPaymentMethod = new Map();
    const byCrmStatus = new Map();
    const summary = {
      ordersCreated: 0,
      ordersConfirmed: 0,
      ordersCompleted: 0,
      ordersCancelled: 0,
      ordersRejected: 0,
      codPending: 0,
      codConfirmed: 0,
      boldApproved: 0,
      boldReview: 0,
      ordersCreatedCop: 0,
      confirmedCop: 0,
      completedCop: 0,
    };

    for (const order of orders) {
      const total = Number(order.total || order.montoRecibido || 0);
      const safeTotal = Number.isFinite(total) ? total : 0;
      const method = orderMethod(order);
      const crmStatus = String(order.crmStatus || 'NEW');
      const day = daily.get(dateKey(order.creadoEn || order.confirmadoEn));
      const confirmed = isConfirmed(order, crmStatus);
      const cancelled = isCancelled(order, crmStatus);
      const rejected = isRejected(order, crmStatus);

      summary.ordersCreated += 1;
      summary.ordersCreatedCop += safeTotal;
      addToMap(byPaymentMethod, method, safeTotal);
      addToMap(byCrmStatus, crmStatus, safeTotal);
      if (day) day.orders += 1;

      if (order.estado === 'COD_PENDING_CONFIRMATION' && new Date(order.expiraEn || 0).getTime() > Date.now()) summary.codPending += 1;
      if (order.estado === 'COD_CONFIRMED') summary.codConfirmed += 1;
      if (method === 'bold' && order.estado === 'SALE_APPROVED') summary.boldApproved += 1;
      if (method === 'bold' && order.requiereRevision) summary.boldReview += 1;
      if (confirmed) {
        summary.ordersConfirmed += 1;
        summary.confirmedCop += safeTotal;
        if (day) {
          day.confirmed += 1;
          day.salesCop += safeTotal;
        }
      }
      if (crmStatus === 'COMPLETED') {
        summary.ordersCompleted += 1;
        summary.completedCop += safeTotal;
        if (day) day.completed += 1;
      }
      if (cancelled) summary.ordersCancelled += 1;
      if (rejected) summary.ordersRejected += 1;
    }

    return res.status(200).json({
      ok: true,
      range: { from: range.from, to: range.to },
      summary,
      byPaymentMethod: [...byPaymentMethod.entries()].map(([method, value]) => ({ method, ...value })),
      byCrmStatus: [...byCrmStatus.entries()].map(([status, value]) => ({ status, ...value })),
      daily: [...daily.values()],
    });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error('Error consultando métricas de pedidos:', error);
    return res.status(status).json({ ok: false, error: status < 500 ? error.message : 'No se pudieron consultar las métricas' });
  }
};
