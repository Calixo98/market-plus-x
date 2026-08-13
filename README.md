# Market Plus X — Landing Page

Landing page de conversión para **Market Plus X**, tienda de Gafas Inteligentes con Cámara e IA en Colombia.

## 🚀 Stack

- **HTML5** semántico
- **Tailwind CSS** (vía CDN — sin build)
- **Vanilla JavaScript** (tabs, acordeón FAQ, navbar dinámica)
- **FontAwesome** + **Inter** (Google Fonts)

Es un sitio 100% estático de un solo archivo (`index.html`). No requiere instalación ni dependencias.

## 🖥️ Probar localmente

Simplemente abre `index.html` en tu navegador. O sirve la carpeta:

```bash
npx serve .
```

## ☁️ Desplegar en Vercel

### Opción A — Desde el dashboard (recomendada)
1. Sube este repo a GitHub.
2. Entra a [vercel.com/new](https://vercel.com/new) e importa el repositorio.
3. Framework Preset: **Other** (no requiere build). Deja todo por defecto.
4. Click en **Deploy**. ✅

### Opción B — Desde la terminal
```bash
npm i -g vercel
vercel        # despliegue de preview
vercel --prod # despliegue a producción
```

## 📞 Configuración

Todos los botones de compra apuntan a WhatsApp:
`https://wa.me/573229320982`

Para cambiar el número, busca y reemplaza `573229320982` en `index.html`.

## 📦 Secciones

Navbar · Hero · Características · Casos de uso (tabs) · Precios (4 modelos) · FAQ · Footer · Botón flotante WhatsApp.

## Chat web y contraentrega

Las funciones Vercel actúan como proxy seguro de Agente X, protegen sesiones
con Turnstile y reservan inventario contraentrega en Upstash. Configurar
`AGENT_X_URL`, `MARKETPLUS_INTERNAL_SECRET`, `CHAT_SESSION_SECRET`,
`TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, `WEBCHAT_ENABLED`, `COD_ENABLED`,
`RESEND_API_KEY`, `EMAIL_FROM` y `NOTIFY_EMAIL`. Activar las banderas después
de aplicar `supabase/migracion-webchat.sql` y desplegar Agente X.

---

Hecho en Colombia 🇨🇴
