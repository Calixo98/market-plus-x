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
const { upfrontDiscount } = require('../commerce-config');
const { cleanText, cleanEmail, normalizeColombianMobile } = require('../lib/validation');
const { ipHash, rateLimit, verifyTurnstile } = require('../lib/security');
const { begin: beginIdempotency, complete: completeIdempotency, fail: failIdempotency } = require('../lib/idempotency');

const RESERVA_TTL_SEGUNDOS = 15 * 60;
const MAX_QTY_POR_ITEM = 5;
const MAX_ITEMS = 10;

// Limite de tasa por IP: evita que alguien bloquee el inventario mandando
// checkouts sin pagar (cada intento retiene stock por 15 min).
//
// Turnstile evita que un bot bloquee piezas unicas creando links que nunca
// paga. El rate limit atomico de security.js queda como segunda barrera.
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

function publicStoreOrigin() {
  const configured = String(process.env.PUBLIC_STORE_URL || 'https://marketplusx.com').replace(/\/+$/, '');
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(configured)) {
    throw new Error('PUBLIC_STORE_URL invalido');
  }
  return configured;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return error(res, 405, 'Metodo no permitido');

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return error(res, 400, 'JSON invalido'); }
  }
  if (!body || typeof body !== 'object') return error(res, 400, 'Cuerpo de solicitud invalido');

  const { items, ciudad, cliente } = body;
  const paymentMethod = String(body.payment_method || 'bold');
  if (paymentMethod !== 'bold') return error(res, 400, 'Metodo de pago invalido');

  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) {
    return error(res, 400, 'El carrito debe tener entre 1 y ' + MAX_ITEMS + ' referencias');
  }
  for (const it of items) {
    if (!it || typeof it.sku !== 'string' || !Number.isInteger(it.qty) || it.qty < 1 || it.qty > MAX_QTY_POR_ITEM) {
      return error(res, 400, 'Item de carrito invalido');
    }
  }
  let ciudadLimpia;
  try { ciudadLimpia = cleanText(ciudad, { field: 'Ciudad', min: 2, max: 100 }); }
  catch { return error(res, 400, 'Ciudad de envio invalida'); }
  if (!cliente || typeof cliente !== 'object') return error(res, 400, 'Datos del cliente requeridos');
  const { nombre, email, telefono, direccion, departamento } = cliente;
  let clienteLimpio;
  try {
    clienteLimpio = {
      nombre: cleanText(nombre, { field: 'Nombre', min: 3, max: 120 }),
      email: cleanEmail(email),
      telefono: normalizeColombianMobile(telefono),
      direccion: cleanText(direccion, { field: 'Direccion', min: 5, max: 300 }),
      departamento: departamento ? cleanText(departamento, { field: 'Departamento', min: 2, max: 100 }) : null,
    };
  } catch (validationError) {
    return error(res, 400, validationError.message);
  }

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
  let idempotencyContext = null;
  let paymentCreated = false;

  try {
    const suppliedIdempotencyKey = body.idempotency_key || req.headers['idempotency-key'];
    idempotencyContext = await beginIdempotency('checkout', suppliedIdempotencyKey, {
      items: itemsResueltos.map(item => ({ sku: item.sku, qty: item.qty })),
      ciudad: ciudadLimpia,
      cliente: clienteLimpio,
      paymentMethod,
    });
    if (idempotencyContext.status === 'completed') {
      return res.status(200).json(idempotencyContext.response);
    }

    if (!(await rateLimit(`checkout:${ipHash(req)}`, LIMITE_INTENTOS_POR_VENTANA, VENTANA_LIMITE_SEGUNDOS))) {
      await failIdempotency(idempotencyContext);
      return error(res, 429, 'Demasiados intentos. Espera unos minutos e intenta de nuevo.');
    }
    if (!(await verifyTurnstile(body.turnstile_token, req))) {
      await failIdempotency(idempotencyContext);
      return error(res, 403, 'Verificacion de seguridad fallida. Recarga e intenta nuevamente.');
    }

    // Liberar reservas abandonadas antes de intentar reservar la nueva: evita
    // que carritos nunca pagados dejen el inventario bloqueado indefinidamente.
    await catalogo.liberarReservasVencidas();

    // La reserva y el descuento de stock se guardan juntos mas abajo, dentro
    // de un unico EVAL. Aqui solo resolvemos el carrito validado.
    const itemsParaReservar = itemsResueltos.map(it => ({ sku: it.sku, qty: it.qty }));
      // Calcular el total. Envio gratis solo si TODO el carrito son referencias con envioGratis.
      const subtotal = itemsResueltos.reduce((acc, it) => acc + it.precio * it.qty, 0);
      const todoEnvioGratis = itemsResueltos.every(it => it.envioGratis);
      const zona = catalogo.buscarZonaEnvio(ciudadLimpia);
      const envioDetalle = todoEnvioGratis
        ? { total: 0, base: 0, pagoEnCasa: 0, estimado: false, zona: { id: zona.id, nombre: zona.nombre } }
        : catalogo.calcularEnvio({ ciudad: ciudadLimpia, items: itemsResueltos, metodoPago: paymentMethod, subtotal });
      const envio = envioDetalle.total;
      const porcentaje = Number(upfrontDiscount?.percentage);
      const descuento = upfrontDiscount?.enabled && upfrontDiscount.paymentMethod === paymentMethod && Number.isFinite(porcentaje) && porcentaje > 0 && porcentaje <= 100
        ? Math.round(subtotal * porcentaje / 100)
        : 0;
      const total = subtotal - descuento + envio;

      // Referencia unica (queda en metadata.reference en Bold, y es la clave
      // que el webhook usa para encontrar de nuevo esta reserva).
      const referencia = `MPX-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      const expiraEnMs = Date.now() + RESERVA_TTL_SEGUNDOS * 1000;
      const expirationTime = new Date(expiraEnMs).toISOString();

      // El dominio de retorno lo fija el servidor; el navegador/proxy no puede
      // elegirlo mediante Host o Forwarded. Esto evita callbacks manipulados.
      const callbackUrl = `${publicStoreOrigin()}/pago-respuesta.html`;

      const reservationKey = `reserva:${referencia}`;
      const reservation = {
        items: itemsParaReservar,
        ciudad: ciudadLimpia,
        zona: zona.id,
        cliente: clienteLimpio,
        subtotal,
        descuento,
        envio,
        envioDetalle,
        total,
        creadoEn: new Date().toISOString(),
        expiraEn: expirationTime,
        stockLiberado: false,
        // El webhook llega desde Bold y no conoce el navegador del comprador.
        ip,
        userAgent: req.headers['user-agent'] || null,
      };
      const stored = await catalogo.guardarConInventario(reservationKey, reservation, {
        stockDeltas: itemsParaReservar.map(item => ({ sku:item.sku, delta:-item.qty })),
      });
      if (!stored.ok) {
        const producto = catalogo.buscarProducto(stored.sku);
        await failIdempotency(idempotencyContext);
        return error(res, 409, `Sin stock suficiente para ${producto ? producto.nombre : stored.sku} (quedan ${stored.disponible})`);
      }

      let paymentUrl;
      let paymentLink;
      try {
        ({ url: paymentUrl, paymentLink } = await crearLinkDePago({
          referencia,
          totalPesos: total,
          moneda: catalogo.moneda,
          descripcion: `Market Plus X — pedido ${referencia}`,
          callbackUrl,
          expiraEnMs,
          payerEmail: clienteLimpio.email,
          identidad,
        }));
        paymentCreated = true;
      } catch (boldError) {
        // La reserva ya existe: liberar y marcarla en la misma transaccion.
        // El limpiador vera stockLiberado=true y nunca sumara esas unidades de nuevo.
        await catalogo.guardarConInventario(reservationKey, {
          ...reservation,
          estado: 'LINK_FAILED',
          stockLiberado: true,
          falloEn: new Date().toISOString(),
        }, { stockDeltas: itemsParaReservar.map(item => ({ sku:item.sku, delta:item.qty })) });
        throw boldError;
      }

      if (paymentLink) {
        // Conserva ambos identificadores: Bold puede devolver el link LNK_*
        // en metadata.reference en algunos flujos, mientras que otras
        // notificaciones usan la referencia externa MPX_*. Estas escrituras
        // son auxiliares: si fallan, nunca se libera una reserva cuyo cobro
        // ya existe; el webhook puede seguir resolviendo la referencia MPX_*.
        try {
          await catalogo.guardarConInventario(reservationKey, {
            ...reservation,
            paymentUrl,
            paymentLink,
          });
          await kv.set(`bold-link:${paymentLink}`, referencia, { exSeconds: catalogo.RESERVA_TTL_RESPALDO_SEGUNDOS });
        } catch (metadataError) {
          console.error(`No se pudo guardar metadata Bold para ${referencia}; se conserva la reserva:`, metadataError.message || metadataError);
        }
      }
      // La reserva activa no recibe TTL físico: si Redis la elimina antes del
      // limpiador, el stock quedaría descontado sin forma de reconciliarlo.
      // El vencimiento lógico usa `expiraEn`; el cron de mantenimiento aplica
      // después el TTL de respaldo cuando ya liberó el inventario.

      const response = {
        ok: true,
        paymentUrl,
        paymentLink: paymentLink || null,
        resumen: { subtotal, descuento, envio, envioEstimado: envioDetalle.estimado, notaEnvio: envioDetalle.nota || null, total, zona: zona.nombre },
      };
      await completeIdempotency(idempotencyContext, response);
      return res.status(200).json(response);
  } catch (err) {
    // Si Bold ya devolvio una URL, no borrar la clave: un reintento debe
    // quedarse bloqueado para evitar crear un segundo cobro mientras se
    // reconcilia una posible escritura incompleta de idempotencia.
    if (!paymentCreated) await failIdempotency(idempotencyContext);
    console.error('Error en /api/checkout:', err);
    const status = Number(err.statusCode) >= 400 && Number(err.statusCode) < 500 ? err.statusCode : 500;
    return error(res, status, status < 500 ? err.message : 'No se pudo iniciar el pago. Intenta de nuevo en un momento.');
  }
};
