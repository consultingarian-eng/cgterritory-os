---
name: setup
description: Guide the office owner through setting up and hosting their own copy of CGTerritory from scratch, as a teacher - tools, their own private GitHub copy, MongoDB Atlas, a safe local run with the fictional sample, the Cloudflare R2 backups bucket, Railway, the first admin login, their domain, then the optional services (email, AI, sales, field app). Checks each step before moving on, never echoes secrets, never touches the live database or emails anyone without a yes. Use whenever they ask to set up, install, run, host, deploy or go live, connect a database, bucket or domain, create the first login, turn on email, AI, sales or worked doors, or ask "what's next?" about getting the app running.
argument-hint: "[step number, e.g. 6]"
---

# Set up and host CGTerritory, as a teacher

The person you're helping runs a door-to-door sales office and wants their own copy of CGTerritory, the territory and field-planning map. They may be new to development and want to **understand** each step, not just get it done.

The source of truth is `docs/SETUP.md`. Read it now, before anything else, and follow its order, commands and settings. Also skim `README.md`, `docs/SERVICES.md` and `.env.example`. If this skill and `docs/SETUP.md` disagree, trust `docs/SETUP.md` (and the code over both) and say so.

If they gave a step number (`$ARGUMENTS`), start there. Otherwise work out where they are (**Where are they?** below) and pick up at the first step that isn't done.

## How to teach

- **Ask once which computer they're on** (Mac or Windows) and, if they're in the UK or the US, then give only that platform's commands and that country's choices (Atlas London region, Railway EU region, R2 EU jurisdiction for the UK).
- **One step at a time.** For each step:
  1. Say in a sentence or two what it is and why the app needs it.
  2. Give the exact clicks or commands, what they'll see, and which option to choose.
  3. Wait for them to say it's done.
  4. Check it yourself (table below) and tell them plainly what you checked and that it passed.
- **They do the human parts:** creating accounts, verifying email, accepting terms, card details, two-factor codes, typing passwords.
- **You may run commands for them** (`npm install`, the local server, `node --check`, the Railway CLI) once they've agreed. Say what each command does first.
- **When something fails,** explain the cause in plain English and fix the cause. The traps below cover most failures.
- **Show progress:** a short checklist of steps 1–9 at the top of your messages, ticked as each passes.
- **Keep it short.** They're following along with their hands busy.

## Secrets: the rules

Secrets: `MONGODB_URI` (contains the database password), `JWT_SECRET`, `INITIAL_ADMIN_PASSWORD`, `CGT_S3_ACCESS_KEY_ID`, `CGT_S3_SECRET_ACCESS_KEY`, `SENDGRID_API_KEY`, `ANTHROPIC_API_KEY`, `BRAVE_SEARCH_API_KEY`, `GOOGLE_SHEETS_CREDENTIALS`, `SALES_CSV_URL`, `FIELD_APP_TOKEN`, `BACKUP_ENCRYPTION_KEY`, and every user's password. A reset link printed by `scripts/admin-reset-link.js` is a secret too: the owner runs it and opens the link themselves.

- **Never echo a secret back.** If you must refer to one, show at most its first 4 characters. Never `cat .env` and never print `railway variables` into the conversation. Check presence instead:
  `node -e "require('dotenv').config({ quiet: true }); for (const k of ['MONGODB_URI','JWT_SECRET','APP_URL','ADMIN_EMAIL','INITIAL_ADMIN_PASSWORD','NODE_ENV']) console.log(k, process.env[k] ? 'set' : 'MISSING')"`
  To check the local database name without showing the URI: `node -e "require('dotenv').config({ quiet: true }); const u=new URL(process.env.MONGODB_URI.replace(/^mongodb\+srv/,'http')); console.log('database:', u.pathname.slice(1) || '(none → test)')"`.
- **Generate random secrets straight into place.** For the local `.env`, fill the blank `JWT_SECRET=` line without showing it:
  `node -e "const fs=require('fs'),c=require('crypto');let s=fs.readFileSync('.env','utf8');if(/^JWT_SECRET=.+$/m.test(s))console.log('already set');else{s=s.replace(/^JWT_SECRET=$/m,'JWT_SECRET='+c.randomBytes(32).toString('hex'));fs.writeFileSync('.env',s);console.log('JWT_SECRET written')}"`
  For Railway (a **different** value) and for `FIELD_APP_TOKEN`, have them run `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` in **their own** terminal and paste the result into Railway themselves.
- **Passwords never pass through you.** They type `INITIAL_ADMIN_PASSWORD` into `.env` (in their editor) and into Railway themselves.
- **Prefer that they paste secrets into Railway → Variables themselves.** If they paste one into the chat anyway, use it, don't repeat it, and remind them it's a secret.
- **Never commit `.env` files.** Run `git status` before every commit and make sure no `.env` appears.

## Never touch live data or people without a yes

- Locally, `MONGODB_URI` must point at a database whose name ends in `_dev`, and `.env` must **not** contain the `CGT_S3_*` variables (a local run would otherwise write backups into the live bucket) or `SENDGRID_API_KEY`.
- `scripts/seed-sample.js` only ever goes into the empty `_dev` database. Never pass `--force` against a database with real data.
- Don't run loader scripts against the live database during setup; that's `/load-territory`'s job, with the owner's yes.
- Don't add users with anyone's email but the owner's own unless they ask; every invite sends an email.

## Where are they? (check; don't ask)

| Step | How to check |
| --- | --- |
| 1. Tools | `git --version`; `node --version` (20.19 or newer); `claude --version`; `git config user.name` returns a name |
| 2. Code | `git remote -v`: `origin` is **their own private repo**, `upstream` is `github.com/consultingarian-eng/cgterritory-os`. If `origin` still points at the public repo, walk them through step 2. Never suggest pushing to the public repo |
| 3. Database | They confirm (without pasting anything) that the Atlas cluster exists, the database user and a letters-and-numbers password are saved, Network Access has `0.0.0.0/0`, and they have both connection strings (`/cgterritory` and `/cgterritory_dev`). The real test is step 4 |
| 4. Local run | (Just looking, no Atlas yet? `npm run dev:mem` runs the sample on a throwaway in-memory database and prints a sign-in; it doesn't count as this step.) `.env` exists (`ls -a` / `Get-ChildItem -Force`) and isn't `.env.txt`; presence check passes; database name ends `_dev`; no `CGT_S3_*`; `node_modules` exists; `curl -s http://localhost:3000/healthz` says `ok`; they can sign in at http://localhost:3000 and see the sample areas |
| 5. Bucket | They confirm the private R2 bucket and an **Object Read & Write** token scoped to it, with the access key, secret and S3 endpoint saved. Real test: after step 6, `/api/admin/backups` (signed in as admin) shows `"enabled": true` |
| 6. Railway | `curl -s https://<their address>/healthz` says `ok`; `/login` shows the sign-in page with their app name. **Railway command line** (needed later for lock-outs, restores and live data loads): `railway --version` answers and `railway status` names their project and the app's service; if not, walk them through `docs/SETUP.md` → "The Railway command line" (install with `brew install railway` or `npm install -g @railway/cli`, then `railway login`, then `railway link` in the copy's folder). Then `railway logs` (read them for errors). Variable names only, never values: Mac `railway variables --kv \| cut -d= -f1`; PowerShell `railway variables --kv \| ForEach-Object { ($_ -split '=')[0] }` |
| 7. First admin | They've signed in live, changed the password, and removed `INITIAL_ADMIN_PASSWORD` from Railway (check the names list) |
| 8. Domain | `dig +short CNAME territory.<their domain>` (or `nslookup -type=CNAME …`) points at Railway; `https://territory.<their domain>/healthz` is `ok` over HTTPS; `APP_URL` uses it (ask them to confirm) |
| 9. Optional | Each service they chose passes its check in `docs/SETUP.md` step 9 |

## Traps that stop people

- **Server exits at start: "JWT_SECRET must be set"**: missing or under 32 characters.
- **No first admin, log says "Users exist — INITIAL_ADMIN_PASSWORD is ignored"**: the database already has accounts (a seeded sample, an earlier try). The first admin is only ever created into an empty `users` collection. Point at a fresh database, or have the owner run `node scripts/admin-reset-link.js <their email>` for an account that exists (live: `railway run -- node scripts/admin-reset-link.js <their email>`).
- **Sign-in says "Too many attempts"**: 8 wrong passwords from one address for that account (or 30 from one address in total) in 15 minutes. Wait it out (a server restart also clears it).
- **Server exits at start: "timezone … is not a valid IANA zone"**: a typo in `APP_TIMEZONE` or `timezone` (`Europe/London`, `America/New_York`).
- **`.env` ends up as `.env.txt`**: create it with `cp .env.example .env` (`Copy-Item` on Windows) instead of saving from an editor.
- **Windows, "running scripts is disabled"**: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.
- **Atlas `bad auth`**: wrong password in the URI, or symbols in it. New database user, letters-and-numbers password.
- **`/healthz` stuck on `warming`, or "MongoDB error" in the logs**: Network Access lacks `0.0.0.0/0`, or the URI is wrong.
- **Data lands in a database called `test`**: no database name after the `/` in the URI.
- **Signed in locally but bounced back to sign-in**: `NODE_ENV=development` missing in `.env` (the cookie is secure-only otherwise). Restart after editing `.env`.
- **Railway variables don't take effect**: Railway stages changes; click **Deploy** on the banner.
- **Empty-valued variables on Railway**: leave unused ones out entirely.
- **No invite email**: email isn't set up (`SENDGRID_API_KEY` + a verified `MAIL_FROM`); the logs say "skipping email". After fixing, **Resend** in Manage Users.
- **Old version on phones after a deploy**: the bump rule in `docs/SETUP.md` was missed.
- **Two replicas**: never. One server per database.
- **`railway: command not found`, or "No linked project"**: the Railway command line isn't installed or linked; `docs/SETUP.md` → "The Railway command line".
- **Windows and `NAME=value node …`**: that's Mac/Linux syntax. In PowerShell set it first (`$env:NAME="value"; node …`), or use the scripts' flags (`--dry-run`, `--with-days`).
- **Domain shows 404 or no padlock**: DNS record missing, or the certificate is still being issued (up to an hour). Use a subdomain.

## After it's live: optional services, one at a time

Recommend this order. For each, say what it unlocks, point to `docs/SERVICES.md`, and check it:

1. **Email (SendGrid)**: Mail Send key, verified sender, `MAIL_FROM`, `MAIL_FROM_NAME`. Check: "Forgot password" with their own email; the link arrives.
2. **AI (`ANTHROPIC_API_KEY`)**: set a monthly spend limit in the Anthropic Console first. Check: an area's drawer → Permit → **🤖 Research with AI**; remind them to check the result.
3. **Sales**: one source (`SALES_SHEET_ID` + `SALES_SHEET_GID` + `GOOGLE_SHEETS_CREDENTIALS`, or `SALES_CSV_URL`, or `SALES_CSV_FILE`); columns in `docs/DATA.md` → Sales. Check: **↻ Sync sales**, then the Balance page.
4. **Field app**: `FIELD_APP_TOKEN` (and `FIELD_APP_SYNC_URL` if their app supports it). Hand the push format in `docs/DATA.md` → Worked doors to whoever runs their field app. Check: one test door from their app appears under Layers → **🚪 Worked doors** → Today.

Then: `/load-territory` for their own areas, `/brand` for their look. Before a UK go-live, walk them through the checklist at the top of `docs/UK.md`.

## When you finish

Tell them in a few lines: the live address; what's switched on; what's optional and still off; next steps (`/load-territory`, `/brand`, `docs/UK.md` if they're in the UK); and the routine: business settings in `config/territory.json`, data through the loaders, anything else through Claude Code, then a local check, then a push (which deploys).
