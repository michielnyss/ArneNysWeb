// Google Drive from the browser, with the signed-in person's own short-lived
// token, scope drive.file only: the app sees just the files picked or
// uploaded here, never the rest of Drive.
//   - "Choose from Google Drive": the Google Picker.
//   - Archive photos: uploaded into a work's folder (the Worker hands out the
//     folder id; this token cannot list it, only add to it), or picked files
//     copied there. The Worker's own account cannot create files, so this is
//     the only way photos get into the archive from the editor.

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const MIME = ['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'image/avif', 'image/gif'].join(',');
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

let cfg = null;
let devUpload = null; // the local stand-in's upload URL (test/mock-server.mjs only)
let token = null; // { value, exp }
let gis = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(s);
  });
}

const once = (fn) => {
  let p = null;
  return () => (p ||= fn().catch((e) => { p = null; throw e; }));
};
const loadGis = once(() => loadScript('https://accounts.google.com/gsi/client'));
const loadPicker = once(() => loadScript('https://apis.google.com/js/api.js').then(() => new Promise((r) => window.gapi.load('picker', r))));

export function configureDrive(google, devUploadUrl = null) {
  cfg = google;
  devUpload = devUploadUrl;
}

/** The Picker needs the API key as well as the client id. */
export const pickerAvailable = () => !!cfg?.apiKey;
/** Uploading into the archive needs a Google sign-in (or the local stand-in). */
export const uploadAvailable = () => !!(cfg?.clientId || devUpload);

async function getToken() {
  if (token && token.exp - Date.now() > 60_000) return token.value;
  await loadGis();
  return new Promise((resolve, reject) => {
    gis = window.google.accounts.oauth2.initTokenClient({
      client_id: cfg.clientId,
      scope: SCOPE,
      callback: (resp) => {
        if (resp.error || !resp.access_token) return reject(new Error(resp.error || 'no token'));
        token = { value: resp.access_token, exp: Date.now() + (resp.expires_in || 3000) * 1000 };
        resolve(token.value);
      },
      error_callback: (err) => reject(Object.assign(new Error(err?.type || 'cancelled'), { cancelled: true })),
    });
    gis.requestAccessToken({ prompt: '' });
  });
}

/**
 * Opens the Picker. Resolves with [{id, name, mimeType, sizeBytes, file()}]
 * (empty if cancelled), where file() downloads that photo as a Blob.
 */
export async function pickFromDrive() {
  await loadPicker();
  const accessToken = await getToken();
  const g = window.google.picker;
  return new Promise((resolve) => {
    const view = new g.DocsView(g.ViewId.DOCS_IMAGES)
      .setMimeTypes(MIME)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false)
      .setMode(g.DocsViewMode.GRID);
    const built = new g.PickerBuilder()
      .setAppId(cfg.appId)
      .setDeveloperKey(cfg.apiKey)
      .setOAuthToken(accessToken)
      .setOrigin(window.location.origin)
      .addView(view)
      .enableFeature(g.Feature.MULTISELECT_ENABLED)
      .setTitle('Choose photos of this work')
      .setSize(Math.min(1051, window.innerWidth - 16), Math.min(650, window.innerHeight - 16))
      .setCallback((data) => {
        const action = data[g.Response.ACTION];
        if (action === g.Action.CANCEL) resolve([]);
        if (action !== g.Action.PICKED) return;
        resolve(
          data[g.Response.DOCUMENTS].map((d) => ({
            id: d[g.Document.ID],
            name: d[g.Document.NAME],
            mimeType: d[g.Document.MIME_TYPE],
            sizeBytes: Number(d.sizeBytes || 0),
            file: () => download(d[g.Document.ID], d[g.Document.MIME_TYPE]),
          })),
        );
      })
      .build();
    built.setVisible(true);
  });
}

async function download(id, mimeType) {
  const res = await fetch(`${API}/files/${encodeURIComponent(id)}?alt=media`, {
    headers: { authorization: `Bearer ${token.value}` },
  });
  if (!res.ok) throw new Error(`Drive download failed (${res.status})`);
  const blob = await res.blob();
  return blob.type ? blob : new Blob([blob], { type: mimeType });
}

const TYPES = { heic: 'image/heic', heif: 'image/heif', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
/** A file's type; Windows browsers often give none for .heic. */
export const typeOf = (file) => file.type || TYPES[String(file.name).split('.').pop().toLowerCase()] || 'application/octet-stream';

async function driveError(res, what) {
  const text = await res.text().catch(() => '');
  let detail = text.slice(0, 120);
  try { detail = JSON.parse(text).error?.message || detail; } catch {}
  return new Error(`${what} (${res.status}${detail ? `: ${detail}` : ''})`);
}

/**
 * Signs in to Google now, if needed. Call it straight from the click that
 * starts an upload: the sign-in popup is only allowed right after a click.
 */
export const ensureDriveToken = () => (devUpload ? Promise.resolve() : getToken());
export const hasDriveToken = () => !!devUpload || !!(token && token.exp - Date.now() > 60_000);

/**
 * Uploads `file` as it is (the original, no conversion) into the Drive
 * folder `folderId`, as `name` (the archive's name for it, from the Worker)
 * with `description` (which keeps the original name). Resolves with
 * { id, name }. Resumable upload, so large photos go in one request each
 * way; multipart if the browser cannot read the session URL.
 */
export async function uploadToFolder(folderId, file, name = file.name, description = '') {
  const type = typeOf(file);
  if (devUpload) {
    const q = new URLSearchParams({ folder: folderId, name, type, description });
    const res = await fetch(`${devUpload}?${q}`, { method: 'POST', body: file });
    if (!res.ok) throw await driveError(res, 'Upload failed');
    return res.json();
  }
  const auth = { authorization: `Bearer ${await getToken()}` };
  const meta = JSON.stringify({ name, description, parents: [folderId], mimeType: type });
  const start = await fetch(`${UPLOAD}?uploadType=resumable&fields=id,name`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': type },
    body: meta,
  });
  if (!start.ok) throw await driveError(start, 'Upload failed');
  const session = start.headers.get('location');
  const res = session
    ? await fetch(session, { method: 'PUT', headers: { 'content-type': type }, body: file })
    : await fetch(`${UPLOAD}?uploadType=multipart&fields=id,name`, {
      method: 'POST',
      headers: auth,
      body: (() => {
        const form = new FormData();
        form.append('metadata', new Blob([meta], { type: 'application/json' }));
        form.append('file', file);
        return form;
      })(),
    });
  if (!res.ok) throw await driveError(res, 'Upload failed');
  return res.json();
}

/** A copy of a picked Drive file in `folderId`, as `name` (the original stays where it was). */
export async function copyToFolder(fileId, folderId, name, description = '') {
  const res = await fetch(`${API}/files/${encodeURIComponent(fileId)}/copy?fields=id,name`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await getToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ parents: [folderId], name, description }),
  });
  if (!res.ok) throw await driveError(res, 'Copy failed');
  return res.json();
}
