// Turns a file (from the computer or Google Drive) into the bytes that will be
// committed. See images.js and convert-worker.js for what happens to each format.

import { cleanLossless, MAX_BYTES, sniff } from './images.js';

export class PhotoProblem extends Error {}

const MB = (n) => `${Math.round(n / 1024 / 1024)} MB`;

let worker = null;
let seq = 0;
const pending = new Map();

function convert(bytes, kind, mime) {
  if (!worker) {
    worker = new Worker('/build/convert-worker.js', { type: 'module' });
    worker.onmessage = (ev) => {
      const p = pending.get(ev.data.id);
      if (!p) return;
      pending.delete(ev.data.id);
      ev.data.ok ? p.resolve(ev.data) : p.reject(new Error(ev.data.error));
    };
    worker.onerror = (ev) => {
      for (const p of pending.values()) p.reject(new Error(ev.message || 'converter failed'));
      pending.clear();
      worker = null;
    };
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, bytes, kind, mime }, [bytes.buffer]);
  });
}

/**
 * @param file a File/Blob
 * @param name a display name for messages
 * @returns {Promise<{bytes: Uint8Array, ext: string, type: string, converted: boolean, width?: number, height?: number}>}
 */
export async function preparePhoto(file, name = file.name || 'This photo') {
  if (file.size > MAX_BYTES)
    throw new PhotoProblem(`"${name}" is ${MB(file.size)}. Photos can be at most 20 MB. Please pick a smaller version.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniff(bytes);
  try {
    const clean = cleanLossless(bytes);
    if (clean) return { ...clean, converted: false };
  } catch {
    throw new PhotoProblem(`"${name}" seems to be damaged and could not be read. Please try another copy of it.`);
  }
  if (kind === 'heic' || kind === 'avif' || kind === 'gif') {
    try {
      const out = await convert(bytes, kind, file.type);
      if (out.bytes.length > MAX_BYTES)
        throw new PhotoProblem(`"${name}" is too large once converted. Please pick a smaller version.`);
      return { bytes: out.bytes, ext: 'jpg', type: 'image/jpeg', converted: true, width: out.width, height: out.height };
    } catch (e) {
      if (e instanceof PhotoProblem) throw e;
      console.error(e);
      throw new PhotoProblem(
        kind === 'heic'
          ? `"${name}" is an iPhone (HEIC) photo that could not be converted here. On the iPhone, set Settings › Camera › Formats to "Most Compatible", or share the photo as JPEG, and try again.`
          : `"${name}" could not be converted. Please save it as a JPEG and try again.`,
      );
    }
  }
  throw new PhotoProblem(`"${name}" is not a photo format the website can use. Please use JPEG, PNG or iPhone (HEIC) photos.`);
}
