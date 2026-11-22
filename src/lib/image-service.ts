/**
 * Astro's sharp image service, with two changes:
 *
 * 1. Every image is encoded at QUALITY unless a component asks otherwise.
 *    Astro's default WebP quality (sharp's 80) visibly smears the brush and
 *    surface detail in the artwork photos.
 *
 * 2. `fit="cover"` with a percentage `position` ("33% 39%") crops around that
 *    point, the way CSS `object-position` does. Sharp's own cover crop only
 *    knows gravity keywords (centre, north, ...), which cannot express the
 *    artworks' `focalPoint`. The grid uses this to serve each cover already
 *    cropped to its 2:3 frame, so no pixels are downloaded only to be hidden.
 */
import type { ImageTransform, LocalImageService } from 'astro';
import sharpService from 'astro/assets/services/sharp';
import sharp from 'sharp';

export const QUALITY = 90;

const PERCENT_POSITION = /^(\d+(?:\.\d+)?)% (\d+(?:\.\d+)?)%$/;

const service: LocalImageService = {
  ...sharpService,

  validateOptions(options, imageConfig) {
    options.quality ??= QUALITY;
    return sharpService.validateOptions!(options, imageConfig);
  },

  async transform(input, transform, imageConfig) {
    const t = transform as ImageTransform & { width?: number; height?: number };
    const focus =
      t.fit === 'cover' && typeof t.position === 'string' ? PERCENT_POSITION.exec(t.position) : null;
    if (!focus || !t.width || !t.height || !t.format || t.format === 'svg') {
      return sharpService.transform(input, transform, imageConfig);
    }

    const image = sharp(input, { failOnError: false, autoOrient: true });
    const { autoOrient } = await image.metadata();
    const { width: srcW, height: srcH } = autoOrient;

    // The largest region of the target aspect ratio that fits the source.
    const ratio = t.width / t.height;
    const cropW = srcW / srcH > ratio ? Math.round(srcH * ratio) : srcW;
    const cropH = srcW / srcH > ratio ? srcH : Math.round(srcW / ratio);
    // Same arithmetic as CSS object-position: x% puts the x% point of the
    // image on the x% point of the frame.
    const left = Math.round(((srcW - cropW) * Number(focus[1])) / 100);
    const top = Math.round(((srcH - cropH) * Number(focus[2])) / 100);

    // Never upscale: a request wider than the crop gets the crop at full size.
    const outW = Math.min(Math.round(t.width), cropW);
    const outH = Math.round(outW / ratio);

    const quality = typeof t.quality === 'number' ? t.quality : parseInt(String(t.quality ?? QUALITY), 10);
    const { data, info } = await image
      .extract({ left, top, width: cropW, height: cropH })
      .resize({ width: outW, height: outH, fit: 'fill' })
      .toFormat(t.format as keyof sharp.FormatEnum, { quality: Number.isNaN(quality) ? QUALITY : quality })
      .toBuffer({ resolveWithObject: true });
    return { data: new Uint8Array(data), format: info.format as ImageTransform['format'] };
  },
};

export default service;
