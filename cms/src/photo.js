// Repo images the editor may read back (the repo itself may be private, so the
// browser cannot load them from GitHub directly). SVG is left out on purpose:
// served from this origin it could run script.
const IMAGE_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
};

/**
 * "/api/photo/<sha>/src/assets/a/b.jpg" -> { sha, path: "src/assets/a/b.jpg", type },
 * or null for anything that is not a plain image path under src/assets/.
 */
export function parsePhotoPath(pathname) {
  const m = /^\/api\/photo\/([0-9a-f]{40})\/(.+)$/.exec(pathname);
  if (!m) return null;
  let segs;
  try {
    segs = m[2].split('/').map(decodeURIComponent);
  } catch {
    return null;
  }
  if (segs[0] !== 'src' || segs[1] !== 'assets' || segs.length < 3) return null;
  for (const s of segs) {
    if (!s || s === '.' || s === '..' || !/^[A-Za-z0-9._ -]+$/.test(s)) return null;
  }
  const type = IMAGE_TYPES[(/\.([a-z0-9]+)$/i.exec(segs.at(-1))?.[1] || '').toLowerCase()];
  if (!type) return null;
  return { sha: m[1], path: segs.join('/'), type };
}
