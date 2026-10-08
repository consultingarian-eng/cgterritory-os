---
name: load-territory
description: Load the office owner's own territory into CGTerritory, replacing the fictional sample - US ZIP codes (Census ZCTA boundaries) or UK postcode sectors (built from open postcode data), their offices with locations, regions, depots (hubs) and delivery days, starting statuses and permit notes, and optionally their Do-Not-Knock list - then check it on the map before anything goes live. Dry-runs every database write and asks before touching the live database. Use when they want to add or replace their areas, ZIPs, postcodes or sectors, boundaries, offices, hubs, depots, delivery days, a Do-Not-Knock list, or "get my territory on the map".
argument-hint: "[us|uk]"
---

# Load their territory, and prove it on the map

You're helping an office owner replace the fictional sample (12 ZIPs around Springfield, Massachusetts, with made-up offices and depots) with **their** territory. Explain each step in plain British English, one at a time.

Read first: `docs/DATA.md` (the source of truth for this skill), `config/territory.json`, `lib/settings.js` (every settings key and default), `scripts/import-territory.js`, and for a UK owner `docs/UK.md`. If this skill and the docs disagree, trust the docs (and the code over both) and say so.

## Ground rules

- **Work locally first, against the `_dev` database** (`MONGODB_URI` ending `_dev`; check the name without printing the URI, as in `/setup`). Nothing goes to the live database until the owner has seen it on their own computer and said yes.
- **Every database loader runs with `--dry-run` first**, and you show the owner the summary.
- **Commands must work on their machine.** Ask Mac or Windows once. The loader scripts take flags (`--dry-run`, `--with-days`), which work the same in PowerShell; never give a Windows owner `NAME=value node …` (in PowerShell that's `$env:NAME="value"; node …`).
- **Keep their raw files out of git.** Put downloads and source files in `boundaries/` (git-ignored). A Do-Not-Knock list is residents' personal data: never commit it, never copy it into `public/data/`, never paste its rows into the chat beyond what's needed to fix a problem.
- **Be gentle with public services.** One download per US state. Look up office locations by asking the owner, or with at most one Nominatim request per office (with the identifying User-Agent). No Overpass calls in this skill.
- **Never invent data.** Statuses, permit notes and households come from the owner or a cited public source; if unknown, leave them out (areas start as `GREY`, Not Reviewed).

## Step 1. US or UK, and their settings

Ask (or take `$ARGUMENTS`): US or UK? Then gather and write into `config/territory.json` (replace the sample values; keep `_comment` short and true):

- **Offices**: for each, a lowercase `key` (explain it's permanent), a `label`, a map `color`, its `address`, and `lat`/`lng`. Ask for coordinates (right-click in Google Maps → copy) or look each address up once.
- **Regions**: US → one per state they work (`{ "code": "CT", "label": "Connecticut" }`). UK → one per postcode area or county they work (`{ "code": "LS", "label": "Leeds" }`). Each office's `regions` lists the ones it covers by default.
- **Hubs** (if their client delivers from depots): `key`, `label`, `short` (3 letters), and any other spellings in their sheets as `aliases`.
- **UK only**: `timezone` `Europe/London`, `countryCodes` `["gb"]`, `areaLabel` `Sector`, `research.region` (e.g. `England, United Kingdom`) with notes from `docs/UK.md` → Permits.
- `sales.pinBounds`: a box around their whole territory, `[minLat, minLng, maxLat, maxLng]`, with some margin.
- `balanceEpoch`: today's date, if they'll use Balance.

Validate: `node -e "const {settings}=require('./lib/settings'); console.log(settings.offices.map(o=>o.key), settings.regions.map(r=>r.code), settings.hubs.map(h=>h.key))"`.

## Step 2. Their list of areas

Take whatever they have (a spreadsheet, a pasted list, a PDF) and make `boundaries/areas.csv` with the columns in `docs/DATA.md` → "Your list of areas": the id, `state`/`region`, and any of `county`, `city`, `municipality`, `households`, `color`, the permit fields. Check every id with `normalizeAreaId` from `lib/settings.js` and show the owner any that fail. Read the CSV back to them as counts per region and per status, not row by row.

## Step 3. Boundaries

**US**: for each state, once: `node scripts/fetch-zcta-geojson.js <STATE>` → `boundaries/<st>-zcta.geojson`. Tell them ZCTAs approximate ZIPs and that PO-box ZIPs have no shape.

**UK**: postcode sectors have no free official polygons, so build approximate ones from open postcode points, as `docs/UK.md` explains:

1. The owner downloads **OS Code-Point Open** (free, from the Ordnance Survey OpenData site) or the **ONS Postcode Directory** (Open Geography Portal), and puts it in `boundaries/`. Explain the Open Government Licence and the attribution it requires.
2. Keep only live postcodes (the ONS directory has a termination-date column) in the owner's postcode areas, with their coordinates (Code-Point Open uses British National Grid eastings/northings: convert to WGS84 latitude/longitude).
3. Build the shapes in a **separate scratch folder** (e.g. `boundaries/build/` with its own `package.json`, so the app's dependencies don't change): a Voronoi cell per postcode point, each cell clipped to a few hundred metres around its point (so coastal and rural cells don't sprawl), then merged per sector (`LS6 3`). Libraries such as `d3-delaunay` and `@turf/turf` do this; Python with `shapely` works as well.
4. Write one GeoJSON with the sector id in a property (e.g. `sector`), and pass `--id-prop sector` in the next step.
5. Add the attribution to their README.
6. Tell the owner plainly: **there is no tested script for this step in the repository; you generated it**, and the shapes are approximate. In step 5 they must check a few sectors against a postcode lookup before trusting them (`docs/UK.md` → Check the shapes). Keep the build script in `boundaries/build/` so it can be re-run.

Or, if they hold a licensed postcode-boundary product, use that file directly with the right `--id-prop`.

## Step 4. Build the map files

```
node scripts/import-territory.js --areas boundaries/areas.csv --geojson boundaries/<file>.geojson [--id-prop NAME] [--region CODE] [--merge]
```

Without `--merge` it replaces `master.json` (that's what we want when swapping out the sample). Read its output: every area should have a polygon. Chase down each "no polygon for" id (a typo, a retired ZIP, a sector missing from the boundary file) before going on.

Then:
- Delete region files in `public/data/` that are no longer in `regions` (the sample's `ma.geojson` if they don't work Massachusetts).
- Bump `DATA_V` in `public/js/app.js`, the `/js/app.js?v=` in `public/index.html`, and `CACHE` in `public/sw.js` (the bump rule).
- `npm run check` must pass with no errors (warnings explained to the owner), and `node --check public/js/app.js`.

## Step 5. Check it on the map (locally)

1. Point `.env` at a **fresh** `_dev` database (the sample's seeded state refers to sample ZIPs): change the database name, e.g. `cgterritory_dev2`, or ask before emptying the old one.
2. `npm start`, sign in at http://localhost:3000.
3. Ask the owner to check, and check with them:
   - every region chip shows, and the map opens over their territory;
   - search finds a few areas they know; the colours match the statuses they gave;
   - a drawer shows the right town, households and the distance and drive time from the right office;
   - areas near the line between two offices are allocated to the office they expect (if not, they can set it per area on its Pipeline card).
4. Fix anything wrong at the source (the CSV or settings) and re-run step 4; don't hand-edit `master.json`.

## Step 6. Depots and delivery days (if they use Balance)

Make `boundaries/hubs.csv` with `Zip` (or `Postcode`/`Sector`), `Hub`, `Delivery Day`, then:

```
node scripts/import-hubs.js --dry-run boundaries/hubs.csv
node scripts/import-hubs.js boundaries/hubs.csv               # into the _dev database (hubs only)
node scripts/import-hubs.js --with-days boundaries/hubs.csv   # hubs and delivery days
```

Show them the Balance page locally. Targets per day are typed on the Balance page itself.

## Step 7. Do-Not-Knock list (if they have one)

Talk through `docs/UK.md` → Data protection (UK) or the general point (US): record the address, the date and "do not knock", nothing about the people. Then:

The area column may be called `zip`, `postcode` or `sector` (a full UK postcode is fine: it's filed under its sector and used whole for the look-up); `state` may be empty.

```
node scripts/import-dnk.js --dry-run boundaries/dnk.csv     # looks addresses up, writes nothing
node scripts/import-dnk.js boundaries/dnk.csv               # into the _dev database
```

Rows with `lat`/`lng` are placed as given; others are looked up at about one a second, so a long list takes a while. Report how many were placed and list (to them, briefly) any that couldn't be.

## Step 8. Go live

When the owner is happy with the local result:

1. Commit `config/territory.json`, `public/data/`, and the bumps (`git status` first: no `.env`, nothing from `boundaries/`). Ask before pushing: **pushing to `main` deploys**.
2. After the deploy, the live map shows their areas. Statuses, notes and permit details from the CSV are already in `master.json`.
3. Depots/delivery days and Do-Not-Knock go into the **live** database by running the same scripts through `railway run --`, which lends them the live variables, **only after the owner says yes** to each. Check the Railway command line first: `railway --version` and `railway status` (it must name their project and the app's service). If either fails, walk them through `docs/SETUP.md` → "The Railway command line" (install, `railway login`, `railway link`). Then `railway run -- node scripts/import-hubs.js --dry-run boundaries/hubs.csv`, show the summary, and after a yes the same without `--dry-run` (add `--with-days` if wanted); likewise `import-dnk.js`. The same commands work in PowerShell. Never run `scripts/seed-sample.js` against the live database.
4. Ask them to open the live app on their phone and check one area and, if loaded, one ✕ pin.

## When you finish

Summarise: areas loaded per region, any without shapes, offices and hubs set, what's in the live database, what's still to do (sales source, field-app doors: `docs/DATA.md`; branding: `/brand`). Remind them to keep `boundaries/` and any Do-Not-Knock file safe and out of git.
