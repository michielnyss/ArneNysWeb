// The archive as the "All works" screen sees it: Drive folders that hold
// photos, joined with their Sheet row by folder id, plus each work's state
// on the website. Pure functions, no I/O (see drive.js and sheet.js for that).
//
// Drive layout: <root>/<year>/[<type>/...]<work>/<photos>. A work is any
// folder with at least one image directly in it, or one a Sheet row names
// (a new work before its first photo).

import { assetSrc, YEAR_MAX, YEAR_MIN } from '../shared/artwork.js';
import { cleanTitle, parseWorkFolder, workFolderName } from '../shared/naming.js';
import { FOLDER } from './drive.js';

export const folderUrl = (id) => `https://drive.google.com/drive/folders/${id}`;
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

/**
 * The folders under `rootId` with their path of names below it
 * (Map id -> string[]), and the images directly in each (Map id -> file[]).
 * Anything outside the root is dropped.
 */
export function subtree(files, rootId) {
  const folders = new Map(files.filter((f) => f.mimeType === FOLDER).map((f) => [f.id, f]));
  const paths = new Map([[rootId, []]]);
  const pathOf = (id, seen = new Set()) => {
    if (paths.has(id)) return paths.get(id);
    const f = folders.get(id);
    if (!f || seen.has(id)) return null; // outside the root, or a loop
    seen.add(id);
    const parent = (f.parents || []).map((p) => pathOf(p, seen)).find(Boolean);
    const path = parent ? [...parent, f.name] : null;
    paths.set(id, path);
    return path;
  };
  for (const id of folders.keys()) pathOf(id);
  const images = new Map();
  for (const f of files) {
    if (!f.mimeType?.startsWith('image/')) continue;
    const parent = (f.parents || []).find((p) => paths.get(p) && p !== rootId);
    if (!parent) continue;
    if (!images.has(parent)) images.set(parent, []);
    images.get(parent).push(f);
  }
  paths.delete(rootId);
  for (const [id, p] of paths) if (!p) paths.delete(id);
  return { paths, images };
}

/** Drive's file -> what the UI needs. Width and height as shown (rotation applied); `time` = capture time. */
export function photo(f) {
  const m = f.imageMediaMetadata || {};
  const turned = m.rotation === 1 || m.rotation === 3;
  return {
    id: f.id,
    name: f.name,
    width: (turned ? m.height : m.width) ?? null,
    height: (turned ? m.width : m.height) ?? null,
    size: f.size ? Number(f.size) : null,
    modified: f.modifiedTime || null,
    time: m.time || null,
  };
}

/** "2024/Schilderij/Werk A" -> year 2024, type "Schilderij". Both optional. */
export function placeOf(path) {
  const year = /^\d{4}$/.test(path[0] || '') && path.length > 1 ? Number(path[0]) : null;
  const type = path.slice(year ? 1 : 0, -1).join(' / ') || null;
  return { year, type };
}

/**
 * Where a work stands with the website:
 *   live   - it is on arnenys.com now (its slug exists on main)
 *   state  - "on", "off" or "changed" (the Sheet and the site disagree, or
 *            its website photos changed after the last publish)
 *   reasons - why it is "changed", in words for Arne
 * `site` is { slug: artwork JSON } from the repo snapshot.
 */
export function websiteStatus(row, photos, site) {
  const slug = row?.websiteSlug || null;
  const onSite = slug ? site[slug] : undefined;
  const live = Boolean(onSite);
  // Left empty, "On website" follows the slug, so linking a row to an
  // existing work does not flag it.
  const wanted = row?.onWebsite ?? live;
  const out = { live, slug, title: onSite?.title ?? null, reasons: [] };
  if (!wanted) {
    if (live) out.reasons.push('Still on the website');
    return { ...out, state: live ? 'changed' : 'off' };
  }
  if (!live) out.reasons.push(slug ? `No work “${slug}” on the website yet` : 'Not published yet');
  else out.reasons.push(...photoDrift(row, photos, slug, onSite));
  return { ...out, state: out.reasons.length ? 'changed' : 'on' };
}

/**
 * How a live work's photos differ from its last publish. "Published photos"
 * (written by Publish) says exactly which Drive photo became which file;
 * a work linked by hand has none yet, and is compared by count only.
 */
export function photoDrift(row, photos, slug, onSite) {
  const reasons = [];
  const chosen = row.websitePhotos || [];
  const published = row.publishedPhotos || [];
  const inFolder = new Map(photos.map((p) => [p.id, p]));
  const gallery = (onSite.gallery || []).map((g) => g.src);
  const gone = chosen.filter((id) => !inFolder.has(id)).length;
  if (gone) reasons.push(`${gone} website photo${gone === 1 ? ' is' : 's are'} no longer in the folder`);
  if (published.length) {
    if (chosen.join() !== published.map((p) => p.id).join()) reasons.push('Website photos chosen differently since the last publish');
    if (gallery.join() !== published.map((p) => assetSrc(slug, p.file)).join()) reasons.push('Photos were changed on the website directly');
  } else if (chosen.length && chosen.length !== gallery.length) reasons.push('Different photos on the website');
  const at = Date.parse(row.lastPublished || '');
  if (at && chosen.some((id) => Date.parse(inFolder.get(id)?.modified || '') > at))
    reasons.push('A website photo changed after the last publish');
  return reasons;
}

/**
 * Drive listing + Sheet records + site works -> the archive.
 *   works       one per photo folder, newest year first, with `row` (or null:
 *               "not in the Sheet yet") and `website`
 *   orphanRows  Sheet rows whose folder is gone, empty or listed twice
 *   siteOnly    works on the website that no row links to
 */
export function buildArchive({ files, rootId, records = [], site = {}, siteSha = {} }) {
  const { paths, images } = subtree(files, rootId);
  const rows = new Map();
  const orphanRows = [];
  for (const r of records) {
    const problem = !r.folderId ? 'No Drive folder ID'
      : rows.has(r.folderId) ? `Same folder as row ${rows.get(r.folderId).rowNumber}`
        : !paths.has(r.folderId) ? 'Folder not found in Drive'
          : null;
    if (problem) orphanRows.push({ rowNumber: r.rowNumber, folderId: r.folderId, workingTitle: r.workingTitle, problem });
    else rows.set(r.folderId, r);
  }

  const works = [];
  for (const folderId of new Set([...images.keys(), ...rows.keys()])) {
    const path = paths.get(folderId);
    const photos = (images.get(folderId) || []).sort(byName).map(photo);
    const row = rows.get(folderId) || null;
    const website = websiteStatus(row, photos, site);
    const place = placeOf(path);
    works.push({
      folderId,
      name: path.at(-1),
      path,
      url: folderUrl(folderId),
      year: typeof row?.year === 'number' ? row.year : place.year,
      type: place.type,
      title: website.title || row?.workingTitle || parseWorkFolder(path.at(-1)).title,
      photos,
      row,
      website: { ...website, sha: siteSha[website.slug] ?? null, data: website.live ? site[website.slug] : null },
    });
  }
  works.sort((a, b) => (b.year ?? -Infinity) - (a.year ?? -Infinity) || a.title.localeCompare(b.title, undefined, { numeric: true }));

  const linked = new Set(works.map((w) => w.website.slug).filter(Boolean));
  const siteOnly = Object.entries(site)
    .filter(([slug]) => !linked.has(slug))
    .map(([slug, d]) => ({ slug, title: d.title, year: d.year ?? null }))
    .sort((a, b) => String(a.title).localeCompare(String(b.title)));
  return { works, orphanRows, siteOnly, places: places(paths, new Set(works.map((w) => w.folderId))) };
}

/**
 * Where a new work can go: the year folders and the type folders directly
 * in them (not works themselves), as { year, type } (type null = the year).
 */
export function places(paths, workIds) {
  const out = [];
  for (const [id, p] of paths) {
    if (workIds.has(id) || !/^\d{4}$/.test(p[0]) || p.length > 2) continue;
    out.push({ year: Number(p[0]), type: p[1] ?? null });
  }
  return out.sort((a, b) => b.year - a.year || String(a.type ?? '').localeCompare(String(b.type ?? '')));
}

const NAME_MAX = 120;

/** A new work's place and title, checked and tidied: { year, type, title } or { problem }. */
export function cleanNewWork({ year, type, title } = {}) {
  const y = Number(year);
  const t = String(type ?? '').trim();
  const name = String(title ?? '').trim();
  if (!Number.isInteger(y) || y < YEAR_MIN || y > YEAR_MAX) return { problem: `The year should be between ${YEAR_MIN} and ${YEAR_MAX}.` };
  if (!cleanTitle(name)) return { problem: 'Please give the work a working title.' };
  if (name.length > NAME_MAX || t.length > NAME_MAX) return { problem: 'That name is too long.' };
  if (/^\d{4}$/.test(t)) return { problem: 'The type cannot be a year.' };
  return { year: y, type: t || null, title: name };
}

/**
 * The folders to create for a new work: the deepest existing folder of
 * <year>/[<type>/]<year - title> under the root, and the names still missing
 * below it. `exists` is set when the work folder itself is already there
 * (named by the scheme, or just its title as older folders are).
 */
export function planNewWork(files, rootId, { year, type, title }) {
  const { paths } = subtree(files, rootId);
  const byPath = new Map();
  for (const [id, p] of paths) if (!byPath.has(p.join('/'))) byPath.set(p.join('/'), id);
  const want = [String(year), ...(type ? [type] : []), workFolderName(year, title)];
  let parentId = rootId;
  let i = 0;
  for (; i < want.length; i++) {
    const id = byPath.get(want.slice(0, i + 1).join('/'));
    if (!id) break;
    parentId = id;
  }
  if (i === want.length) return { exists: parentId };
  const legacy = i === want.length - 1 && byPath.get([...want.slice(0, -1), title].join('/'));
  if (legacy) return { exists: legacy };
  return { parentId, create: want.slice(i) };
}
