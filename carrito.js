// Carrito de compras Market Plus X — estado en localStorage, un solo script
// compartido por index.html, deportiva.html y checkout.html.
//
// Contrato con el HTML de cada pagina:
//   - Un boton con id="carritoBtn" y un <span id="carritoBadge"> dentro, para el contador.
//   - Botones "Agregar al carrito": <button data-add-to-cart data-sku="...">
//   - Selectores de color: <button role="radio" data-color-img data-target data-group
//     data-sku> envolviendo una <img alt="">. Al activarse actualiza la imagen principal,
//     el estado aria-checked del grupo, y si hay un boton "Agregar al carrito" del mismo
//     grupo (data-sku-group), lo apunta al SKU de la variante seleccionada.
//   - Este script inyecta el panel lateral del carrito (dialogo accesible) el solo.
(function () {
  const STORAGE_KEY = 'mpx_carrito';
  let productosCache = null;
  let disparadorApertura = null; // elemento que abrio el panel, para devolverle el foco

  function leerCarrito() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
    } catch {
      return [];
    }
  }

  function guardarCarrito(items) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    actualizarBadge();
  }

  async function cargarProductos() {
    if (productosCache) return productosCache;
    const res = await fetch('productos.json');
    const data = await res.json();
    productosCache = data.productos;
    return productosCache;
  }

  function agregar(sku, qty = 1) {
    const items = leerCarrito();
    const existente = items.find(i => i.sku === sku);
    if (existente) existente.qty += qty;
    else items.push({ sku, qty });
    guardarCarrito(items);
    renderPanel();
    abrirPanel();
  }

  function quitar(sku) {
    guardarCarrito(leerCarrito().filter(i => i.sku !== sku));
    renderPanel();
  }

  function setQty(sku, qty) {
    const items = leerCarrito();
    const item = items.find(i => i.sku === sku);
    if (!item) return;
    if (qty < 1) return quitar(sku);
    item.qty = Math.min(qty, 5);
    guardarCarrito(items);
    renderPanel();
  }

  function totalItems() {
    return leerCarrito().reduce((acc, i) => acc + i.qty, 0);
  }

  function actualizarBadge() {
    const badge = document.getElementById('carritoBadge');
    const btn = document.getElementById('carritoBtn');
    if (!badge) return;
    const n = totalItems();
    badge.textContent = n;
    badge.classList.toggle('hidden', n === 0);
    if (btn) btn.setAttribute('aria-label', n === 0 ? 'Ver carrito, vacío' : `Ver carrito, ${n} artículo${n === 1 ? '' : 's'}`);
  }

  function fmt(n) {
    return '$' + n.toLocaleString('es-CO');
  }

  function crearPanel() {
    if (document.getElementById('carritoPanel')) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <style>
        @media (prefers-reduced-motion: reduce) {
          #carritoPanel { transition: none !important; }
        }
      </style>
      <div id="carritoOverlay" class="fixed inset-0 z-[70] hidden bg-black/60"></div>
      <aside id="carritoPanel" role="dialog" aria-modal="true" aria-labelledby="carritoTitulo"
             class="fixed top-0 right-0 z-[71] h-full w-full max-w-md translate-x-full transition-transform duration-300 bg-raised border-l border-hairline flex flex-col">
        <div class="flex items-center justify-between p-5 border-b border-hairline">
          <h2 id="carritoTitulo" class="text-lg font-bold">Tu carrito</h2>
          <button id="carritoClose" class="w-9 h-9 inline-flex items-center justify-center rounded-lg text-sec hover:text-ink hover:bg-white/5" aria-label="Cerrar carrito">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
        <div id="carritoItems" class="flex-1 overflow-y-auto p-5 space-y-4"></div>
        <div class="p-5 border-t border-hairline space-y-3">
          <div class="flex items-center justify-between text-sm text-sec">
            <span>Subtotal</span>
            <span id="carritoSubtotal" class="font-bold text-ink">$0</span>
          </div>
          <p class="text-xs text-ter">El envío se calcula en el siguiente paso, según tu ciudad.</p>
          <a href="checkout.html" id="carritoIrPagar" class="w-full inline-flex items-center justify-center gap-2 rounded-full bg-accent px-5 py-3.5 text-sm font-bold text-white hover:bg-accent-hover transition">
            Ir a pagar <i class="fa-solid fa-arrow-right text-xs"></i>
          </a>
        </div>
      </aside>`;
    document.body.appendChild(wrap);

    document.getElementById('carritoClose').addEventListener('click', cerrarPanel);
    document.getElementById('carritoOverlay').addEventListener('click', cerrarPanel);
    document.getElementById('carritoPanel').addEventListener('keydown', manejarTeclaPanel);
  }

  function elementosFocuseables(panel) {
    return [...panel.querySelectorAll('button, a[href], input, select, [tabindex]:not([tabindex="-1"])')]
      .filter(el => !el.disabled && el.offsetParent !== null);
  }

  // Escape cierra; Tab queda atrapado dentro del panel mientras esta abierto
  // (patron de dialogo modal — el contenido de fondo no debe ser alcanzable).
  function manejarTeclaPanel(e) {
    if (e.key === 'Escape') {
      cerrarPanel();
      return;
    }
    if (e.key !== 'Tab') return;
    const panel = document.getElementById('carritoPanel');
    const focuseables = elementosFocuseables(panel);
    if (focuseables.length === 0) return;
    const primero = focuseables[0];
    const ultimo = focuseables[focuseables.length - 1];
    if (e.shiftKey && document.activeElement === primero) {
      e.preventDefault();
      ultimo.focus();
    } else if (!e.shiftKey && document.activeElement === ultimo) {
      e.preventDefault();
      primero.focus();
    }
  }

  function abrirPanel() {
    disparadorApertura = document.activeElement;
    const panel = document.getElementById('carritoPanel');
    document.getElementById('carritoOverlay').classList.remove('hidden');
    panel.classList.remove('translate-x-full');
    panel.removeAttribute('inert');
    document.body.classList.add('overflow-hidden');
    const foco = elementosFocuseables(panel)[0];
    if (foco) foco.focus();
  }

  function cerrarPanel() {
    const panel = document.getElementById('carritoPanel');
    if (panel.classList.contains('translate-x-full')) return; // ya estaba cerrado
    document.getElementById('carritoOverlay').classList.add('hidden');
    panel.classList.add('translate-x-full');
    panel.setAttribute('inert', ''); // saca todo el contenido del orden de tabulacion mientras esta oculto
    document.body.classList.remove('overflow-hidden');
    if (disparadorApertura && document.contains(disparadorApertura)) disparadorApertura.focus();
    disparadorApertura = null;
  }

  async function renderPanel() {
    const cont = document.getElementById('carritoItems');
    const subtotalEl = document.getElementById('carritoSubtotal');
    if (!cont) return;
    const items = leerCarrito();

    if (items.length === 0) {
      cont.innerHTML = '<p class="text-sec text-sm">Tu carrito está vacío.</p>';
      subtotalEl.textContent = fmt(0);
      return;
    }

    const productos = await cargarProductos();
    let subtotal = 0;
    cont.innerHTML = `<ul class="space-y-4">` + items.map(item => {
      const p = productos.find(x => x.sku === item.sku);
      if (!p) return '';
      subtotal += p.precio * item.qty;
      return `
        <li class="flex gap-3 items-center">
          <img src="${p.imagen}" alt="" class="w-16 h-16 rounded-xl object-contain bg-white/[.03] border border-hairline" />
          <div class="flex-1 min-w-0">
            <p class="text-sm font-semibold truncate">${p.nombre}</p>
            <p class="text-xs text-ter">${fmt(p.precio)}</p>
            <div class="mt-1 flex items-center gap-2">
              <button data-qty-menos="${item.sku}" aria-label="Quitar uno de ${p.nombre}" class="w-7 h-7 rounded-lg border border-hairline text-sec hover:text-ink">−</button>
              <span class="text-sm w-6 text-center" aria-hidden="true">${item.qty}</span>
              <span class="sr-only">Cantidad: ${item.qty}</span>
              <button data-qty-mas="${item.sku}" aria-label="Agregar uno de ${p.nombre}" class="w-7 h-7 rounded-lg border border-hairline text-sec hover:text-ink">+</button>
              <button data-quitar="${item.sku}" aria-label="Quitar ${p.nombre} del carrito" class="ml-auto px-2 py-1.5 -mr-2 text-xs text-ter hover:text-ink">Quitar</button>
            </div>
          </div>
        </li>`;
    }).join('') + `</ul>`;
    subtotalEl.textContent = fmt(subtotal);

    cont.querySelectorAll('[data-qty-menos]').forEach(b => b.addEventListener('click', () => {
      const it = leerCarrito().find(i => i.sku === b.dataset.qtyMenos);
      if (it) setQty(it.sku, it.qty - 1);
    }));
    cont.querySelectorAll('[data-qty-mas]').forEach(b => b.addEventListener('click', () => {
      const it = leerCarrito().find(i => i.sku === b.dataset.qtyMas);
      if (it) setQty(it.sku, it.qty + 1);
    }));
    cont.querySelectorAll('[data-quitar]').forEach(b => b.addEventListener('click', () => quitar(b.dataset.quitar)));
  }

  function marcarAgotados() {
    fetch('api/stock')
      .then(r => r.json())
      .then(data => {
        if (!data || !data.stock) return;
        document.querySelectorAll('[data-add-to-cart]').forEach(btn => {
          const disponible = data.stock[btn.dataset.sku];
          if (disponible === 0) {
            btn.disabled = true;
            btn.textContent = 'Agotado';
            btn.classList.add('opacity-50', 'cursor-not-allowed');
          }
        });
      })
      .catch(() => { /* si el backend de pagos aun no esta configurado, no bloqueamos la venta por WhatsApp */ });
  }

  // Activa un swatch de color: swap de imagen, aria-checked del grupo, y
  // actualiza el SKU del boton "Agregar al carrito" asociado (data-sku-group).
  function activarSwatch(thumb) {
    const grupo = thumb.dataset.group;
    const mainImg = document.getElementById(thumb.dataset.target);
    if (mainImg) mainImg.src = thumb.dataset.colorImg;

    document.querySelectorAll(`[data-color-img][data-group="${grupo}"]`).forEach(t => {
      t.setAttribute('aria-checked', 'false');
      t.classList.remove('border-2', 'border-accent');
      t.classList.add('border', 'border-hairline');
    });
    thumb.setAttribute('aria-checked', 'true');
    thumb.classList.remove('border', 'border-hairline');
    thumb.classList.add('border-2', 'border-accent');

    if (thumb.dataset.sku) {
      const addBtn = document.querySelector(`[data-add-to-cart][data-sku-group="${grupo}"]`);
      if (addBtn) addBtn.dataset.sku = thumb.dataset.sku;
    }
  }

  function wire() {
    crearPanel();
    actualizarBadge();
    renderPanel();
    marcarAgotados();

    const carritoBtn = document.getElementById('carritoBtn');
    if (carritoBtn) carritoBtn.addEventListener('click', () => { renderPanel(); abrirPanel(); });

    document.addEventListener('click', e => {
      const addBtn = e.target.closest('[data-add-to-cart]');
      if (addBtn && !addBtn.disabled) {
        e.preventDefault();
        agregar(addBtn.dataset.sku, 1);
      }
    });

    // Selectores de color: botones reales (role="radio"), operables por teclado
    // (Enter/Espacio nativos de <button>) y con estado expuesto vía aria-checked,
    // no solo por color de borde.
    document.querySelectorAll('[data-color-img]').forEach(thumb => {
      thumb.addEventListener('click', () => activarSwatch(thumb));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }

  window.MPXCarrito = { agregar, quitar, setQty, leer: leerCarrito, cargarProductos };
})();
