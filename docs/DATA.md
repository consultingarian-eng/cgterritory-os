# Loading your territory and data

In Claude Code, `/load-territory` does all of this with you and checks it on the map. This page explains what it does and where everything lives, so you can do it by hand or understand what you're looking at.

Throughout, an **area** is one shape on the map: a US ZIP code (`01001`) or a UK postcode sector (`LS6 3`). The code and some screens call it a "ZIP" either way.

**Running the commands.** Run them in a terminal in your copy's folder; they are written to work the same in Mac/Linux Terminal and Windows PowerShell (options are `--flags`, not `NAME=value` prefixes). The loader scripts read `MONGODB_URI` from your `.env`, which points at your **`_dev`** database. To run one against the **live** database, put `railway run --` in front of it (set up once: [docs/SETUP.md](SETUP.md#the-railway-command-line-for-recovery-restores-and-loading-live-data)), for example `railway run -- node scripts/import-hubs.js --dry-run my-hubs.csv`. If you ever need to set a variable for one command by hand: Mac/Linux `NAME=value node …`; PowerShell `$env:NAME="value"; node …` (it stays set until you close that window).

## Where your data lives

| What | Where | Changed by |
| --- | --- | --- |
| Your offices, depots (hubs), regions, time zone, labels | `config/territory.json` | You, then deploy |
| The list of areas and their starting details (town, county, households, status, permit notes, distance from each office) | `public/data/master.json` | `scripts/import-territory.js`, then deploy |
| The area shapes, one file per region | `public/data/<region>.geojson` | `scripts/import-territory.js`, then deploy |
| Everything changed in the app: status, pipeline stage, dates, targets, office, hub, delivery day, permit details, incidents, Do-Not-Knock, hold-ups | the `edits` collection in MongoDB, one document per area | The app, and the loader scripts |
| Coverage marks | `knocks` collection (kept 12 weeks) | ✏ Mark Off |
| Worked doors | `workeddoors` collection (kept about 6 months) | Your field app |
| Route plans | `routeplans` collection | ⚡ Generate |
| Balance targets and cycles | `hubgoals` collection | The Balance page |
| Users | `users` collection | Manage Users |

`master.json` and the shapes are the base layer, shipped with the code; what people change in the app is layered on top from the database. So reloading `master.json` never wipes the work your team has done in the app.

The repository ships with a small **fictional sample**: 12 real public ZIP boundaries around Springfield, Massachusetts, with made-up offices (East and West), depots (Riverside and Hilltop), statuses, notes and figures. `samples/` holds the matching example input files, and `scripts/seed-sample.js` fills an empty database with the sample's pipeline and targets. Replace all of it with your own.

## 1. Your settings first

Before loading areas, `config/territory.json` must list:

- **`regions`**: one entry per boundary file, e.g. `{ "code": "CT", "label": "Connecticut" }` for a US state, or `{ "code": "LS", "label": "Leeds" }` for a UK postcode area. Each region's shapes go in `public/data/<code in lowercase>.geojson` (or the `file` you give).
- **`offices`**: each with a short lowercase `key` (it's stored on users and areas, so choose it once and keep it), a `label`, a map `color`, the `regions` it covers by default, and its `lat`/`lng` so distances can be worked out.
- **`hubs`** (optional): the depots or delivery hubs your client services areas from, each with a `key`, `label`, a 3-letter `short` code and any other spellings (`aliases`) that turn up in their spreadsheets.
- **`timezone`**, **`areaLabel`**, **`countryCodes`**: see [docs/UK.md](UK.md#checklist-for-a-uk-copy) for UK values.

The server reads the file once at start-up: restart or deploy after changing it. [docs/BRANDING.md](BRANDING.md#company-settings) covers every key.

## 2. Boundaries

### US: ZIP code shapes

The US Census Bureau publishes ZIP Code Tabulation Areas (ZCTAs): shapes that approximate ZIP codes (public domain). Some ZIPs (PO boxes, single large buildings) have no shape.

```
node scripts/fetch-zcta-geojson.js CT
```

downloads one state's ZCTA shapes (from the OpenDataDE project, which republishes the Census files per state) into `boundaries/ct-zcta.geojson`. The `boundaries/` folder is git-ignored: a whole state is tens of megabytes, and only your areas are kept in the next step. For the newest boundaries, the Census Bureau's own TIGER/Line ZCTA files work too, converted to GeoJSON.

### UK: postcode sector shapes

See [docs/UK.md](UK.md#boundaries-where-the-shapes-come-from) for the sources and licences. There is no ready-made script for this step: `/load-territory` has Claude Code build approximate sector shapes from open postcode points, in a scratch folder, and save them as one GeoJSON file per region with the sector id (`LS6 3`) in a property you name with `--id-prop`. The shapes are approximations, so **check them on the map before relying on them** ([docs/UK.md](UK.md#check-the-shapes)).

## 3. Your list of areas

A CSV file, one row per area. See `samples/territory.sample.csv`.

| Column | Needed? | What |
| --- | --- | --- |
| `zip` (or `postcode`, `sector`, `area`) | Yes | The area id. ZIPs that lost their leading zero in a spreadsheet get it back; a full UK postcode is folded to its sector |
| `state` (or `region`) | Yes, unless you pass `--region` | A region code from `config/territory.json` |
| `county`, `city` (or `town`), `municipality`, `households` | Recommended | Shown in the drawer and search; `households` drives density and route estimates where streets are sparse |
| `color` | Optional | Starting status: `GREEN` Good to Pitch · `YELLOW` Permit Needed · `TEAL` Permit Secured · `RED` Big Blocker · `GREY` Not Reviewed (the default) |
| `permit_required` (Y/N), `authority`, `hours`, `days_restricted`, `other_restrictions`, `verification_status`, `internal_notes` | Optional | Starting permit details, shown in the drawer's Permit section |

Any other column is copied onto the area as it is.

Then build the map files:

```
node scripts/import-territory.js --areas my-areas.csv --geojson boundaries/ct-zcta.geojson
```

- `--id-prop NAME` if the boundary file keeps the id in a property other than `POSTCODE`, `ZCTA5CE20`, `ZCTA5CE10`, `ZIP`, `GEOID20` or `name`.
- `--region CODE` for a CSV without a state/region column.
- `--merge` to add to the areas already in `master.json` instead of replacing them (for a second state, say).

It writes `public/data/master.json` and one `public/data/<region>.geojson` per region, keeping only your areas and rounding coordinates to about a metre so the files stay small. It also works out, for each office with a `lat`/`lng`, the straight-line distance (`dist_miles_<office>`) and an estimated drive time (`drive_mins_<office>`, distance × 1.25 at 45 mph). If you have real drive times, overwrite those columns. An area goes to the nearer office unless someone assigns it by hand on its Pipeline card.

It prints the areas it found no shape for: check them. Then run `npm run check`, which checks your settings against the files (every region has its file, every area a shape and a region, office and hub keys are unique) without needing the database.

**Then bump `DATA_V`** in `public/js/app.js` (and the `app.js` `?v=` and `sw.js` `CACHE`; see [the bump rule](SETUP.md#deploying-changes-the-bump-rule)), commit and deploy.

**+ Add Territories** in the app only accepts areas that are already in `master.json` (others are skipped). When your client sends areas you don't have yet, add them to your CSV and run the import again with `--merge` first.

## 4. Statuses, the pipeline and permit details in bulk

Once areas are on the map:

- **Import** (top bar) updates many areas from a spreadsheet: status, delivery day, hub, density, who's permitted, the permit fields, your flag and notes. Map your columns, check the preview, **Apply import**.
- **+ Add Territories** puts areas into the Pipeline's Incoming column with delivery day, hub, work date, target and "complete first". It takes a typed list, a CSV or Excel file, or (with the AI key) a photo or PDF via **🤖 Extract with AI**.
- **Paint** and **Select** set the status of areas by tapping them on the map.

## 5. Depots (hubs) and delivery days

If your client delivers to each area on a fixed weekday from a depot, the Balance board tracks sales against target per delivery day. Each area needs its `hub` and `delivery_day`.

A CSV with `Zip` (or `Postcode` / `Sector`), `Hub` and `Delivery Day` (Monday… / Mon… / 1–7 with 1 = Monday) columns, like `samples/hubs.sample.csv`:

```
node scripts/import-hubs.js --dry-run my-hubs.csv     # preview, no database
node scripts/import-hubs.js my-hubs.csv               # set hubs
node scripts/import-hubs.js --with-days my-hubs.csv   # also set delivery days
```

(Live database: `railway run -- node scripts/import-hubs.js …`, see [Running the commands](#loading-your-territory-and-data).)

Hub names are matched against each hub's key, label and `aliases` in `config/territory.json`; unknown names are skipped and reported. Delivery days are only written with `--with-days`, so re-importing never overwrites corrections made in the app. Both can also be set per area in the drawer (Territory) or in bulk with **Import**.

Targets per delivery day are set on the **Balance** page itself (**Targets / day**, **Cycle start**, **+ Book cycle N**, **↻ Start new cycle**), by an admin or client. Set `balanceEpoch` in `config/territory.json` to the date you start using Balance (`YYYY-MM-DD`): past cycles with no recorded start begin there, so years of older sales don't pile into them.

Scheduled moves (an area switching delivery day on a date) are set in the drawer and applied automatically on that date.

## 6. Sales

Sales drive: the count per area on the map and in drawers, sale pins, the Balance board, the "strong week" that puts an area into a 12-week rest, and moving an area to **In Field** automatically after 5 sales in 4 weeks (once per area; a person moving it back is respected).

One row per sale, from one of three sources (set the variables on Railway; see [docs/SETUP.md](SETUP.md#9-optional-services)):

| Source | Variables |
| --- | --- |
| A Google Sheet | `SALES_SHEET_ID`, optionally `SALES_SHEET_GID` (the tab), and `GOOGLE_SHEETS_CREDENTIALS` (a Google Cloud service account's JSON key; share the sheet with the service account's email, view only) |
| A CSV at a web address | `SALES_CSV_URL` (for example a sheet "published to the web" as CSV; anyone with the link can read it) |
| A CSV file | `SALES_CSV_FILE` (good for trying it locally: `samples/sales.sample.csv`) |

Columns are found by their headers, ignoring case:

| Header contains | Used for | Needed? |
| --- | --- | --- |
| `zip`, `postcode`, `postal` or `sector` (one that also says `out` wins, e.g. "Zip Out") | Which area the sale counts for | Yes |
| `date`, `signed`, `signup` or `install` | When it was sold. **Use `YYYY-MM-DD`** (or a real date cell in Google Sheets); day-first text dates such as `05/08/2026` are read month first or skipped | Yes for Balance, rest and auto In Field |
| `latitude`/`lat` and `longitude`/`lng`/`lon` | Sale pins on the map. Pins outside `sales.pinBounds` in `config/territory.json` are ignored (catches swapped columns) | Optional |
| `badge` or `code` | Who signed it, on the pin's card | Optional |
| `cancel` | A cancelled sale shows as a red pin | Optional |
| `delivery 1` … `delivery 4` | Deliveries made, on the pin's card | Optional |

The server reads the source at start-up, whenever someone opens the app and its copy is more than an hour old, on **↻ Sync sales**, and at the times in `sales.refreshTimes` each morning (set them a few minutes after your sheet's own daily update).

## 7. Do-Not-Knock list and incidents

Do-Not-Knock addresses are stored as incidents of the type "Do-Not-Knock Issue" on each area, with a ✕ pin at the house so every team sees it.

- **A few at a time:** in the area's drawer, **Incidents** → Do-Not-Knock Issue → the address → **Log Incident**.
- **A list in the app:** **Import** → **✕ Incident / DNK address list →**.
- **A list from a file** (CSV with `address, city, state, zip, notes, scope, lat, lng`, like `samples/dnk.sample.csv`). The area column may be called `zip`, `postcode` or `sector`, and holds a US ZIP, a UK sector (`LS6 3`) or a full UK postcode (`LS6 3AB`, filed under its sector and used whole for the address lookup). `state` can be left empty (UK lists have none). Headers aren't case-sensitive.

  ```
  node scripts/import-dnk.js --dry-run my-dnk.csv   # look up the addresses and preview
  node scripts/import-dnk.js my-dnk.csv             # write
  ```

  Rows with `lat`/`lng` are placed as given; the rest are looked up (US Census geocoder for US boards, then OpenStreetMap's Nominatim, one a second). Addresses already on an area are skipped, so it's safe to run again. Only the incident list is added to; nothing else is touched. `scope` says whether it's a single address or a whole building.

A Do-Not-Knock list is residents' personal data: **keep the file out of git** (don't commit it, and leave `public/data/dnk.json` empty) and read [docs/UK.md](UK.md#data-protection) if you're in the UK.

Incidents of type weapons, threat to staff or violent crime turn the area red (Big Blocker) and move it to **Needs Permits** at once.

## 8. Worked doors from your field app

The doors your reps knock show on the map (Layers → **🚪 Worked doors**) and are skipped by new routes for 90 days. Your field app sends them to the board, server to server.

**Set up:** generate a long random token (`openssl rand -hex 32`), set it as `FIELD_APP_TOKEN` on Railway, and give the same value to your field app's server. Don't put it in anything that runs on a phone or in a browser.

**Send doors:** `POST https://<your board>/api/integrations/worked-doors` with the header `x-service-token: <token>` and a JSON body:

```json
{
  "doors": [
    {
      "id": "myapp:12345",
      "date": "2026-10-08",
      "house_number": "12",
      "street_name": "Example Road",
      "apt_number": "",
      "city": "Springfield",
      "address": "12 Example Road, Springfield",
      "outcome": "lost",
      "ba_name": "Rep name",
      "ba_email": "rep@yourcompany.co.uk",
      "office": "east",
      "sector_id": "",
      "sector_name": "",
      "ts_epoch": 1791480000,
      "lat": 42.1,
      "lng": -72.6,
      "zip": "01001"
    }
  ]
}
```

| Field | Notes |
| --- | --- |
| `id` | **Required.** Your field app's own id for this door event. Sending the same id again updates it instead of adding a duplicate, so re-sending a whole day is safe |
| `date` | **Required**, `YYYY-MM-DD`, the field day in your board's time zone |
| `lat`, `lng` | Optional but best. A door with coordinates is placed exactly where it's sent and never looked up. Without them the board looks the address up from `house_number`, `street_name` and `city` (plus the office's region), which works well for US addresses and less reliably elsewhere |
| `zip` | The door's area: a US ZIP, a UK postcode sector (`LS6 3`) or a full UK postcode (`LS6 3AB`, filed under its sector). Send it when you have it. If it's blank or missing on a door with `lat`/`lng`, the board files the door under the area whose shape contains the point (a point outside every area on your map gets none). A later re-send with a blank `zip` never clears an area already stored |
| `outcome` | `won`, `partially_won`, `lost`, `swing_by_later` or `not_knocked` (the map colours) |
| `office` | One of your office keys from `config/territory.json` |
| `ba_name`, `ba_email` | The rep, shown when a door is tapped |
| `sector_id`, `sector_name` | Optional: the patch the rep worked that day. Doors from one patch on one day that were looked up into a stray area are pulled back to the patch's majority area |
| `ts_epoch` | Optional: when the door was knocked (Unix seconds) |

Up to 5,000 doors per request. The answer says how many were received, added, updated and skipped (a door without a valid `id` or `date` is skipped). Send as often as you like; hourly suits most teams.

**"↻ Sync doors" button (optional):** set `FIELD_APP_SYNC_URL` to an address on your field app that, when the board `POST`s to it with the same `x-service-token`, pushes its latest doors to the address above and then answers `{ "days": [{ "date": "2026-10-08", "pushed": 120, "push_upserted": 15 }] }`. Without it the button reports that sync is off; doors still arrive whenever your app sends them.

**Other addresses your field app can use** (same token): `GET /api/integrations/markoffs?from=YYYY-MM-DD&to=YYYY-MM-DD` (who drew coverage marks on which days, for reminding leaders who didn't), `GET /api/integrations/users` (active admin and sector-leader accounts) and `POST /api/integrations/sector-leaders` with `{ "email", "name", "office" }` (create or update a sector leader and email their invite).

## 9. Backups and restoring

With the `CGT_S3_*` variables set, the server copies **every collection** to your bucket each night after 03:00 (your time zone), under `backups/<date>/`, and keeps 30 days. Worked doors and the geocode cache are copied whole once a week and as each night's changes in between; everything else is copied whole every night. A `manifest.json` is written last; a night without one didn't finish. A failed night retries every 20 minutes and emails `ADMIN_EMAIL` once a day.

Admins can see the nights on hand at `/api/admin/backups`.

**Protect the copies.** A backup holds everything, including the users collection (password hashes). Two settings help:

- `BACKUP_ENCRYPTION_KEY`: every data file is encrypted (AES-256-GCM) before it leaves the server. Use 64 hex characters (`openssl rand -hex 32`) or a long passphrase, and **keep a copy somewhere other than Railway** (a password manager): without it the backups can't be read. The manifest (dates, counts, sizes) stays readable. Nights written before you set it stay unencrypted.
- `BACKUP_PRUNE=off`: the app stops deleting nights older than 30 days, so you can give it a bucket token that can't delete, and let a lifecycle rule (or object lock) in the bucket expire old nights instead. Then someone who gets into the app or its key can't wipe the backups too.

To restore, use `scripts/restore-backup.js`. `railway run --` lends it your live variables (the bucket keys); it needs the Railway command line installed and linked first ([docs/SETUP.md](SETUP.md#the-railway-command-line-for-recovery-restores-and-loading-live-data)). With the `CGT_S3_*` variables in a local `.env`, plain `node` works too.

```
railway run -- node scripts/restore-backup.js list
railway run -- node scripts/restore-backup.js 2026-10-01 --out ./restore
railway run -- node scripts/restore-backup.js 2026-10-01 --target "<mongodb uri>" [--only knocks,edits] [--drop]
```

- `list` shows the nights available.
- `--out` writes that night's data as files, without touching any database: for a look, or to compare.
- An encrypted night needs the same `BACKUP_ENCRYPTION_KEY` in the restore's environment.
- `--target` loads it into a database. A collection that already has documents is refused unless you add `--drop` (which empties it first). `--only` restores just the collections you name. For the big collections, it loads the newest full copy on or before that night and then each night's changes up to it.

**Restore into a new, separate database first**, check it (point a local copy at it), and only then decide whether to restore into the live one. On Atlas's free tier, all databases on the cluster share its 512 MB, so a second full copy may not fit there; use a local MongoDB or a second free cluster.
