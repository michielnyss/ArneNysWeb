// The archive's API: the Drive folder "Arne Kunst" and its Sheet, as the
// service account, joined with the site's works on main.
//
//   GET  /api/archive                 every work: Drive photos + Sheet row + website state
//   GET  /api/archive/thumb/<folder>/<sig>/<file>      one photo, 800 px
//   GET  /api/archive/original/<folder>/<sig>/<file>   one photo, as uploaded
//   POST /api/archive/row             save a work's Sheet row (and rename its folder)
//   POST /api/archive/new             a new work: folders as needed + a Sheet row
//   POST /api/archive/upload-target   checks a folder before the browser uploads into it, and names the photos
//   POST /api/archive/names           renames a folder's photos to the scheme (shared/naming.js)
//   POST /api/archive/publish         put a work on the website (or take it off)
//
// A folder id the browser sends must come with the signature /api/archive
// gave it (thumb.js), so only folders listed under the archive root can be
// written to. Nothing here deletes anything in Drive.

import { COLUMN, parseCell } from '../shared/archive.js';
import { newPhotoNames, parseWorkFolder, renamePlan, retitlePlan, withOriginalNote } from '../shared/naming.js';
import { publishedPairs } from '../shared/publish.js';
import { buildArchive, cleanNewWork, folderUrl, planNewWork } from './archive.js';
import {
  archiveConfig, createFolder, fetchOriginal, fetchThumbnail, fileInfo, folderInfo, isFolderUnder,
  listFolderAndImages, photosInFolder, renameFile, updateFile,
} from './drive.js';
import { snapshot } from './github.js';
import { dryRun, json, notFound, security, UserError } from './http.js';
import { saveToRepo } from './repo.js';
import { readSheet, writeRow } from './sheet.js';
import { ORIGINAL_TYPES, parseThumbPath, signFolder, THUMB_TYPES, thumbPath, verifyFolder } from './thumb.js';

/** Sheet columns the work card may write. The publish columns are Publish's alone. */
export const EDITABLE_COLUMNS = new Set([
  ...Object.values(COLUMN).filter((c) => c.group).map((c) => c.key), 'onWebsite', 'websitePhotos',
]);

/** Only editable columns, each value as its column's type. */
export function cleanChanges(changes) {
  const out = {};
  for (const [k, v] of Object.entries(changes || {})) {
    if (!EDITABLE_COLUMNS.has(k)) throw new UserError(`"${k}" cannot be changed here.`);
    out[k] = parseCell(COLUMN[k].type, v);
  }
  return out;
}

/** A Drive name as typed: trimmed, one line, not too long. */
export function cleanName(name) {
  const s = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!s) throw new UserError('The name cannot be empty.');
  if (s.length > 120) throw new UserError('That name is too long.');
  return s;
}

async function requireFolder(cfg, body) {
  if (!(await verifyFolder(cfg.key, body?.folderId, body?.sig))) throw new UserError('This folder is not part of the archive.', 403);
  return body.folderId;
}

function requireWritable(env) {
  if (String(env.ARCHIVE_READ_ONLY).toLowerCase() === 'true') throw new UserError('The archive is read-only here.', 403);
}

/** The whole archive in one response: Drive, the Sheet and main are read side by side. */
async function list(env, cfg) {
  const [files, sheet, snap] = await Promise.all([listFolderAndImages(env), readSheet(env, cfg.sheetId), snapshot(env)]);
  const site = {};
  const siteSha = {};
  for (const [slug, w] of Object.entries(snap.works)) {
    site[slug] = JSON.parse(w.text);
    siteSha[slug] = w.sha;
  }
  const out = buildArchive({ files, rootId: cfg.folderId, records: sheet.records, site, siteSha, skip: env.ARCHIVE_SKIP_FOLDERS });
  for (const w of out.works) {
    w.sig = await signFolder(cfg.key, w.folderId);
    for (const p of w.photos) p.thumb = thumbPath(w.folderId, w.sig, p.id);
  }
  return json({
    head: snap.head,
    readOnly: String(env.ARCHIVE_READ_ONLY).toLowerCase() === 'true',
    folder: { id: cfg.folderId, url: folderUrl(cfg.folderId) },
    sheet: {
      id: cfg.sheetId, url: `https://docs.google.com/spreadsheets/d/${cfg.sheetId}/edit`,
      tab: sheet.tab, missing: sheet.missing, extra: sheet.extra,
    },
    ...out,
  });
}

/** An archive photo, only if its folder was signed by /api/archive and Drive confirms the file is in it. */
async function photo(env, cfg, pathname) {
  const t = parseThumbPath(pathname);
  if (!t || !(await verifyFolder(cfg.key, t.folderId, t.sig))) return notFound();
  let info;
  try {
    info = await fileInfo(env, t.fileId);
  } catch (e) {
    if (e.status === 404) return notFound();
    throw e;
  }
  const original = t.kind === 'original';
  if (!info.parents?.includes(t.folderId) || !String(info.mimeType).startsWith('image/')) return notFound();
  const res = await (original ? fetchOriginal(env, info) : fetchThumbnail(env, info));
  const type = original ? info.mimeType : (res.headers.get('content-type') || '').split(';')[0].trim();
  if (!res.ok || !(original ? ORIGINAL_TYPES : THUMB_TYPES).has(type)) {
    await res.body?.cancel();
    if (!res.ok) console.error('archive photo', t.kind, t.fileId, res.status);
    return notFound(); // e.g. a HEIC Drive has no preview for yet
  }
  const headers = { ...security, 'content-type': type, 'cache-control': 'private, max-age=86400' };
  const length = res.headers.get('content-length');
  if (original && length) headers['content-length'] = length;
  return new Response(res.body, { status: 200, headers });
}

/** Saves the work card's Archive tab: only the changed cells, and the folder's new name if asked. */
async function saveRow(env, cfg, body) {
  const folderId = await requireFolder(cfg, body);
  const changes = cleanChanges(body.changes);
  const name = body.rename ? cleanName(body.rename) : null;
  if (!Object.keys(changes).length && !name) throw new UserError('There was nothing to save.');
  if (name) await renameFile(env, folderId, name);
  const row = Object.keys(changes).length
    ? await writeRow(env, cfg.sheetId, folderId, changes, cleanBase(body.base, changes))
    : null;
  return json({ ok: true, row, name });
}

/** The values the editor started from, typed like the changes. */
function cleanBase(base, changes) {
  const out = {};
  for (const k of Object.keys(changes)) out[k] = parseCell(COLUMN[k].type, base?.[k] ?? null);
  return out;
}

/** "New work": <year>/[<type>/]<year> - <title> under the root (creating what is missing) and its Sheet row. */
async function newWork(env, cfg, body) {
  const w = cleanNewWork(body);
  if (w.problem) throw new UserError(w.problem);
  const plan = planNewWork(await listFolderAndImages(env), cfg.folderId, w);
  if (plan.exists) throw new UserError('There is already a folder with that name there.', 409, { folderId: plan.exists });
  let folderId = plan.parentId;
  for (const name of plan.create) folderId = (await createFolder(env, name, folderId)).id;
  const row = await writeRow(env, cfg.sheetId, folderId, { workingTitle: w.title, year: w.year });
  return json({ ok: true, folderId, sig: await signFolder(cfg.key, folderId), row });
}

/**
 * Before the browser uploads photos into a folder with the person's own
 * Google token: the folder must be signed and, checked live, still be a
 * folder inside the archive. `files` ([{ name, type }], in upload order)
 * get their names: "<title> - NN.ext", after the photos in the folder now.
 * (That token cannot list the folder, so the numbers come from here.)
 */
async function uploadTarget(env, cfg, body) {
  const folderId = await requireFolder(cfg, body);
  const folder = await isFolderUnder(env, folderId, cfg.folderId);
  if (!folder) throw new UserError('This folder is no longer in the archive. Reload the page.', 403);
  const files = Array.isArray(body.files) ? body.files.slice(0, 500).map((f) => ({ name: String(f?.name ?? ''), type: String(f?.type ?? '') })) : [];
  if (!files.length) return json({ ok: true, folderId, names: [] });
  const existing = (await photosInFolder(env, folderId, 'name')).map((f) => f.name);
  return json({ ok: true, folderId, names: newPhotoNames(existing, parseWorkFolder(folder.name).title, files) });
}

/** Drive renames per request: a free Worker may make only 50 subrequests. The browser asks again for the rest. */
export const RENAME_BATCH = 40;

/**
 * Renames photos in a work's folder to the scheme, as the service account
 * (it may rename what the browser uploaded). The title is the folder's.
 *   mode "settle"  { ids }: just-uploaded photos that clash with another
 *                  upload (two at once) move to the next free number
 *   mode "tidy"    every photo not named by the scheme, by capture time
 *   mode "retitle" { from }: photos named "<from> - NN" take the folder's
 *                  (new) title; other photos are left alone
 * settle and tidy keep the old name in the description. Returns the renames
 * made and how many are `left` (more than RENAME_BATCH: ask again).
 */
async function names(env, cfg, body) {
  const folderId = await requireFolder(cfg, body);
  const folder = await folderInfo(env, folderId);
  if (!folder) throw new UserError('This folder is no longer in Drive. Reload the page.', 404);
  const title = parseWorkFolder(folder.name).title;
  const files = (await photosInFolder(env, folderId, 'id,name,mimeType,description,imageMediaMetadata(time)'))
    .map((f) => ({ ...f, time: f.imageMediaMetadata?.time || null }));
  let plan;
  if (body.mode === 'retitle') plan = retitlePlan(files, parseWorkFolder(String(body.from ?? '')).title, title);
  else if (body.mode === 'settle') plan = renamePlan(files, title, { only: Array.isArray(body.ids) ? body.ids.map(String) : [] });
  else if (body.mode === 'tidy') plan = renamePlan(files, title);
  else throw new UserError('Unknown naming mode.');
  if (!title) plan = [];
  const byId = new Map(files.map((f) => [f.id, f]));
  const renamed = [];
  for (const r of plan.slice(0, RENAME_BATCH)) {
    const description = body.mode === 'retitle' ? undefined : withOriginalNote(byId.get(r.id).description, r.from);
    await updateFile(env, r.id, { name: r.name, description });
    renamed.push({ id: r.id, from: r.from, name: r.name });
  }
  return json({ ok: true, title, renamed, left: plan.length - renamed.length });
}

/**
 * Publish: the work's public fields and starred photos (already uploaded as
 * blobs by the browser) become its artwork JSON in one commit, through the
 * same planner as Save. The slug comes from the Sheet, never the browser.
 * Then the Sheet records the publish. `off` takes the work off the site.
 */
async function publish(env, cfg, body, user) {
  const folderId = await requireFolder(cfg, body);
  const sheet = await readSheet(env, cfg.sheetId);
  const row = sheet.records.find((r) => r.folderId === folderId);
  if (!row) throw new UserError('Save the work in the archive first.');
  const linked = row.websiteSlug || null;
  const dry = dryRun(env);
  const work = body.work || {};
  let ids = [];
  let result = null;

  if (body.off) {
    result = await saveToRepo(env, (s) => {
      if (!linked || !s.works[linked]) throw new UserError('This work is not on the website.');
      return { works: [], deletes: [{ slug: linked, baseSha: work.baseSha ?? null }] };
    }, user, dry);
  } else {
    ids = Array.isArray(body.photos) ? body.photos.map(String) : [];
    const gallery = work.data?.gallery;
    if (!ids.length) throw new UserError('Star at least one photo for the website.');
    if (!Array.isArray(gallery) || gallery.length !== ids.length) throw new UserError('The photos are out of step. Reload the page.');
    const inFolder = new Set((await photosInFolder(env, folderId)).map((f) => f.id));
    if (!ids.every((id) => inFolder.has(id))) throw new UserError('A starred photo is no longer in the Drive folder. Reload the page.', 409);
    result = await saveToRepo(env, (s) => {
      const slug = linked && s.works[linked] ? linked : null;
      return { works: [{ slug, baseSha: slug ? work.baseSha ?? null : null, data: work.data, newImages: work.newImages || {} }] };
    }, user, dry);
  }

  const saved = result.saved?.[0];
  const changes = body.off
    ? { onWebsite: false, publishedPhotos: null, lastPublished: new Date().toISOString() }
    : {
      onWebsite: true, websiteSlug: saved.slug, websitePhotos: ids,
      publishedPhotos: publishedPairs(ids, saved.gallery), lastPublished: new Date().toISOString(),
    };
  const out = { ok: true, ...result, slug: body.off ? linked : saved.slug, sheet: changes };
  if (dry) return json(out); // nothing went live, so the Sheet is left as it is
  try {
    out.row = await writeRow(env, cfg.sheetId, folderId, changes);
  } catch (e) {
    console.error('publish sheet', e.message);
    out.sheetError = 'Published, but the Sheet could not be updated. Publish again later to fix that.';
  }
  return json(out);
}

/** Handles /api/archive*; null for any other path. */
export async function archiveRoute(request, env, url, user) {
  if (url.pathname !== '/api/archive' && !url.pathname.startsWith('/api/archive/')) return null;
  const cfg = archiveConfig(env);
  if (!cfg) return url.pathname === '/api/archive'
    ? json({ error: 'The archive is not set up yet.', notConfigured: true }, 503)
    : notFound();
  if (request.method === 'GET') {
    if (url.pathname === '/api/archive') return list(env, cfg);
    return photo(env, cfg, url.pathname);
  }
  if (request.method !== 'POST') return notFound();
  const routes = { row: saveRow, new: newWork, 'upload-target': uploadTarget, names, publish };
  const handler = routes[url.pathname.slice('/api/archive/'.length)];
  if (!handler) return notFound();
  requireWritable(env);
  return handler(env, cfg, await request.json(), user);
}
