// The service-account token minting (src/google-sa.js) against a throwaway
// key: the JWT verifies with the matching public key, carries the right
// claims, and the token exchange and its cache behave.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { serviceAccountJwt, serviceAccountToken, parseServiceAccount, TOKEN_URL } from '../src/google-sa.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const sa = {
  type: 'service_account',
  client_email: 'robot@example.iam.gserviceaccount.com',
  private_key_id: 'kid123',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: TOKEN_URL,
};
const DRIVE = 'https://www.googleapis.com/auth/drive';
const SHEETS = 'https://www.googleapis.com/auth/spreadsheets';
const part = (jwt, i) => JSON.parse(Buffer.from(jwt.split('.')[i], 'base64url').toString());

test('JWT is RS256-signed by the key and carries the grant claims', async () => {
  const jwt = await serviceAccountJwt(sa, [DRIVE, SHEETS], 1_700_000_000);
  const [h, b, s] = jwt.split('.');
  assert.deepEqual(part(jwt, 0), { alg: 'RS256', typ: 'JWT', kid: 'kid123' });
  assert.deepEqual(part(jwt, 1), {
    iss: sa.client_email, scope: `${DRIVE} ${SHEETS}`, aud: TOKEN_URL, iat: 1_700_000_000, exp: 1_700_003_600,
  });
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, Buffer.from(s, 'base64url')));
});

test('PKCS#1 keys work too', async () => {
  const pkcs1 = { ...sa, private_key: privateKey.export({ type: 'pkcs1', format: 'pem' }) };
  const [h, b, s] = (await serviceAccountJwt(pkcs1, DRIVE, 1)).split('.');
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, Buffer.from(s, 'base64url')));
});

test('token exchange posts the jwt-bearer grant and caches the result', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ access_token: `tok${calls.length}`, expires_in: 3599 }), { status: 200 });
  };
  const now = 1_700_000_000_000;
  const json = JSON.stringify({ ...sa, client_email: 'cache-test@example.iam.gserviceaccount.com' });
  assert.equal(await serviceAccountToken(json, DRIVE, { fetch, now }), 'tok1');
  assert.equal(calls[0].url, TOKEN_URL);
  const form = new URLSearchParams(calls[0].init.body);
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  assert.equal(part(form.get('assertion'), 1).scope, DRIVE);
  // Reused while fresh, renewed in the last 5 minutes.
  assert.equal(await serviceAccountToken(json, DRIVE, { fetch, now: now + 50 * 60_000 }), 'tok1');
  assert.equal(await serviceAccountToken(json, DRIVE, { fetch, now: now + 56 * 60_000 }), 'tok2');
  // Another scope set is another token.
  assert.equal(await serviceAccountToken(json, SHEETS, { fetch, now }), 'tok3');
});

test('a refused exchange throws with Google\'s error', async () => {
  const fetch = async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }), { status: 400 });
  await assert.rejects(serviceAccountToken(sa, DRIVE, { fetch, cache: false }), /400 invalid_grant Invalid JWT Signature/);
});

test('rejects something that is not a key file', () => {
  assert.throws(() => parseServiceAccount('{"type":"authorized_user"}'), /Not a service account key/);
});
