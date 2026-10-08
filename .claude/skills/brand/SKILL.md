---
name: brand
description: Rebrand the office owner's copy of CGTerritory - app name, tagline, company name and website, logo, browser and home-screen icons, colours (app, sign-in pages, emails), status and label wording, what they call their client, field app and areas, fonts and base-map styles - keeping the deploy-bump rule and the in-app guides in step. Previews locally before anything is pushed. Use when they ask to brand, rename, re-skin or recolour the app, change the logo or icons, change words on screen, or switch map styles.
argument-hint: "[name|logo|icons|colours|words|map]"
---

# Make CGTerritory theirs

You're helping an office owner put their own name, logo and look on their copy. Plain British English, one change at a time, previewed locally before anything is pushed.

Read first: `docs/BRANDING.md` (the source of truth), `config/territory.json`, `lib/settings.js`, and the top of `public/css/style.css`. If this skill and the guide disagree, trust the guide (and the code over both) and say so. If they named an area of work (`$ARGUMENTS`), start there.

## Ground rules

- **Settings before code.** Name, tagline, company, website, logo paths, theme colour, office colours and labels for client, field app and areas all live in `config/territory.json`. Only colours, fonts, status names and map styles need code edits.
- **The bump rule, every time**, in the same commit as the change:
  - `public/js/app.js` changed → its `?v=` in `public/index.html` and `CACHE` in `public/sw.js`;
  - `public/css/style.css` changed → its `?v=` in `public/index.html` and `CACHE` in `public/sw.js`;
  - a logo or icon changed → its `?v=` in every HTML page that references it (`index.html`, `login.html`, `set-password.html`, `export-map.html`) and `CACHE` in `public/sw.js`.
- **The GUIDES rule.** If a button label or the meaning of a page changes, update the matching text in `GUIDES` near the bottom of `public/js/app.js` in the same change. Labels are quoted exactly there.
- **No impersonation, no borrowed brands.** Use only names, logos and colours the owner has the right to use. Don't add another company's logo or name unless the owner confirms they're entitled to.
- **Nothing secret goes in `config/territory.json`**, and a map provider's API key in a tile address is visible to every user: only a key restricted to their domain, never one that can spend money.
- **Preview locally** (`npm start` against the `_dev` database; hard-refresh, or open in a private window, to beat the service worker) before suggesting a commit. Ask before pushing: pushing to `main` deploys.

## 1. Name and words

Ask for: the app's name, a short tagline, their company name and website. Set `brand.appName`, `brand.tagline`, `brand.description`, `brand.orgName`, `brand.orgUrl`. Then the words their team uses:

- `client.name` and `client.salesLabel` (the company they sell for, and its sales);
- `fieldApp.name` (their field app);
- `areaLabel` (`ZIP` or `Sector`);
- office `label`s and hub `label`s (never change a `key` here; see `docs/BRANDING.md`).

Status and pipeline names (`STATUS_LABELS`, `PIPELINE_STAGES` near the top of `public/js/app.js`) change only if they really want it; update `GUIDES` text that quotes them, then bump.

Check: restart, open `/login` (title, tagline, company and footer link) and the app's top bar.

## 2. Logo

- `public/logo.svg` (top bar and sign-in page) and `public/logo.png` (emails, ~128 × 128, transparent). Ask for their files; if they only have one format, convert carefully (an SVG from a PNG is just a wrapper; say so).
- Or keep their files under another path in `public/` and set `brand.logo` / `brand.logoPng`.
- Bump the logo's `?v=` in the HTML pages and `CACHE`.

## 3. Icons

From one square master image (at least 512 × 512), make: `favicon.png` (32), `favicon-32.png`, `favicon-16.png`, `apple-touch-icon.png` (180), `icon-192.png`, `icon-512.png`, and `icon-maskable-512.png` (logo inside the central 80%, solid background to the edges). On a Mac, `sips -z <h> <w> in.png --out out.png` resizes without installing anything; otherwise use whatever image tool they have. Show them the maskable icon before keeping it. Bump the icons' `?v=` and `CACHE`. Tell them an installed home-screen icon may only change after they remove and re-add the app.

## 4. Colours and fonts

- `brand.themeColor` in settings (phone status bar, splash).
- The variables at the top of `public/css/style.css` (`--bg`, `--panel`, `--panel-2`, `--panel-3`, `--line`, `--ink`, `--muted`, `--dim`, `--accent`, `--accent-dim`, `--accent-glow`, `--grad`, `--select`). Change them as a set; keep text contrast readable (aim for at least 4.5:1 for body text) and check the map overlays still read.
- The same palette in the `:root` blocks of `public/login.html` and `public/set-password.html` (they don't load `style.css`).
- Email colours in `emailLayout()` and the invite and reset emails in `server.js`.
- Office colours in settings. Status colours in `COLOR_DEFAULTS` in `public/js/app.js` (people can also override these for themselves under **Colors**).
- Fonts: the Google Fonts `<link>` in each HTML page and `--display`, `--body`, `--mono` in `style.css`.

Bump `style.css` (and `app.js` if touched) and `CACHE`.

## 5. Map styles

`BASE_LAYERS` in `public/js/app.js`. Explain what's there (OpenStreetMap standard tiles for Street, Esri for Dark and Satellite) and that each provider has terms. If they want another provider, they create the account and a **domain-restricted** key; you swap the `url` and `attribution` (keep attribution). Bump `app.js` and `CACHE`. Check all three styles load locally and the attribution shows.

## 6. Service worker cache name (optional)

They may rename the `cgterritory-` prefix of `CACHE` and `DATA_CACHE` in `public/sw.js` to their app's name. `CACHE` must still change on every front-end deploy.

## When you finish

Run `node --check` on every JS file you touched, `git status` (no `.env`), and summarise what changed and which versions you bumped. Ask before committing and before pushing. After the deploy, have them open the live app on a phone (close and reopen it once) to see the new look.
