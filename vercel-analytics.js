// Vercel Web Analytics para las páginas HTML estáticas de Marketplusx.
// El paquete vive en package.json para que Vercel lo reconozca; este pequeño
// bootstrap usa el patrón oficial de sitios sin framework.
(() => {
  if (window.__MPX_ANALYTICS__ || /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
  window.__MPX_ANALYTICS__ = true;
  window.va = window.va || function (...args) {
    (window.vaq = window.vaq || []).push(args);
  };
  const script = document.createElement('script');
  script.defer = true;
  script.src = '/_vercel/insights/script.js';
  script.dataset.sdkn = '@vercel/analytics';
  script.dataset.sdkv = '2.0.1';
  document.head.appendChild(script);
})();
