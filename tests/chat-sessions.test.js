const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');

const originalEnv = { ...process.env };
let verificationSuccess = true;
let upstreamStatus = 200;
const calls = [];
const stub = (file, exports) => {
  const id = path.resolve(__dirname, file);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};
stub('../lib/kv.js', { evalScript: async () => 1 });
stub('../lib/http.js', {
  async fetchWithTimeout(url) {
    calls.push(url);
    return { ok: url.includes('siteverify') || upstreamStatus === 200, status: url.includes('siteverify') ? 200 : upstreamStatus,
      json: async () => url.includes('siteverify') ? { success: verificationSuccess } : { ok: upstreamStatus === 200 } };
  }
});
const security = require('../lib/security');
const handler = require('../api/chat/sessions');
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
  assert.deepEqual(res.body, { enabled: true, turnstileSiteKey: 'local-sitekey', hasSession: true });
  assert.equal(res.headers['Cache-Control'], 'no-store');
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
