// The archive's write side: Sheet row writes, new works, the upload-target
// check and photo naming, publish planning, and Publish / unpublish end to end against the
// stand-in Google (mock-google.mjs, changed in memory) and a stand-in GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { COLUMN, HEADERS, parseCell, readTable, rowChanges, toCell } from '../shared/archive.js';
import { currentSrc, dimensionsText, planGallery, publicDefaults, publishedPairs, webPhotoState } from '../shared/publish.js';
import { cleanNewWork, planNewWork, websiteStatus } from '../src/archive.js';
import { cleanChanges } from '../src/archive-routes.js';
import { columnLetter, planHeaders, planRowWrite } from '../src/sheet.js';
import { signFolder } from '../src/thumb.js';
import worker from '../src/worker.js';
import { graphqlSnapshot, localSnapshot } from './helpers.mjs';
import { FOLDER, MOCK_SA_KEY, mockArchive, mockGoogle, mockUpload, ROOT_ID, SHEET_ID } from './mock-google.mjs';

// ------------------------------------------------------------ cells and rows

test('cells are written RAW by column type and read back the same', () => {
  assert.equal(toCell('bool', true), 'yes');
  assert.equal(toCell('bool', false), 'no');
  assert.equal(toCell('ids', ['a', 'b']), 'a, b');
  assert.equal(toCell('pairs', [{ id: 'a', file: '01.jpg' }]), 'a=01.jpg');
  assert.equal(toCell('number', 2400), 2400);
  assert.equal(toCell('text', '=HYPERLINK("x")'), '=HYPERLINK("x")', 'stays text (RAW)');
  assert.equal(toCell('text', null), '');
  for (const [type, v] of [['ids', ['a', 'b']], ['pairs', [{ id: 'a', file: '01.jpg' }, { id: 'b', file: '02.png' }]], ['bool', true], ['number', 3.5]])
    assert.deepEqual(parseCell(type, toCell(type, v)), v, type);
  assert.equal(parseCell('ids', []), null, 'an empty list is empty');
});

test('rowChanges: only what really changed, typed, with the old values', () => {
  const row = { workingTitle: 'Werk', price: 400, sold: null, websitePhotos: ['a'] };
  assert.deepEqual(rowChanges(row, { workingTitle: ' Werk ', price: '400', sold: '', websitePhotos: ['a'] }), { changes: {}, base: {} });
  assert.deepEqual(rowChanges(row, { price: '450,5', sold: 'yes', websitePhotos: ['b', 'a'] }), {
    changes: { price: 450.5, sold: true, websitePhotos: ['b', 'a'] },
    base: { price: 400, sold: null, websitePhotos: ['a'] },
  });
  assert.deepEqual(rowChanges(null, { notes: 'x' }), { changes: { notes: 'x' }, base: { notes: null } });
});

test('column letters', () => {
  assert.deepEqual([0, 25, 26, 27, 51, 52, 701, 702].map(columnLetter), ['A', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
});

const sheetOf = (values, tab = 'Archief') => ({ tab, ...readTable(values) });
const VALUES = [
  ['Working title', 'Drive folder ID', 'Mine', 'Price', 'Sold'],
  ['Werk A', 'fa', 'keep me', 400, ''],
  [],
  ['Werk B', 'fb', '', '', 'yes'],
];

test('a row write touches only the changed cells of that row', () => {
  const plan = planRowWrite(sheetOf(VALUES), 'fb', { price: 900, sold: false }, { price: null, sold: true });
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.rowNumber, 4);
  assert.deepEqual(plan.updates, [
    { range: "'Archief'!D4", values: [[900]] },
    { range: "'Archief'!E4", values: [['no']] },
  ]);
  assert.equal(plan.append, null);
  assert.equal(plan.row.workingTitle, 'Werk B');
  assert.equal(plan.row.price, 900);
});

test('a row write refuses when someone changed that cell meanwhile', () => {
  const plan = planRowWrite(sheetOf(VALUES), 'fa', { price: 500 }, { price: 300 });
  assert.deepEqual(plan.conflicts, ['price']);
  assert.deepEqual(planRowWrite(sheetOf(VALUES), 'fa', { price: 500 }).conflicts, [], 'no base: no check (Publish)');
});

test('no row yet: one is appended; missing columns get a header first', () => {
  const plan = planRowWrite(sheetOf(VALUES, "Arne's"), 'fnew', { workingTitle: 'Nieuw', websitePhotos: ['p1', 'p2'] });
  assert.equal(plan.rowNumber, null);
  assert.deepEqual(plan.updates, [{ range: "'Arne''s'!F1", values: [['Website photos']] }]);
  assert.deepEqual(plan.append, ['Nieuw', 'fnew', '', '', '', 'p1, p2']);
  assert.equal(plan.row.folderId, 'fnew');
  assert.equal(plan.row.notes, null, 'the row has every column');
});

test('headers: an empty Sheet gets them all from A1; an existing one only the missing, after its last', () => {
  assert.deepEqual(planHeaders(sheetOf([], 'Blad1')), { range: "'Blad1'!A1:Z1", values: [HEADERS] });
  const plan = planHeaders(sheetOf(VALUES));
  assert.equal(plan.range, "'Archief'!F1:AA1");
  assert.deepEqual(plan.values[0], HEADERS.filter((h) => !['Working title', 'Drive folder ID', 'Price', 'Sold'].includes(h)));
  assert.equal(planHeaders(sheetOf([HEADERS])), null);
});

test('the work card may only write the archive columns, not the publish ones', () => {
  assert.deepEqual(cleanChanges({ price: '12', onWebsite: 'yes', websitePhotos: 'a, b' }), { price: 12, onWebsite: true, websitePhotos: ['a', 'b'] });
  for (const k of ['websiteSlug', 'lastPublished', 'publishedPhotos', 'folderId', 'nonsense'])
    assert.throws(() => cleanChanges({ [k]: 'x' }), /cannot be changed/, k);
});

// ------------------------------------------------------------ new works

const dir = (id, name, parent) => ({ id, name, mimeType: FOLDER, parents: [parent] });

test('new work: the deepest existing folder, and what to create below it', () => {
  const files = [dir('y24', '2024', 'R'), dir('t', 'Schilderij', 'y24'), dir('w', 'Werk A', 't'), dir('o', '2024', 'OTHER')];
  files.push(dir('w2', '2024 - Werk C', 't'));
  assert.deepEqual(planNewWork(files, 'R', { year: 2024, type: 'Schilderij', title: 'Werk B' }), { parentId: 't', create: ['2024 - Werk B'] });
  assert.deepEqual(planNewWork(files, 'R', { year: 2024, type: 'Beeld', title: 'X' }), { parentId: 'y24', create: ['Beeld', '2024 - X'] });
  assert.deepEqual(planNewWork(files, 'R', { year: 2026, type: null, title: 'X?' }), { parentId: 'R', create: ['2026', '2026 - X'] });
  assert.deepEqual(planNewWork(files, 'R', { year: 2024, type: 'Schilderij', title: 'Werk C' }), { exists: 'w2' });
  assert.deepEqual(planNewWork(files, 'R', { year: 2024, type: 'Schilderij', title: 'Werk A' }), { exists: 'w' }, 'an older folder named just the title');
  assert.deepEqual(planNewWork(files, 'OTHER', { year: 2024, type: null, title: 'X' }), { parentId: 'o', create: ['2024 - X'] }, 'only under the given root');
});

test('new work: year, type and title are checked', () => {
  assert.deepEqual(cleanNewWork({ year: '2025', type: '  ', title: ' Zand ' }), { year: 2025, type: null, title: 'Zand' });
  assert.match(cleanNewWork({ year: '25', title: 'x' }).problem, /year/);
  assert.match(cleanNewWork({ year: 2025, title: ' ' }).problem, /working title/);
  assert.match(cleanNewWork({ year: 2025, title: '???' }).problem, /working title/, 'nothing left for a folder name');
  assert.match(cleanNewWork({ year: 2025, type: '2024', title: 'x' }).problem, /type/);
  assert.match(cleanNewWork({ year: 2025, title: 'x'.repeat(121) }).problem, /too long/);
});

// ------------------------------------------------------------ publish planning

const site = {
  title: 'Afvoerdruk', gallery: [
    { src: '/src/assets/artworks/afvoerdruk/01.jpg', alt: 'Front', focalPoint: { x: 0.3, y: 0.5 } },
    { src: '/src/assets/artworks/afvoerdruk/02.jpg', alt: 'Side' },
  ],
};
const work = {
  name: 'buis 3', year: 2026,
  photos: [{ id: 'p1', modified: '2026-11-01T00:00:00Z' }, { id: 'p2', modified: '2026-11-10T00:00:00Z' }, { id: 'p3', modified: '2026-11-01T00:00:00Z' }],
  row: {
    websitePhotos: ['p1', 'p2'], lastPublished: '2026-11-05T00:00:00Z',
    publishedPhotos: [{ id: 'p1', file: '01.jpg' }, { id: 'p2', file: '02.jpg' }],
  },
  website: { slug: 'afvoerdruk', live: true, data: site },
};

test('a starred photo keeps its repo file unless it changed in Drive since the last publish', () => {
  assert.equal(currentSrc(work, 'p1'), '/src/assets/artworks/afvoerdruk/01.jpg');
  assert.equal(currentSrc(work, 'p2'), null, 'changed after the last publish');
  assert.equal(currentSrc(work, 'p3'), null, 'never published');
  assert.equal(currentSrc({ ...work, website: { slug: 'afvoerdruk', data: { gallery: [] } } }, 'p1'), null, 'removed on the site meanwhile');
  assert.deepEqual(webPhotoState(work, 'p1'), { src: site.gallery[0].src, alt: 'Front', focal: { x: 0.3, y: 0.5 }, focalTouched: false });
  assert.deepEqual(webPhotoState(work, 'p2'), { src: null, alt: 'Side', focal: undefined, focalTouched: false }, 'a changed photo keeps its text');
});

test('planGallery: kept photos by src, the rest uploaded; crops only when changed or carried over', () => {
  const state = {
    p1: { alt: ' Front ', focal: { x: 0.3, y: 0.5 }, focalTouched: false },
    p2: { alt: 'Side', focal: { x: 0.6, y: 0.5 }, focalTouched: false },
    p3: { alt: '', focal: { x: 0.2, y: 0.5 }, focalTouched: true },
  };
  const { gallery, uploads } = planGallery(work, ['p3', 'p1', 'p2'], state);
  assert.deepEqual(uploads, ['p3', 'p2']);
  assert.deepEqual(gallery, [
    { src: 'new:p3', alt: '', focalPoint: { x: 0.2, y: 0.5 } },
    { src: '/src/assets/artworks/afvoerdruk/01.jpg', alt: 'Front' },
    { src: 'new:p2', alt: 'Side', focalPoint: { x: 0.6, y: 0.5 } },
  ]);
  assert.deepEqual(publishedPairs(['p3', 'p1'], ['/src/assets/artworks/x/03.jpg', '/src/assets/artworks/x/01.jpg']),
    [{ id: 'p3', file: '03.jpg' }, { id: 'p1', file: '01.jpg' }]);
  assert.throws(() => publishedPairs(['a'], []));
});

test('a new work starts from plain Sheet facts, never private ones', () => {
  assert.equal(dimensionsText({ width: 120, height: 90, unit: 'cm' }), '120 × 90 cm');
  assert.equal(dimensionsText({ width: 120, height: 90, depth: 35 }), '120 × 90 × 35');
  assert.equal(dimensionsText({ width: 120, dimensions: 'variable' }), 'variable');
  const d = publicDefaults({ name: 'Werk', year: 2024, row: { workingTitle: 'Avond', materials: 'Oil', price: 900, sold: true, notes: 'private', year: 'ca. 2020' } });
  assert.deepEqual(d, { title: 'Avond', year: 2024, description: '', medium: 'Oil', dimensions: '', status: '' });
});

test('changed since publish, now that Publish records its photos', () => {
  const ws = (row, photos = work.photos, s = { afvoerdruk: site }) => websiteStatus({ onWebsite: true, websiteSlug: 'afvoerdruk', ...row }, photos, s);
  const base = { websitePhotos: ['p1', 'p3'], lastPublished: '2026-11-20T00:00:00Z', publishedPhotos: [{ id: 'p1', file: '01.jpg' }, { id: 'p3', file: '02.jpg' }] };
  assert.deepEqual(ws(base).reasons, []);
  assert.deepEqual(ws({ ...base, websitePhotos: ['p3', 'p1'] }).reasons, ['Website photos chosen differently since the last publish']);
  assert.deepEqual(ws(base, work.photos, { afvoerdruk: { gallery: [site.gallery[1]] } }).reasons, ['Photos were changed on the website directly']);
  assert.deepEqual(ws({ ...base, lastPublished: '2026-10-01T00:00:00Z' }).reasons, ['A website photo changed after the last publish']);
});

// ------------------------------------------------------------ the endpoints

const archive = mockArchive();
const snap = localSnapshot();
const calls = [];
let commits = 0;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  calls.push({ url, method: init.method || 'GET', body: typeof init.body === 'string' ? init.body : null });
  const google = await mockGoogle(input, init, archive);
  if (google) return google;
  const ok = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/installation')) return ok({ id: 1 });
  if (url.includes('/access_tokens')) return ok({ token: 'gh', expires_at: new Date(Date.now() + 3600e3).toISOString() }, 201);
  if (url.endsWith('/graphql')) return ok(graphqlSnapshot(snap));
  if (url.endsWith('/git/trees')) return ok({ sha: '1'.repeat(40) }, 201);
  if (url.endsWith('/git/commits')) { commits++; return ok({ sha: '2'.repeat(40) }, 201); }
  if (url.endsWith('/git/refs/heads/main')) return ok({});
  return new Response('unexpected ' + url, { status: 599 });
};

const { privateKey } = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign']);
const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', privateKey)).toString('base64')}\n-----END PRIVATE KEY-----`;
const env = (over = {}) => ({
  DEV_USER_EMAIL: 'dev@example.com', GITHUB_REPO: 'michielnyss/ArneNysWeb', GITHUB_BRANCH: 'main', GH_APP_ID: '1', GH_APP_PRIVATE_KEY: pem,
  GOOGLE_SA_KEY: MOCK_SA_KEY, ARCHIVE_FOLDER_ID: ROOT_ID, ARCHIVE_SHEET_ID: SHEET_ID, DRY_RUN: 'false', ...over,
});
const call = (path, body, e = env()) => worker.fetch(new Request(`http://localhost:8787${path}`, body === undefined ? {} : {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}), e);
const list = async () => (await call('/api/archive')).json();
const byName = async (name) => (await list()).works.find((w) => w.name === name);
const writes = () => calls.filter((c) => c.method !== 'GET' && !/oauth2|graphql/.test(c.url)); // GraphQL is a read

test('POST /api/archive/row writes the changed cells; a stale base is a 409', async () => {
  const w = await byName('Studie rood');
  const res = await call('/api/archive/row', { folderId: w.folderId, sig: w.sig, changes: { price: '480', notes: 'Kader nodig' }, base: { price: 450, notes: null } });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.row.price, 480);
  assert.equal((await byName('Studie rood')).row.notes, 'Kader nodig');
  const stale = await call('/api/archive/row', { folderId: w.folderId, sig: w.sig, changes: { price: 500 }, base: { price: 450 } });
  assert.equal(stale.status, 409);
  assert.equal((await byName('Studie rood')).row.price, 480, 'not overwritten');
});

test('a folder without a row gets one; renaming renames the Drive folder', async () => {
  const w = await byName('zand');
  assert.equal(w.row, null);
  const out = await (await call('/api/archive/row', { folderId: w.folderId, sig: w.sig, changes: { workingTitle: 'Zandstorm' }, base: {}, rename: 'Zandstorm' })).json();
  assert.equal(out.name, 'Zandstorm');
  const after = await byName('Zandstorm');
  assert.equal(after.row.workingTitle, 'Zandstorm');
  assert.equal(after.row.folderId, w.folderId);
  assert.ok(!(await list()).works.some((x) => x.name === 'zand'));
});

test('writes need the folder signature from the listing; nothing is ever deleted', async () => {
  const w = await byName('Avondwind');
  const otherSig = (await byName('Studie rood')).sig;
  for (const body of [
    { folderId: w.folderId, changes: { notes: 'x' } },
    { folderId: w.folderId, sig: otherSig, changes: { notes: 'x' } },
    { folderId: 'mockOtherFolder01', sig: await signFolder('not the key', 'mockOtherFolder01'), changes: { notes: 'x' } },
  ]) assert.equal((await call('/api/archive/row', body)).status, 403);
  assert.equal((await call('/api/archive/row', { folderId: w.folderId, sig: w.sig, changes: { websiteSlug: 'x' } })).status, 400);
  assert.equal((await call('/api/archive/row', { folderId: w.folderId, sig: w.sig, changes: { notes: 'x' } }, env({ ARCHIVE_READ_ONLY: 'true' }))).status, 403);
  assert.ok(!calls.some((c) => c.method === 'DELETE'));
});

test('the upload target must be a folder inside the archive, checked live', async () => {
  const w = await byName('Avondwind');
  assert.equal((await call('/api/archive/upload-target', { folderId: w.folderId, sig: w.sig })).status, 200);
  assert.equal((await call('/api/archive/upload-target', { folderId: w.folderId })).status, 403, 'unsigned');
  // Signed with the real key, but outside the archive (a folder the robot can also see).
  const outside = await signFolder(MOCK_SA_KEY, 'mockOtherFolder01');
  const res = await call('/api/archive/upload-target', { folderId: 'mockOtherFolder01', sig: outside });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /no longer in the archive/);
});

test('upload-target names the photos to upload: next free numbers, in the order given', async () => {
  const w = await byName('Homarium');
  const files = [{ name: 'IMG_9.JPEG', type: 'image/jpeg' }, { name: 'scan', type: 'image/png' }];
  const out = await (await call('/api/archive/upload-target', { folderId: w.folderId, sig: w.sig, files })).json();
  assert.deepEqual(out.names, ['Homarium - 01.jpg', 'Homarium - 02.png']);
});

test('names: settle moves a clashing upload up; tidy renames the rest by capture time; never deletes', async () => {
  const w = await byName('Homarium');
  const up = (name, original, time) => {
    const f = mockUpload(archive, { folderId: w.folderId, name, type: 'image/jpeg', bytes: Buffer.from('x'), description: `Original name: ${original}` });
    if (time) archive.files.find((x) => x.id === f.id).imageMediaMetadata = { time };
    return f.id;
  };
  const a = up('Homarium - 01.jpg', 'a.jpg');
  const b = up('Homarium - 01.jpg', 'b.jpg'); // a second upload got the same number
  const settle = await (await call('/api/archive/names', { folderId: w.folderId, sig: w.sig, mode: 'settle', ids: [b] })).json();
  assert.deepEqual(settle.renamed.map((r) => [r.id, r.name]), [[b, 'Homarium - 02.jpg']]);
  assert.equal(archive.files.find((f) => f.id === b).description, 'Original name: b.jpg', 'the original name stays');
  assert.equal(archive.files.find((f) => f.id === a).name, 'Homarium - 01.jpg');

  const untidy = archive.files.filter((f) => f.parents?.includes(w.folderId) && f.mimeType.startsWith('image/') && !f.name.startsWith('Homarium'));
  untidy[0].imageMediaMetadata = { ...untidy[0].imageMediaMetadata, time: '2025:01:02 10:00:00' };
  untidy[1].imageMediaMetadata = { ...untidy[1].imageMediaMetadata, time: '2025:01:01 10:00:00' };
  const before = untidy.map((f) => f.name);
  const tidy = await (await call('/api/archive/names', { folderId: w.folderId, sig: w.sig, mode: 'tidy' })).json();
  assert.equal(tidy.left, 0);
  assert.equal(tidy.renamed.length, untidy.length);
  assert.deepEqual(tidy.renamed.slice(0, 2).map((r) => r.id), [untidy[1].id, untidy[0].id], 'by capture time');
  assert.equal(untidy[1].name, 'Homarium - 03.jpg');
  assert.equal(untidy[1].description, `Original name: ${before[1]}`);
  assert.equal((await call('/api/archive/names', { folderId: w.folderId, sig: w.sig, mode: 'nope' })).status, 400);
  assert.equal((await call('/api/archive/names', { folderId: w.folderId, mode: 'tidy' })).status, 403, 'unsigned');
  assert.ok(!calls.some((c) => c.method === 'DELETE'));
});

test('renaming a work: the folder, then its photos named after the old title (others left alone)', async () => {
  const w = await byName('Homarium');
  const other = mockUpload(archive, { folderId: w.folderId, name: 'detail.jpg', type: 'image/jpeg', bytes: Buffer.from('x') });
  await call('/api/archive/row', { folderId: w.folderId, sig: w.sig, changes: { workingTitle: 'Homarium twee' }, base: { workingTitle: 'Homarium' }, rename: '2024 - Homarium twee' });
  const out = await (await call('/api/archive/names', { folderId: w.folderId, sig: w.sig, mode: 'retitle', from: 'Homarium' })).json();
  assert.equal(out.title, 'Homarium twee');
  assert.ok(out.renamed.length >= 3);
  assert.ok(out.renamed.every((r) => r.name.startsWith('Homarium twee - ')));
  const names = archive.files.filter((f) => f.parents?.includes(w.folderId) && f.mimeType.startsWith('image/')).map((f) => f.name);
  assert.ok(!names.some((n) => n.startsWith('Homarium - ')));
  assert.ok(names.includes('Homarium twee - 01.jpg'));
  assert.equal(archive.files.find((f) => f.id === other.id).name, 'detail.jpg');
});

test('POST /api/archive/new makes the missing folders and the row', async () => {
  const before = archive.files.length;
  const res = await call('/api/archive/new', { year: 2027, type: 'Beeld', title: 'Nieuw beeld' });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(archive.files.length, before + 3, 'year, type and work folders');
  const w = (await list()).works.find((x) => x.folderId === out.folderId);
  assert.deepEqual([w.path, w.photos, w.row.workingTitle, w.row.year], [['2027', 'Beeld', '2027 - Nieuw beeld'], [], 'Nieuw beeld', 2027]);
  assert.equal(w.sig, out.sig);
  assert.ok((await list()).places.some((p) => p.year === 2027 && p.type === 'Beeld'));
  const again = await call('/api/archive/new', { year: 2027, type: 'Beeld', title: 'Nieuw beeld' });
  assert.equal(again.status, 409);
  assert.equal(archive.files.length, before + 3);
  assert.equal((await call('/api/archive/new', { year: 2027, title: '' })).status, 400);
});

test('originals come through the Worker for Publish, like thumbnails', async () => {
  const w = await byName('Avondwind');
  const res = await call(w.photos[0].thumb.replace('/thumb/', '/original/'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.ok((await res.arrayBuffer()).byteLength > 1000);
});

test('Publish in test mode says what it would commit and leaves the Sheet alone', async () => {
  const w = await byName('Studie rood');
  await call('/api/archive/row', { folderId: w.folderId, sig: w.sig, changes: { onWebsite: true }, base: {} });
  const ids = [w.photos[1].id, w.photos[0].id];
  const before = writes().length;
  const res = await call('/api/archive/publish', {
    folderId: w.folderId, sig: w.sig, photos: ids,
    work: {
      baseSha: null,
      data: { title: 'Studie rood', year: 2024, description: '', medium: 'Oil on paper', dimensions: '', status: '', gallery: ids.map((id) => ({ src: `new:${id}`, alt: '' })) },
      newImages: Object.fromEntries(ids.map((id) => [id, { sha: 'a'.repeat(40), ext: 'jpg' }])),
    },
  }, env({ DRY_RUN: 'true' }));
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.dryRun, true);
  assert.equal(out.slug, 'studie-rood');
  assert.deepEqual(out.files.map((f) => f.path), [
    'src/assets/artworks/studie-rood/01.jpg', 'src/assets/artworks/studie-rood/02.jpg', 'src/content/artworks/studie-rood.json']);
  assert.deepEqual(out.sheet.publishedPhotos, [{ id: ids[0], file: '01.jpg' }, { id: ids[1], file: '02.jpg' }]);
  assert.deepEqual(writes().slice(before).map((c) => c.url), [], 'no Sheet write, no commit');
});

test('Publish commits, then records slug, photos and time in the Sheet; the work is then "on"', async () => {
  const w = await byName('Studie rood');
  const ids = [w.photos[0].id];
  const body = (over = {}) => ({
    folderId: w.folderId, sig: w.sig, photos: ids,
    work: { baseSha: null, data: { title: 'Studie rood', year: 2024, gallery: [{ src: `new:${ids[0]}`, alt: 'Detail' }] }, newImages: { [ids[0]]: { sha: 'b'.repeat(40), ext: 'jpg' } } },
    ...over,
  });
  assert.equal((await call('/api/archive/publish', body({ photos: [] }))).status, 400, 'no photo starred');
  assert.equal((await call('/api/archive/publish', body({ photos: ['mockImg_avondwind_01_jpg'] }))).status, 409, 'a photo from another folder');
  const n = commits;
  const out = await (await call('/api/archive/publish', body())).json();
  assert.equal(commits, n + 1);
  assert.equal(out.row.websiteSlug, 'studie-rood');
  assert.equal(out.row.onWebsite, true);
  assert.deepEqual(out.row.publishedPhotos, [{ id: ids[0], file: '01.jpg' }]);
  assert.ok(Date.parse(out.row.lastPublished) > Date.now() - 60_000);
  const tree = JSON.parse(calls.filter((c) => c.url.endsWith('/git/trees')).at(-1).body);
  const json = JSON.parse(tree.tree.find((e) => e.path === 'src/content/artworks/studie-rood.json').content);
  assert.deepEqual(json.gallery, [{ src: '/src/assets/artworks/studie-rood/01.jpg', alt: 'Detail' }], 'gallery src absolute from the repo root');
  assert.equal(json.order, -1);
});

test('the slug comes from the Sheet: an existing work is updated, legacySlug kept', async () => {
  const w = await byName('Avondwind');
  const data = JSON.parse(snap.works.avondwind.text);
  const ids = w.photos.map((p) => p.id);
  const out = await (await call('/api/archive/publish', {
    folderId: w.folderId, sig: w.sig, photos: ids,
    work: { slug: 'tijdstroom', baseSha: snap.works.avondwind.sha, data: { ...data, title: 'Avondwind II', gallery: data.gallery.map((g) => ({ src: g.src, alt: g.alt })) }, newImages: {} },
  }, env({ DRY_RUN: 'true' }))).json();
  assert.equal(out.slug, 'avondwind', 'never the slug the browser sends');
  assert.deepEqual(out.files, [{ path: 'src/content/artworks/avondwind.json', action: 'write' }]);
  const stale = await call('/api/archive/publish', {
    folderId: w.folderId, sig: w.sig, photos: ids, work: { baseSha: 'f'.repeat(40), data: { ...data, gallery: data.gallery }, newImages: {} },
  }, env({ DRY_RUN: 'true' }));
  assert.equal(stale.status, 409, 'changed on the site meanwhile');
});

test('unpublish removes the work from the site like Delete, and the Sheet says off', async () => {
  const w = await byName('Blauwe echo');
  const out = await (await call('/api/archive/publish', { folderId: w.folderId, sig: w.sig, off: true, work: { baseSha: snap.works['blue-echo'].sha } })).json();
  assert.ok(out.files.some((f) => f.path === 'src/content/artworks/blue-echo.json' && f.action === 'delete'));
  assert.ok(out.files.some((f) => f.path.startsWith('src/assets/artworks/blue-echo/') && f.action === 'delete'), 'its photos too');
  assert.equal(out.row.onWebsite, false);
  assert.equal(out.row.publishedPhotos, null);
  const studie = await byName('Avondwind');
  await call('/api/archive/row', { folderId: studie.folderId, sig: studie.sig, changes: { onWebsite: false }, base: {} });
  const notLive = await byName('2027 - Nieuw beeld');
  assert.equal((await call('/api/archive/publish', { folderId: notLive.folderId, sig: notLive.sig, off: true, work: {} })).status, 400);
});

// ------------------------------------------------------------ the card's helpers

test('work card helpers: the main button, stars and the folder rename offer', async () => {
  globalThis.window ||= { addEventListener() {} };
  const { publishAction, toggleStar, folderRename, untidyPhotos } = await import('../ui/work.js');
  assert.deepEqual(publishAction(true, false), { id: 'publish', label: 'Publish to website' });
  assert.deepEqual(publishAction(true, true), { id: 'publish', label: 'Publish changes' });
  assert.deepEqual(publishAction(false, true), { id: 'unpublish', label: 'Remove from website' });
  assert.equal(publishAction(false, false), null);
  assert.deepEqual(toggleStar(['a', 'b'], 'c'), ['a', 'b', 'c']);
  assert.deepEqual(toggleStar(['a', 'b', 'c'], 'b'), ['a', 'c']);
  assert.equal(folderRename('2026 - buis 3', 'buis 3', 'Buis drie', 2026), '2026 - Buis drie');
  assert.equal(folderRename('buis 3', 'buis 3', 'Buis: drie', 2026), '2026 - Buis drie', 'an older folder gets the scheme');
  assert.equal(folderRename('IMG map', 'buis 3', 'Buis drie', 2026), null, 'a folder named otherwise is left alone');
  assert.equal(folderRename('zand', null, 'Zandstorm', 2024), '2024 - Zandstorm', 'no title yet');
  assert.equal(folderRename('zand', null, ' ', 2024), null);
  assert.equal(folderRename('2024 - Zand', 'Zand', 'Zand?', 2024), null, 'same name once cleaned');
  assert.deepEqual(untidyPhotos({ name: '2024 - T', photos: [{ id: 'a', name: 'T - 01.jpg' }, { id: 'b', name: 'IMG.JPG' }] }).map((r) => r.name), ['T - 02.jpg']);
  assert.ok(COLUMN.publishedPhotos && !COLUMN.publishedPhotos.group, 'Publish columns are not on the card');
});
