# Making it yours

In Claude Code, `/brand` does all of this with you. Most of it is one settings file; the rest is a logo, a set of icons and a handful of colours.

## Company settings

`config/territory.json` holds everything about **your** business. It contains no secrets, it's committed with your copy, and the server reads it once at start-up (restart locally, or deploy, after a change). Every key and its default is in `lib/settings.js`; anything you leave out falls back to the default. Keys starting with `_` (like `_comment`) are notes and are ignored.

| Key | What it sets |
| --- | --- |
| `brand.appName` | The app's name: page titles, sign-in page, emails, the home-screen app's name |
| `brand.tagline`, `brand.description` | The line under the name, and the home-screen app's description |
| `brand.orgName`, `brand.orgUrl` | Your company and its website, shown on the sign-in page and in email footers (leave `orgUrl` empty to drop the link) |
| `brand.logo`, `brand.logoPng` | Paths to your logo (see below) |
| `brand.themeColor` | The colour of the phone's status bar and the home-screen app's splash |
| `timezone` | The time zone every "today" follows (`America/New_York`, `Europe/London` …). The `APP_TIMEZONE` variable, if set, wins. A name that isn't a real time zone stops the server at start-up |
| `countryCodes` | Which countries addresses are looked up in (`["us"]`, `["gb"]`) |
| `areaLabel` | What an area is called on screen: `ZIP` or `Sector` |
| `areaIdPattern` | The area ids the app accepts (US ZIPs and UK sectors by default) |
| `regions` | One entry per boundary file ([docs/DATA.md](DATA.md#1-your-settings-first)) |
| `offices` | Your offices: `key`, `label`, map `color`, default `regions`, `address`, `lat`, `lng` |
| `hubs` | Depots the client delivers from: `key`, `label`, `short` (3 letters), `aliases` |
| `client.name`, `client.salesLabel` | What you call the company you sell for, and its sales |
| `fieldApp.name` | What you call your field app, in messages and guides |
| `sales.refreshTimes`, `sales.pinBounds` | When sales are re-read each morning; the box sale pins must fall inside |
| `research.region`, `research.notes` | Where AI permit research looks, and extra instructions for it |
| `balanceEpoch` | The date you start using the Balance board |
| `routePlanning` | Your own field-time numbers for route estimates ([docs/ROUTES.md](ROUTES.md#how-long-a-lap-may-take)) |

Choose office and hub `key`s once: they're stored on users, areas and targets. Change a label any time; changing a key means updating those records too (ask Claude Code).

## Logo

Two files in `public/`:

- `public/logo.svg`: shown in the app's top bar and on the sign-in page. SVG keeps it sharp; a square or nearly square mark works best (it's shown small, about 52 px high at most).
- `public/logo.png`: used in emails (email programs don't show SVG). About 128 × 128 px, transparent background. It's loaded from `APP_URL`, so emails only show it once the app is live at that address.

Replace the files, or put yours elsewhere under `public/` and point `brand.logo` and `brand.logoPng` at them (`/brand/acme.svg`). Your logo is shown before sign-in, so don't use anything you wouldn't put on a public page.

## Icons and the home-screen app

The app installs on phones from the browser ("Add to Home Screen"). Its icons, all PNG in `public/`:

| File | Size | Used for |
| --- | --- | --- |
| `favicon.png`, `favicon-32.png`, `favicon-16.png` | 32/32/16 px | Browser tab |
| `apple-touch-icon.png` | 180 × 180 | iPhone and iPad home screen |
| `icon-192.png`, `icon-512.png` | 192, 512 | Android home screen and install prompt |
| `icon-maskable-512.png` | 512 × 512 | Android adaptive icon: keep the logo inside the central 80% circle, with a solid background to the edges |

Make them from one square master image (Claude Code can resize it for you). The home-screen app's name, description and colours come from `brand` in your settings; the icon list is in `public/manifest.webmanifest`.

**After changing any icon or logo**, in the same commit: bump `CACHE` in `public/sw.js` (always), and raise the `?v=` number wherever a page has one on these files: the favicon, `favicon-32`/`favicon-16`, apple-touch-icon and logo (`{{LOGO}}?v=…`) links in `public/index.html`, `public/login.html` and `public/set-password.html`, and the favicon in `public/export-map.html`. Use the same new number everywhere (search the HTML for `?v=` followed by the current number). The home-screen icons listed in the manifest (`icon-192`, `icon-512`, the maskable one) have no `?v=`; the `CACHE` bump refreshes them. Without these, phones keep the old images. An installed home-screen icon on a phone may only change after the app is removed and added again.

## Colours

| What | Where |
| --- | --- |
| The app's colours (background, panels, text, accent, the gradient on buttons) | The variables at the top of `public/css/style.css` (`--bg`, `--panel`, `--ink`, `--muted`, `--accent`, `--grad` …) |
| The sign-in and set-password pages | Their own `:root` variables at the top of `public/login.html` and `public/set-password.html` (they don't load `style.css`); keep them in step |
| Emails | Inline colours in `emailLayout()` and the invite and reset emails in `server.js` |
| Phone status bar and splash | `brand.themeColor` in your settings |
| Offices on the map and on cards | Each office's `color` in your settings |
| Area statuses (green, yellow, red, grey, teal) | `COLOR_DEFAULTS` at the top of `public/js/app.js`. Each person can also change these for themselves with **Colors** in the top bar (saved in their own browser only) |
| Pipeline columns, hold-ups, incident types | `PIPELINE_STAGES`, `CONSTRAINTS`, `INCIDENT_TYPES` near the top of `public/js/app.js` |

The app is designed dark. If you lighten it, check the map overlays and the ZIP colours still read well on the Street and Satellite maps, and that text stays readable on phones in daylight.

**Fonts** load from Google Fonts: the `<link>` in each HTML page, and `--display`, `--body` and `--mono` in `style.css`.

After changing `style.css`, bump its `?v=` in `public/index.html` and `CACHE` in `public/sw.js`.

## Words on screen

- **Status names** ("Good to Pitch", "Permit Needed" …): `STATUS_LABELS` near the top of `public/js/app.js`.
- **Pipeline stage names**: `PIPELINE_STAGES` in the same place.
- **Your client, your field app, what an area is called**: `client`, `fieldApp` and `areaLabel` in your settings.
- **The ⓘ page guides**: `GUIDES` near the bottom of `public/js/app.js`. They quote button labels exactly (**⚡ Generate**, **✏ Mark Off** …), so whenever you rename a button or change what a page does, update the guide text in the same change. Claude Code does this as a rule.

After editing `app.js`, bump its `?v=` in `public/index.html` and `CACHE` in `public/sw.js`.

## The service worker's cache name

`public/sw.js` keeps two caches on each phone: `CACHE` (the app's files, for example `myapp-v12`) and `DATA_CACHE` (the map shapes and Leaflet, for example `myapp-data-v2`). You can rename the prefix to your app's name; what matters is that **`CACHE` changes on every front-end deploy** (the number going up is the convention). Change `DATA_CACHE` only if you need every phone to drop its stored map shapes, which `DATA_V` normally handles.

## Map styles

The base maps are listed in `BASE_LAYERS` near the top of `public/js/app.js`:

| Style | Source |
| --- | --- |
| **Street** | OpenStreetMap's standard tiles |
| **Dark** | Esri's dark grey canvas |
| **Satellite** | Esri World Imagery, with Esri road and place labels on top |

Each entry is a tile address and its attribution. To use another provider (MapTiler, Stadia Maps, Mapbox, Ordnance Survey's OS Maps API in the UK …), replace the `url` and the `attribution` with theirs, following their terms. Most need an API key in the tile address: that key is visible to anyone who opens the app, so use a key restricted to your domain in the provider's dashboard, and never one that can spend money or change your account.

Keep the attribution: OpenStreetMap's data licence and most providers' terms require it on the map.

The colours of the areas on the map come from the status colours above; how solid they are is the **Fill** slider in Layers, saved per person.
