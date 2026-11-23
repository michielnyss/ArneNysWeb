// Web Worker wrapper around convert.js, so converting a big iPhone photo does
// not freeze the page.

import { decodeHeic, decodeWithBrowser, encodeJpeg, setupEncoder } from './convert.js';

self.onmessage = async (ev) => {
  const { id, bytes, kind, mime } = ev.data;
  try {
    setupEncoder(() => WebAssembly.compileStreaming(fetch('/build/mozjpeg_enc.wasm')));
    let pixels;
    if (kind === 'heic') {
      try {
        pixels = await decodeHeic(bytes);
      } catch {
        pixels = await decodeWithBrowser(bytes, mime || 'image/heic'); // Safari can decode HEIC itself
      }
    } else {
      pixels = await decodeWithBrowser(bytes, mime);
    }
    const out = await encodeJpeg(pixels);
    self.postMessage({ id, ok: true, bytes: out, width: pixels.width, height: pixels.height }, [out.buffer]);
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e?.message || e) });
  }
};
