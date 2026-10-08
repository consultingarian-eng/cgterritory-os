# Setting up your own CGTerritory

This is the full manual. In Claude Code, `/setup` walks you through the same steps one at a time and checks each one; this page is what it follows, and what to read if you'd rather do it yourself.

You'll end up with: your own private copy of the code on GitHub, a MongoDB database, a storage bucket for backups, the app running on Railway at your own address, and your first admin login.

| Step | What | Time |
| --- | --- | --- |
| 1 | [Tools](#1-tools) | 15 min |
| 2 | [Your own private copy](#2-your-own-private-copy) | 5 min |
| 3 | [Database (MongoDB Atlas)](#3-database-mongodb-atlas) | 15 min |
| 4 | [Run it on your computer](#4-run-it-on-your-computer) | 15 min |
| 5 | [Backups bucket (Cloudflare R2)](#5-backups-bucket-cloudflare-r2) | 10 min |
| 6 | [Hosting (Railway)](#6-hosting-railway) | 15 min |
| 7 | [Your first admin](#7-your-first-admin) | 5 min |
| 8 | [Your domain](#8-your-domain) | 10 min, plus waiting |
| 9 | [Email, AI, sales and your field app](#9-optional-services) | as needed |

Then load your territory (`/load-territory`, [docs/DATA.md](DATA.md)) and brand it (`/brand`, [docs/BRANDING.md](BRANDING.md)).

## 1. Tools

| Tool | Mac | Windows |
| --- | --- | --- |
| **Git** | Open Terminal and type `git --version`; if it isn't installed, macOS offers to install it | Install from [git-scm.com](https://git-scm.com/download/win) with the default options |
| **Node.js** 20.19 or newer (the current LTS is best) | Installer from [nodejs.org](https://nodejs.org) | Installer from [nodejs.org](https://nodejs.org) |
| **Claude Code** | [code.claude.com/docs/en/setup](https://code.claude.com/docs/en/setup) | Same |

Check: `git --version`, `node --version` (18 or higher) and `claude --version` all answer. Tell Git who you are once: `git config --global user.name "Your Name"` and `git config --global user.email you@yourcompany.co.uk`.

## 2. Your own private copy

Your copy will hold your territory, Do-Not-Knock list and settings, so it must be **private**. (A GitHub fork of a public repository can't be made private, so don't fork; copy it like this.)

1. On GitHub, create a **new private repository**, empty (no README, no licence). Say it's `yourname/my-territory`.
2. In a terminal:

   ```
   git clone https://github.com/consultingarian-eng/cgterritory-os.git my-territory
   cd my-territory
   git remote rename origin upstream
   git remote add origin https://github.com/yourname/my-territory.git
   git push -u origin main
   ```

`origin` is now your private copy (Railway deploys from it); `upstream` is this public repository, where updates come from ([Updating](#updating)). Never push to `upstream`.

## 3. Database (MongoDB Atlas)

1. Sign up at [mongodb.com/atlas](https://www.mongodb.com/atlas) and create a **free (M0) cluster**. Pick a region near your users: **London** for the UK, an eastern US region for the US East Coast.
2. **Database Access → Add New Database User**: password authentication, a long password made of **letters and numbers only** (symbols need escaping in the connection string and are the commonest cause of `bad auth`). Role: *Read and write to any database*. Save the password in your password manager.
3. **Network Access → Add IP Address → Allow access from anywhere** (`0.0.0.0/0`). Railway's outgoing addresses change, so a fixed list won't work; the strong password is the protection.
4. **Connect → Drivers** gives a string like `mongodb+srv://<user>:<password>@<cluster>.mongodb.net/?retryWrites=true&w=majority`. Put your password in, and **add a database name after the `/`**:
   - live: `mongodb+srv://<user>:<password>@<cluster>.mongodb.net/cgterritory?retryWrites=true&w=majority`
   - your computer: the same with `/cgterritory_dev` instead, so local experiments never touch live data.

   Without a name the data lands in a database called `test`.

The free tier keeps **no backups**; step 5 fixes that. Collections are created by the app as it needs them.

## 4. Run it on your computer

Running locally first shows you the app with the fictional sample territory, and proves your database works.

**Just looking, no database account yet?** After `npm install`, run `npm run dev:mem`. It starts a throwaway database in memory, loads the sample into it and starts the server. It prints the address and a sign-in (with no `.env`, the admin is `admin@example.com` with a password made up for that run). Everything is gone when you press Ctrl+C. The first run downloads a MongoDB program of about 100 MB; later runs reuse it. For anything you want to keep, use the steps below with Atlas (step 3) or a MongoDB installed on your computer ([MongoDB Community Server](https://www.mongodb.com/docs/manual/administration/install-community/), connection string `mongodb://localhost:27017/cgterritory_dev`).

1. Install the packages: `npm install`
2. Make your settings file: `cp .env.example .env` (Windows PowerShell: `Copy-Item .env.example .env`). Make sure it's called `.env`, not `.env.txt`.
3. Fill in, in `.env`:

   | Variable | Value |
   | --- | --- |
   | `MONGODB_URI` | your **`_dev`** connection string |
   | `JWT_SECRET` | a random string of at least 32 characters: run `openssl rand -hex 32` (or `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) and paste the result |
   | `APP_URL` | `http://localhost:3000` |
   | `ADMIN_EMAIL`, `ADMIN_NAME` | you |
   | `INITIAL_ADMIN_PASSWORD` | a password for your first local sign-in |
   | `NODE_ENV` | `development` (already set in the example) |
   | `SALES_CSV_FILE` | `samples/sales.sample.csv`, to see sales and the Balance board with sample figures |

   Leave the `CGT_S3_*`, `SENDGRID_API_KEY` and `FIELD_APP_*` variables empty locally.
4. Fill the sample working state (pipeline stages, depots, delivery days, targets) into your empty dev database: `npm run seed:sample` (the same as `node scripts/seed-sample.js`). It refuses to run against a database that already has area data. It also stores a made-up street map for sample ZIP **01108**, so **Routes → Generate** works without reaching OpenStreetMap: put the park pin near the centre it prints (42.08124, -72.5625). The made-up streets don't line up with the real map underneath.
5. Start it: `npm start`. Open [http://localhost:3000/healthz](http://localhost:3000/healthz): it says `warming` for a few seconds, then `ok`.
6. Open [http://localhost:3000](http://localhost:3000) and sign in with `ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD`. You should see the sample ZIPs around Springfield, Massachusetts, coloured by status.

Stop the server with Ctrl+C. The live app never reads your `.env`; it's for your computer only, and git ignores it.

## 5. Backups bucket (Cloudflare R2)

The bucket holds the **nightly backup** of your whole database (kept 30 days) and the **street maps** behind walking routes. Without it there are no backups. Any S3-compatible storage works; these steps are for R2.

1. Sign up at [cloudflare.com](https://dash.cloudflare.com/sign-up) and open **R2 Object Storage** (it asks for a payment method; small use falls within the free allowance; check the current [R2 pricing](https://developers.cloudflare.com/r2/pricing/)).
2. **Create bucket**, e.g. `my-territory`. Keep it **private** (no public access). For the UK, choose the **EU jurisdiction** if offered.
3. **Manage R2 API Tokens → Create API token**: permission **Object Read & Write**, applied to **that bucket only**. Copy the **Access Key ID**, the **Secret Access Key** (shown once) and the **S3 endpoint** (`https://<account id>.r2.cloudflarestorage.com`) into your password manager.
4. These become `CGT_S3_ENDPOINT`, `CGT_S3_BUCKET`, `CGT_S3_ACCESS_KEY_ID`, `CGT_S3_SECRET_ACCESS_KEY` on Railway (step 6). `CGT_S3_REGION` can be left out for R2.

Put them on Railway only, not in your local `.env`, so a local run never writes to your live backups.

## 6. Hosting (Railway)

1. Sign up at [railway.com](https://railway.com) with your GitHub account.
2. **New Project → Deploy from GitHub repo** → your **private** `my-territory`. Railway reads `railway.json`: it runs `npm start` and waits for `/healthz` to say `ok` before sending traffic to a new version.
3. Before the first deploy finishes, open the service's **Variables** and add (the **Raw Editor** takes `NAME=value` lines):

   | Variable | Value |
   | --- | --- |
   | `MONGODB_URI` | your **live** connection string (`/cgterritory`, not `_dev`) |
   | `JWT_SECRET` | a **new** random string, not the one on your computer |
   | `ADMIN_EMAIL`, `ADMIN_NAME` | you |
   | `INITIAL_ADMIN_PASSWORD` | a strong password, used once (step 7) |
   | `CGT_S3_ENDPOINT`, `CGT_S3_BUCKET`, `CGT_S3_ACCESS_KEY_ID`, `CGT_S3_SECRET_ACCESS_KEY` | from step 5 |
   | `APP_URL` | set after the next step |

   Don't add `PORT` or `NODE_ENV` (Railway sets `PORT`; leaving `NODE_ENV` out keeps the sign-in cookie secure-only). Don't add variables with empty values. Railway **stages** variable changes: click **Deploy** on the banner to apply them.
4. **Settings → Networking → Generate Domain** gives you an address like `my-territory-production.up.railway.app`. Set `APP_URL` to it (with `https://`, no trailing slash) and deploy.
5. In **Settings**, pick the **region** nearest your users (EU West for the UK) and keep **one replica** (Railway's word for a running copy of the app). The app keeps its working copies of the data in memory and runs its background jobs in one process; two copies would miss each other's changes.
6. Check: `https://<your address>/healthz` says `ok`, and `https://<your address>/login` shows the sign-in page with your app's name.

From now on, **every push to `main` on your private copy deploys** automatically.

### The Railway command line (for recovery, restores and loading live data)

A few jobs run a script against the **live** database from your computer: printing a reset link when you're locked out ([step 7](#7-your-first-admin)), restoring a backup ([docs/DATA.md](DATA.md#9-backups-and-restoring)), and loading your territory, depots or Do-Not-Knock list into the live app. `railway run -- <command>` runs the command on your computer with your Railway service's variables (including the live `MONGODB_URI`), so the secret never has to be pasted anywhere. Set it up once, before you need it:

1. Install it. Mac: `brew install railway`. Windows (PowerShell) or Mac without Homebrew: `npm install -g @railway/cli`. Check: `railway --version`.
2. `railway login` (opens the browser to sign in).
3. In your copy's folder, `railway link`, then pick your project, the **production** environment and the app's service.

Check: `railway status` names the project and service, and `railway run -- node -e "console.log(!!process.env.MONGODB_URI)"` prints `true`. `railway logs` shows the live server's log and `railway variables` lists the variables (it prints their values, so don't share the output).

Without the command line, put the live connection string (from your password manager) in the terminal for that one command, and close the terminal afterwards:

- Mac/Linux: `MONGODB_URI="mongodb+srv://…/cgterritory?…" node scripts/admin-reset-link.js you@yourcompany.co.uk`
- Windows PowerShell: `$env:MONGODB_URI="mongodb+srv://…/cgterritory?…"; node scripts/admin-reset-link.js you@yourcompany.co.uk`

Don't write the live connection string into `.env`: local runs would then use live data.

## 7. Your first admin

At start-up, if there are **no accounts at all** and both `ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` are set, the server creates an **Admin** account with that email, name and password. Once any account exists the variable is ignored (the log says so), so a leaked or forgotten password can never bring an admin back. So:

1. Sign in at `/login` with `ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD`.
2. Change the password straight away. **Update Password** is in the account panel of the phone layout: open the app on your phone (or make the browser window narrow) and tap the account button at the top right. Passwords are at least 8 characters. Once email works, **Forgot password** on the sign-in page does the same from any device.
3. **Delete `INITIAL_ADMIN_PASSWORD`** from Railway's variables and deploy. It's never needed again.

Adding everyone else: your name at the top right (on a phone, the account button) → **Manage Users** → **+ Add User** → their name, email, role and office → **Send Invite**. They get an emailed invite to set their own password (valid 7 days), so **email must be set up first** (step 9). Roles are explained in the [README](../README.md#accounts).

**Demo accounts** (see everything, change nothing) have no switch in the app. Add the user as normal, then run `railway run -- node scripts/set-demo.js them@example.com on` (`off` undoes it). Or, in Atlas: your cluster → **Browse Collections** → your database (`cgterritory`) → **users** → find their document (filter `{ "email": "them@example.com" }`) → the pencil icon → change `demo` from `false` to `true` → **Update**. It takes effect within a minute. Give a demo account the **Client** or **Sector Leader** role, not Admin: an admin demo can still read **Manage Users** (everyone's name and email).

**Locked out?** "Forgot password" on the sign-in page emails a reset link (needs email). Without email, print a one-hour reset link straight from the database (this needs the [Railway command line](#the-railway-command-line-for-recovery-restores-and-loading-live-data), or the connection-string fallback described there):

```bash
railway run -- node scripts/admin-reset-link.js you@yourcompany.co.uk
```

Open the link it prints yourself (it's a secret: don't paste it anywhere) and set a new password. Your account, coverage marks and plans stay as they are. Setting a new password signs that account out everywhere else.

**Sessions:** a sign-in lasts 30 days on that device. **Sign out** ends that session on the server and wipes the app's offline copy from the device (worth doing on a shared phone). Changing or resetting a password, or an admin deactivating an account, ends all of that account's sessions at once. Eight wrong passwords for one email within 15 minutes lock that email out until the 15 minutes are up.

## 8. Your domain

Use a subdomain such as `territory.yourcompany.co.uk`.

1. Railway: **Settings → Networking → Custom Domain**, enter it. Railway shows a **CNAME** record (and sometimes a TXT record to prove ownership).
2. At your domain provider's DNS settings, add exactly those records.
3. Wait for Railway to show the domain as active with a certificate (minutes, occasionally up to an hour).
4. Change `APP_URL` to `https://territory.yourcompany.co.uk` and deploy. Invite and reset links use it.

Check: `https://territory.yourcompany.co.uk/healthz` says `ok` with a padlock.

## 9. Optional services

Add each one's variables on Railway, deploy, and check it. What each does and what it costs: [docs/SERVICES.md](SERVICES.md).

| Service | Variables | Check |
| --- | --- | --- |
| **Email** (SendGrid): invites, resets, backup alerts | `SENDGRID_API_KEY` (a key with **Mail Send** only), `MAIL_FROM` (a sender you've verified in SendGrid, ideally with domain authentication), `MAIL_FROM_NAME` | Sign out, "Forgot password" with your own email: the link arrives |
| **AI** (Anthropic): permit research, reading territory lists | `ANTHROPIC_API_KEY`; optionally `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`), `AI_DAILY_LIMIT` (default 200 calls a day for the whole board) and `BRAVE_SEARCH_API_KEY`. Set a monthly spend limit in the Anthropic Console first | Open an area's drawer → Permit → **🤖 Research with AI**; check the result before relying on it |
| **Sales** | One of: `SALES_SHEET_ID` + `SALES_SHEET_GID` + `GOOGLE_SHEETS_CREDENTIALS`; `SALES_CSV_URL`; `SALES_CSV_FILE` ([docs/DATA.md](DATA.md#6-sales)) | **↻ Sync sales** in the top bar; sales appear in drawers and on Balance |
| **Field app** (worked doors) | `FIELD_APP_TOKEN`; optionally `FIELD_APP_SYNC_URL` ([docs/DATA.md](DATA.md#8-worked-doors-from-your-field-app)) | Your field app pushes a test door; Layers → **🚪 Worked doors** → Today |
| **Geocoder contact** | `GEOCODER_CONTACT` (defaults to `ADMIN_EMAIL`) | — |
| **Routes** | `OVERPASS_URL`, `ROUTE_LAP_MAX_MIN` ([docs/ROUTES.md](ROUTES.md)) | Generate routes in an area |

Backups: the first one runs after 03:00 (your time zone) on the night after the bucket is set up. Signed in as an admin, open `/api/admin/backups` to see the nights on hand and the last error, if any.

## Every setting

Secrets and services go in environment variables (Railway → Variables; a local `.env`). Every one is listed, with notes, in [`.env.example`](../.env.example):

| Variable | Required? | Secret? | What it's for |
| --- | --- | --- | --- |
| `MONGODB_URI` | Yes | Yes | The database |
| `JWT_SECRET` | Yes (32+ characters, or the server won't start) | Yes | Signs sessions |
| `APP_URL` | Yes when live | No | Links in emails |
| `ADMIN_EMAIL`, `ADMIN_NAME` | For the first admin | No | First admin; backup-failure alerts |
| `INITIAL_ADMIN_PASSWORD` | Once | Yes | First admin's password; remove afterwards |
| `PORT`, `NODE_ENV` | Local only | No | Port; `development` allows the cookie over http |
| `CGT_SETTINGS_FILE` | No | No | Use another settings file |
| `APP_TIMEZONE` | No | No | The board's time zone (`America/New_York` by default, `Europe/London` in the UK); wins over `timezone` in `config/territory.json` |
| `TRUST_PROXY` | No | No | Leave unset: `X-Forwarded-For` is then believed only when the connection comes from a private or loopback address (a host's proxy, e.g. Railway), so a browser connecting directly can't fake its address. `0` never trusts it; a number trusts that many proxy hops (use `1` if your proxy reaches the app from a public address). The sign-in throttle needs the real client address |
| `CGT_S3_ENDPOINT`, `CGT_S3_BUCKET`, `CGT_S3_ACCESS_KEY_ID`, `CGT_S3_SECRET_ACCESS_KEY`, `CGT_S3_REGION` | Strongly recommended | Keys yes | Backups and street maps |
| `BACKUP_ENCRYPTION_KEY`, `BACKUP_PRUNE` | Recommended | Key yes | Encrypt each night's backup; `BACKUP_PRUNE=off` leaves old nights to the bucket's own lifecycle rule ([docs/DATA.md](DATA.md#9-backups-and-restoring)) |
| `SENDGRID_API_KEY`, `MAIL_FROM`, `MAIL_FROM_NAME` | Strongly recommended | Key yes | Email |
| `GEOCODER_CONTACT` | No | No | Contact sent to OpenStreetMap services |
| `ANTHROPIC_API_KEY`, `BRAVE_SEARCH_API_KEY` | No | Yes | AI features |
| `ANTHROPIC_MODEL`, `AI_DAILY_LIMIT` | No | No | The one model every AI call uses (default `claude-sonnet-5-5`); the board's daily ceiling on AI calls (default 200, `0` turns AI off) |
| `SALES_SHEET_ID`, `SALES_SHEET_GID`, `GOOGLE_SHEETS_CREDENTIALS`, `SALES_CSV_URL`, `SALES_CSV_FILE` | No | Credentials and CSV link yes | Sales |
| `FIELD_APP_TOKEN`, `FIELD_APP_SYNC_URL` | No | Token yes | Field-app doors |
| `OVERPASS_URL`, `ROUTE_LAP_MAX_MIN`, `ROUTE_COLD_JOBS`, `UNIT_CAP`, `UNIT_POLICY_CONDOS`, `UNIT_POLICY_APT_SKIP_MIN`, `UNIT_POLICY_SUPPRESS` | No | No | Route tuning (`ROUTE_COLD_JOBS`: how many areas may fetch their street maps at once, default 2) |

Your business settings (offices, depots, regions, time zone, what things are called, brand) live in **`config/territory.json`**, which holds no secrets and is committed with your copy. The server reads it once at start-up, so restart (locally) or deploy (live) after changing it. Every key and its default is in `lib/settings.js`; [docs/BRANDING.md](BRANDING.md#company-settings) explains them.

## Deploying changes: the bump rule

Phones keep the app's files in their own cache (it's what lets the map open on a weak signal). So that they pick up a change, **in the same commit**:

| You changed | Bump |
| --- | --- |
| `public/js/app.js` | its `?v=` number in `public/index.html` (`/js/app.js?v=…`) **and** `CACHE` in `public/sw.js` |
| `public/css/style.css` | its `?v=` number in `public/index.html` (`/css/style.css?v=…`) **and** `CACHE` in `public/sw.js` |
| Anything in `public/data/` (boundaries, `master.json`) | `DATA_V` near the top of `public/js/app.js`, **plus** the `app.js` and `CACHE` bumps above (because `app.js` changed) |
| Logo or icons | `CACHE` in `public/sw.js`, plus the `?v=` on the favicon, apple-touch-icon and logo links wherever a page has one ([docs/BRANDING.md](BRANDING.md#icons-and-the-home-screen-app)) |

Forget it, and phones show the old version until the cache gives way. Claude Code follows this rule (it's in `CLAUDE.md`).

## Updating

New features and fixes arrive in the public repository. To bring them into your copy:

```
git fetch upstream
git merge upstream/main
```

Your own files are the ones most likely to conflict: `config/territory.json`, `public/data/`, your logo and icons. Keep **your** version of those. Then run it locally (step 4), and push to `origin` to deploy. Claude Code can do the merge with you: ask it to "update from upstream".

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Server stops at start with "JWT_SECRET must be set" | `JWT_SECRET` missing or shorter than 32 characters |
| `/healthz` stays on `warming` | The database can't be reached or is slow. Check `MONGODB_URI` (password, database name), Atlas Network Access (`0.0.0.0/0`), and the logs for "MongoDB error". On a busy free-tier cluster the first load after a deploy can take a while; Railway waits up to 10 minutes |
| `bad auth` in the logs | Wrong password in `MONGODB_URI`, or symbols in it. Make a new database user with a letters-and-numbers password |
| Signed in locally, but sent straight back to the sign-in page | `NODE_ENV=development` missing from `.env` (the cookie is secure-only otherwise), or `APP_URL` doesn't match the address you opened. Restart after changing `.env` |
| A user shows in **Manage Users** but never got the invite | Email isn't set up, or `MAIL_FROM` isn't a verified sender. The logs say "skipping email". Fix email, then press **Resend** next to them in Manage Users |
| Phones show an old version after a deploy | The [bump rule](#deploying-changes-the-bump-rule) was missed. Bump and redeploy; a phone may need the app closed and reopened |
| An area is in the list but not on the map, or clicking it does nothing | Its boundary is missing from the region file, or its region isn't in `config/territory.json` `regions`. `npm run check` lists exactly which. Re-run the territory import ([docs/DATA.md](DATA.md)) and bump `DATA_V` |
| Routes say "No boundary on file" | Same: the area's polygon isn't in a region file the server loaded. Deploy after adding it |
| Route generation sits on "Mapping streets…" or fails | The public Overpass servers are busy. Try again later, or set `OVERPASS_URL` ([docs/ROUTES.md](ROUTES.md#7-openstreetmap-and-overpass-fair-use)). To try routes without them, use sample ZIP 01108 after `npm run seed:sample` (it has a made-up street map) |
| `railway: command not found`, or "No linked project" | Install and link the Railway command line ([step 6](#the-railway-command-line-for-recovery-restores-and-loading-live-data)) |
| "Only N free doors left in this ZIP" | Almost everything has been worked in the last 90 days. Pick another area, or remove old coverage marks if they were drawn by mistake |
| Sales show an error, or nothing | Check the sales variables; for a Google Sheet, share the sheet with the service account's email (view access). The sheet needs a ZIP/postcode column and a date column ([docs/DATA.md](DATA.md#6-sales)) |
| **↻ Sync doors** says it's disabled | `FIELD_APP_SYNC_URL` and `FIELD_APP_TOKEN` aren't both set, or the URL isn't `https://` (plain `http://` only works for `localhost`). Doors still arrive whenever your field app pushes them |
| No backups listed at `/api/admin/backups` | `enabled: false` means the `CGT_S3_*` variables are missing. Otherwise wait until after 03:00; `status.lastError` shows why a run failed |
| An `/api/…` address returns the sign-in page or 401 | You're not signed in (or your session expired). Every API address needs a session except `/healthz`, the sign-in pages and the field-app addresses |
