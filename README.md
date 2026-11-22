# arnenys.com

Arne Nys's portfolio site — an in-house rebuild of the Squarespace original.

Static [Astro](https://astro.build) site. No store, no cart, no server: the
artworks are a portfolio, and the pages are plain HTML with pre-optimised images.

## Getting started

```bash
npm install
npm run dev        # http://localhost:4321
npm run build      # -> dist/
npm run preview    # serve dist/ locally
```

## Editing content

Two ways in:

1. **`/admin`** — a visual editor ([Sveltia CMS](https://github.com/sveltia/sveltia-cms)).
   Open https://www.arnenys.com/admin/ and choose *Sign In with GitHub* (any
   account with write access to this repo). Saving commits to `main`, which
   rebuilds and deploys the site within a few minutes. Locally, `npm run dev`
   also serves it, with *Work with Local Repository*.
2. **By hand** — each artwork is one JSON file in `src/content/artworks/`,
   images alongside in `src/assets/artworks/<slug>/`.

An artwork looks like this:

```json
{
  "title": "Tijdstroom",
  "year": 2022,
  "order": 22,
  "description": "",
  "medium": "",
  "dimensions": "155 × 80 cm",
  "status": "",
  "gallery": [{ "src": "/src/assets/artworks/tijdstroom/01.jpg", "alt": "..." }],
  "legacySlug": "tijdstroom"
}
```

- `order` sets the position in the grid (lower first) — it mirrors the order the
  Squarespace collection had.
- `dimensions`, `medium` and `status` come from the caption block under the title
  on Squarespace, which held one line each for size, material, year and
  occasionally "Sold". The year is dropped there because it already comes from
  the work's category. Four works have no caption block at all.
- `description` is empty everywhere — Squarespace never had one. Fill it in via
  `/admin` and it renders under the caption lines.
- The **first** gallery image is the grid cover. The extraction puts
  Squarespace's own cover first, which for five works is not the first photo in
  the list.
- `legacySlug` keeps the old Squarespace URL redirecting here. Leave it alone.

## Layout

| Path | Source |
| --- | --- |
| `/` | `src/pages/index.astro` — hero + full artwork grid |
| `/artworks/<year>/` | `src/pages/artworks/[entry].astro` — hero + one year |
| `/artworks/<slug>/` | same file — one artwork |
| `/contact/` | `src/pages/contact.astro` |
| 404 | `src/pages/404.astro` |
| `/admin/` | `src/pages/admin/index.astro` + `public/admin/` |

The hero is shared by `/` and the year pages via `src/components/Hero.astro`.

Years and artwork slugs share the `/artworks/` namespace, so one route resolves
both — see the comment at the top of `[entry].astro`.

### Design tokens

Sampled from the live Squarespace site; defined in `src/styles/global.css`.

| Token | Value | Use |
| --- | --- | --- |
| `--cream` | `#F1EEEC` | page background, light text |
| `--sage` | `#A7A489` | artwork and contact background |
| `--dark-olive` | `#504B38` | secondary text |
| `--ink` | `#191713` | header bar, body text |
| `--navy` | `#02052D` | dark headings |

Type is **Libre Baskerville** (headings) and **Almarai** (body), self-hosted via
`@fontsource` — no third-party font requests.

## Re-extracting from Squarespace

Only needed if the Squarespace site changes before it is switched off.

```bash
npm run login      # once: a browser opens, log in by hand; session is saved
npm run crawl      # renders every page, downloads full-res images -> extracted/
npm run content    # extracted/ -> src/content + src/assets
```

`extracted/` is ~260MB of raw scrape and is gitignored; `src/content` and
`src/assets` are generated from it and *are* committed. The crawl reads the
public site, so `npm run login` is only required for unpublished pages.

`tools/shoot.mjs` screenshots the local preview, which is how the rebuild was
checked against the original.

## Deploying

The site is live at **https://www.arnenys.com** (the apex `arnenys.com` and
`arnenysweb.michiel-nys129.workers.dev` serve it too). It runs on Cloudflare
Workers as plain static assets: `wrangler.jsonc` uploads `dist/` with no
adapter and no Worker script, and binds both custom domains.

**Every push to `main` deploys automatically**, including every save in
`/admin`. `.github/workflows/deploy.yml` runs `npm ci`, `npm run build` and
`wrangler deploy`, one run at a time, and caches the optimised images in
`node_modules/.astro` between runs. It needs two repository secrets,
`CLOUDFLARE_API_TOKEN` (a token limited to deploying Workers on this account
and the `arnenys.com` zone) and `CLOUDFLARE_ACCOUNT_ID`. A deploy can also be
started by hand from the Actions tab, or locally with
`npm run build && npx wrangler deploy`. A cold build re-encodes all ~720
image files and takes about two minutes; with the cache, about 15 seconds.

The old `ateliernys.com` resolves to `185.104.28.27`, which is not
Squarespace and answers nothing, so it cannot redirect here until its DNS is
under our control.

Keep `wrangler.jsonc`: without it, `wrangler deploy` runs
`astro add cloudflare`, which switches the site to SSR and breaks the legacy
redirects. Keep `.nvmrc` too: it pins Node 22, which the workflow reads, and
`astro.config.mjs` uses an import attribute (`with { type: 'json' }`) that
Node 18 cannot parse.

### `/admin` sign-in

*Sign In with GitHub* goes through
[sveltia-cms-auth](https://github.com/sveltia/sveltia-cms-auth), deployed as
its own Worker at `https://sveltia-cms-auth.michiel-nys129.workers.dev`
(`base_url` in `public/admin/config.yml`). It holds the client ID and secret
of the GitHub OAuth app **arnenys.com CMS** on `michielnyss` as Worker
secrets, and `ALLOWED_DOMAINS` restricts it to `www.arnenys.com` and
`arnenys.com`. Its code is not in this repo; redeploy it from a clone of that
project with `wrangler deploy`.

Anyone with write access to this repo can sign in. To let Arne edit, add his
GitHub account as a collaborator with write access.

## Notes

- Old product URLs (`/artworks/p/<slug>`) redirect to the new clean paths; the
  map is generated into `src/data/redirects.json`. `/home` and `/artworks`
  redirect to `/`.
- The Squarespace original hid its store UI with ~30 lines of custom CSS
  (prices, add-to-cart, quantity, variants, floating cart). None of that is
  generated here, so the prices are no longer in the page source at all.
- Three works are deliberately left off the new site: the two that were never
  titled, and the duplicate **Fragment 7**. See `OMIT` in
  `tools/build-content.mjs` — remove a slug from that set to bring one back.
  Their old URLs redirect to `/` rather than 404.
- The one-off **A Domestic Gallery** event page is not carried over;
  `/a-domestic-gallery` redirects to `/`.
- `/admin` is an Astro route, not a plain `public/admin/index.html`: the dev
  server resolves `public/` subfolders by exact filename only, so `/admin/`
  would otherwise hit the 404 page. The CMS bundle, config and logo still live
  in `public/admin/`.
- Gallery paths are **absolute from the repo root**
  (`/src/assets/artworks/<slug>/01.jpg`), not relative to the entry JSON.
  Astro's `image()` accepts either and optimises normally, but Sveltia can only
  resolve an absolute one — with a relative `../../` path the editor shows a
  bare filename and no thumbnail. The collection's media folder is
  `/src/assets/artworks/{{slug}}`, so a photo added through `/admin` is filed
  with its own work. Both were verified against the real config by running the
  CMS over a seeded test repository.
- `npm run content` now replaces only the per-work folders it generates, so
  photos added through `/admin` survive it. It still rewrites every JSON file
  from `extracted/`, though — **do not run it once the site is live and Arne
  has started editing**, or his changes are gone. It is a migration tool, not a
  maintenance one.
- **Images** go through `src/lib/image-service.ts`, Astro's sharp service with
  two changes: WebP at quality 90 instead of sharp's 80, and grid covers
  cropped to their 2:3 frame at build time around `focalPoint` (CSS
  `object-position` semantics), so the grid never downloads pixels only to
  hide them. Each `<Image>` offers widths up to the full source
  (`src/lib/images.ts`) with a `sizes` that matches the CSS, so 2x and 3x
  screens get sharp files. The photos are the Squarespace originals: its CDN
  holds nothing larger.
- The live site has an English/Dutch switcher (Squarespace's auto-translate
  widget) and a cookie banner. Neither is reproduced: there is no Dutch copy to
  serve, and the site sets no cookies.
- The original homepage had buttons to `/plasterrelief` and `/tweedwerk`, both of
  which 404 on the live site. They are not carried over.
