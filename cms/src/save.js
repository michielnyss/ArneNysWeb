// Turns a save request from the UI into the exact set of file changes for one
// Git commit. Pure: no network, so the tests can run it against the real
// content in the repo.

import {
  assetSrc, mergeWork, newWorkData, nextImageName, serializeWork, slugify, srcToRepoPath,
  uniqueSlug, validateWork, workPath, REPO_ASSET_DIR, IMAGE_EXT,
} from '../shared/artwork.js';

export class SaveError extends Error {
  constructor(message, status = 400, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const NEW_PREFIX = 'new:';

/**
 * @param snapshot {works: {slug: {sha, text}}, assets: {slug: [filename]}}
 *   the repo as it is right now (main).
 * @param req {works: [{slug|null, baseSha|null, data, newImages: {id: {sha, ext}}}],
 *             deletes: [{slug, baseSha}]}
 * @param user {name, email}
 * @returns {entries: [{path, mode, type, sha?|content?}], message, changed: [...], files: [...]}
 */
export function planSave(snapshot, req, user) {
  const works = Array.isArray(req?.works) ? req.works : [];
  const deletes = Array.isArray(req?.deletes) ? req.deletes : [];
  if (!works.length && !deletes.length) throw new SaveError('There was nothing to save.');

  const current = {}; // slug -> parsed data, as it is now in the repo
  for (const [slug, w] of Object.entries(snapshot.works)) current[slug] = JSON.parse(w.text);

  // Optimistic locking: refuse if a work changed since the UI loaded it.
  const conflicts = [];
  for (const w of works) {
    if (!w.slug) continue;
    const now = snapshot.works[w.slug];
    if (!now) conflicts.push({ slug: w.slug, reason: 'deleted' });
    else if (now.sha !== w.baseSha) conflicts.push({ slug: w.slug, reason: 'changed' });
  }
  for (const d of deletes) {
    const now = snapshot.works[d.slug];
    if (now && now.sha !== d.baseSha) conflicts.push({ slug: d.slug, reason: 'changed' });
  }
  if (conflicts.length)
    throw new SaveError('Someone changed this in the meantime. Reload the page to see the latest version.', 409, conflicts);

  const after = { ...current }; // slug -> data once the commit lands
  const takenSlugs = new Set(Object.keys(current));
  const entries = [];
  const changed = [];
  const assetsAfter = {};
  for (const [s, names] of Object.entries(snapshot.assets)) assetsAfter[s] = [...names];

  for (const d of deletes) {
    if (!current[d.slug]) continue; // already gone
    delete after[d.slug];
    entries.push({ path: workPath(d.slug), mode: '100644', type: 'blob', sha: null });
    changed.push({ action: 'delete', slug: d.slug, title: current[d.slug].title });
  }

  const upserts = [];
  for (const w of works) {
    const isNew = !w.slug;
    if (!isNew && deletes.some((d) => d.slug === w.slug)) throw new SaveError('A work cannot be edited and deleted at once.');
    const edited = sanitizeEdited(w.data);
    let slug = w.slug;
    if (isNew) {
      slug = uniqueSlug(slugify(edited.title), takenSlugs);
      takenSlugs.add(slug);
    }
    // Name the new photos into the work's folder.
    const folder = (assetsAfter[slug] ||= []);
    const newImages = w.newImages || {};
    if (edited.gallery) edited.gallery = edited.gallery.map((g) => {
      if (!g.src.startsWith(NEW_PREFIX)) return g;
      const img = newImages[g.src.slice(NEW_PREFIX.length)];
      if (!img || !img.sha || !/^(jpg|png|webp)$/.test(img.ext)) throw new SaveError('A new photo did not upload properly. Please try again.');
      const name = nextImageName(folder, img.ext);
      folder.push(name);
      entries.push({ path: `${REPO_ASSET_DIR}/${slug}/${name}`, mode: '100644', type: 'blob', sha: img.sha });
      return { ...g, src: assetSrc(slug, name) };
    });
    // A photo may only point into this work's own folder or one that exists.
    for (const g of edited.gallery || []) {
      const known = Object.values(current).some((c) => (c.gallery || []).some((x) => x.src === g.src));
      if (!known && !g.src.startsWith(assetSrc(slug, ''))) throw new SaveError('A photo points somewhere unexpected.');
    }
    const data = isNew ? Object.assign(newWorkData(), edited) : mergeWork(current[slug], edited);
    if (isNew) for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
    const problems = validateWork(data, slug);
    if (problems.length) throw new SaveError(problems.join(' '));
    after[slug] = data;
    upserts.push({ slug, isNew, data });
  }

  for (const u of upserts) {
    const text = serializeWork(u.data);
    if (!u.isNew && text === snapshot.works[u.slug].text) continue; // unchanged
    entries.push({ path: workPath(u.slug), mode: '100644', type: 'blob', content: text });
    const before = current[u.slug];
    changed.push({
      action: u.isNew ? 'add' : 'update',
      slug: u.slug,
      title: u.data.title,
      orderOnly: !u.isNew && onlyOrderChanged(before, u.data),
    });
  }

  // Photos no work uses any more are removed from the repo, but only from the
  // folders of works touched by this save, and never one still referenced.
  const referenced = new Set();
  for (const d of Object.values(after)) for (const g of d.gallery || []) referenced.add(g.src);
  const touched = new Set([...upserts.map((u) => u.slug), ...deletes.map((d) => d.slug)]);
  for (const slug of touched) {
    for (const name of snapshot.assets[slug] || []) {
      const src = assetSrc(slug, name);
      if (IMAGE_EXT.test(name) && !referenced.has(src))
        entries.push({ path: srcToRepoPath(src), mode: '100644', type: 'blob', sha: null });
    }
  }

  if (!entries.length) return { entries, message: null, changed, noop: true };
  return { entries, message: commitMessage(changed, user), changed, noop: false };
}

function sanitizeEdited(d) {
  if (!d || typeof d !== 'object') throw new SaveError('The work data is missing.');
  const out = {};
  // No trimming here: the UI tidies what the user typed, and values it did not
  // touch must round-trip byte for byte.
  if ('title' in d) out.title = String(d.title ?? '');
  if ('year' in d) out.year = d.year === '' || d.year === null ? null : Number(d.year);
  if ('order' in d) out.order = Number(d.order);
  for (const k of ['description', 'medium', 'dimensions', 'status']) if (k in d) out[k] = String(d[k] ?? '');
  if ('gallery' in d) {
    if (!Array.isArray(d.gallery)) throw new SaveError('Photos are malformed.');
    out.gallery = d.gallery.map((g) => ({ src: String(g?.src ?? ''), alt: String(g?.alt ?? '') }));
  }
  return out;
}

function onlyOrderChanged(a, b) {
  const strip = ({ order, ...rest }) => JSON.stringify(rest);
  return strip(a) === strip(b);
}

export function commitMessage(changed, user) {
  const who = user?.name || user?.email || 'the admin';
  const q = (c) => `"${c.title}"`;
  const real = changed.filter((c) => !c.orderOnly);
  const reordered = changed.some((c) => c.orderOnly);
  let subject;
  if (!real.length) subject = 'Reorder works';
  else if (real.length === 1) {
    const c = real[0];
    subject = `${{ add: 'Add', update: 'Update', delete: 'Delete' }[c.action]} ${q(c)}`;
    if (reordered) subject += ' and reorder works';
  } else subject = `Update ${real.length} works`;
  const lines = changed.filter((c) => !c.orderOnly || !real.length).map((c) =>
    `- ${c.orderOnly ? 'moved' : c.action === 'add' ? 'added' : c.action === 'delete' ? 'deleted' : 'updated'} ${q(c)}`);
  return `${subject}\n\nSaved by ${who} in admin.arnenys.com.\n\n${lines.join('\n')}\n`;
}
