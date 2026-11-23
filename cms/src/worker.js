// admin.arnenys.com: a small editor for the artworks on arnenys.com.
//
//   GET  /api/session   who is signed in, plus the public Google Picker config
//   GET  /api/works     every artwork as it is on main right now
//   POST /api/blob      upload one photo (base64 JSON) -> blob sha
//   POST /api/save      commit edits/new works/deletions to main in one commit
//   *                   the editor's static files (public/)
//
// Every request, static files included, must carry a valid Cloudflare Access
// assertion (see access.js). With DRY_RUN = "true" nothing is ever written to
// GitHub: uploads are discarded and a save only reports what it would commit.

import { authenticate } from './access.js';
import { commit, createBlob, repoParts, snapshot } from './github.js';
import { planSave, SaveError } from './save.js';

const MAX_BLOB_BYTES = 30 * 1024 * 1024; // a 20 MB photo is ~27 MB as base64 JSON

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://apis.google.com https://accounts.google.com/gsi/client 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
  "img-src 'self' data: blob: https://raw.githubusercontent.com https://*.googleusercontent.com https://*.gstatic.com https://*.google.com",
  "connect-src 'self' blob: https://www.googleapis.com https://content.googleapis.com https://accounts.google.com/gsi/",
  'frame-src https://docs.google.com https://drive.google.com https://accounts.google.com https://content.googleapis.com',
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const security = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  // The Picker's API key is restricted to this site's referrer, so Google must
  // see the origin (but never the full URL).
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-robots-tag': 'noindex, nofollow',
  // The Picker opens Google sign-in in a popup and needs to talk back to it.
  'cross-origin-opener-policy': 'same-origin-allow-popups',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...security },
  });

const dryRun = (env) => String(env.DRY_RUN).toLowerCase() === 'true';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let user;
    try {
      user = await authenticate(request, env);
    } catch (e) {
      console.error('auth', e.message);
    }
    if (!user) {
      return new Response('Please sign in at https://admin.arnenys.com.', {
        status: 403,
        headers: { 'content-type': 'text/plain; charset=utf-8', ...security },
      });
    }

    if (!url.pathname.startsWith('/api/')) {
      const res = await env.ASSETS.fetch(request);
      const out = new Response(res.body, res);
      for (const [k, v] of Object.entries(security)) out.headers.set(k, v);
      // File names are not hashed, so always revalidate: a deploy shows up at once.
      out.headers.set('cache-control', /\.(html)?$|\/$/.test(url.pathname) ? 'no-store' : 'no-cache');
      return out;
    }

    // Same-origin JSON only, so another site cannot drive the API through the
    // user's Access cookie.
    if (request.method !== 'GET') {
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin) return json({ error: 'Wrong origin.' }, 403);
      if (!(request.headers.get('content-type') || '').startsWith('application/json'))
        return json({ error: 'Expected JSON.' }, 415);
    }

    try {
      if (url.pathname === '/api/session' && request.method === 'GET') {
        const { owner, repo, branch } = repoParts(env);
        return json({
          email: user.email,
          name: user.name,
          dryRun: dryRun(env),
          repo: `${owner}/${repo}`,
          branch,
          google: env.GOOGLE_CLIENT_ID && env.GOOGLE_API_KEY
            ? { clientId: env.GOOGLE_CLIENT_ID, apiKey: env.GOOGLE_API_KEY, appId: env.GOOGLE_APP_ID || '' }
            : null,
        });
      }

      if (url.pathname === '/api/works' && request.method === 'GET') {
        const s = await snapshot(env);
        return json({
          head: s.head,
          works: Object.entries(s.works).map(([slug, w]) => ({ slug, sha: w.sha, data: JSON.parse(w.text) })),
          assets: s.assets,
        });
      }

      if (url.pathname === '/api/blob' && request.method === 'POST') {
        const length = Number(request.headers.get('content-length')) || 0;
        if (length > MAX_BLOB_BYTES) return json({ error: 'That photo is too large (over 20 MB).' }, 413);
        if (dryRun(env)) {
          await request.body?.cancel();
          return json({ sha: `dryrun-${crypto.randomUUID()}`, dryRun: true });
        }
        if (!length) {
          // No length given (chunked upload): buffer it instead of streaming.
          const buf = await request.arrayBuffer();
          if (!buf.byteLength) return json({ error: 'Upload is empty.' }, 400);
          if (buf.byteLength > MAX_BLOB_BYTES) return json({ error: 'That photo is too large (over 20 MB).' }, 413);
          return json({ sha: await createBlob(env, buf, buf.byteLength) });
        }
        // Streamed straight through: base64 work happens in the browser, so
        // the Worker spends almost no CPU on a 20 MB photo.
        const { readable, writable } = new FixedLengthStream(length);
        request.body.pipeTo(writable);
        return json({ sha: await createBlob(env, readable, length) });
      }

      if (url.pathname === '/api/save' && request.method === 'POST') {
        const req = await request.json();
        for (let attempt = 0; ; attempt++) {
          const s = await snapshot(env);
          const plan = planSave(s, req, user);
          if (plan.noop) return json({ ok: true, noop: true, head: s.head });
          const summary = {
            message: plan.message,
            files: plan.entries.map((e) => ({ path: e.path, action: e.sha === null ? 'delete' : 'write' })),
            changed: plan.changed,
          };
          if (dryRun(env)) return json({ ok: true, dryRun: true, head: s.head, ...summary });
          try {
            const sha = await commit(env, { head: s.head, tree: s.tree, entries: plan.entries, message: plan.message });
            console.log('commit', sha, plan.changed.map((c) => `${c.action}:${c.slug}`).join(' '));
            return json({ ok: true, head: sha, ...summary });
          } catch (e) {
            if (e.status === 422 && attempt < 2) continue; // main moved; re-plan on the new head
            throw e;
          }
        }
      }

      return json({ error: 'Not found.' }, 404);
    } catch (e) {
      if (e instanceof SaveError) return json({ error: e.message, details: e.details }, e.status);
      console.error(e.stack || e.message);
      return json({ error: 'Something went wrong on the server. Nothing was saved. Please try again in a minute.' }, 500);
    }
  },
};
