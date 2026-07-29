// GET /api/estado-pago?ref=REFERENCIA
// Consulta informativa para pago-respuesta.html: lee el pedido tal como lo
// dejo api/webhook-bold.js (la unica fuente de verdad). Bold advierte que el
// webhook puede demorar hasta 10 minutos, asi que "no encontrado" no
// significa que el pago fallo, solo que la notificacion no ha llegado todavia.
//
// No consultamos la API de Bold directamente desde el navegador para esto:
// su endpoint de consulta exige la llave de identidad en un header y no hay
// garantia de que su API este pensada para llamadas CORS desde un sitio web,
// asi que el servidor hace de intermediario y el navegador nunca necesita
// ninguna llave.

const kv = require('../lib/kv');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ ok: false });

  const ref = req.query && req.query.ref;
  if (!ref || typeof ref !== 'string') {
    return res.status(400).json({ ok: false, error: 'Falta el parametro ref' });
  }

  try {
    const pedidoRaw = await kv.get(`pedido:${ref}`);
    res.setHeader('Cache-Control', 'no-store');
    if (!pedidoRaw) return res.status(200).json({ ok: true, encontrado: false });

    const pedido = JSON.parse(pedidoRaw);
    return res.status(200).json({ ok: true, encontrado: true, estado: pedido.estado });
  } catch (err) {
    console.error('Error consultando estado de pago:', err);
    return res.status(500).json({ ok: false, error: 'No se pudo consultar el estado del pago' });
  }
};
