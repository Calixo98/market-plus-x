const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const store = new Map();
const lockTails = new Map();
let payload;
let emailCount;

const fakeKv = {
  async get(key) { return store.has(key) ? store.get(key) : null; },
  async set(key, value) { store.set(key, String(value)); return 'OK'; },
  async del(key) { return store.delete(key) ? 1 : 0; },
  async incrby(key, amount) {
    const next = Number(store.get(key) || 0) + Number(amount);
    store.set(key, String(next));
    return next;
  },
  async withLock(key, work) {
    const previous = lockTails.get(key) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    lockTails.set(key, previous.then(() => current));
    await previous;
    try { return await work(); }
    finally { release(); }
  },
};

function stub(modulePath, exports) {
  require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports };
}

const kvPath = path.resolve(__dirname, '../lib/kv.js');
const catalogPath = path.resolve(__dirname, '../lib/catalogo.js');
const boldPath = path.resolve(__dirname, '../lib/bold.js');
const metaPath = path.resolve(__dirname, '../lib/meta.js');
const telegramPath = path.resolve(__dirname, '../lib/telegram.js');
const emailPath = path.resolve(__dirname, '../lib/email.js');

stub(kvPath, fakeKv);
stub(catalogPath, {
  moneda: 'COP',
  async liberarStock(items) {
    for (const item of items) await fakeKv.incrby(`stock:${item.sku}`, item.qty);
  },
  async reservarStock(items) {
    const reserved = [];
    for (const item of items) {
      const next = await fakeKv.incrby(`stock:${item.sku}`, -item.qty);
      if (next < 0) {
        await fakeKv.incrby(`stock:${item.sku}`, item.qty);
        for (const previous of reserved) await fakeKv.incrby(`stock:${previous.sku}`, previous.qty);
        return { ok:false, sku:item.sku };
      }
      reserved.push(item);
    }
    return { ok:true };
  },
  async guardarConInventario(recordKey, record, { stockDeltas = [], soldDeltas = [], deleteKeys = [] } = {}) {
    for (const entry of stockDeltas) {
      const current = Number(store.get(`stock:${entry.sku}`) || 0);
      if (entry.delta < 0 && current + entry.delta < 0) return { ok: false, sku: entry.sku, disponible: current };
    }
    for (const entry of stockDeltas) await fakeKv.incrby(`stock:${entry.sku}`, entry.delta);
    for (const entry of soldDeltas) await fakeKv.incrby(`vendido:${entry.sku}`, entry.delta);
    store.set(recordKey, JSON.stringify(record));
    for (const key of deleteKeys) store.delete(key);
    return { ok: true };
  },
});
stub(boldPath, {
  leerCuerpoCrudo: async () => Buffer.from(JSON.stringify(payload)),
  verificarFirmaWebhook: () => true,
});
stub(metaPath, { enviarEventoCompra: async () => {} });
stub(telegramPath, { notificarPedidoAprobado: async () => {} });
stub(emailPath, { notifyOrder: async () => { emailCount += 1; return `email-${emailCount}`; } });

const handler = require('../api/webhook-bold.js');

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function request() {
  return { method: 'POST', headers: { 'x-bold-signature': 'valid' } };
}

function reservation() {
  return {
    items: [{ sku: 'MPX-G-PRO', qty: 1 }],
    total: 359000,
    cliente: { email: 'cliente@example.com', telefono: '573001234567' },
  };
}

test.beforeEach(() => {
  store.clear();
  lockTails.clear();
  emailCount = 0;
  process.env.BOLD_WEBHOOK_SECRET = 'test';
});

test('dos rechazos Bold simultaneos liberan la reserva una sola vez', async () => {
  const referencia = 'MPX-BOLD-RACE-REJECT';
  store.set('stock:MPX-G-PRO', '0');
  store.set(`reserva:${referencia}`, JSON.stringify(reservation()));
  payload = { id: 'evt-reject', type: 'SALE_REJECTED', data: { payment_id: 'pay-1', amount: { total: 359000, currency: 'COP' }, metadata: { reference: referencia } } };

  const responses = [response(), response()];
  await Promise.all(responses.map(res => handler(request(), res)));

  assert.equal(store.get('stock:MPX-G-PRO'), '1');
  assert.equal(store.has(`reserva:${referencia}`), false);
  assert.equal(responses.every(res => res.statusCode === 200), true);
});

test('dos aprobaciones Bold simultaneas contabilizan y notifican una sola vez', async () => {
  const referencia = 'MPX-BOLD-RACE-APPROVE';
  store.set('vendido:MPX-G-PRO', '0');
  store.set(`reserva:${referencia}`, JSON.stringify(reservation()));
  payload = { id: 'evt-approve', type: 'SALE_APPROVED', data: { payment_id: 'pay-2', created_at: new Date().toISOString(), amount: { total: 359000, currency: 'COP' }, metadata: { reference: referencia } } };

  const responses = [response(), response()];
  await Promise.all(responses.map(res => handler(request(), res)));

  assert.equal(store.get('vendido:MPX-G-PRO'), '1');
  assert.equal(emailCount, 1);
  assert.equal(store.has(`reserva:${referencia}`), false);
  assert.equal(responses.every(res => res.statusCode === 200), true);
});

test('una aprobacion con monto distinto va a revision y no contabiliza venta', async () => {
  const referencia = 'MPX-BOLD-AMOUNT-MISMATCH';
  store.set('stock:MPX-G-PRO', '0');
  store.set(`reserva:${referencia}`, JSON.stringify(reservation()));
  payload = { id:'evt-mismatch', type:'SALE_APPROVED', data:{ payment_id:'pay-3', amount:{ total:1000, currency:'COP' }, metadata:{ reference:referencia } } };

  const res = response();
  await handler(request(), res);

  const order = JSON.parse(store.get(`pedido:${referencia}`));
  assert.equal(res.statusCode, 200);
  assert.equal(order.estado, 'SALE_APPROVED_REVIEW');
  assert.equal(order.requiereRevision, true);
  assert.equal(store.get('stock:MPX-G-PRO'), '1');
  assert.equal(store.has('vendido:MPX-G-PRO'), false);
  assert.equal(emailCount, 1);
});
