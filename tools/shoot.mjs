// Screenshots the local preview build, for eyeballing against the original.
import { chromium } from 'playwright';
const out = process.argv[2] ?? '.';
const base = process.argv[3] ?? 'http://localhost:4321';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
for (const [name, url] of [
  ['new_home', '/'],
  ['new_art', '/artworks/tijdstroom/'],
  ['new_contact', '/contact/'],
  ['new_dg', '/a-domestic-gallery/'],
  ['new_year', '/artworks/2024/'],
]) {
  await p.goto(base + url, { waitUntil: 'load' });
  await p.evaluate(async () => {
    for (let y = 0; y < 5000; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 110)); }
    window.scrollTo(0, 0);
  });
  await p.waitForTimeout(900);
  await p.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  console.log(name, 'ok');
}
await b.close();
