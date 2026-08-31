# Market Plus X — tienda web

Tienda web de **Market Plus X** para gafas inteligentes y vehículos RC en Colombia.
Incluye catálogo, carrito, checkout, pagos Bold, contraentrega con reserva de
inventario, cálculo de envíos, CRM de pedidos y chat conectado con Agente X.

## 🚀 Stack

- **Frontend:** HTML, Tailwind CSS vía CDN y JavaScript sin framework.
- **Backend:** funciones serverless en `api/` para pagos, pedidos, stock, envíos y chat.
- **Datos:** Upstash Redis/KV para inventario y pedidos.
- **Integraciones:** Bold, Resend, Meta CAPI, Turnstile y Agente X.

Las páginas públicas no requieren compilación. La dependencia de Speed Insights
y las pruebas sí se administran con npm.

## 🖥️ Probar localmente

Instala dependencias, ejecuta las pruebas y sirve la carpeta:

```bash
npm install
npm test
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

## 📦 Superficies principales

- `index.html`, `deportiva.html`, `racing.html` y `racing-producto.html`: catálogo.
- `carrito.js` y `checkout.html`: compra y contraentrega.
- `admin-pedidos.html`: operación y seguimiento de pedidos.
- `api/`: funciones privadas de comercio y chat.
- `tests/`: contratos del funnel, inventario y CRM.

## Chat web y contraentrega

Las funciones Vercel actúan como proxy seguro de Agente X, protegen sesiones
con Turnstile y reservan inventario contraentrega en Upstash. Configurar
`AGENT_X_URL`, `AGENT_X_CHAT_SECRET`, `AGENT_X_ORDERS_SECRET`,
`CHAT_SESSION_SECRET`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`,
`WEBCHAT_ENABLED`, `COD_ENABLED`, `RESEND_API_KEY`, `EMAIL_FROM`,
`NOTIFY_EMAIL`, `CRON_SECRET` y las credenciales de Bold/KV/Meta/Telegram.
En producción, `AGENT_X_CHAT_SECRET` y `AGENT_X_ORDERS_SECRET` son obligatorios
y deben ser distintos; `MARKETPLUS_INTERNAL_SECRET` solo queda como compatibilidad
temporal fuera de producción. Activar las banderas después de aplicar
`supabase/migracion-webchat.sql` y desplegar Agente X.

El endpoint `/api/cron-retry-notifications` debe invocarse con
`Authorization: Bearer <CRON_SECRET>` (Vercel Cron lo hace automáticamente al
configurarlo). Reintenta avisos pendientes y reconcilia reservas vencidas; no
expone datos personales en la URL.

---

Hecho en Colombia 🇨🇴
