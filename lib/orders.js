const crypto = require('crypto');
const kv = require('./kv');
const catalogo = require('./catalogo');
const { notifyOrder } = require('./email');
const { enviarEventoCompra, enviarEventoLeadContraentrega } = require('./meta');
const { cleanText, cleanEmail, normalizeColombianMobile, cleanDocument } = require('./validation');

const COD_TTL_MS = 24 * 60 * 60 * 1000;
const COD_IDEMPOTENCY_TTL_SECONDS = 48 * 60 * 60;
const COD_IDEMPOTENCY_RE = /^[A-Za-z0-9:_-]{16,120}$/;

function stockDeltas(items, multiplier) {
  return (items || []).map(item => ({ sku: item.sku, delta: Number(item.qty) * multiplier }));
}

async function expireCodOrders() {
  const keys = await kv.scanAll('pedido:MPX-COD-*');
  for (const key of keys.filter(candidate => /^pedido:MPX-COD-[^:]+$/.test(candidate))) {
    const raw = await kv.get(key);
    if (!raw) continue;
    let candidate;
    try { candidate = JSON.parse(raw); }
    catch { console.error(`Pedido contraentrega corrupto: ${key}`); continue; }
    if (candidate.estado !== 'COD_PENDING_CONFIRMATION' || new Date(candidate.expiraEn).getTime() > Date.now()) continue;

    await kv.withLock(`lock:${key}`, async () => {
      const currentRaw = await kv.get(key);
      if (!currentRaw) return;
      const order = JSON.parse(currentRaw);
      if (order.estado !== 'COD_PENDING_CONFIRMATION' || order.stockLiberado || new Date(order.expiraEn).getTime() > Date.now()) return;
      order.estado = 'COD_EXPIRED';
      order.stockLiberado = true;
      order.actualizadoEn = new Date().toISOString();
      await catalogo.guardarConInventario(key, order, { stockDeltas: stockDeltas(order.items, 1) });
    });
  }
}

function resolveItems(input) {
  let rawItems = [];
  if (Array.isArray(input.items)) {
    rawItems = input.items.map(item => ({ sku: item.sku, qty: Number(item.qty) }));
  } else if (input.product_name) {
    const aliases = { 'Casual Standard': 'MPX-G-STD', 'Casual Pro': 'MPX-G-PRO', 'Casual Ultra': 'MPX-G-ULTRA-NEG' };
    const normalizedVariant = String(input.variant || '').toLowerCase();
    const deportivaSku = input.product_name === 'Deportiva Ciclismo'
      ? (normalizedVariant.includes('naranj') ? 'MPX-G-DEP-NAR' : normalizedVariant.includes('negr') ? 'MPX-G-DEP-NEG' : null)
      : null;
    const product = catalogo.productos.find(item => item.nombre === input.product_name || item.sku === aliases[input.product_name] || item.sku === deportivaSku);
    if (product) rawItems = [{ sku: product.sku, qty: Number(input.qty || 1) }];
  }

  const grouped = new Map();
  for (const item of rawItems) grouped.set(item.sku, (grouped.get(item.sku) || 0) + item.qty);
  return [...grouped.entries()].map(([sku, qty]) => ({ sku, qty }));
}

async function saveNotificationResult(key, result) {
  try {
    await kv.withLock(`lock:${key}`, async () => {
      const raw = await kv.get(key);
      if (!raw) return;
      const current = JSON.parse(raw);
      await kv.set(key, JSON.stringify({ ...current, ...result }));
    });
  } catch (error) {
    console.error(`No se pudo guardar el estado de notificacion de ${key}:`, error);
  }
}

async function saveEmailNotificationResult(reference, result) {
  await saveNotificationResult(`pedido:${reference}`, result);
}

async function createCodOrder(input) {
  const clientIdempotencyKey = String(input?.idempotency_key || '').trim();
  if (!COD_IDEMPOTENCY_RE.test(clientIdempotencyKey)) throw new Error('Clave de solicitud invalida');

  const items = resolveItems(input);
  if (!items.length || items.length > 10 || items.some(item => !catalogo.buscarProducto(item.sku) || !Number.isInteger(item.qty) || item.qty < 1 || item.qty > 5)) {
    throw new Error('Productos invalidos');
  }
  if (!input.consent?.accepted) throw new Error('Falta consentimiento para el tratamiento de datos');

  const source = cleanText(input.consent.source || 'checkout', { field: 'Origen de consentimiento', min: 1, max: 40 });
  const policyVersion = cleanText(input.consent.policy_version || '2026-08-13', { field: 'Version de politica', min: 1, max: 40 });
  const contact = input.cliente || {};
  const cliente = {
    nombre: cleanText(contact.nombre, { field: 'Nombre', min: 3, max: 120 }),
    telefono: normalizeColombianMobile(contact.telefono),
    email: cleanEmail(contact.email),
    documento: cleanDocument(contact.documento),
    direccion: cleanText(contact.direccion, { field: 'Direccion', min: 5, max: 300 }),
    departamento: cleanText(contact.departamento, { field: 'Departamento', min: 2, max: 100 }),
  };
  const ciudad = cleanText(input.ciudad, { field: 'Ciudad', min: 2, max: 100 });
  const detailed = items.map(item => {
    const product = catalogo.buscarProducto(item.sku);
    return { ...item, nombre: product.nombre, precio: product.precio, envioGratis: product.envioGratis };
  });
  const subtotal = detailed.reduce((sum, item) => sum + item.precio * item.qty, 0);
  const zone = catalogo.buscarZonaEnvio(ciudad);
  const envioDetalle = detailed.every(item => item.envioGratis)
    ? { total: 0, base: 0, pagoEnCasa: 0, estimado: false, zona: { id: zone.id, nombre: zone.nombre } }
    : catalogo.calcularEnvio({ ciudad, items: detailed, metodoPago: 'contraentrega', subtotal });
  const idempotencyHash = crypto.createHash('sha256').update(clientIdempotencyKey).digest('hex');
  const idempotencyKey = `idempotency:cod:${idempotencyHash}`;
  const requestFingerprint = crypto.createHash('sha256').update(JSON.stringify({
    items: detailed.map(item => ({ sku: item.sku, qty: item.qty })),
    ciudad,
    cliente,
    subtotal,
  })).digest('hex');
  const result = await kv.withLock(`lock:${idempotencyKey}`, async () => {
    const existingRaw = await kv.get(idempotencyKey);
    let existingReference = null;
    let existingFingerprint = null;
    if (existingRaw) {
      try {
        const record = JSON.parse(existingRaw);
        if (record && typeof record === 'object') {
          existingReference = record.reference;
          existingFingerprint = record.fingerprint || null;
        } else {
          existingReference = String(existingRaw);
        }
      } catch {
        existingReference = String(existingRaw);
      }
    }
    if (existingReference) {
      if (existingFingerprint && existingFingerprint !== requestFingerprint) {
        throw Object.assign(new Error('La clave de idempotencia ya fue usada con otros datos'), { statusCode: 409 });
      }
      const existingRaw = await kv.get(`pedido:${existingReference}`);
      if (existingRaw) {
        try { return { order: JSON.parse(existingRaw), replay: true }; }
        catch { throw new Error('Pedido idempotente corrupto'); }
      }
      // La referencia se publica antes de la reserva para que una caída entre
      // ambas operaciones no permita que un reintento cree un segundo pedido.
      throw new Error('Pedido en proceso; intenta nuevamente');
    }

    await expireCodOrders();
    const referencia = `MPX-COD-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const key = `pedido:${referencia}`;
    const order = {
      referencia,
      metodo: 'contraentrega',
      estado: 'COD_PENDING_CONFIRMATION',
      items: detailed,
      cliente,
      ciudad,
      zona: zone.id,
      subtotal,
      envio: envioDetalle.total,
      envioDetalle,
      total: subtotal + envioDetalle.total,
      consentimiento: { accepted: true, source, policy_version: policyVersion, accepted_at: new Date().toISOString() },
      conversation_id: input.conversation_id ? cleanText(input.conversation_id, { field: 'Conversacion', min: 1, max: 100 }) : null,
      creadoEn: new Date().toISOString(),
      expiraEn: new Date(Date.now() + COD_TTL_MS).toISOString(),
      stockLiberado: false,
      idempotency_key: clientIdempotencyKey,
    };

    await kv.set(idempotencyKey, JSON.stringify({ reference: referencia, fingerprint: requestFingerprint, createdAt: new Date().toISOString() }), { exSeconds: COD_IDEMPOTENCY_TTL_SECONDS });
    const stored = await catalogo.guardarConInventario(key, order, { stockDeltas: stockDeltas(items, -1) });
    if (!stored.ok) {
      await kv.del(idempotencyKey);
      throw new Error(`Sin stock suficiente para ${stored.sku}`);
    }
    return { order, replay: false };
  }, { ttlSeconds: 30 });

  if (result.replay) return result.order;
  const { order } = result;
  const orderKey = `pedido:${order.referencia}`;
  await saveNotificationResult(orderKey, {
    emailNotificationStatus: 'sending',
    emailNotificationClaimedAt: new Date().toISOString(),
    emailNotificationAttempts: 1,
    emailNotificationError: null,
  });

  let notificationResult;
  try {
    notificationResult = { emailNotificationId: await notifyOrder(order), emailNotificationStatus: 'sent' };
  } catch (error) {
    notificationResult = { emailNotificationStatus: 'failed', emailNotificationError: String(error.message || error) };
  }
  Object.assign(order, notificationResult);
  await saveNotificationResult(orderKey, notificationResult);

  try {
    await enviarEventoLeadContraentrega({
      referencia: order.referencia,
      total: order.total,
      email: cliente.email,
      telefono: cliente.telefono,
      ip: input.event_context?.ip,
      userAgent: input.event_context?.userAgent,
      eventTime: Math.floor(Date.now() / 1000),
    });
  } catch (error) {
    console.error(`No se pudo enviar Lead de Meta para ${order.referencia}:`, error);
  }
  console.info(JSON.stringify({ event: 'cod_order_created', reference: order.referencia, total: order.total, itemCount: items.reduce((sum, item) => sum + item.qty, 0), emailNotificationStatus: order.emailNotificationStatus }));
  return order;
}

async function updateCodOrder(reference, action) {
  await expireCodOrders();
  const key = `pedido:${reference}`;
  const transition = await kv.withLock(`lock:${key}`, async () => {
    const raw = await kv.get(key);
    if (!raw) throw new Error('Pedido no encontrado');
    const order = JSON.parse(raw);
    let changed = false;
    let shouldEmitPurchase = false;
    let stockChanges = [];
    let soldChanges = [];

    if (action === 'confirm' && order.estado === 'COD_PENDING_CONFIRMATION') {
      order.estado = 'COD_CONFIRMED';
      order.confirmadoEn = new Date().toISOString();
      soldChanges = stockDeltas(order.items, 1);
      changed = true;
      shouldEmitPurchase = true;
    } else if (['confirm_expired', 'confirm_cancelled'].includes(action) && ['COD_EXPIRED', 'COD_CANCELLED'].includes(order.estado) && order.stockLiberado) {
      const now = new Date().toISOString();
      const wasPreviouslyConfirmed = Boolean(order.confirmadoEn);
      order.estado = 'COD_CONFIRMED';
      order.stockLiberado = false;
      order.expiraEn = null;
      order.canceladoEn = null;
      order.confirmadoEn = order.confirmadoEn || now;
      order.reactivadoEn = now;
      stockChanges = stockDeltas(order.items, -1);
      if (!wasPreviouslyConfirmed) {
        soldChanges = stockDeltas(order.items, 1);
        shouldEmitPurchase = true;
      }
      changed = true;
    } else if (action === 'cancel' && ['COD_PENDING_CONFIRMATION', 'COD_CONFIRMED'].includes(order.estado) && !order.stockLiberado) {
      order.estado = 'COD_CANCELLED';
      order.stockLiberado = true;
      order.canceladoEn = new Date().toISOString();
      stockChanges = stockDeltas(order.items, 1);
      changed = true;
    }

    if (changed) {
      const saved = await catalogo.guardarConInventario(key, order, { stockDeltas: stockChanges, soldDeltas: soldChanges });
      if (!saved.ok) throw new Error(`Sin stock suficiente para ${saved.sku}`);
    }
    return { order, changed, shouldEmitPurchase };
  });

  if (transition.shouldEmitPurchase) {
    try {
      await enviarEventoCompra({
        referencia: `cod-purchase-${transition.order.referencia}`,
        total: transition.order.total,
        moneda: 'COP',
        email: transition.order.cliente.email,
        telefono: transition.order.cliente.telefono,
        eventTime: Math.floor(Date.now() / 1000),
      });
    } catch (error) {
      console.error(`No se pudo enviar Purchase de Meta para ${reference}:`, error);
    }
  }
  console.info(JSON.stringify({ event: `cod_order_${action}`, reference, state: transition.order.estado, changed: transition.changed }));
  return transition.order;
}

module.exports = { createCodOrder, updateCodOrder, expireCodOrders, saveNotificationResult, saveEmailNotificationResult };
