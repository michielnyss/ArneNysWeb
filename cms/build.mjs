// Bundles ui/ into public/build/ (self-hosted: no CDN at runtime) and copies
// the JPEG encoder's .wasm next to it. Run by `wrangler deploy` / `wrangler dev`.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';

const out = 'public/build';
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  entryPoints: { app: 'ui/app.js', 'convert-worker': 'ui/convert-worker.js' },
  bundle: true,
  format: 'esm',
  outdir: out,
  minify: true,
  sourcemap: true,
  target: ['es2022'],
  legalComments: 'linked',
  logLevel: 'warning',
  // libheif's Emscripten bundle probes for Node; these keep it browser-only.
  external: ['fs', 'path', 'crypto', 'module', 'url', 'worker_threads'],
  define: { 'process.env.NODE_ENV': '"production"' },
});
copyFileSync('node_modules/@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm', `${out}/mozjpeg_enc.wasm`);
console.log('built', out);
