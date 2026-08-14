const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const store = new Map();
const lockTails = new Map();
const kvPath = path.resolve(__dirname, '../lib/kv.js');
const ordersPath = path.resolve(__dirname, '../lib/orders.js');
const crmPath = path.resolve(__dirname, '../lib/crm-orders.js');
const apiPath = path.resolve(__dirname, '../api/pedidos.js');

const fakeKv = {
  async get(key) { return store.has(key) ? store.get(key) : null; },
  async set(key, value) { store.set(key, String(value)); return 'OK'; },
  async scanAll(pattern) { const prefix = pattern.replace('*', ''); return [...store.keys()].filter(key => key.startsWith(prefix)); },
  async withLock(key, work) {
    const previous = lockTails.get(key) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    lockTails.set(key, previous.then(() => current));
    await previous;
    try { return await work(); } finally { release(); if (lockTails.get(key) === current) lockTails.delete(key); }
  },
};

let lastLegacyAction = null;
const fakeOrders = {
  async expireCodOrders() {},
  async updateCodOrder(reference, action) {
    lastLegacyAction = { reference, action };
    const order = JSON.parse(store.get(`pedido:${reference}`));
    order.estado = action === 'confirm' ? 'COD_CONFIRMED' : 'COD_CANCELLED';
    store.set(`pedido:${reference}`, JSON.stringify(order));
    return order;
  },
};

require.cache[kvPath] = { id: kvPath, filename: kvPath, loaded: true, exports: fakeKv };
require.cache[ordersPath] = { id: ordersPath, filename: ordersPath, loaded: true, exports: fakeOrders };
delete require.cache[crmPath];
const crm = require('../lib/crm-orders');
require.cache[crmPath] = { id: crmPath, filename: crmPath, loaded: true, exports: crm };
delete require.cache[apiPath];
const handler = require('../api/pedidos');

function order(reference, overrides = {}) {
  return {
    referencia: reference,
    metodo: 'bold',
    estado: 'SALE_APPROVED',
    total: 359000,
    items: [{ sku: 'MPX-G-PRO', qty: 1, nombre: 'Casual Pro', precio: 359000 }],
    cliente: { nombre: 'Cliente Seguro', telefono: '3001234567', email: 'cliente@example.com', direccion: 'Calle 1 # 2-3', departamento: 'Cundinamarca' },
    ciudad: 'Bogota',
    creadoEn: '2026-08-14T10:00:00.000Z',
    ...overrides,
  };
}

function seed(reference, overrides) {
  const value = order(reference, overrides);
  store.set(`pedido:${reference}`, JSON.stringify(value));
  return value;
}

async function invoke(method, body, token = 'test-admin', headers = {}) {
  let statusCode = 200;
  let payload;
  const response = {
    setHeader(name, value) { this.headers = this.headers || {}; this.headers[name] = value; },
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return this; },
  };
  await handler({ method, body, headers: { authorization: token ? `Bearer ${token}` : '', ...headers } }, response);
  return { statusCode, payload, headers: response.headers || {} };
}

test.beforeEach(() => {
  store.clear();
  lockTails.clear();
  lastLegacyAction = null;
  process.env.ADMIN_TOKEN = 'test-admin';
  delete process.env.MARKETPLUS_INTERNAL_SECRET;
});

test('rechaza listado sin token y evita cache', async () => {
  const result = await invoke('GET', {}, '');
  assert.equal(result.statusCode, 401);
  assert.equal(result.payload.error, 'No autorizado');
  assert.equal(result.headers['Cache-Control'], 'no-store');
});

test('lista pedidos autenticados, hidrata CRM y conserva pedidos antiguos', async () => {
  seed('MPX-OLD', { creadoEn: '2026-08-14T09:00:00.000Z' });
  seed('MPX-BOLD-OLD', { creadoEn: '2026-08-14T08:00:00.000Z', metodo: undefined, estado: 'SALE_APPROVED' });
  seed('MPX-NEW', { creadoEn: '2026-08-14T11:00:00.000Z', cliente: { nombre: '<Cliente>', telefono: '3000000000', email: 'x@example.com', direccion: '<script>', departamento: 'Bogota' } });
  store.set('pedido:MPX-NEW:crm', JSON.stringify({ crmStatus: 'IN_FOLLOW_UP', actualizadoEn: '2026-08-14T12:00:00.000Z', actualizadoPor: 'ivan' }));
  store.set('pedido:MPX-NEW:notes', JSON.stringify([{ texto: '<nota>', fecha: '2026-08-14T12:00:00.000Z', usuario: 'ivan', tipo: 'internal' }]));
  store.set('pedido:MPX-NEW:history', JSON.stringify([]));

  const result = await invoke('GET', {});
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.payload.pedidos.map(pedido => pedido.referencia), ['MPX-NEW', 'MPX-OLD', 'MPX-BOLD-OLD']);
  assert.equal(result.payload.pedidos[1].crmStatus, 'NEW');
  assert.equal(result.payload.pedidos[0].crmStatus, 'IN_FOLLOW_UP');
  assert.equal(result.payload.pedidos[0].ultimaNotaInterna.texto, '<nota>');
  assert.equal(result.payload.pedidos[0].cliente.nombre, '<Cliente>');
  assert.equal(result.payload.pedidos.find(pedido => pedido.referencia === 'MPX-BOLD-OLD').metodo, 'bold');
});

test('actualiza solo CRM, valida estados y no cambia pago', async () => {
  const original = seed('MPX-CRM');
  const valid = await invoke('PATCH', { action: 'update_crm', referencia: 'MPX-CRM', crmStatus: 'CONFIRMED', nota: 'Confirmado por llamada' }, 'test-admin', { 'x-admin-user': 'ivan' });
  assert.equal(valid.statusCode, 200);
  assert.equal(valid.payload.pedido.crmStatus, 'CONFIRMED');
  const stored = JSON.parse(store.get('pedido:MPX-CRM'));
  assert.equal(stored.estado, original.estado);
  assert.equal(stored.metodo, original.metodo);
  assert.equal(stored.total, original.total);
  assert.deepEqual(stored.items, original.items);
  assert.equal(JSON.parse(store.get('pedido:MPX-CRM:history')).length, 1);

  const invalid = await invoke('PATCH', { action: 'update_crm', referencia: 'MPX-CRM', crmStatus: 'PAID' });
  assert.equal(invalid.statusCode, 400);
  assert.equal(JSON.parse(store.get('pedido:MPX-CRM:history')).length, 1);
});

test('repetir el mismo estado no duplica historial y las notas son internas', async () => {
  seed('MPX-REPEAT');
  await invoke('PATCH', { action: 'update_crm', referencia: 'MPX-REPEAT', crmStatus: 'DISPATCHED' });
  await invoke('PATCH', { action: 'update_crm', referencia: 'MPX-REPEAT', crmStatus: 'DISPATCHED' });
  const note = await invoke('PATCH', { action: 'add_note', referencia: 'MPX-REPEAT', nota: '<img src=x onerror=alert(1)>' });
  assert.equal(note.statusCode, 200);
  assert.equal(JSON.parse(store.get('pedido:MPX-REPEAT:history')).length, 1);
  assert.equal(JSON.parse(store.get('pedido:MPX-REPEAT:notes'))[0].texto, '<img src=x onerror=alert(1)>');
  assert.equal(JSON.parse(store.get('pedido:MPX-REPEAT')).estado, 'SALE_APPROVED');
});

test('mantiene la accion existente de contraentrega', async () => {
  seed('MPX-COD-OLD', { metodo: 'contraentrega', estado: 'COD_PENDING_CONFIRMATION' });
  const result = await invoke('PATCH', { action: 'confirm', referencia: 'MPX-COD-OLD' });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(lastLegacyAction, { reference: 'MPX-COD-OLD', action: 'confirm' });
  assert.equal(result.payload.pedido.estado, 'COD_CONFIRMED');
});
