// POST /api/checkout
// Recibe el carrito (SKUs + cantidades + ciudad + datos del cliente), recalcula
// el total desde el catalogo del servidor (nunca confia en precios del navegador),
// reserva el stock de forma ATOMICA (ver lib/catalogo.js) y crea un Link de
// Pago de Bold por ese monto exacto. El navegador solo recibe la URL final,
// nunca calcula ni firma nada.
//
// Referencia: https://developers.bold.co/pagos-en-linea/api-link-de-pagos

const crypto = require('crypto');
const kv = require('../lib/kv');
const catalogo = require('../lib/catalogo');
const { crearLinkDePago } = require('../lib/bold');

const RESERVA_TTL_SEGUNDOS = 15 * 60;
const MAX_QTY_POR_ITEM = 5;
const MAX_ITEMS = 10;

// Limite de tasa por IP: evita que alguien bloquee el inventario mandando
// checkouts sin pagar (cada intento retiene stock por 15 min).
//
// OJO: con un catalogo de solo 1-2 unidades por SKU, ningun limite lo bastante
// generoso para clientes reales (que pueden necesitar reintentar 2-3 veces)
// puede impedir matematicamente que UNA sola IP agote el catalogo completo en
// una sola ventana (el total de unidades es menor que cualquier limite razonable
// para humanos). Este limite eleva el costo del ataque (antes: gratis e ilimitado,
// repetible cada 15 min sin espera) a "requiere gastar todo el cupo de una IP y
// esperar 10 min para repetir" — no lo elimina del todo. Cerrarlo del todo
// requeriria verificacion humana (captcha) antes de reservar, fuera de alcance
// de este arreglo.
const LIMITE_INTENTOS_POR_VENTANA = 4;
const VENTANA_LIMITE_SEGUNDOS = 10 * 60;

function error(res, status, mensaje) {
  res.status(status).json({ ok: false, error: mensaje });
}

function obtenerIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'desconocida';
}

async function excedeLimiteDeTasa(ip) {
  const clave = `ratelimit:checkout:${ip}`;
  const conteo = await kv.incrby(clave, 1);
  if (conteo === 1) await kv.expire(clave, VENTANA_LIMITE_SEGUNDOS);
  return conteo > LIMITE_INTENTOS_POR_VENTANA;
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

  // Resolver cada item contra el catalogo real (precio e imagen del servidor,
  // no del cliente). Es validacion pura (sin tocar Redis), corre siempre.
  const itemsResueltos = [];
  for (const it of items) {
    const producto = catalogo.buscarProducto(it.sku);
    if (!producto) return error(res, 400, `SKU desconocido: ${it.sku}`);
    itemsResueltos.push({ sku: it.sku, qty: it.qty, nombre: producto.nombre, precio: producto.precio, envioGratis: producto.envioGratis });
  }

  // Fallar rapido si la integracion de pagos no esta configurada, antes de tocar Redis.
  const identidad = process.env.BOLD_IDENTITY_KEY;
  if (!identidad) return error(res, 500, 'Integracion de pagos no configurada (falta BOLD_IDENTITY_KEY)');

  const ip = obtenerIp(req);

  try {
    if (await excedeLimiteDeTasa(ip)) {
      return error(res, 429, 'Demasiados intentos. Espera unos minutos e intenta de nuevo.');
    }

    // Liberar reservas abandonadas antes de intentar reservar la nueva: evita
    // que carritos nunca pagados dejen el inventario bloqueado indefinidamente.
    await catalogo.liberarReservasVencidas();

    // Reserva ATOMICA: la propia operacion de descuento es la verificacion de
    // stock. No hay ventana entre "leer disponibilidad" y "escribir la reserva".
    const itemsParaReservar = itemsResueltos.map(it => ({ sku: it.sku, qty: it.qty }));
    const resultadoReserva = await catalogo.reservarStock(itemsParaReservar);
    if (!resultadoReserva.ok) {
      const producto = catalogo.buscarProducto(resultadoReserva.sku);
      return error(
        res, 409,
        `Sin stock suficiente para ${producto ? producto.nombre : resultadoReserva.sku} (quedan ${resultadoReserva.disponible})`
      );
    }

    try {
      // Calcular el total. Envio gratis solo si TODO el carrito son referencias con envioGratis.
      const subtotal = itemsResueltos.reduce((acc, it) => acc + it.precio * it.qty, 0);
      const todoEnvioGratis = itemsResueltos.every(it => it.envioGratis);
      const zona = catalogo.buscarZonaEnvio(ciudad);
      const envio = todoEnvioGratis ? 0 : zona.tarifa;
      const total = subtotal + envio;

      // Referencia unica (queda en metadata.reference en Bold, y es la clave
      // que el webhook usa para encontrar de nuevo esta reserva).
      const referencia = `MPX-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      const expiraEnMs = Date.now() + RESERVA_TTL_SEGUNDOS * 1000;
      const expirationTime = new Date(expiraEnMs).toISOString();

      // x-forwarded-proto puede llegar como lista separada por comas si hay
      // varios proxies en la cadena (p.ej. "https,http" en vercel dev, que
      // antepone el suyo al que ya mandamos nosotros) — solo el primer valor
      // es el que importa. Bold rechaza la URL entera si el esquema no es
      // exactamente "https".
      const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
      const callbackUrl = `${proto}://${req.headers.host}/pago-respuesta.html`;

      // Primero se crea el link en Bold, y SOLO si Bold lo acepta se escribe
      // la reserva en Redis. Si se escribiera antes y crearLinkDePago fallara,
      // quedaria un registro reserva:{referencia} huerfano: liberarStock() ya
      // le devuelve las unidades al contador aqui abajo, pero cuando esa
      // reserva huerfana "expirara" mas tarde, liberarReservasVencidas() le
      // devolveria esas MISMAS unidades otra vez, inflando el stock real.
      const { url: paymentUrl } = await crearLinkDePago({
        referencia,
        totalPesos: total,
        moneda: catalogo.moneda,
        descripcion: `Market Plus X — pedido ${referencia}`,
        callbackUrl,
        expiraEnMs,
        payerEmail: email,
        identidad,
      });

      await kv.set(
        `reserva:${referencia}`,
        JSON.stringify({
          items: itemsParaReservar,
          ciudad,
          zona: zona.id,
          cliente: { nombre, email, telefono, direccion, departamento: departamento || null },
          subtotal,
          envio,
          total,
          creadoEn: new Date().toISOString(),
          expiraEn: expirationTime,
        })
      );
      // Red de seguridad de almacenamiento (24h): la logica real de vencimiento
      // usa el campo expiraEn de arriba, no este TTL.
      await kv.expire(`reserva:${referencia}`, catalogo.RESERVA_TTL_RESPALDO_SEGUNDOS);

      return res.status(200).json({
        ok: true,
        paymentUrl,
        resumen: { subtotal, envio, total, zona: zona.nombre },
      });
    } catch (errInterno) {
      // Ya reservamos el stock atomicamente arriba: si algo falla DESPUES de eso
      // (p.ej. Bold rechazo el link, o no se pudo guardar la reserva), hay que
      // devolverlo o el stock quedaria perdido para siempre.
      await catalogo.liberarStock(itemsParaReservar);
      throw errInterno;
    }
  } catch (err) {
    console.error('Error en /api/checkout:', err);
    return error(res, 500, 'No se pudo iniciar el pago. Intenta de nuevo en un momento.');
  }
};
