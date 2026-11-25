// The archive Sheet (one row per work), as the service account. The column
// mapping lives in shared/archive.js. Writes touch only the cells of the
// columns that changed, in the row whose "Drive folder ID" matches, so Arne's
// own columns and his edits to other cells are left alone.

import { COLUMN, COLUMNS, readTable, sameValue, toCell } from '../shared/archive.js';
import { googleJson } from './drive.js';

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

export class SheetConflict extends Error {
  constructor(keys) {
    super('Someone changed this work in the Sheet in the meantime. Reload the page to see the latest version.');
    this.status = 409;
    this.keys = keys;
  }
}

/**
 * The first tab as records. Numbers come back as numbers and dates as the
 * text Arne sees, whatever the Sheet's number format.
 */
export async function readSheet(env, sheetId) {
  const params = new URLSearchParams({ valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'FORMATTED_STRING' });
  // A range without a tab name is the first tab.
  const out = await googleJson(env, `${SHEETS}/${encodeURIComponent(sheetId)}/values/A:ZZ?${params}`);
  return { tab: String(out.range || '').split('!')[0].replace(/^'|'$/g, '').replace(/''/g, "'"), ...readTable(out.values) };
}

/** 0 -> "A", 25 -> "Z", 26 -> "AA". */
export function columnLetter(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const tabRef = (tab) => `'${String(tab).replace(/'/g, "''")}'`;

/**
 * What to write so the row of `folderId` holds `changes` ({column key: value}).
 * Pure. `sheet` is readSheet's result, read just before. `base` holds the
 * values the editor started from; a changed key whose cell no longer holds
 * its base value is a conflict (someone edited that cell meanwhile). Without
 * a row for the folder, a new one is appended. Columns the Sheet lacks are
 * added after its last header.
 *
 * @returns {{ rowNumber: number|null, updates: {range, values}[], append: any[]|null, conflicts: string[], row: object }}
 */
export function planRowWrite(sheet, folderId, changes, base = null) {
  const current = sheet.records.find((r) => r.folderId === folderId) || null;
  const keys = Object.keys(changes).filter((k) => COLUMN[k] && k !== 'folderId');
  const conflicts = base ? keys.filter((k) => k in base && !sameValue(base[k], current?.[k])) : [];
  const tab = tabRef(sheet.tab);
  const index = { ...sheet.index };
  const updates = [];
  let width = sheet.width;
  for (const k of current ? keys : ['folderId', ...keys]) {
    if (k in index) continue;
    index[k] = width++;
    updates.push({ range: `${tab}!${columnLetter(index[k])}1`, values: [[COLUMN[k].header]] });
  }
  const cell = (k) => toCell(COLUMN[k].type, k === 'folderId' ? folderId : changes[k]);
  const row = { ...Object.fromEntries(COLUMNS.map((c) => [c.key, null])), ...(current || {}), ...Object.fromEntries(keys.map((k) => [k, changes[k]])), folderId };
  if (current) {
    for (const k of keys) updates.push({ range: `${tab}!${columnLetter(index[k])}${current.rowNumber}`, values: [[cell(k)]] });
    return { rowNumber: current.rowNumber, updates, append: null, conflicts, row };
  }
  const written = ['folderId', ...keys];
  const append = Array.from({ length: Math.max(...written.map((k) => index[k])) + 1 }, () => '');
  for (const k of written) append[index[k]] = cell(k);
  return { rowNumber: null, updates, append, conflicts, row };
}

/**
 * The header cells a Sheet still lacks, written after its last header in the
 * order of COLUMNS (all of them, from A1, for an empty Sheet). Pure; null
 * when nothing is missing. Arne's own columns are left where they are.
 */
export function planHeaders(sheet) {
  const missing = COLUMNS.filter((c) => !(c.key in sheet.index)).map((c) => c.header);
  if (!missing.length) return null;
  const from = columnLetter(sheet.width);
  const to = columnLetter(sheet.width + missing.length - 1);
  return { range: `${tabRef(sheet.tab)}!${from}1:${to}1`, values: [missing] };
}

/** Writes the missing header cells (RAW). Returns the headers it added. */
export async function writeHeaders(env, sheetId) {
  const plan = planHeaders(await readSheet(env, sheetId));
  if (!plan) return [];
  await googleJson(env, `${SHEETS}/${encodeURIComponent(sheetId)}/values:batchUpdate`, 'POST', { valueInputOption: 'RAW', data: [plan] });
  return plan.values[0];
}

/**
 * Writes `changes` into the row of `folderId` (a new row if it has none),
 * after a fresh read. Throws SheetConflict (409) when `base` no longer
 * matches. Returns the row as it now is (with `rowNumber`).
 */
export async function writeRow(env, sheetId, folderId, changes, base = null) {
  const sheet = await readSheet(env, sheetId);
  const plan = planRowWrite(sheet, folderId, changes, base);
  if (plan.conflicts.length) throw new SheetConflict(plan.conflicts);
  const id = encodeURIComponent(sheetId);
  if (plan.updates.length)
    await googleJson(env, `${SHEETS}/${id}/values:batchUpdate`, 'POST', { valueInputOption: 'RAW', data: plan.updates });
  if (plan.append) {
    const range = encodeURIComponent(`${tabRef(sheet.tab)}!A1`);
    const out = await googleJson(env, `${SHEETS}/${id}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      'POST', { values: [plan.append] });
    plan.row.rowNumber = Number(/!\$?[A-Z]+\$?(\d+)/.exec(out?.updates?.updatedRange || '')?.[1]) || null;
  }
  return plan.row;
}
