const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const records = new Map();
const idempotencyRecords = new Map();
let stock;
let boldShouldFail;
let metadataShouldFail;
let boldCalls;
let boldOptions;
let requestCount = 0;

function stub(modulePath, exports) {
  require.cache[modulePath] = { id:modulePath, filename:modulePath, loaded:true, exports };
}

const kvPath = path.resolve(__dirname, '../lib/kv.js');
const catalogPath = path.resolve(__dirname, '../lib/catalogo.js');
const boldPath = path.resolve(__dirname, '../lib/bold.js');
const securityPath = path.resolve(__dirname, '../lib/security.js');

stub(kvPath, {
  expire:async () => 1,
  async get(key) { return idempotencyRecords.get(key) || null; },
  async set(key, value) { idempotencyRecords.set(key, String(value)); return 'OK'; },
  async setnx(key, value) { if (idempotencyRecords.has(key)) return null; idempotencyRecords.set(key, String(value)); return 'OK'; },
  async del(key) { return idempotencyRecords.delete(key) ? 1 : 0; },
});
stub(catalogPath, {
  moneda:'COP',
  RESERVA_TTL_RESPALDO_SEGUNDOS:48 * 60 * 60,
  buscarProducto(sku) { return sku === 'MPX-G-PRO' ? { sku, nombre:'Casual Pro', precio:359000, envioGratis:true } : null; },
  buscarZonaEnvio() { return { id:'bogota', nombre:'Bogota' }; },
  calcularEnvio() { return { total:0, estimado:false, zona:{ id:'bogota', nombre:'Bogota' } }; },
  async liberarReservasVencidas() {},
  async guardarConInventario(key, record, { stockDeltas = [] } = {}) {
    if (metadataShouldFail && record.paymentLink) throw new Error('KV metadata temporalmente no disponible');
    const delta = stockDeltas.reduce((sum, entry) => sum + Number(entry.delta), 0);
    if (stock + delta < 0) return { ok:false, sku:'MPX-G-PRO', disponible:stock };
    stock += delta;
    records.set(key, structuredClone(record));
    return { ok:true };
  },
});
stub(boldPath, {
  async crearLinkDePago(options) {
    boldCalls += 1;
    boldOptions = options;
    if (boldShouldFail) throw new Error('Bold temporalmente no disponible');
    return { url:'https://checkout.bold.co/test' };
  },
});
stub(securityPath, {
  ipHash:() => 'ip-hash',
  rateLimit:async () => true,
  verifyTurnstile:async () => true,
});

const handler = require('../api/checkout.js');

function request() {
  requestCount += 1;
  return {
    method:'POST',
    headers:{ host:'marketplusx.com', 'x-forwarded-proto':'https', 'x-forwarded-for':'127.0.0.1', 'user-agent':'test' },
    socket:{ remoteAddress:'127.0.0.1' },
    body:{
      items:[{ sku:'MPX-G-PRO', qty:1 }],
      payment_method:'bold',
      idempotency_key:`checkout-test-key-${requestCount}`,
      turnstile_token:'token',
      ciudad:'Bogota D.C.',
      cliente:{ nombre:'Cliente Prueba', email:'cliente@example.com', telefono:'3001234567', direccion:'Calle 1 # 2-3', departamento:'Cundinamarca' },
    },
  };
}

function response() {
  return {
    statusCode:200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test.beforeEach(() => {
  records.clear();
  stock = 1;
  boldShouldFail = false;
  metadataShouldFail = false;
  boldCalls = 0;
  boldOptions = null;
  requestCount = 0;
  idempotencyRecords.clear();
  process.env.BOLD_IDENTITY_KEY = 'identity-test';
  process.env.PUBLIC_STORE_URL = 'https://marketplusx.com';
});

test('checkout guarda reserva y stock juntos antes de crear el link Bold', async () => {
  const res = response();
  await handler(request(), res);

  const reservation = [...records.values()][0];
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.paymentUrl, 'https://checkout.bold.co/test');
  assert.equal(stock, 0);
  assert.equal(reservation.total, 359000);
  assert.equal(reservation.stockLiberado, false);
  assert.equal(boldCalls, 1);
});

test('checkout usa el origen canónico aunque el Host del request sea manipulable', async () => {
  const req = request();
  req.headers.host = 'evil.example';
  req.headers['x-forwarded-proto'] = 'http';
  const res = response();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(boldOptions.callbackUrl, 'https://marketplusx.com/pago-respuesta.html');
});

test('reintentar el mismo checkout devuelve el link original sin crear otro cobro', async () => {
  const req = request();
  const first = response();
  const second = response();
  await handler(req, first);
  await handler({ ...req, body: { ...req.body, turnstile_token: 'token-repetido' } }, second);

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.paymentUrl, first.body.paymentUrl);
  assert.equal(boldCalls, 1);
  assert.equal(stock, 0);
});

test('si Bold rechaza crear el link, libera una sola vez y marca la reserva', async () => {
  boldShouldFail = true;
  const res = response();
  await handler(request(), res);

  const reservation = [...records.values()][0];
  assert.equal(res.statusCode, 500);
  assert.equal(stock, 1);
  assert.equal(reservation.estado, 'LINK_FAILED');
  assert.equal(reservation.stockLiberado, true);
});

test('si falla guardar metadata despues de crear el link, conserva la reserva', async () => {
  metadataShouldFail = true;
  boldPath.crearLinkDePago = async () => {
    boldCalls += 1;
    return { url:'https://checkout.bold.co/test', paymentLink:'LNK_TEST' };
  };
  const res = response();
  await handler(request(), res);

  const reservation = [...records.values()][0];
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.paymentUrl, 'https://checkout.bold.co/test');
  assert.equal(stock, 0);
  assert.equal(reservation.stockLiberado, false);
  assert.equal(boldCalls, 1);
});
