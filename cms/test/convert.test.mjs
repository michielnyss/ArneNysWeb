// HEIC/HEIF -> JPEG conversion, run in Node with the same code the browser
// worker uses. fixtures/p3.heic is a tiny HEIF made with sharp (AV1, which
// libheif-js can parse but not decode; the browser decodes those itself), with
// an ICC colour profile and a 90° rotation. Set HEIC_SAMPLE to a real iPhone-style
// HEVC .heic to test that path too (not committed: sample files are large).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { decodeHeic, encodeJpeg, heicInfo, setupEncoder } from '../ui/convert.js';
import { ROOT } from './helpers.mjs';

const sharp = createRequire(path.join(ROOT, 'package.json'))('sharp');
const wasm = path.join(import.meta.dirname, '..', 'node_modules/@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm');
setupEncoder(async () => WebAssembly.compile(readFileSync(wasm)));

async function convert(file) {
  const px = await decodeHeic(new Uint8Array(readFileSync(file)));
  return { px, jpeg: Buffer.from(await encodeJpeg(px)) };
}

test('the colour profile is read from a HEIF without decoding it', () => {
  const info = heicInfo(new Uint8Array(readFileSync(path.join(import.meta.dirname, 'fixtures', 'p3.heic'))));
  assert.equal(info.width, 200);
  assert.equal(info.height, 300, 'size is after the HEIF rotation');
  assert.ok(info.icc && info.icc.length > 100);
  assert.equal(Buffer.from(info.icc.subarray(36, 40)).toString(), 'acsp', 'a real ICC profile');
});

test('pixels become a 4:4:4 quality-95 JPEG with the profile embedded and no metadata', async () => {
  const icc = heicInfo(new Uint8Array(readFileSync(path.join(import.meta.dirname, 'fixtures', 'p3.heic')))).icc;
  const width = 40, height = 30;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([250, 10, 10, 255], i);
  const jpeg = Buffer.from(await encodeJpeg({ data, width, height, icc }));
  const meta = await sharp(jpeg).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, width);
  assert.equal(meta.chromaSubsampling, '4:4:4');
  assert.ok(meta.icc && Buffer.from(meta.icc).equals(Buffer.from(icc)), 'colour profile embedded');
  assert.equal(meta.exif, undefined, 'no camera metadata');
  const px = await sharp(jpeg).raw().toBuffer();
  assert.ok(Math.abs(px[0] - 250) < 4 && px[1] < 15 && px[2] < 15, `got ${px[0]},${px[1]},${px[2]}`);
});

test('real HEVC HEIC (optional sample)', { skip: !process.env.HEIC_SAMPLE }, async () => {
  const { px, jpeg } = await convert(process.env.HEIC_SAMPLE);
  const meta = await sharp(jpeg).metadata();
  assert.equal(meta.width, px.width);
  assert.equal(meta.chromaSubsampling, '4:4:4');
  console.log(`  ${px.width}x${px.height} -> ${(jpeg.length / 1024).toFixed(0)} KB, icc: ${!!meta.icc}`);
});
