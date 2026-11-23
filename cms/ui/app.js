// The editor UI. Plain DOM, no framework: two screens (all works, one work),
// switched by the URL hash so the browser's Back button works.

import Sortable from 'sortablejs';
import {
  compareWorks, newWorkData, NEW_WORK_ORDER, STATUS_OPTIONS, YEAR_MAX, YEAR_MIN,
} from '../shared/artwork.js';
import { configureDrive, driveAvailable, pickFromDrive } from './drive.js';
import { preparePhoto, PhotoProblem } from './prepare.js';
import {
  cropAxis, focalCentredOn, focalFromEdge, framePlacement, gridCrop, tilePlacement, withAxis,
} from './crop.js';

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

/** Which screen is showing; the list and the page preview use the site's own look. */
function setScreen(name) {
  document.body.dataset.screen = name;
}

/**
 * A 2:3 grid tile showing exactly the crop the site's build makes of the
 * photo: the same rectangle (src/lib/crop.js), placed with exact CSS. Until
 * the photo has loaded (its size is needed) it shows a plain centred cover.
 */
function gridFrame(url, focal) {
  const img = h('img', { src: url, alt: '', decoding: 'async', loading: 'lazy', draggable: 'false' });
  const frame = h('div', { class: 'site-frame' }, img);
  frame.place = (f) => {
    focal = f;
    const w = img.naturalWidth;
    const ht = img.naturalHeight;
    if (!w || !ht) return;
    Object.assign(img.style, tilePlacement(gridCrop(w, ht, focal), w, ht));
    img.classList.add('placed');
  };
  img.addEventListener('load', () => frame.place(focal));
  if (img.complete) frame.place(focal);
  return frame;
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
  setScreen('list');
  document.title = 'Works — arnenys.com admin';
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
          h('button', { class: 'icon-btn move-earlier', type: 'button', title: 'Move earlier', 'aria-label': `Move “${title}” earlier`, disabled: i === 0, onclick: () => nudge(w.slug, -1) }),
          h('button', { class: 'icon-btn move-later', type: 'button', title: 'Move later', 'aria-label': `Move “${title}” later`, disabled: i === order.length - 1, onclick: () => nudge(w.slug, 1) }),
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

function field(label, input, id) {
  return h('div', { class: 'field' },
    h('label', { for: id }, label),
    input,
  );
}

function renderEditor() {
  const D = S.draft;
  const o = D.original;
  const isNew = !D.slug;
  document.title = `${isNew ? 'New work' : o.title} — arnenys.com admin`;
  const onInput = () => { setDirty(true); renderPreviewText(); };

  const title = h('input', { id: 'f-title', type: 'text', value: o.title, required: true, autocomplete: 'off', oninput: onInput });
  const year = h('input', { id: 'f-year', type: 'number', inputmode: 'numeric', min: YEAR_MIN, max: YEAR_MAX, step: 1, value: o.year ?? '', oninput: onInput });
  const dims = h('input', { id: 'f-dimensions', type: 'text', value: o.dimensions ?? '', placeholder: '120 × 90 cm', autocomplete: 'off', oninput: onInput });
  const medium = h('input', { id: 'f-medium', type: 'text', value: o.medium ?? '', autocomplete: 'off', oninput: onInput });
  const desc = h('textarea', { id: 'f-description', rows: 5, oninput: onInput });
  desc.value = o.description ?? '';
  const order = h('input', { id: 'f-order', type: 'number', inputmode: 'numeric', step: 1, value: o.order ?? NEW_WORK_ORDER, oninput: onInput });

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
    ? h('button', { class: 'btn', type: 'button', onclick: addFromDrive }, h('span', { class: 'drive-icon', 'aria-hidden': 'true' }), 'Google Drive')
    : null;

  const form = h('form', { class: 'editor narrow', onsubmit: (e) => { e.preventDefault(); saveDraft(); } },
    h('a', { class: 'back', href: '#/' }, '← All works'),
    h('h1', {}, isNew ? 'New work' : o.title),
    !isNew ? h('p', { class: 'lede' }, h('a', { href: `https://www.arnenys.com/artworks/${D.slug}/`, target: '_blank', rel: 'noopener' }, 'On the website ↗')) : null,

    h('section', { class: 'panel' },
      field('Title', title, 'f-title'),
      h('div', { class: 'row' },
        field('Year', year, 'f-year'),
        field('Size', dims, 'f-dimensions'),
      ),
      field('Material', medium, 'f-medium'),
      h('div', { class: 'field' },
        h('span', { class: 'label', id: 'status-label' }, 'Status'),
        status,
      ),
      field('About', desc, 'f-description'),
    ),

    h('section', { class: 'panel' },
      h('h2', {}, 'Photos'),
      photoList,
      notices,
      h('div', { class: 'add-photos' },
        driveBtn,
        h('button', { class: 'btn', type: 'button', onclick: () => fileInput.click() }, 'Upload'),
        fileInput,
      ),
    ),

    h('section', { class: 'panel', id: 'crop-panel', 'aria-labelledby': 'crop-title' }),

    h('section', { class: 'panel' },
      field('Position', order, 'f-order'),
    ),

    !isNew ? h('section', { class: 'panel danger-zone' },
      h('h2', {}, 'Delete'),
      h('button', { class: 'btn danger', type: 'button', onclick: deleteWork }, `Delete “${o.title}”`),
    ) : null,

    h('p', { class: 'preview-link' }, h('a', { href: '#page-preview', onclick: (e) => { e.preventDefault(); document.getElementById('page-preview').scrollIntoView({ behavior: 'smooth' }); } }, 'Preview ↓')),

    h('div', { class: 'action-bar' },
      h('span', { id: 'save-state', class: 'save-state' }, D.dirty ? 'Not saved yet' : isNew ? 'New — not saved yet' : 'No changes'),
      h('span', { class: 'bar-buttons' },
        h('a', { class: 'btn quiet', href: '#/' }, 'Back'),
        h('button', { class: 'btn primary', id: 'save-btn', type: 'submit', disabled: !D.dirty && !isNew }, 'Save'),
      ),
    ),
  );

  $app().replaceChildren(form, pagePreview());
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
        h('label', { class: 'alt-label', for: `alt-${p.key}` }, 'Description'),
        h('input', {
          id: `alt-${p.key}`, type: 'text', value: p.alt,
          oninput: (e) => { p.alt = e.target.value; setDirty(true); },
        }),
        h('div', { class: 'photo-actions' },
          i > 0 ? h('button', { class: 'btn small', type: 'button', onclick: () => movePhoto(p, 0) }, 'Make cover') : null,
          i > 0 ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Move earlier', title: 'Move earlier', onclick: () => movePhoto(p, i - 1) }, '←') : null,
          i < D.photos.length - 1 ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Move later', title: 'Move later', onclick: () => movePhoto(p, i + 1) }, '→') : null,
          h('button', { class: 'btn small quiet', type: 'button', onclick: () => removePhoto(p) }, 'Remove'),
        ),
      ),
    ),
  );
  if (!D.photos.length) list.append(h('li', { class: 'photo-empty' }, 'No photos'));
  renderCrop();
  renderPreviewPhotos();
}

// ------------------------------------------------------------ crop editor


/** The cover, with the 2:3 grid frame over it, and a live tile beside it. */
function renderCrop() {
  const box = document.getElementById('crop-panel');
  if (!box) return;
  const p = S.draft.photos[0];
  const heading = h('h2', { id: 'crop-title' }, 'Crop');
  box.hidden = !p || p.state === 'working';
  if (box.hidden) return box.replaceChildren();
  const url = p.preview || photoUrl(p.src);
  const img = h('img', { class: 'crop-photo', src: url, alt: 'The cover photo', draggable: 'false' });
  const frame = h('div', { class: 'crop-frame', tabindex: '0', role: 'slider', 'aria-label': 'Part of the cover shown in the grid' });
  const stage = h('div', { class: 'crop-stage' }, img, frame);
  const reset = h('button', { class: 'btn small', type: 'button', onclick: () => setFocal({ x: 0.5, y: 0.5 }) }, 'Reset to centre');
  const tile = gridFrame(url, p.focal);
  box.replaceChildren(
    heading,
    h('div', { class: 'crop-layout' },
      h('div', { class: 'crop-main' }, stage, h('div', { class: 'crop-actions' }, reset)),
      h('div', { class: 'crop-side' },
        h('div', { class: 'site site-tile' }, tile, h('span', { class: 'site-caption', 'data-live': 'title' }, currentTitle())),
      ),
    ),
  );

  let w = 0;
  let ht = 0;
  let axis = null;
  const centred = () => (p.focal?.x ?? 0.5) === 0.5 && (p.focal?.y ?? 0.5) === 0.5;
  function update() {
    Object.assign(frame.style, framePlacement(gridCrop(w, ht, p.focal), w, ht));
    tile.place(p.focal);
    if (!axis) return;
    const v = Math.round((p.focal?.[axis] ?? 0.5) * 100);
    frame.setAttribute('aria-valuenow', String(v));
    frame.setAttribute('aria-valuetext', v === 50 ? 'Centred' : axis === 'x' ? `${v}% of the way from left to right` : `${v}% of the way from top to bottom`);
    reset.disabled = centred();
  }
  function setFocal(f) {
    if ((p.focal?.x ?? 0.5) === f.x && (p.focal?.y ?? 0.5) === f.y && p.focal) return;
    if (!p.focal && f.x === 0.5 && f.y === 0.5) return; // still centred
    p.focal = f;
    p.focalTouched = true;
    update();
    setDirty(true);
  }

  function ready() {
    w = img.naturalWidth;
    ht = img.naturalHeight;
    if (!w || !ht) return;
    axis = cropAxis(w, ht);
    stage.dataset.axis = axis || 'none';
    reset.hidden = !axis;
    frame.hidden = !axis; // 2:3 already: no crop, no frame
    if (axis) {
      frame.setAttribute('aria-orientation', axis === 'x' ? 'horizontal' : 'vertical');
      frame.setAttribute('aria-valuemin', '0');
      frame.setAttribute('aria-valuemax', '100');
    } else {
      frame.removeAttribute('role');
      frame.removeAttribute('tabindex');
    }
    update();
  }
  img.addEventListener('load', ready);
  if (img.complete) ready();

  // Drag the frame to move it. A tap or click anywhere on the photo centres
  // the frame on that spot (outside the frame it does so at once, so a drag
  // can follow). Pointer events cover mouse, pen and touch.
  let drag = null;
  const centreOn = (e, box, scale) =>
    setFocal(focalCentredOn(w, ht, axis, (e.clientX - box.left) * scale, (e.clientY - box.top) * scale, p.focal));
  stage.addEventListener('pointerdown', (e) => {
    if (!axis || e.button > 0) return;
    e.preventDefault();
    const box = stage.getBoundingClientRect();
    const scale = w / box.width; // photo pixels per screen pixel
    const onFrame = e.target === frame;
    if (!onFrame) centreOn(e, box, scale);
    const r = gridCrop(w, ht, p.focal);
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, edge: axis === 'x' ? r.left : r.top, scale, box, onFrame, moved: false };
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('dragging');
    frame.focus({ preventScroll: true });
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const moved = axis === 'x' ? e.clientX - drag.x : e.clientY - drag.y;
    if (Math.abs(moved) > 3) drag.moved = true;
    if (drag.moved) setFocal(focalFromEdge(w, ht, axis, drag.edge + moved * drag.scale, p.focal));
  });
  const stop = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (e.type === 'pointerup' && drag.onFrame && !drag.moved) centreOn(e, drag.box, drag.scale);
    drag = null;
    stage.classList.remove('dragging');
  };
  stage.addEventListener('pointerup', stop);
  stage.addEventListener('pointercancel', stop);

  frame.addEventListener('keydown', (e) => {
    if (!axis) return;
    const now = p.focal?.[axis] ?? 0.5;
    const step = e.shiftKey ? 0.1 : 0.01;
    const keys = {
      ArrowLeft: now - step, ArrowUp: now - step, ArrowRight: now + step, ArrowDown: now + step,
      PageUp: now - 0.1, PageDown: now + 0.1, Home: 0, End: 1,
    };
    if (!(e.key in keys)) return;
    e.preventDefault();
    setFocal(withAxis(p.focal, axis, keys[e.key]));
  });
}

// ------------------------------------------------------- page preview

function currentTitle() {
  return document.getElementById('f-title')?.value.trim() || S.draft?.original.title || 'Untitled';
}

/**
 * The work's own page as the site renders it (src/pages/artworks/[entry].astro):
 * every photo at its full shape, then the title, the caption lines and the text.
 */
function pagePreview() {
  return h('section', { class: 'page-preview', id: 'page-preview', 'aria-labelledby': 'preview-title' },
    h('div', { class: 'narrow preview-head' }, h('h2', { id: 'preview-title' }, 'Preview')),
    h('div', { class: 'site sage' },
      h('nav', { class: 'site-crumbs site-wrap', 'aria-hidden': 'true' },
        h('span', {}, 'Artworks'), h('span', {}, '›'), h('span', { 'data-live': 'title' }, '')),
      h('div', { class: 'site-work site-wrap' },
        h('div', { class: 'site-plates', id: 'preview-plates' }),
        h('div', { class: 'site-details', id: 'preview-details' }),
      ),
    ),
  );
}

/** The values as typed, tidied the way saving tidies them. */
function liveValues() {
  const val = (id) => document.getElementById(id)?.value.trim() ?? '';
  const year = val('f-year');
  return {
    title: val('f-title'),
    year: year && Number.isFinite(Number(year)) ? String(Number(year)) : year,
    dimensions: val('f-dimensions'),
    medium: val('f-medium'),
    status: document.querySelector('input[name=status]:checked')?.value ?? '',
    description: val('f-description'),
  };
}

function renderPreviewText() {
  const details = document.getElementById('preview-details');
  if (!details) return;
  const v = liveValues();
  const lines = [v.dimensions, v.medium, v.year, v.status].filter(Boolean);
  details.replaceChildren(
    h('p', { class: 'site-h1' }, v.title),
    ...lines.map((line) => h('p', { class: 'site-line' }, line)),
    v.description ? h('p', { class: 'site-blurb' }, v.description) : null,
  );
  for (const el of document.querySelectorAll('[data-live=title]')) el.textContent = v.title || 'Untitled';
}

function renderPreviewPhotos() {
  const plates = document.getElementById('preview-plates');
  if (!plates) return;
  const ready = S.draft.photos.filter((p) => p.state !== 'working' && (p.src || p.preview));
  plates.replaceChildren(...ready.map((p) => h('img', { src: p.preview || photoUrl(p.src), alt: '', loading: 'lazy', decoding: 'async' })));
  renderPreviewText();
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
    gallery: D.photos.map((p) => {
      const item = { src: p.src || `new:${p.key}`, alt: p.src && p.alt === (o.gallery?.find((g) => g.src === p.src)?.alt ?? '') ? p.alt : p.alt.trim() };
      // Only a crop Arne changed is sent; the server leaves the rest as stored
      // (and leaves a centred crop out of a photo that never had one).
      if (p.focalTouched) item.focalPoint = p.focal ?? null;
      return item;
    }),
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
    toast('Saved — live in a few minutes.', 'ok', 12000);
  } catch (e) {
    S.busy = false;
    setBusy(false);
    if (S.draft) setDirty(S.draft.dirty);
    toast(e.status === 409 ? e.message : `Not saved: ${e.message}`, 'error');
  }
}

boot();
