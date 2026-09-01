const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const store = new Map();
const kvPath = path.resolve(__dirname, '../lib/kv.js');
const crmPath = path.resolve(__dirname, '../lib/crm-orders.js');
const apiPath = path.resolve(__dirname, '../api/metricas.js');

const fakeKv = {
  async get(key) { return store.has(key) ? store.get(key) : null; },
  async scanAll(pattern) {
    const prefix = pattern.replace('*', '');
    return [...store.keys()].filter(key => key.startsWith(prefix));
  },
};

const fakeCrm = {
  async getOrderWithCrm(reference) {
    const raw = await fakeKv.get(`pedido:${reference}`);
    if (!raw) return null;
    const order = JSON.parse(raw);
    const crmRaw = await fakeKv.get(`pedido:${reference}:crm`);
    const crm = crmRaw ? JSON.parse(crmRaw) : {};
    return { ...order, crmStatus: crm.crmStatus || order.crmStatus || 'NEW' };
  },
};

require.cache[kvPath] = { id: kvPath, filename: kvPath, loaded: true, exports: fakeKv };
require.cache[crmPath] = { id: crmPath, filename: crmPath, loaded: true, exports: fakeCrm };
delete require.cache[apiPath];
const handler = require('../api/metricas');

function seed(reference, overrides = {}) {
  store.set(`pedido:${reference}`, JSON.stringify({
    referencia: reference,
    metodo: 'bold',
    estado: 'SALE_APPROVED',
    total: 359000,
    cliente: { nombre: 'No debe salir', telefono: '3001234567', email: 'private@example.com' },
    creadoEn: '2026-08-14T10:00:00.000Z',
    ...overrides,
  }));
}

async function invoke(query = {}, token = 'test-admin') {
  let statusCode = 200;
  let payload;
  const response = {
    setHeader(name, value) { this.headers = this.headers || {}; this.headers[name] = value; },
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return this; },
  };
  await handler({ method: 'GET', query, headers: { authorization: token ? `Bearer ${token}` : '' } }, response);
  return { statusCode, payload, headers: response.headers || {} };
}

test.beforeEach(() => {
  store.clear();
  process.env.ADMIN_TOKEN = 'test-admin';
});

test('métricas de pedidos requieren token y no ejecutan limpieza', async () => {
  const result = await invoke({ from: '2026-08-01', to: '2026-08-31' }, '');
  assert.equal(result.statusCode, 401);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(result.payload.error, 'No autorizado');
});

test('métricas aceptan el secreto interno de Agente X', async () => {
  process.env.MARKETPLUS_INTERNAL_SECRET = 'internal-metrics-secret';
  seed('MPX-INTERNAL-METRICS');
  const result = await invoke({ from: '2026-08-01', to: '2026-08-31' }, 'internal-metrics-secret');
  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.summary.ordersCreated, 1);
});

test('métricas agregan pedidos por fecha y no devuelven PII', async () => {
  seed('MPX-METRICS-1');
  seed('MPX-METRICS-2', { metodo: 'contraentrega', estado: 'COD_CONFIRMED', total: 420000, creadoEn: '2026-08-15T12:00:00.000Z' });
  store.set('pedido:MPX-METRICS-2:crm', JSON.stringify({ crmStatus: 'COMPLETED' }));

  const result = await invoke({ from: '2026-08-14', to: '2026-08-15' });
  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.summary.ordersCreated, 2);
  assert.equal(result.payload.summary.boldApproved, 1);
  assert.equal(result.payload.summary.codConfirmed, 1);
  assert.equal(result.payload.summary.ordersCompleted, 1);
  assert.equal(result.payload.daily.length, 2);
  assert.equal(result.payload.daily[0].orders, 1);
  assert.equal(result.payload.daily[1].orders, 1);
  assert.equal(JSON.stringify(result.payload).includes('No debe salir'), false);
  assert.equal(JSON.stringify(result.payload).includes('private@example.com'), false);
});
