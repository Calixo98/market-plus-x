const crypto = require('crypto'); const kv = require('./kv'); const catalogo = require('./catalogo'); const { notifyOrder } = require('./email'); const { enviarEventoCompra, enviarEventoLeadContraentrega } = require('./meta');
const COD_TTL_MS = 24 * 60 * 60 * 1000;
async function expireCodOrders() {
  const keys = await kv.scanAll('pedido:MPX-COD-*');
  for (const key of keys) { const raw = await kv.get(key); if (!raw) continue; const candidate = JSON.parse(raw); if (candidate.estado !== 'COD_PENDING_CONFIRMATION' || new Date(candidate.expiraEn).getTime() > Date.now()) continue; await kv.withLock(`lock:${key}`, async () => { const currentRaw = await kv.get(key); if (!currentRaw) return; const order = JSON.parse(currentRaw); if (order.estado !== 'COD_PENDING_CONFIRMATION' || order.stockLiberado || new Date(order.expiraEn).getTime() > Date.now()) return; await catalogo.liberarStock(order.items); order.estado = 'COD_EXPIRED'; order.stockLiberado = true; order.actualizadoEn = new Date().toISOString(); await kv.set(key, JSON.stringify(order)); }); }
}
function resolveItems(input) {
  if (Array.isArray(input.items)) return input.items.map(i => ({ sku: i.sku, qty: Number(i.qty) }));
  if (input.product_name) {
    const aliases = { 'Casual Standard': 'MPX-G-STD', 'Casual Pro': 'MPX-G-PRO', 'Casual Ultra': 'MPX-G-ULTRA-NEG' };
    const normalizedVariant = String(input.variant || '').toLowerCase();
    const deportivaSku = input.product_name === 'Deportiva Ciclismo'
      ? (normalizedVariant.includes('naranj') ? 'MPX-G-DEP-NAR' : normalizedVariant.includes('negr') ? 'MPX-G-DEP-NEG' : null)
      : null;
    const p = catalogo.productos.find(x => x.nombre === input.product_name || x.sku === aliases[input.product_name] || x.sku === deportivaSku);
    return p ? [{ sku: p.sku, qty: Number(input.qty || 1) }] : [];
  }
  return [];
}
async function createCodOrder(input) {
  await expireCodOrders(); const items = resolveItems(input);
  if (!items.length || items.length > 10 || items.some(i => !catalogo.buscarProducto(i.sku) || !Number.isInteger(i.qty) || i.qty < 1 || i.qty > 5)) throw new Error('Productos invalidos');
  const c = input.cliente || {};
  if (String(c.nombre || '').trim().length < 3 || String(c.telefono || '').replace(/\D/g, '').length < 7 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(c.email || '')) || String(c.documento || '').replace(/\D/g, '').length < 6 || String(c.direccion || '').trim().length < 5 || String(c.departamento || '').trim().length < 2 || String(input.ciudad || '').trim().length < 2 || !input.consent?.accepted) throw new Error('Faltan datos obligatorios o consentimiento');
  const detailed = items.map(i => { const p = catalogo.buscarProducto(i.sku); return { ...i, nombre: p.nombre, precio: p.precio, envioGratis: p.envioGratis }; });
  const reserved = await catalogo.reservarStock(items); if (!reserved.ok) throw new Error(`Sin stock suficiente para ${reserved.sku}`);
  try {
    const subtotal = detailed.reduce((sum, i) => sum + i.precio * i.qty, 0); const zone = catalogo.buscarZonaEnvio(input.ciudad); const envio = detailed.every(i => i.envioGratis) ? 0 : zone.tarifa;
    const referencia = `MPX-COD-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const order = { referencia, metodo: 'contraentrega', estado: 'COD_PENDING_CONFIRMATION', items: detailed, cliente: { nombre: c.nombre.trim(), telefono: c.telefono, email: c.email, documento: c.documento, direccion: c.direccion.trim(), departamento: c.departamento || null }, ciudad: String(input.ciudad).trim(), zona: zone.id, subtotal, envio, total: subtotal + envio, consentimiento: { accepted: true, source: input.consent.source || 'checkout', policy_version: input.consent.policy_version || '2026-08-13', accepted_at: new Date().toISOString() }, conversation_id: input.conversation_id || null, creadoEn: new Date().toISOString(), expiraEn: new Date(Date.now() + COD_TTL_MS).toISOString(), stockLiberado: false };
    await kv.set(`pedido:${referencia}`, JSON.stringify(order));
    try { order.emailNotificationId = await notifyOrder(order); order.emailNotificationStatus = 'sent'; } catch (error) { order.emailNotificationStatus = 'failed'; order.emailNotificationError = String(error.message || error); }
    await kv.set(`pedido:${referencia}`, JSON.stringify(order));
    await enviarEventoLeadContraentrega({ referencia, total:order.total, email:order.cliente.email, telefono:order.cliente.telefono, ip:input.event_context?.ip, userAgent:input.event_context?.userAgent, eventTime:Math.floor(Date.now()/1000) });
    console.info(JSON.stringify({ event:'cod_order_created', reference:referencia, total:order.total, itemCount:order.items.reduce((n,i)=>n+i.qty,0), emailNotificationStatus:order.emailNotificationStatus }));
    return order;
  } catch (error) { await catalogo.liberarStock(items); throw error; }
}
async function updateCodOrder(reference, action) {
  await expireCodOrders(); const key = `pedido:${reference}`;
  return kv.withLock(`lock:${key}`, async () => { const raw = await kv.get(key); if (!raw) throw new Error('Pedido no encontrado'); const order = JSON.parse(raw);
    let justConfirmed = false; let justCancelled = false;
    if (action === 'confirm' && order.estado === 'COD_PENDING_CONFIRMATION') { order.estado = 'COD_CONFIRMED'; order.confirmadoEn = new Date().toISOString(); for (const item of order.items) await kv.incrby(`vendido:${item.sku}`, item.qty); justConfirmed = true; }
    else if (action === 'cancel' && order.estado === 'COD_PENDING_CONFIRMATION' && !order.stockLiberado) { await catalogo.liberarStock(order.items); order.estado = 'COD_CANCELLED'; order.stockLiberado = true; order.canceladoEn = new Date().toISOString(); justCancelled = true; }
    await kv.set(key, JSON.stringify(order));
    if (justConfirmed) await enviarEventoCompra({ referencia:`cod-purchase-${order.referencia}`, total:order.total, moneda:'COP', email:order.cliente.email, telefono:order.cliente.telefono, eventTime:Math.floor(Date.now()/1000) });
    console.info(JSON.stringify({ event:`cod_order_${action}`, reference:reference, state:order.estado, changed:justConfirmed || justCancelled }));
    return order;
  });
}
module.exports = { createCodOrder, updateCodOrder, expireCodOrders };
