// Access tokens for a Google service account, minted in the Worker itself:
// a JWT signed with the account's private key (RS256, WebCrypto) is exchanged
// at Google's token endpoint (the OAuth 2.0 JWT bearer grant). No Google
// library needed. The key is the service account's JSON key file, kept as a
// Worker secret.

import { pemToPkcs8 } from './github.js';

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const enc = new TextEncoder();
const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlStr = (s) => b64url(enc.encode(s));

/** The parsed key file; accepts the JSON text or an object already parsed. */
export function parseServiceAccount(json) {
  const sa = typeof json === 'string' ? JSON.parse(json) : json;
  if (!sa?.client_email || !sa?.private_key) throw new Error('Not a service account key (client_email / private_key missing)');
  return sa;
}

/**
 * The signed assertion Google exchanges for an access token.
 * `scopes` is an array or a space-separated string; `nowSec` is Unix seconds.
 */
export async function serviceAccountJwt(sa, scopes, nowSec = Math.floor(Date.now() / 1000)) {
  const head = { alg: 'RS256', typ: 'JWT', ...(sa.private_key_id ? { kid: sa.private_key_id } : {}) };
  const claims = {
    iss: sa.client_email,
    scope: Array.isArray(scopes) ? scopes.join(' ') : scopes,
    aud: sa.token_uri || TOKEN_URL,
    iat: nowSec,
    exp: nowSec + 3600, // Google's maximum
  };
  const data = `${b64urlStr(JSON.stringify(head))}.${b64urlStr(JSON.stringify(claims))}`;
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToPkcs8(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(data));
  return `${data}.${b64url(sig)}`;
}

const cache = new Map(); // `${email} ${scopes}` -> { value, exp }

/**
 * A bearer token for the service account, reused until 5 minutes before it
 * expires. Options: `fetch` (for tests), `now` (ms), `cache: false`.
 */
export async function serviceAccountToken(json, scopes, opts = {}) {
  const sa = parseServiceAccount(json);
  const doFetch = opts.fetch || globalThis.fetch;
  const now = opts.now ?? Date.now();
  const scope = Array.isArray(scopes) ? scopes.join(' ') : scopes;
  const cacheKey = `${sa.client_email} ${scope}`;
  const hit = opts.cache === false ? null : cache.get(cacheKey);
  if (hit && hit.exp - now > 5 * 60_000) return hit.value;

  const assertion = await serviceAccountJwt(sa, scope, Math.floor(now / 1000));
  const res = await doFetch(sa.token_uri || TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Google token for ${sa.client_email}: ${res.status} ${body.error || ''} ${body.error_description || ''}`.trim());
  }
  const token = { value: body.access_token, exp: now + (body.expires_in || 3600) * 1000 };
  if (opts.cache !== false) cache.set(cacheKey, token);
  return token.value;
}
