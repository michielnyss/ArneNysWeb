// The editor UI. Plain DOM, no framework: the website's works (grid, one
// work) and Arne's archive (archive.js), switched by the URL hash so the
// browser's Back button works.

import Sortable from 'sortablejs';
import { compareWorks, newWorkData, NEW_WORK_ORDER } from '../shared/artwork.js';
import { $app, api, clearToast, h, notice, toast, uploadBlob } from './dom.js';
import { isListHash, showArchive, showNewWork } from './archive.js';
import { leaveWork, showArchiveWork } from './work.js';
import { configureDrive, pickFromDrive, pickerAvailable } from './drive.js';
import {
  field, gridFrame, pagePreview, previewLink, publicFields, readPublicFields, renderCrop, renderPhotoList,
  renderPreviewPhotos, renderPreviewText,
} from './editor.js';
import { preparePhoto, PhotoProblem } from './prepare.js';

const S = {
  session: null,
  head: null,
  works: [], // [{slug, sha, data}]
  assets: {},
  pendingOrder: null, // [slug] while a drag-reorder is unsaved
  draft: null,
  busy: false,
};

// ------------------------------------------------------------------ helpers

/** A repo photo through the Worker (the repo may be private), pinned to the commit. */
function photoUrl(src) {
  const path = String(src).replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
  return `/api/photo/${S.head}/${path}`;
}

function workBySlug(slug) {
  return S.works.find((w) => w.slug === slug);
}

function sortedWorks() {
  return [...S.works].sort(compareWorks);
}

/** Which screen is showing; the list and the page preview use the site's own look. */
function setScreen(name) {
  document.body.dataset.screen = name;
}

function setDirty(on) {
  if (S.draft) S.draft.dirty = on;
  const st = document.getElementById('save-state');
  if (st && on) { st.textContent = 'Not saved yet'; st.className = 'save-state pending'; }
  const btn = document.getElementById('save-btn');
  if (btn) btn.disabled = !on || S.busy;
}

window.addEventListener('beforeunload', (e) => {
  if (S.draft?.dirty || S.pendingOrder || S.busy) { e.preventDefault(); e.returnValue = ''; }
});

// ------------------------------------------------------------------ boot

async function boot() {
  try {
    S.session = await api('/api/session');
    configureDrive(S.session.google, S.session.devUpload);
    document.getElementById('who').textContent = S.session.name;
    if (S.session.dryRun) document.getElementById('test-banner').hidden = false;
    if (S.session.archive) document.getElementById('top-nav').hidden = false;
    await loadWorks();
    window.addEventListener('hashchange', route);
    route();
  } catch (e) {
    $app().replaceChildren(h('div', { class: 'panel error-panel narrow' }, h('h2', {}, 'The editor could not start'), h('p', {}, e.message),
      h('button', { class: 'btn', onclick: () => location.reload() }, 'Try again')));
  }
}

async function loadWorks() {
  const out = await api('/api/works');
  S.head = out.head;
  S.works = out.works;
  S.assets = out.assets;
}

function route() {
  const hash = location.hash || '#/';
  clearToast();
  if (!leaveWork(hash)) return; // the archive's work card, if one is open with changes
  if (hash.startsWith('#/work/')) return showEditor(decodeURIComponent(hash.slice(7)));
  if (hash === '#/new') return showEditor(null);
  if (isListHash(hash) || hash.startsWith('#/archive/')) {
    if (!leaveEditor()) return;
    setScreen('archive');
    if (isListHash(hash)) return showArchive();
    if (hash === '#/archive/new') return showNewWork();
    return showArchiveWork(decodeURIComponent(hash.slice(10)));
  }
  return showList();
}

/** Leaving a work: asks first if it has unsaved changes (and stays if so). */
function leaveEditor() {
  if (S.draft?.dirty && !leaveDraftOk()) {
    history.replaceState(null, '', S.draft.slug ? `#/work/${encodeURIComponent(S.draft.slug)}` : '#/new');
    return false;
  }
  disposeDraft();
  return true;
}

function leaveDraftOk() {
  if (!S.draft?.dirty) return true;
  return confirm('You have changes that are not saved. Leave without saving them?');
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

// ------------------------------------------------------------------ list

function showList() {
  if (!leaveEditor()) return;
  setScreen('list');
  document.title = 'Works | arnenys.com admin';
  // The works as the home page grid shows them: same columns, tiles, crop and captions.
  const list = h('ol', { class: 'site-grid', 'aria-label': 'All works, in the order of the website grid' });
  const order = (S.pendingOrder || sortedWorks().map((w) => w.slug)).filter((slug) => workBySlug(slug));
  order.forEach((slug, i) => {
    const w = workBySlug(slug);
    const cover = w.data.gallery?.[0];
    const title = w.data.title || 'Untitled';
    list.append(
      h('li', { class: 'tile', 'data-slug': w.slug },
        h('a', {
          class: 'tile-link', href: `#/work/${encodeURIComponent(w.slug)}`, draggable: 'false',
          onclick: (e) => { e.preventDefault(); if (Date.now() - dragEndedAt > 300) openWork(w.slug); },
        },
          cover ? gridFrame(photoUrl(cover.src), cover.focalPoint) : h('div', { class: 'site-frame empty' }, h('span', {}, 'No photo yet')),
          h('span', { class: 'site-caption' }, title),
        ),
        h('span', { class: 'tile-tools' },
          h('button', { class: 'icon-btn move-earlier', type: 'button', title: 'Move earlier', 'aria-label': `Move "${title}" earlier`, disabled: i === 0, onclick: () => nudge(w.slug, -1) }),
          h('button', { class: 'icon-btn move-later', type: 'button', title: 'Move later', 'aria-label': `Move "${title}" later`, disabled: i === order.length - 1, onclick: () => nudge(w.slug, 1) }),
        ),
      ),
    );
  });

  const orderBar = h('div', { class: 'action-bar', id: 'order-bar', hidden: !S.pendingOrder },
    h('span', { class: 'save-state pending' }, 'Order not saved'),
    h('span', { class: 'bar-buttons' },
      h('button', { class: 'btn quiet', onclick: () => { S.pendingOrder = null; showList(); } }, 'Undo'),
      h('button', { class: 'btn primary', id: 'save-order', onclick: saveOrder }, 'Save order'),
    ),
  );

  $app().replaceChildren(
    h('div', { class: 'list-head narrow' },
      h('div', {},
        h('h1', {}, 'Works'),
      ),
      h('button', { class: 'btn primary', onclick: () => { if (confirmDiscardOrder()) go('#/new'); } }, '+ Add a new work'),
    ),
    h('div', { class: 'site site-wrap site-home' }, list),
    orderBar,
  );

  Sortable.create(list, {
    animation: 150,
    ghostClass: 'drag-ghost',
    filter: '.tile-tools',
    preventOnFilter: false,
    // On a phone a short press scrolls; press and hold to pick a work up.
    delay: 200,
    delayOnTouchOnly: true,
    onEnd: () => {
      dragEndedAt = Date.now();
      S.pendingOrder = [...list.children].map((li) => li.dataset.slug);
      if (S.pendingOrder.join() === sortedWorks().map((w) => w.slug).join()) S.pendingOrder = null;
      document.getElementById('order-bar').hidden = !S.pendingOrder;
    },
  });
}

function nudge(slug, dir) {
  const order = S.pendingOrder ? [...S.pendingOrder] : sortedWorks().map((w) => w.slug);
  const i = order.indexOf(slug);
  const j = i + dir;
  if (j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  S.pendingOrder = order.join() === sortedWorks().map((w) => w.slug).join() ? null : order;
  const y = window.scrollY;
  showList();
  window.scrollTo(0, y);
  const tools = document.querySelector(`[data-slug="${CSS.escape(slug)}"] .tile-tools`);
  const btn = tools?.querySelector(dir < 0 ? '.move-earlier' : '.move-later');
  (btn && !btn.disabled ? btn : tools?.querySelector('button:not(:disabled)'))?.focus();
}

let dragEndedAt = 0;

function confirmDiscardOrder() {
  if (!S.pendingOrder) return true;
  if (!confirm('The new order is not saved yet. Forget it?')) return false;
  S.pendingOrder = null;
  return true;
}

function openWork(slug) {
  if (!confirmDiscardOrder()) return;
  go(`#/work/${encodeURIComponent(slug)}`);
}

async function saveOrder() {
  const works = [];
  S.pendingOrder.forEach((slug, i) => {
    const w = workBySlug(slug);
    if (w && w.data.order !== i) works.push({ slug, baseSha: w.sha, data: { order: i } });
  });
  await runSave({ works }, 'the new order', () => { S.pendingOrder = null; showList(); });
}

// ---------------------------------------------------------------- editor

let photoSeq = 0;

function disposeDraft() {
  for (const p of S.draft?.photos || []) if (p.preview) URL.revokeObjectURL(p.preview);
  S.draft = null;
}

function showEditor(slug) {
  const w = slug ? workBySlug(slug) : null;
  if (slug && !w) {
    setScreen('editor');
    $app().replaceChildren(h('div', { class: 'panel narrow' }, h('p', {}, 'This work no longer exists. It may have been deleted.'),
      h('a', { class: 'btn', href: '#/' }, '← All works')));
    return;
  }
  if (!(S.draft && S.draft.slug === slug && S.draft.dirty)) {
    disposeDraft();
    const d = w ? w.data : newWorkData();
    S.draft = {
      slug,
      baseSha: w?.sha ?? null,
      original: d,
      // focal: the photo's crop centre as stored (undefined if none);
      // focalTouched: the crop editor changed it, so the save sends it.
      photos: (d.gallery || []).map((g) => ({ key: ++photoSeq, src: g.src, alt: g.alt ?? '', focal: g.focalPoint, focalTouched: false })),
      dirty: false,
    };
  }
  setScreen('editor');
  renderEditor();
}

function renderEditor() {
  const D = S.draft;
  const o = D.original;
  const isNew = !D.slug;
  document.title = `${isNew ? 'New work' : o.title} | arnenys.com admin`;
  const onInput = () => { setDirty(true); renderPreviewText(); };
  const order = h('input', { id: 'f-order', type: 'number', inputmode: 'numeric', step: 1, value: o.order ?? NEW_WORK_ORDER, oninput: onInput });

  const fileInput = h('input', {
    type: 'file', accept: 'image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif', multiple: true, hidden: true,
    onchange: (e) => { addFiles([...e.target.files].map((f) => ({ name: f.name, size: f.size, get: async () => f }))); e.target.value = ''; },
  });
  const driveBtn = pickerAvailable()
    ? h('button', { class: 'btn', type: 'button', onclick: addFromDrive }, h('span', { class: 'drive-icon', 'aria-hidden': 'true' }), 'Google Drive')
    : null;

  const form = h('form', { class: 'editor narrow', onsubmit: (e) => { e.preventDefault(); saveDraft(); } },
    h('a', { class: 'back', href: '#/' }, '← All works'),
    h('h1', {}, isNew ? 'New work' : o.title),
    !isNew ? h('p', { class: 'lede' }, h('a', { href: `https://www.arnenys.com/artworks/${D.slug}/`, target: '_blank', rel: 'noopener' }, 'On the website ↗')) : null,
    h('section', { class: 'panel' }, publicFields(o, onInput)),
    h('section', { class: 'panel' },
      h('h2', {}, 'Photos'),
      h('ul', { class: 'photos', id: 'photos' }),
      h('div', { id: 'photo-notices', 'aria-live': 'polite' }),
      h('div', { class: 'add-photos' },
        driveBtn,
        h('button', { class: 'btn', type: 'button', onclick: () => fileInput.click() }, 'Upload'),
        fileInput,
      ),
    ),
    h('section', { class: 'panel', id: 'crop-panel', 'aria-labelledby': 'crop-title' }),
    h('section', { class: 'panel' }, field('Position', order, 'f-order')),
    !isNew ? h('section', { class: 'panel danger-zone' },
      h('h2', {}, 'Delete'),
      h('button', { class: 'btn danger', type: 'button', onclick: deleteWork }, `Delete "${o.title}"`),
    ) : null,
    previewLink(),
    h('div', { class: 'action-bar' },
      h('span', { id: 'save-state', class: 'save-state' }, D.dirty ? 'Not saved yet' : isNew ? 'New, not saved yet' : 'No changes'),
      h('span', { class: 'bar-buttons' },
        h('a', { class: 'btn quiet', href: '#/' }, 'Back'),
        h('button', { class: 'btn primary', id: 'save-btn', type: 'submit', disabled: !D.dirty && !isNew }, 'Save'),
      ),
    ),
  );

  $app().replaceChildren(form, pagePreview());
  renderPhotos();
  if (isNew) document.getElementById('f-title').focus();
}

const photoSrc = (p) => p.preview || photoUrl(p.src);

function renderPhotos() {
  const list = document.getElementById('photos');
  if (!list) return;
  const D = S.draft;
  const changed = () => { renderPhotos(); setDirty(true); };
  renderPhotoList(list, D.photos, {
    url: photoSrc,
    badge: (p) => (p.preview ? (p.converted ? 'New · converted' : 'New') : null),
    onChange: changed,
    onText: () => setDirty(true),
    onRemove: (p) => {
      if (!p.preview && !confirm('Remove this photo from the work? It will be deleted when you save.')) return;
      D.photos.splice(D.photos.indexOf(p), 1);
      if (p.preview) URL.revokeObjectURL(p.preview);
      changed();
    },
  });
  renderCrop(document.getElementById('crop-panel'), D.photos[0], D.photos[0] && photoSrc(D.photos[0]), () => setDirty(true));
  renderPreviewPhotos(D.photos.filter((p) => p.state !== 'working' && (p.src || p.preview)).map(photoSrc));
}

const photoNotice = (text) => notice(document.getElementById('photo-notices'), text);

/** items: [{name, size, get: () => Promise<Blob>}] */
async function addFiles(items) {
  const D = S.draft;
  for (const it of items) {
    if (it.size > 20 * 1024 * 1024) {
      photoNotice(`"${it.name}" is ${Math.round(it.size / 1048576)} MB. Photos can be at most 20 MB. Please pick a smaller version.`);
      continue;
    }
    const p = { key: ++photoSeq, src: null, alt: '', state: 'working' };
    D.photos.push(p);
    renderPhotos();
    try {
      const blob = await it.get();
      const out = await preparePhoto(blob, it.name);
      if (S.draft !== D) return; // user left the page meanwhile
      p.bytes = out.bytes;
      p.ext = out.ext;
      p.converted = out.converted;
      p.preview = URL.createObjectURL(new Blob([out.bytes], { type: out.type }));
      p.state = 'ready';
      setDirty(true);
    } catch (e) {
      D.photos.splice(D.photos.indexOf(p), 1);
      photoNotice(e instanceof PhotoProblem ? e.message : `"${it.name}" could not be added (${e.message}). Please try again.`);
    }
    renderPhotos();
  }
}

async function addFromDrive() {
  try {
    const picked = await pickFromDrive();
    if (!picked.length) return;
    addFiles(picked.map((f) => ({ name: f.name, size: f.sizeBytes, get: f.file })));
  } catch (e) {
    if (e.cancelled) return;
    console.error(e);
    photoNotice('Google Drive could not be opened. Check that pop-ups are allowed for this page, then try again.');
  }
}

function readDraft() {
  const D = S.draft;
  const o = D.original;
  const { data, problems } = readPublicFields(o);
  data.gallery = D.photos.map((p) => {
    const item = { src: p.src || `new:${p.key}`, alt: p.src && p.alt === (o.gallery?.find((g) => g.src === p.src)?.alt ?? '') ? p.alt : p.alt.trim() };
    // Only a crop Arne changed is sent; the server leaves the rest as stored
    // (and leaves a centred crop out of a photo that never had one).
    if (p.focalTouched) item.focalPoint = p.focal ?? null;
    return item;
  });
  if (D.photos.some((p) => p.state === 'working')) problems.push('Please wait until all photos are ready.');
  return { data, problems };
}

async function saveDraft() {
  if (S.busy) return;
  const D = S.draft;
  const { data, problems } = readDraft();
  if (problems.length) return toast(problems.join(' '), 'error');
  const fresh = D.photos.filter((p) => !p.src);
  const newImages = {};
  S.busy = true;
  setBusy(true);
  try {
    for (let i = 0; i < fresh.length; i++) {
      toast(`Uploading photo ${i + 1} of ${fresh.length}…`, 'info');
      const p = fresh[i];
      if (!p.blobSha) p.blobSha = (await uploadBlob(p.bytes)).sha;
      newImages[p.key] = { sha: p.blobSha, ext: p.ext };
    }
  } catch (e) {
    S.busy = false;
    setBusy(false);
    return toast(`A photo could not be uploaded: ${e.message} Nothing was saved. Please try again.`, 'error');
  }
  S.busy = false;
  await runSave({ works: [{ slug: D.slug, baseSha: D.baseSha, data, newImages }] }, `"${data.title}"`, (res) => {
    const slug = res.changed?.find((c) => c.action === 'add')?.slug || D.slug;
    D.dirty = false;
    go(`#/work/${encodeURIComponent(slug)}`);
  });
}

async function deleteWork() {
  const D = S.draft;
  const title = D.original.title;
  if (!confirm(`Delete "${title}" and all its photos from the website?`)) return;
  await runSave({ works: [], deletes: [{ slug: D.slug, baseSha: D.baseSha }] }, `the deletion of "${title}"`, () => {
    D.dirty = false;
    go('#/');
  });
}

function setBusy(on) {
  document.querySelectorAll('#save-btn, #save-order, .danger').forEach((b) => (b.disabled = on));
  document.body.classList.toggle('busy', on);
}

async function runSave(payload, what, after) {
  S.busy = true;
  setBusy(true);
  toast('Saving…', 'info');
  try {
    const res = await api('/api/save', { method: 'POST', body: JSON.stringify(payload) });
    if (res.dryRun) {
      const n = res.files?.length || 0;
      toast(`Test mode: not published (${n} file${n === 1 ? '' : 's'}).`, 'test');
      console.info('Dry run', res);
      S.busy = false;
      setBusy(false);
      return;
    }
    if (res.noop) {
      toast('No changes.', 'ok', 5000);
      S.busy = false;
      setBusy(false);
      if (S.draft) setDirty(false);
      return;
    }
    await loadWorks();
    S.busy = false;
    setBusy(false);
    after(res);
    toast('Saved. Live in a few minutes.', 'ok', 12000);
  } catch (e) {
    S.busy = false;
    setBusy(false);
    if (S.draft) setDirty(S.draft.dirty);
    toast(e.status === 409 ? e.message : `Not saved: ${e.message}`, 'error');
  }
}

// A publish from the archive changed the site: the grid reloads its works.
window.addEventListener('site-changed', () => { loadWorks().catch(() => {}); });

boot();
