// A stand-in for Google (token endpoint, Drive, Sheets, thumbnails) for the
// tests and `npm run dev:mock`: an archive of a few works whose "Drive"
// photos are images from this checkout. Nothing here goes on the network.
// Writes (new folders, renames, Sheet cells, uploads) change the archive
// object in memory only, so a restart starts afresh.
import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import { COLUMNS, HEADERS } from '../shared/archive.js';
import { ASSETS, CONTENT } from './helpers.mjs';

export const ROOT_ID = 'mockRootFolder01';
export const SHEET_ID = 'mockArchiveSheet01';
export const FOLDER = 'application/vnd.google-apps.folder';
const OTHER_ROOT = 'mockOtherFolder01'; // shared with the robot too, but not the archive
const EARLY = '2026-10-01T10:00:00.000Z';
const LATE = '2026-11-22T10:00:00.000Z';

/** A throwaway service-account key, so the real token code runs. */
export const MOCK_SA_KEY = JSON.stringify({
  type: 'service_account',
  client_email: 'mock-archive@example.iam.gserviceaccount.com',
  private_key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: 'https://oauth2.googleapis.com/token',
});

const idOf = (prefix, s) => `${prefix}_${s.replace(/[^A-Za-z0-9]+/g, '_')}`.padEnd(12, '0');

// [Drive path under the root, repo photo folder (the stand-in images), Sheet row or null]
const WORKS = [
  ['2026/Installaties/buis 3', 'afvoerdruk', { workingTitle: 'buis 3', technique: 'Installation', materials: 'PVC, plaster, pigment', onWebsite: 'yes', websiteSlug: 'afvoerdruk', lastPublished: '2026-11-01T00:00:00Z', late: '02.jpg' }],
  ['2024/Schilderij/Avondwind', 'avondwind', { workingTitle: 'Avondwind', technique: 'Oil on linen', width: 120, height: 90, unit: 'cm', onWebsite: 'yes', websiteSlug: 'avondwind', lastPublished: '2026-11-20T00:00:00Z' }],
  ['2024/Schilderij/Studie rood', 'obelia', { workingTitle: 'Studie rood', technique: 'Oil on paper', price: 450 }],
  ['2024/Tekening/zand', 'zandstorm', null],
  ['2025/Beeld/Blauwe echo', 'blue-echo', { workingTitle: 'Blauwe echo', series: 'Echo', sold: 'yes', soldTo: 'Galerie Noord', salePrice: 3200, onWebsite: 'no', websiteSlug: 'blue-echo' }],
  ['2022/Grijns', 'gele-grijns', { workingTitle: 'Grijns', edition: '1/1', sold: 'ja', onWebsite: 'yes', websiteSlug: 'gele-grijns', lastPublished: '2026-11-20T00:00:00Z' }],
  ['2024/Beeld/Homarium', 'homarium', { workingTitle: 'Homarium', onWebsite: 'yes' }],
];

/** The Drive listing (folders, images, one PDF) and the Sheet's values. */
export function mockArchive() {
  const files = [
    { id: ROOT_ID, name: 'Kunstwerken', mimeType: FOLDER, parents: ['robotRoot0001'] },
    { id: OTHER_ROOT, name: 'Something else', mimeType: FOLDER, parents: ['robotRoot0001'] },
    { id: 'mockSecretImg1', name: 'secret.jpg', mimeType: 'image/jpeg', parents: [OTHER_ROOT], modifiedTime: EARLY },
  ];
  const sources = new Map(); // image id -> repo file
  const folders = new Map([['', ROOT_ID]]);
  const folder = (p) => {
    if (folders.has(p)) return folders.get(p);
    const parent = folder(p.split('/').slice(0, -1).join('/'));
    const id = idOf('mockDir', p);
    files.push({ id, name: p.split('/').at(-1), mimeType: FOLDER, parents: [parent] });
    folders.set(p, id);
    return id;
  };
  const rows = [];
  for (const [p, repo, row] of WORKS) {
    const parent = folder(p);
    const ids = [];
    for (const name of galleryFiles(repo)) {
      const id = idOf('mockImg', `${repo}_${name}`);
      ids.push(id);
      sources.set(id, path.join(ASSETS, repo, name));
      files.push({
        id, name: `IMG_${name}`, mimeType: name.endsWith('.webp') ? 'image/webp' : 'image/jpeg', parents: [parent],
        size: '200000', modifiedTime: row?.late === name ? LATE : EARLY, imageMediaMetadata: { width: 2000, height: 3000 },
      });
    }
    files.push({ id: idOf('mockPdf', repo), name: 'certificate.pdf', mimeType: 'application/pdf', parents: [parent] });
    if (row) {
      const { late, ...cells } = row;
      rows.push({ folderId: parent, ...cells, ...(cells.websiteSlug ? { websitePhotos: ids.join(', ') } : {}) });
    }
  }
  rows.push({ folderId: 'mockGoneFolder1', workingTitle: 'Oude studie', year: 2019 });

  // Columns in another order than HEADERS, plus one of Arne's own, to show the mapping is by name.
  const head = [...HEADERS.slice(1), 'Location', HEADERS[0]];
  const key = Object.fromEntries(COLUMNS.map((c) => [c.header, c.key]));
  const values = [head, ...rows.map((r) => head.map((h) => (h === 'Location' ? 'Studio' : r[key[h]] ?? '')))];
  return { files, values, sources };
}

function galleryFiles(repo) {
  return JSON.parse(readFileSync(path.join(CONTENT, `${repo}.json`), 'utf8'))
    .gallery.map((g) => g.src.split('/').at(-1));
}

const ok = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const bytesOf = (src) => (typeof src === 'string' ? readFileSync(src) : src);
let seq = 0;

/** "'Archive'!E5" -> [column index, row index] (both 0-based). */
function cellOf(range) {
  const m = /!([A-Z]+)(\d+)$/.exec(range);
  const col = [...m[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  return [col, Number(m[2]) - 1];
}

/** A photo uploaded by the browser (dev:mock's stand-in for the Drive upload). */
export function mockUpload(archive, { folderId, name, type, bytes, description = '' }) {
  const id = `mockUpload${String(++seq).padStart(4, '0')}`;
  archive.sources.set(id, bytes);
  archive.files.push({
    id, name, description, mimeType: type || 'image/jpeg', parents: [folderId], size: String(bytes.length),
    modifiedTime: new Date().toISOString(), imageMediaMetadata: {},
  });
  return { id, name };
}

/**
 * Answers a Google request from the mock archive, or returns null for
 * anything that is not Google.
 */
export async function mockGoogle(input, init = {}, archive = mockArchive()) {
  const url = new URL(String(input));
  const method = init.method || 'GET';
  if (url.href === 'https://oauth2.googleapis.com/token' && method === 'POST')
    return ok({ access_token: 'mock-google-token', expires_in: 3600 });
  const body = typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : null;
  if (url.host === 'lh3.mock.test') {
    const [id, size] = url.pathname.slice(1).split('=');
    const f = archive.files.find((x) => x.id === id);
    if (!archive.sources.has(id) || !/^s\d+$/.test(size)) return ok({ error: 'not found' }, 404);
    return new Response(bytesOf(archive.sources.get(id)), { headers: { 'content-type': f.mimeType } });
  }
  if (!/(^|\.)googleapis\.com$/.test(url.host)) return null;
  if (init.headers?.authorization !== 'Bearer mock-google-token') return ok({ error: { message: 'No token' } }, 401);
  if (url.pathname === '/drive/v3/files' && method === 'GET') {
    const parent = /'([^']+)' in parents/.exec(url.searchParams.get('q') || '')?.[1];
    return ok({ files: parent ? archive.files.filter((f) => f.parents?.includes(parent) && f.mimeType.startsWith('image/')) : archive.files });
  }
  if (url.pathname === '/drive/v3/files' && method === 'POST') {
    const f = { id: `mockNewDir${String(++seq).padStart(4, '0')}`, name: body.name, mimeType: body.mimeType, parents: body.parents };
    archive.files.push(f);
    return ok(f);
  }
  const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
  if (one) {
    const f = archive.files.find((x) => x.id === decodeURIComponent(one[1]));
    if (!f) return ok({ error: { code: 404, message: 'File not found' } }, 404);
    if (method === 'PATCH') {
      if (Object.keys(body).some((k) => k !== 'name' && k !== 'description')) return ok({ error: { message: 'mock: only name and description' } }, 400);
      return ok(Object.assign(f, body));
    }
    if (method !== 'GET') return ok({ error: { message: 'The mock never deletes.' } }, 403);
    if (url.searchParams.get('alt') === 'media') return new Response(bytesOf(archive.sources.get(f.id)), { headers: { 'content-type': f.mimeType } });
    return ok({ id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents, description: f.description, trashed: false, ...(archive.sources.has(f.id) ? { thumbnailLink: `https://lh3.mock.test/${f.id}=s220` } : {}) });
  }
  const sheet = `/v4/spreadsheets/${SHEET_ID}/values`;
  if (url.pathname === `${sheet}/A:ZZ` && method === 'GET') return ok({ range: "'Archive'!A1:Z100", values: archive.values });
  if (url.pathname === `${sheet}:batchUpdate` && method === 'POST') {
    for (const d of body.data) {
      const [c, r] = cellOf(d.range);
      while (archive.values.length <= r) archive.values.push([]);
      const row = archive.values[r];
      while (row.length <= c) row.push('');
      row[c] = d.values[0][0];
    }
    return ok({ totalUpdatedCells: body.data.length });
  }
  if (url.pathname.startsWith(`${sheet}/`) && url.pathname.endsWith(':append') && method === 'POST') {
    archive.values.push([...body.values[0]]);
    const n = archive.values.length;
    return ok({ updates: { updatedRange: `'Archive'!A${n}:Z${n}` } });
  }
  return ok({ error: { message: `mock: unknown ${method} ${url.pathname}` } }, 404);
}
