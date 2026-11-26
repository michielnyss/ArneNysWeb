// The work card (#/archive/<folder id>): one work of Arne's archive, in two
// tabs.
//   Archive (private): the Sheet row's fields and the photos in the work's
//     Drive folder. A star puts a photo on the website (starred order =
//     website order). Photos are uploaded into the folder from here. Save
//     writes the row; nothing in Drive is ever deleted from here.
//   Website (public): on or off, what visitors see (the website editor's own
//     fields, photo list, crop and page preview, from editor.js), and Publish,
//     which copies the starred photos and the fields to the site in one commit.

import { COLUMNS, rowChanges } from '../shared/archive.js';
import { cleanTitle, originalNote, parseWorkFolder, renamePlan, workFolderName } from '../shared/naming.js';
import { planGallery, publicDefaults, webPhotoState } from '../shared/publish.js';
import { $app, api, h, notice, toast, uploadBlob } from './dom.js';
import { invalidateArchive, loadArchive, loading, problem, websiteBadge } from './archive.js';
import {
  copyToFolder, ensureDriveToken, hasDriveToken, pickerAvailable, pickFromDrive, uploadAvailable, uploadToFolder,
} from './drive.js';
import {
  pagePreview, previewLink, publicFields, readPublicFields, renderCrop, renderPhotoList, renderPreviewPhotos,
  renderPreviewText,
} from './editor.js';
import { preparePhoto, PhotoProblem } from './prepare.js';

let C = null; // the open card: { work, data, tab, starred, web, onWebsite, original, dirty: {archive, web}, busy, result }

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const hashOf = (folderId) => `#/archive/${encodeURIComponent(folderId)}`;

// ------------------------------------------------------------ pure helpers

/** What the main button does now: publish, publish changes, take off, or nothing. */
export function publishAction(onWebsite, live) {
  if (onWebsite) return { id: 'publish', label: live ? 'Publish changes' : 'Publish to website' };
  return live ? { id: 'unpublish', label: 'Remove from website' } : null;
}

/** Starring: on adds the photo at the end of the website order, off takes it out. */
export function toggleStar(starred, id) {
  return starred.includes(id) ? starred.filter((x) => x !== id) : [...starred, id];
}

/**
 * The work folder's new name ("YYYY - <new title>") when the working title
 * changed and the folder carries the old one ("YYYY - <old>", or just the
 * old title as older folders are), or there was no title yet; else null.
 * The year is the folder's own, or `year` if its name has none.
 */
export function folderRename(folderName, oldTitle, newTitle, year) {
  const t = cleanTitle(newTitle);
  if (!t) return null;
  const now = parseWorkFolder(folderName);
  const follows = !oldTitle || now.title === cleanTitle(oldTitle) || folderName === String(oldTitle).trim();
  const name = workFolderName(now.year ?? year, t);
  return follows && name !== folderName ? name : null;
}

/** Photos in the folder not named by the scheme yet (what "Tidy names" would rename). */
export const untidyPhotos = (work) => renamePlan(work.photos, parseWorkFolder(work.name).title);

// ------------------------------------------------------------------ guard

window.addEventListener('beforeunload', (e) => {
  if (C && (C.dirty.archive || C.dirty.web || C.busy)) { e.preventDefault(); e.returnValue = ''; }
});

/** Leaving the card for `hash`: asks first if there are unsaved changes (and stays if so). */
export function leaveWork(hash) {
  if (!C || hash === hashOf(C.work.folderId)) return true;
  if ((C.dirty.archive || C.dirty.web) && !confirm('You have changes that are not saved. Leave without saving them?')) {
    history.replaceState(null, '', hashOf(C.work.folderId));
    return false;
  }
  C = null;
  return true;
}

// ------------------------------------------------------------------ screen

export async function showArchiveWork(folderId) {
  const fresh = !C || C.work.folderId !== folderId;
  if (fresh) loading();
  let data;
  try {
    data = await loadArchive();
  } catch (e) {
    return problem(e);
  }
  const work = data.works.find((x) => x.folderId === folderId);
  if (!work) {
    C = null;
    return $app().replaceChildren(h('div', { class: 'panel narrow' }, h('p', {}, 'This folder is not in the archive (any more).'),
      h('a', { class: 'btn', href: '#/archive' }, '← All works')));
  }
  if (fresh || !(C.dirty.archive || C.dirty.web)) open(work, data, fresh ? 'archive' : C.tab);
  render();
}

function open(work, data, tab) {
  const inFolder = new Set(work.photos.map((p) => p.id));
  const starred = (work.row?.websitePhotos || []).filter((id) => inFolder.has(id));
  C = {
    work, data, tab,
    starred,
    web: Object.fromEntries(work.photos.map((p) => [p.id, { key: p.id, thumb: p.thumb, name: p.name, ...webPhotoState(work, p.id) }])),
    onWebsite: work.row?.onWebsite ?? work.website.live,
    original: work.website.data || publicDefaults(work),
    dirty: { archive: false, web: false },
    busy: false,
    result: null,
  };
}

function markDirty(which) {
  C.dirty[which] = true;
  updateBar();
}

/** Keeps what was typed on the Website tab when the card is drawn again. */
function captureWeb() {
  if (C.dirty.web && document.getElementById('f-title')) C.webValues = readPublicFields(C.original).data;
}

function render() {
  captureWeb();
  const w = C.work;
  document.title = `${w.title} — arnenys.com admin`;
  const b = websiteBadge(w);
  const tabs = [['archive', 'Archive (private)'], ['website', 'Website (public)']];
  const readOnly = C.data.readOnly;
  $app().replaceChildren(...[
    h('div', { class: 'archive work-card narrow' },
      h('a', { class: 'back', href: '#/archive' }, '← All works'),
      h('div', { class: 'card-head' },
        h('div', {},
          h('h1', {}, w.title),
          h('p', { class: 'lede' }, 'Drive: ', h('a', { href: w.url, target: '_blank', rel: 'noopener' }, w.path.join(' / '), ' ↗'),
            ' · ', plural(w.photos.length, 'photo'))),
        h('span', { class: `badge ${b.cls}`, title: w.website.reasons.join('. ') || null },
          w.website.live && w.website.title !== w.title ? `${b.text} as “${w.website.title}”` : b.text),
      ),
      h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([id, label]) => h('button', {
        class: `tab${C.tab === id ? ' on' : ''}`, type: 'button', role: 'tab', id: `tab-${id}`, 'aria-selected': String(C.tab === id),
        'aria-controls': `pane-${id}`, onclick: () => { C.tab = id; render(); },
      }, label))),
      h('div', { id: 'pane-archive', role: 'tabpanel', 'aria-labelledby': 'tab-archive', hidden: C.tab !== 'archive' }, archivePane(readOnly)),
      h('div', { id: 'pane-website', role: 'tabpanel', 'aria-labelledby': 'tab-website', hidden: C.tab !== 'website' }, websitePane()),
      C.result ? resultPanel(C.result) : null,
      readOnly ? h('p', { class: 'hint' }, 'The archive is read-only here.') : actionBar(),
    ),
    C.tab === 'website' && C.onWebsite ? pagePreview() : null,
  ].filter(Boolean));
  if (C.tab === 'website' && C.onWebsite) renderWebPhotos();
  renderRename();
  updateBar();
}

// ------------------------------------------------------------ archive tab

function archivePane(readOnly) {
  const w = C.work;
  const fileInput = h('input', {
    type: 'file', accept: 'image/*,.heic,.heif', multiple: true, hidden: true,
    onchange: (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      addPhotos(files.map((f) => ({ name: f.name, type: f.type, put: (id, name, note) => uploadToFolder(id, f, name, note) })));
    },
  });
  // Google sign-in first (a popup, allowed only right after a click), then the file chooser.
  const addButton = async () => {
    if (!hasDriveToken()) {
      try {
        await ensureDriveToken();
      } catch (e) {
        if (!e.cancelled) toast('Google sign-in did not work. Check that pop-ups are allowed for this page, then try again.', 'error');
        return;
      }
    }
    fileInput.click();
  };
  const photos = h('ul', { class: 'drive-photos' }, w.photos.map((p) => {
    const on = C.starred.includes(p.id);
    const n = C.starred.indexOf(p.id) + 1;
    return h('li', { class: on ? 'starred' : '' },
      h('div', { class: 'drive-photo' },
        h('img', { src: p.thumb, alt: '', loading: 'lazy', onerror: (e) => e.target.replaceWith(h('span', { class: 'no-thumb' }, 'No preview yet')) }),
        h('button', {
          class: 'star', type: 'button', disabled: readOnly, 'aria-pressed': String(on),
          'aria-label': on ? `On the website (photo ${n}). Take “${p.name}” off the website` : `Show “${p.name}” on the website`,
          title: on ? 'On the website — click to take it off' : 'Show on the website',
          onclick: () => { C.starred = toggleStar(C.starred, p.id); markDirty('archive'); render(); },
        }, on ? '★' : '☆'),
        on ? h('span', { class: 'star-num' }, n === 1 ? '1 · cover' : String(n)) : null,
      ),
      h('span', { class: 'fname' }, p.name));
  }));
  const canAdd = !readOnly && uploadAvailable();
  const untidy = readOnly ? [] : untidyPhotos(w);
  return [
    h('section', { class: 'panel' },
      h('h2', {}, 'Photos in the Drive folder'),
      w.photos.length ? photos : h('p', { class: 'hint' }, 'No photos in this folder yet.'),
      h('div', { id: 'drive-notices', 'aria-live': 'polite' }),
      canAdd ? h('div', { class: 'add-photos' },
        h('button', { class: 'btn', type: 'button', onclick: addButton }, '+ Add photos'),
        pickerAvailable() ? h('button', { class: 'btn', type: 'button', onclick: copyFromDrive }, h('span', { class: 'drive-icon', 'aria-hidden': 'true' }), 'From Google Drive') : null,
        fileInput,
      ) : null,
      untidy.length ? h('p', { class: 'hint' }, `${plural(untidy.length, 'photo')} not named “${parseWorkFolder(w.name).title} - NN” yet. `,
        h('button', { class: 'btn', type: 'button', onclick: tidyNames }, 'Tidy names')) : null,
      h('p', { class: 'hint' }, '★ = on the website, in the order starred; the first is the cover. Photos stay in Drive: only the starred ones are copied to the website when you publish. Added photos are saved in this Drive folder as they are, named “working title - 01”, “- 02”, … (the old name is kept in the Drive description).'),
    ),
    fieldsPanel('The work', 'work', readOnly),
    fieldsPanel('Price and sale', 'sale', readOnly, ' — never on the website'),
  ];
}

function fieldsPanel(title, group, readOnly, aside = '') {
  const row = C.work.row || {};
  const cols = COLUMNS.filter((c) => c.group === group);
  return h('section', { class: 'panel' },
    h('h2', {}, title, aside ? h('span', { class: 'hint-inline' }, aside) : null),
    h('div', { class: 'fields' }, cols.map((c) => {
      const id = `a-${c.key}`;
      const v = C.edits?.[c.key] ?? row[c.key];
      const onInput = (e) => {
        (C.edits ||= {})[c.key] = e.target.value;
        markDirty('archive');
        if (c.key === 'workingTitle') renderRename();
      };
      let input;
      if (c.type === 'bool') {
        input = h('select', { id, disabled: readOnly, onchange: onInput },
          [['', '—'], ['yes', 'Yes'], ['no', 'No']].map(([value, label]) =>
            h('option', { value, selected: (v === true ? 'yes' : v === false ? 'no' : v ?? '') === value }, label)));
      } else if (c.long) {
        input = h('textarea', { id, rows: 3, disabled: readOnly, oninput: onInput });
        input.value = v ?? '';
      } else {
        input = h('input', {
          id, type: 'text', value: v ?? '', disabled: readOnly, autocomplete: 'off', placeholder: c.placeholder || null,
          inputmode: c.type === 'number' ? 'decimal' : null, oninput: onInput,
        });
      }
      return h('div', { class: `field${c.wide || c.long ? ' wide' : ''}` }, h('label', { for: id }, c.label || c.header), input,
        c.key === 'workingTitle' ? h('div', { id: 'rename-box' }) : null);
    })),
  );
}

/** The new folder name, when the working title changed and the folder carries the old one. */
const renameTo = () => {
  const now = C.edits?.workingTitle;
  return now === undefined ? null : folderRename(C.work.name, C.work.row?.workingTitle, now, C.work.year);
};

/** "Also rename the Drive folder" (on unless unticked). */
function renderRename() {
  const box = document.getElementById('rename-box');
  if (!box) return;
  const name = renameTo();
  box.replaceChildren(name ? h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: C.keepFolderName !== true, onchange: (e) => { C.keepFolderName = !e.target.checked; } }),
    ` Also rename the Drive folder “${C.work.name}” to “${name}” (and its photos named after it)`) : '');
}

/** The archive tab's changes, as the row endpoint takes them. */
function archiveChanges() {
  const edits = { ...(C.edits || {}) };
  const row = C.work.row;
  const inFolder = new Set(C.work.photos.map((p) => p.id));
  const before = (row?.websitePhotos || []).filter((id) => inFolder.has(id));
  if (C.starred.join() !== before.join()) edits.websitePhotos = C.starred;
  if (C.onWebsite !== (row?.onWebsite ?? C.work.website.live)) edits.onWebsite = C.onWebsite;
  const { changes, base } = rowChanges(row, edits);
  const rename = C.keepFolderName !== true ? renameTo() : null;
  return { changes, base, rename };
}

async function saveArchive({ quiet = false } = {}) {
  const { changes, base, rename } = archiveChanges();
  if (!Object.keys(changes).length && !rename) {
    C.dirty.archive = false;
    return true;
  }
  const w = C.work;
  const out = await api('/api/archive/row', { method: 'POST', body: JSON.stringify({ folderId: w.folderId, sig: w.sig, changes, base, rename }) });
  if (out.row) w.row = out.row;
  if (out.name) {
    const from = w.name;
    w.name = out.name;
    w.path = [...w.path.slice(0, -1), out.name];
    try {
      await renamePhotos(w, { mode: 'retitle', from });
    } catch (e) {
      console.error(e);
      toast(`The folder was renamed, but not all its photos: ${e.message}`, 'error');
    }
  }
  if (!w.website.live) w.title = w.row?.workingTitle || parseWorkFolder(w.name).title;
  C.edits = {};
  C.keepFolderName = false;
  C.dirty.archive = false;
  invalidateArchive();
  if (!quiet) toast('Saved in the Sheet.', 'ok', 5000);
  return true;
}

/**
 * Renames photos in the work's folder on the Worker (see /api/archive/names),
 * asking again while some are left. Updates the names on the card.
 */
async function renamePhotos(w, body) {
  for (let i = 0; i < 50; i++) {
    const out = await api('/api/archive/names', { method: 'POST', body: JSON.stringify({ folderId: w.folderId, sig: w.sig, ...body }) });
    const names = new Map(out.renamed.map((r) => [r.id, r.name]));
    for (const p of w.photos) if (names.has(p.id)) p.name = names.get(p.id);
    if (!out.left || !out.renamed.length) return;
  }
}

/** "Tidy names": every photo not named by the scheme gets the next free number, by capture time. */
async function tidyNames() {
  const n = untidyPhotos(C.work).length;
  const title = parseWorkFolder(C.work.name).title;
  if (C.busy || !confirm(`Rename ${plural(n, 'photo')} to “${title} - NN”, in the order they were taken? Each photo's old name is kept in its Drive description.`)) return;
  setBusy(true);
  try {
    await renamePhotos(C.work, { mode: 'tidy' });
    toast('Photo names tidied.', 'ok', 5000);
  } catch (e) {
    console.error(e);
    toast(e.message, 'error');
  }
  setBusy(false);
  await refresh();
}

/**
 * items: [{ name, type, put: (folderId, name, note) => Promise<{id}> }], in
 * the order chosen. Each goes into the work's Drive folder as the Worker
 * names it ("<title> - NN.ext"), its own name kept in the description.
 */
async function addPhotos(items) {
  if (!items.length || C.busy) return;
  const w = C.work;
  const box = () => document.getElementById('drive-notices');
  setBusy(true);
  let names;
  try {
    // The Worker checks that the folder is (still) inside the archive before anything is uploaded, and names the photos.
    ({ names } = await api('/api/archive/upload-target', {
      method: 'POST', body: JSON.stringify({ folderId: w.folderId, sig: w.sig, files: items.map((it) => ({ name: it.name, type: it.type })) }),
    }));
  } catch (e) {
    setBusy(false);
    return toast(e.message, 'error');
  }
  const ids = [];
  for (const [i, it] of items.entries()) {
    toast(`Adding photo ${i + 1} of ${items.length} to Drive…`, 'info');
    try {
      ids.push((await it.put(w.folderId, names[i] || it.name, originalNote(it.name))).id);
    } catch (e) {
      console.error(e);
      notice(box(), `“${it.name}” could not be added to Drive: ${e.message}`);
    }
  }
  // Another upload into this folder at the same time may have taken the same numbers: those move up.
  if (ids.length) await renamePhotos(w, { mode: 'settle', ids }).catch((e) => console.error('settle names', e));
  setBusy(false);
  const done = ids.length;
  if (!done) return;
  toast(`${plural(done, 'photo')} added to the Drive folder.`, 'ok', 6000);
  await refresh();
}

async function copyFromDrive() {
  try {
    const picked = await pickFromDrive();
    await addPhotos(picked.map((f) => ({ name: f.name, type: f.mimeType, put: (id, name, note) => copyToFolder(f.id, id, name, note) })));
  } catch (e) {
    if (e.cancelled) return;
    console.error(e);
    toast('Google Drive could not be opened. Check that pop-ups are allowed for this page, then try again.', 'error');
  }
}

/** Reloads the archive and reopens this card, keeping unsaved edits. */
async function refresh() {
  const keep = C;
  const data = await loadArchive(true);
  const work = data.works.find((x) => x.folderId === keep.work.folderId);
  if (!work || C !== keep) return;
  open(work, data, keep.tab);
  for (const k of ['edits', 'keepFolderName']) C[k] = keep[k];
  if (keep.dirty.archive) { C.starred = keep.starred.filter((id) => C.web[id]); C.onWebsite = keep.onWebsite; C.dirty.archive = true; }
  if (keep.dirty.web) {
    for (const [id, s] of Object.entries(keep.web)) if (C.web[id]) Object.assign(C.web[id], { alt: s.alt, focal: s.focal, focalTouched: s.focalTouched });
    C.original = keep.original;
    C.webValues = readPublicFields(keep.original).data;
    C.dirty.web = true;
  }
  render();
}

// ------------------------------------------------------------ website tab

function websitePane() {
  const w = C.work;
  const s = w.website;
  const toggle = h('label', { class: 'switch-row' },
    h('input', {
      type: 'checkbox', role: 'switch', checked: C.onWebsite, disabled: C.data.readOnly,
      onchange: (e) => { C.onWebsite = e.target.checked; markDirty('archive'); render(); },
    }),
    h('span', {}, h('b', {}, 'Show on the website'),
      h('span', { class: 'hint' }, s.live
        ? ' Turning it off takes the work off arnenys.com when you press “Remove from website”. Nothing in Drive changes.'
        : ' Turn it on, choose what visitors see, then publish.')));
  const out = [h('section', { class: 'panel' }, toggle)];
  if (!C.onWebsite) return out;

  const o = C.webValues ? { ...C.original, ...C.webValues } : C.original;
  const onInput = () => { markDirty('web'); renderPreviewText(); };
  const legacy = s.live && !w.row?.publishedPhotos?.length;
  out.push(
    h('section', { class: 'panel' },
      h('h2', {}, 'What visitors see'),
      publicFields(o, onInput),
      h('p', { class: 'hint' }, s.slug && s.live
        ? h('span', {}, 'Web address: ', h('a', { href: `https://www.arnenys.com/artworks/${s.slug}/`, target: '_blank', rel: 'noopener' }, `arnenys.com/artworks/${s.slug}/`), ' (stays the same).')
        : 'The web address is made from the title when the work is first published.'),
    ),
    h('section', { class: 'panel' },
      h('h2', {}, 'Photos on the website'),
      h('p', { class: 'hint' }, 'Drag to reorder; the first is the cover in the grid. To add one, star it on the Archive tab.'),
      legacy && s.data?.gallery?.length
        ? h('p', { class: 'notice warn' }, `The website now shows ${plural(s.data.gallery.length, 'photo')} that ${s.data.gallery.length === 1 ? 'is' : 'are'} not linked to this Drive folder. Publishing replaces ${s.data.gallery.length === 1 ? 'it' : 'them'} with the starred photos.`)
        : null,
      h('ul', { class: 'photos', id: 'photos' }),
    ),
    h('section', { class: 'panel', id: 'crop-panel', 'aria-labelledby': 'crop-title' }),
    s.reasons.length && s.live ? h('p', { class: 'notice' }, `Not published yet: ${s.reasons.join('; ').toLowerCase()}.`) : null,
    w.row?.lastPublished ? h('p', { class: 'hint' }, `Last published ${new Date(w.row.lastPublished).toLocaleString()}.`) : null,
    previewLink(),
  );
  return out;
}

const webList = () => C.starred.map((id) => C.web[id]).filter(Boolean);

function renderWebPhotos() {
  const list = document.getElementById('photos');
  if (!list) return;
  const photos = webList();
  const changed = () => {
    C.starred = photos.map((p) => p.key);
    markDirty('archive');
    markDirty('web');
    renderWebPhotos();
  };
  renderPhotoList(list, photos, {
    url: (p) => p.thumb,
    badge: (p) => (p.src ? null : 'New'),
    empty: 'No photos starred yet.',
    onChange: changed,
    onText: () => markDirty('web'),
    removeLabel: 'Remove from website',
    onRemove: (p) => { photos.splice(photos.indexOf(p), 1); changed(); },
  });
  renderCrop(document.getElementById('crop-panel'), photos[0], photos[0]?.thumb, () => markDirty('web'));
  renderPreviewPhotos(photos.map((p) => p.thumb));
}

// ------------------------------------------------------------------ bar

function actionBar() {
  return h('div', { class: 'action-bar' },
    h('span', { id: 'save-state', class: 'save-state' }),
    h('span', { class: 'bar-buttons' },
      h('button', { class: 'btn', id: 'save-btn', type: 'button', onclick: () => run(() => saveArchive()) }, 'Save'),
      h('button', { class: 'btn primary', id: 'publish-btn', type: 'button', onclick: publishClicked }),
    ),
  );
}

function updateBar() {
  const st = document.getElementById('save-state');
  if (!st) return;
  const { archive, web } = C.dirty;
  st.textContent = C.busy ? 'Working…'
    : archive && web ? 'Not saved yet'
      : archive ? 'Not saved in the Sheet yet'
        : web ? 'Website changes not published yet'
          : 'Saved';
  st.className = `save-state${archive || web ? ' pending' : ''}`;
  document.getElementById('save-btn').disabled = C.busy || !archive;
  const btn = document.getElementById('publish-btn');
  const action = publishAction(C.onWebsite, C.work.website.live);
  btn.hidden = !action;
  btn.textContent = action?.label || '';
  btn.disabled = C.busy;
}

function setBusy(on) {
  C.busy = on;
  document.body.classList.toggle('busy', on);
  updateBar();
}

async function run(fn) {
  if (C.busy) return;
  setBusy(true);
  try {
    await fn();
  } catch (e) {
    toast(e.status === 409 || e.plain ? e.message : `Not saved: ${e.message}`, 'error');
  } finally {
    if (C) {
      setBusy(false);
      render();
    }
  }
}

// --------------------------------------------------------------- publish

function publishClicked() {
  const action = publishAction(C.onWebsite, C.work.website.live);
  if (action?.id === 'unpublish') {
    if (!confirm(`Take “${C.work.website.title}” off the website? Its photos stay in Drive.`)) return;
    return run(unpublish);
  }
  if (action?.id === 'publish') return run(publish);
}

/**
 * Starred photos the site does not have yet are read from Drive through the
 * Worker, made fit for the site in the browser (HEIC converted, metadata
 * removed: prepare.js) and uploaded as blobs; then one request commits the
 * work and records the publish in the Sheet.
 */
async function publish() {
  const w = C.work;
  // The Website tab's fields are on the page (hidden or not) whenever the work is "on".
  const { data: fields, problems } = readPublicFields(C.original);
  C.webValues = fields;
  if (!C.starred.length) problems.push('Star at least one photo for the website (Archive tab).');
  if (problems.length) {
    C.tab = 'website';
    throw Object.assign(new Error(problems.join(' ')), { plain: true });
  }
  await saveArchive({ quiet: true });

  const { gallery, uploads } = planGallery(w, C.starred, C.web);
  const newImages = {};
  for (const [i, id] of uploads.entries()) {
    const p = C.web[id];
    toast(`Preparing photo ${i + 1} of ${uploads.length} for the website…`, 'info');
    if (!p.blob) {
      const res = await fetch(p.thumb.replace('/thumb/', '/original/'), { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`“${p.name}” could not be read from Drive.`);
      let out;
      try {
        out = await preparePhoto(await res.blob(), p.name);
      } catch (e) {
        throw new Error(e instanceof PhotoProblem ? e.message : `“${p.name}”: ${e.message}`);
      }
      p.blob = { sha: (await uploadBlob(out.bytes)).sha, ext: out.ext };
    }
    newImages[id] = p.blob;
  }
  toast('Publishing…', 'info');
  const { title, year, description, medium, dimensions, status } = fields;
  const res = await api('/api/archive/publish', {
    method: 'POST',
    body: JSON.stringify({
      folderId: w.folderId, sig: w.sig, photos: C.starred,
      work: { baseSha: w.website.sha, data: { title, year, description, medium, dimensions, status, gallery }, newImages },
    }),
  });
  finish(res, 'Published');
}

async function unpublish() {
  await saveArchive({ quiet: true });
  const w = C.work;
  const res = await api('/api/archive/publish', {
    method: 'POST', body: JSON.stringify({ folderId: w.folderId, sig: w.sig, off: true, work: { baseSha: w.website.sha } }),
  });
  finish(res, 'Removed from the website');
}

function finish(res, done) {
  C.result = res;
  if (res.dryRun) {
    toast(`Test mode: nothing was published (${plural(res.files.length, 'file')} would change).`, 'test');
    return;
  }
  C.dirty.web = false;
  C.webValues = null;
  for (const p of Object.values(C.web)) p.blob = null;
  window.dispatchEvent(new Event('site-changed'));
  toast(res.sheetError || `${done} — live in a few minutes.`, res.sheetError ? 'error' : 'ok', 12000);
  invalidateArchive();
  refresh().catch(() => {});
}

/** What a publish did (or, in test mode, would do). */
function resultPanel(r) {
  const sheet = Object.entries(r.sheet || {}).map(([k, v]) => `${COLUMNS.find((c) => c.key === k)?.header}: ${Array.isArray(v) ? v.map((x) => x.file || x).join(', ') : v ?? '—'}`);
  return h('section', { class: `panel publish-result${r.dryRun ? ' test' : ''}`, id: 'publish-result' },
    h('h2', {}, r.dryRun ? 'Test mode: this is what Publish would do' : r.noop ? 'The website already had this' : 'Published'),
    r.message ? h('pre', { class: 'commit-msg' }, r.message.trim()) : null,
    r.files?.length ? h('ul', { class: 'file-list' }, r.files.map((f) => h('li', {}, h('span', { class: `act ${f.action}` }, f.action === 'delete' ? 'remove' : 'write'), ' ', f.path))) : null,
    h('p', { class: 'hint' }, r.dryRun ? 'Then the Sheet would get: ' : 'The Sheet now has: ', sheet.join(' · ')),
    h('button', { class: 'btn small quiet', type: 'button', onclick: () => { C.result = null; render(); } }, 'Close'),
  );
}
