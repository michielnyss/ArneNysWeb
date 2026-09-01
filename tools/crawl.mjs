import { openBrowser, ROOT } from './browser.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const site = process.argv[2] ?? 'https://cricket-coral-jl86.squarespace.com';
const origin = new URL(site).origin;
const originHost = new URL(origin).host;

const OUT = path.join(ROOT, 'extracted');
const dirs = {
  images: path.join(OUT, 'images'),
  pages: path.join(OUT, 'pages'),
  shots: path.join(OUT, 'screenshots'),
  json: path.join(OUT, 'json'),
};
for (const d of Object.values(dirs)) await fs.mkdir(d, { recursive: true });

const ctx = await openBrowser({ headless: true });
const page = await ctx.newPage();
page.setDefaultTimeout(45000);

/**
 * The sitemap lists the configured primary domain (ateliernys.com), which does
 * not currently resolve, so every URL is rewritten onto the serving origin.
 */
async function discoverUrls() {
  const found = new Set();
  const queue = [`${origin}/sitemap.xml`];
  while (queue.length) {
    const res = await ctx.request.get(queue.shift()).catch(() => null);
    if (!res?.ok()) continue;
    for (const [, loc] of (await res.text()).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
      if (loc.endsWith('.xml')) { queue.push(loc); continue; }
      const u = new URL(loc.split('#')[0]);
      u.host = originHost;
      u.protocol = 'https:';
      found.add(u.toString());
    }
  }
  found.add(`${origin}/`);
  return [...found].sort();
}

function fullRes(src) {
  try {
    const u = new URL(src, origin);
    if (/squarespace/.test(u.hostname)) { u.search = ''; u.searchParams.set('format', '2500w'); }
    return u.toString();
  } catch { return null; }
}

const images = new Map();
async function downloadImage(src) {
  const url = fullRes(src);
  if (!url) return null;
  if (images.has(url)) return images.get(url);
  const res = await ctx.request.get(url).catch(() => null);
  if (!res?.ok()) { images.set(url, null); return null; }
  const buf = Buffer.from(await res.body());
  const mime = (res.headers()['content-type'] ?? '').split(';')[0];
  const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg', 'image/avif': '.avif' }[mime]
    ?? (path.extname(new URL(url).pathname) || '.jpg');
  const raw = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'image');
  const stem = path.basename(raw, path.extname(raw)).replace(/[^a-z0-9._-]+/gi, '-').slice(0, 60) || 'image';
  const name = `${stem}-${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 8)}${ext}`;
  await fs.writeFile(path.join(dirs.images, name), buf);
  images.set(url, name);
  return name;
}

/**
 * Scroll the page so lazy sections render, then wait for images.
 * The step count is fixed up front: re-reading scrollHeight each iteration
 * never terminates, because lazy loading grows the page as we scroll.
 */
async function settle() {
  await page.evaluate(async () => {
    const step = window.innerHeight * 0.75;
    const steps = Math.min(Math.ceil(document.body.scrollHeight / step) + 4, 40);
    for (let i = 0; i <= steps; i++) {
      window.scrollTo(0, i * step);
      await new Promise((r) => setTimeout(r, 180));
    }
    window.scrollTo(0, 0);
  }).catch(() => {});
  await page.waitForTimeout(600);
  // Bounded: a permanently pending image must not stall the crawl.
  await page.evaluate(() => Promise.race([
    Promise.all([...document.images].filter((i) => !i.complete)
      .map((i) => new Promise((r) => { i.onload = i.onerror = r; }))),
    new Promise((r) => setTimeout(r, 8000)),
  ])).catch(() => {});
}

const slugOf = (u) => (new URL(u).pathname.replace(/^\/|\/$/g, '') || 'index').replace(/\//g, '--');

/** Runs inside the page: 7.1 section structure, text, images and type tokens. */
function scrapePage() {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const cs = getComputedStyle;
  const bgUrls = (el) => {
    const bg = cs(el).backgroundImage;
    if (!bg || bg === 'none') return [];
    return [...bg.matchAll(/url\(["']?(.*?)["']?\)/g)]
      .map((m) => m[1]).filter((u) => u && !u.startsWith('data:'));
  };
  // Only elements that can realistically carry a background image.
  const bgCandidates = () => [...document.querySelectorAll(
    'section,div,figure,header,footer,a,li,span[class*=background],[class*=image],[class*=banner],[style*=background]',
  )].slice(0, 4000);

  const imgSrc = (img) => {
    if (img.currentSrc) return img.currentSrc;
    if (img.src && !img.src.startsWith('data:')) return img.src;
    return img.dataset.src || img.getAttribute('data-image') || null;
  };

  const sections = [...document.querySelectorAll('[data-section-id], section.page-section')].map((sec) => {
    const blocks = [];
    for (const el of sec.querySelectorAll('h1,h2,h3,h4,p,li,blockquote,figcaption,.sqs-block-button-element')) {
      const text = clean(el.innerText);
      if (!text || blocks.at(-1)?.text === text) continue;
      const tag = el.tagName.toLowerCase();
      const kind = /^h[1-4]$/.test(tag) ? tag
        : tag === 'li' ? 'listItem'
        : tag === 'blockquote' ? 'quote'
        : tag === 'figcaption' ? 'caption'
        : el.classList.contains('sqs-block-button-element') ? 'button'
        : 'paragraph';
      blocks.push({ kind, text, ...(kind === 'button' ? { href: el.getAttribute('href') } : {}) });
    }
    const sectionImages = [
      ...[...sec.querySelectorAll('img')].map(imgSrc),
      ...bgCandidates().filter((e) => sec.contains(e)).flatMap(bgUrls),
    ].filter(Boolean);
    return {
      id: sec.dataset.sectionId ?? null,
      className: sec.className,
      fluid: !!sec.querySelector('.fluid-engine'),
      background: cs(sec).backgroundColor,
      blocks,
      images: [...new Set(sectionImages)],
    };
  });

  const links = [...document.querySelectorAll('a[href]')].map((a) => ({
    text: clean(a.textContent),
    href: a.getAttribute('href'),
    inNav: !!a.closest('nav, .header-nav, .header-menu'),
  }));

  const styleOf = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const s = cs(el);
    return {
      fontFamily: s.fontFamily, fontSize: s.fontSize, fontWeight: s.fontWeight,
      letterSpacing: s.letterSpacing, lineHeight: s.lineHeight,
      color: s.color, textTransform: s.textTransform,
    };
  };

  const allImages = [...new Set([
    ...[...document.querySelectorAll('img')].map(imgSrc),
    ...bgCandidates().flatMap(bgUrls),
  ].filter(Boolean))];

  return {
    title: document.title,
    description: document.querySelector('meta[name="description"]')?.content ?? '',
    h1: clean(document.querySelector('h1')?.textContent),
    sections,
    links,
    allImages,
    tokens: {
      body: styleOf('body'),
      h1: styleOf('h1'), h2: styleOf('h2'), h3: styleOf('h3'), p: styleOf('p'),
      bodyBackground: cs(document.body).backgroundColor,
    },
  };
}

const urls = await discoverUrls();
console.log(`Discovered ${urls.length} URLs on ${origin}\n`);

const pages = [];
for (const [n, url] of urls.entries()) {
  const slug = slugOf(url);
  process.stdout.write(`[${n + 1}/${urls.length}] ${new URL(url).pathname} `);
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 45000 });
  } catch { process.stdout.write('(timeout) '); }
  await settle();

  const data = await page.evaluate(scrapePage);

  // Structured JSON from Squarespace, for clean product copy and metadata.
  let itemJson = null;
  const j = await ctx.request.get(`${url}${url.includes('?') ? '&' : '?'}format=json`).catch(() => null);
  if (j?.ok()) {
    try {
      itemJson = JSON.parse(await j.text());
      await fs.writeFile(path.join(dirs.json, `${slug}.json`), JSON.stringify(itemJson, null, 2));
    } catch { /* some endpoints answer with HTML */ }
  }

  await fs.writeFile(path.join(dirs.pages, `${slug}.html`), await page.content());
  await page.screenshot({ path: path.join(dirs.shots, `${slug}.png`), fullPage: true, timeout: 30000 }).catch((e) => process.stdout.write('(shot failed) '));

  const local = [];
  for (const src of data.allImages) {
    const file = await downloadImage(src);
    if (file) local.push({ original: fullRes(src), file: `images/${file}` });
  }

  const it = itemJson?.item ?? null;
  pages.push({
    url, slug,
    title: data.title,
    h1: data.h1,
    description: data.description,
    collection: itemJson?.collection?.title ?? null,
    collectionType: itemJson?.collection?.typeName ?? null,
    // Prices and variants are deliberately dropped: this is a portfolio, not a shop.
    item: it && {
      title: it.title, urlId: it.urlId, body: it.body ?? null, excerpt: it.excerpt ?? null,
      categories: it.categories ?? [], addedOn: it.addedOn, assetUrl: it.assetUrl ?? null,
    },
    sections: data.sections,
    nav: data.links.filter((l) => l.inNav),
    tokens: data.tokens,
    images: local,
  });
  console.log(`— ${data.sections.length} sections, ${local.length} imgs`);
}

const toMarkdown = (p) => [
  `# ${p.h1 || p.title}`, ``, `> ${p.url}`,
  p.description ? `> ${p.description}` : null, ``,
  ...p.sections.flatMap((s, i) => [
    `## [section ${i + 1}${s.fluid ? ' · fluid' : ''}]`,
    ...s.blocks.map((b) => b.kind.startsWith('h') ? `### ${b.text}`
      : b.kind === 'listItem' ? `- ${b.text}`
      : b.kind === 'quote' ? `> ${b.text}`
      : b.kind === 'button' ? `[button] ${b.text} → ${b.href ?? ''}`
      : b.kind === 'caption' ? `*${b.text}*` : b.text),
    s.images.length ? `(${s.images.length} image${s.images.length > 1 ? 's' : ''})` : null, ``,
  ]),
].filter((l) => l !== null).join('\n');

for (const p of pages) await fs.writeFile(path.join(dirs.pages, `${p.slug}.md`), toMarkdown(p) + '\n');

const imageCount = [...images.values()].filter(Boolean).length;
await fs.writeFile(
  path.join(OUT, 'manifest.json'),
  JSON.stringify({ site: origin, crawledAt: new Date().toISOString(), pageCount: pages.length, imageCount, pages }, null, 2),
);

console.log(`\n${pages.length} pages, ${imageCount} unique images → extracted/`);
await ctx.close();
process.exit(0);
