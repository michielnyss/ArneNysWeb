// The archive Sheet: one row per work, shared by the Worker (which reads it)
// and the UI (which shows it). Columns are found by their header text, not
// their position, so Arne can reorder, hide or add columns in the Sheet.
//
// Private archive fields come from ArneDatabase (table `kunstwerken`). What
// visitors see (title, description, ...) stays in the site's artwork JSON and
// is not repeated here; "Website slug" links a row to that JSON.

/**
 * type: text | number | bool | ids (Drive file ids, in order) | pairs
 * ("id=file, ..."). group: where the work card shows it (work, sale), or
 * nothing for the columns the editor fills in itself.
 */
export const COLUMNS = [
  { key: 'folderId', header: 'Drive folder ID', type: 'text' },
  { key: 'workingTitle', header: 'Working title', type: 'text', group: 'work', wide: true },
  { key: 'year', header: 'Year', type: 'number', group: 'work' },
  { key: 'series', header: 'Series', type: 'text', group: 'work' },
  { key: 'technique', header: 'Technique', type: 'text', group: 'work' },
  { key: 'materials', header: 'Materials', type: 'text', group: 'work' },
  { key: 'edition', header: 'Edition', type: 'text', group: 'work' },
  { key: 'width', header: 'Width', type: 'number', group: 'work' },
  { key: 'height', header: 'Height', type: 'number', group: 'work' },
  { key: 'depth', header: 'Depth', type: 'number', group: 'work' },
  { key: 'unit', header: 'Unit', type: 'text', group: 'work', placeholder: 'cm' },
  { key: 'dimensions', header: 'Dimensions (free text)', type: 'text', group: 'work', placeholder: 'e.g. variable' },
  { key: 'tags', header: 'Tags', type: 'text', group: 'work' },
  { key: 'notes', header: 'Notes', type: 'text', group: 'work', long: true },
  { key: 'price', header: 'Price', type: 'number', group: 'sale', label: 'Asking price (€)' },
  { key: 'sold', header: 'Sold', type: 'bool', group: 'sale' },
  { key: 'soldTo', header: 'Sold to', type: 'text', group: 'sale' },
  { key: 'salePrice', header: 'Sale price', type: 'number', group: 'sale', label: 'Sale price (€)' },
  { key: 'saleDate', header: 'Sale date', type: 'text', group: 'sale', placeholder: 'e.g. 2026-11-24' },
  { key: 'buyerContact', header: 'Buyer contact', type: 'text', group: 'sale' },
  { key: 'saleNotes', header: 'Sale notes', type: 'text', group: 'sale', long: true },
  { key: 'onWebsite', header: 'On website', type: 'bool' },
  { key: 'websiteSlug', header: 'Website slug', type: 'text' },
  { key: 'websitePhotos', header: 'Website photos', type: 'ids' },
  { key: 'lastPublished', header: 'Last published', type: 'text' },
  // Written by Publish: which Drive photo became which file on the site.
  { key: 'publishedPhotos', header: 'Published photos', type: 'pairs' },
];

export const COLUMN = Object.fromEntries(COLUMNS.map((c) => [c.key, c]));

/** The header row, in the order a new Sheet gets it. */
export const HEADERS = COLUMNS.map((c) => c.header);

/** Header text -> lookup key: case, spaces and punctuation don't matter. */
export const headerKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const BY_HEADER = new Map(COLUMNS.map((c) => [headerKey(c.header), c]));

const TRUE = new Set(['yes', 'y', 'ja', 'j', 'true', 'x', '1', 'sold', 'verkocht']);
const FALSE = new Set(['no', 'n', 'nee', 'false', '0']);

/** One cell as its column's type. Empty is null; text that is not a number stays text. */
export function parseCell(type, raw) {
  if (raw === null || raw === undefined) return null;
  if (type === 'bool') {
    if (typeof raw === 'boolean') return raw;
    const s = String(raw).trim().toLowerCase();
    return TRUE.has(s) ? true : FALSE.has(s) ? false : null;
  }
  if (typeof raw === 'string' && raw.trim() === '') return null;
  if (type === 'number') {
    if (typeof raw === 'number') return raw;
    const n = Number(String(raw).trim().replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : String(raw).trim();
  }
  if (type === 'ids' || type === 'pairs') {
    const list = Array.isArray(raw) && type === 'pairs' ? raw : String(raw).split(/[\s,;]+/).filter(Boolean);
    const out = type === 'ids' ? list
      : list.map((p) => (typeof p === 'string' ? p.split('=') : [p?.id, p?.file]))
        .filter(([id, file]) => id && file).map(([id, file]) => ({ id: String(id), file: String(file) }));
    return out.length ? out : null; // empty is empty, as for the other types
  }
  return String(raw).trim();
}

/**
 * The other way round: a value as it is written to its cell (RAW, so text
 * that starts with "=" stays text and "1/5" does not become a date).
 */
export function toCell(type, value) {
  if (value === null || value === undefined) return '';
  if (type === 'bool') return value === true ? 'yes' : value === false ? 'no' : String(value);
  if (type === 'ids') return [].concat(value).join(', ');
  if (type === 'pairs') return [].concat(value).map((p) => `${p.id}=${p.file}`).join(', ');
  if (type === 'number') return typeof value === 'number' ? value : String(value);
  return String(value);
}

/** Two cell values as parsed: the same? (Arrays and objects by content.) */
export const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * What changed: `edits` ({key: value as typed or chosen}) parsed by column
 * type and compared with `row` (null for a work with no row yet). Returns
 * { changes, base }: only the changed values, and what the row had for them.
 */
export function rowChanges(row, edits) {
  const changes = {};
  const base = {};
  for (const [k, raw] of Object.entries(edits)) {
    const v = parseCell(COLUMN[k].type, raw);
    if (sameValue(row?.[k] ?? null, v)) continue;
    changes[k] = v;
    base[k] = row?.[k] ?? null;
  }
  return { changes, base };
}

/**
 * The Sheet's values (row 1 = headers) -> records keyed by column key, each
 * with its 1-based `rowNumber`. Rows with nothing in them are skipped.
 * `missing` lists the headers of columns not found; `extra` the Sheet's own
 * headers that are not ours (kept in the Sheet, ignored here). `index` is
 * each column's position and `width` the header row's length, for writing.
 */
export function readTable(values = []) {
  const [head = [], ...rows] = values;
  const index = {};
  const extra = [];
  head.forEach((h, i) => {
    const col = BY_HEADER.get(headerKey(h));
    if (col && !(col.key in index)) index[col.key] = i;
    else if (String(h ?? '').trim()) extra.push(String(h).trim());
  });
  const missing = COLUMNS.filter((c) => !(c.key in index)).map((c) => c.header);
  const records = [];
  rows.forEach((row, i) => {
    if (!row?.some((v) => v !== null && v !== undefined && String(v).trim() !== '')) return;
    const rec = { rowNumber: i + 2 };
    for (const c of COLUMNS) rec[c.key] = c.key in index ? parseCell(c.type, row[index[c.key]]) : null;
    records.push(rec);
  });
  return { records, missing, extra, index, width: head.length };
}

/** The website states a work can be in (see src/archive.js). */
export const WEBSITE_LABELS = {
  on: 'On website',
  off: 'Not on website',
  changed: 'Changed since publish',
};
