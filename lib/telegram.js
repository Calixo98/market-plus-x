// Notificacion de ventas por Telegram — para que el dueño se entere de un
// pedido aprobado sin tener que entrar manualmente a admin-pedidos.html.
// Se dispara desde api/webhook-bold.js, mismo lugar que el evento de Meta.
//
// Referencia: https://core.telegram.org/bots/api#sendmessage

// No lanza: un fallo de Telegram (token vencido, chat borrado, etc.) no debe
// hacer fallar el webhook de Bold ni afectar el registro del pedido, que ya
// quedo guardado en Redis antes de llamar aqui.
const { fetchWithTimeout } = require('./http');

async function notificarPedidoAprobado({ referencia, total, items, cliente }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error('TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID no configurados: no se notifica el pedido por Telegram');
    return false;
  }

  const listaItems = items.map(i => `  • ${i.qty}× ${i.sku}`).join('\n');
  const texto = [
    '🛒 *Nueva venta aprobada*',
    '',
    `*Referencia:* ${referencia}`,
    `*Total:* $${total.toLocaleString('es-CO')} COP`,
    '',
    '*Productos:*',
    listaItems,
    '',
    `*Cliente:* ${cliente.nombre}`,
    `*Teléfono:* ${cliente.telefono}`,
    `*Dirección:* ${cliente.direccion}`,
  ].join('\n');

  try {
    const resp = await fetchWithTimeout(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: 'Markdown' }),
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || !data.ok) {
      console.error(`Telegram rechazo la notificacion de ${referencia}:`, JSON.stringify(data));
      return false;
    }
    return true;
  } catch (err) {
    console.error(`Error de red notificando por Telegram (${referencia}):`, err.message);
    return false;
  }
}

module.exports = { notificarPedidoAprobado };
