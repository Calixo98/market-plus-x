const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');

const originalEnv = { ...process.env };
let verificationSuccess = true;
let upstreamStatus = 200;
const calls = [];
const counters = new Map();
const limitCalls = [];
const stub = (file, exports) => {
  const id = path.resolve(__dirname, file);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};
stub('../lib/kv.js', { async evalScript(script, keys, args) {
  const key = keys[0];
  const count = (counters.get(key) || 0) + 1;
  counters.set(key, count);
  limitCalls.push({ key, seconds: args[0] });
  return count;
} });
stub('../lib/http.js', {
  async fetchWithTimeout(url) {
    calls.push(url);
    return { ok: url.includes('siteverify') || upstreamStatus === 200, status: url.includes('siteverify') ? 200 : upstreamStatus,
      json: async () => url.includes('siteverify') ? { success: verificationSuccess } : { ok: upstreamStatus === 200 } };
  }
});
const security = require('../lib/security');
const chatPolicy = require('../lib/chat-policy');
const canonicalTurnstilePolicy = chatPolicy.turnstileRequired;
const handler = require('../api/chat/sessions');
const messages = require('../api/chat/messages');
const request = (method = 'POST', body = {}, cookie = '') => ({ method, body, headers: { cookie, 'x-forwarded-for': '127.0.0.1' } });
const response = () => ({
  statusCode: 200, headers: {},
  setHeader(key, value) { this.headers[key] = value; },
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; }
});
const signedCookie = () => `mpx_chat_session=${encodeURIComponent(security.signSession(crypto.randomUUID()))}`;

test.beforeEach(() => {
  calls.length = 0;
  counters.clear(); limitCalls.length = 0;
  // Existing verification regressions exercise explicit re-enabled policy.
  chatPolicy.turnstileRequired = true;
  verificationSuccess = true;
  upstreamStatus = 200;
  Object.assign(process.env, {
    WEBCHAT_ENABLED: '1', CHAT_SESSION_SECRET: 'local-session-test-secret',
    TURNSTILE_SECRET_KEY: 'local-verification-test-secret', TURNSTILE_SITE_KEY: 'local-sitekey',
    AGENT_X_URL: 'https://agent.example.test', AGENT_X_CHAT_SECRET: 'local-agent-test-secret'
  });
});
test.after(() => { process.env = originalEnv; });

test('config exposes only a boolean for a valid signed session', async () => {
  const res = response(); await handler(request('GET', {}, signedCookie()), res);
  assert.deepEqual(res.body, { enabled: true, turnstileRequired: true, turnstileSiteKey: 'local-sitekey', hasSession: true });
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(calls.length, 0);
});

test('canonical chat policy is disabled and config withholds the widget key', async () => {
  assert.equal(canonicalTurnstilePolicy, false);
  chatPolicy.turnstileRequired = false;
  const res = response(); await handler(request('GET'), res);
  assert.deepEqual(res.body, { enabled: true, turnstileRequired: false, turnstileSiteKey: null, hasSession: false });
});

test('direct startup uses a new bounded bucket despite exhausted verification attempts', async () => {
  chatPolicy.turnstileRequired = false;
  const req = request();
  const hash = security.ipHash(req);
  counters.set(`ratelimit:chat-session:${hash}`, 5);
  const res = response(); await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(counters.get(`ratelimit:chat-session:${hash}`), 5);
  assert.deepEqual(limitCalls, [{ key: `ratelimit:chat-session:direct:${hash}`, seconds: 3600 }]);
  assert.equal(calls.some(url => url.includes('siteverify')), false);
  assert.ok(security.readSession(request('GET', {}, res.headers['Set-Cookie'].split(';')[0])));
});

test('direct startup still denies the sixth new session per IP per hour', async () => {
  chatPolicy.turnstileRequired = false;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = response(); await handler(request(), res);
    assert.equal(res.statusCode, attempt <= 5 ? 200 : 429);
    if (attempt === 6) assert.equal(res.headers['Set-Cookie'], undefined);
  }
  assert.equal(calls.filter(url => url.includes('webchat/session')).length, 5);
});

test('client flags cannot disable a re-enabled server challenge', async () => {
  const res = response(); await handler(request('POST', { turnstileRequired: false }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(calls.length, 0);
  assert.match(limitCalls[0].key, /^ratelimit:chat-session:(?!direct:)/);
});

test('forged cookie in direct mode creates a new limited signed session, not a reused one', async () => {
  chatPolicy.turnstileRequired = false;
  const forgedId = crypto.randomUUID();
  const res = response(); await handler(request('POST', {}, `mpx_chat_session=${forgedId}.forged`), res);
  assert.equal(res.statusCode, 200);
  assert.equal(limitCalls.length, 1);
  const id = security.readSession(request('GET', {}, res.headers['Set-Cookie'].split(';')[0]));
  assert.ok(id); assert.notEqual(id, forgedId);
});

test('direct chat still requires a signed cookie for messages and validates the payload', async () => {
  chatPolicy.turnstileRequired = false;
  for (const cookie of ['', `mpx_chat_session=${crypto.randomUUID()}.forged`]) {
    const res = response(); await messages(request('POST', {}, cookie), res);
    assert.equal(res.statusCode, 401);
  }
  const res = response(); await messages(request('POST', {}, signedCookie()), res);
  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
});

test('direct mode preserves message session/IP quotas', async () => {
  chatPolicy.turnstileRequired = false;
  const cookie = signedCookie();
  const req = request('POST', { client_message_id: crypto.randomUUID(), body: 'Test question' }, cookie);
  const sessionId = security.readSession(req);
  counters.set(`ratelimit:chat-message-session:${sessionId}`, 12);
  const res = response(); await messages(req, res);
  assert.equal(res.statusCode, 429);
  assert.deepEqual(limitCalls, [
    { key: `ratelimit:chat-message-session:${sessionId}`, seconds: 600 },
    { key: `ratelimit:chat-message-ip:${security.ipHash(req)}`, seconds: 3600 }
  ]);
  assert.equal(calls.length, 0);
});

test('missing or forged cookie does not advertise a reusable session', async () => {
  for (const cookie of ['', `mpx_chat_session=${crypto.randomUUID()}.forged`, 'mpx_chat_session=%invalid']) {
    const res = response(); await handler(request('GET', {}, cookie), res);
    assert.equal(res.body.hasSession, false);
  }
});

test('advisor errors are reported rather than presenting a connected session', async () => {
  upstreamStatus = 500;
  const res = response(); await handler(request('POST', {}, signedCookie()), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.ok, false);
});

test('verified new session receives a signed secure cookie and reaches advisor', async () => {
  const res = response(); await handler(request('POST', { turnstile_token: 'verified-token' }), res);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Set-Cookie'], /HttpOnly; Secure; SameSite=Lax/);
  assert.equal(calls.filter(url => url.includes('siteverify')).length, 1);
  assert.equal(calls.filter(url => url.includes('webchat/session')).length, 1);
});

test('valid signed session reaches advisor without a new token or verification', async () => {
  const res = response(); await handler(request('POST', {}, signedCookie()), res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /webchat\/session/);
});

test('missing or invalid token stays fail-closed even with a forged cookie', async () => {
  for (const token of [undefined, 'invalid-token']) {
    calls.length = 0; verificationSuccess = false;
    const res = response();
    await handler(request('POST', { turnstile_token: token, hasSession: true }, `mpx_chat_session=${crypto.randomUUID()}.forged`), res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.headers['Set-Cookie'], undefined);
    assert.equal(calls.some(url => url.includes('webchat/session')), false);
  }
});
