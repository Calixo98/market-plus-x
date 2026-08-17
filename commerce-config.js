/*
 * Configuracion comercial compartida por el navegador y las funciones de
 * Vercel. El descuento esta apagado por defecto. Cuando se active, la API de
 * checkout tambien lo validara antes de crear el enlace de pago.
 */
(function (root) {
  const config = Object.freeze({
    upfrontDiscount: Object.freeze({
      enabled: false,
      percentage: 10,
      paymentMethod: 'bold',
      label: 'Descuento por pago anticipado',
    }),
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = config;
  if (root) root.MPX_COMMERCE_CONFIG = config;
}(typeof window !== 'undefined' ? window : globalThis));
