# DESIGN V3 — Market Plus X (Lima Ácido)

> Fuente de verdad del sistema de diseño. Todos los valores aquí documentados
> están verificados contra WCAG AA con la fórmula de luminancia relativa
> (https://www.w3.org/WAI/GL/wiki/Relative_luminance). Cualquier cambio en
> estos tokens debe recalcular su contraste antes de desplegar.

---

## Paleta

```js
colors: {
  night:   '#07080A',            // fondo base
  raised:  '#111318',            // bento cards, secciones alternas
  card:    '#16181D',            // tablas, inputs, selects
  ink:     '#F2F1EC',            // texto principal (crema, no blanco puro)
  sec:     'rgba(242,241,236,.66)', // texto secundario — 7.8:1 sobre night ✓
  ter:     'rgba(242,241,236,.50)', // texto terciario/labels — 4.8:1 sobre night ✓
  accent:  { DEFAULT:'#C8F02A', hover:'#E4FF6B', soft:'rgba(200,240,42,.14)' },
  wa:      { DEFAULT:'#25D366', dark:'#1DA851' },   // verde WhatsApp
  hairline:'rgba(242,241,236,.14)',
}
```

### Contraste validado

| Combinación | Ratio | Verdict |
|---|---|---|
| `ink` sobre `night` | 17.7:1 | AAA |
| `ink` sobre `raised` | 16.4:1 | AAA |
| `ink` sobre `card` | 15.7:1 | AAA |
| `sec` sobre `night` | 7.8:1 | AAA |
| `ter` sobre `night` | 4.8:1 | AA |
| `accent` sobre `night` | 15.2:1 | AAA |
| `night` sobre `accent` | 15.2:1 | AAA |
| `night` sobre `wa` | 10.1:1 | AAA |
| `ink` sobre `wa` | 1.7:1 | **FAIL** → usar `night` para texto sobre wa |

### Regla: `ink` NUNCA sobre `accent` o `wa`
El blanco crema (`ink`) no contrasta sobre el lima ni sobre el verde WhatsApp.
Siempre usar `night` para texto sobre fondos `accent` o `wa`.

---

## Tipografía

Tres familias, cada una con un rol específico:

| Familia | Rol | Google Fonts URL |
|---|---|---|
| **Archivo** (variable) | Display, titulares, hero — `wdth,wght` | `Archivo:wdth,wght@80,200..900` |
| **Geist Mono** (variable) | Nav, botones, precios, labels, microcopy | `Geist+Mono:wght@400..700` |
| **Inter** (variable) | Párrafos largos (FAQ, testimonios, políticas, texto legal) | `Inter:wght@400..900` |

### Aplicación

```css
font-family: {
  display: ['Archivo', 'sans-serif'],       // H1, H2 grandes, hero
  mono:    ['Geist Mono', 'monospace'],      // nav, labels, buttons, prices
  sans:    ['Inter', '-apple-system', 'sans-serif'], // body, párrafos
}
```

### Tamaños display

```css
.display { font-size: clamp(2.1rem, 8vw, 5.5rem); letter-spacing: -0.04em; line-height: 1.02; }
.h2v3    { font-size: clamp(1.9rem, 4vw, 3rem); letter-spacing: -0.02em; }
```

---

## Botones

| Tipo | Radio | Uso |
|---|---|---|
| CTA primario | `border-radius: 2px` (recto) | Botones "Agregar al carrito", "Pagar", "Ver modelos" |
| WhatsApp | `border-radius: 2px` (recto) | Botones de WhatsApp |
| Nav pills | `rounded-full` | Tags de sección, badges, navegación |
| Botón secundario | `border-radius: 2px` | Links outline / btn-outline |

Regla: los CTAs principales pasan de píldora (`rounded-full`) a esquina recta
(`2px`). Los nav pills, badges y tags de sección conservan forma de píldora.

---

## Hero — Variante A "Muro Ácido" (index.html)

- Fondo: `bg-accent` (lima `#C8F02A`)
- Titular: `text-night` (negro `#07080A`), tipografía Archivo display
- Tarjeta de propuesta de valor: `bg-night` con `text-ink`, flotando sobre el
  fondo lima — contiene spec bullets y CTA
- Franja de confianza/trust strip: misma, sobre fondo lima
- Producto: `photo-vignette` con glow, saturación ajustada para fondo lima

---

## Sistema de "gama" (assets/gama.css)

Capa compartida por las 8 páginas que agrega atmósfera de fondo, insignia de
sección y barrido de transición entre páginas. Vive en un solo archivo para no
repetir la misma deriva que ya tenía el sitio.

**Regla de oro: el CTA (`accent`, lima `#C8F02A`) nunca cambia entre gamas.**
Solo cambia el color de *ambiente* — fondo, mancha, insignia, hover de borde.
Por eso `assets/gama.css` no toca ningún `tailwind.config`.

| Página | `data-gama` | Paleta de ambiente |
|---|---|---|
| `index.html` (hero) | `home` | Lima Ácido `#C8F02A` |
| `index.html` (`#modelos`, vía scroll) | `catalogo` | Violeta Grafito `#B8AEC9` |
| `deportiva.html` | `pdp` | Naranja Incandescente `#FF7A2A` |
| `checkout.html` / `pago-respuesta.html` | `carrito` | Verde Neón `#2BE332` |
| `politicas.html` | `marca` | Hueso `#F2F1EC` (solo el brillo del encabezado — ver nota abajo) |
| `admin-pedidos.html` | `home` | Lima Ácido |
| `racing.html` / `racing-producto.html` | `racing` | Tierra Óxido `#C9793C` (línea MK Racing — ver nota abajo) |

El cambio de gama dentro de `index.html` lo hace un `IntersectionObserver` (no
GSAP, no `prefers-reduced-motion` — es un cambio de atributo, no una
animación) que alterna `data-gama` entre `home` y `catalogo` cuando `#modelos`
cruza el centro de la pantalla. La transición de color la hace CSS puro vía
`@property` sobre las variables `--g1/--g2/--g3/--g-base`.

**Nota sobre `politicas.html`:** el mockup original invierte toda la página a
un tema claro para la gama Hueso. Se comprobó que el acento lima sobre un
fondo claro da **1.16:1 de contraste** (falla catastrófica, WCAG exige 4.5:1),
y que la mayoría del contenido legal no tiene cajas opacas propias — se apoya
directamente en el fondo del `<body>`. Invertir el tema completo habría
significado reclasificar decenas de usos de `text-accent`/`bg-accent-soft` en
la página de mayor riesgo de cumplimiento del sitio (Habeas Data). Se optó por
una versión más conservadora: el contenido se queda en el tema oscuro ya
auditado, y la gama Hueso solo se expresa en el brillo superior del
encabezado (`color-mix(in srgb, var(--g2) 20%, transparent)`) y en la
insignia del header.

**Nota sobre `racing.html`/`racing-producto.html` (Gama 06 — Tierra Óxido):**
paleta terrosa/óxido a propósito, para no confundirse con `pdp` (Naranja
Incandescente). `.mpx-ticker` pinta `background: var(--g2)` con `color:
var(--g-base)`, así que la cinta invierte con la gama — se calculó el ratio
con la fórmula WCAG (no se estimó a ojo): `--g2 #C9793C` sobre `--g-base
#1A0E06` da **5.66:1**, por encima del mínimo de 4.5:1. El CTA principal
sigue siendo lima `#C8F02A`, como en el resto del sitio.

**Barrido entre páginas:** `@view-transition { navigation: auto; }` +
`::view-transition-old/new(root)`, puro CSS. Sin soporte (Firefox hoy) la
navegación es la normal, sin animación — nunca bloquea nada.

**Cinta de specs (`index.html`, bajo el hero):** reemplaza la franja estática
de stats que existía ahí — mismos datos, ahora en movimiento. Reutiliza el
patrón de `@keyframes marquee` que ya usaba el carrusel de fotos (duplicar el
contenido, correr `-50%`). Se pausa con mouse y con foco de teclado (WCAG
2.2.2), se detiene con `prefers-reduced-motion`, y lleva una lista `.sr-only`
paralela para lectores de pantalla.

---

## Estructura de página (sin cambios)

Los IDs de ancla se mantienen: `#inicio #experiencia #anatomia #modelos
#comparativa #prueba #confianza #faq #galeria`.

Los 4 bloques de medición en `<head>` (GTM, GA4, Meta Pixel, TikTok Pixel)
NO se tocan — están en la misma posición y con el mismo código.

Todo `api/*` y `lib/*` queda intacto — esto es un rediseño visual únicamente.

Los atributos `data-add-to-cart`, `data-sku`, `data-color-img`, `data-group`,
`role="dialog"`, `aria-*` y demás enlaces entre HTML y `carrito.js`/`checkout.html`
NO se modifican — solo cambian clases y colores alrededor.

---

## Fecha

Última actualización: agosto 2026