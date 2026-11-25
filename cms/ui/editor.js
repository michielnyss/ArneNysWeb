// The parts of a work's website editor, shared by the website editor
// (app.js, a work on the site) and the archive's work card (work.js, its
// Website tab): the public fields, the photo list, the cover crop and the
// page preview. Each part takes the photos and callbacks it works on, so it
// does not care where a photo comes from (repo, device or Drive).

import Sortable from 'sortablejs';
import { NEW_WORK_ORDER, STATUS_OPTIONS, YEAR_MAX, YEAR_MIN } from '../shared/artwork.js';
import { field, h } from './dom.js';

export { field };
import {
  cropAxis, focalCentredOn, focalFromEdge, framePlacement, gridCrop, tilePlacement, withAxis,
} from './crop.js';

/**
 * A 2:3 grid tile showing exactly the crop the site's build makes of the
 * photo: the same rectangle (src/lib/crop.js), placed with exact CSS. Until
 * the photo has loaded (its size is needed) it shows a plain centred cover.
 */
export function gridFrame(url, focal) {
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

// ------------------------------------------------------------ public fields

/** The fields visitors see (title, year, size, material, status, about), filled from `o`. */
export function publicFields(o, onInput) {
  const title = h('input', { id: 'f-title', type: 'text', value: o.title, required: true, autocomplete: 'off', oninput: onInput });
  const year = h('input', { id: 'f-year', type: 'number', inputmode: 'numeric', min: YEAR_MIN, max: YEAR_MAX, step: 1, value: o.year ?? '', oninput: onInput });
  const dims = h('input', { id: 'f-dimensions', type: 'text', value: o.dimensions ?? '', placeholder: '120 × 90 cm', autocomplete: 'off', oninput: onInput });
  const medium = h('input', { id: 'f-medium', type: 'text', value: o.medium ?? '', autocomplete: 'off', oninput: onInput });
  const desc = h('textarea', { id: 'f-description', rows: 5, oninput: onInput });
  desc.value = o.description ?? '';
  const statusOpts = [...STATUS_OPTIONS];
  if (o.status && !statusOpts.some((s) => s.value === o.status)) statusOpts.push({ value: o.status, label: o.status });
  const status = h('div', { class: 'choices', role: 'radiogroup', 'aria-labelledby': 'status-label' },
    statusOpts.map((s) => h('label', { class: 'choice' },
      h('input', { type: 'radio', name: 'status', value: s.value, checked: (o.status ?? '') === s.value, onchange: onInput }),
      h('span', {}, s.label))));
  return [
    field('Title', title, 'f-title'),
    h('div', { class: 'row' }, field('Year', year, 'f-year'), field('Size', dims, 'f-dimensions')),
    field('Material', medium, 'f-medium'),
    h('div', { class: 'field' }, h('span', { class: 'label', id: 'status-label' }, 'Status'), status),
    field('About', desc, 'f-description'),
  ];
}

const val = (id) => document.getElementById(id)?.value ?? '';

/** The values as typed, tidied the way saving tidies them (for the preview). */
export function liveValues() {
  const year = val('f-year').trim();
  return {
    title: val('f-title').trim(),
    year: year && Number.isFinite(Number(year)) ? String(Number(year)) : year,
    dimensions: val('f-dimensions').trim(),
    medium: val('f-medium').trim(),
    status: document.querySelector('input[name=status]:checked')?.value ?? '',
    description: val('f-description').trim(),
  };
}

/**
 * The public fields to save, compared with `o` (the work as stored): a value
 * the person did not really change is sent back byte for byte.
 * Also reads the Position field when the form has one.
 */
export function readPublicFields(o) {
  const text = (id, orig) => {
    const v = val(id).trim();
    return v === String(orig ?? '').trim() ? orig ?? '' : v;
  };
  const yearRaw = val('f-year').trim();
  const data = {
    title: text('f-title', o.title),
    year: yearRaw === '' ? null : Number(yearRaw),
    description: text('f-description', o.description),
    medium: text('f-medium', o.medium),
    dimensions: text('f-dimensions', o.dimensions),
    status: document.querySelector('input[name=status]:checked')?.value ?? '',
  };
  const problems = [];
  if (document.getElementById('f-order')) {
    const orderRaw = val('f-order').trim();
    data.order = orderRaw === '' ? NEW_WORK_ORDER : Number(orderRaw);
    if (!Number.isInteger(data.order)) problems.push('The position in the grid should be a whole number.');
  }
  if (!data.title.trim()) problems.push('Please give the work a title.');
  if (data.year !== null && (!Number.isInteger(data.year) || data.year < YEAR_MIN || data.year > YEAR_MAX))
    problems.push(`The year should be between ${YEAR_MIN} and ${YEAR_MAX}, or empty.`);
  return { data, problems };
}

// ------------------------------------------------------------- photo list

/**
 * The photos as cards: drag (or the arrows) to reorder, the first is the
 * cover, each has a description. `photos` is reordered in place.
 *   url(p)       the photo to show
 *   badge(p)     an extra label on the photo, or null
 *   onChange()   after any change (order, text, removal)
 *   removeLabel, onRemove(p)   the remove button
 */
export function renderPhotoList(list, photos, opts) {
  const move = (p, to) => {
    photos.splice(photos.indexOf(p), 1);
    photos.splice(to, 0, p);
    opts.onChange();
  };
  list.replaceChildren(...photos.map((p, i) =>
    h('li', { class: `photo${p.state === 'working' ? ' working' : ''}`, 'data-key': p.key },
      h('div', { class: 'photo-img', title: 'Drag to reorder' },
        p.state === 'working'
          ? h('span', { class: 'spinner-wrap' }, h('span', { class: 'spinner' }), 'Preparing…')
          : h('img', { src: opts.url(p), alt: '', loading: 'lazy', onerror: (e) => e.target.replaceWith(h('span', { class: 'no-thumb' }, 'No preview yet')) }),
        i === 0 ? h('span', { class: 'cover-badge' }, 'Cover') : null,
        opts.badge?.(p) ? h('span', { class: 'new-badge' }, opts.badge(p)) : null,
      ),
      h('label', { class: 'alt-label', for: `alt-${p.key}` }, 'Description'),
      h('input', { id: `alt-${p.key}`, type: 'text', value: p.alt, oninput: (e) => { p.alt = e.target.value; opts.onText?.(); } }),
      h('div', { class: 'photo-actions' },
        i > 0 ? h('button', { class: 'btn small', type: 'button', onclick: () => move(p, 0) }, 'Make cover') : null,
        i > 0 ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Move earlier', title: 'Move earlier', onclick: () => move(p, i - 1) }, '←') : null,
        i < photos.length - 1 ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Move later', title: 'Move later', onclick: () => move(p, i + 1) }, '→') : null,
        h('button', { class: 'btn small quiet', type: 'button', onclick: () => opts.onRemove(p) }, opts.removeLabel || 'Remove'),
      ),
    )));
  if (!photos.length) list.append(h('li', { class: 'photo-empty' }, opts.empty || 'No photos'));
  list.current = { photos, opts };
  if (!list.sortable) {
    list.sortable = Sortable.create(list, {
      animation: 150,
      handle: '.photo-img',
      ghostClass: 'drag-ghost',
      delay: 120,
      delayOnTouchOnly: true,
      onEnd: () => {
        const keys = [...list.children].map((li) => li.dataset.key);
        list.current.photos.sort((a, b) => keys.indexOf(String(a.key)) - keys.indexOf(String(b.key)));
        list.current.opts.onChange();
      },
    });
  }
}

// ------------------------------------------------------------ crop editor

/**
 * The cover `p` with the 2:3 grid frame over it, and a live tile beside it.
 * Dragging the frame, tapping a spot or the arrow keys set `p.focal` (and
 * `p.focalTouched`); `onChange` follows.
 */
export function renderCrop(box, p, url, onChange) {
  if (!box) return;
  box.hidden = !p || p.state === 'working';
  if (box.hidden) return box.replaceChildren();
  const img = h('img', { class: 'crop-photo', src: url, alt: 'The cover photo', draggable: 'false' });
  const frame = h('div', { class: 'crop-frame', tabindex: '0', role: 'slider', 'aria-label': 'Part of the cover shown in the grid' });
  const stage = h('div', { class: 'crop-stage' }, img, frame);
  const reset = h('button', { class: 'btn small', type: 'button', onclick: () => setFocal({ x: 0.5, y: 0.5 }) }, 'Reset to centre');
  const tile = gridFrame(url, p.focal);
  box.replaceChildren(
    h('h2', { id: 'crop-title' }, 'Crop'),
    h('div', { class: 'crop-layout' },
      h('div', { class: 'crop-main' }, stage, h('div', { class: 'crop-actions' }, reset)),
      h('div', { class: 'crop-side' },
        h('div', { class: 'site site-tile' }, tile, h('span', { class: 'site-caption', 'data-live': 'title' }, liveValues().title || 'Untitled')),
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
    onChange();
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
  const centreOn = (e, rect, scale) =>
    setFocal(focalCentredOn(w, ht, axis, (e.clientX - rect.left) * scale, (e.clientY - rect.top) * scale, p.focal));
  stage.addEventListener('pointerdown', (e) => {
    if (!axis || e.button > 0) return;
    e.preventDefault();
    const rect = stage.getBoundingClientRect();
    const scale = w / rect.width; // photo pixels per screen pixel
    const onFrame = e.target === frame;
    if (!onFrame) centreOn(e, rect, scale);
    const r = gridCrop(w, ht, p.focal);
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, edge: axis === 'x' ? r.left : r.top, scale, rect, onFrame, moved: false };
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
    if (e.type === 'pointerup' && drag.onFrame && !drag.moved) centreOn(e, drag.rect, drag.scale);
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

// ------------------------------------------------------------ page preview

/**
 * The work's own page as the site renders it (src/pages/artworks/[entry].astro):
 * every photo at its full shape, then the title, the caption lines and the text.
 */
export function pagePreview() {
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

export function renderPreviewText() {
  const details = document.getElementById('preview-details');
  if (!details) return;
  const v = liveValues();
  const lines = [v.dimensions, v.medium, v.year, v.status].filter(Boolean);
  details.replaceChildren(...[
    h('p', { class: 'site-h1' }, v.title),
    ...lines.map((line) => h('p', { class: 'site-line' }, line)),
    v.description ? h('p', { class: 'site-blurb' }, v.description) : null,
  ].filter(Boolean)); // replaceChildren would show a null as the text "null"
  for (const el of document.querySelectorAll('[data-live=title]')) el.textContent = v.title || 'Untitled';
}

/** `urls`: the photos in page order. */
export function renderPreviewPhotos(urls) {
  const plates = document.getElementById('preview-plates');
  if (!plates) return;
  plates.replaceChildren(...urls.map((src) => h('img', { src, alt: '', loading: 'lazy', decoding: 'async' })));
  renderPreviewText();
}

/** A link that scrolls to the page preview. */
export function previewLink() {
  return h('p', { class: 'preview-link' }, h('a', {
    href: '#page-preview',
    onclick: (e) => { e.preventDefault(); document.getElementById('page-preview').scrollIntoView({ behavior: 'smooth' }); },
  }, 'Preview ↓'));
}
