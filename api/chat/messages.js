const { ipHash, rateLimit, readSession } = require('../../lib/security');
const { fetchWithTimeout } = require('../../lib/http');

const CLIENT_MESSAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

async function forward(upstream, res) {
  const data = await upstream.json().catch(() => null);
  if (upstream.status >= 500) return res.status(503).json({ ok: false, error: 'Agente no disponible temporalmente' });
  return res.status(upstream.status).json(data || { ok: upstream.ok });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (process.env.WEBCHAT_ENABLED !== '1') return res.status(503).json({ ok: false, error: 'Chat no disponible' });

  const sessionId = readSession(req);
  if (!sessionId) return res.status(401).json({ ok: false, error: 'Sesion requerida' });

  try {
    if (req.method === 'GET') {
      const after = req.query?.after ? `&after=${encodeURIComponent(String(req.query.after))}` : '';
      const upstream = await callAgent(`/api/internal/webchat/messages?session_id=${encodeURIComponent(sessionId)}${after}`);
      return forward(upstream, res);
    }

    if (req.method !== 'POST') return res.status(405).json({ ok: false });
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ ok: false, error: 'JSON invalido' }); }
    }
    const message = typeof body?.body === 'string' ? body.body.trim() : '';
    if (!CLIENT_MESSAGE_ID_RE.test(body?.client_message_id || '') || message.length < 1 || message.length > 1200) {
      return res.status(400).json({ ok: false, error: 'Mensaje invalido' });
    }

    const [sessionOk, ipOk] = await Promise.all([
      rateLimit(`chat-message-session:${sessionId}`, 12, 600),
      rateLimit(`chat-message-ip:${ipHash(req)}`, 40, 3600),
    ]);
    if (!sessionOk || !ipOk) return res.status(429).json({ ok: false, error: 'Has enviado muchos mensajes. Espera unos minutos.' });

    const upstream = await callAgent('/api/internal/webchat/messages', {
      method: 'POST',
      body: JSON.stringify({
        session_id: sessionId,
        client_message_id: body.client_message_id,
        body: message,
        page: typeof body.page === 'string' ? body.page.slice(0, 300) : null,
      }),
    });
    return forward(upstream, res);
  } catch (error) {
    console.error('Error comunicando Marketplusx con Agente X:', error);
    return res.status(503).json({ ok: false, error: 'Agente no disponible temporalmente' });
  }
};
