const crypto = require('crypto'); const { ipHash, rateLimit, signSession, readSession, verifyTurnstile } = require('../../lib/security');
function agentUrl(path) { return `${String(process.env.AGENT_X_URL || '').replace(/\/$/, '')}${path}`; }
async function callAgent(path, options = {}) { return fetch(agentUrl(path), { ...options, headers: { ...(options.headers || {}), authorization: `Bearer ${process.env.MARKETPLUS_INTERNAL_SECRET}`, 'content-type': 'application/json' } }); }
module.exports = async (req, res) => {
  if (req.method === 'GET') return res.status(200).json({ enabled: process.env.WEBCHAT_ENABLED === '1', turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || null });
  if (req.method !== 'POST') return res.status(405).json({ ok: false }); if (process.env.WEBCHAT_ENABLED !== '1') return res.status(503).json({ ok: false, error: 'Chat no disponible' });
  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ ok: false, error: 'JSON invalido' }); } } let sessionId = readSession(req);
  if (!sessionId) { if (!(await rateLimit(`chat-session:${ipHash(req)}`, 5, 3600))) return res.status(429).json({ ok: false, error: 'Demasiados intentos' }); if (!(await verifyTurnstile(body?.turnstile_token, req))) return res.status(403).json({ ok: false, error: 'Verificacion de seguridad fallida' }); sessionId = crypto.randomUUID(); res.setHeader('Set-Cookie', `mpx_chat_session=${encodeURIComponent(signSession(sessionId))}; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax`); }
  const upstream = await callAgent('/api/internal/webchat/session', { method: 'POST', body: JSON.stringify({ session_id: sessionId }) }); const data = await upstream.json().catch(() => ({ error: 'Agente no disponible' })); return res.status(upstream.status).json(data);
};
