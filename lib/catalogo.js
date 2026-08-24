// Fuente unica de verdad de precios, stock inicial y tarifas de envio.
// Las funciones de api/ SIEMPRE recalculan el total desde aqui: el navegador
// nunca decide cuanto vale un pedido.
//
// MODELO DE STOCK (atomico, sin ventana de carrera):
//   stock:{sku}  = contador Redis = unidades disponibles AHORA MISMO.
//   Reservar/liberar un carrito completo se hace en un unico script Lua.
//   vendido:{sku} es solo para reportes; no participa en el calculo de disponibilidad.

const fs = require('fs');
const path = require('path');
const kv = require('./kv');

const productos = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'productos.json'), 'utf8'));
const envios = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'envios.json'), 'utf8'));

// Tarifario oficial Inter Rapidísimo 2026-2027 (vigente desde 2026-06-30):
// https://inter-portalweb-public-docs.s3.us-east-1.amazonaws.com/documents/Tarifario.pdf
// El cotizador advierte que la tarifa se ajusta al verificar peso/volumen:
// https://interrapidisimo.com/cotiza-tu-envio/
// Bold puede reintentar webhooks durante 24 h. Conservamos la reserva vencida
// (ya sin bloquear stock) durante 48 h para reconciliar un pago tardio con sus
// productos, cliente y total en vez de crear un pedido incompleto.
const RESERVA_TTL_RESPALDO_SEGUNDOS = 48 * 60 * 60;
const PAGO_EN_CASA_PORCENTAJE = Number(envios.contraentrega?.pagoEnCasaPorcentaje || 0);
const PRECIOS_GAFAS = productos.productos.filter(producto => producto.sku.startsWith('MPX-G-')).map(producto => Number(producto.precio));
const PRECIOS_RACING = productos.productos.filter(producto => producto.sku.startsWith('MPX-RC-')).map(producto => Number(producto.precio));
const SUBTOTAL_GAFAS_PROMEDIO = Math.round(PRECIOS_GAFAS.reduce((total, precio) => total + precio, 0) / PRECIOS_GAFAS.length);
const SUBTOTAL_RACING_PROMEDIO = Math.round(PRECIOS_RACING.reduce((total, precio) => total + precio, 0) / PRECIOS_RACING.length);
const PAQUETE_GAFAS = Object.freeze({
  tipo: envios.gafas.tipoPaquete,
  kilosAdicionales: 0,
});
const PAQUETE_RACING = Object.freeze({
  pesoVolumetricoKg: envios.racing.pesoVolumetricoAproximadoKg,
  pesoFacturableKg: Math.ceil(envios.racing.pesoVolumetricoAproximadoKg),
  divisorVolumetricoCm3PorKg: envios.racing.divisorVolumetricoCm3PorKg,
});

const STOCK_ONLY_SCRIPT = `
-- MPX_STOCK_ONLY_V1
for i = 1, #KEYS do
  local current = tonumber(redis.call('get', KEYS[i]) or '0')
  local delta = tonumber(ARGV[i])
  if delta < 0 and current + delta < 0 then return {0, i, current} end
end
for i = 1, #KEYS do redis.call('incrby', KEYS[i], ARGV[i]) end
return {1}
`;

const INVENTORY_TRANSITION_SCRIPT = `
-- MPX_INVENTORY_TRANSITION_V1
local stock_count = tonumber(ARGV[2])
local sold_count = tonumber(ARGV[3])
for i = 1, stock_count do
  local current = tonumber(redis.call('get', KEYS[i + 1]) or '0')
  local delta = tonumber(ARGV[i + 3])
  if delta < 0 and current + delta < 0 then return {0, i, current} end
end
for i = 1, stock_count + sold_count do
  redis.call('incrby', KEYS[i + 1], ARGV[i + 3])
end
redis.call('set', KEYS[1], ARGV[1])
for i = stock_count + sold_count + 2, #KEYS do redis.call('del', KEYS[i]) end
return {1}
`;

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

function calcularEnvio({ ciudad, items = [], metodoPago = 'bold', subtotal, linea } = {}) {
  const zona = buscarZonaEnvio(ciudad);
  const itemsResueltos = (Array.isArray(items) ? items : []).map(item => {
    const producto = buscarProducto(item.sku);
    return {
      sku: item.sku,
      qty: Math.max(1, Number(item.qty) || 1),
      precio: Number.isFinite(Number(item.precio)) ? Number(item.precio) : Number(producto?.precio || 0),
      envioGratis: typeof item.envioGratis === 'boolean' ? item.envioGratis : Boolean(producto?.envioGratis),
    };
  });
  const todoEnvioGratis = itemsResueltos.length > 0 && itemsResueltos.every(item => item.envioGratis);
  const unidadesRacing = linea === 'racing'
    ? Math.max(1, itemsResueltos.reduce((total, item) => total + item.qty, 0))
    : itemsResueltos.filter(item => item.sku.startsWith('MPX-RC-')).reduce((total, item) => total + item.qty, 0);
  const esRacing = linea === 'racing' || unidadesRacing > 0;
  const subtotalCalculado = Number.isFinite(Number(subtotal))
    ? Math.max(0, Number(subtotal))
    : itemsResueltos.reduce((total, item) => total + item.precio * item.qty, 0);
  const esContraentrega = ['cod', 'contraentrega'].includes(String(metodoPago).toLowerCase());

  if (todoEnvioGratis) {
    return { total: 0, base: 0, pagoEnCasa: 0, estimado: false, zona: { id: zona.id, nombre: zona.nombre } };
  }

  if (!esRacing) {
    const base = Number(zona.tarifa);
    const pagoEnCasa = esContraentrega ? Math.round(subtotalCalculado * PAGO_EN_CASA_PORCENTAJE / 100) : 0;
    return {
      total: base + pagoEnCasa,
      base,
      pagoEnCasa,
      estimado: true,
      paquete: PAQUETE_GAFAS,
      zona: { id: zona.id, nombre: zona.nombre },
      nota: envios.gafas.nota,
    };
  }

  const kilosFacturablesPorUnidad = PAQUETE_RACING.pesoFacturableKg;
  const kilosAdicionalesPorUnidad = Math.max(0, kilosFacturablesPorUnidad - 1);
  const tarifaKiloAdicionalPromedio = Number(zona.tarifaRacingKiloAdicionalPromedio || 0);
  const transportePorUnidad = Number(zona.tarifaRacingBase) + (kilosAdicionalesPorUnidad * tarifaKiloAdicionalPromedio);
  const base = transportePorUnidad * Math.max(1, unidadesRacing);
  const pagoEnCasa = esContraentrega ? Math.round(subtotalCalculado * PAGO_EN_CASA_PORCENTAJE / 100) : 0;
  const redondeo = Math.max(1, Number(envios.racing.redondeoPesos) || 1);
  const total = Math.ceil((base + pagoEnCasa) / redondeo) * redondeo;
  return {
    total,
    base,
    pagoEnCasa,
    estimado: true,
    pesoFacturableKg: PAQUETE_RACING.pesoFacturableKg * Math.max(1, unidadesRacing),
    kilosAdicionales: kilosAdicionalesPorUnidad * Math.max(1, unidadesRacing),
    tarifaKiloAdicionalPromedio,
    zona: { id: zona.id, nombre: zona.nombre },
    nota: envios.racing.nota,
  };
}

function estimarEnvio({ ciudad, linea = 'racing' } = {}) {
  const ciudadNormalizada = String(ciudad || '').trim();
  if (ciudadNormalizada.length < 2) throw new Error('Ciudad requerida para estimar el envío');
  const zona = buscarZonaEnvio(ciudadNormalizada);
  const esLineaRacing = linea === 'racing';
  const preciosLinea = esLineaRacing ? PRECIOS_RACING : PRECIOS_GAFAS;
  const subtotalPromedio = esLineaRacing ? SUBTOTAL_RACING_PROMEDIO : SUBTOTAL_GAFAS_PROMEDIO;
  const paquete = esLineaRacing ? PAQUETE_RACING : PAQUETE_GAFAS;
  const promedio = calcularEnvio({ ciudad: ciudadNormalizada, linea, metodoPago: 'contraentrega', subtotal: subtotalPromedio });
  const minimo = calcularEnvio({ ciudad: ciudadNormalizada, linea, metodoPago: 'contraentrega', subtotal: Math.min(...preciosLinea) });
  const maximo = calcularEnvio({ ciudad: ciudadNormalizada, linea, metodoPago: 'contraentrega', subtotal: Math.max(...preciosLinea) });
  return {
    linea,
    ciudad: ciudadNormalizada,
    zona: { id: zona.id, nombre: zona.nombre },
    moneda: productos.moneda,
    valorReferencial: promedio.total,
    rangoReferencial: { minimo: minimo.total, maximo: maximo.total },
    subtotalCatalogoPromedio: subtotalPromedio,
    componentes: { tarifaBase: promedio.base, pagoEnCasaPromedio: promedio.pagoEnCasa },
    paquete,
    nota: esLineaRacing
      ? `Promedio para un carro del catálogo. ${envios.racing.nota}`
      : `Promedio para unas gafas del catálogo. ${envios.gafas.nota}`,
  };
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
  // Los pedidos descuentan el contador al reservar. No se fuerza el SKU a
  // cero por existir un pedido abierto: eso ocultaba las otras dos unidades
  // de productos con stock mayor a uno (por ejemplo Casual Standard).
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
    await kv.withLock(`lock:${clave}`, async () => {
      // Releer dentro del mismo lock que usa el webhook: otra limpieza o el
      // evento de Bold pudo resolver esta reserva mientras recorríamos SCAN.
      const raw = await kv.get(clave);
      if (!raw) return;
      let reserva;
      try { reserva = JSON.parse(raw); }
      catch {
        console.error(`Reserva corrupta ignorada: ${clave}`);
        return;
      }
      if (reserva.stockLiberado || reserva.estado === 'EXPIRED') return;
      const expiraEn = new Date(reserva.expiraEn).getTime();
      if (!Number.isFinite(expiraEn) || expiraEn > ahora) return;
      reserva.estado = 'EXPIRED';
      reserva.stockLiberado = true;
      reserva.liberadoEn = new Date().toISOString();
      await guardarConInventario(clave, reserva, {
        stockDeltas: (Array.isArray(reserva.items) ? reserva.items : []).map(item => ({ sku: item.sku, delta: item.qty })),
      });
      await kv.expire(clave, RESERVA_TTL_RESPALDO_SEGUNDOS);
    }, { ttlSeconds: 30 });
  }
}

function agruparDeltas(entries) {
  const grouped = new Map();
  for (const entry of entries || []) {
    const sku = String(entry.sku || '');
    const delta = Number(entry.delta);
    if (!sku || !Number.isInteger(delta) || delta === 0) continue;
    grouped.set(sku, (grouped.get(sku) || 0) + delta);
  }
  return [...grouped.entries()].map(([sku, delta]) => ({ sku, delta })).filter(entry => entry.delta !== 0);
}

async function ajustarStockAtomico(stockDeltas) {
  const entries = agruparDeltas(stockDeltas);
  if (entries.length === 0) return { ok: true };
  await Promise.all(entries.map(entry => asegurarContador(entry.sku)));
  const result = await kv.evalScript(
    STOCK_ONLY_SCRIPT,
    entries.map(entry => `stock:${entry.sku}`),
    entries.map(entry => entry.delta)
  );
  if (Number(result?.[0]) === 0) {
    const failed = entries[Number(result[1]) - 1];
    return { ok: false, sku: failed?.sku, disponible: Number(result[2]) || 0 };
  }
  return { ok: true };
}

// Cambia pedido/reserva, stock y contadores vendidos dentro de un solo EVAL.
// deleteKeys permite consumir una reserva Bold en la misma transicion.
async function guardarConInventario(recordKey, record, { stockDeltas = [], soldDeltas = [], deleteKeys = [] } = {}) {
  const stockEntries = agruparDeltas(stockDeltas);
  const soldEntries = agruparDeltas(soldDeltas);
  await Promise.all(stockEntries.map(entry => asegurarContador(entry.sku)));
  const deletes = [...new Set(deleteKeys.filter(key => key && key !== recordKey))];
  const keys = [
    recordKey,
    ...stockEntries.map(entry => `stock:${entry.sku}`),
    ...soldEntries.map(entry => `vendido:${entry.sku}`),
    ...deletes,
  ];
  const args = [
    JSON.stringify(record),
    stockEntries.length,
    soldEntries.length,
    ...stockEntries.map(entry => entry.delta),
    ...soldEntries.map(entry => entry.delta),
  ];
  const result = await kv.evalScript(INVENTORY_TRANSITION_SCRIPT, keys, args);
  if (Number(result?.[0]) === 0) {
    const failed = stockEntries[Number(result[1]) - 1];
    return { ok: false, sku: failed?.sku, disponible: Number(result[2]) || 0 };
  }
  return { ok: true };
}

async function reservarStock(items) {
  return ajustarStockAtomico((items || []).map(item => ({ sku: item.sku, delta: -Number(item.qty) })));
}

async function liberarStock(items) {
  return ajustarStockAtomico((items || []).map(item => ({ sku: item.sku, delta: Number(item.qty) })));
}

module.exports = {
  productos: productos.productos,
  moneda: productos.moneda,
  whatsapp: productos.whatsapp,
  envios: envios.zonas,
  RESERVA_TTL_RESPALDO_SEGUNDOS,
  buscarProducto,
  buscarZonaEnvio,
  calcularEnvio,
  estimarEnvio,
  stockDisponible,
  stockDeTodos,
  liberarReservasVencidas,
  guardarConInventario,
  reservarStock,
  liberarStock,
};
