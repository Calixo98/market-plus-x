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

// Tarifario oficial Inter Rapidísimo 2026-2027 (vigente desde 2026-06-30):
// https://inter-portalweb-public-docs.s3.us-east-1.amazonaws.com/documents/Tarifario.pdf
// El cotizador advierte que la tarifa se ajusta al verificar peso/volumen:
// https://interrapidisimo.com/cotiza-tu-envio/
const RESERVA_TTL_RESPALDO_SEGUNDOS = 24 * 60 * 60; // red de seguridad de almacenamiento
const PRECIOS_RACING = productos.productos.filter(producto => producto.sku.startsWith('MPX-RC-')).map(producto => Number(producto.precio));
const SUBTOTAL_RACING_PROMEDIO = Math.round(PRECIOS_RACING.reduce((total, precio) => total + precio, 0) / PRECIOS_RACING.length);
const PAQUETE_RACING = Object.freeze({
  pesoVolumetricoKg: envios.racing.pesoVolumetricoAproximadoKg,
  pesoFacturableKg: Math.ceil(envios.racing.pesoVolumetricoAproximadoKg),
  divisorVolumetricoCm3PorKg: envios.racing.divisorVolumetricoCm3PorKg,
});

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

  if (todoEnvioGratis) {
    return { total: 0, base: 0, pagoEnCasa: 0, estimado: false, zona: { id: zona.id, nombre: zona.nombre } };
  }

  if (!esRacing) {
    return { total: zona.tarifa, base: zona.tarifa, pagoEnCasa: 0, estimado: false, zona: { id: zona.id, nombre: zona.nombre } };
  }

  const kilosFacturablesPorUnidad = PAQUETE_RACING.pesoFacturableKg;
  const kilosAdicionalesPorUnidad = Math.max(0, kilosFacturablesPorUnidad - 1);
  const tarifaKiloAdicionalPromedio = Number(zona.tarifaRacingKiloAdicionalPromedio || 0);
  const transportePorUnidad = Number(zona.tarifaRacingBase) + (kilosAdicionalesPorUnidad * tarifaKiloAdicionalPromedio);
  const base = transportePorUnidad * Math.max(1, unidadesRacing);
  const esContraentrega = ['cod', 'contraentrega'].includes(String(metodoPago).toLowerCase());
  const pagoEnCasa = esContraentrega ? Math.round(subtotalCalculado * Number(envios.racing.pagoEnCasaPorcentaje) / 100) : 0;
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
  const paquete = linea === 'racing' ? PAQUETE_RACING : null;
  const promedio = calcularEnvio({ ciudad: ciudadNormalizada, linea, metodoPago: 'contraentrega', subtotal: SUBTOTAL_RACING_PROMEDIO });
  const minimo = calcularEnvio({ ciudad: ciudadNormalizada, linea, metodoPago: 'contraentrega', subtotal: Math.min(...PRECIOS_RACING) });
  const maximo = calcularEnvio({ ciudad: ciudadNormalizada, linea, metodoPago: 'contraentrega', subtotal: Math.max(...PRECIOS_RACING) });
  return {
    linea,
    ciudad: ciudadNormalizada,
    zona: { id: zona.id, nombre: zona.nombre },
    moneda: productos.moneda,
    valorReferencial: promedio.total,
    rangoReferencial: { minimo: minimo.total, maximo: maximo.total },
    subtotalCatalogoPromedio: SUBTOTAL_RACING_PROMEDIO,
    componentes: { tarifaBase: promedio.base, pagoEnCasaPromedio: promedio.pagoEnCasa },
    paquete,
    nota: linea === 'racing'
      ? `Promedio para un carro del catálogo. ${envios.racing.nota}`
      : 'Referencia por zona; el valor final lo confirma la transportadora al despachar.',
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

async function skusBloqueadosPorPedidos() {
  const claves = await kv.scanAll('pedido:MPX-COD-*');
  const bloqueados = new Set();
  for (const clave of claves.filter(candidateKey => /^pedido:MPX-COD-[^:]+$/.test(candidateKey))) {
    const raw = await kv.get(clave);
    if (!raw) continue;
    let pedido;
    try { pedido = JSON.parse(raw); } catch { continue; }
    const abierto = ['COD_PENDING_CONFIRMATION', 'COD_CONFIRMED'].includes(pedido.estado) && !pedido.stockLiberado;
    if (!abierto || !Array.isArray(pedido.items)) continue;
    for (const item of pedido.items) if (item?.sku) bloqueados.add(item.sku);
  }
  return bloqueados;
}

async function stockDeTodos() {
  const resultado = {};
  const bloqueados = await skusBloqueadosPorPedidos();
  for (const p of productos.productos) resultado[p.sku] = bloqueados.has(p.sku) ? 0 : await stockDisponible(p.sku);
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
  calcularEnvio,
  estimarEnvio,
  stockDisponible,
  stockDeTodos,
  liberarReservasVencidas,
  reservarStock,
  liberarStock,
};
