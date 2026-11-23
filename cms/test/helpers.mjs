// Builds the same "snapshot" the Worker reads from GitHub, from the files in
// this checkout, so the save logic can be tested against the real content.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CONTENT = path.join(ROOT, 'src/content/artworks');
export const ASSETS = path.join(ROOT, 'src/assets/artworks');

export const gitSha = (buf) => createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

export function localSnapshot() {
  const works = {};
  for (const f of readdirSync(CONTENT).filter((f) => f.endsWith('.json'))) {
    const buf = readFileSync(path.join(CONTENT, f));
    works[f.slice(0, -5)] = { sha: gitSha(buf), text: buf.toString('utf8') };
  }
  const assets = {};
  for (const d of readdirSync(ASSETS)) {
    if (!statSync(path.join(ASSETS, d)).isDirectory()) continue;
    assets[d] = readdirSync(path.join(ASSETS, d));
  }
  return { head: 'a'.repeat(40), tree: 'b'.repeat(40), works, assets };
}
