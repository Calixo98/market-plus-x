// Carrito de compras Market Plus X — estado en localStorage, un solo script
// compartido por index.html, deportiva.html y checkout.html.
//
// Contrato con el HTML de cada pagina:
//   - Un boton con id="carritoBtn" y un <span id="carritoBadge"> dentro, para el contador.
//   - Botones "Agregar al carrito": <button data-add-to-cart data-sku="...">
//     Si el producto tiene variantes de color, el swatch debe traer data-sku y
//     data-group; al hacer clic se actualiza data-sku del boton con ese mismo data-group.
//   - Este script inyecta el panel lateral del carrito (overlay) el solo.
(function () {
  const STORAGE_KEY = 'mpx_carrito';
  let productosCache = null;

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
    if (!badge) return;
    const n = totalItems();
    badge.textContent = n;
    badge.classList.toggle('hidden', n === 0);
  }

  function fmt(n) {
    return '$' + n.toLocaleString('es-CO');
  }

  function crearPanel() {
    if (document.getElementById('carritoPanel')) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div id="carritoOverlay" class="fixed inset-0 z-[70] hidden bg-black/60"></div>
      <aside id="carritoPanel" class="fixed top-0 right-0 z-[71] h-full w-full max-w-md translate-x-full transition-transform duration-300 bg-raised border-l border-hairline flex flex-col">
        <div class="flex items-center justify-between p-5 border-b border-hairline">
          <h2 class="text-lg font-bold">Tu carrito</h2>
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
  }

  function abrirPanel() {
    document.getElementById('carritoOverlay').classList.remove('hidden');
    document.getElementById('carritoPanel').classList.remove('translate-x-full');
    document.body.classList.add('overflow-hidden');
  }

  function cerrarPanel() {
    document.getElementById('carritoOverlay').classList.add('hidden');
    document.getElementById('carritoPanel').classList.add('translate-x-full');
    document.body.classList.remove('overflow-hidden');
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
    cont.innerHTML = items.map(item => {
      const p = productos.find(x => x.sku === item.sku);
      if (!p) return '';
      subtotal += p.precio * item.qty;
      return `
        <div class="flex gap-3 items-center">
          <img src="${p.imagen}" alt="${p.nombre}" class="w-16 h-16 rounded-xl object-contain bg-white/[.03] border border-hairline" />
          <div class="flex-1 min-w-0">
            <p class="text-sm font-semibold truncate">${p.nombre}</p>
            <p class="text-xs text-ter">${fmt(p.precio)}</p>
            <div class="mt-1 flex items-center gap-2">
              <button data-qty-menos="${item.sku}" class="w-7 h-7 rounded-lg border border-hairline text-sec hover:text-ink">−</button>
              <span class="text-sm w-6 text-center">${item.qty}</span>
              <button data-qty-mas="${item.sku}" class="w-7 h-7 rounded-lg border border-hairline text-sec hover:text-ink">+</button>
              <button data-quitar="${item.sku}" class="ml-auto text-xs text-ter hover:text-ink">Quitar</button>
            </div>
          </div>
        </div>`;
    }).join('');
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

    // Selector de color generico: cambia la imagen principal, resalta el swatch
    // activo, y si hay un boton "Agregar al carrito" del mismo grupo (data-sku-group),
    // lo apunta al SKU de la variante seleccionada.
    document.querySelectorAll('[data-color-img]').forEach(thumb => {
      thumb.addEventListener('click', () => {
        const grupo = thumb.dataset.group;
        const mainImg = document.getElementById(thumb.dataset.target);
        if (mainImg) mainImg.src = thumb.dataset.colorImg;

        document.querySelectorAll(`[data-color-img][data-group="${grupo}"]`).forEach(t => {
          t.classList.remove('border-2', 'border-accent');
          t.classList.add('border', 'border-hairline');
        });
        thumb.classList.remove('border', 'border-hairline');
        thumb.classList.add('border-2', 'border-accent');

        if (thumb.dataset.sku) {
          const addBtn = document.querySelector(`[data-add-to-cart][data-sku-group="${grupo}"]`);
          if (addBtn) addBtn.dataset.sku = thumb.dataset.sku;
        }
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }

  window.MPXCarrito = { agregar, quitar, setQty, leer: leerCarrito, cargarProductos };
})();
