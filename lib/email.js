const { fetchWithTimeout } = require('./http');

async function sendOperationalEmail({ subject, text, idempotencyKey }) {
  const apiKey = process.env.RESEND_API_KEY; const from = process.env.EMAIL_FROM; const to = process.env.NOTIFY_EMAIL;
  if (!apiKey || !from || !to) throw new Error('Faltan RESEND_API_KEY / EMAIL_FROM / NOTIFY_EMAIL');
  const response = await fetchWithTimeout('https://api.resend.com/emails', { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ from, to: [to], subject, text }) });
  const data = await response.json().catch(() => null); if (!response.ok) throw new Error(`Resend ${response.status}: ${JSON.stringify(data)}`); return data?.id || null;
}
function orderEmail(order) {
  const items = (order.items || []).map(i => `${i.qty} x ${i.nombre || i.sku} (${i.sku})`).join('\n'); const c = order.cliente || {};
  return [`Referencia: ${order.referencia}`, `Estado: ${order.estado}`, `Metodo: ${order.metodo || 'Bold'}`, ...(order.requiereRevision ? [`REVISION MANUAL: ${order.motivoRevision || 'Revisar el pago en Bold.'}`, `Monto recibido: $${Number(order.montoRecibido || 0).toLocaleString('es-CO')} ${order.monedaRecibida || ''}`] : []), '', 'Productos:', items, '', `Subtotal: $${Number(order.subtotal || 0).toLocaleString('es-CO')} COP`, `Envio: $${Number(order.envio || 0).toLocaleString('es-CO')} COP`, `Total: $${Number(order.total || order.montoRecibido || 0).toLocaleString('es-CO')} COP`, '', `Cliente: ${c.nombre || ''}`, `Cedula: ${c.documento || 'No registrada'}`, `WhatsApp: ${c.telefono || ''}`, `Correo: ${c.email || ''}`, `Ciudad: ${order.ciudad || ''}`, `Departamento: ${c.departamento || ''}`, `Direccion: ${c.direccion || ''}`].join('\n');
}
async function notifyOrder(order) {
  const subject = order.requiereRevision
    ? `REVISAR pago Bold - ${order.referencia}`
    : order.metodo === 'contraentrega'
      ? `Pedido contraentrega por confirmar - ${order.referencia}`
      : `Venta Bold aprobada - ${order.referencia}`;
  return sendOperationalEmail({ subject, text: orderEmail(order), idempotencyKey: `marketplus-order-${order.referencia}-${order.estado}`.slice(0, 256) });
}
module.exports = { sendOperationalEmail, notifyOrder };
