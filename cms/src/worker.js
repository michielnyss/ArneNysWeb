// admin.arnenys.com: a small editor for the artworks on arnenys.com.
//
//   GET  /api/session   who is signed in, plus the public Google Picker config
//   GET  /api/works     every artwork as it is on main right now
//   GET  /api/photo/<commit sha>/src/assets/...   one repo image at that commit
//   POST /api/blob      upload one photo (base64 JSON) -> blob sha
//   POST /api/save      commit edits/new works/deletions to main in one commit
//   /api/archive...     Arne's archive in Drive + the Sheet (see archive-routes.js)
//   *                   the editor's static files (public/)
//
// Every request, static files included, must carry a valid Cloudflare Access
// assertion (see access.js). With DRY_RUN = "true" nothing is ever written to
// GitHub: uploads are discarded and a save only reports what it would commit.

import { authenticate } from './access.js';
import { archiveRoute } from './archive-routes.js';
import { archiveConfig } from './drive.js';
import { createBlob, readFile, repoParts, snapshot } from './github.js';
import { dryRun, json, security, UserError } from './http.js';
import { parsePhotoPath } from './photo.js';
import { saveToRepo } from './repo.js';
import { SaveError } from './save.js';
import { SheetConflict } from './sheet.js';

const MAX_BLOB_BYTES = 30 * 1024 * 1024; // a 20 MB photo is ~27 MB as base64 JSON

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
          archive: Boolean(archiveConfig(env)),
          // The client id alone is enough to upload to Drive; the Picker also needs the API key.
          google: env.GOOGLE_CLIENT_ID
            ? { clientId: env.GOOGLE_CLIENT_ID, apiKey: env.GOOGLE_API_KEY || '', appId: env.GOOGLE_APP_ID || '' }
            : null,
          // Local stand-in only (test/mock-server.mjs): uploads go to a fake Drive.
          devUpload: ['localhost', '127.0.0.1'].includes(url.hostname) && env.DEV_DRIVE_UPLOAD || null,
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

      if (url.pathname.startsWith('/api/photo/') && request.method === 'GET') {
        const photo = parsePhotoPath(url.pathname);
        if (!photo) return json({ error: 'Not found.' }, 404);
        const res = await readFile(env, photo.path, photo.sha);
        if (res.status === 404) {
          await res.body?.cancel();
          return json({ error: 'Not found.' }, 404);
        }
        if (!res.ok) {
          console.error('photo', photo.path, res.status);
          await res.body?.cancel();
          return json({ error: 'Could not load that photo from GitHub.' }, 502);
        }
        const headers = {
          ...security,
          'content-type': photo.type,
          // The URL names the commit, so the bytes behind it never change.
          'cache-control': 'private, max-age=31536000, immutable',
        };
        const length = res.headers.get('content-length');
        if (length) headers['content-length'] = length;
        return new Response(res.body, { status: 200, headers });
      }

      const archived = await archiveRoute(request, env, url, user);
      if (archived) return archived;

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
        return json({ ok: true, ...(await saveToRepo(env, () => req, user, dryRun(env))) });
      }

      return json({ error: 'Not found.' }, 404);
    } catch (e) {
      if (e instanceof SaveError || e instanceof UserError) return json({ error: e.message, details: e.details }, e.status);
      if (e instanceof SheetConflict) return json({ error: e.message, details: e.keys }, e.status);
      console.error(e.stack || e.message);
      return json({ error: 'Something went wrong on the server. Nothing was saved. Please try again in a minute.' }, 500);
    }
  },
};
