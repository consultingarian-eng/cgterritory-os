# CLAUDE.md

Guidance for Claude Code working in this repository. The person you're helping is usually an **office owner, not a developer**: explain in plain British English, one step at a time, and check your work before saying it's done.

## What this is

CGTerritory is the territory and field-planning map for a door-to-door sales office: areas (US ZIP codes or UK postcode sectors) on a live Leaflet map coloured by permit status; a ZIP drawer (households, drive time, permit details from AI research, incidents and Do-Not-Knock ✕ pins, delivery day and depot, notes, sales, last worked); coverage marks; worked doors synced from a field app; walking-route laps for pairs and solos from a park pin over OpenStreetMap streets; a pipeline, a schedule, and a Balance board of sales against per-delivery-day targets per depot. Built and run by Cube Group USA; MIT licence. The repo ships with a **fictional** sample territory.

## Skills: which to run

| Skill | When |
| --- | --- |
| `/setup` | Installing, running locally, the database, the R2 bucket, Railway, the domain, the first admin, email/AI/sales/field-app variables, "what's next?" |
| `/load-territory` | Their own areas and boundaries (US or UK), offices, depots and delivery days, Do-Not-Knock list, checking it on the map |
| `/brand` | App name, logo, icons, colours, words on screen, map styles |

The guides they follow live in `docs/` (`SETUP.md`, `DATA.md`, `ROUTES.md`, `UK.md`, `SERVICES.md`, `BRANDING.md`). If a skill and a guide disagree, trust the guide; if the guide and the code disagree, trust the code and say so.

## Repository map

```
server.js                Express app: auth + users, area edits (RAM store), coverage marks
                         (knocks), worked doors + geocode worker, sales source, Balance targets
                         (hub goals), AI permit research + territory extraction, field-app
                         integration routes (/api/integrations/*), nightly backup, page branding
lib/settings.js          Reads config/territory.json over defaults; normalizeAreaId; publicConfig
                         (served to the browser as /config.js → window.CGT_CONFIG)
lib/routes_api.js        Route endpoints, plan persistence/expiry, street-map cache (RAM → Mongo → R2)
lib/routegen.js          The route generator: pure functions, no I/O (generate, applyExclusions, prepare)
lib/osm.js               Overpass fetch (hedged mirrors) and the street/door graph for one area
lib/geo.js               Geometry helpers
lib/parcels.js, parcels/ US assessor parcel adapters (homes per building); none for the UK
lib/blobstore.js         Minimal S3/R2 client (SigV4, no SDK); off when CGT_S3_* unset
lib/backup.js            Nightly backup of every collection to R2 (optionally encrypted)
lib/security.js          Input validation (edits, incidents, strokes, prefs), rate limiter, CSRF
                         guard, security headers + CSP, generic errors, backup encryption
lib/sector_leader_setup.js  Create/update a sector leader for the field-app integration
config/territory.json    Owner settings: brand, timezone, regions, offices, hubs, labels. NO secrets
public/index.html        The app shell ({{APP_NAME}}-style placeholders filled by server.js)
public/js/app.js         The whole front end (large; vanilla JS + Leaflet). GUIDES near the bottom
public/css/style.css     Styles; colour variables at the top
public/sw.js             Service worker (CACHE, DATA_CACHE)
public/data/             master.json + <region>.geojson: the territory base layer
scripts/                 Loaders (import-territory, import-hubs, import-dnk, fetch-zcta-geojson,
                         seed-sample), check-config (npm run check), dev-mem (npm run dev:mem),
                         restore-backup, admin-reset-link (locked-out recovery), set-demo,
                         bulk-permit-research, parcel-check
scripts/lib/street-fixture.js  Made-up street map for sample ZIP 01108 (routes with no Overpass)
test/                    node --test suites (npm test); in-memory MongoDB, network blocked
samples/                 Fictional example inputs (territory, hubs, DNK, sales)
docs/                    Owner guides
.claude/skills/          The three skills above
```

## Run and check

```
npm install
cp .env.example .env          # then fill MONGODB_URI (a *_dev* database), JWT_SECRET (32+ chars),
                              # APP_URL=http://localhost:3000, ADMIN_EMAIL, ADMIN_NAME,
                              # INITIAL_ADMIN_PASSWORD, NODE_ENV=development,
                              # SALES_CSV_FILE=samples/sales.sample.csv
node scripts/seed-sample.js   # sample pipeline/hubs/targets + 01108 street map into an EMPTY database
npm start                     # http://localhost:3000 ; /healthz → ok when the RAM stores are warm
```

No database yet? `npm run dev:mem` starts an in-memory MongoDB, seeds the sample and starts the server (data is lost on Ctrl+C).

There is no build step. Before calling a change done:

- `npm test` (`node --test`): unit tests for `lib/security.js` (`test/security.test.js`), the route generator on the sample street map (`test/routegen.test.js`) and end-to-end security tests (`test/server.test.js`) that boot `server.js` against a throwaway in-memory MongoDB (the `mongodb-memory-server` dev dependency) with all outbound network blocked (`scripts/lib/block-net.js`). Never against a real database. Add a test when you add a write route or change who may do what.
- `npm run check` (`scripts/check-config.js`): checks `config/territory.json` against `public/data/` without a database or the network (regions and their files, every area has a polygon and the other way round, unique office and hub keys).

- `node --check` every JavaScript file you touched (`server.js`, `lib/*.js`, `scripts/*.js`, `public/js/app.js`, `public/sw.js`).
- Run the server locally against the `_dev` database and use the feature in the browser.
- For route-generator changes, call `routegen.generate()` / `applyExclusions()` directly on a street graph rather than fetching from Overpass again: `require('./scripts/lib/street-fixture').buildFixtureGraph()` gives the made-up 01108 grid (see `test/routegen.test.js`), or read a cached graph from the `osmcaches` collection of the `_dev` database. In the app, sample ZIP 01108 generates routes offline after `seed-sample.js` (park pin near 42.08124, -72.5625); the graph is flagged `fixture` and never refreshed from OSM.
- On macOS there is no `timeout` command; don't wrap commands in it.

## House rules

1. **The deploy-bump rule.** Phones cache the front end. In the **same commit**:
   - changed `public/js/app.js` → bump `/js/app.js?v=N` in `public/index.html` **and** `CACHE` in `public/sw.js`;
   - changed `public/css/style.css` → bump `/css/style.css?v=N` in `public/index.html` **and** `CACHE` in `public/sw.js`;
   - changed anything in `public/data/` → bump `DATA_V` in `public/js/app.js` (so also the app.js `?v=` and `CACHE`);
   - changed a logo or icon → bump `CACHE`, and the `?v=` on the favicon, apple-touch-icon and `{{LOGO}}` links in every HTML page that has one (the manifest's home-screen icons have no `?v=`; `CACHE` refreshes them).
2. **The GUIDES rule.** The ⓘ page guides (`GUIDES` near the bottom of `public/js/app.js`) quote button labels exactly. Any change to a button's label or to what a page does updates the guide text in the same change.
3. **Settings, not code, for business facts.** Offices, depots, regions, time zone, labels and brand come from `config/territory.json` via `lib/settings.js` (server) and `window.CGT_CONFIG` (browser). Don't hard-code an office, hub, state, client name or URL.
4. **Dates are calendar dates in `settings.timezone`** (`APP_TIMEZONE`, else `timezone` in `config/territory.json`, else America/New_York). Never derive "today" from `toISOString()` (UTC).
5. **One server process per database.** RAM stores, route jobs and background work live in-process; never suggest replicas.
6. **Write routes go through `requireAuth`** (it refuses demo accounts' writes); sector leaders' limits are enforced on the server, not only hidden in the UI. Server-to-server routes use `requireServiceToken`.
7. **Be gentle with OpenStreetMap services.** Don't loop Overpass or Nominatim calls; use cached graphs and the geocode cache; keep the identifying User-Agent.
8. **Stored text is never markup.** Anything a user, an import, a field app, OpenStreetMap or the AI wrote goes into HTML through `esc()` (or `textContent`), in attributes too. Values that are rendered or scheduled on are validated on the way in, in `lib/security.js`: edits (`validateEditPatch`; incidents are rebuilt field by field; households, `dist_miles_*`, `drive_mins_*`, `transit_mins_*` must be numbers and place names plain text, mirrored on load by `cleanEdits()` in `app.js` for older rows), coverage strokes (`sanitizeKnock`), preferences (`sanitizePrefs`, an allow-list: a new pref key must be added there). `INCIDENT_TYPES` exists in both `public/js/app.js` and `lib/security.js`; change both.
9. **No inline script.** The Content-Security-Policy runs only script files from this site, plus the one SheetJS file on unpkg (`CDN_SCRIPT` in `lib/security.js`, the exact URL, never the whole origin; pinned by integrity hash in `ensureXLSX()`, change both together). Inline `<script>` blocks in the HTML pages are allowed by hash automatically (`sendBranded`); `onclick="…"` attributes and `javascript:` links never run. Use `addEventListener` or a `data-` attribute with a delegated listener.
10. **Writes are JSON from this origin.** The CSRF guard refuses API writes with a non-JSON body or a foreign `Origin`/`Sec-Fetch-Site`. Browser code sends `Content-Type: application/json`; server-to-server routes live under `/api/integrations/`.
11. **Errors to the browser are generic.** Use `sec.sendError(res, e, tag)`: a 4xx keeps its message, anything else is logged and answered with a generic line.
12. **One model setting.** Every Anthropic call uses `AI_MODEL` (`ANTHROPIC_MODEL`, default `claude-sonnet-5-5`) and takes from the daily AI budget (`takeAiBudget`).

## Safety rules (non-negotiable)

- **Never commit `.env` or any secret**, and never put secrets in `config/territory.json`. Run `git status` before every commit.
- **Never print a secret.** Not `cat .env`, not `railway variables`. Check presence, not values (`node -e "require('dotenv').config({ quiet: true }); console.log(['MONGODB_URI','JWT_SECRET'].map(k => k + ': ' + !!process.env[k]).join('\n'))"`). If you must refer to one, show at most its first 4 characters.
- **Never point a local server or a loader script at the live database** unless the owner has said yes to that specific action. Locally, `MONGODB_URI` uses a `_dev` database, and the `CGT_S3_*` variables are left out (so a local run never writes to live backups). Use `--dry-run` first with the loader scripts (`import-hubs`, `import-dnk`); live loads go through `railway run -- …` ([docs/SETUP.md](docs/SETUP.md#the-railway-command-line-for-recovery-restores-and-loading-live-data)). Give the owner commands that work in PowerShell too (flags, not `NAME=value` prefixes).
- **Never email anyone while testing.** Invites go only to addresses the owner gives you for that purpose, with their go-ahead.
- **Never commit residents' personal data** (Do-Not-Knock lists, incident details, worked doors, sales addresses). They go into the database through the loaders, from files kept outside git.
- **Pushing to the owner's `main` deploys to production.** Say so before you push, and push only when they ask.
- Keep the fictional sample clearly fictional if you touch it: no real people, customers or residents.
