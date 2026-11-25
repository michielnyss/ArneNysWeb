// Arne's archive in Google Drive, as the service account arnenys-archive@...,
// which is shared on the archive folder only. It lists and reads, writes the
// Sheet, creates and renames folders, and renames photos (shared/naming.js).
// It never deletes anything, and it cannot create files (it has no storage
// of its own): photos are uploaded by the browser with the signed-in
// person's own token (ui/drive.js).

import { serviceAccountToken } from './google-sa.js';

export const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
];
export const DRIVE = 'https://www.googleapis.com/drive/v3';
export const FOLDER = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'id,name,mimeType,parents,size,modifiedTime,imageMediaMetadata(width,height,rotation,time)';

/** Archive settings, or null while the Worker is not set up for it. */
export function archiveConfig(env) {
  if (!env.ARCHIVE_FOLDER_ID || !env.ARCHIVE_SHEET_ID || !env.GOOGLE_SA_KEY) return null;
  return { folderId: env.ARCHIVE_FOLDER_ID, sheetId: env.ARCHIVE_SHEET_ID, key: env.GOOGLE_SA_KEY };
}

/**
 * Calls a Google API as the service account: JSON back, or a thrown error
 * with `status`. `body` (an object) is sent as JSON.
 */
export async function googleJson(env, url, method = 'GET', body) {
  const token = await serviceAccountToken(env.GOOGLE_SA_KEY, SCOPES);
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Google ${method} ${url.split('?')[0]}: ${res.status} ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

/**
 * Every folder and image the service account can see, in as few requests as
 * possible (one per 1,000 items, rather than one per folder: a free Worker
 * may make only 50 subrequests). The caller keeps the archive's subtree.
 */
export async function listFolderAndImages(env) {
  const q = `trashed = false and (mimeType = '${FOLDER}' or mimeType contains 'image/')`;
  const files = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({ q, pageSize: '1000', fields: `nextPageToken,files(${FILE_FIELDS})` });
    if (pageToken) params.set('pageToken', pageToken);
    const page = await googleJson(env, `${DRIVE}/files?${params}`);
    files.push(...(page.files || []));
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  return files;
}

/** A new folder in `parentId`. */
export function createFolder(env, name, parentId) {
  return googleJson(env, `${DRIVE}/files?fields=id,name,parents`, 'POST', { name, mimeType: FOLDER, parents: [parentId] });
}

/** Renames a file or folder (nothing else about it changes). */
export function renameFile(env, id, name) {
  return updateFile(env, id, { name });
}

/** Changes a file's name and/or description (nothing else). */
export function updateFile(env, id, { name, description }) {
  const body = { name, ...(description !== undefined ? { description } : {}) };
  return googleJson(env, `${DRIVE}/files/${encodeURIComponent(id)}?fields=id,name`, 'PATCH', body);
}

/** The images directly in a folder, right now (up to 1,000), with `fields` of each. */
export async function photosInFolder(env, folderId, fields = 'id') {
  const q = `'${folderId}' in parents and trashed = false and mimeType contains 'image/'`;
  const out = await googleJson(env, `${DRIVE}/files?${new URLSearchParams({ q, pageSize: '1000', fields: `files(${fields})` })}`);
  return out.files || [];
}

/**
 * Is `id` a folder inside `rootId` (at any depth), right now? The folder
 * ({ id, name, ... }) if so, else null. Walks up the parents, one request
 * per level (a work is 2-3 levels down).
 */
export async function isFolderUnder(env, id, rootId, maxDepth = 6) {
  const folder = await folderInfo(env, id);
  if (!folder) return null;
  let f = folder;
  for (let i = 0; i < maxDepth && f; i++) {
    const parent = f.parents?.[0];
    if (!parent) return null;
    if (parent === rootId) return folder;
    f = await googleJson(env, `${DRIVE}/files/${encodeURIComponent(parent)}?fields=id,parents,trashed`).catch(() => null);
    if (f?.trashed) return null;
  }
  return null;
}

/** A folder's id, name and parents; null if it is not a folder (or gone). */
export async function folderInfo(env, id) {
  const f = await googleJson(env, `${DRIVE}/files/${encodeURIComponent(id)}?fields=id,name,mimeType,parents,trashed`).catch(() => null);
  return f && f.mimeType === FOLDER && !f.trashed ? f : null;
}

/** One file's metadata (parents, type and a short-lived thumbnail link). */
export function fileInfo(env, id) {
  return googleJson(env, `${DRIVE}/files/${encodeURIComponent(id)}?fields=id,mimeType,parents,thumbnailLink`);
}

/**
 * A thumbnail of `size` px on the long side. Drive's thumbnailLink is a
 * pre-signed URL, so no token goes with it. Without one (Drive has not made
 * it yet) the original is read instead.
 */
export async function fetchThumbnail(env, info, size = 800) {
  if (info.thumbnailLink) return fetch(info.thumbnailLink.replace(/=s\d+$/, '') + `=s${size}`);
  return fetchOriginal(env, info);
}

/** The file's own bytes, as Drive's Response (streamed, not buffered). */
export async function fetchOriginal(env, info) {
  const token = await serviceAccountToken(env.GOOGLE_SA_KEY, SCOPES);
  return fetch(`${DRIVE}/files/${encodeURIComponent(info.id)}?alt=media`, { headers: { authorization: `Bearer ${token}` } });
}
