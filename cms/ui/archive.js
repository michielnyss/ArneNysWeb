// "All works": Arne's archive (Drive folders + the Sheet), grouped by year,
// with search and filters, and each work's state on the website. A work
// opens as its work card (work.js); "New work" makes its folder and row.

import { WEBSITE_LABELS } from '../shared/archive.js';
import { YEAR_MAX, YEAR_MIN } from '../shared/artwork.js';
import { $app, api, field, h, toast } from './dom.js';

const A = { data: null, list: '#/archive' };

// ------------------------------------------------------------ pure helpers

export const FILTERS = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'on', label: 'On website', test: (w) => w.website.live },
  { id: 'off', label: 'Not on website', test: (w) => !w.website.live },
  { id: 'changed', label: 'Changed since publish', test: (w) => w.website.state === 'changed' },
  { id: 'sold', label: 'Sold', test: (w) => w.row?.sold === true },
];

const SEARCHED = ['workingTitle', 'technique', 'materials', 'series', 'tags', 'edition', 'notes', 'soldTo', 'buyerContact', 'websiteSlug'];

/** Everything a search may match, lower case. */
export function searchText(w) {
  return [w.title, ...w.path, ...SEARCHED.map((k) => w.row?.[k])].filter((v) => v !== null && v !== undefined).join(' ').toLowerCase();
}

/** The values the Year and Technique filters use ('' = the work has none). */
export const yearOf = (w) => (w.year === null || w.year === undefined ? '' : String(w.year));
export const techniqueOf = (w) => String(w.row?.technique || w.type || '').trim();

/** The same filter value? Case does not matter ("relief" is "Relief"). */
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

/** The list's filters: site (a FILTERS id), year and technique ('*' = all, '' = none given), q (search). */
export const NO_FILTERS = { site: 'all', year: '*', technique: '*', q: '' };

/** Does a work pass the filters? `skip` leaves one out (for the counts next to that filter). */
function passes(w, f, skip) {
  const site = (FILTERS.find((x) => x.id === f.site) || FILTERS[0]).test;
  const words = String(f.q || '').toLowerCase().split(/\s+/).filter(Boolean);
  return (skip === 'site' || site(w))
    && (skip === 'year' || f.year === '*' || same(yearOf(w), f.year))
    && (skip === 'technique' || f.technique === '*' || same(techniqueOf(w), f.technique))
    && words.every((word) => searchText(w).includes(word));
}

/** The works that pass every filter and the search (all combined). */
export function filterWorks(works, filters = {}) {
  const f = { ...NO_FILTERS, ...filters };
  return works.filter((w) => passes(w, f));
}

/**
 * The choices for each filter, each with how many works it would show given
 * the other filters: { site, year, technique }, each [{ id, label, n }].
 * Years newest first, then "Unknown year"; techniques A-Z, then "No
 * technique". A chosen value stays a choice even if no work has it (any more).
 */
export function filterChoices(works, filters = {}) {
  const f = { ...NO_FILTERS, ...filters };
  const matching = (skip) => works.filter((w) => passes(w, f, skip));
  const choices = (key, of, all, none, order) => {
    const base = matching(key);
    const values = new Map(); // lower case -> the first spelling
    for (const v of [...works.map(of), ...(f[key] === '*' ? [] : [f[key]])]) if (!values.has(v.toLowerCase())) values.set(v.toLowerCase(), v);
    return [{ id: '*', label: all, n: base.length },
      ...[...values.values()].sort(order).map((v) => ({ id: v, label: v || none, n: base.filter((w) => same(of(w), v)).length }))];
  };
  const last = (a, b) => (a === '') - (b === ''); // "none" at the end
  return {
    site: FILTERS.map((x) => ({ id: x.id, label: x.label, n: matching('site').filter(x.test).length })),
    year: choices('year', yearOf, 'All years', 'Unknown year', (a, b) => last(a, b) || Number(b) - Number(a)),
    technique: choices('technique', techniqueOf, 'All techniques', 'No technique',
      (a, b) => last(a, b) || a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })),
  };
}

/** "#/archive?year=2024&technique=Relief&site=on&q=oil" -> filters (an unknown site falls back to all). */
export function parseListHash(hash) {
  const i = String(hash || '').indexOf('?');
  const p = new URLSearchParams(i < 0 ? '' : hash.slice(i + 1));
  const site = p.get('site');
  return {
    site: FILTERS.some((x) => x.id === site) ? site : 'all',
    year: p.get('year') ?? '*',
    technique: p.get('technique') ?? '*',
    q: p.get('q') || '',
  };
}

/** The other way round; a filter left at "all" stays out of the hash. */
export function listHash(filters = {}) {
  const f = { ...NO_FILTERS, ...filters };
  const p = new URLSearchParams();
  if (f.year !== '*') p.set('year', f.year);
  if (f.technique !== '*') p.set('technique', f.technique);
  if (f.site !== 'all') p.set('site', f.site);
  if (f.q.trim()) p.set('q', f.q.trim());
  const qs = p.toString().replace(/\+/g, '%20');
  return qs ? `#/archive?${qs}` : '#/archive';
}

export const isListHash = (hash) => hash === '#/archive' || String(hash).startsWith('#/archive?');

/** The list as it was last shown, filters and all: where "← All works" goes back to. */
export const listHref = () => A.list;

/** [[year or null, works]], in the order the works come (newest year first). */
export function groupByYear(works) {
  const groups = new Map();
  for (const w of works) {
    if (!groups.has(w.year)) groups.set(w.year, []);
    groups.get(w.year).push(w);
  }
  return [...groups];
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The small grey line under a card's title. */
export function workMeta(w) {
  const r = w.row || {};
  return [
    r.workingTitle && r.workingTitle !== w.title ? `Working title: “${r.workingTitle}”` : null,
    r.technique || r.series && `Series: ${r.series}`,
    plural(w.photos.length, 'photo'),
    r.sold ? 'sold' : null,
  ].filter(Boolean).join(' · ');
}

/** The badge text and colour for a work's website state. */
export function websiteBadge(w) {
  const s = w.website;
  if (s.state === 'changed') return { cls: 'b-chg', text: s.live ? 'On website · changed' : s.reasons[0] || WEBSITE_LABELS.changed };
  return { cls: s.state === 'on' ? 'b-on' : 'b-off', text: WEBSITE_LABELS[s.state] };
}

/** The photo a card shows: the first website photo still in the folder, else the first photo. */
export function coverOf(w) {
  const first = (w.row?.websitePhotos || []).map((id) => w.photos.find((p) => p.id === id)).find(Boolean);
  return first || w.photos[0] || null;
}

// ------------------------------------------------------------------ screens

/** The archive as /api/archive gives it, loaded once and shared with the work card. */
export async function loadArchive(force = false) {
  if (!A.data || force) A.data = await api('/api/archive');
  return A.data;
}

/** After a save: the next screen reloads the archive. */
export function invalidateArchive() {
  A.data = null;
}

export function problem(e) {
  const text = e.status === 503
    ? 'The archive is not connected yet. Once the Drive folder and the Sheet are set up, the works appear here.'
    : e.message;
  $app().replaceChildren(h('div', { class: 'panel error-panel narrow' }, h('h2', {}, 'The archive could not be loaded'), h('p', {}, text),
    h('button', { class: 'btn', onclick: () => showArchive(true) }, 'Try again')));
}

export function loading() {
  $app().replaceChildren(h('div', { class: 'loading' }, h('span', { class: 'spinner' }), ' Loading the archive…'));
}

export async function showArchive(force = false) {
  document.title = 'All works — arnenys.com admin';
  if (!A.data || force) loading();
  let data;
  try {
    data = await loadArchive(force);
  } catch (e) {
    return problem(e);
  }
  if (!isListHash(location.hash)) return; // moved on while loading

  // The filters live in the hash, so Back from a work card and a reload keep them.
  // The top bar's "Archive" link comes back to it too.
  const f = parseListHash(location.hash);
  const remember = () => {
    A.list = listHash(f);
    document.querySelector('[data-nav=archive]')?.setAttribute('href', A.list);
  };
  const set = (change) => {
    Object.assign(f, change);
    remember();
    history.replaceState(null, '', A.list); // no extra history entry, no hashchange
    render();
  };
  remember();
  const results = h('div', { id: 'archive-results', 'aria-live': 'polite' });
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Website' });
  const select = (key, label) => h('select', { 'aria-label': label, onchange: (e) => set({ [key]: e.target.value }) });
  const year = select('year', 'Year');
  const technique = select('technique', 'Technique');
  const search = h('input', {
    type: 'search', value: f.q, placeholder: 'Search title, working title, technique, buyer…', 'aria-label': 'Search the works',
    oninput: (e) => set({ q: e.target.value }),
  });
  const clear = h('button', { class: 'chip clear-filters', type: 'button', onclick: () => { search.value = ''; set(NO_FILTERS); } }, 'Clear filters');
  const fill = (el, list, chosen) => {
    el.replaceChildren(...list.map((o) => h('option', { value: o.id }, `${o.label} (${o.n})`)));
    el.value = chosen;
    el.classList.toggle('on', chosen !== '*');
  };
  const render = () => {
    const c = filterChoices(data.works, f);
    chips.replaceChildren(...c.site.map((x) => h('button', {
      class: `chip${f.site === x.id ? ' on' : ''}`, type: 'button', 'aria-pressed': String(f.site === x.id),
      onclick: () => set({ site: x.id }),
    }, `${x.label} ${x.n}`)));
    fill(year, c.year, f.year);
    fill(technique, c.technique, f.technique);
    clear.hidden = A.list === '#/archive';
    const shown = filterWorks(data.works, f);
    results.replaceChildren(...(shown.length
      ? groupByYear(shown).map(([y, works]) => h('section', { class: 'year-group' },
        h('div', { class: 'year-head' }, h('h2', {}, y ? String(y) : 'No year'), h('span', {}, plural(works.length, 'work'))),
        h('ul', { class: 'cards' }, works.map(card))))
      : [h('p', { class: 'lede' }, data.works.length ? 'No works match.' : 'No works yet: the archive folder has no photo folders.')]));
  };

  $app().replaceChildren(
    h('div', { class: 'archive' },
      h('div', { class: 'list-head' },
        h('div', {}, h('h1', {}, 'All works'),
          h('p', { class: 'lede' },
            h('a', { href: data.folder.url, target: '_blank', rel: 'noopener' }, 'Drive folder ↗'), ' · ',
            h('a', { href: data.sheet.url, target: '_blank', rel: 'noopener' }, 'Sheet ↗'))),
        h('span', { class: 'bar-buttons' },
          h('button', { class: 'btn', type: 'button', onclick: () => showArchive(true) }, 'Reload'),
          data.readOnly ? null : h('a', { class: 'btn primary', href: '#/archive/new' }, '+ New work')),
      ),
      notices(data),
      h('div', { class: 'archive-bar' },
        search,
        h('div', { class: 'filter-selects' }, year, technique),
        chips,
        clear,
      ),
      results,
    ),
  );
  render();
}

/** What is out of step between Drive, the Sheet and the site, in plain words. */
function notices(data) {
  const out = [];
  if (data.sheet.missing.length)
    out.push(`The Sheet has no column for: ${data.sheet.missing.join(', ')}.`);
  const unlisted = data.works.filter((w) => !w.row).length;
  if (unlisted) out.push(`${plural(unlisted, 'folder')} with photos ${unlisted === 1 ? 'is' : 'are'} not in the Sheet yet.`);
  for (const r of data.orphanRows)
    out.push(`Sheet row ${r.rowNumber}${r.workingTitle ? ` (“${r.workingTitle}”)` : ''}: ${r.problem.toLowerCase()}.`);
  const loose = data.loose || [];
  if (loose.length) {
    const n = loose.reduce((s, l) => s + l.count, 0);
    out.push(`${plural(n, 'photo')} ${n === 1 ? 'is' : 'are'} not inside a work folder: ${loose.map((l) => l.path.join('/')).join(', ')}.`);
  }
  if (data.siteOnly.length)
    out.push(`${plural(data.siteOnly.length, 'work')} on the website ${data.siteOnly.length === 1 ? 'is' : 'are'} not linked to a Drive folder yet.`);
  if (!out.length) return null;
  return h('details', { class: 'archive-notes' },
    h('summary', {}, `${plural(out.length, 'thing')} to tidy up`),
    h('ul', {}, out.map((t) => h('li', {}, t))));
}

function card(w) {
  const cover = coverOf(w);
  const b = websiteBadge(w);
  return h('li', { class: 'card' },
    h('a', { href: `#/archive/${encodeURIComponent(w.folderId)}`, class: 'card-link' },
      h('div', { class: 'card-photo' }, cover ? h('img', { src: cover.thumb, alt: '', loading: 'lazy', decoding: 'async' }) : null),
      h('div', { class: 'card-body' },
        h('span', { class: 'card-title' }, w.title),
        h('span', { class: 'card-meta' }, workMeta(w)),
        h('span', { class: 'badges' },
          h('span', { class: `badge ${b.cls}`, title: w.website.reasons.join('. ') || null }, b.text),
          w.row ? null : h('span', { class: 'badge b-new' }, 'Not in the Sheet yet')),
      ),
    ),
  );
}

// ------------------------------------------------------------- new work

/** The years and types the archive has, for the New work form. */
export function placeChoices(places) {
  const years = [...new Set(places.map((p) => p.year))].sort((a, b) => b - a);
  const types = (year) => places.filter((p) => p.year === Number(year) && p.type).map((p) => p.type);
  return { years, types };
}

/** "New work": where it goes (year, optional type) and its working title. The Worker makes the folder and the row. */
export async function showNewWork() {
  document.title = 'New work — arnenys.com admin';
  if (!A.data) loading();
  let data;
  try {
    data = await loadArchive();
  } catch (e) {
    return problem(e);
  }
  const { years, types } = placeChoices(data.places || []);
  const year = h('input', { id: 'n-year', type: 'number', inputmode: 'numeric', min: YEAR_MIN, max: YEAR_MAX, step: 1, required: true, list: 'n-years', value: new Date().getFullYear() });
  const typeList = h('datalist', { id: 'n-types' });
  const fillTypes = () => typeList.replaceChildren(...types(year.value).map((t) => h('option', { value: t })));
  year.addEventListener('input', fillTypes);
  fillTypes();
  const type = h('input', { id: 'n-type', type: 'text', list: 'n-types', autocomplete: 'off', placeholder: 'e.g. Schilderij (optional)' });
  const title = h('input', { id: 'n-title', type: 'text', required: true, autocomplete: 'off' });
  const button = h('button', { class: 'btn primary', type: 'submit' }, 'Create the work');
  const create = async (e) => {
    e.preventDefault();
    button.disabled = true;
    toast('Making the folder…', 'info');
    try {
      const out = await api('/api/archive/new', { method: 'POST', body: JSON.stringify({ year: year.value, type: type.value, title: title.value }) });
      await loadArchive(true);
      toast('The work is ready. Add its photos.', 'ok', 6000);
      location.hash = `#/archive/${encodeURIComponent(out.folderId)}`;
    } catch (err) {
      button.disabled = false;
      toast(err.message, 'error');
    }
  };
  $app().replaceChildren(h('form', { class: 'archive narrow', onsubmit: create },
    h('a', { class: 'back', href: listHref() }, '← All works'),
    h('h1', {}, 'New work'),
    h('p', { class: 'lede' }, 'This makes a folder for the work in the Drive folder, and a row in the Sheet.'),
    h('section', { class: 'panel' },
      h('div', { class: 'row' }, field('Year', year, 'n-year'), field('Type (folder)', type, 'n-type')),
      h('datalist', { id: 'n-years' }, years.map((y) => h('option', { value: y }))), typeList,
      field('Working title', title, 'n-title'),
      h('p', { class: 'hint' }, 'The folder goes in “year / type / year - working title”. A year or type folder that is not there yet is made too. Photos added later are named “working title - 01”, “- 02”, …'),
    ),
    h('div', { class: 'action-bar' }, h('span', {}), h('span', { class: 'bar-buttons' }, h('a', { class: 'btn quiet', href: listHref() }, 'Cancel'), button)),
  ));
  title.focus();
}
