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
- **Archive** (top bar) is Arne's private archive of all his works: the Google Drive folder
  "Arne Kunst" plus one Google Sheet. Each work has a card with its private details and
  photos, and **Publish to website** puts it on arnenys.com. See "The archive" below.

## How it fits together

```
browser ──► Cloudflare Access (Google or email-code sign-in, email allow-list)
        ──► Worker "arnenys-admin" (this folder) on admin.arnenys.com
              ├─ checks the Access JWT again (src/access.js)
              ├─ serves the editor (public/, bundled from ui/)
              └─ /api/*  ──► GitHub API as the "arnenys-admin" GitHub App (src/github.js)
                             (photos too: /api/photo/<commit>/src/assets/..., so the repo can be private)
              └─ /api/archive* ──► Drive + Sheets as the service account (src/archive-routes.js)
browser ──► Google Picker, and photo uploads into a work's Drive folder
            (the person's own drive.file token, in the browser only)
```

| Path | What |
|---|---|
| `src/worker.js` | Router, sign-in check, the website API endpoints |
| `src/http.js` | Security headers, JSON responses, the dry-run switch |
| `src/repo.js` | One save to the repo: plan (save.js) + commit, re-planned if `main` moved. Used by Save and Publish |
| `src/access.js` | Cloudflare Access JWT validation and the signed-in person's name |
| `src/github.js` | GitHub App token, one-request repo snapshot (GraphQL), raw file read, blob upload, commit |
| `src/photo.js` | Which `/api/photo/...` paths may be read: images under `src/assets/` only, no traversal |
| `src/save.js` | Turns a save request into the exact file changes for one commit (pure, tested) |
| `src/archive-routes.js` | The `/api/archive*` endpoints: list, photos, Sheet row, new work, upload check and names, photo renames, publish |
| `shared/artwork.js` | The artwork JSON rules, mirroring `src/content.config.ts` and `public/admin/config.yml` |
| `shared/archive.js` | The archive Sheet's columns (headers, types, where the card shows them), reading and writing cells |
| `shared/naming.js` | Names in Drive: work folders, photos (`<title> - NN.ext`), next numbers, rename plans (pure, tested) |
| `shared/publish.js` | Archive work -> the gallery to publish: which photos the site has, which to copy (pure, tested) |
| `src/google-sa.js` | Access tokens for the archive service account (signed JWT, no Google library) |
| `src/drive.js` | Drive as the service account: list, read, create and rename folders, rename photos (never delete) |
| `src/sheet.js` | The Sheet: read, and write only the changed cells of one row (pure planner, tested) |
| `src/archive.js` | Drive folders + Sheet rows + site works -> the "All works" list, website state, new-work folders (pure, tested) |
| `src/thumb.js` | Signed `/api/archive/(thumb\|original)/...` paths; the same signature vouches for folder ids sent back |
| `ui/archive.js` | The "All works" screen and "New work" |
| `ui/work.js` | The work card: Archive and Website tabs, photo uploads, Publish |
| `ui/editor.js` | The parts both the website editor and the work card use: public fields, photo list, crop, page preview |
| `../src/lib/crop.js` | The grid crop (size and rectangle). The site's image service cuts the covers with it and the editor draws its tiles with it, so the two cannot drift |
| `ui/crop.js` | Turns that rectangle into CSS for the tiles and the crop frame (pure, tested) |
| `public/fonts/` | The site's fonts (Libre Baskerville, Almarai; SIL OFL), self-hosted for the grid and page preview |
| `ui/` | The rest of the editor (plain DOM + SortableJS), photo clean-up, HEIC conversion, Drive Picker and uploads (`drive.js`) |
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

| Where | Name | Owned by | Notes |
|---|---|---|---|
| GitHub | App **arnenys-admin** (id 5873857) | GitHub account `michielnyss` (email `michiel.nys129@gmail.com`) | Installed on `michielnyss/ArneNysWeb` only. Contents read/write, metadata read. No webhook. |
| Google Cloud | Project **arnenys-admin** | `michiel.nys129@gmail.com` (sole Owner; no organization) | Drive API and Picker API enabled. OAuth consent "Arne Nys website editor", External, **Testing**, scope `drive.file` only. |
| Google Cloud | OAuth web client **admin.arnenys.com Google Picker** | `michiel.nys129@gmail.com` (sole Owner; no organization) | JS origins `https://admin.arnenys.com` and `http://localhost:8787` (local testing). |
| Google Cloud | API key **admin.arnenys.com Google Picker** | `michiel.nys129@gmail.com` (sole Owner; no organization) | Restricted to the Picker API, referrers `https://admin.arnenys.com/*` and `http://localhost:8787/*`. |
| Google Cloud | OAuth web client **Cloudflare Access (arnenys.cloudflareaccess.com)** | `michiel.nys129@gmail.com` (sole Owner; no organization) | Redirect URI `https://arnenys.cloudflareaccess.com/cdn-cgi/access/callback`. Its ID and secret live only in Cloudflare (Zero Trust > Integrations > Identity providers > Google). |
| Google Cloud | Service account **arnenys-archive@arnenys-admin.iam.gserviceaccount.com** | `michiel.nys129@gmail.com` (sole Owner; no organization) | Created 2026-11-23. Its JSON key is kept outside the repo; never commit it. |
| Cloudflare | Worker **arnenys-admin** on `admin.arnenys.com` | `michiel.nys129@gmail.com` (Cloudflare account and its only member) | `workers_dev` and preview URLs off. |
| Cloudflare | Zero Trust, **Free** plan | `michiel.nys129@gmail.com` (Cloudflare account and its only member) | Team domain `https://arnenys.cloudflareaccess.com`. Login page name "Arne Nys website editor" (Reusable components > Custom pages). |
| Cloudflare | Login methods | `michiel.nys129@gmail.com` (Cloudflare account and its only member) | **One-time PIN** (code by email) and **Google**. |
| Cloudflare | Access application **arnenys admin** | `michiel.nys129@gmail.com` (Cloudflare account and its only member) | Self-hosted, `admin.arnenys.com`, login methods One-time PIN + Google, session 1 month. Policy **Editors** (Allow, Include: Emails). AUD tag is in `wrangler.jsonc`. |

Worker secrets are set with `npx wrangler secret put NAME`, which reads the value from
stdin. They are never stored in a file here.

| Secret | Value |
|---|---|
| `GH_APP_ID` | `5873857` |
| `GH_APP_PRIVATE_KEY` | The App's private key PEM. GitHub > Settings > Developer settings > GitHub Apps > arnenys-admin > Generate a private key |
| `GOOGLE_CLIENT_ID` | OAuth client ID of "admin.arnenys.com Google Picker" |
| `GOOGLE_API_KEY` | The API key above |
| `GOOGLE_APP_ID` | The Google Cloud project number (`282654506`) |
| `GOOGLE_SA_KEY` | The archive service account's whole JSON key file (`npx wrangler secret put GOOGLE_SA_KEY < key.json`). Not set yet |

Plain variables in `wrangler.jsonc`: `DRY_RUN`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and for the
archive `ARCHIVE_FOLDER_ID` (the Drive folder "Arne Kunst") and `ARCHIVE_SHEET_ID` (the Sheet
"Archive" in it). Both are set (2026-11-25). While any of the three archive settings is empty, the archive is off: the "Archive" tab
is hidden and `/api/archive` answers 503.

## The archive

The editor is also Arne's private archive (it replaces the ArneDatabase app). The ground
truth is the Google Drive folder "Arne Kunst" (`<year>/[<type>/]<work>/<photos>`) and
**one Google Sheet** in it, one row per work. The site's artwork JSON stays exactly as it
is; **Publish** copies a work's public fields and chosen photos into it.

- **All works** (`#/archive`): every work, by year, with search, filters and its state on
  the website. The filters (Year, Technique — the Sheet's, else the type folder — and the
  website chips) combine with each other and the search, and live in the hash
  (`#/archive?year=2024&technique=Relief&site=on`), so Back and a reload keep them. A work is any folder with photos directly in it, or one a Sheet row names.
  Except (`classify` in `src/archive.js`): folders named in `ARCHIVE_SKIP_FOLDERS`
  (`wrangler.jsonc`; default `Andere, inspiratie foto_s socials`: comma-separated names
  matched at any depth, case ignored, or a `a/b` path from the root) are left out with
  everything in them; a folder inside a work that has a row (`bewerkt`, `a5`) is not a work
  and its photos are not added to it; and photos lying in a type or year folder that holds
  works are not a work either, only one "N photos are not inside a work folder" line in
  the tidy-up notes. A Sheet row always makes its folder a work.
- **New work** (`#/archive/new`): year, optional type and working title. The Worker makes
  `<year>/<type>/<year> - <working title>` (creating a year or type folder that is
  missing) and the Sheet row. See "Names in Drive" below.
- **The work card** (`#/archive/<folder id>`), two tabs:
  - *Archive (private)*: every Sheet field (the work; price and sale, never published).
    **Save** writes only the cells that changed, after a fresh read; if someone changed the
    same cell in the Sheet meanwhile, the save is refused with a "reload" message. Changing
    the working title offers to rename the Drive folder too (when it carried the old title),
    and then its photos named after the old title.
    The Drive photos, each with a **star**: starred = on the website, in starred order, the
    first is the cover (stored in `Website photos`). **+ Add photos** uploads from the
    device, **From Google Drive** copies picked files: the original goes into the folder
    as it is (HEIC stays HEIC; Drive is the archive), named by the scheme below. **Tidy
    names** (shown when some photos are not named that way) renames those. Nothing in Drive
    is ever deleted from the editor; "Remove from website" only takes the star off.
  - *Website (public)*: **Show on the website** on/off, the public fields (the same form as
    the website editor), the starred photos with their descriptions and order, the cover
    crop and the page preview, all the website editor's own components (`ui/editor.js`).
    A work not on the site yet starts with its working title, year, materials and size from
    the Sheet; never its price, sale, notes or status.
- **Publish to website** (or **Publish changes**): the browser reads each starred photo
  the site does not have yet through the Worker (`/api/archive/original/...`), makes it fit
  for the site with the existing code (HEIC converted, metadata stripped, 20 MB limit) and
  uploads it with `/api/blob`. Then `POST /api/archive/publish` makes one commit through
  the same planner as Save (`src/save.js`: absolute `src` paths, `NN.jpg` names, `order`
  -1 for a new work, `legacySlug` and unknown keys kept, a conflict refused) and writes
  `On website`, `Website slug`, `Website photos`, `Published photos` and `Last published`
  to the Sheet. The slug always comes from the Sheet, never from the browser. A photo
  already published and unchanged in Drive is not copied again.
- **Remove from website** (the switch off on a work that is on the site) deletes its JSON
  and photos from the repo, as Delete in the website editor does, and sets `On website`
  to no. Its Drive folder and row stay.
- **Changed since publish** is exact for works published from the archive: `Published
  photos` (`<drive id>=<repo file>`, written by Publish) is compared with the stars and the
  site's gallery, and photo dates with `Last published`. A work linked to the site by hand
  (a `Website slug` but no `Published photos`) is compared by photo count only; its first
  Publish replaces the site's photos with the starred ones (the card says so).

**Names in Drive** (`shared/naming.js`, pure and tested; local scripts can import it too):

| What | Name |
|---|---|
| Year folder | `2024` |
| Type folder | as Arne named it (left alone) |
| Work folder | `2024 - <Working title>` |
| Photo | `<Working title> - 01.jpg`: the next free number in the folder (highest + 1), 2 digits, 3 from 100 |

Characters files cannot have (`/ \ : * ? " < > |`) are dropped, spaces trimmed and
collapsed; extensions are lowercase and `jpeg` becomes `jpg`. A photo's title is the work
folder's title (its name without `YYYY - `; an older folder named just the title works
too), so the photos follow the folder. The name a photo had before is kept in its Drive
description as `Original name: <name>` (never overwritten).

- **Uploads** (device or Google Drive): `POST /api/archive/upload-target` with the files'
  names and types answers with their new names, numbered after the photos in the folder
  now, in the order chosen (the browser's `drive.file` token cannot list the folder). The
  browser uploads with that name and the original-name description, then asks
  `POST /api/archive/names` (`mode: "settle"`, the new ids): if another upload took the
  same numbers meanwhile, the newer photos move to the next free ones.
- **Renaming a work**: the folder is renamed with the Sheet save, then `names`
  (`mode: "retitle"`, `from`: the old folder name) renames photos named
  `<old title> - NN.ext` to `<new title> - NN.ext`. Other photos are left alone.
- **Tidy names**: `names` (`mode: "tidy"`) renames every photo not named by the scheme, by
  capture time (Drive's `imageMediaMetadata.time`), then name, after the numbers in use;
  photos already named right (and the first of two with the same number) keep theirs.
- Renames are made by the service account, at most 40 per request (a free Worker may make
  50 subrequests); the browser asks again for the rest.

**Access.** The service account `arnenys-archive@arnenys-admin.iam.gserviceaccount.com`,
shared (as Editor) on the "Arne Kunst" folder only, is used by the Worker only (scopes
`drive` and `spreadsheets`; it only sees what is shared with it). It lists, reads, writes
the Sheet, creates and renames folders, and renames photos. It cannot create files (no storage of its
own), so **photos are uploaded by the browser** with the signed-in person's own Google
token, scope `drive.file`, straight into the work's folder; that token cannot list or read
the folder. Every folder id the browser sends back carries the HMAC signature the listing
gave it (`src/thumb.js`), so only folders listed under the archive root can be written to;
before an upload the Worker also checks live that the folder is still inside the root.
Sheet values are written RAW, so text like `=...` or `1/5` stays text.

**The Sheet** is read from its first tab by header name (case and punctuation ignored), so
columns can be reordered and Arne's own columns are left alone. The columns are in
`shared/archive.js`; a column the Sheet lacks is added after the last header the first
time it is written. `Published photos` is the editor's bookkeeping: leave it alone.

**Worker limits.** Every heavy step runs in the browser (conversion, base64). A publish is
about a dozen subrequests (Sheet read, folder check, GitHub snapshot and commit, Sheet
write), one `/api/blob` request per new photo, and originals are streamed through.

To try it locally (Publish is always a dry run locally: it shows what it would commit):

```bash
npm run dev:mock           # stand-in Drive and Sheet in memory (test/mock-google.mjs); uploads go to the stand-in
npm run dev:archive        # the real TEST folder "Kunstwerken TEST", read-only
npm run dev:archive:write  # the real TEST folder (or the ids set) with saves, new works and renames, inside it only
```

The real modes read the key from `SA_KEY_FILE` (default `~/.secrets/arnenys-archive-sa.json`;
never put it in the repo) and use the TEST folder and its Sheet unless `ARCHIVE_FOLDER_ID` and
`ARCHIVE_SHEET_ID` are both set (e.g. to the real ids from `wrangler.jsonc`). `dev:archive:write`
writes only inside that folder and its Sheet, refuses deletes, and will not start unless the
Sheet is inside the folder.

`npm run archive:headers` (with the same two variables) writes a new Sheet's header row: the
columns of `shared/archive.js` it lacks, after its last header. It checks first that the Sheet
is inside the folder, and touches no other cell. Real uploads from the browser need the Picker's OAuth
client id: `GOOGLE_CLIENT_ID=<id> npm run dev:archive:write` (localhost:8787 is an allowed
origin), and a Google account on the test-user list. All open http://localhost:8787.

`ARCHIVE_READ_ONLY = "true"` (a plain variable) makes the archive look-only anywhere.

### Going live with the archive

Set up 2026-11-25 in Michiel's Drive (`michiel.nys129@gmail.com`), so the archive does not
depend on Arne's own storage:

- Folder **"Arne Kunst"** (My Drive), shared as **Editor** with
  `arnenys-archive@arnenys-admin.iam.gserviceaccount.com` (no notification). Its id is
  `ARCHIVE_FOLDER_ID` in `wrangler.jsonc`.
- Sheet **"Archive"** inside it (so the service account can use it too), header row written
  with `npm run archive:headers`. Its id is `ARCHIVE_SHEET_ID`.
- Still to do: share "Arne Kunst" as Editor with Arne's Google account (he has two that
  have shared folders with Michiel; ask him which one he uses), add that account as an
  editor (see "Adding an editor"), and let Arne move his works in himself:
  `<year>/[<type>/]<work>/<photos>`. Rows can be left empty: the card's **Save** makes a
  row for a folder that has none.

Michiel, in this order:

1. `npx wrangler secret put GOOGLE_SA_KEY < <key file>` (from `cms/`; the key stays outside the repo).
2. (`ARCHIVE_FOLDER_ID` and `ARCHIVE_SHEET_ID` in `wrangler.jsonc` are already set.)
3. `npm test`, then `npm run deploy`. The Archive tab appears once all three settings are there.
4. Open the archive, check the "things to tidy up" note, and link the works already on the
   site: put each one's slug (`src/content/artworks/<slug>.json`) in `Website slug` and star
   its photos; the first Publish from the card then takes over its photos.

Repo changes (new photos, JSON) go live through the normal deploy workflow. Nothing about
the site's own Worker changes.

`cms/spike/` (the feasibility scripts from 2026-11-23) is no longer used by anything; it can
be deleted once Michiel no longer wants it as a record. The test file
`_spike user upload.png` it made in the TEST folder, if still there, can go too.

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
npm run dev:archive    # dev:mock, but the archive reads the real TEST Drive folder (read-only)
npm run dev:archive:write  # the same, with saves, new works and renames inside that folder only
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

0. The archive: see "Going live with the archive" above.
1. ~~Cloudflare Access~~: done 2026-11-22. Email-code sign-in as `michiel.nys129@gmail.com`
   tested live; the works list loads in test mode. Google sign-in is not tested yet.
2. Add Arne's email (see "Adding an editor"), then have him test "Sign in with Google".
3. ~~Real test save~~: done 2026-11-23. An alt-text edit, a photo upload and its removal
   each made one commit and deployed; the live page showed the changes.

## Notes

- Every account and resource above belongs to `michiel.nys129@gmail.com`. The old
  `michiel@ateliernys.com` is being deleted; on 2026-11-24 it was gone from the Cloud project
  IAM, the Access "Editors" list and GitHub, and was removed from the OAuth test users and the
  test Drive folder. Don't add it anywhere again. That
  Google account is supervised (Family Link): signing in to the Picker with it asks a parent
  to approve. For editing, use Arne's own Google account (`arnenys129@gmail.com` is a test user).
- Photos already in the repo are loaded through the Worker (`GET /api/photo/<commit sha>/src/assets/...`,
  behind Access like every other route), not from `raw.githubusercontent.com`, so the repo can be
  private. The Worker reads the file with the GitHub App token, pinned to that commit, using the
  raw media type (`application/vnd.github.raw`, files up to 100 MB; the base64 JSON form stops at
  1 MB). Only images (jpg, jpeg, png, webp, gif, avif) under `src/assets/` are served; anything else,
  including `..` and encoded slashes, is a 404 without asking GitHub. Responses are cached
  `private, max-age=31536000, immutable`, because the URL names the commit.
- Thumbnails are loaded at full size. That is fine for about 30 works, but heavy on a phone
  with mobile data, and each first view of a photo costs one GitHub API request (the App's
  limit is 5,000 an hour, far above what the editor uses).
- libheif-js is LGPL-3.0. It is shipped unmodified as a separate bundle
  (`public/build/convert-worker.js`), with its licence in the bundle's `.LEGAL.txt`.
