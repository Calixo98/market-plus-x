// Utilidades de integracion con Wompi (firma de integridad y checksum de eventos).
// Referencia: https://docs.wompi.co/docs/colombia/widget-checkout-web/
//             https://docs.wompi.co/docs/colombia/eventos/
//
// El secreto de integridad y el secreto de eventos SOLO viven aqui (backend).
// Nunca deben aparecer en un archivo servido al navegador.

const crypto = require('crypto');

// SHA256(referencia + montoEnCentavos + moneda [+ expirationTimeISO] + secretoIntegridad)
function firmarIntegridad({ referencia, montoEnCentavos, moneda, expirationTime, secreto }) {
  const partes = [referencia, montoEnCentavos, moneda];
  if (expirationTime) partes.push(expirationTime);
  partes.push(secreto);
  return crypto.createHash('sha256').update(partes.join('')).digest('hex');
}

// Resuelve una ruta tipo "transaction.id" dentro del objeto `data` del payload del evento.
function resolverRuta(obj, ruta) {
  return ruta.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

// Valida el checksum de un evento de Wompi (webhook). Devuelve true/false.
function validarChecksumEvento(payload, secretoEventos) {
  const { signature, timestamp, data } = payload;
  if (!signature || !Array.isArray(signature.properties) || !signature.checksum) return false;

  const valores = signature.properties.map(ruta => resolverRuta(data, ruta));
  if (valores.some(v => v === undefined)) return false;

  const cadena = valores.join('') + timestamp + secretoEventos;
  const calculado = crypto.createHash('sha256').update(cadena).digest('hex');
  return calculado.toLowerCase() === String(signature.checksum).toLowerCase();
}

module.exports = { firmarIntegridad, validarChecksumEvento };
