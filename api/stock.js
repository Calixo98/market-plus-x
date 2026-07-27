// GET /api/stock
// Devuelve la disponibilidad actual por SKU (inicial - vendido - retenido por
// reservas vigentes), para que la web marque "Agotado" sin intervencion manual.

const catalogo = require('../lib/catalogo');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ ok: false });

  try {
    const stock = await catalogo.stockDeTodos();
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, stock });
  } catch (err) {
    console.error('Error consultando stock:', err);
    return res.status(500).json({ ok: false, error: 'No se pudo consultar el stock' });
  }
};
