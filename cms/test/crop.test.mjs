// The grid crop: the admin draws its tiles from the same src/lib/crop.js the
// site's image service cuts the covers with. These tests pin that function to
// the arithmetic the image service used before it was shared (so the site's
// images cannot drift), and check the admin's CSS turns it into exactly that
// rectangle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { cropRect, focusPosition, GRID_RATIO, gridImageSize, parsePosition } from '../../src/lib/crop.js';
import { cropAxis, focalCentredOn, focalFromEdge, framePlacement, gridCrop, tilePlacement, withAxis } from '../ui/crop.js';
import { ASSETS, localSnapshot } from './helpers.mjs';

// The image service's code before the crop moved to src/lib/crop.js (commit 73ee197), verbatim.
const OLD_PERCENT_POSITION = /^(\d+(?:\.\d+)?)% (\d+(?:\.\d+)?)%$/;
function oldServiceCrop(srcW, srcH, t) {
  const focus = t.fit === 'cover' && typeof t.position === 'string' ? OLD_PERCENT_POSITION.exec(t.position) : null;
  if (!focus) return null;
  const ratio = t.width / t.height;
  const cropW = srcW / srcH > ratio ? Math.round(srcH * ratio) : srcW;
  const cropH = srcW / srcH > ratio ? srcH : Math.round(srcW / ratio);
  const left = Math.round(((srcW - cropW) * Number(focus[1])) / 100);
  const top = Math.round(((srcH - cropH) * Number(focus[2])) / 100);
  return { left, top, width: cropW, height: cropH };
}
// ArtworkGrid.astro's position string before it moved to focusPosition().
const oldGridPosition = (fp) => {
  const focus = fp ?? { x: 0.5, y: 0.5 };
  return `${+(focus.x * 100).toFixed(2)}% ${+(focus.y * 100).toFixed(2)}%`;
};
// ArtworkGrid.astro's image size before it moved to gridImageSize(), verbatim
// (with images.ts's cropWidth inlined).
function oldGridSize(src) {
  const cropWidth = (s, ratio) => (s.width / s.height > ratio ? Math.round(s.height * ratio) : s.width);
  const width = Math.min(cropWidth(src, 2 / 3), 2040);
  return { width, height: Math.round(width * 1.5) };
}
// The service's new path, as image-service.ts now runs it.
function newServiceCrop(srcW, srcH, t) {
  const focus = t.fit === 'cover' ? parsePosition(t.position) : null;
  if (!focus) return null;
  return cropRect(srcW, srcH, t.width / t.height, focus.x, focus.y);
}

const snap = localSnapshot();
const works = Object.values(snap.works).map((w) => JSON.parse(w.text));
const storedFocals = works.flatMap((w) => (w.gallery || []).map((g) => g.focalPoint));

// Every photo in the repo, oriented as sharp (and so the site) sees it.
const photos = [];
for (const dir of readdirSync(ASSETS)) {
  for (const f of readdirSync(path.join(ASSETS, dir)).filter((f) => /\.(jpe?g|png|webp)$/i.test(f))) {
    const { autoOrient } = await sharp(path.join(ASSETS, dir, f)).metadata();
    photos.push({ src: `/src/assets/artworks/${dir}/${f}`, w: autoOrient.width, h: autoOrient.height });
  }
}
const bySrc = new Map(photos.map((p) => [p.src, p]));
const covers = works.filter((w) => w.gallery?.length).map((w) => ({ ...bySrc.get(w.gallery[0].src), focal: w.gallery[0].focalPoint }));

const FOCALS = [
  undefined, ...storedFocals,
  ...[0, 0.001, 0.1, 0.25, 0.3333, 0.33000001311302185, 0.5, 0.6667, 0.75, 0.9, 0.999, 1].flatMap((x) => [0, 0.39, 0.5, 1].map((y) => ({ x, y }))),
];

/** The srcset transforms the grid asks for, the way Astro derives them (width, then height from the aspect). */
function gridTransforms(w, h) {
  const { width, height } = oldGridSize({ width: w, height: h });
  const ladder = [320, 480, 640, 860, 1150, 1530, 2040, 2720, 3600].filter((x) => x >= 320 && x < width * 0.9);
  return [...ladder, width].map((x) => ({ width: x, height: Math.round(x / (width / height)) }));
}

test('the repo photos were found', () => {
  assert.ok(photos.length >= 80, `${photos.length} photos`);
  assert.ok(covers.length >= 30 && covers.every((c) => c.w && c.h), 'every cover has a size');
});

test('the shared crop is the image service\'s old arithmetic, for every photo, focal point and grid size', () => {
  let n = 0;
  for (const p of photos) {
    for (const fp of FOCALS) {
      const position = focusPosition(fp);
      assert.equal(position, oldGridPosition(fp));
      assert.deepEqual(gridImageSize(p.w, p.h), oldGridSize({ width: p.w, height: p.h }));
      for (const size of [...gridTransforms(p.w, p.h), { width: 2, height: 3 }, { width: 1, height: 1 }, { width: 16, height: 9 }, { width: 4, height: 5 }]) {
        const t = { fit: 'cover', position, ...size };
        assert.deepEqual(newServiceCrop(p.w, p.h, t), oldServiceCrop(p.w, p.h, t), `${p.src} ${position} ${size.width}x${size.height}`);
        n++;
      }
    }
  }
  assert.ok(n > 30_000, `${n} cases`);
});

test('positions the service does not crop (keywords, negatives) are still left alone', () => {
  for (const pos of ['center', 'left top', '-5% 10%', '50%', undefined, 42]) assert.equal(parsePosition(pos), null, String(pos));
  assert.deepEqual(parsePosition('33.33% 39%'), { x: 33.33, y: 39 });
});

test('the admin draws every current cover with exactly the site\'s rectangle', () => {
  for (const c of covers) {
    // The site: the grid's <img src> transform (its size from the old grid
    // code), cut with the old image service arithmetic.
    const size = oldGridSize({ width: c.w, height: c.h });
    const site = oldServiceCrop(c.w, c.h, { fit: 'cover', position: oldGridPosition(c.focal), ...size });
    const rect = gridCrop(c.w, c.h, c.focal);
    assert.deepEqual(rect, site, c.src);
    // Undo the CSS: the frame is the unit box, the photo is placed inside it.
    const css = tilePlacement(rect, c.w, c.h);
    const n = (s) => parseFloat(s) / 100;
    const scaleX = n(css.width) / c.w; // frame widths per photo pixel
    const scaleY = n(css.height) / c.h;
    const back = { left: -n(css.left) / scaleX, top: -n(css.top) / scaleY, width: 1 / scaleX, height: 1 / scaleY };
    for (const k of ['left', 'top', 'width', 'height']) assert.ok(Math.abs(back[k] - site[k]) < 1e-6, `${c.src} ${k}: ${back[k]} vs ${site[k]}`);
    const f = framePlacement(rect, c.w, c.h);
    assert.ok(Math.abs(n(f.left) * c.w - site.left) < 1e-6 && Math.abs(n(f.width) * c.w - site.width) < 1e-6, c.src);
  }
});

test('which way the frame moves: sideways for wide photos, up and down for tall ones, not at all for 2:3', () => {
  assert.equal(cropAxis(3000, 2000), 'x');
  assert.equal(cropAxis(1000, 3000), 'y');
  assert.equal(cropAxis(2000, 3000), null);
  assert.equal(cropAxis(1333, 2000), null); // rounds to the whole photo
  assert.equal(cropAxis(1360, 2048), null); // 8 px to spare: nothing worth offering
  assert.equal(cropAxis(1300, 2048), 'y');
  // A tall photo is cut at top and bottom, and its x focal point does nothing.
  const tall = cropRect(1000, 3000, GRID_RATIO, 0, 30);
  assert.deepEqual(tall, { left: 0, top: 450, width: 1000, height: 1500 });
  assert.deepEqual(cropRect(1000, 3000, GRID_RATIO, 100, 30), tall);
  for (const c of covers) assert.notEqual(cropAxis(c.w, c.h), undefined);
});

test('dragging and tapping give focal points that land the frame where it was put', () => {
  for (const [w, h, axis] of [[4000, 3000, 'x'], [1200, 3600, 'y'], [3024, 4032, 'x'], [5000, 1000, 'x']]) {
    const r = gridCrop(w, h);
    const slack = axis === 'x' ? w - r.width : h - r.height;
    for (let edge = -50; edge <= slack + 50; edge += Math.max(1, Math.floor(slack / 97))) {
      const f = focalFromEdge(w, h, axis, edge, { x: 0.5, y: 0.39 });
      assert.ok(f.x >= 0 && f.x <= 1 && f.y >= 0 && f.y <= 1);
      assert.equal(axis === 'x' ? f.y : f.x, axis === 'x' ? 0.39 : 0.5, 'the other coordinate is kept');
      const got = gridCrop(w, h, f)[axis === 'x' ? 'left' : 'top'];
      const want = Math.min(slack, Math.max(0, edge));
      assert.ok(Math.abs(got - want) <= Math.max(1, slack / 1e4 + 1), `${w}x${h} edge ${edge}: ${got}`);
    }
    // Tapping the middle of the photo centres the frame.
    assert.deepEqual(focalCentredOn(w, h, axis, w / 2, h / 2, undefined), { x: 0.5, y: 0.5 });
  }
  assert.deepEqual(withAxis({ x: 0.2, y: 0.4 }, 'x', 1.3), { x: 1, y: 0.4 });
  assert.deepEqual(withAxis(undefined, 'y', 0.123456), { x: 0.5, y: 0.1235 });
});
