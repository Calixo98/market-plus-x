const crypto = require('crypto');
const kv = require('./kv');
function ipOf(req) { return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim(); }
function ipHash(req) { return crypto.createHmac('sha256', process.env.CHAT_SESSION_SECRET || 'missing').update(ipOf(req)).digest('hex').slice(0, 24); }
async function rateLimit(key, max, seconds) {
  const redisKey = `ratelimit:${key}`;
  const count = await kv.cmd('eval', "local current = redis.call('incr', KEYS[1]); if current == 1 then redis.call('expire', KEYS[1], ARGV[1]); end; return current", 1, redisKey, seconds);
  return Number(count) <= max;
}
function signSession(id) { const secret = process.env.CHAT_SESSION_SECRET; if (!secret) throw new Error('CHAT_SESSION_SECRET no configurado'); return `${id}.${crypto.createHmac('sha256', secret).update(id).digest('base64url')}`; }
function readSession(req) {
  const raw = String(req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('mpx_chat_session='))?.split('=').slice(1).join('=');
  if (!raw) return null;
  const [id, signature] = decodeURIComponent(raw).split('.'); if (!id || !signature) return null;
  try { const expected = signSession(id).split('.')[1]; const a = Buffer.from(signature); const b = Buffer.from(expected); return a.length === b.length && crypto.timingSafeEqual(a, b) && /^[a-f0-9-]{36}$/i.test(id) ? id : null; } catch { return null; }
}
async function verifyTurnstile(token, req) {
  const secret = process.env.TURNSTILE_SECRET_KEY; if (!secret || !token) return false;
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: new URLSearchParams({ secret, response: token, remoteip: ipOf(req) }) });
  const result = await response.json().catch(() => null); return Boolean(response.ok && result?.success);
}
module.exports = { ipHash, rateLimit, signSession, readSession, verifyTurnstile };
