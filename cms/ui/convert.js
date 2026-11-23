// Conversion for photos that cannot be cleaned losslessly: Apple's HEIC
// (iPhone), and AVIF/GIF/other formats the browser can decode. They become one
// high-quality JPEG: quality 95, no chroma subsampling (4:4:4), with the
// original colour profile embedded so Display P3 iPhone colours stay right.
// Rotation is applied to the pixels; no camera metadata is carried over.
// Used by convert-worker.js in the browser and by the tests in Node.

import libheifFactory from 'libheif-js/libheif-wasm/libheif-bundle.mjs';
import encode, { init as initEncoder } from '@jsquash/jpeg/encode.js';
import { cleanJpeg } from './images.js';

export const JPEG_OPTIONS = { quality: 95, auto_subsample: false, chroma_subsample: 1, progressive: true, optimize_coding: true };

let heif = null;
let encoderReady = null;

/** @param loadWasm () => Promise<WebAssembly.Module> for mozjpeg_enc.wasm */
export function setupEncoder(loadWasm) {
  encoderReady ||= loadWasm().then((m) => initEncoder(m));
  return encoderReady;
}

/** Size and colour profile without decoding the pixels (used by the tests). */
export function heicInfo(bytes) {
  heif ||= libheifFactory();
  const images = new heif.HeifDecoder().decode(bytes);
  if (!images?.length) throw new Error('heic-decode');
  const out = { width: images[0].get_width(), height: images[0].get_height(), icc: readIcc(images[0]) };
  for (const i of images) try { i.free(); } catch {}
  return out;
}

export function decodeHeic(bytes) {
  heif ||= libheifFactory();
  const decoder = new heif.HeifDecoder();
  const images = decoder.decode(bytes);
  if (!images?.length) throw new Error('heic-decode');
  const img = images[0]; // the primary image comes first (is_primary() is broken in libheif-js 1.19)
  const width = img.get_width();
  const height = img.get_height();
  const icc = readIcc(img);
  return new Promise((resolve, reject) => {
    const target = { data: new Uint8ClampedArray(width * height * 4), width, height };
    img.display(target, (out) => {
      for (const i of images) try { i.free(); } catch {}
      if (!out) reject(new Error('heic-decode'));
      else resolve({ data: out.data, width, height, icc });
    });
  });
}

// libheif-js has no wrapper for the colour profile, so call the C API directly.
function readIcc(img) {
  try {
    const ptr = img.handle?.$$?.ptr;
    if (!ptr) return null;
    const type = heif._heif_image_handle_get_color_profile_type(ptr);
    if (type !== 0x72494343 && type !== 0x70726f66) return null; // 'rICC' / 'prof'
    const size = heif._heif_image_handle_get_raw_color_profile_size(ptr);
    if (!size) return null;
    const out = heif._malloc(size);
    const err = heif._malloc(16);
    heif._heif_image_handle_get_raw_color_profile(err, ptr, out);
    const code = new DataView(heif.HEAPU8.buffer).getInt32(err, true);
    const icc = code === 0 ? heif.HEAPU8.slice(out, out + size) : null;
    heif._free(out);
    heif._free(err);
    return icc;
  } catch {
    return null;
  }
}

/** Browser-only: createImageBitmap applies the EXIF rotation and converts to sRGB. */
export async function decodeWithBrowser(bytes, type) {
  const bmp = await createImageBitmap(new Blob([bytes], { type }), { imageOrientation: 'from-image' });
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // transparent areas become white, not black
  ctx.fillRect(0, 0, bmp.width, bmp.height);
  ctx.drawImage(bmp, 0, 0);
  const id = ctx.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  return { data: id.data, width: id.width, height: id.height, icc: null };
}

export async function encodeJpeg(pixels) {
  await encoderReady;
  const jpeg = new Uint8Array(await encode({ data: pixels.data, width: pixels.width, height: pixels.height }, JPEG_OPTIONS));
  return cleanJpeg(jpeg, { icc: pixels.icc }).bytes;
}
