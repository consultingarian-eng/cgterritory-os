# CGTerritory — the territory and field-planning map for door-to-door offices

**CGTerritory** is the map Cube Group USA's sector leaders plan their field day on. It answers the questions a leader has every morning:

- **Where can we knock?** Every ZIP code (or, in the UK, postcode sector) on one live map, coloured by whether you can work it: good to pitch, permit needed, permit secured, a big blocker, or not reviewed yet.
- **What's already been covered?** The doors your reps knocked, synced from your field app, and the streets leaders have marked off by hand, so nobody walks the same street twice in a rotation.
- **Where does each pair go today?** Drop a pin where you'll park, say how many pairs and solos are out, and it hands each one a walking lap over real streets, skipping what's been worked.
- **What's next?** A pipeline of every area you've been given, from just assigned through permit research to in the field and completed, with the reasons an area can't go out yet.
- **Are we balanced?** If your client delivers on fixed days from depots, the Balance board shows sales against target for each delivery day and which day to work next.

It is open source (MIT). Clone it, open it in Claude Code, load your own territory, and you have your own copy running on your own database, domain and branding.

**See it:** a guided tour is on the showcase site: **[tech-stack.cubemarketing.us/#/cgt](https://tech-stack.cubemarketing.us/#/cgt)**.

The repository ships with a small **fictional sample territory** (real public ZIP boundaries, with made-up offices, depots, statuses, notes and figures) so every feature works the moment you start it. You replace it with your own.

## A leader's day with it

1. **Morning.** Open the map. The **TODAY** strip shows the areas scheduled for today. Tap one: its drawer shows the permit position, households, drive time from your office, sales, incidents and Do-Not-Knock warnings, and when it was last worked.
2. **Plan the team.** In the drawer's **Routes** section, set Pairs, Solos and Doors per person, drop the **P** where you'll park and tap **⚡ Generate**. Each route is a lap: out along one side of the street and back along the other, side streets taken as you pass, finishing across the road from the car. **Share** sends each rep their route.
3. **In the field.** Reps follow their line on their phone. Worked doors flow in as your field app sends them.
4. **End of day.** Mark off what was covered with **✏ Mark Off**, log anything that happened under **Incidents** (a weapons, threat or violent-crime incident turns the area red for everyone at once), and check **🚪 Worked doors** to see where everyone actually went.
5. **The week ahead.** Move areas along the **Pipeline**, set work dates on the **Schedule**, and use **Balance** to see which delivery day needs sales most.

## What's inside

**The map**
- Areas coloured by status, with search, region chips and Day and Hub filters.
- Layers: Street, Dark and Satellite maps; coverage marks; incident and Do-Not-Knock ✕ pins; permit difficulty (1 to 5); sales bubbles and sale pins; worked doors by outcome and date range.
- **Paint** and **Select** to set the status of many areas at once (on a computer).
- Works as a home-screen app on phones, and keeps opening with a weak signal.

**An area's drawer**
- Status, pipeline stage, distance and drive time from your office, sales, households and density, and the last week it was worked.
- **Coverage**: draw the streets you've knocked; marks last 12 weeks.
- **Routes**: walking laps for pairs and solos from a park pin, over OpenStreetMap streets, skipping doors worked in the last 90 days, marked-off streets and today's other plans. How it works: [docs/ROUTES.md](docs/ROUTES.md).
- **Incidents**: log what happened, with an address for a ✕ on the map. Do-Not-Knock addresses show the same way.
- **Permit**: whether a permit is needed, fees, lead time, the issuing office, allowed hours, restricted days, the rules, and who holds it. **🤖 Research with AI** drafts it from the local rules for you to check.
- **Territory**: delivery day, depot (hub), density, difficulty, a scheduled move to another delivery day, and "complete first" ordering between areas.
- **⤓ Export Map**: a printable map of the area.

**Planning**
- **Pipeline**: Incoming → Researching → Needs Permits → Permit Secured → No Permit Needed → In Field → Completed, with drag and drop, bulk moves, and hold-ups (needs cars, partial permits, permit pending, resting, awaiting date). Areas with a strong sales week in the last 12 weeks are flagged to rest.
- **Schedule**: a month calendar of work dates.
- **Balance**: per depot, sold against target for each delivery day this cycle, which day to work next, booked targets for the next cycle, and a "workable" view of where nobody has been lately.
- **+ Add Territories** (type, upload a CSV or Excel file, or **🤖 Extract with AI** from a photo or PDF) and **Import** to update many areas from a spreadsheet.

**Running it**
- Accounts with roles, invitations by email, and view-only demo accounts.
- Nightly backups of the whole database to your own storage bucket, with a restore script.
- **ⓘ page guides** on every page that explain each button in plain words (switch them off under the account menu's page helpers).

## Accounts

| Role | Who it's for | What they can do |
| --- | --- | --- |
| **Admin** | The office owner, operations | Everything, including **Manage Users** (invite, change role or office, deactivate) |
| **Client** | Whoever decides territory: your managers, or the company you sell for | Everything except managing users: statuses, pipeline, schedule, Balance targets, permit research, imports |
| **Sector Leader** | Leaders running teams in the field | The map and Balance; coverage marks, routes and incidents. They can remove only their own marks, routes and incidents, can't change statuses or run permit research, and don't see Pipeline or Schedule |
| **Demo** (a flag on any account, set with `scripts/set-demo.js`) | Showing the system to someone | Sees what their role sees; every change is refused |

Each account is tied to one office or to all of them; single-office accounts see only their office's areas on the Pipeline and Schedule. That, and the hidden views, are conveniences, not walls: every account can read the whole board through the API. The server enforces who may **change** what. See [SECURITY.md](SECURITY.md#if-you-run-a-copy-of-this-app).

## Build your own with Claude Code

1. **Get the tools:** Git, Node.js 20.19 or newer (the current LTS is best), and [Claude Code](https://code.claude.com/docs/en/setup). Step 1 of [docs/SETUP.md](docs/SETUP.md) shows how.
2. **Clone it and open it in Claude Code:**

   ```
   git clone https://github.com/consultingarian-eng/cgterritory-os.git my-territory
   cd my-territory
   claude
   ```

   Keep your own copy in a **private** repository: it will hold your territory, your Do-Not-Knock list and your settings. [docs/SETUP.md](docs/SETUP.md) step 2 shows how.

3. **In Claude Code, run these in order:**

   | Command | What it does |
   | --- | --- |
   | `/setup` | Database, backups bucket, a safe local run, Railway hosting, your domain and your first admin login, one step at a time, checking each one |
   | `/load-territory` | Your areas (US ZIP codes or UK postcode sectors) with their boundaries, your offices, depots and delivery days, your Do-Not-Knock list, and a check on the map |
   | `/brand` | Your company name, logo, colours, app icons, the words on screen (what you call your client, your field app, an area) and the map styles |

**Just want a look first?** After `npm install`, `npm run dev:mem` runs the fictional sample on a throwaway in-memory database, with no accounts or keys needed, and prints where to sign in. Walking routes work offline in sample ZIP 01108, which has a made-up street map.

You can stop at any point and run a command again; it picks up where you left off. Nothing emails anyone during setup except invitations you ask for, and nothing is loaded into a live database without you saying yes.

## What you'll need

| Service | Needed? | What it does here |
| --- | --- | --- |
| GitHub | Required | Your private copy of the code |
| MongoDB Atlas | Required | The database (you can start on the free tier) |
| Railway | Required (or another Node.js host) | Runs the app on the internet |
| Cloudflare R2 (or any S3-compatible storage) | Strongly recommended | Nightly backups, and the street maps behind routes |
| SendGrid | Strongly recommended | Invitations and password resets |
| A domain | Recommended | `territory.yourcompany.co.uk` instead of a Railway address |
| Anthropic API key | Optional | AI permit research and reading territory lists from photos and PDFs |
| Google Cloud service account | Optional | Reads your sales sheet: sales on the map, sale pins, the Balance board |
| Your field app | Optional | Sends the doors your reps worked |

Everything optional stays off until you add its settings. What each one powers and what breaks without it: [docs/SERVICES.md](docs/SERVICES.md).

## The guides

| Guide | Read it for |
| --- | --- |
| [docs/SETUP.md](docs/SETUP.md) | The full manual: database, hosting, bucket, domain, first admin, every setting, updates, troubleshooting |
| [docs/DATA.md](docs/DATA.md) | Loading your territory: boundaries, your area list and statuses, offices, depots and delivery days, sales, Do-Not-Knock, worked doors, backups |
| [docs/ROUTES.md](docs/ROUTES.md) | How walking routes are made, what they skip and for how long, and OpenStreetMap fair use |
| [docs/UK.md](docs/UK.md) | Running it in the UK: postcode sectors, units, time zone, street-trading and collection rules, data protection |
| [docs/SERVICES.md](docs/SERVICES.md) | Every outside service, what it powers and what happens without it |
| [docs/BRANDING.md](docs/BRANDING.md) | Your name, logo, colours, icons, home-screen app and map styles |

## How it's built

```
 Leaders and managers: phone / browser (home-screen app)
                    │
   ┌────────────────▼───────────────────────────────────────┐
   │  One Railway service (Node.js, Express: server.js)     │
   │   ├─ the web app: plain HTML/CSS/JS + Leaflet (public/) │
   │   ├─ the API: areas, coverage, doors, routes, users     │
   │   ├─ in-memory copies of the big collections            │
   │   └─ background jobs: geocoding, sales refresh,         │
   │      day changes, nightly backup                        │
   └──────┬──────────┬──────────┬──────────┬────────────────┘
          │          │          │          │
   MongoDB Atlas  R2 / S3   OpenStreetMap  Optional: Anthropic, SendGrid,
                 (backups,  (Overpass,     Google Sheets, your field app
                  street     geocoding,
                  maps)      map tiles)
```

- `server.js`: the Express server: sign-in and users, area edits, coverage, worked doors and geocoding, sales, Balance targets, AI research, backups.
- `lib/`: walking routes (`routegen.js`, `routes_api.js`, `osm.js`, `geo.js`), US parcel data (`parcels.js`, `parcels/`), storage (`blobstore.js`), backups (`backup.js`), your settings (`settings.js`).
- `config/territory.json`: your offices, depots, regions, time zone, labels and brand. No secrets.
- `public/`: the web app (`index.html`, `js/app.js`, `css/style.css`), the sign-in pages, the service worker (`sw.js`), and your territory data in `public/data/`.
- `scripts/`: loaders and maintenance (Do-Not-Knock import, depot import, restore a backup).
- `docs/`: the guides above. `.claude/skills/`: the Claude Code commands.

There's no build step: what's in `public/` is what the browser gets. Run **one** copy of the server per database.

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md). The repository contains no keys or passwords. Yours belong in your host's variables and a local `.env` that git ignores. `npm test` runs the security test suite against a throwaway in-memory database, with no network.

## Credits and licence

Built and run in the field by **Cube Group USA**. Released under the [MIT licence](LICENSE), Copyright (c) 2026 Cube Group USA.

Street data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL). US ZIP boundaries: US Census Bureau ZCTAs. UK boundaries, where you load them: see [docs/UK.md](docs/UK.md) for the sources and their licence terms. Map library: [Leaflet](https://leafletjs.com).

Permit research is a starting point, not legal advice: check the rules with the local authority before your team goes out.
