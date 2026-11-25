// `npm run dev:mock`: the editor on http://localhost:8787 with no secrets and
// no way to write. The real Worker code runs in Node against a stand-in for
// GitHub that serves the works from this checkout, and DRY_RUN is forced on,
// so Save only reports what it would commit. Photos go through the Worker's
// /api/photo route like in production; the stand-in answers those reads from
// the files on disk (whatever the commit in the URL), so nothing has to be
// pushed. For trying out the editor and for screenshots; never deployed.
//
// The archive (#/archive) uses a stand-in Drive and Sheet (test/mock-google.mjs)
// by default, kept in memory: saves, new works and photo uploads (to
// /__mock/upload instead of Google) all work until the server stops.
// With --drive=real it uses a real Drive folder as the service account
// instead (the TEST folder "Kunstwerken TEST" unless both ids below are set):
//   `npm run dev:archive`        read-only: every Google request but GET is refused
//   `npm run dev:archive:write`  (--write) saves, new works, folder and photo renames
//                                and Sheet writes, but only inside the configured folder
//                                and its Sheet; anything else, and any delete, is refused
//   SA_KEY_FILE         key file, default ~/.secrets/arnenys-archive-sa.json
//   ARCHIVE_FOLDER_ID,  the folder and its Sheet: both or neither (default the TEST
//   ARCHIVE_SHEET_ID    folder and its Sheet). --write refuses to start unless the
//                       Sheet is inside the folder
//   GOOGLE_CLIENT_ID    optional: the Picker OAuth client id, for real browser
//                       uploads to Drive (http://localhost:8787 is an allowed origin)
// Publish is a dry run in every mode (DRY_RUN is forced on).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/worker.js';
import { graphqlSnapshot, localSnapshot, ROOT } from './helpers.mjs';
import { MOCK_SA_KEY, mockArchive, mockGoogle, mockUpload, ROOT_ID, SHEET_ID } from './mock-google.mjs';

const REAL_DRIVE = process.argv.includes('--drive=real');
const WRITE = REAL_DRIVE && process.argv.includes('--write');
const TEST_FOLDER = '1geWc6HmQiu6JxdL9AprOC_Ukwmj0rZb7'; // "Kunstwerken TEST"
const TEST_SHEET = '19a5mCqGsanUrhAzf4a1cd_ET8vPhgaB9TEJyufXoV5s'; // its Sheet

const PORT = Number(process.env.PORT) || 8787;
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim();

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.map': 'application/json', '.txt': 'text/plain' };
const ASSETS = {
  async fetch(request) {
    let p = decodeURIComponent(new URL(request.url).pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(PUBLIC, path.normalize(p));
    if (!file.startsWith(PUBLIC)) return new Response('no', { status: 404 });
    try {
      return new Response(await readFile(file), { headers: { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' } });
    } catch {
      return new Response(await readFile(path.join(PUBLIC, 'index.html')), { headers: { 'content-type': TYPES['.html'] } });
    }
  },
};

const archive = mockArchive(); // the stand-in's Drive and Sheet, changed in memory
const realFetch = globalThis.fetch;
const refuse = (why) => new Response(JSON.stringify({ error: { message: why } }), { status: 403, headers: { 'content-type': 'application/json' } });

/** In --write mode: is this Drive id inside the configured folder? (Walks up its parents.) */
async function inArchiveFolder(id, headers) {
  for (let i = 0; i < 8 && id; i++) {
    if (id === env.ARCHIVE_FOLDER_ID) return true;
    const res = await realFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=parents`, { headers });
    if (!res.ok) return false;
    id = (await res.json()).parents?.[0];
  }
  return false;
}

/** The real Google, with writes refused (read-only) or kept to the configured folder and its Sheet (--write). */
async function guardGoogle(url, init) {
  const method = init.method || 'GET';
  if (method === 'GET' || url.startsWith('https://oauth2.googleapis.com/token')) return null;
  if (!WRITE) return refuse('read-only');
  const u = new URL(url);
  if (u.pathname.startsWith(`/v4/spreadsheets/${env.ARCHIVE_SHEET_ID}/values`) && method === 'POST') return null;
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
  const auth = { authorization: init.headers.authorization };
  if (u.pathname === '/drive/v3/files' && method === 'POST' && body.mimeType === 'application/vnd.google-apps.folder'
    && (await inArchiveFolder(body.parents?.[0], auth))) return null;
  const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
  if (one && method === 'PATCH' && Object.keys(body).length && Object.keys(body).every((k) => k === 'name' || k === 'description')
    && (await inArchiveFolder(decodeURIComponent(one[1]), auth))) return null;
  return refuse(`dev:archive:write only writes inside the archive folder (${method} ${u.pathname} refused)`);
}

// A stand-in GitHub: reads come from the checkout, every write is refused.
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (!REAL_DRIVE) {
    const google = await mockGoogle(input, init, archive);
    if (google) return google;
  } else if (/^https:\/\/[^/]*googleapis\.com\//.test(url)) {
    const refused = await guardGoogle(url, init);
    if (refused) return refused;
  }
  const ok = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/installation')) return ok({ id: 1 });
  if (url.includes('/access_tokens')) return ok({ token: 'mock', expires_at: new Date(Date.now() + 3600e3).toISOString() }, 201);
  if (url.endsWith('/graphql')) {
    return ok(graphqlSnapshot(localSnapshot(), head)); // fresh each time, so edits on disk show on reload
  }
  const contents = /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/contents\/([^?]+)/.exec(url);
  if (contents && (init.method || 'GET') === 'GET') {
    const rel = contents[1].split('/').map(decodeURIComponent).join('/');
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(path.join(ROOT, 'src', 'assets') + path.sep)) return ok({ message: 'Not Found' }, 404);
    try {
      return new Response(await readFile(file), { headers: { 'content-type': 'application/octet-stream' } });
    } catch {
      return ok({ message: 'Not Found' }, 404);
    }
  }
  if (url.startsWith('https://api.github.com')) return ok({ message: 'The mock server never writes.' }, 403);
  return realFetch(input, init);
};

const env = {
  GITHUB_REPO: 'michielnyss/ArneNysWeb', GITHUB_BRANCH: 'main', DRY_RUN: 'true',
  ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '',
  DEV_USER_EMAIL: 'local@localhost', DEV_USER_NAME: 'Local test',
  GH_APP_ID: '1', GH_APP_PRIVATE_KEY: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }),
  ASSETS,
  ...(REAL_DRIVE
    ? {
      GOOGLE_SA_KEY: readFileSync(process.env.SA_KEY_FILE || path.join(homedir(), '.secrets', 'arnenys-archive-sa.json'), 'utf8'),
      ARCHIVE_FOLDER_ID: process.env.ARCHIVE_FOLDER_ID || TEST_FOLDER,
      ARCHIVE_SHEET_ID: process.env.ARCHIVE_SHEET_ID || TEST_SHEET,
      ARCHIVE_READ_ONLY: WRITE ? 'false' : 'true',
      GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
    }
    : { GOOGLE_SA_KEY: MOCK_SA_KEY, ARCHIVE_FOLDER_ID: ROOT_ID, ARCHIVE_SHEET_ID: SHEET_ID, DEV_DRIVE_UPLOAD: '/__mock/upload' }),
};
if (REAL_DRIVE && !process.env.ARCHIVE_FOLDER_ID !== !process.env.ARCHIVE_SHEET_ID) {
  console.error('Set both ARCHIVE_FOLDER_ID and ARCHIVE_SHEET_ID, or neither (the TEST folder and its Sheet).');
  process.exit(1);
}
if (WRITE) {
  // Writes are kept to the folder and the Sheet given; the Sheet must be inside
  // the folder, so a mistyped pair cannot point writes at someone else's Sheet.
  const { serviceAccountToken } = await import('../src/google-sa.js');
  const { SCOPES } = await import('../src/drive.js');
  const auth = { authorization: `Bearer ${await serviceAccountToken(env.GOOGLE_SA_KEY, SCOPES)}` };
  if (!(await inArchiveFolder(env.ARCHIVE_SHEET_ID, auth))) {
    console.error('dev:archive:write: the Sheet is not inside the archive folder (or the service account cannot see it).');
    process.exit(1);
  }
}

/** dev:mock's stand-in for the browser's Drive upload: the photo joins the in-memory archive. */
function standInUpload(req, body) {
  const q = new URL(req.url, 'http://localhost').searchParams;
  if (!archive.files.some((f) => f.id === q.get('folder') && f.mimeType === 'application/vnd.google-apps.folder'))
    return [404, { error: { message: 'No such folder' } }];
  return [200, mockUpload(archive, { folderId: q.get('folder'), name: q.get('name') || 'photo.jpg', type: q.get('type'), description: q.get('description') || '', bytes: body })];
}

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  if (!REAL_DRIVE && req.method === 'POST' && req.url.startsWith('/__mock/upload?')) {
    const [status, out] = standInUpload(req, body || Buffer.alloc(0));
    res.writeHead(status, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(out));
  }
  const request = new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers: req.headers, body: req.method === 'GET' ? undefined : body });
  const out = await worker.fetch(request, env);
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(Buffer.from(await out.arrayBuffer()));
}).listen(PORT, () => console.log(`Mock editor (test mode, no writes) on http://localhost:${PORT}  [photos from disk, head ${head.slice(0, 7)}, archive: ${REAL_DRIVE ? `real Drive folder ${env.ARCHIVE_FOLDER_ID}, ${WRITE ? 'writes inside it only' : 'read-only'}` : 'stand-in, in memory'}]`));
