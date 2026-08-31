const { createCodOrder } = require('../lib/orders'); const { ipHash, rateLimit, verifyTurnstile } = require('../lib/security');
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  if (process.env.COD_ENABLED !== '1') return res.status(503).json({ ok: false, error: 'Contraentrega no disponible temporalmente' });
  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ ok: false, error: 'JSON invalido' }); } }
  const production = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
  const internalSecret = process.env.AGENT_X_ORDERS_SECRET || (!production && process.env.MARKETPLUS_INTERNAL_SECRET);
  const internal = Boolean(internalSecret) && req.headers.authorization === `Bearer ${internalSecret}`;
  if (!internal && !(await rateLimit(`cod-order-ip:${ipHash(req)}`, 5, 3600))) return res.status(429).json({ ok: false, error: 'Demasiados intentos de contraentrega. Espera unos minutos.' });
  if (!/^[A-Za-z0-9:_-]{16,120}$/.test(String(body?.idempotency_key || '').trim())) return res.status(400).json({ ok: false, error: 'Clave de solicitud invalida' });
  if (!internal && !(await verifyTurnstile(body?.turnstile_token, req))) return res.status(403).json({ ok: false, error: 'Verificacion de seguridad fallida' });
  try { const order = await createCodOrder({ ...(body || {}), event_context:{ ip:String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(), userAgent:req.headers['user-agent'] || '' } }); return res.status(201).json({ ok: true, referencia: order.referencia, estado: order.estado, resumen: { subtotal: order.subtotal, envio: order.envio, envioEstimado: Boolean(order.envioDetalle?.estimado), notaEnvio: order.envioDetalle?.nota || null, total: order.total } }); }
  catch (error) {
    const message = String(error.message || error);
    const expected = /^(Sin stock|Productos invalidos|Falta|Nombre invalido|WhatsApp invalido|Email invalido|Cedula invalida|Direccion invalida|Departamento invalido|Ciudad invalida|Origen de consentimiento invalido|Version de politica invalido|Conversacion invalida|Clave de solicitud invalida|La clave de idempotencia|Pedido en proceso)/.test(message);
    if (!expected) console.error('Error creando pedido contraentrega:', error);
    return res.status(message.startsWith('Sin stock') ? 409 : expected ? 400 : 500).json({ ok: false, error: expected ? message : 'No se pudo crear el pedido. Intenta nuevamente.' });
  }
};
