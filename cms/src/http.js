// Response helpers shared by the Worker's routes.

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://apis.google.com https://accounts.google.com/gsi/client 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
  "img-src 'self' data: blob: https://*.googleusercontent.com https://*.gstatic.com https://*.google.com",
  "connect-src 'self' blob: https://www.googleapis.com https://content.googleapis.com https://accounts.google.com/gsi/",
  'frame-src https://docs.google.com https://drive.google.com https://accounts.google.com https://content.googleapis.com',
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const security = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  // The Picker's API key is restricted to this site's referrer, so Google must
  // see the origin (but never the full URL).
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-robots-tag': 'noindex, nofollow',
  // The Picker opens Google sign-in in a popup and needs to talk back to it.
  'cross-origin-opener-policy': 'same-origin-allow-popups',
};

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...security },
  });

export const notFound = () => json({ error: 'Not found.' }, 404);

export const dryRun = (env) => String(env.DRY_RUN).toLowerCase() === 'true';

/** A problem to show the person as is (with an HTTP status). */
export class UserError extends Error {
  constructor(message, status = 400, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
