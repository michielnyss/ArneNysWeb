// The archive: Sheet column mapping, Drive tree -> works, website state, the
// thumbnail path checks, and GET /api/archive end to end against the
// stand-in Google (mock-google.mjs) and a stand-in GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { COLUMNS, HEADERS, headerKey, parseCell, readTable } from '../shared/archive.js';
import { buildArchive, placeOf, subtree, websiteStatus } from '../src/archive.js';
import { parseThumbPath, signFolder, thumbPath, verifyFolder } from '../src/thumb.js';
import worker from '../src/worker.js';
import { graphqlSnapshot, localSnapshot } from './helpers.mjs';
import { FOLDER, MOCK_SA_KEY, mockArchive, mockGoogle, ROOT_ID, SHEET_ID } from './mock-google.mjs';

// ------------------------------------------------------------ Sheet columns

test('every column has a unique key and a unique header', () => {
  assert.equal(new Set(COLUMNS.map((c) => c.key)).size, COLUMNS.length);
  assert.equal(new Set(HEADERS.map(headerKey)).size, HEADERS.length);
});

test('cells are parsed by column type; empty is null', () => {
  assert.equal(parseCell('text', '  Oil  '), 'Oil');
  assert.equal(parseCell('text', ''), null);
  assert.equal(parseCell('number', 120), 120);
  assert.equal(parseCell('number', '2,5'), 2.5);
  assert.equal(parseCell('number', 'about 40'), 'about 40'); // kept, not lost
  for (const v of ['yes', 'Ja', 'TRUE', 'x', true]) assert.equal(parseCell('bool', v), true, v);
  for (const v of ['no', 'Nee', false, '0']) assert.equal(parseCell('bool', v), false, String(v));
  assert.equal(parseCell('bool', ''), null);
  assert.deepEqual(parseCell('ids', 'a1, b2;c3\nd4'), ['a1', 'b2', 'c3', 'd4']);
});

test('the Sheet is read by header name, whatever the column order', () => {
  const values = [
    ['Website slug', 'Price', 'my own column', 'drive folder id', 'SOLD'],
    ['avondwind', 1200, 'x', 'f1', 'yes'],
    ['', '', '', '', ''],
    [null, 50, '', 'f2'],
  ];
  const t = readTable(values);
  assert.deepEqual(t.extra, ['my own column']);
  assert.ok(t.missing.includes('Working title') && !t.missing.includes('Sold'));
  assert.equal(t.records.length, 2, 'the empty row is skipped');
  assert.deepEqual(
    t.records[0],
    { ...Object.fromEntries(COLUMNS.map((c) => [c.key, null])), rowNumber: 2, websiteSlug: 'avondwind', price: 1200, folderId: 'f1', sold: true },
  );
  assert.equal(t.records[1].rowNumber, 4);
  assert.deepEqual(t.index, { websiteSlug: 0, price: 1, folderId: 3, sold: 4 });
  assert.equal(t.width, 5);
  assert.deepEqual(readTable([]), { records: [], missing: HEADERS, extra: [], index: {}, width: 0 });
});

// ---------------------------------------------------------- tree -> works

const dir = (id, name, parent) => ({ id, name, mimeType: FOLDER, parents: [parent] });
const img = (id, name, parent, extra = {}) => ({ id, name, mimeType: 'image/jpeg', parents: [parent], ...extra });

test('only folders under the root count, and a work is a folder with images', () => {
  const files = [
    dir('y', '2024', 'R'), dir('t', 'Schilderij', 'y'), dir('w', 'Werk A', 't'), dir('empty', 'Leeg', 'y'),
    img('i2', '10.jpg', 'w'), img('i1', '2.jpg', 'w'), { id: 'pdf', name: 'a.pdf', mimeType: 'application/pdf', parents: ['w'] },
    img('loose', 'loose.jpg', 'R'), dir('o', 'Elsewhere', 'X'), img('s', 'secret.jpg', 'o'),
    dir('loop1', 'a', 'loop2'), dir('loop2', 'b', 'loop1'),
  ];
  const { paths, images } = subtree(files, 'R');
  assert.deepEqual([...paths.keys()].sort(), ['empty', 't', 'w', 'y']);
  assert.deepEqual(paths.get('w'), ['2024', 'Schilderij', 'Werk A']);
  assert.deepEqual([...images.keys()], ['w']);
  const { works } = buildArchive({ files, rootId: 'R' });
  assert.equal(works.length, 1);
  assert.deepEqual(works[0].photos.map((p) => p.name), ['2.jpg', '10.jpg'], 'natural name order');
  assert.equal(works[0].year, 2024);
  assert.equal(works[0].type, 'Schilderij');
  assert.equal(works[0].row, null);
  assert.equal(works[0].title, 'Werk A');
  assert.equal(works[0].url, 'https://drive.google.com/drive/folders/w');
});

test('year and type come from the path, when there', () => {
  assert.deepEqual(placeOf(['2024', 'Schilderij', 'Werk']), { year: 2024, type: 'Schilderij' });
  assert.deepEqual(placeOf(['2024', 'Werk']), { year: 2024, type: null });
  assert.deepEqual(placeOf(['Losse werken', 'Werk']), { year: null, type: 'Losse werken' });
  assert.deepEqual(placeOf(['2024']), { year: null, type: null }, 'a year folder holding photos itself');
  assert.deepEqual(placeOf(['2025', 'Beeld', 'Groot', 'Werk']), { year: 2025, type: 'Beeld / Groot' });
});

test('rotated photos report their shown size', () => {
  const files = [dir('w', 'W', 'R'), img('i', 'a.jpg', 'w', { imageMediaMetadata: { width: 4000, height: 3000, rotation: 1 }, size: '123' })];
  const p = buildArchive({ files, rootId: 'R' }).works[0].photos[0];
  assert.deepEqual([p.width, p.height, p.size], [3000, 4000, 123]);
});

test('rows join by folder id; bad rows are reported, not dropped', () => {
  const files = [dir('a', 'A', 'R'), img('ia', '1.jpg', 'a'), dir('b', 'B', 'R'), img('ib', '1.jpg', 'b'), dir('c', 'C', 'R'), dir('d', 'D', 'R')];
  const rec = (rowNumber, folderId, more = {}) => ({ rowNumber, folderId, workingTitle: `row ${rowNumber}`, ...more });
  const { works, orphanRows } = buildArchive({
    files, rootId: 'R',
    records: [rec(2, 'a', { year: 2021 }), rec(3, 'a'), rec(4, 'gone'), rec(5, null), rec(6, 'c')],
  });
  const a = works.find((w) => w.folderId === 'a');
  assert.equal(a.row.rowNumber, 2);
  assert.equal(a.year, 2021, 'the Sheet\'s year wins over the path');
  assert.equal(a.title, 'row 2');
  assert.equal(works.find((w) => w.folderId === 'b').row, null);
  assert.deepEqual(orphanRows.map((r) => [r.rowNumber, r.problem]), [
    [3, 'Same folder as row 2'], [4, 'Folder not found in Drive'], [5, 'No Drive folder ID'],
  ]);
  const c = works.find((w) => w.folderId === 'c');
  assert.deepEqual([c.photos, c.row.rowNumber], [[], 6], 'a new work: a row, no photos yet');
  assert.ok(!works.some((w) => w.folderId === 'd'), 'an empty folder with no row is not a work');
});

test('works are sorted newest year first, no year last', () => {
  const files = [dir('a', 'Zonder jaar', 'R'), img('1', '1.jpg', 'a'), dir('y1', '2020', 'R'), dir('b', 'B', 'y1'), img('2', '1.jpg', 'b'),
    dir('y2', '2025', 'R'), dir('c', 'C', 'y2'), img('3', '1.jpg', 'c')];
  assert.deepEqual(buildArchive({ files, rootId: 'R' }).works.map((w) => w.year), [2025, 2020, null]);
});

// ------------------------------------------------------------ website state

const site = { avondwind: { title: 'Avondwind', gallery: [{}, {}] } };
const photos = [{ id: 'p1', modified: '2026-11-01T00:00:00Z' }, { id: 'p2', modified: '2026-11-01T00:00:00Z' }];
const ws = (row) => websiteStatus(row, photos, site);

test('website state: on, off, and the ways it can be changed', () => {
  assert.equal(ws(null).state, 'off');
  assert.equal(ws({ onWebsite: false }).state, 'off');
  let s = ws({ websiteSlug: 'avondwind' });
  assert.deepEqual([s.state, s.live, s.title], ['on', true, 'Avondwind'], 'a slug with "On website" empty is on');
  assert.equal(ws({ onWebsite: true, websiteSlug: 'avondwind', websitePhotos: ['p1', 'p2'], lastPublished: '2026-11-02T00:00:00Z' }).state, 'on');
  s = ws({ onWebsite: false, websiteSlug: 'avondwind' });
  assert.deepEqual([s.state, s.live, s.reasons], ['changed', true, ['Still on the website']]);
  s = ws({ onWebsite: true });
  assert.deepEqual([s.state, s.live, s.reasons], ['changed', false, ['Not published yet']]);
  assert.match(ws({ onWebsite: true, websiteSlug: 'nope' }).reasons[0], /No work “nope”/);
  assert.deepEqual(ws({ onWebsite: true, websiteSlug: 'avondwind', websitePhotos: ['p1', 'gone'] }).reasons, ['1 website photo is no longer in the folder']);
  assert.deepEqual(ws({ onWebsite: true, websiteSlug: 'avondwind', websitePhotos: ['p1'] }).reasons, ['Different photos on the website']);
  assert.deepEqual(ws({ onWebsite: true, websiteSlug: 'avondwind', websitePhotos: ['p1', 'p2'], lastPublished: '2026-10-01T00:00:00Z' }).reasons,
    ['A website photo changed after the last publish']);
});

test('site works no row links to are listed', () => {
  const out = buildArchive({ files: [], rootId: 'R', site: { a: { title: 'A', year: 2020 }, b: { title: 'B' } }, records: [] });
  assert.deepEqual(out.siteOnly, [{ slug: 'a', title: 'A', year: 2020 }, { slug: 'b', title: 'B', year: null }]);
});

// ------------------------------------------------------------ thumbnail paths

const F = 'folderId_0001';
const P = 'fileId_000001';

test('thumbnail paths: only the exact shape parses', async () => {
  const sig = await signFolder('secret', F);
  assert.equal(sig.length, 43);
  assert.deepEqual(parseThumbPath(thumbPath(F, sig, P)), { kind: 'thumb', folderId: F, sig, fileId: P });
  assert.deepEqual(parseThumbPath(thumbPath(F, sig, P, 'original')), { kind: 'original', folderId: F, sig, fileId: P });
  const bad = [
    `/api/archive/thumb/${F}/${sig}`,
    `/api/archive/thumb/${F}/${sig}/${P}/x`,
    `/api/archive/thumb/${F}/${sig.slice(1)}/${P}`,
    `/api/archive/thumb/${F}/${sig}/..%2F..%2Fx`,
    `/api/archive/thumb/${F}/${sig}/../${P}`,
    `/api/archive/thumb/${F}/${sig}/${P}.jpg`,
    `/api/archive/thumb/${F}/${sig}/short`,
    `/api/archive/thumb/${F}%2F/${sig}/${P}`,
    `/api/archive/thumb//${sig}/${P}`,
    `/api/archive/thumbs/${F}/${sig}/${P}`,
    `/api/archive/full/${F}/${sig}/${P}`,
  ];
  for (const p of bad) assert.equal(parseThumbPath(p), null, p);
});

test('a folder signature only fits that folder and that key', async () => {
  const sig = await signFolder('secret', F);
  assert.equal(await verifyFolder('secret', F, sig), true);
  assert.equal(await verifyFolder('secret', 'folderId_0002', sig), false);
  assert.equal(await verifyFolder('other secret', F, sig), false);
  assert.equal(await verifyFolder('secret', F, 'A'.repeat(43)), false);
});

// ------------------------------------------------------------ the endpoint

const snap = localSnapshot();
const archive = mockArchive();
const calls = [];
globalThis.fetch = async (input, init = {}) => {
  calls.push({ url: String(input), method: init.method || 'GET' });
  const google = await mockGoogle(input, init, archive);
  if (google) return google;
  const url = String(input);
  const ok = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/installation')) return ok({ id: 1 });
  if (url.includes('/access_tokens')) return ok({ token: 'gh', expires_at: new Date(Date.now() + 3600e3).toISOString() }, 201);
  if (url.endsWith('/graphql')) return ok(graphqlSnapshot(snap));
  return new Response('unexpected ' + url, { status: 599 });
};

const { privateKey } = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign']);
const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', privateKey)).toString('base64')}\n-----END PRIVATE KEY-----`;
const env = (over = {}) => ({
  DEV_USER_EMAIL: 'dev@example.com', GITHUB_REPO: 'michielnyss/ArneNysWeb', GITHUB_BRANCH: 'main', GH_APP_ID: '1', GH_APP_PRIVATE_KEY: pem,
  GOOGLE_SA_KEY: MOCK_SA_KEY, ARCHIVE_FOLDER_ID: ROOT_ID, ARCHIVE_SHEET_ID: SHEET_ID, ...over,
});
const get = (path, e = env()) => worker.fetch(new Request(`http://localhost:8787${path}`), e);

test('GET /api/archive joins Drive, the Sheet and the site', async () => {
  calls.length = 0;
  const res = await get('/api/archive');
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes('mock-google-token') && !text.includes('PRIVATE KEY'), 'no token or key in the response');
  const out = JSON.parse(text);
  const google = calls.filter((c) => c.url.includes('googleapis.com'));
  assert.ok(google.length && google.every((c) => c.method === 'GET' || c.url === 'https://oauth2.googleapis.com/token'), 'Google is only read');
  assert.deepEqual(out.sheet.missing, []);
  assert.deepEqual(out.sheet.extra, ['Location']);
  assert.equal(out.sheet.tab, 'Archive');
  assert.equal(out.works.length, 7);
  assert.ok(!JSON.stringify(out).includes('secret.jpg'), 'nothing from outside the archive folder');
  const by = Object.fromEntries(out.works.map((w) => [w.name, w]));
  assert.deepEqual(out.works.map((w) => w.year), [2026, 2025, 2024, 2024, 2024, 2024, 2022]);
  assert.equal(by.Avondwind.website.state, 'on');
  assert.equal(by['buis 3'].website.state, 'changed');
  assert.equal(by['buis 3'].title, 'Afvoerdruk', 'the website title when on the site');
  assert.equal(by['Blauwe echo'].website.state, 'changed');
  assert.equal(by['Blauwe echo'].row.sold, true);
  assert.equal(by['Studie rood'].website.state, 'off');
  assert.equal(by.zand.row, null, 'not in the Sheet yet');
  assert.equal(by.Homarium.website.reasons[0], 'Not published yet');
  assert.deepEqual(out.orphanRows.map((r) => r.problem), ['Folder not found in Drive']);
  assert.ok(out.siteOnly.some((s) => s.slug === 'tijdstroom'));
  assert.ok(!out.siteOnly.some((s) => s.slug === 'avondwind'));
  for (const w of out.works) for (const p of w.photos) assert.ok(parseThumbPath(p.thumb), p.thumb);
});

test('archive thumbnails come through the Worker; anything else is a 404', async () => {
  const out = await (await get('/api/archive')).json();
  const w = out.works.find((x) => x.name === 'Avondwind');
  const res = await get(w.photos[0].thumb);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.match(res.headers.get('cache-control'), /^private/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.ok((await res.arrayBuffer()).byteLength > 1000);

  const [, , , , folder, sig, file] = w.photos[0].thumb.split('/');
  const other = out.works.find((x) => x.name === 'zand');
  const otherSig = other.photos[0].thumb.split('/')[5];
  const bad = [
    thumbPath(folder, sig, other.photos[0].id), // a real file, but not in the signed folder
    thumbPath(other.folderId, sig, file), // another folder with this folder's signature
    thumbPath(folder, `${sig.slice(0, -1)}${sig.at(-1) === 'A' ? 'B' : 'A'}`, file), // tampered
    thumbPath('mockOtherFolder01', otherSig, 'mockSecretImg1'), // outside the archive
    thumbPath(folder, sig, 'mockPdf_avondwind'), // not an image
    thumbPath(folder, sig, 'doesNotExist01'),
    `/api/archive/thumb/${folder}/${sig}/..%2F${file}`,
  ];
  for (const p of bad) assert.equal((await get(p)).status, 404, p);
});

test('without the archive settings: 503 for the list, 404 for photos, and the session says so', async () => {
  const none = env({ ARCHIVE_FOLDER_ID: '', GOOGLE_SA_KEY: '' });
  const res = await get('/api/archive', none);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).notConfigured, true);
  const sig = await signFolder(MOCK_SA_KEY, F);
  assert.equal((await get(thumbPath(F, sig, P), none)).status, 404);
  assert.equal((await (await get('/api/session', none)).json()).archive, false);
  assert.equal((await (await get('/api/session')).json()).archive, true);
});

test('the archive needs sign-in like every other route', async () => {
  const res = await worker.fetch(new Request('https://admin.arnenys.com/api/archive'), env({ ACCESS_TEAM_DOMAIN: 'https://x.cloudflareaccess.com', ACCESS_AUD: 'a' }));
  assert.equal(res.status, 403);
});

// ------------------------------------------------------------ the screen's helpers

test('the All works screen: filters, search, year groups, badges and covers', async () => {
  const { FILTERS, filterWorks, groupByYear, websiteBadge, coverOf, workMeta } = await import('../ui/archive.js');
  const { works } = await (await get('/api/archive')).json();
  const count = (f, q = '') => filterWorks(works, f, q).length;
  assert.deepEqual(FILTERS.map((f) => count(f.id)), [7, 4, 3, 3, 2]); // all, on (Blauwe echo is still live), off, changed, sold
  assert.equal(count('on') + count('off'), count('all'));
  assert.deepEqual(filterWorks(works, 'all', 'galerie NOORD').map((w) => w.name), ['Blauwe echo'], 'searches the buyer');
  assert.deepEqual(filterWorks(works, 'all', 'oil linen').map((w) => w.name), ['Avondwind'], 'every word must match');
  assert.equal(count('sold', 'avondwind'), 0);
  assert.deepEqual(groupByYear(works).map(([y, ws]) => [y, ws.length]), [[2026, 1], [2025, 1], [2024, 4], [2022, 1]]);
  const by = Object.fromEntries(works.map((w) => [w.name, w]));
  assert.deepEqual(websiteBadge(by.Avondwind), { cls: 'b-on', text: 'On website' });
  assert.deepEqual(websiteBadge(by['buis 3']), { cls: 'b-chg', text: 'On website · changed' });
  assert.deepEqual(websiteBadge(by.Homarium), { cls: 'b-chg', text: 'Not published yet' });
  assert.deepEqual(websiteBadge(by.zand), { cls: 'b-off', text: 'Not on website' });
  assert.equal(workMeta(by['buis 3']), 'Working title: “buis 3” · Installation · 5 photos');
  assert.equal(coverOf(by.Avondwind).id, by.Avondwind.row.websitePhotos[0]);
  assert.equal(coverOf({ photos: [], row: null }), null);
});
