const crypto = require('crypto');
const { ipHash, rateLimit, signSession, readSession, verifyTurnstile } = require('../../lib/security');
const { fetchWithTimeout } = require('../../lib/http');

function agentUrl(path) {
  const base = String(process.env.AGENT_X_URL || '').replace(/\/$/, '');
  if (!base || !process.env.MARKETPLUS_INTERNAL_SECRET) throw new Error('Integracion de Agente X no configurada');
  return `${base}${path}`;
}

async function callAgent(path, options = {}) {
  return fetchWithTimeout(agentUrl(path), {
    ...options,
    headers: {
      ...(options.headers || {}),
      authorization: `Bearer ${process.env.MARKETPLUS_INTERNAL_SECRET}`,
      'content-type': 'application/json',
    },
  }, 10000);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') {
    return res.status(200).json({
      enabled: process.env.WEBCHAT_ENABLED === '1',
      turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || null,
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  if (process.env.WEBCHAT_ENABLED !== '1') return res.status(503).json({ ok: false, error: 'Chat no disponible' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ ok: false, error: 'JSON invalido' }); }
  }

  try {
    let sessionId = readSession(req);
    if (!sessionId) {
      if (!(await rateLimit(`chat-session:${ipHash(req)}`, 5, 3600))) {
        return res.status(429).json({ ok: false, error: 'Demasiados intentos' });
      }
      if (!(await verifyTurnstile(body?.turnstile_token, req))) {
        return res.status(403).json({ ok: false, error: 'Verificacion de seguridad fallida' });
      }
      sessionId = crypto.randomUUID();
      res.setHeader('Set-Cookie', `mpx_chat_session=${encodeURIComponent(signSession(sessionId))}; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax`);
    }

    const upstream = await callAgent('/api/internal/webchat/session', {
      method: 'POST',
      body: JSON.stringify({ session_id: sessionId }),
    });
    const data = await upstream.json().catch(() => null);
    if (upstream.status >= 500) return res.status(503).json({ ok: false, error: 'Agente no disponible temporalmente' });
    return res.status(upstream.status).json(data || { ok: upstream.ok });
  } catch (error) {
    console.error('Error creando sesion de Agente X:', error);
    return res.status(503).json({ ok: false, error: 'Agente no disponible temporalmente' });
  }
};
