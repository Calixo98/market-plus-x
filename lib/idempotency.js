const crypto = require('crypto');
const kv = require('./kv');

const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

function idempotencyError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function normalizeKey(value) {
  const key = String(value || '').trim();
  if (!KEY_RE.test(key)) throw idempotencyError('Idempotencia invalida');
  return key;
}

function fingerprint(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function recordKey(scope, key) {
  return `idempotency:${scope}:${key}`;
}

function parseRecord(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch { return null; }
}

/**
 * Claims an idempotency key before any external side effect. A completed
 * request is replayed verbatim; a different payload or an in-flight request
 * is rejected instead of creating a second order/reservation.
 */
async function begin(scope, suppliedKey, payload, { ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  const key = normalizeKey(suppliedKey);
  const fingerprintValue = fingerprint(payload);
  const redisKey = recordKey(scope, key);
  const pending = {
    state: 'PENDING',
    fingerprint: fingerprintValue,
    createdAt: new Date().toISOString(),
  };
  const claimed = await kv.setnx(redisKey, JSON.stringify(pending), { exSeconds: ttlSeconds });
  if (claimed === 'OK') return { key, redisKey, fingerprint: fingerprintValue, status: 'new' };

  const current = parseRecord(await kv.get(redisKey));
  if (!current) {
    // A short-lived race with an expired Redis key: retry the claim once.
    const retried = await kv.setnx(redisKey, JSON.stringify(pending), { exSeconds: ttlSeconds });
    if (retried === 'OK') return { key, redisKey, fingerprint: fingerprintValue, status: 'new' };
    throw Object.assign(new Error('Operacion en curso; intenta nuevamente'), { statusCode: 409 });
  }
  if (current.fingerprint !== fingerprintValue) {
    throw Object.assign(new Error('La clave de idempotencia ya fue usada con otros datos'), { statusCode: 409 });
  }
  if (current.state === 'COMPLETED') return { key, redisKey, fingerprint: fingerprintValue, status: 'completed', response: current.response };
  throw Object.assign(new Error('Operacion en curso; espera un momento antes de reintentar'), { statusCode: 409 });
}

async function complete(context, response, { ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  if (!context) return;
  await kv.set(context.redisKey, JSON.stringify({
    state: 'COMPLETED',
    fingerprint: context.fingerprint,
    completedAt: new Date().toISOString(),
    response,
  }), { exSeconds: ttlSeconds });
}

async function fail(context) {
  if (!context) return;
  try { await kv.del(context.redisKey); }
  catch (error) { console.error(`No se pudo liberar idempotencia ${context.redisKey}:`, error.message || error); }
}

module.exports = { begin, complete, fail, normalizeKey, fingerprint };
