// GET /api/pedidos
// PATCH /api/pedidos
// Panel administrativo de pedidos y estado operativo CRM.

const kv = require('../lib/kv');
const { expireCodOrders, updateCodOrder } = require('../lib/orders');
const {
  getOrderWithCrm,
  hydrateOrders,
  updateCrmStatus,
  addInternalNote,
} = require('../lib/crm-orders');

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store');
}

function parseBody(req) {
  if (typeof req.body !== 'string') return req.body || {};
  try {
    return JSON.parse(req.body);
  } catch {
    const error = new Error('JSON invalido');
    error.statusCode = 400;
    throw error;
  }
}

function adminActor(req) {
  return String(req.headers['x-admin-user'] || req.headers['x-admin-id'] || 'admin').trim().slice(0, 120) || 'admin';
}

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN;
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const internal = process.env.MARKETPLUS_INTERNAL_SECRET && provided === process.env.MARKETPLUS_INTERNAL_SECRET;
  return Boolean((adminToken && provided === adminToken) || internal);
}

function errorStatus(error) {
  if (error.statusCode) return error.statusCode;
  if (/Pedido no encontrado/i.test(error.message || '')) return 404;
  return 500;
}

module.exports = async (req, res) => {
  noStore(res);
  if (!['GET', 'PATCH'].includes(req.method)) return res.status(405).json({ ok: false, error: 'Metodo no permitido' });
  if (!isAuthorized(req)) return res.status(401).json({ ok: false, error: 'No autorizado' });

  try {
    await expireCodOrders();

    if (req.method === 'PATCH') {
      const body = parseBody(req);
      const { referencia, action } = body;

      // Compatibilidad con las acciones existentes de contraentrega.
      if (action === 'confirm' || action === 'confirm_expired' || action === 'cancel') {
        await updateCodOrder(referencia, action);
        return res.status(200).json({ ok: true, pedido: await getOrderWithCrm(referencia) });
      }

      if (action === 'update_crm') {
        const pedido = await updateCrmStatus(referencia, body.crmStatus, adminActor(req), body.nota);
        return res.status(200).json({ ok: true, pedido });
      }

      if (action === 'add_note') {
        const pedido = await addInternalNote(referencia, body.nota, adminActor(req));
        return res.status(200).json({ ok: true, pedido });
      }

      return res.status(400).json({ ok: false, error: 'Operacion invalida' });
    }

    const keys = (await kv.scanAll('pedido:*')).filter(key => /^pedido:[^:]+$/.test(key));
    const values = await Promise.all(keys.map(key => kv.get(key)));
    const pedidos = values
      .map(value => {
        try { return value ? JSON.parse(value) : null; } catch { return null; }
      })
      .filter(Boolean);
    const enriched = await hydrateOrders(pedidos);
    enriched.sort((a, b) => new Date(b.creadoEn || b.confirmadoEn || 0) - new Date(a.creadoEn || a.confirmadoEn || 0));
    return res.status(200).json({ ok: true, pedidos: enriched });
  } catch (error) {
    const status = errorStatus(error);
    if (status >= 500) console.error('Error administrando pedidos:', error);
    return res.status(status).json({
      ok: false,
      error: status < 500 ? error.message : 'No se pudieron procesar los pedidos',
    });
  }
};
