// Cliente minimo para la REST API de Upstash Redis (sin dependencias npm).
// Variables de entorno esperadas (las inyecta la integracion "Upstash for Redis"
// del Marketplace de Vercel al conectarla al proyecto): KV_REST_API_URL, KV_REST_API_TOKEN

function baseUrl() {
  const url = process.env.KV_REST_API_URL || process.env.KV_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error('Faltan KV_REST_API_URL (o KV_URL) / KV_REST_API_TOKEN en las variables de entorno');
  }
  return { url, token };
}

const { fetchWithTimeout } = require('./http');

// Ejecuta un comando Redis vía la REST API de Upstash. Se conserva para comandos
// pequeños que no transportan datos sensibles; los valores de pedidos siempre
// pasan por `command`, que usa POST y no los expone en la URL.
async function cmd(...parts) {
  const { url, token } = baseUrl();
  const path = parts.map(p => encodeURIComponent(String(p))).join('/');
  const res = await fetchWithTimeout(`${url}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  }, 4000);
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Upstash error (${res.status}): ${JSON.stringify(body)}`);
  }
  return body.result;
}

// Variante POST para comandos con argumentos grandes (por ejemplo EVAL con
// pedidos JSON). Evita poner datos personales y scripts completos en la URL.
async function command(parts) {
  const { url, token } = baseUrl();
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(parts),
  }, 4000);
  const body = await res.json();
  if (!res.ok || body.error) {
    throw new Error(`Upstash command error (${res.status}): ${JSON.stringify(body)}`);
  }
  return body.result;
}

async function evalScript(script, keys = [], args = []) {
  return command(['EVAL', script, keys.length, ...keys, ...args]);
}

// Ejecuta varios comandos en una sola llamada (pipeline), en orden.
async function pipeline(commands) {
  const { url, token } = baseUrl();
  const res = await fetchWithTimeout(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  }, 4000);
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Upstash pipeline error (${res.status}): ${JSON.stringify(body)}`);
  }
  return body.map(r => r.result);
}

async function get(key) {
  return cmd('get', key);
}

async function set(key, value, { exSeconds } = {}) {
  return command(['SET', key, value, ...(exSeconds ? ['EX', exSeconds] : [])]);
}

async function incrby(key, amount) {
  return cmd('incrby', key, amount);
}

// SET ... NX: solo escribe si la clave no existe. Atomico — sirve para "sembrar"
// contadores una sola vez aunque dos requests lleguen al mismo tiempo.
async function setnx(key, value, { exSeconds } = {}) {
  return command(['SET', key, value, 'NX', ...(exSeconds ? ['EX', exSeconds] : [])]);
}

// Pone/actualiza el TTL de una clave existente sin tocar su valor.
async function expire(key, seconds) {
  return cmd('expire', key, seconds);
}

async function del(key) {
  return cmd('del', key);
}

// SCAN completo (el volumen de este comercio es minimo, un solo ciclo alcanza casi siempre).
async function scanAll(matchPattern) {
  let cursor = '0';
  const keys = [];
  do {
    const result = await cmd('scan', cursor, 'match', matchPattern, 'count', '200');
    cursor = result[0];
    keys.push(...result[1]);
  } while (cursor !== '0');
  return keys;
}

async function withLock(key, work, { ttlSeconds = 15, attempts = 40 } = {}) {
  const token = `${Date.now()}-${Math.random()}`;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const acquired = await cmd('set', key, token, 'NX', 'EX', ttlSeconds);
    if (acquired === 'OK') {
      try { return await work(); }
      finally {
        await cmd('eval', "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, key, token);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Operacion ocupada; intenta nuevamente');
}

module.exports = { cmd, command, evalScript, pipeline, get, set, incrby, setnx, expire, del, scanAll, withLock };
