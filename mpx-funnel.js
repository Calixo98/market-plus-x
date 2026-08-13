// Embudo comercial compartido. No contiene PII y mantiene una semantica
// consistente en GA4, Meta, TikTok y GTM.
(() => {
  if (window.MPXAnalytics) return;

  const cleanItems = items => (items || []).map(item => ({
    item_id: item.sku, item_name: item.nombre,
    price: Number(item.precio || 0), quantity: Number(item.qty || 1),
  }));

  function track(event, payload = {}, options = {}) {
    const ecommerce = payload.items ? { ...payload, items: cleanItems(payload.items) } : payload;
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({ event: `mpx_${event}`, ...ecommerce });

    const gaNames = { product_view:'view_item', add_to_cart:'add_to_cart', begin_checkout:'begin_checkout', chat_open:'chat_open', chat_message_sent:'contact_webchat', whatsapp_click:'contact_whatsapp', cod_order_submitted:'generate_lead', payment_method_selected:'payment_method_selected' };
    if (window.gtag && gaNames[event]) window.gtag('event', gaNames[event], ecommerce);

    const metaNames = { product_view:'ViewContent', add_to_cart:'AddToCart', begin_checkout:'InitiateCheckout', chat_message_sent:'Contact', whatsapp_click:'Contact', cod_order_submitted:'Lead' };
    if (window.fbq && metaNames[event]) {
      const meta = { value:Number(payload.value || 0), currency:payload.currency || 'COP', content_ids:(payload.items || []).map(item => item.sku), content_type:'product' };
      if (options.eventId) window.fbq('track', metaNames[event], meta, { eventID: options.eventId });
      else window.fbq('track', metaNames[event], meta);
    }

    const tiktokNames = { product_view:'ViewContent', add_to_cart:'AddToCart', begin_checkout:'InitiateCheckout', chat_message_sent:'Contact', whatsapp_click:'Contact', cod_order_submitted:'SubmitForm' };
    if (window.ttq && tiktokNames[event]) window.ttq.track(tiktokNames[event], { value:Number(payload.value || 0), currency:payload.currency || 'COP' });
  }

  function once(key, event, payload = {}, options = {}) {
    try { if (sessionStorage.getItem(`mpx_event_${key}`)) return; sessionStorage.setItem(`mpx_event_${key}`, '1'); } catch {}
    track(event, payload, options);
  }

  document.addEventListener('click', event => {
    const whatsapp = event.target.closest('a[href*="wa.me"]');
    if (whatsapp) track('whatsapp_click', { placement:whatsapp.dataset.placement || 'fallback' });
  });

  window.MPXAnalytics = { track, once };
})();
