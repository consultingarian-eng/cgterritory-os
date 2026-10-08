# Outside services

Everything CGTerritory talks to, what each one powers, and what happens without it. Only MongoDB and somewhere to host the app are required; everything else switches on when you add its settings in [`.env.example`](../.env.example) terms. Prices change, so follow the links rather than any figure here.

| Service | Needed? | What it does here | Without it |
| --- | --- | --- | --- |
| [MongoDB Atlas](https://www.mongodb.com/atlas) | **Required** | The database: users, area edits and pipeline, coverage marks, worked doors, route plans, hub targets, cached street maps | The app won't start properly |
| [Railway](https://railway.com) (or any Node.js host) | **Required** | Runs the app on the internet | Only runs on your own computer |
| A domain | Recommended | `territory.yourcompany.co.uk` instead of a Railway address | Use the Railway address |
| [Cloudflare R2](https://developers.cloudflare.com/r2/) (or any S3-compatible storage) | Strongly recommended | Nightly database backups; the big street maps and parcel sets | **No backups at all** on Atlas's free tier; street maps are stored inside MongoDB instead |
| [SendGrid](https://sendgrid.com) | Strongly recommended | Invite emails for new users, password resets, backup-failure alerts | New users never receive their invite link, and "Forgot password" does nothing |
| [Anthropic](https://console.anthropic.com) (Claude) | Optional | **🤖 Research with AI** (permit rules for an area) and **🤖 Extract with AI** (reading a photo, PDF or messy sheet of territories) | Those two buttons return an error; everything else works |
| [Brave Search API](https://brave.com/search/api/) | Optional | A fallback search for permit research, used only if Anthropic's own web search fails | Research uses Anthropic's web search only |
| [Google Sheets API](https://developers.google.com/sheets/api) (service account) | Optional | Reads your sales sheet: sales per area, sale pins, and the Balance board | No sales, sale pins or Balance numbers |
| Your field app | Optional | Pushes the doors your reps knocked, so the map shows them and routes skip them | Coverage comes only from leaders' ✏ Mark Off strokes |
| [OpenStreetMap](https://www.openstreetmap.org) via Overpass | Used automatically | Streets, buildings and addresses for walking routes | No routes |
| Geocoders: [US Census geocoder](https://geocoding.geo.census.gov/), [Nominatim](https://nominatim.org) | Used automatically | Turning addresses into map positions: incident and Do-Not-Knock ✕ pins, worked doors | Addresses can't be pinned |
| Map tiles: [OpenStreetMap](https://www.openstreetmap.org), [Esri](https://www.esri.com) | Used automatically | The Street, Dark and Satellite base maps | Blank map background |

## MongoDB Atlas

The database. You can start on the free M0 tier (512 MB of storage; current limits on [Atlas's pricing page](https://www.mongodb.com/pricing)) and move to a paid tier later on the same connection string. How long the free tier lasts depends on how many worked doors and coverage marks you keep (see below).

- **The free tier keeps no backups.** That's why the app copies the whole database to your R2/S3 bucket every night (see below). Set up R2 before you put real work into the app.
- **Shared tiers throttle big reads** once they've used their data-transfer allowance. The app is built around that: the large collections (coverage marks, worked doors, area edits) are read once into the server's memory at start-up and kept current with small updates, so the map doesn't wait on the database. A busy office with a lot of worked-door history may still outgrow the free tier; the first sign is a slow start after a deploy (the health check stays on "warming").
- Network access: Railway's outgoing addresses change, so allow `0.0.0.0/0` and rely on a strong database password.

## Railway

Hosts the Node.js server. `railway.json` tells it how to build and start the app and to wait for `/healthz` before switching traffic to a new deploy. `/healthz` answers "ok" only once the in-memory stores have loaded, so nobody sees a half-loaded app after a deploy.

**Run one copy only.** The in-memory stores, the route-generation jobs, the nightly backup and the background geocoding all live inside the single server process. Railway calls each running copy of a service a *replica*; keep it at one. Two copies would each hold their own copy of the data and miss each other's changes for up to half an hour.

Any other host that runs Node.js 20.19 or newer and gives the app a `PORT` works the same way.

## Cloudflare R2 (or another S3-compatible store)

One private bucket holds:

| Path in the bucket | What | How often |
| --- | --- | --- |
| `backups/<date>/` | A copy of every database collection as gzipped lines (encrypted when `BACKUP_ENCRYPTION_KEY` is set), plus a `manifest.json` written last (a night without one didn't finish) | Every night after 03:00 in the app's time zone; kept 30 days. Worked doors and the geocode cache are copied whole weekly plus each night's changes |
| `graphs/<area>.json.gz` | Each area's street map for routes | When an area is first mapped, then about monthly |
| `parcels/<area>.json.gz` | US property-tax parcel sets (homes per building) | When an area is mapped, refreshed every 180 days |

For R2's current storage and request charges, and its free allowance, see [Cloudflare's R2 pricing](https://developers.cloudflare.com/r2/pricing/). S3, Backblaze B2, Wasabi and MinIO work too, since the app talks plain S3 (it signs its own requests; no SDK).

A failed backup retries every 20 minutes and emails the admin address once a day (needs SendGrid). Admins can see the nights on hand at `/api/admin/backups`. Restoring is in [docs/DATA.md](DATA.md#9-backups-and-restoring).

## SendGrid

Sends three kinds of email: the **invite** when an admin adds a user (a link to set their password, valid 7 days), the **password reset** link (valid 1 hour), and the **backup-failure** alert. Without a key the server logs "SENDGRID_API_KEY not set — skipping email" and carries on, which means a new user never gets their link. You need a verified sender address on your own domain. Any email provider could replace it; the sending is in one function, `sendMail()` in `server.js`.

## Anthropic (Claude)

Two features:

- **🤖 Research with AI**, in an area's drawer under Permit: searches the web for the local rules on door-to-door selling or canvassing (who issues permits, fees, lead times, hours, restricted days, the ordinance) and fills in the permit fields. It uses Anthropic's server-side web search, so it's the expensive call: at most 5 areas per request and 10 requests per user per 10 minutes, and only admins and clients can run it. **Always check the results before a team goes out**, and treat them as text from the web: the app shows them as plain text, never as markup.
- **🤖 Extract with AI**, in **+ Add Territories**: reads a photo, PDF (under 10 MB), pasted text or messy spreadsheet of new territories into rows. Admins and clients only, 10 per user per 10 minutes.

Both use one model, set with `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`). On top of the per-user limits, `AI_DAILY_LIMIT` caps AI calls for the whole board per day (default 200; `0` switches the AI features off), so a single account, or a stolen session, can't run up the bill.

Point the research at your jurisdiction with `research.region` and `research.notes` in `config/territory.json`. The search steps in the prompt (`RESEARCH_SYSTEM` in `server.js`) were written for US town ordinances; for the UK, see [docs/UK.md](UK.md#permits). Set a monthly spend limit in the Anthropic Console.

## Google Sheets (sales)

If your client or your own team keeps a sheet of sales, the app reads it with a Google Cloud **service account** (read-only): at start-up, whenever someone opens the app and the copy it holds is more than an hour old, on **↻ Sync sales**, and twice each morning. From it come: sales per area on the map and in each drawer, sale pins on the map (if the sheet has latitude and longitude columns), the "strong week" that puts an area into its 12-week rest, areas moved to **In Field** automatically when they get 5 or more sales in 4 weeks, and the Balance board. The columns it looks for are in [docs/DATA.md](DATA.md#6-sales).

## Your field app (worked doors)

Whatever app your reps use to log doors can push them to the map. The push address and its format are in [docs/DATA.md](DATA.md#8-worked-doors-from-your-field-app). The **↻ Sync doors** button asks your field app to push its latest doors straight away; it works only if your field app offers an address for that (`FIELD_APP_SYNC_URL`). Without it, doors arrive whenever your field app sends them.

## OpenStreetMap, Overpass and the geocoders

All free, run by volunteers or public bodies, and used gently: see [docs/ROUTES.md](ROUTES.md#7-openstreetmap-and-overpass-fair-use) for how route data is fetched and cached.

- **Overpass** supplies the streets and buildings. The app tries `OVERPASS_URL` first if you set it, then a list of public servers.
- **US Census geocoder**: free, no key, house-level, **US addresses only**. Used first, including a batch mode for big backfills of worked doors.
- **Nominatim** (OpenStreetMap's geocoder): the fallback. Its [usage policy](https://operations.osmfoundation.org/policies/nominatim/) asks for at most one request a second and an identifying `User-Agent`; the app paces its requests and caches every answer permanently in the `geocaches` collection, so a house is only ever looked up once. The app identifies itself with your app name and `GEOCODER_CONTACT` (or `ADMIN_EMAIL`); make sure that's an address you read.

## Map tiles

The base maps are drawn from public tile servers (`BASE_LAYERS` in `public/js/app.js`): **Street** from OpenStreetMap's own tile server, **Dark** and **Satellite** from Esri. Each has its own terms ([OpenStreetMap tile usage policy](https://operations.osmfoundation.org/policies/tiles/); Esri's terms for its basemaps). A handful of users is light use, but if your team grows, or you're unsure the terms fit your use, switch to a tile provider you have an account with. [docs/BRANDING.md](BRANDING.md#map-styles) shows where.

## Loaded in the browser

Fonts come from Google Fonts. The spreadsheet reader used by **Import** and **Upload CSV / Excel** (SheetJS) is loaded from unpkg.com the first time it's needed. Leaflet, the map library, is served by the app itself from `public/vendor/leaflet/`, on the map and on the printable **⤓ Export Map** page. The security policy lets the browser load that one SheetJS file from unpkg.com and no other script from outside the app.
