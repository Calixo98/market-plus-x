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
    const pageType = document.documentElement?.dataset.gama || 'unknown';
    const eventPayload = {
      ...ecommerce,
      currency: ecommerce.currency || 'COP',
      page_type: pageType,
      page_path: location.pathname,
      ...(pageType === 'racing' ? { linea: 'racing' } : {}),
    };
    window.dataLayer = window.dataLayer || [];
    // GTM escucha estos nombres estables: mpx_chat_open, mpx_add_to_cart,
    // mpx_buy_now, mpx_begin_checkout, mpx_cod_order_submitted, etc.
    window.dataLayer.push({ event: `mpx_${event}`, mpx_event: event, ...eventPayload });

    const gaNames = { product_view:'view_item', add_to_cart:'add_to_cart', buy_now:'begin_checkout', begin_checkout:'begin_checkout', chat_open:'chat_open', chat_message_sent:'contact_webchat', whatsapp_click:'contact_whatsapp', cod_order_submitted:'generate_lead', payment_method_selected:'payment_method_selected' };
    if (window.gtag && gaNames[event]) window.gtag('event', gaNames[event], eventPayload);

    const metaNames = { product_view:'ViewContent', add_to_cart:'AddToCart', buy_now:'InitiateCheckout', begin_checkout:'InitiateCheckout', chat_open:'Contact', chat_message_sent:'Contact', whatsapp_click:'Contact', cod_order_submitted:'Lead' };
    if (window.fbq && metaNames[event]) {
      const meta = { value:Number(eventPayload.value || 0), currency:eventPayload.currency, content_ids:(eventPayload.items || []).map(item => item.item_id || item.sku), content_type:'product' };
      if (options.eventId) window.fbq('track', metaNames[event], meta, { eventID: options.eventId });
      else window.fbq('track', metaNames[event], meta);
    }

    const tiktokNames = { product_view:'ViewContent', add_to_cart:'AddToCart', buy_now:'InitiateCheckout', begin_checkout:'InitiateCheckout', chat_open:'Contact', chat_message_sent:'Contact', whatsapp_click:'Contact', cod_order_submitted:'SubmitForm' };
    if (window.ttq && tiktokNames[event]) window.ttq.track(tiktokNames[event], { value:Number(eventPayload.value || 0), currency:eventPayload.currency });
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
