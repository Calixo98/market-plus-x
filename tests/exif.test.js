const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { stripExif } = require('../scripts/strip-jpeg-exif');

function jpegWithOrientation(orientation) {
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x0112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const app1 = Buffer.alloc(payload.length + 4);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(payload.length + 2, 2);
  payload.copy(app1, 4);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9])]);
}

test('elimina EXIF sin tocar los datos comprimidos del JPEG', () => {
  const source = jpegWithOrientation(1);
  const result = stripExif(source);
  assert.equal(result.removedSegments, 1);
  assert.deepEqual(result.buffer, Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]));
});

test('se niega a quitar una orientación necesaria para mostrar la foto correctamente', () => {
  assert.throws(() => stripExif(jpegWithOrientation(6)), /orientación 6/);
});

test('las fotos públicas de clientes ya no contienen EXIF', () => {
  const customerDir = path.resolve(__dirname, '../assets/rc/customer');
  for (const file of ['IMG_7908.jpg', 'IMG_7909.jpg', 'IMG_7912.jpg', 'IMG_7916.jpg']) {
    const result = stripExif(fs.readFileSync(path.join(customerDir, file)));
    assert.equal(result.removedSegments, 0, file);
  }
});
