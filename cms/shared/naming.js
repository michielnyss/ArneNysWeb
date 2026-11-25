// How works and photos are named in the archive's Drive folder. Pure, no
// dependencies: the Worker, the editor UI and local Node scripts share it.
//
//   year folder   2024
//   type folder   as Arne named it (left alone)
//   work folder   2024 - Avondwind
//   photo         Avondwind - 01.jpg   (the next free number in the folder;
//                 3 digits from 100; extension lowercase, jpeg -> jpg)
//
// A photo's title is the work folder's title (its name without "YYYY - "),
// so photos follow the folder when a work is renamed. The name a photo had
// before is kept in its Drive description as "Original name: <name>".

const NOT_ALLOWED = /[/\\:*?"<>|\u0000-\u001f\u007f]/g;

/** Text made safe for a file or folder name: no / \ : * ? " < > |, spaces collapsed, trimmed (also trailing dots). */
export function cleanTitle(s) {
  return String(s ?? '').replace(NOT_ALLOWED, '').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
}

/** The work folder's name: "2024 - Avondwind" (just the title when there is no year). */
export function workFolderName(year, title) {
  const t = cleanTitle(title);
  return /^\d{4}$/.test(String(year ?? '')) ? `${year} - ${t}` : t;
}

/** "2024 - Avondwind" -> { year: 2024, title: 'Avondwind' }; a name without the year -> { year: null, title: name }. */
export function parseWorkFolder(name) {
  const m = /^(\d{4}) - (.+)$/.exec(String(name ?? '').trim());
  return m ? { year: Number(m[1]), title: cleanTitle(m[2]) } : { year: null, title: cleanTitle(name) };
}

const EXT_OF_TYPE = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif', 'image/tiff': 'tif' };

/** A photo's extension, lowercase, jpeg -> jpg; from its MIME type when the name has none. '' if neither says. */
export function photoExt(name, mimeType = '') {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(name ?? ''));
  const ext = m ? m[1].toLowerCase() : EXT_OF_TYPE[mimeType] || '';
  return ext === 'jpeg' ? 'jpg' : ext;
}

/** "Avondwind - 01.jpg": number padded to 2 digits (3 from 100). */
export function photoName(title, number, ext) {
  const n = String(number).padStart(2, '0');
  return `${cleanTitle(title)} - ${n}${ext ? `.${ext}` : ''}`;
}

/** "Avondwind - 01.jpg" -> { title: 'Avondwind', number: 1, ext: 'jpg' }; null if the name is not like that. */
export function parsePhotoName(name) {
  const m = /^(.+) - (\d{2,})(?:\.([A-Za-z0-9]{1,5}))?$/.exec(String(name ?? ''));
  return m ? { title: m[1], number: Number(m[2]), ext: (m[3] || '').toLowerCase() } : null;
}

/** Is `name` exactly the scheme's name for a photo of `title`? */
export function isPhotoName(name, title) {
  const p = parsePhotoName(name);
  return !!p && p.number > 0 && name === photoName(title, p.number, photoExt(name));
}

/** The next free number for `title` in a folder whose photos are `names` (highest + 1; 1 for none). */
export function nextNumber(names, title) {
  let max = 0;
  for (const n of names) if (isPhotoName(n, title)) max = Math.max(max, parsePhotoName(n).number);
  return max + 1;
}

/**
 * The names for new photos (`files`: [{ name, type }], in the order chosen)
 * going into a folder with `names` already in it: consecutive numbers.
 */
export function newPhotoNames(names, title, files) {
  const first = nextNumber(names, title);
  return files.map((f, i) => photoName(title, first + i, photoExt(f.name, f.type)));
}

/** The note kept in a photo's Drive description. */
export const originalNote = (name) => `Original name: ${name}`;
const NOTE = /^Original name: (.*)$/m;
/** The original name from a description, or null. */
export const originalName = (description) => NOTE.exec(String(description ?? ''))?.[1] ?? null;
/** A description with the original-name note added, unless it has one already. */
export function withOriginalNote(description, name) {
  const d = String(description ?? '');
  if (NOTE.test(d)) return d;
  return d.trim() ? `${d.trimEnd()}\n${originalNote(name)}` : originalNote(name);
}

const byTimeThenName = (a, b) => {
  const ta = a.time || '';
  const tb = b.time || '';
  if (ta !== tb) return !ta ? 1 : !tb ? -1 : ta < tb ? -1 : 1; // no capture time: last
  return String(a.name).localeCompare(String(b.name), undefined, { numeric: true });
};

/**
 * Renames that bring a folder's photos to the scheme for `title`.
 * `files`: [{ id, name, mimeType?, time? }] (time = capture time, e.g. Drive's
 * imageMediaMetadata.time "2024:05:01 12:00:00", which sorts as text).
 * Photos already named right keep their number; the others (and the second
 * of two with the same number) get the next free numbers, by capture time,
 * then name. With `only` (ids, in order), only those photos may be renamed,
 * in that order (e.g. just-uploaded photos that clash with another upload).
 * Returns [{ id, from, name }].
 */
export function renamePlan(files, title, { only = null } = {}) {
  const pos = only ? new Map(only.map((id, i) => [id, i])) : null;
  const ordered = pos
    ? [...files.filter((f) => !pos.has(f.id)), ...files.filter((f) => pos.has(f.id)).sort((a, b) => pos.get(a.id) - pos.get(b.id))]
    : files;
  const taken = new Set();
  const todo = [];
  for (const f of ordered) {
    const n = isPhotoName(f.name, title) ? parsePhotoName(f.name).number : 0;
    if (n && !taken.has(n)) taken.add(n);
    else if (!pos || pos.has(f.id)) todo.push(f);
  }
  if (!pos) todo.sort(byTimeThenName);
  let next = Math.max(0, ...taken) + 1;
  return todo.map((f) => ({ id: f.id, from: f.name, name: photoName(title, next++, photoExt(f.name, f.mimeType)) }));
}

/**
 * Renames for a work whose title changed: photos named "<from> - NN.ext"
 * become "<to> - NN.ext" (keeping their number unless <to> already has it).
 * Other photos are left alone. Returns [{ id, from, name }].
 */
export function retitlePlan(files, from, to) {
  const taken = new Set(files.filter((f) => isPhotoName(f.name, to)).map((f) => parsePhotoName(f.name).number));
  let next = Math.max(0, ...taken) + 1;
  return files
    .filter((f) => cleanTitle(from) !== cleanTitle(to) && isPhotoName(f.name, from))
    .map((f) => ({ f, p: parsePhotoName(f.name) }))
    .sort((a, b) => a.p.number - b.p.number)
    .map(({ f, p }) => {
      let n = p.number;
      if (taken.has(n)) {
        while (taken.has(next)) next++;
        n = next;
      }
      taken.add(n);
      return { id: f.id, from: f.name, name: photoName(to, n, p.ext) };
    });
}
