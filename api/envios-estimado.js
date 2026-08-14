// Estimación interna para que Agente X pueda orientar sobre el envío de MK Racing.
// No sustituye la tarifa final confirmada por la transportadora al despachar.

const catalogo = require('../lib/catalogo');

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store');
}

function authorized(req) {
  const secret = process.env.MARKETPLUS_INTERNAL_SECRET;
  return Boolean(secret && req.headers.authorization === `Bearer ${secret}`);
}

module.exports = async (req, res) => {
  noStore(res);
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Metodo no permitido' });
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'No autorizado' });

  const url = new URL(req.url || '/', 'http://localhost');
  const linea = url.searchParams.get('linea') || 'racing';
  const ciudad = url.searchParams.get('ciudad') || '';
  if (linea !== 'racing') return res.status(400).json({ ok: false, error: 'Solo se estima MK Racing en esta ruta' });

  try {
    return res.status(200).json({ ok: true, estimacion: catalogo.estimarEnvio({ ciudad, linea }) });
  } catch (error) {
    return res.status(400).json({ ok: false, error: String(error.message || error) });
  }
};
