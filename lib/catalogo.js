// Fuente unica de verdad de precios, stock inicial y tarifas de envio.
// Las funciones de api/ SIEMPRE recalculan el total desde aqui: el navegador
// nunca decide cuanto vale un pedido.

const fs = require('fs');
const path = require('path');
const kv = require('./kv');

const productos = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'productos.json'), 'utf8'));
const envios = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'envios.json'), 'utf8'));

function buscarProducto(sku) {
  return productos.productos.find(p => p.sku === sku) || null;
}

function buscarZonaEnvio(ciudad) {
  const normalizada = String(ciudad || '').trim().toLowerCase();
  const zona =
    envios.zonas.find(z => z.ciudades.some(c => c.toLowerCase() === normalizada)) ||
    envios.zonas.find(z => z.id === 'resto');
  return zona;
}

// Suma cuanto stock esta actualmente retenido por reservas activas (no vencidas) para un SKU.
async function stockRetenido(sku) {
  const claves = await kv.scanAll('reserva:*');
  if (claves.length === 0) return 0;
  const valores = await Promise.all(claves.map(k => kv.get(k)));
  let total = 0;
  for (const v of valores) {
    if (!v) continue;
    const reserva = JSON.parse(v);
    for (const item of reserva.items) {
      if (item.sku === sku) total += item.qty;
    }
  }
  return total;
}

// Stock disponible ahora mismo = inicial - vendido - retenido por reservas vigentes.
async function stockDisponible(sku) {
  const producto = buscarProducto(sku);
  if (!producto) return 0;
  const vendidoRaw = await kv.get(`vendido:${sku}`);
  const vendido = vendidoRaw ? parseInt(vendidoRaw, 10) : 0;
  const retenido = await stockRetenido(sku);
  return Math.max(0, producto.stockInicial - vendido - retenido);
}

async function stockDeTodos() {
  const resultado = {};
  for (const p of productos.productos) {
    resultado[p.sku] = await stockDisponible(p.sku);
  }
  return resultado;
}

module.exports = {
  productos: productos.productos,
  moneda: productos.moneda,
  whatsapp: productos.whatsapp,
  envios: envios.zonas,
  buscarProducto,
  buscarZonaEnvio,
  stockDisponible,
  stockDeTodos,
};
