const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const pages = ['index.html', 'deportiva.html', 'racing.html', 'racing-producto.html', 'checkout.html'];
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('scripts propios y scripts inline tienen sintaxis valida', () => {
  ['mpx-funnel.js', 'carrito.js', 'chat-widget.js', 'vercel-speed-insights.js', 'lib/meta.js', 'lib/orders.js', 'lib/crm-orders.js', 'api/pedidos.js', 'api/envios-estimado.js'].forEach(file => new vm.Script(read(file), { filename:file }));
  pages.forEach(file => {
    const html = read(file);
    [...html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*type=["']application\/ld\+json["'])[^>]*>([\s\S]*?)<\/script>/gi)]
      .forEach((match, index) => new vm.Script(match[1], { filename:`${file}:inline-${index + 1}` }));
  });
});

test('la tienda prioriza compra web y deja WhatsApp como respaldo', () => {
  const commercial = pages.map(read).join('\n');
  assert.match(commercial, /data-buy-now/);
  assert.match(commercial, /data-open-chat/);
  assert.doesNotMatch(commercial, /Comprar por WhatsApp|Lo quiero por WhatsApp|BOTÓN FLOTANTE WHATSAPP/i);
  assert.doesNotMatch(commercial, /fbq\('track',\s*'Contact'/);
  assert.equal((commercial.match(/wa\.me/g) || []).length, 2);
});

test('los CTA invitan a consultar asesor y el chat identifica a Maria Paula', () => {
  const commercial = pages.map(read).join('\n');
  const advisorCtas = (commercial.match(/[^\r\n]*data-open-chat[^\r\n]*/g) || []).join('\n');
  assert.match(advisorCtas, /Consultar asesor/);
  assert.doesNotMatch(advisorCtas, /Preguntarle a María Paula|Pregúntale a María Paula|Consultar a María Paula/);
  const widget = read('chat-widget.js');
  assert.match(widget, /María Paula · Asesora/);
  assert.match(widget, /location\.protocol === 'file:'/);
  assert.match(widget, /marketplusx\.com/);
});

test('contraentrega usa selección progresiva, consentimiento y confirmación clara', () => {
  const checkout = read('checkout.html');
  assert.match(checkout, /id="selectContraentrega"/);
  assert.match(checkout, /id="formCheckout" class="hidden/);
  assert.match(checkout, /aceptar la politica de privacidad/i);
  assert.match(checkout, /Pronto te contactaremos/);
  assert.match(checkout, /cod_order_submitted/);
});

test('Purchase de contraentrega solo se emite al confirmar', () => {
  const orders = read('lib/orders.js');
  const confirmAt = orders.indexOf("action === 'confirm'");
  const purchaseCallAt = orders.lastIndexOf('enviarEventoCompra');
  assert.ok(confirmAt >= 0 && purchaseCallAt > confirmAt);
});

test('Speed Insights está preparado para las páginas HTML públicas', () => {
  const packageJson = JSON.parse(read('package.json'));
  assert.equal(packageJson.dependencies['@vercel/speed-insights'], '^2.0.0');
  assert.match(read('vercel-speed-insights.js'), /_vercel\/speed-insights\/script\.js/);
  ['index.html', 'deportiva.html', 'racing.html', 'racing-producto.html', 'checkout.html', 'pago-respuesta.html', 'politicas.html']
    .forEach(file => assert.match(read(file), /vercel-speed-insights\.js/));
});

test('el panel CRM renderiza datos con textContent y expone filtros y estados', () => {
  const admin = read('admin-pedidos.html');
  assert.doesNotMatch(admin, /innerHTML/);
  assert.match(admin, /textContent/);
  assert.match(admin, /id="filtroCrm"/);
  assert.match(admin, /id="detallePanel"/);
  assert.match(admin, /id="btnAgregarNota"/);
  ['NEW', 'PENDING_CONFIRMATION', 'CONFIRMED', 'IN_FOLLOW_UP', 'DISPATCHED', 'COMPLETED', 'CANCELLED', 'REJECTED'].forEach(state => assert.match(admin, new RegExp(state)));
});
