// `npm run archive:headers`: writes the archive Sheet's missing header cells
// (the columns of shared/archive.js, after its last header), as the service
// account. For setting up a new, empty archive Sheet; run it again any time,
// it only adds what is missing and never touches other cells.
//   ARCHIVE_FOLDER_ID, ARCHIVE_SHEET_ID  the archive folder and its Sheet (both
//                                        required; the Sheet must be inside it)
//   SA_KEY_FILE                          key file, default ~/.secrets/arnenys-archive-sa.json
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DRIVE, googleJson } from '../src/drive.js';
import { readSheet, writeHeaders } from '../src/sheet.js';

const { ARCHIVE_FOLDER_ID: folderId, ARCHIVE_SHEET_ID: sheetId } = process.env;
if (!folderId || !sheetId) {
  console.error('Set ARCHIVE_FOLDER_ID and ARCHIVE_SHEET_ID.');
  process.exit(1);
}
const env = { GOOGLE_SA_KEY: readFileSync(process.env.SA_KEY_FILE || path.join(homedir(), '.secrets', 'arnenys-archive-sa.json'), 'utf8') };

// The Sheet must sit inside the folder (walking up its parents), so a
// mistyped id cannot write into some other Sheet the service account sees.
let id = sheetId;
let inside = false;
for (let i = 0; i < 8 && id && !inside; i++) {
  const f = await googleJson(env, `${DRIVE}/files/${encodeURIComponent(id)}?fields=id,parents,trashed`);
  if (f.trashed) break;
  id = f.parents?.[0];
  inside = id === folderId;
}
if (!inside) {
  console.error('The Sheet is not inside the archive folder; nothing written.');
  process.exit(1);
}

const added = await writeHeaders(env, sheetId);
const sheet = await readSheet(env, sheetId);
console.log(added.length ? `Added ${added.length} headers to tab "${sheet.tab}".` : `Tab "${sheet.tab}" already has every header.`);
console.log(`Missing now: ${sheet.missing.length ? sheet.missing.join(', ') : 'none'}; rows: ${sheet.records.length}; other columns: ${sheet.extra.length ? sheet.extra.join(', ') : 'none'}`);
