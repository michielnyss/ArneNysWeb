// Photo preparation that never touches pixels. The repo is public, so camera
// metadata (GPS position, device, dates, editing history) is removed before a
// photo is committed, while the compressed image data is copied over byte for
// byte: no re-encoding, no quality loss.
//
//   JPEG  drop APP1 (Exif, XMP), APP3-13, APP15, comments, non-ICC APP2 (MPF)
//         and anything after the main image (iPhone depth/gain-map images).
//         Keep JFIF, the ICC colour profile and Adobe colour info. If the photo
//         was taken sideways, write back a tiny Exif block holding *only* the
//         orientation, so browsers and the site's image pipeline (sharp
//         .rotate()) still turn it upright.
//   PNG   drop tEXt / zTXt / iTXt / eXIf / tIME chunks.
//   WebP  drop EXIF and XMP chunks.
//
// Pure functions on Uint8Array so the tests can run them in Node.

export const MAX_BYTES = 20 * 1024 * 1024;

export function sniff(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  const ascii = (o, n) => String.fromCharCode(...b.subarray(o, o + n));
  if (b.length > 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'webp';
  if (b.length > 12 && ascii(4, 4) === 'ftyp') {
    const brands = ascii(8, Math.min(32, b.length - 8));
    if (/heic|heix|hevc|hevx|heim|heis|mif1|msf1/.test(brands)) return 'heic';
    if (/avif|avis/.test(brands)) return 'avif';
  }
  if (b.length > 6 && ascii(0, 3) === 'GIF') return 'gif';
  return 'unknown';
}

const u16 = (b, o) => (b[o] << 8) | b[o + 1];

function concat(parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const startsWith = (b, o, s) => {
  for (let i = 0; i < s.length; i++) if (b[o + i] !== s.charCodeAt(i)) return false;
  return true;
};

/** EXIF orientation (1-8) from an APP1 payload, or 0 if absent. */
export function exifOrientation(seg) {
  // seg = payload after the 2 length bytes, starting "Exif\0\0".
  if (!startsWith(seg, 0, 'Exif\0\0')) return 0;
  const t = 6;
  const le = seg[t] === 0x49;
  const r16 = (o) => (le ? seg[t + o] | (seg[t + o + 1] << 8) : (seg[t + o] << 8) | seg[t + o + 1]);
  const r32 = (o) => (le ? (r16(o) | (r16(o + 2) << 16)) >>> 0 : ((r16(o) << 16) | r16(o + 2)) >>> 0);
  if (r16(2) !== 42) return 0;
  const ifd = r32(4);
  if (t + ifd + 2 > seg.length) return 0;
  const n = r16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (t + e + 12 > seg.length) break;
    if (r16(e) === 0x0112) {
      const v = r16(e + 8);
      return v >= 1 && v <= 8 ? v : 0;
    }
  }
  return 0;
}

/** A complete APP1 segment carrying nothing but the orientation tag. */
export function orientationApp1(orientation) {
  const payload = [
    ...'Exif\0\0'.split('').map((c) => c.charCodeAt(0)),
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // big-endian TIFF, IFD0 at 8
    0x00, 0x01, // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ];
  const len = payload.length + 2;
  return new Uint8Array([0xff, 0xe1, len >> 8, len & 255, ...payload]);
}

/** APP2 segments holding an ICC profile (split into 64 KB chunks as the spec requires). */
export function iccApp2(icc) {
  const CHUNK = 65519;
  const count = Math.ceil(icc.length / CHUNK);
  const segs = [];
  for (let i = 0; i < count; i++) {
    const data = icc.subarray(i * CHUNK, (i + 1) * CHUNK);
    const len = 2 + 12 + 2 + data.length;
    const head = new Uint8Array([0xff, 0xe2, len >> 8, len & 255, ...'ICC_PROFILE\0'.split('').map((c) => c.charCodeAt(0)), i + 1, count]);
    segs.push(head, data);
  }
  return concat(segs);
}

/**
 * Rebuilds a JPEG with only the segments needed to display it correctly.
 * @param extra optional {icc: Uint8Array} to embed (used after HEIC conversion)
 * @returns {{bytes: Uint8Array, orientation: number, removed: string[]}}
 */
export function cleanJpeg(b, extra = {}) {
  if (sniff(b) !== 'jpeg') throw new Error('Not a JPEG');
  const keep = [];
  const removed = [];
  let orientation = 0;
  let hasIcc = false;
  let i = 2;
  let ended = false;
  while (i < b.length) {
    if (b[i] !== 0xff) throw new Error('Damaged JPEG');
    while (b[i] === 0xff && b[i + 1] === 0xff) i++; // fill bytes
    const m = b[i + 1];
    if (m === 0xd9) { keep.push(b.subarray(i, i + 2)); ended = true; break; }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { keep.push(b.subarray(i, i + 2)); i += 2; continue; }
    const len = u16(b, i + 2);
    const end = i + 2 + len;
    if (end > b.length) throw new Error('Damaged JPEG');
    const seg = b.subarray(i, end);
    const payload = b.subarray(i + 4, end);
    let drop = false;
    if (m === 0xe1) {
      drop = true;
      orientation ||= exifOrientation(payload);
      removed.push(startsWith(payload, 0, 'Exif') ? 'Exif' : 'XMP');
    } else if (m === 0xe2) {
      if (startsWith(payload, 0, 'ICC_PROFILE\0')) hasIcc = true;
      else { drop = true; removed.push(startsWith(payload, 0, 'MPF') ? 'MPF' : 'APP2'); }
    } else if ((m >= 0xe3 && m <= 0xed) || m === 0xef) {
      drop = true; removed.push(`APP${m - 0xe0}`);
    } else if (m === 0xfe) {
      drop = true; removed.push('comment');
    }
    if (!drop) keep.push(seg);
    i = end;
    if (m === 0xda) {
      // Entropy-coded data runs until the next real marker.
      const start = i;
      while (i < b.length) {
        if (b[i] === 0xff) {
          const n = b[i + 1];
          if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) { i += 2; continue; }
          if (n === 0xff) { i++; continue; }
          break;
        }
        i++;
      }
      keep.push(b.subarray(start, i));
    }
  }
  if (!ended) keep.push(new Uint8Array([0xff, 0xd9])); // truncated file: close it
  if (ended && i + 2 < b.length) removed.push('trailing data');

  // Re-insert just what is needed, right after SOI (and JFIF, which must lead).
  const head = [b.subarray(0, 2)];
  let rest = keep;
  if (keep[0] && keep[0][1] === 0xe0) { head.push(keep[0]); rest = keep.slice(1); }
  if (orientation > 1) head.push(orientationApp1(orientation));
  if (extra.icc && !hasIcc) head.push(iccApp2(extra.icc));
  return { bytes: concat([...head, ...rest]), orientation: orientation || 1, removed };
}

const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

export function cleanPng(b) {
  if (sniff(b) !== 'png') throw new Error('Not a PNG');
  const parts = [b.subarray(0, 8)];
  const removed = [];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    const type = String.fromCharCode(...b.subarray(i + 4, i + 8));
    const end = i + 12 + len;
    if (end > b.length) throw new Error('Damaged PNG');
    if (PNG_DROP.has(type)) removed.push(type);
    else parts.push(b.subarray(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  return { bytes: concat(parts), orientation: 1, removed };
}

export function cleanWebp(b) {
  if (sniff(b) !== 'webp') throw new Error('Not a WebP');
  const parts = [];
  const removed = [];
  let i = 12;
  let vp8x = null;
  while (i + 8 <= b.length) {
    const type = String.fromCharCode(...b.subarray(i, i + 4));
    const len = (b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16) | (b[i + 7] << 24)) >>> 0;
    const end = i + 8 + len + (len & 1);
    if (type === 'EXIF' || type === 'XMP ') removed.push(type.trim());
    else {
      const chunk = b.slice(i, Math.min(end, b.length));
      if (type === 'VP8X') vp8x = chunk;
      parts.push(chunk);
    }
    i = end;
  }
  if (vp8x) vp8x[8] &= ~(0x08 | 0x04); // clear the EXIF and XMP flags
  const body = concat(parts);
  const size = body.length + 4;
  const head = new Uint8Array([0x52, 0x49, 0x46, 0x46, size & 255, (size >> 8) & 255, (size >> 16) & 255, size >>> 24, 0x57, 0x45, 0x42, 0x50]);
  return { bytes: concat([head, body]), orientation: 1, removed };
}

/** Lossless clean-up for the formats that allow it; null for the rest. */
export function cleanLossless(bytes) {
  const type = sniff(bytes);
  if (type === 'jpeg') return { ...cleanJpeg(bytes), ext: 'jpg', type: 'image/jpeg' };
  if (type === 'png') return { ...cleanPng(bytes), ext: 'png', type: 'image/png' };
  if (type === 'webp') return { ...cleanWebp(bytes), ext: 'webp', type: 'image/webp' };
  return null;
}
