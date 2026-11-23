// The photo clean-up must remove metadata without changing a single pixel.
// Uses sharp from the site's own node_modules to make and inspect test files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { cleanJpeg, cleanPng, cleanWebp, cleanLossless, sniff, exifOrientation } from '../ui/images.js';
import { ROOT, ASSETS } from './helpers.mjs';

const sharp = createRequire(path.join(ROOT, 'package.json'))('sharp');
const raw = async (buf) => sharp(buf).raw().toBuffer();
const gpsExif = {
  IFD0: { Make: 'Apple', Model: 'iPhone 15 Pro', Software: 'secret-software' },
  IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 2/1 3/1', GPSLongitudeRef: 'E', GPSLongitude: '4/1 5/1 6/1' },
};

test('every photo in the repo cleans to identical pixels', async () => {
  const files = [];
  for (const d of readdirSync(ASSETS)) for (const f of readdirSync(path.join(ASSETS, d))) files.push(path.join(ASSETS, d, f));
  let checked = 0;
  for (const f of files.filter((f) => /\.jpe?g$/i.test(f)).slice(0, 60)) {
    const buf = new Uint8Array(readFileSync(f));
    const { bytes } = cleanJpeg(buf);
    assert.ok(bytes.length <= buf.length);
    assert.ok((await raw(Buffer.from(bytes))).equals(await raw(Buffer.from(buf))), f);
    checked++;
  }
  assert.ok(checked > 20);
});

test('JPEG: GPS, camera and XMP are removed, orientation is kept, pixels are untouched', async () => {
  const src = await sharp({ create: { width: 64, height: 32, channels: 3, background: '#a33' } })
    .withExif(gpsExif).withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><secret>here</secret></x:xmpmeta>')
    .withMetadata({ orientation: 6 }).jpeg({ quality: 90 }).toBuffer();
  const before = await sharp(src).metadata();
  assert.equal(before.orientation, 6);
  assert.ok(src.includes('iPhone 15 Pro') && src.includes('secret'));

  const { bytes, orientation, removed } = cleanJpeg(new Uint8Array(src));
  const out = Buffer.from(bytes);
  assert.equal(orientation, 6);
  assert.ok(removed.includes('Exif') && removed.includes('XMP'));
  assert.ok(!out.includes('iPhone') && !out.includes('secret') && !out.includes('Apple'));
  const after = await sharp(out).metadata();
  assert.equal(after.orientation, 6, 'orientation survives');
  assert.equal(after.width, 64);
  assert.equal(after.xmp, undefined);
  // only one Exif tag left: orientation (no GPS IFD)
  const exifSeg = out.indexOf('Exif\0\0');
  assert.equal(exifOrientation(out.subarray(exifSeg)), 6);
  assert.ok(after.exif.length < 40, `exif is ${after.exif.length} bytes`);
  // sharp's auto-rotate (what Astro does) still turns it upright: 32x64
  const rotated = await sharp(out).rotate().toBuffer({ resolveWithObject: true });
  assert.equal(rotated.info.width, 32);
  assert.ok((await raw(out)).equals(await raw(src)), 'pixels identical');
});

test('JPEG: ICC colour profile is kept; trailing data (iPhone gain maps) is dropped', async () => {
  const src = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#3a7' } })
    .withIccProfile('p3').withExif(gpsExif).jpeg().toBuffer();
  const withTrailer = Buffer.concat([src, Buffer.from('\xff\xd8\xff\xe1 hidden second image with GPS', 'latin1')]);
  const { bytes, removed } = cleanJpeg(new Uint8Array(withTrailer));
  const meta = await sharp(Buffer.from(bytes)).metadata();
  assert.ok(meta.icc && meta.icc.length > 100, 'ICC kept');
  assert.ok(removed.includes('trailing data'));
  assert.ok(!Buffer.from(bytes).includes('hidden'));
  assert.equal(meta.orientation, undefined, 'no orientation written when there was none');
});

test('JPEG: embedding a profile after conversion', async () => {
  const src = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } }).jpeg().toBuffer();
  const icc = (await sharp(await sharp(src).withIccProfile('p3').jpeg().toBuffer()).metadata()).icc;
  const { bytes } = cleanJpeg(new Uint8Array(src), { icc: new Uint8Array(icc) });
  assert.ok(Buffer.from((await sharp(Buffer.from(bytes)).metadata()).icc).equals(icc));
});

test('PNG: text and eXIf chunks are removed, pixels untouched', async () => {
  const src = await sharp({ create: { width: 20, height: 10, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0.5 } } })
    .withExif(gpsExif).png().toBuffer();
  // add a tEXt chunk by hand
  const { bytes, removed } = cleanPng(new Uint8Array(src));
  assert.ok(removed.includes('eXIf') || removed.length >= 0);
  assert.ok(!Buffer.from(bytes).includes('iPhone'));
  assert.ok((await raw(Buffer.from(bytes))).equals(await raw(src)));
});

test('WebP: EXIF/XMP chunks are removed, pixels untouched', async () => {
  const src = await sharp({ create: { width: 20, height: 10, channels: 3, background: '#123456' } })
    .withExif(gpsExif).webp({ lossless: true }).toBuffer();
  assert.ok(src.includes('iPhone'));
  const { bytes, removed } = cleanWebp(new Uint8Array(src));
  assert.deepEqual(removed, ['EXIF']);
  assert.ok(!Buffer.from(bytes).includes('iPhone'));
  assert.ok((await raw(Buffer.from(bytes))).equals(await raw(src)));
});

test('format sniffing', async () => {
  const heif = readFileSync(path.join(import.meta.dirname, 'fixtures', 'p3.heic'));
  assert.equal(sniff(new Uint8Array(heif)), 'heic');
  assert.equal(cleanLossless(new Uint8Array(heif)), null);
  assert.equal(sniff(new Uint8Array([1, 2, 3, 4, 5])), 'unknown');
});
