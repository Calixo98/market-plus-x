// Elimina únicamente segmentos APP1/Exif de JPEG sin recomprimir la imagen.
// Así se quitan GPS, fecha y modelo del dispositivo conservando exactamente
// los mismos píxeles y el resto de segmentos necesarios para color/renderizado.

const fs = require('node:fs');
const path = require('node:path');

const EXIF_SIGNATURE = Buffer.from('Exif\0\0', 'binary');

function exifOrientation(payload) {
  if (!payload.subarray(0, EXIF_SIGNATURE.length).equals(EXIF_SIGNATURE)) return null;
  const tiff = EXIF_SIGNATURE.length;
  const endian = payload.toString('ascii', tiff, tiff + 2);
  const littleEndian = endian === 'II';
  if (!littleEndian && endian !== 'MM') throw new Error('EXIF con orden de bytes desconocido');
  const read16 = offset => littleEndian ? payload.readUInt16LE(offset) : payload.readUInt16BE(offset);
  const read32 = offset => littleEndian ? payload.readUInt32LE(offset) : payload.readUInt32BE(offset);
  const ifdOffset = tiff + read32(tiff + 4);
  const entries = read16(ifdOffset);
  for (let index = 0; index < entries; index += 1) {
    const entry = ifdOffset + 2 + (index * 12);
    if (read16(entry) === 0x0112) return read16(entry + 8);
  }
  return null;
}

function stripExif(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new Error('El archivo no es un JPEG válido');
  }

  const chunks = [buffer.subarray(0, 2)];
  let offset = 2;
  let removedSegments = 0;

  while (offset < buffer.length) {
    const markerStart = offset;
    if (buffer[offset] !== 0xff) throw new Error(`Marcador JPEG inválido en byte ${offset}`);
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    offset += 1;

    // SOS: desde aquí comienzan los datos comprimidos. Se conservan byte a byte.
    if (marker === 0xda) {
      chunks.push(buffer.subarray(markerStart));
      offset = buffer.length;
      break;
    }

    // Marcadores sin campo de longitud.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      chunks.push(buffer.subarray(markerStart, offset));
      continue;
    }

    if (offset + 2 > buffer.length) throw new Error('Segmento JPEG truncado');
    const length = buffer.readUInt16BE(offset);
    const segmentEnd = offset + length;
    if (length < 2 || segmentEnd > buffer.length) throw new Error('Longitud de segmento JPEG inválida');
    const payload = buffer.subarray(offset + 2, segmentEnd);
    const isExif = marker === 0xe1 && payload.subarray(0, EXIF_SIGNATURE.length).equals(EXIF_SIGNATURE);

    if (isExif) {
      const orientation = exifOrientation(payload);
      if (orientation !== null && orientation !== 1) {
        throw new Error(`No se elimina EXIF con orientación ${orientation}; normaliza la imagen primero`);
      }
      removedSegments += 1;
    } else {
      chunks.push(buffer.subarray(markerStart, segmentEnd));
    }
    offset = segmentEnd;
  }

  if (offset !== buffer.length) throw new Error('No se encontró el inicio de los datos JPEG');
  return { buffer: Buffer.concat(chunks), removedSegments };
}

function processFile(file) {
  const filePath = path.resolve(file);
  const original = fs.readFileSync(filePath);
  const cleaned = stripExif(original);
  if (cleaned.removedSegments === 0) return { file: filePath, removedSegments: 0, savedBytes: 0 };
  fs.writeFileSync(filePath, cleaned.buffer);
  return {
    file: filePath,
    removedSegments: cleaned.removedSegments,
    savedBytes: original.length - cleaned.buffer.length,
  };
}

if (require.main === module) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('Uso: node scripts/strip-jpeg-exif.js <foto.jpg> [...]');
    process.exit(1);
  }
  for (const file of files) console.log(JSON.stringify(processFile(file)));
}

module.exports = { exifOrientation, stripExif };
