const { ipHash, rateLimit, readSession } = require('../../lib/security');
const CLIENT_MESSAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function agentUrl(path) { return `${String(process.env.AGENT_X_URL || '').replace(/\/$/, '')}${path}`; }
async function callAgent(path, options = {}) { return fetch(agentUrl(path), { ...options, headers: { ...(options.headers || {}), authorization: `Bearer ${process.env.MARKETPLUS_INTERNAL_SECRET}`, 'content-type': 'application/json' } }); }
module.exports = async (req, res) => {
  const sessionId = readSession(req); if (!sessionId) return res.status(401).json({ ok: false, error: 'Sesion requerida' });
  if (req.method === 'GET') { const after = req.query?.after ? `&after=${encodeURIComponent(req.query.after)}` : ''; const upstream = await callAgent(`/api/internal/webchat/messages?session_id=${encodeURIComponent(sessionId)}${after}`); const data = await upstream.json().catch(() => ({ error: 'Agente no disponible' })); res.setHeader('Cache-Control', 'no-store'); return res.status(upstream.status).json(data); }
  if (req.method !== 'POST') return res.status(405).json({ ok: false }); let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ ok: false, error: 'JSON invalido' }); } } const text = String(body?.body || '').trim();
  if (!CLIENT_MESSAGE_ID_RE.test(body?.client_message_id || '') || text.length < 1 || text.length > 1200) return res.status(400).json({ ok: false, error: 'Mensaje invalido' });
  const [sessionOk, ipOk] = await Promise.all([rateLimit(`chat-message-session:${sessionId}`, 12, 600), rateLimit(`chat-message-ip:${ipHash(req)}`, 40, 3600)]); if (!sessionOk || !ipOk) return res.status(429).json({ ok: false, error: 'Has enviado muchos mensajes. Espera unos minutos.' });
  const upstream = await callAgent('/api/internal/webchat/messages', { method: 'POST', body: JSON.stringify({ session_id: sessionId, client_message_id: body.client_message_id, body: text, page: body.page || null }) }); const data = await upstream.json().catch(() => ({ error: 'Agente no disponible' })); return res.status(upstream.status).json(data);
};
