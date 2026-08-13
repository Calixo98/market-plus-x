// Vercel Speed Insights para las páginas HTML estáticas de Marketplusx.
// El paquete vive en package.json para que Vercel lo reconozca; este pequeño
// bootstrap usa el patrón oficial de sitios sin framework.
(() => {
  if (window.__MPX_SPEED_INSIGHTS__ || /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
  window.__MPX_SPEED_INSIGHTS__ = true;
  window.si = window.si || function (...args) {
    (window.siq = window.siq || []).push(args);
  };
  const script = document.createElement('script');
  script.defer = true;
  script.src = '/_vercel/speed-insights/script.js';
  script.dataset.sdkn = '@vercel/speed-insights';
  script.dataset.sdkv = '2.0.0';
  document.head.appendChild(script);
})();
