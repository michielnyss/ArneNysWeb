// Keeps public/admin/sveltia-cms.js in step with the installed package,
// so /admin never depends on a third-party CDN at runtime.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Deliberately does not import ./browser.mjs: that pulls in Playwright, and
// this script runs on every production build, where no browser is installed.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const from = path.join(ROOT, 'node_modules', '@sveltia', 'cms', 'dist', 'sveltia-cms.js');
const to = path.join(ROOT, 'public', 'admin', 'sveltia-cms.js');
await fs.copyFile(from, to);
console.log('admin: sveltia-cms.js synced');
