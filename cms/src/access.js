// Cloudflare Access sits in front of admin.arnenys.com and only lets listed
// Google accounts through. This checks its signed assertion again inside the
// Worker, so a request that somehow skips Access (a misconfigured policy, a
// workers.dev URL) still gets nothing.
//
// Docs: https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/

const enc = new TextEncoder();
let certs = { at: 0, keys: [] };
const names = new Map(); // email -> display name, from Access's identity endpoint

export function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

async function signingKeys(env, force = false) {
  if (!force && certs.keys.length && Date.now() - certs.at < 3600_000) return certs.keys;
  const res = await fetch(`${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs: ${res.status}`);
  certs = { at: Date.now(), keys: (await res.json()).keys || [] };
  return certs.keys;
}

/**
 * @returns {Promise<{email: string, jwt: string} | null>} null when the
 *   request carries no valid Access assertion for this application.
 */
export async function verifyAccessJwt(jwt, env, now = Date.now() / 1000) {
  if (!jwt || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = b64urlJson(parts[0]);
    payload = b64urlJson(parts[1]);
  } catch {
    return null;
  }
  if (header.alg !== 'RS256') return null;
  let jwk = (await signingKeys(env)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await signingKeys(env, true)).find((k) => k.kid === header.kid); // keys rotated
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== env.ACCESS_TEAM_DOMAIN) return null;
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (typeof payload.exp !== 'number' || payload.exp < now - 30) return null;
  if (typeof payload.nbf === 'number' && payload.nbf > now + 30) return null;
  if (!payload.email) return null; // service tokens have no person behind them
  return { email: String(payload.email).toLowerCase(), jwt };
}

/** The person's name as Google gave it to Access, for commit messages. */
export async function displayName(user, env) {
  if (names.has(user.email)) return names.get(user.email);
  let name = '';
  try {
    const res = await fetch(`${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/get-identity`, {
      headers: { cookie: `CF_Authorization=${user.jwt}` },
    });
    if (res.ok) name = String((await res.json()).name || '').trim();
  } catch {}
  name ||= user.email.split('@')[0];
  names.set(user.email, name);
  return name;
}

/**
 * Who is asking. Local development (wrangler dev on localhost, with
 * DEV_USER_EMAIL set in an untracked env file) skips Access; nothing else does.
 */
export async function authenticate(request, env) {
  const url = new URL(request.url);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (local && env.DEV_USER_EMAIL) {
    return { email: env.DEV_USER_EMAIL, name: env.DEV_USER_NAME || env.DEV_USER_EMAIL };
  }
  const user = await verifyAccessJwt(request.headers.get('Cf-Access-Jwt-Assertion'), env);
  if (!user) return null;
  return { email: user.email, name: await displayName(user, env) };
}
