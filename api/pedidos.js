// GET /api/pedidos
// Lista los pedidos registrados (pagados, rechazados, o pendientes de revision).
// Protegido con un token simple: header  Authorization: Bearer <ADMIN_TOKEN>
// El valor de ADMIN_TOKEN lo defines tu en las variables de entorno de Vercel.

const kv = require('../lib/kv');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ ok: false });

  const adminToken = process.env.ADMIN_TOKEN;
  const auth = req.headers.authorization || '';
  const provisto = auth.startsWith('Bearer ') ? auth.slice(7) : '';

  if (!adminToken || provisto !== adminToken) {
    return res.status(401).json({ ok: false, error: 'No autorizado' });
  }

  try {
    const claves = await kv.scanAll('pedido:*');
    const valores = await Promise.all(claves.map(k => kv.get(k)));
    const pedidos = valores
      .filter(Boolean)
      .map(v => JSON.parse(v))
      .sort((a, b) => new Date(b.confirmadoEn) - new Date(a.confirmadoEn));

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, pedidos });
  } catch (err) {
    console.error('Error listando pedidos:', err);
    return res.status(500).json({ ok: false, error: 'No se pudieron listar los pedidos' });
  }
};
