function cleanText(value, { field, min = 0, max }) {
  const text = String(value ?? '').trim();
  if (text.length < min || text.length > max) {
    throw new Error(`${field} invalido`);
  }
  return text;
}

function cleanEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Email invalido');
  }
  return email;
}

function normalizeColombianMobile(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (/^3\d{9}$/.test(digits)) return `57${digits}`;
  if (/^573\d{9}$/.test(digits)) return digits;
  throw new Error('WhatsApp invalido');
}

function cleanDocument(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length < 6 || digits.length > 15) throw new Error('Cedula invalida');
  return digits;
}

module.exports = { cleanText, cleanEmail, normalizeColombianMobile, cleanDocument };
