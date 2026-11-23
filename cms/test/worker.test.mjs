// The Worker end to end against a mock GitHub and a mock Cloudflare Access:
// sign-in checks, the read path, and a full commit (tree -> commit -> ref)
// without touching the real repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, webcrypto } from 'node:crypto';
import worker from '../src/worker.js';
import { pemToPkcs8 } from '../src/github.js';
import { localSnapshot } from './helpers.mjs';

// Workers-only globals.
globalThis.FixedLengthStream ||= class extends TransformStream { constructor() { super(); } };

const TEAM = 'https://example-team.cloudflareaccess.com';
const AUD = 'aud-tag-123';
const snap = localSnapshot();

// ---- Access: a key pair standing in for Cloudflare's signing key
const { publicKey, privateKey } = await webcrypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await webcrypto.subtle.exportKey('jwk', publicKey)), kid: 'k1' };
const b64u = (b) => Buffer.from(b).toString('base64url');
async function accessJwt(claims, kid = 'k1', key = privateKey) {
  const head = b64u(JSON.stringify({ alg: 'RS256', kid }));
  const body = b64u(JSON.stringify(claims));
  const sig = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', key, Buffer.from(`${head}.${body}`));
  return `${head}.${body}.${b64u(sig)}`;
}
const now = Math.floor(Date.now() / 1000);
const goodClaims = { iss: TEAM, aud: [AUD], email: 'Michiel@Example.com', exp: now + 600, iat: now, nbf: now - 1 };

// ---- GitHub App key (PKCS#1, as GitHub hands it out)
const appKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });

// ---- fetch mock
const calls = [];
function graphqlSnapshot() {
  return {
    data: { repository: { ref: { target: {
      oid: snap.head, tree: { oid: snap.tree },
      works: { object: { entries: Object.entries(snap.works).map(([s, w]) => ({ name: `${s}.json`, oid: w.sha, object: { text: w.text, isTruncated: false } })) } },
      assets: { object: { entries: Object.entries(snap.assets).map(([s, names]) => ({ name: s, type: 'tree', object: { entries: names.map((n) => ({ name: n, type: 'blob' })) } })) } },
    } } } },
  };
}
let refStatus = 200;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const method = init.method || 'GET';
  let body = init.body;
  if (body && typeof body !== 'string') body = await new Response(body).text();
  calls.push({ url, method, body, headers: init.headers || {} });
  const ok = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  if (url === `${TEAM}/cdn-cgi/access/certs`) return ok({ keys: [jwk] });
  if (url === `${TEAM}/cdn-cgi/access/get-identity`) return ok({ name: 'Michiel Nys', email: 'michiel@example.com' });
  if (url.endsWith('/repos/michielnyss/ArneNysWeb/installation')) return ok({ id: 42 });
  if (url.endsWith('/app/installations/42/access_tokens')) return ok({ token: 'inst-token', expires_at: new Date(Date.now() + 3600e3).toISOString() }, 201);
  if (url.endsWith('/graphql')) return ok(graphqlSnapshot());
  if (url.endsWith('/git/blobs')) return ok({ sha: 'f'.repeat(40) }, 201);
  if (url.endsWith('/git/trees')) return ok({ sha: '1'.repeat(40) }, 201);
  if (url.endsWith('/git/commits')) return ok({ sha: '2'.repeat(40) }, 201);
  if (url.endsWith('/git/refs/heads/main')) return refStatus === 200 ? ok({}) : ok({ message: 'Update is not a fast forward' }, refStatus);
  return new Response('unexpected ' + url, { status: 599 });
};

const env = (over = {}) => ({
  ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, GITHUB_REPO: 'michielnyss/ArneNysWeb', GITHUB_BRANCH: 'main',
  GH_APP_ID: '123', GH_APP_PRIVATE_KEY: appKey, DRY_RUN: 'false',
  ASSETS: { fetch: async () => new Response('<html>editor</html>', { headers: { 'content-type': 'text/html' } }) },
  ...over,
});
const req = async (path, { jwt, method = 'GET', body, headers = {} } = {}) =>
  new Request(`https://admin.arnenys.com${path}`, {
    method, body,
    headers: { ...(jwt ? { 'cf-access-jwt-assertion': jwt } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
  });

test('PKCS#1 GitHub keys are converted so WebCrypto can sign with them', async () => {
  await webcrypto.subtle.importKey('pkcs8', pemToPkcs8(appKey), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
});

test('no or bad Access assertion: everything is refused, static files included', async () => {
  const bad = [
    undefined,
    'garbage',
    await accessJwt({ ...goodClaims, aud: ['other-app'] }),
    await accessJwt({ ...goodClaims, iss: 'https://evil.cloudflareaccess.com' }),
    await accessJwt({ ...goodClaims, exp: now - 3600 }),
    await accessJwt({ ...goodClaims, email: undefined }),
    await accessJwt(goodClaims, 'k1', (await webcrypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign'])).privateKey),
  ];
  for (const jwt of bad) {
    for (const path of ['/', '/api/works']) {
      const res = await worker.fetch(await req(path, { jwt }), env());
      assert.equal(res.status, 403, `${path} with ${String(jwt).slice(0, 20)}`);
    }
  }
});

test('the dev bypass only works on localhost', async () => {
  const res = await worker.fetch(await req('/api/session'), env({ DEV_USER_EMAIL: 'dev@example.com' }));
  assert.equal(res.status, 403);
  const local = await worker.fetch(new Request('http://localhost:8787/api/session'), env({ DEV_USER_EMAIL: 'dev@example.com' }));
  assert.equal(local.status, 200);
});

test('a signed-in user gets the session, the editor and the works', async () => {
  const jwt = await accessJwt(goodClaims);
  const s = await (await worker.fetch(await req('/api/session', { jwt }), env())).json();
  assert.equal(s.email, 'michiel@example.com');
  assert.equal(s.name, 'Michiel Nys');
  assert.equal(s.dryRun, false);
  const page = await worker.fetch(await req('/', { jwt }), env());
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const w = await (await worker.fetch(await req('/api/works', { jwt }), env())).json();
  assert.equal(w.works.length, Object.keys(snap.works).length);
  assert.equal(w.head, snap.head);
});

test('save commits one tree/commit/ref update, with the name in the message', async () => {
  const jwt = await accessJwt(goodClaims);
  calls.length = 0;
  const body = JSON.stringify({ works: [{ slug: 'avondwind', baseSha: snap.works.avondwind.sha, data: { status: 'Reserved' } }] });
  const res = await worker.fetch(await req('/api/save', { jwt, method: 'POST', body }), env());
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.head, '2'.repeat(40));
  const tree = JSON.parse(calls.find((c) => c.url.endsWith('/git/trees')).body);
  assert.equal(tree.base_tree, snap.tree);
  assert.equal(tree.tree.length, 1);
  assert.equal(tree.tree[0].path, 'src/content/artworks/avondwind.json');
  assert.equal(JSON.parse(tree.tree[0].content).status, 'Reserved');
  const commit = JSON.parse(calls.find((c) => c.url.endsWith('/git/commits')).body);
  assert.deepEqual(commit.parents, [snap.head]);
  assert.match(commit.message, /^Update "Avondwind"\n\nSaved in admin/);
  const ref = calls.find((c) => c.url.endsWith('/git/refs/heads/main'));
  assert.equal(ref.method, 'PATCH');
  assert.equal(JSON.parse(ref.body).force, false);
  assert.ok(calls.filter((c) => c.url.startsWith('https://api.github.com')).every((c) => c.headers.authorization === 'Bearer inst-token' || c.url.includes('/app/') || c.url.endsWith('/installation')));
});

test('dry run writes nothing to GitHub', async () => {
  const jwt = await accessJwt(goodClaims);
  calls.length = 0;
  const body = JSON.stringify({ works: [{ slug: 'avondwind', baseSha: snap.works.avondwind.sha, data: { status: 'Sold' } }] });
  const out = await (await worker.fetch(await req('/api/save', { jwt, method: 'POST', body }), env({ DRY_RUN: 'true' }))).json();
  assert.equal(out.dryRun, true);
  assert.deepEqual(out.files, [{ path: 'src/content/artworks/avondwind.json', action: 'write' }]);
  const blob = await (await worker.fetch(await req('/api/blob', { jwt, method: 'POST', body: '{"encoding":"base64","content":"AAAA"}', headers: { 'content-length': '38' } }), env({ DRY_RUN: 'true' }))).json();
  assert.match(blob.sha, /^dryrun-/);
  assert.ok(!calls.some((c) => c.method !== 'GET' && !c.url.endsWith('/graphql') && !c.url.includes('access_tokens')), 'no writes');
});

test('photo upload streams to the blob API', async () => {
  const jwt = await accessJwt(goodClaims);
  calls.length = 0;
  const body = '{"encoding":"base64","content":"/9j/4AAQ"}';
  const out = await (await worker.fetch(await req('/api/blob', { jwt, method: 'POST', body, headers: { 'content-length': String(body.length) } }), env())).json();
  assert.equal(out.sha, 'f'.repeat(40));
  assert.equal(calls.find((c) => c.url.endsWith('/git/blobs')).body, body);
});

test('cross-origin writes are refused', async () => {
  const jwt = await accessJwt(goodClaims);
  const res = await worker.fetch(await req('/api/save', { jwt, method: 'POST', body: '{}', headers: { origin: 'https://evil.example' } }), env());
  assert.equal(res.status, 403);
});

test('if main moved during the save, it re-plans and then reports failure cleanly', async () => {
  const jwt = await accessJwt(goodClaims);
  refStatus = 422;
  calls.length = 0;
  const body = JSON.stringify({ works: [{ slug: 'avondwind', baseSha: snap.works.avondwind.sha, data: { status: 'Sold' } }] });
  const res = await worker.fetch(await req('/api/save', { jwt, method: 'POST', body }), env());
  refStatus = 200;
  assert.equal(res.status, 500);
  assert.equal(calls.filter((c) => c.url.endsWith('/git/refs/heads/main')).length, 3);
  assert.match((await res.json()).error, /Nothing was saved/);
});
