(() => {
  if (window.__MPX_CHAT__) return;
  window.__MPX_CHAT__ = true;

  const state = { started: false, cursor: null, busy: false, poll: null, rendered: new Set(), siteKey: null };
  const displayText = value => {
    if (typeof value === 'string') return value;
    if (value == null || typeof value === 'object') return '';
    return String(value);
  };
  const esc = s => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const unavailableMessage = () => location.protocol === 'file:'
    ? 'El chat funciona desde la tienda publicada. Abre marketplusx.com para hablar con María Paula.'
    : 'El chat no está disponible temporalmente. Intenta de nuevo en un momento.';

  document.body.insertAdjacentHTML('beforeend', `<button id="mpx-chat-launcher" type="button" aria-controls="mpx-chat-panel" aria-expanded="false">Consultar asesor</button><section id="mpx-chat-panel" role="dialog" aria-label="Chat de Market Plus X" data-open="false"><header class="mpx-chat-head"><div><div class="mpx-chat-title">María Paula · Asesora</div><div class="mpx-chat-sub">ASESORÍA MARKET PLUS X</div></div><button class="mpx-chat-close" aria-label="Cerrar chat">×</button></header><div class="mpx-chat-messages" aria-live="polite"></div><div><div class="mpx-chat-status"></div><form class="mpx-chat-form"><input class="mpx-chat-input" maxlength="1200" autocomplete="off" placeholder="Escribe tu pregunta" aria-label="Mensaje"><button class="mpx-chat-send" type="submit">Enviar</button></form></div></section>`);

  const panel = document.getElementById('mpx-chat-panel');
  const launcher = document.getElementById('mpx-chat-launcher');
  const list = panel.querySelector('.mpx-chat-messages');
  const status = panel.querySelector('.mpx-chat-status');
  const input = panel.querySelector('.mpx-chat-input');

  function render(m) {
    if (state.rendered.has(m.id)) return;
    state.rendered.add(m.id);
    const el = document.createElement('div');
    const isPhoto = m.kind === 'product_photo' || Boolean(m.image_url);
    el.className = `mpx-chat-bubble ${m.direction === 'in' ? 'mpx-chat-in' : 'mpx-chat-out'}${isPhoto ? ' mpx-chat-photo-only' : ''}`;
    el.dataset.operator = String(Boolean(m.operator));
    const image = m.image_url ? `<img class="mpx-chat-photo" src="${esc(m.image_url)}" alt="Foto del producto">` : '';
    el.innerHTML = image + (isPhoto ? '' : esc(displayText(m.body)));
    list.appendChild(el);
    list.scrollTop = list.scrollHeight;
    state.cursor = m.created_at;
  }

  async function load() {
    if (!state.started) return;
    try {
      const r = await fetch(`/api/chat/messages${state.cursor ? `?after=${encodeURIComponent(state.cursor)}` : ''}`);
      if (!r.ok) return;
      const d = await r.json();
      (d.messages || []).forEach(render);
      status.textContent = d.status === 'handoff' ? 'Un asesor humano está atendiendo esta conversación.' : '';
    } catch {}
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

  async function open(prompt) {
    panel.dataset.open = 'true';
    launcher.setAttribute('aria-expanded', 'true');
    window.MPXAnalytics?.track('chat_open', { placement: prompt ? 'contextual' : 'launcher' });
    await start();
    if (prompt && !input.value) input.value = prompt;
    input.focus();
  }

  launcher.addEventListener('click', open);
  panel.querySelector('.mpx-chat-close').addEventListener('click', () => {
    panel.dataset.open = 'false';
    launcher.setAttribute('aria-expanded', 'false');
  });
  document.addEventListener('click', e => {
    const a = e.target.closest('[data-open-chat]');
    if (!a) return;
    e.preventDefault();
    open(a.dataset.chatPrompt || '');
  });
  panel.querySelector('form').addEventListener('submit', async e => {
    e.preventDefault();
    const body = input.value.trim();
    if (!body || state.busy || !(await start())) return;
    state.busy = true;
    input.value = '';
    status.textContent = 'María Paula está respondiendo…';
    const temp = { id: crypto.randomUUID(), direction: 'in', body, created_at: new Date().toISOString() };
    render(temp);
    try {
      const r = await fetch('/api/chat/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_message_id: temp.id, body, page: location.pathname })
      });
      if (!r.ok) throw new Error((await r.json()).error);
      window.MPXAnalytics?.once('first_chat_message', 'chat_message_sent', { channel: 'webchat' });
      await load();
    } catch (err) {
      status.textContent = err.message || 'No se pudo enviar. Intenta otra vez.';
    } finally {
      state.busy = false;
      setTimeout(load, 1200);
    }
  });
})();
