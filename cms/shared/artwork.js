// Artwork JSON rules, shared by the Worker (which writes the files) and the
// browser UI (which edits them). They mirror two files outside cms/ exactly,
// and must change whenever those do:
//   - src/content.config.ts   (the Astro schema the site build validates)
//   - public/admin/config.yml (Sveltia's field labels, hints and defaults)

export const REPO_CONTENT_DIR = 'src/content/artworks';
export const REPO_ASSET_DIR = 'src/assets/artworks';

/** Fields the editor may change, in the key order the existing files use. */
export const EDITABLE = ['title', 'year', 'order', 'description', 'medium', 'dimensions', 'status', 'gallery'];

/** The status choices offered in config.yml. Any other existing value is kept as-is. */
export const STATUS_OPTIONS = [
  { value: '', label: 'Available — show nothing' },
  { value: 'Sold', label: 'Sold' },
  { value: 'Reserved', label: 'Reserved' },
];

export const YEAR_MIN = 1990;
export const YEAR_MAX = 2100;
/** A new work starts at −1 so it appears at the front of the grid (config.yml). */
export const NEW_WORK_ORDER = -1;

/** Image formats Astro's image() accepts and the admin can produce. */
export const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;

/** The file text the repo uses: 2-space JSON plus a trailing newline. */
export function serializeWork(data) {
  return JSON.stringify(data, null, 2) + '\n';
}

export function workPath(slug) {
  return `${REPO_CONTENT_DIR}/${slug}.json`;
}

/** Gallery src values are absolute from the repo root (Sveltia needs that). */
export function assetSrc(slug, file) {
  return `/${REPO_ASSET_DIR}/${slug}/${file}`;
}

/** "/src/assets/artworks/x/01.jpg" -> "src/assets/artworks/x/01.jpg" */
export function srcToRepoPath(src) {
  return src.replace(/^\//, '');
}

/** The site's grid order (src/lib/artworks.ts): order, then title. */
export function compareWorks(a, b) {
  return (a.data.order ?? 0) - (b.data.order ?? 0) || String(a.data.title).localeCompare(String(b.data.title));
}

/**
 * Slug from a title, the way Sveltia's {{slug}} does it: lower case, accents
 * dropped, anything else non-alphanumeric collapsed to single hyphens.
 */
export function slugify(title) {
  const s = String(title || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return s || 'work';
}

/**
 * A slug that is free. `taken` holds existing work slugs. Pure numbers are
 * avoided because /artworks/<year>/ shares the URL namespace with works, and
 * "p" because /artworks/p/... is the old Squarespace redirect space.
 */
export function uniqueSlug(base, taken) {
  const set = new Set(taken);
  let b = /^\d+$/.test(base) || base === 'p' ? `work-${base}` : base;
  if (!set.has(b)) return b;
  for (let i = 2; ; i++) if (!set.has(`${b}-${i}`)) return `${b}-${i}`;
}

/** A fresh work with the defaults config.yml gives a new entry. */
export function newWorkData(fields = {}) {
  return {
    title: fields.title ?? '',
    year: fields.year ?? new Date().getFullYear(),
    order: NEW_WORK_ORDER,
    description: '',
    medium: '',
    dimensions: '',
    status: '',
    gallery: [],
  };
}

/**
 * Applies the editor's values to the work as stored, without disturbing
 * anything the editor does not own: unknown keys, key order, `legacySlug`,
 * and each photo's `focalPoint` (matched by src) all round-trip untouched.
 */
export function mergeWork(original, edited) {
  const out = {};
  const keys = Object.keys(original);
  // Keep the original key order; add any missing editable key in canonical order.
  for (const k of EDITABLE) if (!keys.includes(k) && k in edited) keys.splice(insertIndex(keys, k), 0, k);
  for (const k of keys) {
    if (!EDITABLE.includes(k) || !(k in edited)) { out[k] = original[k]; continue; }
    out[k] = k === 'gallery' ? mergeGallery(original.gallery || [], edited.gallery || []) : edited[k];
  }
  return out;
}

function insertIndex(keys, k) {
  // Place k after the nearest preceding editable key that exists.
  const pos = EDITABLE.indexOf(k);
  for (let i = pos - 1; i >= 0; i--) {
    const at = keys.indexOf(EDITABLE[i]);
    if (at !== -1) return at + 1;
  }
  return 0;
}

function mergeGallery(origItems, editedItems) {
  const bySrc = new Map(origItems.map((it) => [it.src, it]));
  return editedItems.map((e) => {
    const o = bySrc.get(e.src);
    if (!o) return { src: e.src, alt: e.alt ?? '' };
    const item = {};
    for (const k of Object.keys(o)) item[k] = k === 'alt' ? e.alt ?? '' : o[k];
    if (!('alt' in item) && e.alt) item.alt = e.alt;
    return item;
  });
}

/** Just the editable values, for handing to the UI. */
export function editableView(data) {
  const v = {};
  for (const k of EDITABLE) v[k] = data[k];
  v.gallery = (data.gallery || []).map((g) => ({ src: g.src, alt: g.alt ?? '' }));
  return v;
}

/**
 * Checks a work against src/content.config.ts plus config.yml's limits.
 * Returns a list of plain-English problems (empty when fine).
 */
export function validateWork(data, slug) {
  const errs = [];
  if (typeof data.title !== 'string' || !data.title.trim()) errs.push('The work needs a title.');
  if (data.year !== null && data.year !== undefined) {
    if (!Number.isInteger(data.year) || data.year < YEAR_MIN || data.year > YEAR_MAX)
      errs.push(`The year should be a whole number between ${YEAR_MIN} and ${YEAR_MAX}, or left empty.`);
  }
  if (data.order !== undefined && !Number.isFinite(data.order)) errs.push('The grid position must be a number.');
  for (const k of ['description', 'medium', 'dimensions', 'status'])
    if (data[k] !== undefined && typeof data[k] !== 'string') errs.push(`${k} must be text.`);
  if (data.gallery !== undefined) {
    if (!Array.isArray(data.gallery)) errs.push('Photos are malformed.');
    else
      data.gallery.forEach((g, i) => {
        if (!g || typeof g.src !== 'string') return errs.push(`Photo ${i + 1} has no file.`);
        const ok = g.src.startsWith(`/${REPO_ASSET_DIR}/`) && IMAGE_EXT.test(g.src) && !g.src.includes('..');
        if (!ok) errs.push(`Photo ${i + 1} has an unexpected file path.`);
        if (g.alt !== undefined && typeof g.alt !== 'string') errs.push(`Photo ${i + 1}'s description must be text.`);
        if (g.focalPoint !== undefined && !(Number.isFinite(g.focalPoint?.x) && Number.isFinite(g.focalPoint?.y)))
          errs.push(`Photo ${i + 1} has a malformed crop centre.`);
      });
  }
  if (data.legacySlug !== undefined && typeof data.legacySlug !== 'string') errs.push('legacySlug must be text.');
  if (slug !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(slug)) errs.push('The work has an unexpected file name.');
  return errs;
}

/** "07.jpg" etc.: the next free two-digit name in a work's folder. */
export function nextImageName(existingNames, ext) {
  let max = 0;
  for (const n of existingNames) {
    const m = /^(\d+)\./.exec(n);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  const num = String(max + 1).padStart(2, '0');
  return `${num}.${ext}`;
}
