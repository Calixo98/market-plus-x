# DESIGN V3 — Market Plus X · Dark Premium (Apple/Linear)

> Fuente de verdad del sistema visual v3. Cualquier página o componente nuevo debe usar estos tokens.

## Principios
1. **Legitimidad primero**: fotos y video reales como protagonistas. Nada de renders falsos, neón
   ni degradados multicolor (anti-patrón "estafa cripto" detectado en v1).
2. **Un solo acento**: el azul `#0066ff` se usa ÚNICAMENTE en CTAs, estados activos, líneas de
   callout y glow. Todo lo demás es escala de grises.
3. **Mobile-first real**: tráfico Android gama media en 4G. Imágenes lazy, un solo video
   click-to-play, sin Three.js, sin librerías extra (solo Tailwind CDN + GSAP 3 + ScrollTrigger).
4. **Conversión**: cada sección empuja a WhatsApp (+57 322 932 0982). La medición (GTM, GA4
   `contact_whatsapp`, Meta Pixel `Contact`) es intocable.

## Tokens

```json
{
  "color": {
    "bg":     { "base": "#0b0b0c", "pure": "#000000", "raised": "#131316", "card": "#17171b" },
    "text":   { "primary": "#ffffff", "secondary": "#a1a1aa", "tertiary": "#63636b" },
    "accent": { "DEFAULT": "#0066ff", "hover": "#2b7fff", "soft": "rgba(0,102,255,0.12)" },
    "border": { "hairline": "rgba(255,255,255,0.08)", "active": "rgba(0,102,255,0.45)" },
    "glass":  { "bg": "rgba(19,19,22,0.60)", "blur": "16px" }
  },
  "typography": {
    "family": "Inter, -apple-system, BlinkMacSystemFont, sans-serif",
    "display": { "size": "clamp(2.75rem, 8vw, 5.5rem)", "weight": 900, "tracking": "-0.03em", "leading": 1.02 },
    "h2":      { "size": "clamp(1.9rem, 4vw, 3rem)", "weight": 800, "tracking": "-0.02em" },
    "h3":      { "size": "1.125rem-1.5rem", "weight": 700 },
    "body":    { "size": "1rem-1.125rem", "weight": 400, "color": "#a1a1aa" },
    "label":   { "size": "0.75rem", "weight": 600, "tracking": "0.08em", "transform": "uppercase", "color": "#63636b" }
  },
  "radius": { "card": "24px", "pill": "9999px", "media": "16px" },
  "spacing": { "sectionY": "96-128px", "cardPad": "24-40px", "gridGap": "16-24px" },
  "effects": {
    "glassCard": "backdrop-filter: blur(16px); background: rgba(19,19,22,.6); border: 1px solid rgba(255,255,255,.08); border-radius: 24px",
    "glowAccent": "radial-gradient(closest-side, rgba(0,102,255,.14), transparent) detrás del producto",
    "shadowCard": "inset 0 1px 0 rgba(255,255,255,.04), 0 20px 60px rgba(0,0,0,.5)",
    "hairlineDivider": "border-color: rgba(255,255,255,.08)"
  },
  "motion": {
    "reveal":   { "from": { "y": 28, "opacity": 0 }, "to": { "y": 0, "opacity": 1 }, "duration": 0.7, "ease": "power2.out", "trigger": "top 88%" },
    "heroFloat":{ "y": "8px", "loop": "6s ease-in-out infinite alternate" },
    "heroParallax": { "y": "±6%", "scrub": true },
    "anatomy":  { "desktop": "sección pinned, 3 steps activan callouts", "mobile": "estático apilado" },
    "marquee":  { "keyframes": "translateX(0 → -50%)", "duration": "40s linear infinite", "hover": "paused" },
    "reducedMotion": "con prefers-reduced-motion: reduce → sin GSAP, todo visible y estático"
  }
}
```

## Componentes clave
- **Header**: fijo, `bg-transparent` → al scroll `glassCard` (blur 16px + hairline inferior).
  Altura 64px. Logo izquierda, nav centro (desktop), CTA pill azul derecha.
- **CTA primario**: pill azul `#0066ff`, texto blanco 600, hover `#2b7fff`, `px-7 py-4`.
  Los CTA que abren WhatsApp llevan `fa-whatsapp` y el mismo azul (decisión del dueño).
- **CTA secundario**: pill glass (hairline + blur), texto blanco.
- **Bento card**: `rounded-[24px]`, fondo `#131316`/foto con overlay `linear-gradient(rgba(0,0,0,.25), rgba(11,11,12,.9))`,
  hairline, `shadowCard`. Hover: hairline → `border.active` + translateY(-4px).
- **Callout de anatomía**: punto 8px azul + línea 1px `rgba(255,255,255,.25)` + etiqueta label.
  Estado activo: línea y punto en azul, texto `text.primary`.
- **Tabla comparativa**: fondo `card`, hairlines, columna destacada con `accent.soft`.
- **Marquee**: pista duplicada, `mask-image: linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent)`.

## Accesibilidad
- Texto secundario `#a1a1aa` sobre `#0b0b0c` = contraste ~8.7:1 (AA/AAA ok). No usar `#63636b`
  para texto de lectura, solo labels grandes.
- Focus visible en CTAs (`outline` azul). `prefers-reduced-motion` respetado en todo.

## Páginas
- `index.html`: header glass · hero display · bento dual (Sport / Casual Pro & Ultra + 3 tiles) ·
  anatomía · modelos (4 cards) · comparativa · marquee + video real + testimonios · confianza +
  privacidad · FAQ · CTA final masivo · footer.
- `deportiva.html` y `politicas.html`: mismos tokens, estructura propia intacta.

## Medición (NO tocar)
- GTM `GTM-WG74VTMW` (head + noscript) · GA4 `G-0QH4MFCW2X` (gtag/js + config) ·
  Meta Pixel `2724794924558492` (init + PageView + noscript).
- Listener global: clic en `a[href*="wa.me"]` → `fbq('track','Contact')` +
  `gtag('event','contact_whatsapp',{button_text,link_url})`. Presente en las 3 páginas.
