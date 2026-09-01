# ateliernys.com

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
   Saving commits to this repo, which triggers a rebuild and deploy. Before it
   works, set `backend.repo` in `public/admin/config.yml` to the GitHub
   `owner/name`, and connect the OAuth app (see **Deploying**).
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
  "dimensions": "",
  "gallery": [{ "src": "../../assets/artworks/tijdstroom/01.jpg", "alt": "..." }],
  "legacySlug": "tijdstroom"
}
```

- `order` sets the position in the grid (lower first) — it mirrors the order the
  Squarespace collection had.
- `description`, `medium` and `dimensions` were **empty on Squarespace** for every
  work. They render only when filled in, so the pages look right either way.
- `legacySlug` keeps the old Squarespace URL redirecting here. Leave it alone.

## Layout

| Path | Source |
| --- | --- |
| `/` | `src/pages/index.astro` — hero + full artwork grid |
| `/artworks/<year>/` | `src/pages/artworks/[entry].astro` — year filter |
| `/artworks/<slug>/` | same file — one artwork |
| `/contact/` | `src/pages/contact.astro` |
| `/a-domestic-gallery/` | `src/pages/a-domestic-gallery.astro` |
| `/admin/` | `public/admin/` |

Years and artwork slugs share the `/artworks/` namespace, so one route resolves
both — see the comment at the top of `[entry].astro`.

### Design tokens

Sampled from the live Squarespace site; defined in `src/styles/global.css`.

| Token | Value | Use |
| --- | --- | --- |
| `--cream` | `#F1EEEC` | page background, light text |
| `--sage` | `#A7A489` | artwork / contact / gallery background |
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
have free tiers; build command `npm run build`, output directory `dist`.

Two things still to do at launch:

1. **Point the domain.** `www.ateliernys.com` currently resolves to
   `185.104.28.27`, which is not Squarespace and answers nothing on port 443 —
   the live site is only reachable at its `*.squarespace.com` URL. Point the
   domain at the new host and set `site` in `astro.config.mjs` if it changes.
2. **Wire up `/admin` auth.** Sveltia needs a GitHub OAuth app. On Cloudflare,
   deploy [sveltia-cms-auth](https://github.com/sveltia/sveltia-cms-auth) as a
   Worker and set `base_url` in `public/admin/config.yml` to it.

## Notes

- Old product URLs (`/artworks/p/<slug>`) redirect to the new clean paths; the
  map is generated into `src/data/redirects.json`. `/home` and `/artworks`
  redirect to `/`.
- The Squarespace original hid its store UI with ~30 lines of custom CSS
  (prices, add-to-cart, quantity, variants, floating cart). None of that is
  generated here, so the prices are no longer in the page source at all.
- Two works had no title on Squarespace and are currently **Untitled I** and
  **Untitled II**; two different works were both called **Fragment 7**, so the
  second is at `/artworks/fragment-7-2/`. Worth renaming properly.
- The original homepage had buttons to `/plasterrelief` and `/tweedwerk`, both of
  which 404 on the live site. They are not carried over.
