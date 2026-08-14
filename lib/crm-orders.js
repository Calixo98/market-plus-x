const kv = require('./kv');

const CRM_STATUS = Object.freeze([
  'NEW',
  'PENDING_CONFIRMATION',
  'CONFIRMED',
  'IN_FOLLOW_UP',
  'DISPATCHED',
  'COMPLETED',
  'CANCELLED',
  'REJECTED',
]);
const BOLD_PAYMENT_STATES = new Set(['SALE_APPROVED', 'SALE_REJECTED', 'VOID_APPROVED', 'VOID_REJECTED']);

function crmKey(referencia) {
  return `pedido:${referencia}:crm`;
}

function notesKey(referencia) {
  return `pedido:${referencia}:notes`;
}

function historyKey(referencia) {
  return `pedido:${referencia}:history`;
}

function validationError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function cleanActor(actor) {
  const value = String(actor || 'admin').trim().slice(0, 120);
  return value || 'admin';
}

function cleanNote(note) {
  const value = String(note || '').trim();
  if (value.length > 2000) throw validationError('La nota no puede superar 2000 caracteres');
  return value;
}

function withPaymentMethod(order) {
  if (order.metodo || !BOLD_PAYMENT_STATES.has(order.estado)) return order;
  return { ...order, metodo: 'bold' };
}

async function readSnapshot(referencia, order = null) {
  const [crmRaw, notesRaw, historyRaw] = await Promise.all([
    kv.get(crmKey(referencia)),
    kv.get(notesKey(referencia)),
    kv.get(historyKey(referencia)),
  ]);
  const crm = parseJson(crmRaw, {});
  const notasInternas = parseJson(notesRaw, []);
  const historial = parseJson(historyRaw, []);
  const legacyStatus = order && CRM_STATUS.includes(order.crmStatus) ? order.crmStatus : null;
  const crmStatus = CRM_STATUS.includes(crm.crmStatus) ? crm.crmStatus : (legacyStatus || 'NEW');

  return {
    crmStatus,
    actualizadoEn: crm.actualizadoEn || order?.actualizadoEn || null,
    actualizadoPor: crm.actualizadoPor || null,
    notasInternas: Array.isArray(notasInternas) ? notasInternas : [],
    historial: Array.isArray(historial) ? historial : [],
  };
}

async function getOrderWithCrm(referencia) {
  const raw = await kv.get(`pedido:${referencia}`);
  if (!raw) return null;
  const order = parseJson(raw, null);
  if (!order || typeof order !== 'object') return null;
  const snapshot = await readSnapshot(referencia, order);
  return {
    ...withPaymentMethod(order),
    crmStatus: snapshot.crmStatus,
    actualizadoEn: snapshot.actualizadoEn,
    actualizadoPor: snapshot.actualizadoPor,
    ultimaNotaInterna: snapshot.notasInternas.at(-1) || null,
    notasInternas: snapshot.notasInternas,
    historial: snapshot.historial,
  };
}

async function hydrateOrders(orders) {
  return Promise.all(orders.map(order => readSnapshot(order.referencia, order).then(snapshot => ({
    ...withPaymentMethod(order),
    crmStatus: snapshot.crmStatus,
    actualizadoEn: snapshot.actualizadoEn,
    actualizadoPor: snapshot.actualizadoPor,
    ultimaNotaInterna: snapshot.notasInternas.at(-1) || null,
    notasInternas: snapshot.notasInternas,
    historial: snapshot.historial,
  }))));
}

async function requireOrder(referencia) {
  const order = await getOrderWithCrm(referencia);
  if (!order) throw validationError('Pedido no encontrado', 404);
  return order;
}

async function updateCrmStatus(referencia, nextStatus, actor, note = '') {
  if (!CRM_STATUS.includes(nextStatus)) throw validationError('Estado CRM invalido');
  const cleanReference = String(referencia || '').trim();
  if (!cleanReference) throw validationError('Referencia requerida');
  const cleanActorValue = cleanActor(actor);
  const cleanNoteValue = cleanNote(note);

  return kv.withLock(`lock:crm:${cleanReference}`, async () => {
    const order = await requireOrder(cleanReference);
    const snapshot = await readSnapshot(cleanReference, order);
    const now = new Date().toISOString();
    const previousStatus = snapshot.crmStatus;
    const statusChanged = previousStatus !== nextStatus;
    const notes = [...snapshot.notasInternas];
    const history = [...snapshot.historial];

    if (statusChanged) {
      history.push({
        estadoAnterior: previousStatus,
        estadoNuevo: nextStatus,
        fecha: now,
        usuario: cleanActorValue,
        nota: cleanNoteValue || null,
      });
    }
    if (cleanNoteValue) {
      notes.push({ texto: cleanNoteValue, fecha: now, usuario: cleanActorValue, tipo: 'internal' });
    }

    await kv.set(crmKey(cleanReference), JSON.stringify({
      crmStatus: nextStatus,
      actualizadoEn: now,
      actualizadoPor: cleanActorValue,
    }));
    if (statusChanged) await kv.set(historyKey(cleanReference), JSON.stringify(history));
    if (cleanNoteValue) await kv.set(notesKey(cleanReference), JSON.stringify(notes));

    return getOrderWithCrm(cleanReference);
  });
}

async function addInternalNote(referencia, note, actor) {
  const cleanReference = String(referencia || '').trim();
  if (!cleanReference) throw validationError('Referencia requerida');
  const cleanNoteValue = cleanNote(note);
  if (!cleanNoteValue) throw validationError('La nota no puede estar vacia');
  const cleanActorValue = cleanActor(actor);

  return kv.withLock(`lock:crm:${cleanReference}`, async () => {
    const order = await requireOrder(cleanReference);
    const snapshot = await readSnapshot(cleanReference, order);
    const now = new Date().toISOString();
    const notes = [...snapshot.notasInternas, { texto: cleanNoteValue, fecha: now, usuario: cleanActorValue, tipo: 'internal' }];
    await kv.set(notesKey(cleanReference), JSON.stringify(notes));
    await kv.set(crmKey(cleanReference), JSON.stringify({
      crmStatus: snapshot.crmStatus,
      actualizadoEn: now,
      actualizadoPor: cleanActorValue,
    }));
    return getOrderWithCrm(cleanReference);
  });
}

module.exports = {
  CRM_STATUS,
  getOrderWithCrm,
  hydrateOrders,
  updateCrmStatus,
  addInternalNote,
};
