/**
 * The focal-point crop, in one place.
 *
 * The site's image service (src/lib/image-service.ts) cuts every grid cover
 * with `cropRect`, and the admin editor (cms/) imports this same file to draw
 * its tiles, so what Arne sees in the admin is the crop the build makes.
 * Plain JavaScript with no imports, so the Worker, the browser and Node's
 * test runner can all load it as it is. Changing anything here changes the
 * built site's images.
 */

/** The grid frame: 2:3 portrait, width / height. */
export const GRID_RATIO = 2 / 3;

/** The widest grid image the build makes: covers a 3x phone and a 2x tablet. */
export const GRID_MAX_WIDTH = 2040;

/**
 * The size the grid asks the image service for, for a srcW x srcH cover: the
 * width of its 2:3 crop (at most GRID_MAX_WIDTH) by one and a half times that,
 * rounded. The rounding makes the ratio a hair off 2:3, so the crop for the
 * served image is cropRect(srcW, srcH, width / height, ...), not GRID_RATIO.
 */
export function gridImageSize(srcW, srcH) {
  const width = Math.min(cropRect(srcW, srcH, GRID_RATIO).width, GRID_MAX_WIDTH);
  return { width, height: Math.round(width * 1.5) };
}

/**
 * A `focalPoint` ({x, y}, 0-1, missing means centred) as the percentages the
 * grid passes to the image service: at most two decimals, as numbers.
 */
export function focusPercent(focalPoint) {
  const f = focalPoint ?? { x: 0.5, y: 0.5 };
  return { x: +(f.x * 100).toFixed(2), y: +(f.y * 100).toFixed(2) };
}

/** The `position` string the grid gives <Image>, e.g. "33% 39%". */
export function focusPosition(focalPoint) {
  const p = focusPercent(focalPoint);
  return `${p.x}% ${p.y}%`;
}

const PERCENT_POSITION = /^(\d+(?:\.\d+)?)% (\d+(?:\.\d+)?)%$/;

/** "33% 39%" -> {x: 33, y: 39}; anything else (keywords, negatives) -> null. */
export function parsePosition(position) {
  const m = typeof position === 'string' ? PERCENT_POSITION.exec(position) : null;
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}

/**
 * The region of a srcW x srcH image that a frame of `ratio` (width / height)
 * shows, in source pixels, when the image is cropped around xPct% / yPct%.
 *
 * The region is the largest one of that ratio that fits, so only one axis is
 * ever cut: the sides of a wide photo, or the top and bottom of a tall one.
 * The position uses the arithmetic of CSS object-position: x% puts the x%
 * point of the image on the x% point of the frame (0 = left edge, 100 = right).
 */
export function cropRect(srcW, srcH, ratio, xPct = 50, yPct = 50) {
  const wide = srcW / srcH > ratio;
  const width = wide ? Math.round(srcH * ratio) : srcW;
  const height = wide ? srcH : Math.round(srcW / ratio);
  const left = Math.round(((srcW - width) * xPct) / 100);
  const top = Math.round(((srcH - height) * yPct) / 100);
  return { left, top, width, height };
}
