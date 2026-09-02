import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const artworks = defineCollection({
  loader: glob({ pattern: '**/*.json', base: './src/content/artworks' }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      year: z.number().nullable(),
      order: z.number().default(0),
      description: z.string().default(''),
      medium: z.string().default(''),
      dimensions: z.string().default(''),
      /** Free text shown under the year, e.g. "Sold". */
      status: z.string().default(''),
      gallery: z
        .array(
          z.object({
            src: image(),
            alt: z.string().default(''),
            focalPoint: z.object({ x: z.number(), y: z.number() }).optional(),
          }),
        )
        .default([]),
      legacySlug: z.string().optional(),
    }),
});

export const collections = { artworks };
