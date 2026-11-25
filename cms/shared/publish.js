// Publishing an archive work: which of its starred Drive photos the site
// already has, which must be copied to the repo, and the gallery and fields
// to save through the normal save path (src/save.js). Pure, so the browser
// (which does the heavy photo work) and the tests share it.

import { assetSrc, YEAR_MAX, YEAR_MIN } from './artwork.js';

/** The prefix save.js expects for a photo uploaded with this save. */
export const NEW = 'new:';

/**
 * The repo file a Drive photo became at the last publish, if the site still
 * shows it and the photo has not changed in Drive since. Otherwise null, and
 * Publish copies the photo again.
 */
export function currentSrc(work, id) {
  const { slug, data } = work.website || {};
  const pub = (work.row?.publishedPhotos || []).find((p) => p.id === id);
  if (!slug || !data || !pub) return null;
  const src = assetSrc(slug, pub.file);
  const item = (data.gallery || []).find((g) => g.src === src);
  if (!item) return null;
  const photo = work.photos.find((p) => p.id === id);
  const at = Date.parse(work.row?.lastPublished || '');
  if (!photo || !at || Date.parse(photo.modified || '') > at) return null;
  return src;
}

/**
 * Each starred photo's website state as the editor starts it: the alt text
 * and crop the site has for it, if it is already there.
 */
export function webPhotoState(work, id) {
  const src = currentSrc(work, id);
  // A photo that changed in Drive keeps the text and crop of the file it replaces.
  const pub = (work.row?.publishedPhotos || []).find((p) => p.id === id);
  const old = pub && work.website?.slug ? assetSrc(work.website.slug, pub.file) : null;
  const item = (work.website?.data?.gallery || []).find((g) => g.src === (src || old));
  return { src, alt: item?.alt ?? '', focal: item?.focalPoint, focalTouched: false };
}

/**
 * The gallery to save for `starred` (Drive ids in website order), given each
 * photo's editor state ({ alt, focal, focalTouched }).
 *   gallery  [{ src, alt, focalPoint? }], new photos as "new:<drive id>"
 *   uploads  the Drive ids that must be copied to the repo first
 * As in the website editor, a crop is only sent when it was changed, except
 * for a photo copied again, which takes over the crop it had.
 */
export function planGallery(work, starred, state = {}) {
  const uploads = [];
  const gallery = starred.map((id) => {
    const s = state[id] || webPhotoState(work, id);
    const src = currentSrc(work, id);
    const item = { src: src || `${NEW}${id}`, alt: String(s.alt ?? '').trim() };
    if (!src) uploads.push(id);
    if (s.focalTouched || (!src && s.focal)) item.focalPoint = s.focal ?? null;
    return item;
  });
  return { gallery, uploads };
}

/** "120 × 90 cm" from the Sheet's width/height/depth/unit, else its free text. */
export function dimensionsText(row = {}) {
  const sizes = [row.width, row.height, row.depth].filter((v) => v !== null && v !== undefined && v !== '');
  if (sizes.length >= 2) return `${sizes.join(' × ')}${row.unit ? ` ${row.unit}` : ''}`;
  return row.dimensions || '';
}

/**
 * What a work not yet on the website starts with on its Website tab. Only
 * plain facts from the Sheet; the description, the status and anything
 * private (price, sale) are never filled in.
 */
export function publicDefaults(work) {
  const r = work.row || {};
  const year = Number.isInteger(r.year) && r.year >= YEAR_MIN && r.year <= YEAR_MAX ? r.year : work.year ?? null;
  return {
    title: r.workingTitle || work.name || '',
    year,
    description: '',
    medium: r.materials || '',
    dimensions: dimensionsText(r),
    status: '',
  };
}

/**
 * The Sheet's record of a publish: which Drive photo is which repo file,
 * from the ids sent and the gallery the save produced (same order).
 */
export function publishedPairs(ids, gallerySrcs) {
  if (ids.length !== gallerySrcs.length) throw new Error('Photo list and gallery differ in length');
  return ids.map((id, i) => ({ id, file: gallerySrcs[i].split('/').at(-1) }));
}
