// `npm run dev:mock`: the editor on http://localhost:8787 with no secrets and
// no way to write. The real Worker code runs in Node against a stand-in for
// GitHub that serves the works from this checkout, and DRY_RUN is forced on,
// so Save only reports what it would commit. Photos go through the Worker's
// /api/photo route like in production; the stand-in answers those reads from
// the files on disk (whatever the commit in the URL), so nothing has to be
// pushed. For trying out the editor and for screenshots; never deployed.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/worker.js';
import { localSnapshot, ROOT } from './helpers.mjs';

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

// A stand-in GitHub: reads come from the checkout, every write is refused.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const ok = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/installation')) return ok({ id: 1 });
  if (url.includes('/access_tokens')) return ok({ token: 'mock', expires_at: new Date(Date.now() + 3600e3).toISOString() }, 201);
  if (url.endsWith('/graphql')) {
    const snap = localSnapshot(); // fresh each time, so edits on disk show on reload
    return ok({ data: { repository: { ref: { target: {
      oid: head, tree: { oid: snap.tree },
      works: { object: { entries: Object.entries(snap.works).map(([s, w]) => ({ name: `${s}.json`, oid: w.sha, object: { text: w.text, isTruncated: false } })) } },
      assets: { object: { entries: Object.entries(snap.assets).map(([s, names]) => ({ name: s, type: 'tree', object: { entries: names.map((n) => ({ name: n, type: 'blob' })) } })) } },
    } } } } });
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
};

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers: req.headers, body: req.method === 'GET' ? undefined : body });
  const out = await worker.fetch(request, env);
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(Buffer.from(await out.arrayBuffer()));
}).listen(PORT, () => console.log(`Mock editor (test mode, no writes) on http://localhost:${PORT}  [photos from disk, head ${head.slice(0, 7)}]`));
