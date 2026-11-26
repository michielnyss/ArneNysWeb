// Validates what the admin writes against the site's real Astro schema
// (src/content.config.ts), using the site's own Astro install:
//   1. every existing work, round-tripped through the editor model,
//   2. an edited work and a brand-new work with a photo, as planSave writes them,
// in a throwaway copy of the content, then `astro sync`, which parses every
// entry with the schema (image() included) and fails on any mismatch.
// A deliberately broken entry is checked too, to prove the check can fail.
//
//   npm run check-schema

import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { editableView, mergeWork, serializeWork } from '../shared/artwork.js';
import { planSave } from '../src/save.js';
import { cleanJpeg } from '../ui/images.js';
import { ASSETS, ROOT, localSnapshot } from './helpers.mjs';

const snap = localSnapshot();

function makeProject(extraWorks = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'arnenys-schema-'));
  mkdirSync(path.join(dir, 'src/content/artworks'), { recursive: true });
  cpSync(path.join(ROOT, 'src/content.config.ts'), path.join(dir, 'src/content.config.ts'));
  cpSync(ASSETS, path.join(dir, 'src/assets/artworks'), { recursive: true });
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  writeFileSync(path.join(dir, 'package.json'), '{"type":"module","private":true}');
  writeFileSync(path.join(dir, 'astro.config.mjs'), 'export default {};\n');
  writeFileSync(path.join(dir, 'tsconfig.json'), '{"extends":"astro/tsconfigs/strict"}');

  // 1. all existing works, through the editor model
  for (const [slug, w] of Object.entries(snap.works)) {
    const data = JSON.parse(w.text);
    writeFileSync(path.join(dir, `src/content/artworks/${slug}.json`), serializeWork(mergeWork(data, editableView(data))));
  }
  // 2. an edit and a new work, exactly as a save would write them
  const edit = editableView(JSON.parse(snap.works.avondwind.text));
  edit.status = 'Sold';
  edit.year = null;
  edit.gallery = [edit.gallery[1], edit.gallery[0]];
  const fresh = {
    title: 'Schema check: new work', year: 2026, order: -1, description: 'Line one.\nLine two.', medium: 'Aluminium', dimensions: '60 × 55 × 30 cm', status: 'Reserved',
    gallery: [{ src: 'new:1', alt: 'Front view' }],
  };
  const plan = planSave(snap, {
    works: [
      { slug: 'avondwind', baseSha: snap.works.avondwind.sha, data: edit },
      { slug: null, baseSha: null, data: fresh, newImages: { 1: { sha: 'x', ext: 'jpg' } } },
    ],
  }, { name: 'Schema Check' });
  const photo = cleanJpeg(new Uint8Array(readFileSync(path.join(ASSETS, 'avondwind/01.jpg')))).bytes;
  for (const e of plan.entries) {
    const file = path.join(dir, e.path);
    if (e.sha === null) rmSync(file, { force: true });
    else if (e.content) writeFileSync(file, e.content);
    else { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, photo); }
  }
  for (const [name, text] of Object.entries(extraWorks)) writeFileSync(path.join(dir, `src/content/artworks/${name}.json`), text);
  return { dir, plan };
}

function sync(dir) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/astro/astro.js'), 'sync', '--root', dir], { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout}\n${r.stderr}` };
}

const good = makeProject();
const g = sync(good.dir);
console.log(`Valid set (${Object.keys(snap.works).length} round-tripped + ${good.plan.entries.filter((e) => e.content).length} written by a save): ${g.ok ? 'PASS' : 'FAIL'}`);
if (!g.ok) console.log(g.out);

const bad = makeProject({ broken: JSON.stringify({ title: 'Broken', year: 'nineteen', gallery: [{ src: '/src/assets/artworks/nope/01.jpg' }] }) });
const b = sync(bad.dir);
console.log(`Broken entry is rejected (control): ${!b.ok ? 'PASS' : 'FAIL'}`);

for (const p of [good.dir, bad.dir]) {
  // Remove the node_modules link first, on its own, so cleanup can never
  // reach through it into the site's real node_modules.
  const link = path.join(p, 'node_modules');
  if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
  if (!existsSync(link)) rmSync(p, { recursive: true, force: true });
}
process.exit(g.ok && !b.ok ? 0 : 1);
