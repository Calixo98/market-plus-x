const { createCodOrder } = require('../lib/orders'); const { verifyTurnstile } = require('../lib/security');
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  if (process.env.COD_ENABLED !== '1') return res.status(503).json({ ok: false, error: 'Contraentrega no disponible temporalmente' });
  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ ok: false, error: 'JSON invalido' }); } }
  const internalSecret = process.env.MARKETPLUS_INTERNAL_SECRET;
  const internal = Boolean(internalSecret) && req.headers.authorization === `Bearer ${internalSecret}`;
  if (!internal && !(await verifyTurnstile(body?.turnstile_token, req))) return res.status(403).json({ ok: false, error: 'Verificacion de seguridad fallida' });
  try { const order = await createCodOrder({ ...(body || {}), event_context:{ ip:String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(), userAgent:req.headers['user-agent'] || '' } }); return res.status(201).json({ ok: true, referencia: order.referencia, estado: order.estado, resumen: { subtotal: order.subtotal, envio: order.envio, envioEstimado: Boolean(order.envioDetalle?.estimado), notaEnvio: order.envioDetalle?.nota || null, total: order.total } }); }
  catch (error) { const message = String(error.message || error); return res.status(message.startsWith('Sin stock') ? 409 : 400).json({ ok: false, error: message }); }
};
