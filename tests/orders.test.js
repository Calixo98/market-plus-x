const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const store = new Map();
const lockTails = new Map();
let emailCount = 0;

const fakeKv = {
  async get(key) { return store.has(key) ? store.get(key) : null; },
  async set(key, value) { store.set(key, String(value)); return 'OK'; },
  async setnx(key, value) { if (store.has(key)) return null; store.set(key, String(value)); return 'OK'; },
  async incrby(key, amount) { const next = Number(store.get(key) || 0) + Number(amount); store.set(key, String(next)); return next; },
  async scanAll(pattern) { const prefix = pattern.replace('*', ''); return [...store.keys()].filter(key => key.startsWith(prefix)); },
  async withLock(key, work) {
    const previous = lockTails.get(key) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    lockTails.set(key, previous.then(() => current));
    await previous;
    try { return await work(); }
    finally { release(); if (lockTails.get(key) === current) lockTails.delete(key); }
  },
};

const kvPath = path.resolve(__dirname, '../lib/kv.js');
const emailPath = path.resolve(__dirname, '../lib/email.js');
require.cache[kvPath] = { id: kvPath, filename: kvPath, loaded: true, exports: fakeKv };
require.cache[emailPath] = { id: emailPath, filename: emailPath, loaded: true, exports: { notifyOrder: async () => `email-${++emailCount}` } };

const { createCodOrder, updateCodOrder, expireCodOrders } = require('../lib/orders');
const catalogo = require('../lib/catalogo');

function input(productName) {
  return {
    product_name: productName,
    qty: 1,
    cliente: { nombre: 'Cliente Prueba', telefono: '3001234567', email: 'cliente@example.com', documento: '12345678', direccion: 'Calle 1 # 2-3', departamento: 'Cundinamarca' },
    ciudad: 'Bogotá D.C.',
    consent: { accepted: true, source: 'test', policy_version: '2026-08-13' },
  };
}

test.beforeEach(() => { store.clear(); lockTails.clear(); emailCount = 0; });

test('estima el envío de MK Racing con el empaque volumétrico informado', () => {
  const estimate = catalogo.estimarEnvio({ linea: 'racing', ciudad: 'Bogotá D.C.' });
  assert.equal(estimate.valorReferencial, 12000);
  assert.equal(estimate.zona.id, 'bogota');
  assert.deepEqual(estimate.paquete, {
    largoCm: 30,
    altoCm: 15,
    anchoCm: 10,
    volumenCm3: 4500,
    divisorVolumetricoCm3PorKg: 5000,
    pesoVolumetricoKg: 0.9,
  });
});

test('dos clientes no reservan simultáneamente la última unidad', async () => {
  store.set('stock:MPX-G-PRO', '1');
  const results = await Promise.allSettled([createCodOrder(input('Casual Pro')), createCodOrder(input('Casual Pro'))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(store.get('stock:MPX-G-PRO'), '0');
  assert.equal(emailCount, 1);
});

test('confirmar dos veces contabiliza la venta una sola vez', async () => {
  store.set('stock:MPX-G-STD', '1');
  const order = await createCodOrder(input('Casual Standard'));
  await Promise.all([updateCodOrder(order.referencia, 'confirm'), updateCodOrder(order.referencia, 'confirm')]);
  assert.equal(store.get('vendido:MPX-G-STD'), '1');
  assert.equal(JSON.parse(store.get(`pedido:${order.referencia}`)).estado, 'COD_CONFIRMED');
});

test('cancelar dos veces libera la reserva una sola vez', async () => {
  store.set('stock:MPX-G-ULTRA-NEG', '1');
  const order = await createCodOrder(input('Casual Ultra'));
  await Promise.all([updateCodOrder(order.referencia, 'cancel'), updateCodOrder(order.referencia, 'cancel')]);
  assert.equal(store.get('stock:MPX-G-ULTRA-NEG'), '1');
  assert.equal(JSON.parse(store.get(`pedido:${order.referencia}`)).estado, 'COD_CANCELLED');
});

test('cancelar una contraentrega confirmada libera la unidad reservada', async () => {
  store.set('stock:MPX-G-STD', '1');
  const order = await createCodOrder(input('Casual Standard'));
  await updateCodOrder(order.referencia, 'confirm');
  assert.equal(store.get('stock:MPX-G-STD'), '0');
  await updateCodOrder(order.referencia, 'cancel');
  assert.equal(store.get('stock:MPX-G-STD'), '1');
  assert.equal(JSON.parse(store.get(`pedido:${order.referencia}`)).estado, 'COD_CANCELLED');
  await updateCodOrder(order.referencia, 'cancel');
  assert.equal(store.get('stock:MPX-G-STD'), '1');
});

test('el stock publico bloquea un pedido abierto aunque el contador no se haya actualizado', async () => {
  store.set('stock:MPX-RC-P12-ROJ', '1');
  store.set('pedido:MPX-COD-RESERVA-01', JSON.stringify({ estado: 'COD_CONFIRMED', stockLiberado: false, items: [{ sku: 'MPX-RC-P12-ROJ', qty: 1 }] }));
  let stock = await catalogo.stockDeTodos();
  assert.equal(stock['MPX-RC-P12-ROJ'], 0);
  store.set('pedido:MPX-COD-RESERVA-01', JSON.stringify({ estado: 'COD_CANCELLED', stockLiberado: true, items: [{ sku: 'MPX-RC-P12-ROJ', qty: 1 }] }));
  stock = await catalogo.stockDeTodos();
  assert.equal(stock['MPX-RC-P12-ROJ'], 1);
});

test('vencer una reserva en paralelo libera stock una sola vez', async () => {
  store.set('stock:MPX-G-PRO', '1');
  const order = await createCodOrder(input('Casual Pro'));
  order.expiraEn = new Date(Date.now() - 1000).toISOString();
  store.set(`pedido:${order.referencia}`, JSON.stringify(order));
  await Promise.all([expireCodOrders(), expireCodOrders()]);
  assert.equal(store.get('stock:MPX-G-PRO'), '1');
  assert.equal(JSON.parse(store.get(`pedido:${order.referencia}`)).estado, 'COD_EXPIRED');
});
