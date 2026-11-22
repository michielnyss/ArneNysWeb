/**
 * Widths for an image's srcset, up to `max` source pixels and never past it.
 *
 * Each rung is about 4/3 of the last, so whatever width the browser needs,
 * the file it picks is at most a third larger. The top rung is `max` itself,
 * so the sharpest file the source allows is always on offer (on a 2x or 3x
 * screen that is often the one picked). A rung within 10% of `max` is dropped
 * as a near-duplicate.
 */
const LADDER = [320, 480, 640, 860, 1150, 1530, 2040, 2720, 3600];

export function widthsUpTo(max: number, min = 320): number[] {
  const top = Math.round(max);
  return [...LADDER.filter((w) => w >= min && w < top * 0.9), top];
}

/**
 * The width, in source pixels, of the largest crop of an image to `ratio`
 * (width / height): what is left of it inside a frame of that shape.
 */
export function cropWidth(src: { width: number; height: number }, ratio: number): number {
  return src.width / src.height > ratio ? Math.round(src.height * ratio) : src.width;
}
