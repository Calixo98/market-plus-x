// Fuente unica de verdad de precios, stock inicial y tarifas de envio.
// Las funciones de api/ SIEMPRE recalculan el total desde aqui: el navegador
// nunca decide cuanto vale un pedido.
//
// MODELO DE STOCK (atomico, sin ventana de carrera):
//   stock:{sku}  = contador Redis = unidades disponibles AHORA MISMO.
//   Reservar = INCRBY -qty (atomico). Si el resultado queda negativo, la propia
//   operacion demuestra la sobreventa y se deshace de inmediato — no hay un paso
//   de "verificar" separado de un paso de "escribir": son la misma operacion.
//   Liberar (rechazo/expiracion) = INCRBY +qty.
//   vendido:{sku} es solo para reportes; no participa en el calculo de disponibilidad.

const fs = require('fs');
const path = require('path');
const kv = require('./kv');

const productos = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'productos.json'), 'utf8'));
const envios = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'envios.json'), 'utf8'));

const RESERVA_TTL_RESPALDO_SEGUNDOS = 24 * 60 * 60; // red de seguridad de almacenamiento

function buscarProducto(sku) {
  return productos.productos.find(p => p.sku === sku) || null;
}

function buscarZonaEnvio(ciudad) {
  const normalizada = String(ciudad || '').trim().toLowerCase();
  return (
    envios.zonas.find(z => z.ciudades.some(c => c.toLowerCase() === normalizada)) ||
    envios.zonas.find(z => z.id === 'resto')
  );
}

// Siembra el contador de stock la primera vez que se toca un SKU. SETNX es
// atomico: si dos requests llegan a la vez, solo uno "gana" el seed real y el
// otro es un no-op silencioso — nunca se reinicia un contador ya en uso.
async function asegurarContador(sku) {
  const producto = buscarProducto(sku);
  if (!producto) return;
  await kv.setnx(`stock:${sku}`, producto.stockInicial);
}

async function stockDisponible(sku) {
  await asegurarContador(sku);
  const raw = await kv.get(`stock:${sku}`);
  return Math.max(0, parseInt(raw, 10) || 0);
}

async function stockDeTodos() {
  const resultado = {};
  for (const p of productos.productos) resultado[p.sku] = await stockDisponible(p.sku);
  return resultado;
}

// Libera reservas vencidas (15 min sin resolucion, o el plazo extendido si el
// pago quedo PENDING) que ningun webhook llego a resolver. Se corre antes de
// cada intento de checkout para que el stock nunca quede bloqueado para siempre
// por un carrito abandonado.
async function liberarReservasVencidas() {
  const claves = await kv.scanAll('reserva:*');
  if (claves.length === 0) return;
  const ahora = Date.now();
  for (const clave of claves) {
    const raw = await kv.get(clave);
    if (!raw) continue;
    const reserva = JSON.parse(raw);
    if (new Date(reserva.expiraEn).getTime() > ahora) continue; // sigue vigente
    for (const item of reserva.items) {
      await kv.incrby(`stock:${item.sku}`, item.qty);
    }
    await kv.del(clave);
  }
}

// Reserva atomica de una lista de items. Si algun SKU no alcanza, deshace TODO
// lo ya reservado en este mismo lote (todo o nada) y devuelve cual fallo.
async function reservarStock(items) {
  const reservados = [];
  for (const item of items) {
    await asegurarContador(item.sku);
    const nuevoValor = await kv.incrby(`stock:${item.sku}`, -item.qty);
    if (nuevoValor < 0) {
      await kv.incrby(`stock:${item.sku}`, item.qty); // deshacer este
      for (const r of reservados) await kv.incrby(`stock:${r.sku}`, r.qty); // deshacer los previos del lote
      return { ok: false, sku: item.sku, disponible: nuevoValor + item.qty };
    }
    reservados.push(item);
  }
  return { ok: true };
}

async function liberarStock(items) {
  for (const item of items) await kv.incrby(`stock:${item.sku}`, item.qty);
}

module.exports = {
  productos: productos.productos,
  moneda: productos.moneda,
  whatsapp: productos.whatsapp,
  envios: envios.zonas,
  RESERVA_TTL_RESPALDO_SEGUNDOS,
  buscarProducto,
  buscarZonaEnvio,
  stockDisponible,
  stockDeTodos,
  liberarReservasVencidas,
  reservarStock,
  liberarStock,
};
