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
   Saving commits to this repo, which triggers a rebuild and deploy. It works
   locally today via *Work with Local Repository*; the GitHub sign-in button
   additionally needs an OAuth app (see **Deploying**).
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

Static output, so anything that serves files works. Cloudflare Pages or Netlify
have free tiers; build command `npm run build`, output directory `dist`. A cold
build re-encodes all ~500 images and takes about a minute.

`.nvmrc` pins Node 22, which Cloudflare Pages reads. Do not remove it: the
platform still defaults to Node 18, and `astro.config.mjs` uses an import
attribute (`with { type: 'json' }`) that Node 18 cannot parse.

Two things still to do at launch:

1. **Register and point the domain.** The site will live at **arnenys.com**,
   which does not resolve yet (NXDOMAIN) — it still needs registering. The old
   `ateliernys.com` resolves to `185.104.28.27`, which is not Squarespace and
   answers nothing, so no redirect from it is possible until that DNS is under
   our control. `site` in `astro.config.mjs` is already set to
   `https://www.arnenys.com`.
2. **Wire up `/admin` auth.** `backend.repo` is set to
   `michielnyss/ArneNysWeb`, so the editor loads and offers three ways in:
   *Work with Local Repository* (no setup — it opens the checkout straight from
   the browser), *Sign In with GitHub*, and an access token. Only the GitHub
   button needs work: Sveltia wants an OAuth app, so on Cloudflare deploy
   [sveltia-cms-auth](https://github.com/sveltia/sveltia-cms-auth) as a Worker
   and set `base_url` in `public/admin/config.yml` to it.

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
- The live site has an English/Dutch switcher (Squarespace's auto-translate
  widget) and a cookie banner. Neither is reproduced: there is no Dutch copy to
  serve, and the site sets no cookies.
- The original homepage had buttons to `/plasterrelief` and `/tweedwerk`, both of
  which 404 on the live site. They are not carried over.
