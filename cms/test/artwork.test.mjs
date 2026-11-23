import test from 'node:test';
import assert from 'node:assert/strict';
import { editableView, mergeWork, serializeWork, slugify, uniqueSlug, validateWork, nextImageName } from '../shared/artwork.js';
import { planSave, SaveError } from '../src/save.js';
import { localSnapshot } from './helpers.mjs';

const snap = localSnapshot();
const slugs = Object.keys(snap.works);
const user = { name: 'Test Person', email: 't@example.com' };

test('every existing artwork round-trips byte for byte through the editor model', () => {
  assert.ok(slugs.length >= 30, `expected the real artworks, found ${slugs.length}`);
  for (const slug of slugs) {
    const text = snap.works[slug].text;
    const data = JSON.parse(text);
    assert.equal(serializeWork(mergeWork(data, editableView(data))), text, slug);
    assert.deepEqual(validateWork(data, slug), [], slug);
  }
});

test('saving every work unchanged, as the UI sends it, is a no-op', () => {
  const works = slugs.map((slug) => ({ slug, baseSha: snap.works[slug].sha, data: editableView(JSON.parse(snap.works[slug].text)), newImages: {} }));
  const plan = planSave(snap, { works }, user);
  assert.equal(plan.noop, true);
  assert.equal(plan.entries.length, 0);
});

test('editing one field changes only that field; legacySlug and focalPoint survive', () => {
  const slug = 'avondwind';
  const orig = JSON.parse(snap.works[slug].text);
  const data = editableView(orig);
  data.status = 'Sold';
  data.gallery = [data.gallery[2], data.gallery[0]]; // reorder and drop one
  data.gallery[0].alt = 'New alt';
  const plan = planSave(snap, { works: [{ slug, baseSha: snap.works[slug].sha, data }] }, user);
  const json = plan.entries.find((e) => e.path === `src/content/artworks/${slug}.json`);
  const out = JSON.parse(json.content);
  assert.equal(out.status, 'Sold');
  assert.equal(out.legacySlug, orig.legacySlug);
  assert.deepEqual(Object.keys(out), Object.keys(orig));
  assert.deepEqual(out.gallery[0], { ...orig.gallery[2], alt: 'New alt' });
  assert.deepEqual(out.gallery[1], orig.gallery[0]);
  assert.ok(out.gallery[0].focalPoint);
  // The dropped photo is deleted from the repo, nothing else is.
  const deleted = plan.entries.filter((e) => e.sha === null).map((e) => e.path);
  assert.deepEqual(deleted, ['src/assets/artworks/avondwind/02.jpg']);
  assert.match(plan.message, /^Update "Avondwind"\n\nSaved by Test Person/);
});

test('a new work gets a fresh slug, order -1, absolute image paths and numbered photos', () => {
  const data = {
    title: 'Avondwind', year: 2026, order: -1, description: '', medium: 'Oil', dimensions: '10 × 10 cm', status: '',
    gallery: [{ src: 'new:1', alt: 'Front' }, { src: 'new:2', alt: '' }],
  };
  const newImages = { 1: { sha: 'c'.repeat(40), ext: 'jpg' }, 2: { sha: 'd'.repeat(40), ext: 'png' } };
  const plan = planSave(snap, { works: [{ slug: null, baseSha: null, data, newImages }] }, user);
  const json = plan.entries.find((e) => e.path.startsWith('src/content/'));
  assert.equal(json.path, 'src/content/artworks/avondwind-2.json');
  const out = JSON.parse(json.content);
  assert.deepEqual(Object.keys(out), ['title', 'year', 'order', 'description', 'medium', 'dimensions', 'status', 'gallery']);
  assert.equal(out.order, -1);
  assert.deepEqual(out.gallery, [
    { src: '/src/assets/artworks/avondwind-2/01.jpg', alt: 'Front' },
    { src: '/src/assets/artworks/avondwind-2/02.png', alt: '' },
  ]);
  assert.deepEqual(plan.entries.filter((e) => e.sha).map((e) => [e.path, e.sha[0]]), [
    ['src/assets/artworks/avondwind-2/01.jpg', 'c'], ['src/assets/artworks/avondwind-2/02.png', 'd']]);
  assert.match(plan.message, /^Add "Avondwind"/);
});

test('new photos on an existing work continue its numbering', () => {
  const slug = 'avondwind';
  const data = editableView(JSON.parse(snap.works[slug].text));
  data.gallery.push({ src: 'new:9', alt: '' });
  const plan = planSave(snap, { works: [{ slug, baseSha: snap.works[slug].sha, data, newImages: { 9: { sha: 'e'.repeat(40), ext: 'jpg' } } }] }, user);
  assert.ok(plan.entries.some((e) => e.path === 'src/assets/artworks/avondwind/04.jpg'));
});

test('reordering sends only order and keeps everything else', () => {
  const works = slugs.slice(0, 3).map((slug, i) => ({ slug, baseSha: snap.works[slug].sha, data: { order: 100 + i } }));
  const plan = planSave(snap, { works }, user);
  assert.equal(plan.entries.length, 3);
  for (const e of plan.entries) {
    const slug = e.path.split('/').pop().slice(0, -5);
    const before = JSON.parse(snap.works[slug].text);
    const after = JSON.parse(e.content);
    assert.deepEqual({ ...after, order: before.order }, before);
    assert.deepEqual(Object.keys(after), Object.keys(before));
  }
  assert.match(plan.message, /^Reorder works/);
});

test('deleting a work removes its JSON and photos', () => {
  const slug = 'avondwind';
  const plan = planSave(snap, { works: [], deletes: [{ slug, baseSha: snap.works[slug].sha }] }, user);
  assert.deepEqual(plan.entries.map((e) => e.path).sort(), [
    'src/assets/artworks/avondwind/01.jpg', 'src/assets/artworks/avondwind/02.jpg', 'src/assets/artworks/avondwind/03.jpg',
    'src/content/artworks/avondwind.json']);
  assert.ok(plan.entries.every((e) => e.sha === null));
  assert.match(plan.message, /^Delete "Avondwind"/);
});

test('a stale edit is refused with 409', () => {
  const slug = 'avondwind';
  assert.throws(() => planSave(snap, { works: [{ slug, baseSha: 'stale', data: { order: 1 } }] }, user),
    (e) => e instanceof SaveError && e.status === 409);
});

test('bad input is refused', () => {
  const slug = 'avondwind';
  const base = { slug, baseSha: snap.works[slug].sha };
  const bad = [
    { title: '' },
    { year: 1800 },
    { year: 2020.5 },
    { gallery: [{ src: '/etc/passwd', alt: '' }] },
    { gallery: [{ src: '/src/assets/artworks/avondwind/../../x.jpg', alt: '' }] },
    { gallery: [{ src: '/src/assets/artworks/other-work/01.jpg', alt: '' }] },
    { gallery: [{ src: 'new:1', alt: '' }] }, // no uploaded blob
  ];
  for (const data of bad) assert.throws(() => planSave(snap, { works: [{ ...base, data }] }, user), SaveError, JSON.stringify(data));
});

test('slugs and photo names', () => {
  assert.equal(slugify('Frisse duik in zomerweer'), 'frisse-duik-in-zomerweer');
  assert.equal(slugify('Één — Été!'), 'een-ete');
  assert.equal(uniqueSlug('2024', []), 'work-2024');
  assert.equal(uniqueSlug('a', ['a', 'a-2']), 'a-3');
  assert.equal(nextImageName(['01.jpg', '03.jpg', 'x.png'], 'jpg'), '04.jpg');
  assert.equal(nextImageName([], 'png'), '01.png');
});

// ---- the crop centre (focalPoint) and the commit summary

const save = (s, slug, edit) => {
  const data = editableView(JSON.parse(s.works[slug].text));
  edit(data);
  return planSave(s, { works: [{ slug, baseSha: s.works[slug].sha, data }] }, user);
};
const written = (plan, slug) => JSON.parse(plan.entries.find((e) => e.path === `src/content/artworks/${slug}.json`).content);

/** The snapshot with every focalPoint of one work removed, as a work saved before crops existed. */
function withoutFocal(slug) {
  const s = structuredClone(snap);
  const d = JSON.parse(s.works[slug].text);
  for (const g of d.gallery) delete g.focalPoint;
  s.works[slug] = { sha: 'nofocal', text: serializeWork(d) };
  return s;
}

test('a moved crop is written as {x, y} on that photo only, in place', () => {
  const plan = save(snap, 'avondwind', (d) => { d.gallery[0].focalPoint = { x: 0.2731, y: 0.5 }; });
  const before = JSON.parse(snap.works.avondwind.text);
  const out = written(plan, 'avondwind');
  assert.deepEqual(out.gallery[0], { ...before.gallery[0], focalPoint: { x: 0.2731, y: 0.5 } });
  assert.deepEqual(Object.keys(out.gallery[0]), Object.keys(before.gallery[0]));
  assert.deepEqual(out.gallery.slice(1), before.gallery.slice(1));
  assert.equal(plan.entries.length, 1);
  assert.match(plan.message, /- "Avondwind": Changed: crop of cover\n/);
});

test('sending the stored crop back unchanged is a no-op, also for the float values Sveltia wrote', () => {
  for (const slug of slugs) {
    const plan = save(snap, slug, (d) => {
      const stored = JSON.parse(snap.works[slug].text).gallery;
      d.gallery.forEach((g, i) => { if (stored[i].focalPoint) g.focalPoint = { ...stored[i].focalPoint }; });
    });
    assert.equal(plan.noop, true, slug);
  }
});

test('a centred crop is left out of a photo that had none; an off-centre one is added', () => {
  const s = withoutFocal('avondwind');
  const plan = planSave(s, { works: [{ slug: 'avondwind', baseSha: 'nofocal', data: { ...editableView(JSON.parse(s.works.avondwind.text)), gallery: JSON.parse(s.works.avondwind.text).gallery.map((g) => ({ ...g, focalPoint: { x: 0.5, y: 0.5 } })) } }] }, user);
  assert.equal(plan.noop, true, 'reset to centre on a photo without a crop changes nothing');

  const d = editableView(JSON.parse(s.works.avondwind.text));
  d.gallery[0].focalPoint = { x: 0.8, y: 0.5 };
  const out = written(planSave(s, { works: [{ slug: 'avondwind', baseSha: 'nofocal', data: d }] }, user), 'avondwind');
  assert.deepEqual(Object.keys(out.gallery[0]), ['src', 'alt', 'focalPoint']);
  assert.deepEqual(out.gallery[0].focalPoint, { x: 0.8, y: 0.5 });
  assert.ok(!('focalPoint' in out.gallery[1]));
});

test('reset to centre on a photo that had a crop writes the centre; null removes it', () => {
  const orig = JSON.parse(snap.works.avondwind.text);
  const i = orig.gallery.findIndex((g) => g.focalPoint && (g.focalPoint.x !== 0.5 || g.focalPoint.y !== 0.5));
  const slug = i >= 0 ? 'avondwind' : slugs.find((s) => JSON.parse(snap.works[s].text).gallery.some((g) => g.focalPoint?.x !== 0.5));
  const src = JSON.parse(snap.works[slug].text);
  const k = src.gallery.findIndex((g) => g.focalPoint && (g.focalPoint.x !== 0.5 || g.focalPoint.y !== 0.5));
  const out = written(save(snap, slug, (d) => { d.gallery[k].focalPoint = { x: 0.5, y: 0.5 }; }), slug);
  assert.deepEqual(out.gallery[k].focalPoint, { x: 0.5, y: 0.5 });
  const gone = written(save(snap, slug, (d) => { d.gallery[k].focalPoint = null; }), slug);
  assert.ok(!('focalPoint' in gone.gallery[k]));
});

test('a new photo keeps an off-centre crop, and a malformed crop is refused', () => {
  const slug = 'avondwind';
  const data = editableView(JSON.parse(snap.works[slug].text));
  data.gallery.unshift({ src: 'new:5', alt: '', focalPoint: { x: 0.1, y: 0.5 } });
  data.gallery.push({ src: 'new:6', alt: '', focalPoint: { x: 0.5, y: 0.5 } });
  const newImages = { 5: { sha: 'c'.repeat(40), ext: 'jpg' }, 6: { sha: 'd'.repeat(40), ext: 'jpg' } };
  const plan = planSave(snap, { works: [{ slug, baseSha: snap.works[slug].sha, data, newImages }] }, user);
  const out = written(plan, slug);
  assert.deepEqual(out.gallery[0], { src: '/src/assets/artworks/avondwind/04.jpg', alt: '', focalPoint: { x: 0.1, y: 0.5 } });
  assert.deepEqual(out.gallery.at(-1), { src: '/src/assets/artworks/avondwind/05.jpg', alt: '' });
  assert.match(plan.message, /- "Avondwind": Changed: cover photo; added 2 photos\n/);
  for (const fp of [{ x: 2, y: 0.5 }, { x: '0.5', y: 0.5 }, { x: 0.5 }, 'centre', 7]) {
    const bad = editableView(JSON.parse(snap.works[slug].text));
    bad.gallery[0].focalPoint = fp;
    assert.throws(() => planSave(snap, { works: [{ slug, baseSha: snap.works[slug].sha, data: bad }] }, user), SaveError, JSON.stringify(fp));
  }
});

test('the commit message says what changed', () => {
  const slug = 'avondwind';
  const msg = (edit) => save(snap, slug, edit).message;
  const withPhotos = save(snap, slug, (d) => { d.title = 'Avondwind II'; d.gallery[0].focalPoint = { x: 0.3, y: 0.5 }; });
  assert.match(withPhotos.message, /^Update "Avondwind II"\n\nSaved by Test Person in admin\.arnenys\.com\.\n\n- "Avondwind II": Changed: title, crop of cover\n$/);
  assert.match(msg((d) => { d.year = 2001; d.dimensions = '1 × 1 cm'; d.medium = 'Oil'; d.status = 'Sold'; d.description = 'x'; }),
    /: Changed: year, size, material, sold status, description\n/);
  assert.match(msg((d) => { d.gallery = [d.gallery[0], d.gallery[2], d.gallery[1]]; }), /: Changed: photo order\n/);
  assert.match(msg((d) => { d.gallery = [d.gallery[1], d.gallery[0], d.gallery[2]]; }), /: Changed: cover photo\n/);
  assert.match(msg((d) => { d.gallery[1].alt = 'a'; d.gallery[2].alt = 'b'; }), /: Changed: 2 photo descriptions\n/);
  assert.match(msg((d) => { d.gallery[2].focalPoint = { x: 0.1, y: 0.1 }; }), /: Changed: crop of 1 other photo\n/);
  assert.match(msg((d) => { d.gallery.pop(); }), /: removed 1 photo\n/);
  assert.match(msg((d) => { d.order = 99; d.title = 'X'; }), /: Changed: title, position\n/);
  // New works and plain moves keep their short lines.
  const add = planSave(snap, { works: [{ slug: null, baseSha: null, data: { title: 'Nieuw', gallery: [{ src: 'new:1', alt: '' }] }, newImages: { 1: { sha: 'c'.repeat(40), ext: 'jpg' } } }] }, user);
  assert.match(add.message, /\n- added "Nieuw" \(1 photo\)\n$/);
  const move = planSave(snap, { works: [{ slug, baseSha: snap.works[slug].sha, data: { order: 1234 } }] }, user);
  assert.match(move.message, /^Reorder works\n[\s\S]*\n- moved "Avondwind"\n$/);
});
