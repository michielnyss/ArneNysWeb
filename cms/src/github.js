// Talks to GitHub as the "arnenys-admin" GitHub App, which is installed on
// michielnyss/ArneNysWeb only, with Contents: read & write. Commits are built
// with the Git Data API (blobs -> tree -> commit -> move main), so one save is
// one commit however many files it touches.

import { b64urlToBytes } from './access.js';

const API = 'https://api.github.com';
const enc = new TextEncoder();
let token = { value: null, exp: 0 };
let installationId = null;

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlStr = (s) => b64url(enc.encode(s));

export function repoParts(env) {
  const [owner, repo] = String(env.GITHUB_REPO || 'michielnyss/ArneNysWeb').split('/');
  return { owner, repo, branch: env.GITHUB_BRANCH || 'main' };
}

/** PEM (PKCS#1 as GitHub hands it out, or PKCS#8) -> PKCS#8 DER. */
export function pemToPkcs8(pem) {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = b64urlToBytes(body.replace(/\+/g, '-').replace(/\//g, '_'));
  if (!/BEGIN RSA PRIVATE KEY/.test(pem)) return der;
  // Wrap PKCS#1 in a PKCS#8 PrivateKeyInfo: version 0, rsaEncryption, key.
  const len = (n) => (n < 128 ? [n] : n < 256 ? [0x81, n] : n < 65536 ? [0x82, n >> 8, n & 255] : [0x83, n >> 16, (n >> 8) & 255, n & 255]);
  const algo = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = [0x04, ...len(der.length)];
  const inner = [0x02, 0x01, 0x00, ...algo, ...octet];
  const total = inner.length + der.length;
  const out = new Uint8Array(1 + len(total).length + total);
  out.set([0x30, ...len(total), ...inner]);
  out.set(der, out.length - der.length);
  return out;
}

async function appJwt(env) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64urlStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64urlStr(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(env.GH_APP_ID) }));
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToPkcs8(env.GH_APP_PRIVATE_KEY), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

const baseHeaders = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'arnenys-admin',
};

async function installationToken(env) {
  if (token.value && token.exp - Date.now() > 5 * 60_000) return token.value;
  const { owner, repo } = repoParts(env);
  const jwt = await appJwt(env);
  const auth = { ...baseHeaders, authorization: `Bearer ${jwt}` };
  if (!installationId) {
    const r = await fetch(`${API}/repos/${owner}/${repo}/installation`, { headers: auth });
    if (!r.ok) throw new Error(`GitHub App is not installed on ${owner}/${repo} (${r.status})`);
    installationId = (await r.json()).id;
  }
  const r = await fetch(`${API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ repositories: [repo], permissions: { contents: 'write' } }),
  });
  if (!r.ok) throw new Error(`GitHub token: ${r.status}`);
  const t = await r.json();
  token = { value: t.token, exp: Date.parse(t.expires_at) };
  return token.value;
}

export async function gh(env, path, init = {}) {
  const t = await installationToken(env);
  const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
    ...init,
    headers: { ...baseHeaders, authorization: `Bearer ${t}`, ...(init.headers || {}) },
  });
  return res;
}

async function ghJson(env, path, init) {
  const res = await gh(env, path, init);
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`GitHub ${init?.method || 'GET'} ${path.replace(API, '')}: ${res.status} ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

const SNAPSHOT_QUERY = `
query($owner: String!, $repo: String!, $ref: String!) {
  repository(owner: $owner, name: $repo) {
    ref(qualifiedName: $ref) {
      target {
        ... on Commit {
          oid
          tree { oid }
          works: file(path: "src/content/artworks") {
            object { ... on Tree { entries { name oid object { ... on Blob { text isTruncated } } } } }
          }
          assets: file(path: "src/assets/artworks") {
            object { ... on Tree { entries { name type object { ... on Tree { entries { name type } } } } } }
          }
        }
      }
    }
  }
}`;

/**
 * Everything the admin needs from main in one consistent read: the head
 * commit, every artwork JSON (text and blob sha) and the photo file names.
 */
export async function snapshot(env) {
  const { owner, repo, branch } = repoParts(env);
  const out = await ghJson(env, '/graphql', {
    method: 'POST',
    body: JSON.stringify({ query: SNAPSHOT_QUERY, variables: { owner, repo, ref: `refs/heads/${branch}` } }),
  });
  if (out.errors) throw new Error(`GitHub GraphQL: ${JSON.stringify(out.errors).slice(0, 300)}`);
  const c = out.data.repository.ref.target;
  const works = {};
  for (const e of c.works?.object?.entries || []) {
    if (!e.name.endsWith('.json')) continue;
    if (e.object?.isTruncated || typeof e.object?.text !== 'string') throw new Error(`Could not read ${e.name}`);
    works[e.name.slice(0, -5)] = { sha: e.oid, text: e.object.text };
  }
  const assets = {};
  for (const e of c.assets?.object?.entries || []) {
    if (e.type !== 'tree') continue;
    assets[e.name] = (e.object?.entries || []).filter((x) => x.type === 'blob').map((x) => x.name);
  }
  return { head: c.oid, tree: c.tree.oid, works, assets };
}

/** Uploads one photo. `body` is a JSON {content: base64, encoding: "base64"} stream. */
export async function createBlob(env, body, length) {
  const { owner, repo } = repoParts(env);
  const out = await ghJson(env, `/repos/${owner}/${repo}/git/blobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(length) },
    body,
  });
  return out.sha;
}

/**
 * One commit on top of `head`, then main fast-forwards to it. Throws with
 * status 422 if main moved meanwhile (the caller retries from a fresh read).
 */
export async function commit(env, { head, tree, entries, message }) {
  const { owner, repo, branch } = repoParts(env);
  const base = `/repos/${owner}/${repo}/git`;
  const newTree = await ghJson(env, `${base}/trees`, { method: 'POST', body: JSON.stringify({ base_tree: tree, tree: entries }) });
  const c = await ghJson(env, `${base}/commits`, {
    method: 'POST',
    body: JSON.stringify({ message, tree: newTree.sha, parents: [head] }),
  });
  await ghJson(env, `${base}/refs/heads/${branch}`, { method: 'PATCH', body: JSON.stringify({ sha: c.sha, force: false }) });
  return c.sha;
}
