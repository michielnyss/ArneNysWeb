// Keeps public/admin/sveltia-cms.js in step with the installed package,
// so /admin never depends on a third-party CDN at runtime.
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './browser.mjs';

const from = path.join(ROOT, 'node_modules', '@sveltia', 'cms', 'dist', 'sveltia-cms.js');
const to = path.join(ROOT, 'public', 'admin', 'sveltia-cms.js');
await fs.copyFile(from, to);
console.log('admin: sveltia-cms.js synced');
