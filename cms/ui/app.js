// The editor UI. Plain DOM, no framework: two screens (all works, one work),
// switched by the URL hash so the browser's Back button works.

import Sortable from 'sortablejs';
import {
  compareWorks, newWorkData, NEW_WORK_ORDER, STATUS_OPTIONS, YEAR_MAX, YEAR_MIN,
} from '../shared/artwork.js';
import { configureDrive, driveAvailable, pickFromDrive } from './drive.js';
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

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

const $app = () => document.getElementById('app');

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    credentials: 'same-origin',
  });
  let body = null;
  try { body = await res.json(); } catch {}
  if (res.status === 401 || res.status === 403) {
    if (!body) throw new Error('You have been signed out. Reload the page to sign in again.');
  }
  if (!res.ok) throw Object.assign(new Error(body?.error || `Something went wrong (${res.status}).`), { status: res.status });
  return body;
}

function photoUrl(src) {
  return `https://raw.githubusercontent.com/${S.session.repo}/${S.head}${src}`;
}

function workBySlug(slug) {
  return S.works.find((w) => w.slug === slug);
}

function sortedWorks() {
  return [...S.works].sort(compareWorks);
}

function metaLine(d) {
  return [d.year ?? '', d.dimensions || ''].filter(Boolean).join(' · ');
}

// ------------------------------------------------------------- status bar

let toastTimer = null;
function toast(text, kind = 'info', ms = 0) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => (el.className = 'toast'), ms);
}
function clearToast() {
  document.getElementById('toast').className = 'toast';
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
    if (S.session.google) configureDrive(S.session.google);
    document.getElementById('who').textContent = S.session.name;
    if (S.session.dryRun) document.getElementById('test-banner').hidden = false;
    await loadWorks();
    window.addEventListener('hashchange', route);
    route();
  } catch (e) {
    $app().replaceChildren(h('div', { class: 'panel error-panel' }, h('h2', {}, 'The editor could not start'), h('p', {}, e.message),
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
  if (hash.startsWith('#/work/')) return showEditor(decodeURIComponent(hash.slice(7)));
  if (hash === '#/new') return showEditor(null);
  return showList();
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
  if (S.draft?.dirty && !leaveDraftOk()) {
    history.replaceState(null, '', S.draft.slug ? `#/work/${encodeURIComponent(S.draft.slug)}` : '#/new');
    return;
  }
  disposeDraft();
  document.title = 'Works — arnenys.com admin';
  const list = h('ol', { class: 'works', 'aria-label': 'All works, in the order of the website grid' });
  const order = S.pendingOrder || sortedWorks().map((w) => w.slug);
  for (const slug of order) {
    const w = workBySlug(slug);
    if (!w) continue;
    const cover = w.data.gallery?.[0];
    list.append(
      h('li', { class: 'work', 'data-slug': w.slug },
        h('span', { class: 'handle', title: 'Drag to move', 'aria-hidden': 'true' }, '⠿'),
        h('button', { class: 'work-open', onclick: () => openWork(w.slug) },
          cover ? h('img', { class: 'thumb', src: photoUrl(cover.src), alt: '', loading: 'lazy', decoding: 'async' }) : h('span', { class: 'thumb empty' }, 'No photo'),
          h('span', { class: 'work-text' },
            h('span', { class: 'work-title' }, w.data.title || 'Untitled'),
            h('span', { class: 'work-meta' }, metaLine(w.data)),
            w.data.status ? h('span', { class: `badge ${w.data.status.toLowerCase()}` }, w.data.status) : null,
          ),
        ),
        h('span', { class: 'move' },
          h('button', { class: 'icon-btn', title: 'Move up', 'aria-label': `Move ${w.data.title} up`, onclick: () => nudge(w.slug, -1) }, '↑'),
          h('button', { class: 'icon-btn', title: 'Move down', 'aria-label': `Move ${w.data.title} down`, onclick: () => nudge(w.slug, 1) }, '↓'),
        ),
      ),
    );
  }

  const orderBar = h('div', { class: 'action-bar', id: 'order-bar', hidden: !S.pendingOrder },
    h('span', { class: 'save-state pending' }, 'The order has changed, but is not saved yet.'),
    h('span', { class: 'bar-buttons' },
      h('button', { class: 'btn quiet', onclick: () => { S.pendingOrder = null; showList(); } }, 'Undo'),
      h('button', { class: 'btn primary', id: 'save-order', onclick: saveOrder }, 'Save order'),
    ),
  );

  $app().replaceChildren(
    h('div', { class: 'list-head' },
      h('div', {},
        h('h1', {}, 'Works'),
        h('p', { class: 'lede' }, 'Tap a work to change it. To change the order on the website, drag a work by ', h('span', { class: 'handle-inline' }, '⠿'), ' or use the arrows. The top of this list is the top of the website.'),
      ),
      h('button', { class: 'btn primary', onclick: () => { if (confirmDiscardOrder()) go('#/new'); } }, '+ Add a new work'),
    ),
    list,
    orderBar,
  );

  Sortable.create(list, {
    handle: '.handle',
    animation: 150,
    ghostClass: 'drag-ghost',
    onEnd: () => {
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
  document.querySelector(`[data-slug="${CSS.escape(slug)}"] .move button:${dir < 0 ? 'first-child' : 'last-child'}`)?.focus();
}

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
    $app().replaceChildren(h('div', { class: 'panel' }, h('p', {}, 'This work no longer exists. It may have been deleted.'),
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
      photos: (d.gallery || []).map((g) => ({ key: ++photoSeq, src: g.src, alt: g.alt ?? '' })),
      dirty: false,
    };
  }
  renderEditor();
}

function field(label, hint, input, id) {
  return h('div', { class: 'field' },
    h('label', { for: id }, label),
    input,
    hint ? h('p', { class: 'hint', id: `${id}-hint` }, hint) : null,
  );
}

function renderEditor() {
  const D = S.draft;
  const o = D.original;
  const isNew = !D.slug;
  document.title = `${isNew ? 'New work' : o.title} — arnenys.com admin`;
  const onInput = () => setDirty(true);

  const title = h('input', { id: 'f-title', type: 'text', value: o.title, required: true, 'aria-describedby': 'f-title-hint', autocomplete: 'off', oninput: onInput });
  const year = h('input', { id: 'f-year', type: 'number', inputmode: 'numeric', min: YEAR_MIN, max: YEAR_MAX, step: 1, value: o.year ?? '', 'aria-describedby': 'f-year-hint', oninput: onInput });
  const dims = h('input', { id: 'f-dimensions', type: 'text', value: o.dimensions ?? '', 'aria-describedby': 'f-dimensions-hint', autocomplete: 'off', oninput: onInput });
  const medium = h('input', { id: 'f-medium', type: 'text', value: o.medium ?? '', 'aria-describedby': 'f-medium-hint', autocomplete: 'off', oninput: onInput });
  const desc = h('textarea', { id: 'f-description', rows: 5, 'aria-describedby': 'f-description-hint', oninput: onInput });
  desc.value = o.description ?? '';
  const order = h('input', { id: 'f-order', type: 'number', inputmode: 'numeric', step: 1, value: o.order ?? NEW_WORK_ORDER, 'aria-describedby': 'f-order-hint', oninput: onInput });

  const statusOpts = [...STATUS_OPTIONS];
  if (o.status && !statusOpts.some((s) => s.value === o.status)) statusOpts.push({ value: o.status, label: o.status });
  const status = h('div', { class: 'choices', role: 'radiogroup', 'aria-labelledby': 'status-label' },
    statusOpts.map((s) => h('label', { class: 'choice' },
      h('input', { type: 'radio', name: 'status', value: s.value, checked: (o.status ?? '') === s.value, onchange: onInput }),
      h('span', {}, s.label))));

  const photoList = h('ul', { class: 'photos', id: 'photos' });
  const notices = h('div', { id: 'photo-notices', 'aria-live': 'polite' });
  const fileInput = h('input', {
    type: 'file', accept: 'image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif', multiple: true, hidden: true,
    onchange: (e) => { addFiles([...e.target.files].map((f) => ({ name: f.name, size: f.size, get: async () => f }))); e.target.value = ''; },
  });

  const driveBtn = driveAvailable()
    ? h('button', { class: 'btn', type: 'button', onclick: addFromDrive }, h('span', { class: 'drive-icon', 'aria-hidden': 'true' }), 'Choose from Google Drive')
    : null;

  const form = h('form', { class: 'editor', onsubmit: (e) => { e.preventDefault(); saveDraft(); } },
    h('a', { class: 'back', href: '#/' }, '← All works'),
    h('h1', {}, isNew ? 'New work' : o.title),
    !isNew ? h('p', { class: 'lede' }, h('a', { href: `https://www.arnenys.com/artworks/${D.slug}/`, target: '_blank', rel: 'noopener' }, 'See it on the website ↗')) : null,

    h('section', { class: 'panel' },
      field('Title', 'The name of the work, as it should appear under the photo.', title, 'f-title'),
      h('div', { class: 'row' },
        field('Year', `The year you made it. This is also what the 2026 / 2025 / 2024 filter uses.`, year, 'f-year'),
        field('Size', 'Height × width, e.g. 120 × 90 cm. Add a third number for a sculpture: 60 × 55 × 30 cm.', dims, 'f-dimensions'),
      ),
      field('Material', 'What it is made of, e.g. Aluminium, or Plaster relief on panel. Leave empty if you would rather not say.', medium, 'f-medium'),
      h('div', { class: 'field' },
        h('span', { class: 'label', id: 'status-label' }, 'Sold?'),
        status,
        h('p', { class: 'hint' }, "Shown as a line under the year on the work's own page."),
      ),
      field('About this work', 'Optional. A few sentences shown under the size and year. Leave empty and nothing appears.', desc, 'f-description'),
    ),

    h('section', { class: 'panel' },
      h('h2', {}, 'Photos'),
      h('p', { class: 'hint' }, 'The first photo is the one shown in the grid on the home page. Drag to reorder, or use “Make cover”.'),
      photoList,
      notices,
      h('div', { class: 'add-photos' },
        driveBtn,
        h('button', { class: 'btn', type: 'button', onclick: () => fileInput.click() }, 'Upload from this device'),
        fileInput,
      ),
      h('p', { class: 'hint small' }, 'Photos are kept at full quality. Location and camera details are removed before they go online. iPhone (HEIC) photos are converted to high-quality JPEG. Up to 20 MB each.'),
    ),

    h('section', { class: 'panel' },
      field('Position in the grid', 'Lower numbers come first. A new work starts at −1 so it appears at the front — only change this if you want to move it. (Dragging in the list of works does this for you.)', order, 'f-order'),
    ),

    !isNew ? h('section', { class: 'panel danger-zone' },
      h('h2', {}, 'Delete this work'),
      h('p', { class: 'hint' }, 'Removes the work and its photos from the website. This cannot be undone here.'),
      h('button', { class: 'btn danger', type: 'button', onclick: deleteWork }, `Delete “${o.title}”`),
    ) : null,

    h('div', { class: 'action-bar' },
      h('span', { id: 'save-state', class: 'save-state' }, D.dirty ? 'Not saved yet' : isNew ? 'New — not saved yet' : 'No changes'),
      h('span', { class: 'bar-buttons' },
        h('a', { class: 'btn quiet', href: '#/' }, 'Back'),
        h('button', { class: 'btn primary', id: 'save-btn', type: 'submit', disabled: !D.dirty && !isNew }, 'Save'),
      ),
    ),
  );

  $app().replaceChildren(form);
  renderPhotos();
  Sortable.create(photoList, {
    animation: 150,
    handle: '.photo-img',
    ghostClass: 'drag-ghost',
    delay: 120,
    delayOnTouchOnly: true,
    onEnd: () => {
      const keys = [...photoList.children].map((li) => Number(li.dataset.key));
      S.draft.photos.sort((a, b) => keys.indexOf(a.key) - keys.indexOf(b.key));
      renderPhotos();
      setDirty(true);
    },
  });
  if (isNew) title.focus();
}

function renderPhotos() {
  const list = document.getElementById('photos');
  if (!list) return;
  const D = S.draft;
  list.replaceChildren(
    ...D.photos.map((p, i) =>
      h('li', { class: `photo${p.state === 'working' ? ' working' : ''}`, 'data-key': p.key },
        h('div', { class: 'photo-img', title: 'Drag to reorder' },
          p.state === 'working'
            ? h('span', { class: 'spinner-wrap' }, h('span', { class: 'spinner' }), 'Preparing…')
            : h('img', { src: p.preview || photoUrl(p.src), alt: '', loading: 'lazy' }),
          i === 0 ? h('span', { class: 'cover-badge' }, 'Cover') : null,
          p.preview ? h('span', { class: 'new-badge' }, p.converted ? 'New · converted' : 'New') : null,
        ),
        h('label', { class: 'alt-label', for: `alt-${p.key}` }, 'Description of the photo'),
        h('input', {
          id: `alt-${p.key}`, type: 'text', value: p.alt, placeholder: 'e.g. The work seen from the side',
          oninput: (e) => { p.alt = e.target.value; setDirty(true); },
        }),
        h('p', { class: 'hint small' }, 'Read aloud to visitors who cannot see the image. One short sentence is plenty.'),
        h('div', { class: 'photo-actions' },
          i > 0 ? h('button', { class: 'btn small', type: 'button', onclick: () => movePhoto(p, 0) }, 'Make cover') : null,
          i > 0 ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Move earlier', title: 'Move earlier', onclick: () => movePhoto(p, i - 1) }, '←') : null,
          i < D.photos.length - 1 ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Move later', title: 'Move later', onclick: () => movePhoto(p, i + 1) }, '→') : null,
          h('button', { class: 'btn small quiet', type: 'button', onclick: () => removePhoto(p) }, 'Remove'),
        ),
      ),
    ),
  );
  if (!D.photos.length) list.append(h('li', { class: 'photo-empty' }, 'No photos yet. Add one below — the work needs at least one to show in the grid.'));
}

function movePhoto(p, to) {
  const arr = S.draft.photos;
  arr.splice(arr.indexOf(p), 1);
  arr.splice(to, 0, p);
  renderPhotos();
  setDirty(true);
}

function removePhoto(p) {
  if (!p.preview && !confirm('Remove this photo from the work? It will be deleted when you save.')) return;
  const arr = S.draft.photos;
  arr.splice(arr.indexOf(p), 1);
  if (p.preview) URL.revokeObjectURL(p.preview);
  renderPhotos();
  setDirty(true);
}

function notice(text, kind = 'error') {
  const box = document.getElementById('photo-notices');
  if (!box) return;
  const n = h('div', { class: `notice ${kind}` }, h('span', {}, text), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Dismiss', onclick: () => n.remove() }, '×'));
  box.append(n);
}

/** items: [{name, size, get: () => Promise<Blob>}] */
async function addFiles(items) {
  const D = S.draft;
  for (const it of items) {
    if (it.size > 20 * 1024 * 1024) {
      notice(`“${it.name}” is ${Math.round(it.size / 1048576)} MB. Photos can be at most 20 MB — please pick a smaller version.`);
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
      notice(e instanceof PhotoProblem ? e.message : `“${it.name}” could not be added (${e.message}). Please try again.`);
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
    notice('Google Drive could not be opened. Check that pop-ups are allowed for this page, then try again.');
  }
}

function readDraft() {
  const D = S.draft;
  const o = D.original;
  const val = (id) => document.getElementById(id).value;
  // Keep the stored value byte-for-byte unless the user really changed it.
  const text = (id, orig) => {
    const v = val(id).trim();
    return v === String(orig ?? '').trim() ? orig ?? '' : v;
  };
  const yearRaw = val('f-year').trim();
  const orderRaw = val('f-order').trim();
  const data = {
    title: text('f-title', o.title),
    year: yearRaw === '' ? null : Number(yearRaw),
    order: orderRaw === '' ? NEW_WORK_ORDER : Number(orderRaw),
    description: (() => { const v = val('f-description'); return v.trim() === String(o.description ?? '').trim() ? o.description ?? '' : v.trim(); })(),
    medium: text('f-medium', o.medium),
    dimensions: text('f-dimensions', o.dimensions),
    status: document.querySelector('input[name=status]:checked')?.value ?? '',
    gallery: D.photos.map((p) => ({ src: p.src || `new:${p.key}`, alt: p.src && p.alt === (o.gallery?.find((g) => g.src === p.src)?.alt ?? '') ? p.alt : p.alt.trim() })),
  };
  if (o.year === null && yearRaw === '') data.year = null;
  const problems = [];
  if (!data.title.trim()) problems.push('Please give the work a title.');
  if (data.year !== null && (!Number.isInteger(data.year) || data.year < YEAR_MIN || data.year > YEAR_MAX))
    problems.push(`The year should be between ${YEAR_MIN} and ${YEAR_MAX}, or empty.`);
  if (!Number.isInteger(data.order)) problems.push('The position in the grid should be a whole number.');
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
  await runSave({ works: [{ slug: D.slug, baseSha: D.baseSha, data, newImages }] }, `“${data.title}”`, (res) => {
    const slug = res.changed?.find((c) => c.action === 'add')?.slug || D.slug;
    D.dirty = false;
    go(`#/work/${encodeURIComponent(slug)}`);
  });
}

function uploadBlob(bytes) {
  // base64 via FileReader: native and fast even for 20 MB.
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error('could not read the photo.'));
    r.onload = async () => {
      const b64 = String(r.result).split(',')[1];
      try {
        resolve(await api('/api/blob', { method: 'POST', body: `{"encoding":"base64","content":"${b64}"}` }));
      } catch (e) { reject(e); }
    };
    r.readAsDataURL(new Blob([bytes]));
  });
}

async function deleteWork() {
  const D = S.draft;
  const title = D.original.title;
  if (!confirm(`Delete “${title}” and all its photos from the website?`)) return;
  await runSave({ works: [], deletes: [{ slug: D.slug, baseSha: D.baseSha }] }, `the deletion of “${title}”`, () => {
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
      toast(`Test mode: nothing was published. Saving ${what} would have changed ${n} file${n === 1 ? '' : 's'}.`, 'test');
      console.info('Dry run', res);
      S.busy = false;
      setBusy(false);
      return;
    }
    if (res.noop) {
      toast('There was nothing new to save.', 'ok', 5000);
      S.busy = false;
      setBusy(false);
      if (S.draft) setDirty(false);
      return;
    }
    await loadWorks();
    S.busy = false;
    setBusy(false);
    after(res);
    toast('Saved — it will be live on arnenys.com in a few minutes.', 'ok', 12000);
  } catch (e) {
    S.busy = false;
    setBusy(false);
    if (S.draft) setDirty(S.draft.dirty);
    toast(e.status === 409 ? e.message : `Not saved: ${e.message}`, 'error');
  }
}

boot();
