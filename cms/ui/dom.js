// Small DOM and API helpers shared by the editor's screens.

export function h(tag, attrs = {}, ...kids) {
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

/** A labelled form field. */
export function field(label, input, id) {
  return h('div', { class: 'field' }, h('label', { for: id }, label), input);
}

export const $app = () => document.getElementById('app');

export async function api(path, opts = {}) {
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

// ------------------------------------------------------------ status bar

let toastTimer = null;
export function toast(text, kind = 'info', ms = 0) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => (el.className = 'toast'), ms);
}

export function clearToast() {
  document.getElementById('toast').className = 'toast';
}

/** A dismissable message in `box` (e.g. a photo that could not be added). */
export function notice(box, text, kind = 'error') {
  if (!box) return;
  const n = h('div', { class: `notice ${kind}` }, h('span', {}, text), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Dismiss', onclick: () => n.remove() }, '×'));
  box.append(n);
}

/** Uploads one photo for the next save; resolves with { sha }. */
export function uploadBlob(bytes) {
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
