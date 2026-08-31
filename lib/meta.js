// Meta Conversions API: evento Purchase enviado server-side.
// Se dispara desde el webhook (api/webhook-bold.js), no desde el navegador:
// la redireccion del cliente nunca es prueba confiable de una venta (misma
// razon por la que el stock se descuenta en el webhook, no en pago-respuesta.html).
//
// Referencia: https://developers.facebook.com/docs/marketing-api/conversions-api

const crypto = require('crypto');
const { fetchWithTimeout } = require('./http');

// Mismo Pixel ID que ya esta hardcodeado en el <script> de cada pagina
// (index.html, deportiva.html, checkout.html, politicas.html) — no es un
// secreto, esta pensado para ser publico.
const PIXEL_ID = '2724794924558492';
const GRAPH_API_VERSION = 'v21.0';

function hashSha256(valor) {
  return crypto.createHash('sha256').update(String(valor).trim().toLowerCase()).digest('hex');
}

// Meta exige el telefono en E.164 SIN el "+" antes de hashear. El checkout
// solo pide numeros colombianos y no pide indicativo, asi que se asume 57.
function normalizarTelefono(telefono) {
  const digitos = String(telefono).replace(/\D/g, '');
  if (digitos.startsWith('57') && digitos.length > 10) return digitos;
  return `57${digitos.replace(/^0+/, '')}`;
}

// No lanza: un fallo de Meta (token vencido, rate limit, etc.) no debe hacer
// fallar el webhook de Bold ni afectar el registro del pedido, que ya quedo
// guardado en Redis antes de llamar aqui.
async function enviarEvento({ eventName, eventId, total, moneda, email, telefono, ip, userAgent, eventTime, sourceUrl }) {
  const token = process.env.META_CAPI_ACCESS_TOKEN;
  if (!token) {
    console.error(`META_CAPI_ACCESS_TOKEN no configurado: no se envia ${eventName} a Meta`);
    return false;
  }

  const userData = {
    em: [hashSha256(email)],
    ph: [hashSha256(normalizarTelefono(telefono))],
  };
  if (ip) userData.client_ip_address = ip;
  if (userAgent) userData.client_user_agent = userAgent;

  const body = {
    data: [{
      event_name: eventName,
      event_time: eventTime,
      // Mismo id que la referencia del pedido: si en el futuro se agrega un
      // evento Purchase de navegador con este mismo event_id, Meta los dedupe
      // solo (hoy no existe ese evento de navegador, pero no cuesta nada
      // dejarlo listo).
      event_id: eventId,
      action_source: 'website',
      event_source_url: sourceUrl || 'https://marketplusx.com/checkout.html',
      user_data: userData,
      custom_data: { currency: moneda, value: total },
    }],
  };

  try {
    const resp = await fetchWithTimeout(`https://graph.facebook.com/${GRAPH_API_VERSION}/${PIXEL_ID}/events?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      console.error(`Meta rechazo ${eventName} ${eventId}:`, JSON.stringify(data));
      return false;
    }
    return true;
  } catch (err) {
    console.error(`Error de red enviando ${eventName} ${eventId}:`, err.message);
    return false;
  }
}

async function enviarEventoCompra({ referencia, total, moneda, email, telefono, ip, userAgent, eventTime }) {
  return enviarEvento({ eventName:'Purchase', eventId:referencia, total, moneda, email, telefono, ip, userAgent, eventTime });
}

async function enviarEventoLeadContraentrega({ referencia, total, email, telefono, ip, userAgent, eventTime }) {
  return enviarEvento({ eventName:'Lead', eventId:`cod-lead-${referencia}`, total, moneda:'COP', email, telefono, ip, userAgent, eventTime });
}

module.exports = { enviarEventoCompra, enviarEventoLeadContraentrega };
