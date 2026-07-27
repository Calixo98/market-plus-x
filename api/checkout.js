// POST /api/checkout
// Recibe el carrito (SKUs + cantidades + ciudad + datos del cliente), recalcula
// el total desde el catalogo del servidor (nunca confia en precios del navegador),
// reserva el stock por 15 minutos y devuelve los parametros firmados para
// redirigir al Web Checkout de Wompi.
//
// Referencia: https://docs.wompi.co/docs/colombia/widget-checkout-web/

const crypto = require('crypto');
const kv = require('../lib/kv');
const catalogo = require('../lib/catalogo');
const { firmarIntegridad } = require('../lib/wompi');

const RESERVA_TTL_SEGUNDOS = 15 * 60;
const MAX_QTY_POR_ITEM = 5;
const MAX_ITEMS = 10;

function error(res, status, mensaje) {
  res.status(status).json({ ok: false, error: mensaje });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return error(res, 405, 'Metodo no permitido');

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return error(res, 400, 'JSON invalido'); }
  }
  if (!body || typeof body !== 'object') return error(res, 400, 'Cuerpo de solicitud invalido');

  const { items, ciudad, cliente } = body;

  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) {
    return error(res, 400, 'El carrito debe tener entre 1 y ' + MAX_ITEMS + ' referencias');
  }
  for (const it of items) {
    if (!it || typeof it.sku !== 'string' || !Number.isInteger(it.qty) || it.qty < 1 || it.qty > MAX_QTY_POR_ITEM) {
      return error(res, 400, 'Item de carrito invalido');
    }
  }
  if (!ciudad || typeof ciudad !== 'string' || ciudad.trim().length < 2) {
    return error(res, 400, 'Ciudad de envio requerida');
  }
  if (!cliente || typeof cliente !== 'object') return error(res, 400, 'Datos del cliente requeridos');
  const { nombre, email, telefono, direccion, departamento } = cliente;
  if (!nombre || String(nombre).trim().length < 3) return error(res, 400, 'Nombre completo requerido');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return error(res, 400, 'Email invalido');
  if (!telefono || String(telefono).replace(/\D/g, '').length < 7) return error(res, 400, 'Teléfono invalido');
  if (!direccion || String(direccion).trim().length < 5) return error(res, 400, 'Dirección de envío requerida');

  // 1) Resolver cada item contra el catalogo real (precio e imagen del servidor, no del cliente).
  // Es validacion pura (sin tocar Redis), asi que corre siempre, sin importar la configuracion.
  const itemsResueltos = [];
  for (const it of items) {
    const producto = catalogo.buscarProducto(it.sku);
    if (!producto) return error(res, 400, `SKU desconocido: ${it.sku}`);
    itemsResueltos.push({ sku: it.sku, qty: it.qty, nombre: producto.nombre, precio: producto.precio, envioGratis: producto.envioGratis });
  }

  // Fallar rapido si la integracion de pagos no esta configurada, antes de tocar Redis.
  const secreto = process.env.WOMPI_INTEGRITY_SECRET;
  if (!secreto) return error(res, 500, 'Integracion de pagos no configurada (falta WOMPI_INTEGRITY_SECRET)');

  try {
    // 2) Verificar stock disponible AHORA (inicial - vendido - retenido por otras reservas vigentes).
    for (const it of itemsResueltos) {
      const disponible = await catalogo.stockDisponible(it.sku);
      if (disponible < it.qty) {
        return error(res, 409, `Sin stock suficiente para ${it.nombre} (quedan ${disponible})`);
      }
    }

    // 3) Calcular el total. Envio gratis solo si TODO el carrito son referencias con envioGratis.
    const subtotal = itemsResueltos.reduce((acc, it) => acc + it.precio * it.qty, 0);
    const todoEnvioGratis = itemsResueltos.every(it => it.envioGratis);
    const zona = catalogo.buscarZonaEnvio(ciudad);
    const envio = todoEnvioGratis ? 0 : zona.tarifa;
    const total = subtotal + envio;

    // 4) Referencia unica + firma de integridad (el secreto SOLO existe en esta funcion).
    const referencia = `MPX-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const expirationTime = new Date(Date.now() + RESERVA_TTL_SEGUNDOS * 1000).toISOString();
    const amountInCents = Math.round(total * 100);

    const signature = firmarIntegridad({
      referencia,
      montoEnCentavos: amountInCents,
      moneda: catalogo.moneda,
      expirationTime,
      secreto,
    });

    // 5) Reservar el stock por 15 minutos (se descuenta de verdad solo cuando llegue el webhook).
    await kv.set(
      `reserva:${referencia}`,
      JSON.stringify({
        items: itemsResueltos.map(it => ({ sku: it.sku, qty: it.qty })),
        ciudad,
        zona: zona.id,
        cliente: { nombre, email, telefono, direccion, departamento: departamento || null },
        subtotal,
        envio,
        total,
        creadoEn: new Date().toISOString(),
      }),
      { exSeconds: RESERVA_TTL_SEGUNDOS }
    );

    const proto = req.headers['x-forwarded-proto'] || 'https';
    const redirectUrl = `${proto}://${req.headers.host}/pago-respuesta.html`;
    const publicKey = process.env.WOMPI_PUBLIC_KEY || 'pub_prod_qg4b0cfHMATdoZNRvjtdIQVilCstMh9d';

    return res.status(200).json({
      ok: true,
      publicKey,
      currency: catalogo.moneda,
      amountInCents,
      reference: referencia,
      signature,
      expirationTime,
      redirectUrl,
      customer: { email, fullName: nombre, phoneNumber: telefono },
      shipping: { addressLine1: direccion, city: ciudad, region: departamento || ciudad, country: 'CO', phoneNumber: telefono },
      resumen: { subtotal, envio, total, zona: zona.nombre },
    });
  } catch (err) {
    console.error('Error en /api/checkout:', err);
    return error(res, 500, 'No se pudo iniciar el pago. Intenta de nuevo en un momento.');
  }
};
