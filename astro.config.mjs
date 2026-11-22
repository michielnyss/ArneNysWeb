import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import redirects from './src/data/redirects.json' with { type: 'json' };

export default defineConfig({
  site: 'https://www.arnenys.com',
  // Old Squarespace product URLs (/artworks/p/<slug>) keep working.
  redirects: { ...redirects, '/home': '/', '/artworks': '/' },
  build: { format: 'directory' },
  // The custom service is sharp with a higher default quality and focal-point
  // crops; see the comment at the top of the file.
  image: { responsiveStyles: true, service: { entrypoint: './src/lib/image-service.ts' } },
  integrations: [sitemap({ filter: (page) => !page.includes('/admin') })],
});
