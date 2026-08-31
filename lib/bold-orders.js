// Maquina de estados interna para los webhooks de Bold.
//
// Fuentes oficiales:
// - https://developers.bold.co/webhook
// - https://developers.bold.co/pagos-en-linea/api-link-de-pagos
//
// Bold documenta amount.total como number y amount.currency como ISO 4217.
// Una aprobacion solo se contabiliza si ambos coinciden exactamente con la
// reserva calculada por este servidor.

const kv = require('./kv');
const catalogo = require('./catalogo');

const ESTADO_REVISION_MONTO = 'SALE_APPROVED_REVIEW';
const ESTADO_REVISION_STOCK = 'SALE_APPROVED_STOCK_REVIEW';

function parseJson(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch { return null; }
}

function eventKey(event) {
  return [event.type, event.paymentId || 'sin-payment-id', event.eventId || event.createdAt || 'sin-event-id'].join(':');
}

function appendEvent(order, key) {
  const previous = Array.isArray(order.eventosBoldProcesados) ? order.eventosBoldProcesados : [];
  return [...new Set([...previous, key])].slice(-20);
}

function baseOrder(reference, event, reservation = {}) {
  return {
    ...reservation,
    referencia: reference,
    metodo: 'bold',
    paymentId: event.paymentId || null,
    montoRecibido: event.amount?.total ?? null,
    monedaRecibida: event.amount?.currency || null,
    confirmadoEn: event.createdAt || new Date().toISOString(),
  };
}

function deltas(items, multiplier) {
  return (items || []).map(item => ({ sku: item.sku, delta: Number(item.qty) * multiplier }));
}

async function processApprovedPayment(orderKey, reservationKey, reservation, event, key, previousEvents = []) {
  const receivedTotal = event.amount?.total;
  const receivedCurrency = String(event.amount?.currency || '').toUpperCase();
  const expectedTotal = Number(reservation.total);
  const expectedCurrency = String(catalogo.moneda || '').toUpperCase();
  const amountMatches = Number.isSafeInteger(receivedTotal) && receivedTotal === expectedTotal;
  const currencyMatches = receivedCurrency === expectedCurrency;
  const eventosBoldProcesados = appendEvent({ eventosBoldProcesados: previousEvents }, key);

  if (!amountMatches || !currencyMatches) {
    const order = {
      ...baseOrder(reservation.referencia || reservation.reference || '', event, reservation),
      estado: ESTADO_REVISION_MONTO,
      montoCoincide: amountMatches,
      monedaCoincide: currencyMatches,
      requiereRevision: true,
      motivoRevision: `Pago no conciliado: esperado ${expectedTotal} ${expectedCurrency}, recibido ${receivedTotal ?? 'sin monto'} ${receivedCurrency || 'sin moneda'}.`,
      stockLiberado: true,
      ventaContabilizada: false,
      emailNotificationStatus: 'pending',
      ultimoEventoBold: event.type,
      actualizadoEn: new Date().toISOString(),
      eventosBoldProcesados,
    };
    await catalogo.guardarConInventario(orderKey, order, {
      stockDeltas: reservation.stockLiberado ? [] : deltas(reservation.items, 1),
      deleteKeys: [reservationKey],
    });
    return { order, duplicate: false, approved: false, review: true };
  }

  // Si la reserva ya fue liberada por rechazo o vencimiento, volver a tomar
  // esas unidades antes de contabilizar. Si ya se vendieron, queda en revisión.
  const order = {
    ...baseOrder(reservation.referencia || reservation.reference || '', event, reservation),
    estado: 'SALE_APPROVED',
    montoCoincide: true,
    monedaCoincide: true,
    requiereRevision: false,
    motivoRevision: null,
    ultimoEventoBold: event.type,
    actualizadoEn: new Date().toISOString(),
    stockLiberado: false,
    ventaContabilizada: true,
    metaNotificationStatus: 'pending',
    telegramNotificationStatus: 'pending',
    emailNotificationStatus: 'pending',
    eventosBoldProcesados,
  };
  const saved = await catalogo.guardarConInventario(orderKey, order, {
    stockDeltas: reservation.stockLiberado ? deltas(reservation.items, -1) : [],
    soldDeltas: deltas(reservation.items, 1),
    deleteKeys: [reservationKey],
  });
  if (!saved.ok) {
    const reviewOrder = {
      ...order,
      estado: ESTADO_REVISION_STOCK,
      requiereRevision: true,
      motivoRevision: `Pago aprobado despues del vencimiento, sin stock suficiente para ${saved.sku}.`,
      stockLiberado: true,
      ventaContabilizada: false,
    };
    await catalogo.guardarConInventario(orderKey, reviewOrder, { deleteKeys: [reservationKey] });
    return { order: reviewOrder, duplicate: false, approved: false, review: true };
  }
  return { order, duplicate: false, approved: true, review: false };
}

async function processExistingOrder(orderKey, reservationKey, existing, event, key) {
  if ((existing.eventosBoldProcesados || []).includes(key)) {
    return { order: existing, duplicate: true, approved: false, review: false };
  }

  if (event.type === 'SALE_APPROVED' && !existing.ventaContabilizada
    && ['SALE_REJECTED', ESTADO_REVISION_MONTO, ESTADO_REVISION_STOCK].includes(existing.estado)) {
    const reservation = { ...(parseJson(await kv.get(reservationKey)) || existing), referencia: existing.referencia };
    return processApprovedPayment(orderKey, reservationKey, reservation, event, key, existing.eventosBoldProcesados);
  }

  const now = new Date().toISOString();
  const processed = appendEvent(existing, key);

  if (event.type === 'VOID_APPROVED') {
    const order = {
      ...existing,
      estado: 'VOID_APPROVED',
      ultimoEventoBold: event.type,
      voidPaymentId: event.paymentId || existing.paymentId || null,
      stockLiberado: true,
      ventaContabilizada: false,
      anuladoEn: event.createdAt || now,
      actualizadoEn: now,
      eventosBoldProcesados: processed,
    };
    await catalogo.guardarConInventario(orderKey, order, {
      stockDeltas: existing.stockLiberado ? [] : deltas(existing.items, 1),
      soldDeltas: existing.ventaContabilizada ? deltas(existing.items, -1) : [],
    });
    return { order, duplicate: false, approved: false, review: false };
  }

  // Un VOID_REJECTED no anula la venta original. Los demas eventos tardios
  // tampoco deben degradar una aprobacion ya procesada ni mover inventario.
  const order = {
    ...existing,
    ultimoEventoBold: event.type,
    actualizadoEn: now,
    eventosBoldProcesados: processed,
    ...(event.type === 'VOID_REJECTED' ? { anulacionRechazadaEn: event.createdAt || now } : {}),
  };
  await catalogo.guardarConInventario(orderKey, order);
  return { order, duplicate: false, approved: false, review: Boolean(order.requiereRevision) };
}

async function processBoldEvent(reference, event) {
  const reservationKey = `reserva:${reference}`;
  const orderKey = `pedido:${reference}`;
  const key = eventKey(event);

  return kv.withLock(`lock:${reservationKey}`, async () => {
    const existing = parseJson(await kv.get(orderKey));
    if (existing) return processExistingOrder(orderKey, reservationKey, existing, event, key);

    const reservation = parseJson(await kv.get(reservationKey));
    if (!reservation) {
      const order = {
        ...baseOrder(reference, event),
        estado: event.type === 'SALE_APPROVED' ? ESTADO_REVISION_STOCK : event.type,
        requiereRevision: event.type === 'SALE_APPROVED',
        motivoRevision: event.type === 'SALE_APPROVED'
          ? 'Pago aprobado sin datos de reserva; no se modifico inventario.'
          : null,
        stockLiberado: true,
        ventaContabilizada: false,
        emailNotificationStatus: 'pending',
        eventosBoldProcesados: [key],
      };
      await catalogo.guardarConInventario(orderKey, order);
      return { order, duplicate: false, approved: false, review: order.requiereRevision };
    }

    if (event.type === 'SALE_APPROVED') {
      return processApprovedPayment(orderKey, reservationKey, { ...reservation, referencia: reference }, event, key);
    }

    const order = {
      ...baseOrder(reference, event, reservation),
      estado: event.type,
      stockLiberado: true,
      ventaContabilizada: false,
      requiereRevision: event.type === 'VOID_REJECTED',
      motivoRevision: event.type === 'VOID_REJECTED'
        ? 'Bold rechazo la anulacion antes de existir una venta aprobada local; revisar la transaccion.'
        : null,
      eventosBoldProcesados: [key],
    };
    await catalogo.guardarConInventario(orderKey, order, {
      stockDeltas: reservation.stockLiberado ? [] : deltas(reservation.items, 1),
      deleteKeys: event.type === 'SALE_REJECTED' ? [] : [reservationKey],
    });
    if (event.type === 'SALE_REJECTED') {
      await kv.set(reservationKey, JSON.stringify({
        ...reservation,
        estado: 'SALE_REJECTED',
        stockLiberado: true,
        rechazadoEn: event.createdAt || new Date().toISOString(),
      }), { exSeconds: catalogo.RESERVA_TTL_RESPALDO_SEGUNDOS });
    }
    return { order, duplicate: false, approved: false, review: order.requiereRevision };
  }, { ttlSeconds: 30 });
}

module.exports = {
  ESTADO_REVISION_MONTO,
  ESTADO_REVISION_STOCK,
  processBoldEvent,
};
