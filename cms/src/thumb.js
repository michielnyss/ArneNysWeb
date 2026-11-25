// Archive photos are shown through the Worker (the service account's token
// never leaves it). A photo URL names the work's folder, a signature over
// that folder id, and the file:
//
//   /api/archive/thumb/<folder id>/<signature>/<file id>      800 px preview
//   /api/archive/original/<folder id>/<signature>/<file id>   the file itself (for Publish)
//
// The Worker signs only folders it listed under the archive root, and serves
// a file only if Drive says that folder is its parent. So the route cannot be
// used to read anything else the service account might see. The same
// signature vouches for a folder id the browser sends back (saves, uploads).

const ID = '[A-Za-z0-9_-]{10,200}';
const RE = new RegExp(`^/api/archive/(thumb|original)/(${ID})/([A-Za-z0-9_-]{43})/(${ID})$`);
export const isId = (s) => new RegExp(`^${ID}$`).test(String(s ?? ''));
const enc = new TextEncoder();
const keys = new Map(); // secret text -> CryptoKey

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** An HMAC key derived from the service-account key, so there is no extra secret to manage. */
async function hmacKey(secret) {
  if (!keys.has(secret)) {
    const raw = await crypto.subtle.digest('SHA-256', enc.encode(`arnenys-archive-thumb\n${secret}`));
    keys.set(secret, await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']));
  }
  return keys.get(secret);
}

export async function signFolder(secret, folderId) {
  return b64url(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(folderId)));
}

export async function verifyFolder(secret, folderId, sig) {
  if (!isId(folderId) || !/^[A-Za-z0-9_-]{43}$/.test(String(sig ?? ''))) return false;
  const bin = atob(sig.replace(/-/g, '+').replace(/_/g, '/') + '=');
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return crypto.subtle.verify('HMAC', await hmacKey(secret), bytes, enc.encode(folderId));
}

export const thumbPath = (folderId, sig, fileId, kind = 'thumb') => `/api/archive/${kind}/${folderId}/${sig}/${fileId}`;

/** "/api/archive/<thumb|original>/<folder>/<sig>/<file>" -> { kind, folderId, sig, fileId }, or null. */
export function parseThumbPath(pathname) {
  const m = RE.exec(pathname);
  return m ? { kind: m[1], folderId: m[2], sig: m[3], fileId: m[4] } : null;
}

/** Image types the routes pass on. SVG and anything else are refused. */
export const THUMB_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
/** Originals may also be phone formats; the browser converts them for the site. */
export const ORIGINAL_TYPES = new Set([...THUMB_TYPES, 'image/heic', 'image/heif', 'image/avif']);
