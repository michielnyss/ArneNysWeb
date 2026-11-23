# admin.arnenys.com: the artwork editor

A small, friendly editor for the works on arnenys.com, made for Arne:

- He signs in with his **Google account**, or with a code sent by email (Cloudflare Access
  in front of the site).
- He edits a work's title, year, size, material, sold/reserved status, description,
  photos (order, cover, descriptions) and grid position. He can also add and delete works,
  and drag works into a new order.
- The list of works **is the home page grid**: the same columns, 2:3 tiles, captions, colours
  and fonts as arnenys.com, with each cover cropped exactly as the site crops it. Works are
  dragged around in it (or moved with the arrows under each tile).
- On a work, **The cover in the grid** shows the cover with the 2:3 frame over it. Dragging
  the frame, tapping a spot, or the arrow keys set the photo's `focalPoint`, with a live tile
  beside it and **Reset to centre**. Below the form, **How the page will look** previews the
  work's own page and follows what he types.
- **Choose from Google Drive** opens the Google Picker, which grants access to the picked
  files only (`drive.file`, not his whole Drive). **Upload from this device** also works.
- **Save** makes one Git commit to `michielnyss/ArneNysWeb` `main` on the server side,
  through a GitHub App, so Arne needs no GitHub account. The existing Actions workflow then
  builds and deploys the site, and the editor shows "Saved — live in a few minutes".

Sveltia CMS at `www.arnenys.com/admin` is untouched and still works in parallel.

## How it fits together

```
browser ──► Cloudflare Access (Google or email-code sign-in, email allow-list)
        ──► Worker "arnenys-admin" (this folder) on admin.arnenys.com
              ├─ checks the Access JWT again (src/access.js)
              ├─ serves the editor (public/, bundled from ui/)
              └─ /api/*  ──► GitHub API as the "arnenys-admin" GitHub App (src/github.js)
browser ──► Google Picker + Drive download (drive.file token, in the browser only)
```

| Path | What |
|---|---|
| `src/worker.js` | Router, security headers, API endpoints, dry-run switch |
| `src/access.js` | Cloudflare Access JWT validation and the signed-in person's name |
| `src/github.js` | GitHub App token, one-request repo snapshot (GraphQL), blob upload, commit |
| `src/save.js` | Turns a save request into the exact file changes for one commit (pure, tested) |
| `shared/artwork.js` | The artwork JSON rules, mirroring `src/content.config.ts` and `public/admin/config.yml` |
| `../src/lib/crop.js` | The grid crop (size and rectangle). The site's image service cuts the covers with it and the editor draws its tiles with it, so the two cannot drift |
| `ui/crop.js` | Turns that rectangle into CSS for the tiles and the crop frame (pure, tested) |
| `public/fonts/` | The site's fonts (Libre Baskerville, Almarai; SIL OFL), self-hosted for the grid and page preview |
| `ui/` | The editor (plain DOM + SortableJS), photo clean-up, HEIC conversion, Drive Picker |
| `test/` | Unit and integration tests, plus `schema-check.mjs` against the real Astro schema |

### Content compatibility

- Fields, labels, hints and defaults mirror `public/admin/config.yml`. Validation mirrors
  `src/content.config.ts`. **If either file changes, update `shared/artwork.js` and the
  labels in `ui/app.js` with it.**
- Files are written as 2-space JSON with a trailing newline, the same as now. Saving a work
  unchanged gives a byte-identical file. The tests check this for every work in the repo.
- Unknown keys, key order, the hidden `legacySlug` and each photo's `focalPoint` are copied
  over untouched. The UI only sends a `focalPoint` for a photo whose crop Arne changed. A
  centred crop is not added to a photo that had none, so opening the crop editor changes
  nothing. A photo that is 2:3 already (or loses under 1.5% of its width or height, like the
  many 1360 × 2048 photos) gets a "no crop needed" note instead of a frame to drag.
- The commit body says what changed per work, e.g. `- "Einstein": Changed: title, crop of
  cover; added 2 photos`.
- The grid and page preview copy the site's CSS (bottom of `public/app.css`). If
  `ArtworkGrid.astro`, `[entry].astro` or `global.css` change their look, update it there.
- New works start at `order: -1`. The slug comes from the title, as Sveltia makes it,
  without clashing with existing works, years or `p`. New photos are named `NN.ext` in
  `src/assets/artworks/<slug>/`, continuing the numbering. They are referenced as
  `/src/assets/artworks/<slug>/NN.jpg`, an absolute path.
- A photo removed from a work is deleted from the repo in the same commit, unless another
  work still uses it. Deleting a work removes its JSON and its photo folder.
- If someone else changed the same work in the meantime, for example through Sveltia,
  the save is refused with a "reload" message rather than overwriting their change.

### Photos

All processing happens in the browser. A free-plan Worker has 10 ms of CPU per request.

- **JPEG, PNG, WebP**: committed at full resolution, and the compressed data is copied
  byte for byte, with no re-encoding. Exif (GPS, camera, dates), XMP, IPTC, comments,
  iPhone MPF/gain-map trailers and PNG/WebP text and EXIF chunks are removed. The ICC
  colour profile is kept. If the photo was taken sideways, a tiny Exif block that holds
  only the orientation is written back, so browsers and the site's sharp pipeline still
  show it upright. The tests check that the pixels are identical on 60 repo photos.
- **iPhone HEIC** (and AVIF/GIF): converted once in a Web Worker to JPEG at quality 95
  with no chroma subsampling (4:4:4). The original colour profile (Display P3) is embedded
  and the rotation is applied. libheif-js and MozJPEG, both self-hosted, do the work.
  Safari's own decoder is the fallback. If conversion fails, the editor shows a clear
  message on how to export as JPEG.
- Files over **20 MB** are refused with a friendly message.

## One-time setup (what exists now)

| Where | Name | Notes |
|---|---|---|
| GitHub | App **arnenys-admin** (id 5873857) | Installed on `michielnyss/ArneNysWeb` only. Contents read/write, metadata read. No webhook. |
| Google Cloud | Project **arnenys-admin** | Drive API and Picker API enabled. OAuth consent "Arne Nys website editor", External, **Testing**, scope `drive.file` only. |
| Google Cloud | OAuth web client **admin.arnenys.com Google Picker** | JS origins `https://admin.arnenys.com` and `http://localhost:8787` (local testing). |
| Google Cloud | API key **admin.arnenys.com Google Picker** | Restricted to the Picker API, referrers `https://admin.arnenys.com/*` and `http://localhost:8787/*`. |
| Google Cloud | OAuth web client **Cloudflare Access (arnenys.cloudflareaccess.com)** | Redirect URI `https://arnenys.cloudflareaccess.com/cdn-cgi/access/callback`. Its ID and secret live only in Cloudflare (Zero Trust > Integrations > Identity providers > Google). |
| Cloudflare | Worker **arnenys-admin** on `admin.arnenys.com` | `workers_dev` and preview URLs off. |
| Cloudflare | Zero Trust, **Free** plan | Team domain `https://arnenys.cloudflareaccess.com`. Login page name "Arne Nys website editor" (Reusable components > Custom pages). |
| Cloudflare | Login methods | **One-time PIN** (code by email) and **Google**. |
| Cloudflare | Access application **arnenys admin** | Self-hosted, `admin.arnenys.com`, login methods One-time PIN + Google, session 1 month. Policy **Editors** (Allow, Include: Emails). AUD tag is in `wrangler.jsonc`. |

Worker secrets are set with `npx wrangler secret put NAME`, which reads the value from
stdin. They are never stored in a file here.

| Secret | Value |
|---|---|
| `GH_APP_ID` | `5873857` |
| `GH_APP_PRIVATE_KEY` | The App's private key PEM. GitHub > Settings > Developer settings > GitHub Apps > arnenys-admin > Generate a private key |
| `GOOGLE_CLIENT_ID` | OAuth client ID of "admin.arnenys.com Google Picker" |
| `GOOGLE_API_KEY` | The API key above |
| `GOOGLE_APP_ID` | The Google Cloud project number (`282654506`) |

Plain variables in `wrangler.jsonc`: `DRY_RUN`, `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`.

## Adding an editor (e.g. Arne)

1. **Cloudflare Access** (the one that decides who gets in):
   [one.dash.cloudflare.com](https://one.dash.cloudflare.com) > Access controls >
   Applications > *arnenys admin* > Edit > Access policies > *Editors* > Include: Emails >
   add the address > Save. It takes effect immediately. With only this step the person
   can already sign in with an **email code**.
2. **Google Auth Platform test users**, only while the Google app is in Testing:
   [console.cloud.google.com/auth/audience?project=arnenys-admin](https://console.cloud.google.com/auth/audience?project=arnenys-admin)
   > Test users > Add users > the same Google address > Save. Both the **"Sign in with
   Google"** button on the Access login page and **Choose from Google Drive** use this
   project's consent screen, so in Testing both refuse a Google account that is not on
   the list (the email code still works).

**Publishing the Google app** (same page, "Publish app") would remove step 2 for everyone.
Its scopes are `openid`/`email`/`profile` (Access sign-in) and `drive.file` (Picker), all
non-sensitive, so Google needs no security review or app verification. It may still ask
to verify the brand (name, logo, homepage, privacy policy) before the app name and logo
are shown; without that, users see the "unverified" wording on the consent screen at
most. Access still decides who gets in, so publishing does not open the editor to anyone.
It has not been published.

## Commands

```bash
cd cms
npm install
npm test               # unit + integration tests (mock GitHub, mock Access)
npm run check-schema   # validates written JSON with the site's real Astro schema (astro sync)
npm run dev            # local copy on http://localhost:8787 (see below)
npm run dev:mock       # same, with no secrets at all: works from this checkout, saves are dry runs
npm run deploy         # build ui/ and deploy the Worker to admin.arnenys.com
```

`npm run dev` uses `wrangler.local.jsonc`. That config has no custom domain and is always
`DRY_RUN`. It needs an env file outside the repo, passed with
`--env-file <path>`, containing `DEV_USER_EMAIL`, `DEV_USER_NAME`, the GitHub App
secrets and the Google values. `DEV_USER_EMAIL` only works when the request URL is
`localhost`, so it cannot open the deployed Worker.

To test HEIC conversion against a real iPhone-style file, run
`HEIC_SAMPLE=/path/to/photo.heic npm test`.

## Test mode

Saves are live: `DRY_RUN` is `"false"` in `wrangler.jsonc` since 2026-11-23. To switch
to test mode again (Save only reports what it would commit, a yellow "Test mode" banner
shows, and uploads are discarded), set it to `"true"` and run `npm run deploy`.

## Still to do

1. ~~Cloudflare Access~~: done 2026-11-22. Email-code sign-in as `michiel.nys129@gmail.com`
   tested live; the works list loads in test mode. Google sign-in is not tested yet.
2. Add Arne's email (see "Adding an editor"), then have him test "Sign in with Google".
3. ~~Real test save~~: done 2026-11-23. An alt-text edit, a photo upload and its removal
   each made one commit and deployed; the live page showed the changes.

## Notes

- The Google account `michiel.nys129@gmail.com` is supervised (Family Link). Signing in
  to the Picker with it asks a parent to approve. Use another Google account for the
  editor, such as `michiel@ateliernys.com` or Arne's own.
- Thumbnails are loaded at full size from `raw.githubusercontent.com`, pinned to the commit.
  That is fine for about 30 works, but heavy on a phone with mobile data.
- libheif-js is LGPL-3.0. It is shipped unmodified as a separate bundle
  (`public/build/convert-worker.js`), with its licence in the bundle's `.LEGAL.txt`.
