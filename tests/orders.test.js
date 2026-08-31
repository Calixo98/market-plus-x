const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const store = new Map();
const lockTails = new Map();
let emailCount = 0;
let inputCount = 0;

const fakeKv = {
  async get(key) { return store.has(key) ? store.get(key) : null; },
  async set(key, value) { store.set(key, String(value)); return 'OK'; },
  async setnx(key, value) { if (store.has(key)) return null; store.set(key, String(value)); return 'OK'; },
  async incrby(key, amount) { const next = Number(store.get(key) || 0) + Number(amount); store.set(key, String(next)); return next; },
  async del(key) { return store.delete(key) ? 1 : 0; },
  async expire() { return 1; },
  async evalScript(script, keys, args) {
    if (script.includes('MPX_STOCK_ONLY_V1')) {
      for (let i = 0; i < keys.length; i += 1) {
        const current = Number(store.get(keys[i]) || 0);
        const delta = Number(args[i]);
        if (delta < 0 && current + delta < 0) return [0, i + 1, current];
      }
      for (let i = 0; i < keys.length; i += 1) store.set(keys[i], String(Number(store.get(keys[i]) || 0) + Number(args[i])));
      return [1];
    }
    if (script.includes('MPX_INVENTORY_TRANSITION_V1')) {
      const stockCount = Number(args[1]);
      const soldCount = Number(args[2]);
      for (let i = 0; i < stockCount; i += 1) {
        const current = Number(store.get(keys[i + 1]) || 0);
        const delta = Number(args[i + 3]);
        if (delta < 0 && current + delta < 0) return [0, i + 1, current];
      }
      for (let i = 0; i < stockCount + soldCount; i += 1) {
        const key = keys[i + 1];
        store.set(key, String(Number(store.get(key) || 0) + Number(args[i + 3])));
      }
      store.set(keys[0], String(args[0]));
      for (let i = stockCount + soldCount + 1; i < keys.length; i += 1) store.delete(keys[i]);
      return [1];
    }
    throw new Error('Script Redis no simulado');
  },
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
const { processBoldEvent } = require('../lib/bold-orders');

function input(productName) {
  inputCount += 1;
  return {
    product_name: productName,
    qty: 1,
    idempotency_key: `cod-test-key-${String(inputCount).padStart(4, '0')}`,
    cliente: { nombre: 'Cliente Prueba', telefono: '3001234567', email: 'cliente@example.com', documento: '12345678', direccion: 'Calle 1 # 2-3', departamento: 'Cundinamarca' },
    ciudad: 'Bogotá D.C.',
    consent: { accepted: true, source: 'test', policy_version: '2026-08-13' },
  };
}

test.beforeEach(() => { store.clear(); lockTails.clear(); emailCount = 0; inputCount = 0; });

test('estima el envío de MK Racing con peso volumétrico y Pago en Casa', () => {
  const estimate = catalogo.estimarEnvio({ linea: 'racing', ciudad: 'Bogotá D.C.' });
  assert.equal(estimate.valorReferencial, 54000);
  assert.deepEqual(estimate.rangoReferencial, { minimo: 49000, maximo: 67000 });
  assert.equal(estimate.zona.id, 'bogota');
  assert.deepEqual(estimate.paquete, {
    pesoVolumetricoKg: 5,
    pesoFacturableKg: 5,
    divisorVolumetricoCm3PorKg: 6000,
  });
});

test('calcula la guía Racing según ciudad, valor y forma de pago', () => {
  const item = [{ sku: 'MPX-RC-P12-ROJ', qty: 1, precio: 521000, envioGratis: false }];
  const contraentrega = catalogo.calcularEnvio({ ciudad: 'Medellín', items: item, subtotal: 521000, metodoPago: 'contraentrega' });
  const anticipado = catalogo.calcularEnvio({ ciudad: 'Medellín', items: item, subtotal: 521000, metodoPago: 'bold' });
  assert.equal(contraentrega.total, 72000);
  assert.equal(contraentrega.base, 45800);
  assert.equal(contraentrega.pagoEnCasa, 26050);
  assert.equal(contraentrega.kilosAdicionales, 4);
  assert.equal(anticipado.total, 46000);
  assert.equal(anticipado.pagoEnCasa, 0);
});

test('aplica Pago en Casa a las gafas y conserva la tarifa de caja pequeña', () => {
  const item = [{ sku: 'MPX-G-STD', qty: 1, precio: 319000, envioGratis: false }];
  const contraentrega = catalogo.calcularEnvio({ ciudad: 'Bogotá D.C.', items: item, subtotal: 319000, metodoPago: 'contraentrega' });
  const anticipado = catalogo.calcularEnvio({ ciudad: 'Bogotá D.C.', items: item, subtotal: 319000, metodoPago: 'bold' });
  assert.equal(contraentrega.base, 12000);
  assert.equal(contraentrega.pagoEnCasa, 15950);
  assert.equal(contraentrega.total, 27950);
  assert.deepEqual(contraentrega.paquete, { tipo: 'caja_pequena', kilosAdicionales: 0 });
  assert.equal(anticipado.total, 12000);
  assert.equal(anticipado.pagoEnCasa, 0);
});

test('respeta el envío gratis de las gafas incluso en contraentrega', () => {
  const item = [{ sku: 'MPX-G-ULTRA-NEG', qty: 1, precio: 420000, envioGratis: true }];
  const contraentrega = catalogo.calcularEnvio({ ciudad: 'Medellín', items: item, subtotal: 420000, metodoPago: 'contraentrega' });
  assert.equal(contraentrega.total, 0);
  assert.equal(contraentrega.pagoEnCasa, 0);
});

test('dos clientes no reservan simultáneamente la última unidad', async () => {
  store.set('stock:MPX-G-PRO', '1');
  const results = await Promise.allSettled([createCodOrder(input('Casual Pro')), createCodOrder(input('Casual Pro'))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(store.get('stock:MPX-G-PRO'), '0');
  assert.equal(emailCount, 1);
});

test('reintentar la misma contraentrega devuelve el pedido original sin reservar otra unidad', async () => {
  store.set('stock:MPX-G-PRO', '2');
  const request = input('Casual Pro');
  const first = await createCodOrder(request);
  const retry = await createCodOrder({ ...request });
  assert.equal(retry.referencia, first.referencia);
  assert.equal(store.get('stock:MPX-G-PRO'), '1');
  assert.equal(emailCount, 1);
});

test('rechaza reutilizar una clave de contraentrega con datos distintos', async () => {
  store.set('stock:MPX-G-PRO', '2');
  const request = input('Casual Pro');
  await createCodOrder(request);
  await assert.rejects(
    () => createCodOrder({ ...request, ciudad: 'Medellín' }),
    error => error.statusCode === 409 && /idempotencia/i.test(error.message),
  );
  assert.equal(store.get('stock:MPX-G-PRO'), '1');
});

test('un carrito de varios SKU se reserva como todo o nada', async () => {
  store.set('stock:MPX-G-STD', '1');
  store.set('stock:MPX-G-PRO', '0');
  const result = await catalogo.reservarStock([
    { sku: 'MPX-G-STD', qty: 1 },
    { sku: 'MPX-G-PRO', qty: 1 },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.sku, 'MPX-G-PRO');
  assert.equal(store.get('stock:MPX-G-STD'), '1');
  assert.equal(store.get('stock:MPX-G-PRO'), '0');
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

test('el stock publico conserva las unidades restantes de un SKU con varias piezas', async () => {
  store.set('stock:MPX-G-STD', '2');
  store.set('pedido:MPX-COD-RESERVA-01', JSON.stringify({ estado: 'COD_CONFIRMED', stockLiberado: false, items: [{ sku: 'MPX-G-STD', qty: 1 }] }));
  const stock = await catalogo.stockDeTodos();
  assert.equal(stock['MPX-G-STD'], 2);
});

test('reactivar una contraentrega expirada vuelve a reservar el inventario', async () => {
  store.set('stock:MPX-RC-P12-ROJ', '1');
  const order = await createCodOrder({ ...input('Casual Standard'), items: [{ sku: 'MPX-RC-P12-ROJ', qty: 1 }], product_name: undefined });
  order.expiraEn = new Date(Date.now() - 1000).toISOString();
  store.set(`pedido:${order.referencia}`, JSON.stringify(order));
  await expireCodOrders();
  assert.equal(JSON.parse(store.get(`pedido:${order.referencia}`)).estado, 'COD_EXPIRED');
  const reactivated = await updateCodOrder(order.referencia, 'confirm_expired');
  assert.equal(reactivated.estado, 'COD_CONFIRMED');
  assert.equal(reactivated.stockLiberado, false);
  assert.equal(store.get('stock:MPX-RC-P12-ROJ'), '0');
});

test('reactivar una contraentrega cancelada conserva la venta contabilizada', async () => {
  store.set('stock:MPX-RC-P12-ROJ', '1');
  const order = await createCodOrder({ ...input('Casual Standard'), items: [{ sku: 'MPX-RC-P12-ROJ', qty: 1 }], product_name: undefined });
  await updateCodOrder(order.referencia, 'confirm');
  await updateCodOrder(order.referencia, 'cancel');
  assert.equal(store.get('stock:MPX-RC-P12-ROJ'), '1');
  const reactivated = await updateCodOrder(order.referencia, 'confirm_cancelled');
  assert.equal(reactivated.estado, 'COD_CONFIRMED');
  assert.equal(reactivated.stockLiberado, false);
  assert.equal(store.get('stock:MPX-RC-P12-ROJ'), '0');
  assert.equal(store.get('vendido:MPX-RC-P12-ROJ'), '1');
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

test('dos limpiezas Bold no liberan dos veces la misma reserva vencida', async () => {
  store.set('stock:MPX-G-PRO', '0');
  store.set('reserva:MPX-BOLD-EXPIRADA', JSON.stringify({
    expiraEn: new Date(Date.now() - 1000).toISOString(),
    items: [{ sku: 'MPX-G-PRO', qty: 1 }],
  }));

  await Promise.all([catalogo.liberarReservasVencidas(), catalogo.liberarReservasVencidas()]);

  assert.equal(store.get('stock:MPX-G-PRO'), '1');
  const reserva = JSON.parse(store.get('reserva:MPX-BOLD-EXPIRADA'));
  assert.equal(reserva.estado, 'EXPIRED');
  assert.equal(reserva.stockLiberado, true);
});

test('vencimiento y aprobacion Bold simultaneos conservan una sola reserva de stock', async () => {
  const reference = 'MPX-BOLD-EXPIRA-Y-PAGA';
  store.set('stock:MPX-G-PRO', '0');
  store.set(`reserva:${reference}`, JSON.stringify({
    expiraEn: new Date(Date.now() - 1000).toISOString(),
    items: [{ sku:'MPX-G-PRO', qty:1 }],
    total: 359000,
    cliente: { nombre:'Cliente Prueba', email:'cliente@example.com', telefono:'573001234567' },
  }));

  await Promise.all([
    catalogo.liberarReservasVencidas(),
    processBoldEvent(reference, { type:'SALE_APPROVED', eventId:'evt-race', paymentId:'pay-race', amount:{ total:359000, currency:'COP' } }),
  ]);

  assert.equal(store.get('stock:MPX-G-PRO'), '0');
  assert.equal(store.get('vendido:MPX-G-PRO'), '1');
  assert.equal(JSON.parse(store.get(`pedido:${reference}`)).estado, 'SALE_APPROVED');
  assert.equal(store.has(`reserva:${reference}`), false);
});

test('un registro corrupto no bloquea la limpieza de otras reservas y pedidos', async () => {
  store.set('reserva:CORRUPTA', '{no-json');
  store.set('reserva:VALIDA', JSON.stringify({ expiraEn:new Date(Date.now() - 1000).toISOString(), items:[{ sku:'MPX-G-PRO', qty:1 }] }));
  store.set('stock:MPX-G-PRO', '0');
  store.set('pedido:MPX-COD-CORRUPTO', '{no-json');

  await Promise.all([catalogo.liberarReservasVencidas(), expireCodOrders()]);

  assert.equal(store.get('stock:MPX-G-PRO'), '1');
  assert.equal(JSON.parse(store.get('reserva:VALIDA')).estado, 'EXPIRED');
  assert.equal(store.get('pedido:MPX-COD-CORRUPTO'), '{no-json');
});
