// Integracion con Bold (Link de Pagos + verificacion de webhook).
// Referencia: https://developers.bold.co/pagos-en-linea/api-link-de-pagos
//             https://developers.bold.co/webhook
//
// A diferencia de Wompi, crear un cobro con la API de Link de Pagos SOLO
// necesita la llave de identidad en el header Authorization: no hay hash de
// integridad que calcular ni exponer, porque el monto nunca sale de este
// servidor — se lo mandamos a Bold nosotros mismos, server-to-server.
// La llave secreta se usa unicamente para verificar la firma HMAC del webhook.

const crypto = require('crypto');

const BASE_URL = 'https://integrations.api.bold.co';

// Crea un link de pago por un monto cerrado (CLOSE). Devuelve la URL a la que
// hay que redirigir al cliente para que pague.
async function crearLinkDePago({ referencia, totalPesos, moneda, descripcion, callbackUrl, expiraEnMs, payerEmail, identidad }) {
  const resp = await fetch(`${BASE_URL}/online/link/v1`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `x-api-key ${identidad}`,
    },
    body: JSON.stringify({
      amount_type: 'CLOSE',
      amount: { currency: moneda, total_amount: totalPesos, tip_amount: 0 },
      reference: referencia,
      description: descripcion.slice(0, 100),
      callback_url: callbackUrl,
      // Nanosegundos desde epoch. Un poco de perdida de precision del double
      // de JS a esta escala (unos cientos de ms) es irrelevante para una
      // ventana de expiracion de 15 minutos.
      expiration_date: Math.round(expiraEnMs * 1e6),
      ...(payerEmail ? { payer_email: payerEmail } : {}),
    }),
  });

  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data || !data.payload || !data.payload.url) {
    const detalle = data && data.errors ? JSON.stringify(data.errors) : `HTTP ${resp.status}`;
    throw new Error(`Bold rechazo la creacion del link de pago: ${detalle}`);
  }
  return { paymentLink: data.payload.payment_link, url: data.payload.url };
}

// Lee el cuerpo crudo del request SIN tocar req.body (ese getter de
// @vercel/node consume el stream y lo re-serializa; el HMAC de Bold firma los
// bytes exactos que enviaron, no un JSON reconstruido — por eso hay que leer
// el stream nosotros mismos, antes de que nadie mas lo toque).
function leerCuerpoCrudo(req) {
  return new Promise((resolve, reject) => {
    const partes = [];
    req.on('data', (chunk) => partes.push(chunk));
    req.on('end', () => resolve(Buffer.concat(partes)));
    req.on('error', reject);
  });
}

// Verifica el header x-bold-signature: HMAC-SHA256(clave=secreto,
// mensaje=base64(cuerpoCrudo)), comparado en tiempo constante.
//
// OJO: en modo pruebas Bold firma SIEMPRE con clave vacia (documentado
// explicitamente), sin importar el valor real de tu llave secreta de
// pruebas — por eso BOLD_WEBHOOK_SECRET se deja como '' mientras se prueba
// en sandbox, y se reemplaza por el secreto real solo al pasar a produccion.
function verificarFirmaWebhook(cuerpoCrudo, firmaRecibida, secreto) {
  if (!firmaRecibida || typeof firmaRecibida !== 'string') return false;
  const cuerpoBase64 = cuerpoCrudo.toString('base64');
  const calculada = crypto.createHmac('sha256', secreto).update(cuerpoBase64).digest('hex');
  const bufCalculada = Buffer.from(calculada, 'utf8');
  const bufRecibida = Buffer.from(firmaRecibida, 'utf8');
  if (bufCalculada.length !== bufRecibida.length) return false;
  return crypto.timingSafeEqual(bufCalculada, bufRecibida);
}

module.exports = { crearLinkDePago, leerCuerpoCrudo, verificarFirmaWebhook };
