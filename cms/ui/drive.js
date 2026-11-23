// "Choose from Google Drive": Google Identity Services for a short-lived token
// with the drive.file scope only (the app sees just the files picked here,
// never the rest of Drive), and the Google Picker to choose them.

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const MIME = ['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'image/avif', 'image/gif'].join(',');

let cfg = null;
let token = null; // { value, exp }
let tokenClient = null;
let loading = null;

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

export function configureDrive(google) {
  cfg = google;
}

export function driveAvailable() {
  return !!cfg;
}

function load() {
  loading ||= Promise.all([
    loadScript('https://accounts.google.com/gsi/client'),
    loadScript('https://apis.google.com/js/api.js').then(() => new Promise((r) => window.gapi.load('picker', r))),
  ]).catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}

function getToken() {
  if (token && token.exp - Date.now() > 60_000) return Promise.resolve(token.value);
  return new Promise((resolve, reject) => {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: cfg.clientId,
      scope: SCOPE,
      callback: (resp) => {
        if (resp.error || !resp.access_token) return reject(new Error(resp.error || 'no token'));
        token = { value: resp.access_token, exp: Date.now() + (resp.expires_in || 3000) * 1000 };
        resolve(token.value);
      },
      error_callback: (err) => reject(Object.assign(new Error(err?.type || 'cancelled'), { cancelled: true })),
    });
    tokenClient.requestAccessToken({ prompt: '' });
  });
}

/**
 * Opens the Picker. Resolves with [{id, name, mimeType, sizeBytes, file()}]
 * (empty if cancelled), where file() downloads that photo as a Blob.
 */
export async function pickFromDrive() {
  await load();
  const accessToken = await getToken();
  const g = window.google.picker;
  return new Promise((resolve) => {
    const view = new g.DocsView(g.ViewId.DOCS_IMAGES)
      .setMimeTypes(MIME)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false)
      .setMode(g.DocsViewMode.GRID);
    const picker = new g.PickerBuilder()
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
    picker.setVisible(true);
  });
}

async function download(id, mimeType) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`, {
    headers: { authorization: `Bearer ${token.value}` },
  });
  if (!res.ok) throw new Error(`Drive download failed (${res.status})`);
  const blob = await res.blob();
  return blob.type ? blob : new Blob([blob], { type: mimeType });
}
