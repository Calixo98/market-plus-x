const test = require('node:test');
const assert = require('node:assert/strict');

test('EVAL se envia a Upstash por POST sin poner el script ni datos en la URL', async t => {
  const previousFetch = global.fetch;
  const previousUrl = process.env.KV_REST_API_URL;
  const previousToken = process.env.KV_REST_API_TOKEN;
  t.after(() => {
    global.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.KV_REST_API_URL; else process.env.KV_REST_API_URL = previousUrl;
    if (previousToken === undefined) delete process.env.KV_REST_API_TOKEN; else process.env.KV_REST_API_TOKEN = previousToken;
  });

  process.env.KV_REST_API_URL = 'https://redis.example.test';
  process.env.KV_REST_API_TOKEN = 'secret-test-token';
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok:true, status:200, json:async () => ({ result:5 }) };
  };

  delete require.cache[require.resolve('../lib/kv')];
  const kv = require('../lib/kv');
  const result = await kv.evalScript('return ARGV[1]', ['rate:key'], ['5']);

  assert.equal(result, 5);
  assert.equal(request.url, 'https://redis.example.test');
  assert.equal(request.options.method, 'POST');
  assert.deepEqual(JSON.parse(request.options.body), ['EVAL', 'return ARGV[1]', 1, 'rate:key', '5']);
  assert.equal(request.url.includes('return'), false);
});
