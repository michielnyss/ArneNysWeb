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
