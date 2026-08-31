(() => {
  if (window.__MPX_CHAT__) return;
  window.__MPX_CHAT__ = true;

  const state = { started: false, cursor: null, busy: false, poll: null, rendered: new Set(), siteKey: null, pollFailures: 0, returnFocus: null };
  const displayText = value => {
    if (typeof value === 'string') return value;
    if (value == null || typeof value === 'object') return '';
    return String(value);
  };
  const esc = s => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const unavailableMessage = () => location.protocol === 'file:'
    ? 'El chat funciona desde la tienda publicada. Abre marketplusx.com para hablar con María Paula.'
    : 'El chat no está disponible temporalmente. Intenta de nuevo en un momento.';

  document.body.insertAdjacentHTML('beforeend', `<button id="mpx-chat-launcher" type="button" aria-controls="mpx-chat-panel" aria-expanded="false">Consultar asesor</button><section id="mpx-chat-panel" role="dialog" aria-modal="true" aria-label="Chat de Market Plus X" data-open="false"><header class="mpx-chat-head"><div><div class="mpx-chat-title">María Paula · Asesora</div><div class="mpx-chat-sub">ASESORÍA MARKET PLUS X</div></div><button class="mpx-chat-close" type="button" aria-label="Cerrar chat">×</button></header><div class="mpx-chat-messages" aria-live="polite"></div><div><div class="mpx-chat-status" role="status" aria-live="polite" aria-atomic="true"></div><form class="mpx-chat-form"><input class="mpx-chat-input" maxlength="1200" autocomplete="off" placeholder="Escribe tu pregunta" aria-label="Mensaje"><button class="mpx-chat-send" type="submit">Enviar</button></form></div></section>`);

  const panel = document.getElementById('mpx-chat-panel');
  const launcher = document.getElementById('mpx-chat-launcher');
  const list = panel.querySelector('.mpx-chat-messages');
  const status = panel.querySelector('.mpx-chat-status');
  const input = panel.querySelector('.mpx-chat-input');

  function render(m, advanceCursor = true) {
    if (state.rendered.has(m.id)) {
      if (advanceCursor && m.created_at) state.cursor = m.created_at;
      return;
    }
    state.rendered.add(m.id);
    const el = document.createElement('div');
    const isPhoto = m.kind === 'product_photo' || m.kind === 'racing_media' || Boolean(m.image_url);
    const isVideo = m.kind === 'product_video' || m.kind === 'racing_media' || Boolean(m.video_url);
    el.className = `mpx-chat-bubble ${m.direction === 'in' ? 'mpx-chat-in' : 'mpx-chat-out'}${isPhoto ? ' mpx-chat-photo-only' : ''}${isVideo ? ' mpx-chat-video-only' : ''}`;
    el.dataset.operator = String(Boolean(m.operator));
    const image = m.image_url ? `<img class="mpx-chat-photo" src="${esc(m.image_url)}" alt="Foto del producto">` : '';
    const video = m.video_url ? `<video class="mpx-chat-video" controls playsinline preload="metadata" src="${esc(m.video_url)}"></video>` : '';
    const actionUrl = typeof m.action_url === 'string' && /^https:\/\/wa\.me\/\d+/.test(m.action_url) ? m.action_url : '';
    const action = actionUrl ? `<a class="mpx-chat-action" href="${esc(actionUrl)}" target="_blank" rel="noopener noreferrer">${esc(displayText(m.action_label) || 'Escribir por WhatsApp')}</a>` : '';
    el.innerHTML = image + video + ((isPhoto || isVideo) ? '' : esc(displayText(m.body))) + action;
    list.appendChild(el);
    list.scrollTop = list.scrollHeight;
    if (advanceCursor && m.created_at) state.cursor = m.created_at;
    return el;
  }

  async function sendMessage(message, element) {
    if (state.busy) return;
    state.busy = true;
    element?.querySelector('.mpx-chat-retry')?.remove();
    element?.removeAttribute('data-failed');
    status.textContent = 'María Paula está respondiendo…';
    try {
      const response = await fetch('/api/chat/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_message_id: message.id, body: message.body, page: location.pathname })
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'No se pudo enviar.');
      window.MPXAnalytics?.once('first_chat_message', 'chat_message_sent', { channel: 'webchat' });
      await load();
    } catch (error) {
      status.textContent = error.message || 'No se pudo enviar. Intenta otra vez.';
      if (element) {
        element.dataset.failed = 'true';
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'mpx-chat-retry';
        retry.textContent = 'Reintentar';
        retry.addEventListener('click', () => { void sendMessage(message, element); });
        element.appendChild(retry);
      }
    } finally {
      state.busy = false;
      setTimeout(load, 1200);
    }
  }

  async function load() {
    if (!state.started) return;
    try {
      const r = await fetch(`/api/chat/messages${state.cursor ? `?after=${encodeURIComponent(state.cursor)}` : ''}`);
      if (!r.ok) throw new Error(`chat polling ${r.status}`);
      const d = await r.json();
      (d.messages || []).forEach(message => render(message));
      state.pollFailures = 0;
      status.textContent = d.status === 'handoff' ? 'Un asesor humano está atendiendo esta conversación.' : '';
    } catch {
      state.pollFailures += 1;
      if (state.pollFailures >= 2 && !state.busy) status.textContent = 'Reconectando el chat…';
    }
  }

  async function token() {
    if (!state.siteKey) return null;
    if (!window.turnstile) {
      await new Promise((ok, bad) => {
        const s = document.createElement('script');
        s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        s.onload = ok;
        s.onerror = bad;
        document.head.appendChild(s);
      });
    }
    return new Promise(resolve => {
      const host = document.createElement('div');
      host.style.display = 'none';
      document.body.appendChild(host);
      const widgetId = window.turnstile.render(host, {
        sitekey: state.siteKey,
        size: 'invisible',
        execution: 'execute',
        callback: t => { host.remove(); resolve(t); },
        'error-callback': () => { host.remove(); resolve(null); }
      });
      window.turnstile.execute(widgetId);
    });
  }

  async function start() {
    if (state.started) return true;
    status.textContent = 'Conectando…';
    try {
      const configResponse = await fetch('/api/chat/sessions');
      if (!configResponse.ok) throw new Error(unavailableMessage());
      const config = await configResponse.json();
      if (!config.enabled) {
        status.textContent = 'Chat no disponible temporalmente.';
        return false;
      }
      state.siteKey = config.turnstileSiteKey;
      const r = await fetch('/api/chat/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ turnstile_token: await token() })
      });
      if (!r.ok) {
        status.textContent = (await r.json().catch(() => ({}))).error || 'No pudimos iniciar el chat.';
        return false;
      }
      state.started = true;
      status.textContent = '';
      await load();
      state.poll = setInterval(load, 2500);
      return true;
    } catch (error) {
      status.textContent = location.protocol === 'file:' ? unavailableMessage() : (error.message || unavailableMessage());
      return false;
    }
  }

  async function open(prompt, invoker = null) {
    const contextualPrompt = typeof prompt === 'string' ? prompt : '';
    state.returnFocus = invoker instanceof HTMLElement ? invoker : document.activeElement;
    panel.dataset.open = 'true';
    launcher.setAttribute('aria-expanded', 'true');
    window.MPXAnalytics?.track('chat_open', { placement: contextualPrompt ? 'contextual' : 'launcher' });
    await start();
    if (contextualPrompt && !input.value) input.value = contextualPrompt;
    input.focus();
  }

  // No pasar directamente `open` como listener: el navegador le entrega el
  // PointerEvent como primer argumento y terminaba convertido en
  // "[object PointerEvent]" dentro del mensaje del cliente.
  function close() {
    panel.dataset.open = 'false';
    launcher.setAttribute('aria-expanded', 'false');
    const target = state.returnFocus instanceof HTMLElement ? state.returnFocus : launcher;
    target.focus();
  }

  launcher.addEventListener('click', () => { void open('', launcher); });
  panel.querySelector('.mpx-chat-close').addEventListener('click', close);
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'Tab') {
      const focusable = [...panel.querySelectorAll('button, input, a[href], [tabindex]:not([tabindex="-1"])')]
        .filter(element => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true');
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  document.addEventListener('click', e => {
    const target = e.target instanceof Element ? e.target : null;
    const a = target?.closest('[data-open-chat]');
    if (!a) return;
    e.preventDefault();
    void open(a.dataset.chatPrompt || '', a);
  });
  panel.querySelector('form').addEventListener('submit', async e => {
    e.preventDefault();
    const body = input.value.trim();
    if (!body || state.busy || !(await start())) return;
    input.value = '';
    const temp = { id: crypto.randomUUID(), direction: 'in', body, created_at: new Date().toISOString() };
    const element = render(temp, false);
    await sendMessage(temp, element);
  });
})();
