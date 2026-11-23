// The grid crop in the editor. The rectangle itself comes from the site's own
// src/lib/crop.js (the file the image service cuts the covers with); this file
// only turns it into CSS and back. Pure, so the tests can check it.

import { cropRect, focusPercent, gridImageSize } from '../../src/lib/crop.js';

/**
 * The frame ratio the site cuts a w x h cover at: the size the grid asks for
 * (2:3, rounded to whole pixels), so the admin matches the served image exactly.
 */
function ratioFor(w, h) {
  const s = gridImageSize(w, h);
  return s.width / s.height;
}

/** The crop the site makes of a w x h photo for the grid, in source pixels. */
export function gridCrop(w, h, focalPoint) {
  const p = focusPercent(focalPoint);
  return cropRect(w, h, ratioFor(w, h), p.x, p.y);
}

const pct = (n) => `${n * 100}%`;

/**
 * CSS for an <img> inside a 2:3 frame (position: relative; overflow: hidden)
 * so that the frame shows exactly `rect` of the w x h photo: the photo is
 * scaled until the rectangle fills the frame and shifted so it lines up.
 * Percentages of the frame, so it is exact at any tile size.
 */
export function tilePlacement(rect, w, h) {
  return {
    width: pct(w / rect.width),
    height: pct(h / rect.height),
    left: pct(-rect.left / rect.width),
    top: pct(-rect.top / rect.height),
  };
}

/** The frame drawn over the whole photo in the crop editor, as percentages of the photo. */
export function framePlacement(rect, w, h) {
  return {
    left: pct(rect.left / w),
    top: pct(rect.top / h),
    width: pct(rect.width / w),
    height: pct(rect.height / h),
  };
}

/**
 * Which way the frame can move: 'x' for a photo wider than 2:3 (the sides are
 * cut), 'y' for a narrower one (top and bottom are cut), null when the photo
 * already is 2:3 and the whole of it is shown. A photo that loses less than
 * NO_CROP_BELOW of its width or height counts as 2:3: many are 1360 x 2048,
 * which leaves 8 pixels to move, too little to see or to offer as a control.
 * (Its crop is still drawn exactly.)
 */
export const NO_CROP_BELOW = 0.015;
export function cropAxis(w, h) {
  const r = cropRect(w, h, ratioFor(w, h));
  if ((w - r.width) / w >= NO_CROP_BELOW) return 'x';
  if ((h - r.height) / h >= NO_CROP_BELOW) return 'y';
  return null;
}

/** Four decimals: the grid uses two decimals of a percentage. */
const tidy = (v) => Math.round(Math.min(1, Math.max(0, v)) * 1e4) / 1e4;

/** `current` with one coordinate set to v (kept within 0-1). */
export function withAxis(current, axis, v) {
  return { x: current?.x ?? 0.5, y: current?.y ?? 0.5, [axis]: tidy(v) };
}

/**
 * The focal point that puts the frame's leading edge at `edge` source pixels
 * (its left edge for axis 'x', its top for 'y'). The other coordinate is kept.
 */
export function focalFromEdge(w, h, axis, edge, current) {
  const f = { x: current?.x ?? 0.5, y: current?.y ?? 0.5 };
  const r = cropRect(w, h, ratioFor(w, h));
  const slack = axis === 'x' ? w - r.width : h - r.height;
  if (!axis || slack <= 0) return f;
  f[axis] = tidy(edge / slack);
  return f;
}

/** The focal point that centres the frame on the point (px, py) of the photo, in source pixels. */
export function focalCentredOn(w, h, axis, px, py, current) {
  const r = cropRect(w, h, ratioFor(w, h));
  return axis === 'x'
    ? focalFromEdge(w, h, axis, px - r.width / 2, current)
    : focalFromEdge(w, h, axis, py - r.height / 2, current);
}
