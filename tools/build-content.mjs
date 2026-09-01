/**
 * Turns extracted/ (raw Squarespace data) into src/content + src/assets.
 * Re-runnable: it rewrites generated files from the extraction each time.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './browser.mjs';

const EX = path.join(ROOT, 'extracted');
const CONTENT = path.join(ROOT, 'src', 'content', 'artworks');
const ASSETS = path.join(ROOT, 'src', 'assets', 'artworks');
const DATA = path.join(ROOT, 'src', 'data');

// Category id -> year, read off the live year pages during extraction.
const YEARS = {
  '698e3006c541b61476a76c8e': 2022,
  '698e3067c541b61476a76d15': 2023,
  '698e2fddfcea335ca354b7e8': 2024,
  '698e2e53c541b61476a76a5f': 2025,
  '698e31bfea7b683116d520fe': 2026,
};

/** Titles the artist never filled in; keyed by the auto-generated Squarespace slug. */
const TITLE_FIXES = {
  bjb366ne34709r4jj55mezzid34azi: 'Untitled I',
  e7oab086474gxxjaokz0lwvl9lyhqq: 'Untitled II',
};

const slugify = (s) => s.toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/['’]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '');

const manifest = JSON.parse(await fs.readFile(path.join(EX, 'manifest.json'), 'utf8'));

/**
 * The live grid is ordered by the collection's own item sequence, not by year,
 * so read that sequence off the extracted collection page and index by urlId.
 */
const gridOrder = new Map();
for (const file of ['index.json', 'artworks.json']) {
  try {
    const coll = JSON.parse(await fs.readFile(path.join(EX, 'json', file), 'utf8'));
    for (const [n, it] of (coll.items ?? []).entries()) {
      if (it.urlId && !gridOrder.has(it.urlId)) gridOrder.set(it.urlId, n);
    }
  } catch { /* file absent */ }
}

/** full-resolution URL -> downloaded filename, from the crawl. */
const byUrl = new Map();
for (const p of manifest.pages) for (const i of p.images) byUrl.set(i.original, i.file.replace(/^images\//, ''));

const fullRes = (src) => {
  const u = new URL(src);
  u.search = '';
  u.searchParams.set('format', '2500w');
  return u.toString();
};

await fs.rm(CONTENT, { recursive: true, force: true });
await fs.rm(ASSETS, { recursive: true, force: true });
await fs.mkdir(CONTENT, { recursive: true });
await fs.mkdir(ASSETS, { recursive: true });
await fs.mkdir(DATA, { recursive: true });

const files = (await fs.readdir(path.join(EX, 'json'))).filter((f) => f.startsWith('artworks--p--'));
const used = new Map();
const artworks = [];
const redirects = {};
const warnings = [];

for (const f of files.sort()) {
  const raw = JSON.parse(await fs.readFile(path.join(EX, 'json', f), 'utf8'));
  const item = raw.item;
  if (!item) { warnings.push(`${f}: no item payload`); continue; }

  const oldSlug = item.urlId;
  const title = (item.title || '').trim() || TITLE_FIXES[oldSlug] || 'Untitled';
  if (!(item.title || '').trim()) warnings.push(`untitled on Squarespace -> "${title}" (was /${oldSlug})`);

  let slug = slugify(title);
  if (used.has(slug)) {
    const n = used.get(slug) + 1;
    used.set(slug, n);
    warnings.push(`duplicate title "${title}" -> slug ${slug}-${n} (was /${oldSlug})`);
    slug = `${slug}-${n}`;
  } else {
    used.set(slug, 1);
  }

  const year = YEARS[(item.categoryIds ?? [])[0]] ?? null;
  if (!year) warnings.push(`${title}: no year category`);

  // Gallery order comes from Squarespace's own item list.
  const gallery = [];
  const dir = path.join(ASSETS, slug);
  await fs.mkdir(dir, { recursive: true });
  for (const [n, sub] of (item.items ?? []).entries()) {
    if (!sub.assetUrl) continue;
    const local = byUrl.get(fullRes(sub.assetUrl));
    if (!local) { warnings.push(`${title}: image not downloaded (${sub.filename})`); continue; }
    const ext = path.extname(local) || '.jpg';
    const name = `${String(n + 1).padStart(2, '0')}${ext}`;
    await fs.copyFile(path.join(EX, 'images', local), path.join(dir, name));
    const [w, h] = (sub.originalSize || '').split('x').map(Number);
    gallery.push({
      src: `../../assets/artworks/${slug}/${name}`,
      alt: `${title} — Arne Nys`,
      ...(w && h ? { width: w, height: h } : {}),
      focalPoint: sub.mediaFocalPoint ? { x: sub.mediaFocalPoint.x, y: sub.mediaFocalPoint.y } : undefined,
    });
  }
  if (!gallery.length) warnings.push(`${title}: no images`);

  const entry = {
    title,
    year,
    order: gridOrder.get(oldSlug) ?? 999,
    // Empty on Squarespace; these exist so they can be filled in via /admin.
    description: '',
    medium: '',
    dimensions: '',
    gallery,
    legacySlug: oldSlug,
  };
  artworks.push({ slug, ...entry });
  redirects[`/artworks/p/${oldSlug}`] = `/artworks/${slug}`;
  await fs.writeFile(path.join(CONTENT, `${slug}.json`), JSON.stringify(entry, null, 2) + '\n');
}

await fs.writeFile(path.join(DATA, 'redirects.json'), JSON.stringify(redirects, null, 2) + '\n');

const byYear = {};
for (const a of artworks) (byYear[a.year] ??= []).push(a.title);

console.log(`${artworks.length} artworks -> src/content/artworks/`);
console.log(`${artworks.reduce((n, a) => n + a.gallery.length, 0)} images -> src/assets/artworks/`);
for (const y of Object.keys(byYear).sort()) console.log(`  ${y}: ${byYear[y].length}`);
console.log(`\n${Object.keys(redirects).length} redirects -> src/data/redirects.json`);
if (warnings.length) {
  console.log(`\n${warnings.length} thing(s) to look at:`);
  for (const w of warnings) console.log('  •', w);
}
