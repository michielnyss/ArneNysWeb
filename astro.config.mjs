import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import redirects from './src/data/redirects.json' with { type: 'json' };

export default defineConfig({
  site: 'https://www.ateliernys.com',
  // Old Squarespace product URLs (/artworks/p/<slug>) keep working.
  redirects: { ...redirects, '/home': '/', '/artworks': '/' },
  build: { format: 'directory' },
  image: { responsiveStyles: true },
  integrations: [sitemap({ filter: (page) => !page.includes('/admin') })],
});
