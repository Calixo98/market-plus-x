const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function browser({ hasSession = false, scriptLoaded = true, renderError = false, executeError = false, syncSuccess = false, failConfig = false,
  hostWidth = 360, stallConfigBody = false, stallSessionBody = false, rejectReady = false, turnstileRequired } = {}) {
  class Element {
    constructor() { this.dataset = {}; this.listeners = {}; this.children = []; this.value = ''; this.style = {}; this.clientWidth = hostWidth; }
    addEventListener(name, handler) { this.listeners[name] = handler; }
    setAttribute() {}
    removeAttribute() {}
    hasAttribute() { return false; }
    focus() {}
    appendChild(child) { child.parentNode = this; this.children.push(child); }
    insertBefore(child) { this.appendChild(child); }
    remove() { this.removed = true; }
    querySelector(selector) { return elements[selector] || null; }
    querySelectorAll() { return []; }
    insertAdjacentHTML() {}
  }
  const elements = Object.fromEntries(['#mpx-chat-panel', '#mpx-chat-launcher', '.mpx-chat-messages', '.mpx-chat-status', '.mpx-chat-input', '.mpx-chat-close', 'form'].map(key => [key, new Element()]));
  elements['.mpx-chat-status'].parentNode = new Element();
  const timers = new Map();
  let timerId = 0;
  const calls = [];
  const removed = [];
  const widgets = [];
  let sessionPosts = 0;
  const head = new Element();
  const document = { body: new Element(), head, activeElement: elements['#mpx-chat-launcher'], getElementById: id => elements[`#${id}`], createElement: () => new Element(), addEventListener() {} };
  const api = {
    ready: callback => {
      if (rejectReady) throw new Error('[Cloudflare Turnstile] Remove async/defer from the Turnstile api.js script tag before using turnstile.ready().');
      callback();
    },
    render(host, options) {
      if (renderError) throw new Error('render failure');
      widgets.push({ host, options });
      if (syncSuccess) options.callback('synchronous-token');
      return `widget-${widgets.length}`;
    },
    execute() { if (executeError) throw new Error('execute failure'); },
    remove: id => removed.push(id)
  };
  const window = scriptLoaded ? { turnstile: api } : {};
  const response = data => ({ ok: true, json: async () => data });
  const context = {
    window, document, Element, HTMLElement: Element, location: { protocol: 'https:', pathname: '/racing' },
    crypto: { randomUUID: () => 'client-test-id' }, AbortController,
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      if (failConfig && calls.length === 1) return { ok: false, json: async () => null };
      if (stallConfigBody && calls.length === 1) return { ok: true, json: () => new Promise(() => {}) };
      if (url === '/api/chat/sessions' && options.method === 'POST') {
        sessionPosts += 1;
        if (stallSessionBody && sessionPosts === 1) return { ok: false, json: () => new Promise(() => {}) };
      }
      return response(url === '/api/chat/sessions' && !options.method
        ? { enabled: true, turnstileSiteKey: turnstileRequired === false ? null : 'test-sitekey', hasSession, turnstileRequired }
        : { messages: [] });
    },
    setTimeout: (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => ++timerId,
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../chat-widget.js'), 'utf8'), context);
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  return {
    calls, widgets, removed, timers, head, api, window, elements, flush,
    open: () => elements['#mpx-chat-launcher'].listeners.click(),
    submit: () => elements.form.listeners.submit({ preventDefault() {} }),
    fire(ms) { const item = [...timers.values()].find(timer => timer.ms === ms); assert.ok(item, `timer ${ms} exists`); item.callback(); },
    posts: () => calls.filter(call => call.url === '/api/chat/sessions' && call.options.method === 'POST'),
  };
}

test('concurrent startup shares one visible supported challenge and session request', async () => {
  const b = browser();
  b.open(); b.open(); await b.flush();
  assert.equal(b.widgets.length, 1);
  const { host, options } = b.widgets[0];
  assert.equal(options.size, 'flexible');
  assert.equal(options.appearance, 'interaction-only');
  assert.equal(options.execution, 'execute');
  assert.equal(options.retry, 'never');
  assert.equal(host.parentNode, b.elements['.mpx-chat-status'].parentNode);
  assert.equal(host.style.cssText, undefined);
  options.callback('verified-token'); await b.flush();
  assert.equal(b.posts().length, 1);
  assert.equal(JSON.parse(b.posts()[0].options.body).turnstile_token, 'verified-token');
  assert.equal(host.removed, true);
  assert.deepEqual(b.removed, ['widget-1']);
  assert.equal(b.timers.size, 0);
  options['error-callback']('late-error');
  assert.equal(b.removed.length, 1);
});

test('existing signed session resumes without loading Turnstile', async () => {
  const b = browser({ hasSession: true, scriptLoaded: false });
  b.open(); await b.flush();
  assert.equal(b.head.children.length, 0);
  assert.equal(b.widgets.length, 0);
  assert.equal(b.posts().length, 1);
  assert.equal(JSON.parse(b.posts()[0].options.body).turnstile_token, null);
});

test('server-disabled verification creates a new session without SDK or token', async () => {
  const b = browser({ turnstileRequired: false, scriptLoaded: false }); b.open(); await b.flush();
  assert.equal(b.head.children.length, 0);
  assert.equal(b.widgets.length, 0);
  assert.equal(b.posts().length, 1);
  assert.equal(JSON.parse(b.posts()[0].options.body).turnstile_token, null);
});

test('legacy config lacking the disable flag still requires verification', async () => {
  const b = browser(); b.open(); await b.flush();
  assert.equal(b.widgets.length, 1);
  assert.equal(b.posts().length, 0);
  b.widgets[0].options['error-callback']('challenge-failed'); await b.flush();
  assert.equal(b.posts().length, 0);
});

for (const scriptLoaded of [true, false]) {
  test(`${scriptLoaded ? 'preloaded' : 'dynamically loaded'} async SDK renders without unsupported ready()`, async () => {
    const b = browser({ scriptLoaded, rejectReady: true });
    b.open(); await b.flush();
    if (!scriptLoaded) {
      assert.equal(b.widgets.length, 0);
      b.window.turnstile = b.api;
      b.head.children[0].onload(); await b.flush();
    }
    assert.equal(b.widgets.length, 1);
    b.widgets[0].options.callback('verified-token'); await b.flush();
    assert.equal(b.posts().length, 1);
    assert.equal(JSON.parse(b.posts()[0].options.body).turnstile_token, 'verified-token');
    assert.equal(b.timers.size, 0);
  });
}

test('narrow mobile and unmeasurable hosts choose compact instead of clipping flexible', async () => {
  for (const hostWidth of [302, 0]) {
    const b = browser({ hostWidth }); b.open(); await b.flush();
    assert.equal(b.widgets[0].options.size, 'compact');
    b.widgets[0].options.callback('mobile-token'); await b.flush();
    assert.equal(b.posts().length, 1);
  }
});

test('stalled config JSON expires, aborts the request and permits a fresh startup', async () => {
  const b = browser({ stallConfigBody: true }); b.open(); await b.flush();
  b.fire(15000); await b.flush();
  assert.equal(b.calls[0].options.signal.aborted, true);
  assert.match(b.elements['.mpx-chat-status'].textContent, /tardó demasiado/);
  assert.equal(b.widgets.length, 0);
  b.open(); await b.flush();
  assert.equal(b.widgets.length, 1);
  b.widgets[0].options.callback('fresh-token'); await b.flush();
  assert.equal(b.posts().length, 1);
});

test('stalled session error JSON expires and does not freeze retry', async () => {
  const b = browser({ hasSession: true, stallSessionBody: true }); b.open(); await b.flush();
  b.fire(15000); await b.flush();
  assert.equal(b.posts()[0].options.signal.aborted, true);
  assert.match(b.elements['.mpx-chat-status'].textContent, /tardó demasiado/);
  b.open(); await b.flush();
  assert.equal(b.posts().length, 2);
  assert.equal(b.calls.some(call => call.url.startsWith('/api/chat/messages')), true);
});

test('challenge errors preserve submitted input and allow manual retry', async () => {
  const b = browser();
  b.elements['.mpx-chat-input'].value = 'Product question';
  b.open(); const submitted = b.submit(); await b.flush();
  assert.equal(b.widgets.length, 1);
  b.widgets[0].options['error-callback']('300030');
  await submitted; await b.flush();
  assert.equal(b.posts().length, 0);
  assert.equal(b.elements['.mpx-chat-input'].value, 'Product question');
  assert.match(b.elements['.mpx-chat-status'].textContent, /Intenta de nuevo/);
  b.open(); await b.flush();
  b.widgets[1].options.callback('fresh-token'); await b.flush();
  assert.equal(b.posts().length, 1);
});

test('silent timeout cleans up and ignores late success', async () => {
  const b = browser(); b.open(); await b.flush();
  b.fire(60000); await b.flush();
  b.widgets[0].options.callback('late-token'); await b.flush();
  assert.equal(b.posts().length, 0);
  assert.equal(b.widgets[0].host.removed, true);
  assert.equal(b.timers.size, 0);
});

test('interaction receives one bounded extension instead of a late silent timeout', async () => {
  const b = browser(); b.open(); await b.flush();
  const options = b.widgets[0].options;
  options['before-interactive-callback']();
  assert.equal([...b.timers.values()].some(timer => timer.ms === 60000), false);
  const id = [...b.timers.keys()][0];
  options['before-interactive-callback']();
  assert.equal([...b.timers.keys()][0], id);
  b.fire(120000); await b.flush();
  assert.equal(b.posts().length, 0);
  assert.equal(b.widgets[0].host.removed, true);
});

test('script timeout removes failed loader and retry creates a fresh script', async () => {
  const b = browser({ scriptLoaded: false }); b.open(); await b.flush();
  const first = b.head.children[0];
  const staleOnload = first.onload;
  b.fire(10000); await b.flush();
  assert.equal(first.removed, true);
  assert.equal(first.onload, null);
  assert.equal(b.posts().length, 0);
  b.open(); await b.flush();
  b.window.turnstile = b.api;
  staleOnload(); assert.equal(b.widgets.length, 0);
  b.head.children[1].onload(); await b.flush();
  b.widgets[0].options.callback('retry-token'); await b.flush();
  assert.equal(b.posts().length, 1);
});

test('script load errors settle and can be retried', async () => {
  const b = browser({ scriptLoaded: false }); b.open(); await b.flush();
  b.head.children[0].onerror(); await b.flush();
  assert.equal(b.head.children[0].removed, true);
  assert.equal(b.posts().length, 0);
  assert.equal(b.timers.size, 0);
  b.open(); await b.flush();
  assert.equal(b.head.children.length, 2);
});

test('failed config clears shared startup and permits the next attempt', async () => {
  const b = browser({ failConfig: true }); b.open(); await b.flush();
  assert.equal(b.widgets.length, 0);
  b.open(); await b.flush();
  assert.equal(b.widgets.length, 1);
});

test('synchronous success removes the returned widget id without leaking timers', async () => {
  const b = browser({ syncSuccess: true }); b.open(); await b.flush();
  assert.equal(b.posts().length, 1);
  assert.deepEqual(b.removed, ['widget-1']);
  assert.equal(b.timers.size, 0);
});

for (const callback of ['expired-callback', 'timeout-callback']) {
  test(`${callback} does not post an expired challenge`, async () => {
    const b = browser(); b.open(); await b.flush();
    b.widgets[0].options[callback](); await b.flush();
    assert.equal(b.posts().length, 0);
    assert.equal(b.timers.size, 0);
  });
}

for (const error of ['renderError', 'executeError']) {
  test(`${error} settles without an unverified POST or leaked host`, async () => {
    const b = browser({ [error]: true }); b.open(); await b.flush();
    assert.equal(b.posts().length, 0);
    assert.equal(b.timers.size, 0);
    assert.equal(b.elements['.mpx-chat-status'].parentNode.children[0].removed, true);
  });
}
