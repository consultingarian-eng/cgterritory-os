# Security policy

## Reporting a vulnerability

Please report security problems **privately**, using GitHub's private vulnerability reporting for this repository:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the problem, how to reproduce it, and what an attacker could do with it.

**Never open a public issue, pull request or discussion for a vulnerability**, and don't post details anywhere public until a fix is available. A copy of this app holds an office's territory, its Do-Not-Knock addresses, incident reports, the doors its teams have worked and its sales locations. A public report puts every office running a copy at risk.

We'll acknowledge your report, keep you updated while we look into it, and credit you in the fix if you'd like.

## Scope

In scope: the code in this repository (the Express server, the web app in `public/`, the scripts, the deploy configuration and the Claude Code skills).

Out of scope:

- Individual deployments run by other people. Each office owner runs their own copy on their own hosting; report problems with a specific site to its owner.
- The outside services the app talks to (MongoDB Atlas, Railway, Cloudflare R2, Anthropic, SendGrid, Google, OpenStreetMap/Overpass, the map tile providers, the geocoders). Report those to the provider.

## If you run a copy of this app

- **Secrets live only in your host's variables** (Railway → Variables) and in a local `.env` that git ignores. Never commit them, paste them into an issue or a chat, or show them in a screenshot. [`.env.example`](.env.example) marks which variables are secrets.
- This repository contains **no** keys, passwords or connection strings. If you ever find one in it, report it as above.
- **`JWT_SECRET`** must be a long random value (the server refuses to start with less than 32 characters). Use a different one on your computer and on the live app.
- **If a secret leaks, rotate it at the provider straight away**: the database user's password (in `MONGODB_URI`), `JWT_SECRET`, the R2/S3 keys, the Anthropic key, the SendGrid key, the Google service-account key and the field-app service token. Then update Railway's variables and redeploy. Changing `JWT_SECRET` signs everyone out, which is what you want after a leak.
- **Remove `INITIAL_ADMIN_PASSWORD`** from your variables once your first admin has signed in and changed their password ([docs/SETUP.md](docs/SETUP.md#7-your-first-admin)). It only ever creates an admin while there are no accounts at all; after that it is ignored. Locked out: `scripts/admin-reset-link.js`.
- **The field-app service token** (`FIELD_APP_TOKEN`) unlocks the server-to-server addresses under `/api/integrations/`. Leave it unset if you don't connect a field app (those addresses then refuse every call); if you do set it, make it long and random and share it only with the field app's server.
- Everything after the sign-in page needs a session, including the map data files and the Do-Not-Knock list. Keep it that way if you add files to `public/data/`.
- Set a monthly spend limit on your Anthropic account. Permit research is the expensive call. The server also caps it (5 areas a request, 10 requests per user per 10 minutes) and caps all AI calls per day with `AI_DAILY_LIMIT` (default 200).
- **Accounts see the whole board.** The office switch and the hidden views (`canSeeView`) are conveniences in the app, not walls: every signed-in account can read every office's areas, Balance targets, coverage marks, worked doors (with the rep's name) and sale pins through the API. What the server does enforce is **who may change what** (sector leaders only log incidents and remove their own marks and routes; only admins manage users; demo accounts change nothing). Give accounts only to people who may see all of it, and run a separate copy for a business that must not see another's data.
- **Encrypt your backups** with `BACKUP_ENCRYPTION_KEY` (kept somewhere besides Railway too), and consider `BACKUP_PRUNE=off` with a bucket lifecycle rule or object lock so the app's key can't delete old nights ([docs/DATA.md](docs/DATA.md#9-backups-and-restoring)).
- **Behind a proxy?** Leave `TRUST_PROXY` unset. The server then believes `X-Forwarded-For` only when the connection comes from a private or loopback address, which is how a host's proxy (Railway, Render, Fly) reaches it. A browser connecting directly can't fake its address to dodge the sign-in throttle. Set it to `0` to ignore the header entirely, or to a hop count if your proxy connects from a public address.
- **Sign-in throttle.** Eight wrong passwords from one address lock that address out of that account for 15 minutes; the real owner signing in from elsewhere is not affected. An address is also capped at 30 failures across all accounts, and an account at 60 failures from all addresses together, so a spread-out attack still hits a wall (and can then lock the account for up to 15 minutes; existing sessions stay signed in).
- **Shared phones:** use **Sign out**. It ends the session on the server and deletes the app's offline copy (including the Do-Not-Knock list) from the device.
- Treat what you load as personal data where it is personal data: Do-Not-Knock addresses, incident notes, worked-door records (which carry the rep's name and email) and sales locations. [docs/UK.md](docs/UK.md#data-protection) covers the UK side.

## Rules the code keeps (for contributors)

- **Sessions are checked against the database, for pages and files too.** A session cookie lasts 30 days, but every API call **and** every page, map file and the Do-Not-Knock list re-reads the user's role, office and active flag (cached for a minute; `loadSession` in `server.js`), so deactivating someone or changing their role takes effect straight away.
- **Sessions can be ended.** Each session carries the account's `tokenVersion`: a password change or reset, or a deactivation, bumps it and every older session stops working (the device that changed the password gets a fresh one). **Sign out** revokes that one session's token id on the server (`RevokedToken`) until it would have expired.
- **Sign-in is throttled.** 8 failed passwords from one address for one account, 30 from one address across all accounts, or 60 for one account from all addresses, within 15 minutes; further attempts get `429` without a password check. "Forgot password" sends at most 3 mails an hour to one inbox and answers before it looks anything up, the same either way. Set-password and change-password are throttled too.
- **Stored text is data, not markup.** Everything people, imports, field apps, OpenStreetMap or the AI wrote is escaped where the app shows it, and validated where the server stores it (`lib/security.js`): incidents are rebuilt from known fields (type from a fixed list, a real date, numeric coordinates), coverage marks need a `YYYY-MM-DD` date, at most 5,000 points and an allow-listed style, preferences keep only known keys of the right type (and always belong to the signed-in user), edit field names can't be database operators, the figures the board draws (households, distances, drive and transit minutes) must be numbers, and place names (state, county, town) can't hold markup characters.
- **Content-Security-Policy and friends.** Every response carries a CSP that runs only this site's script files (plus the one spreadsheet-parser file on unpkg, named by its exact URL and pinned with an integrity hash; the rest of unpkg is refused); the pages' own inline scripts are allowed by their exact hash. Framing is refused (`frame-ancestors 'none'`, `X-Frame-Options`), `nosniff` and a strict referrer policy are set, HSTS when served over https, and `X-Powered-By` is off.
- **Cross-site writes are refused.** API writes must be JSON (there is no form parser) and are refused when the browser says they came from another origin or site (`Origin`, `Sec-Fetch-Site`), sibling subdomains included. Session cookies are `HttpOnly`, `SameSite=Lax` and `Secure` outside local development.
- **Expensive work is bounded.** Request bodies are capped (2 MB; 15 MB for AI imports; 8 MB for the field app's door push); AI calls as above; at most `ROUTE_COLD_JOBS` (2) street-map downloads at once and 10 route jobs per user per 10 minutes; the "↻ Sync doors" round-trip at most every 2 minutes; forced sales re-reads 3 per user per 5 minutes (none for demo accounts); address look-ups 120 per user per minute, with Nominatim paced to one request a second.
- **Errors don't leak internals.** A 4xx says what was wrong with the request; anything else is logged on the server and the browser gets a generic message.
- **Demo accounts never write.** A user with `demo: true` can look at everything their role can see, and every request that isn't a read is refused inside `requireAuth`, wherever the route sits in `server.js`. New write routes must go through `requireAuth`.
- **Sector leaders write only what they're allowed to.** On ZIP edits they may only log incidents, and remove only incidents they logged themselves (the server keeps who logged each one and never takes it from the request, so a safety warning someone else logged can't be wiped); they can delete only their own coverage marks and routes (not unattributed ones); permit research and AI imports are refused to them on the server, not just hidden in the app. Roles and offices are checked against fixed lists on create and update.
- **Server-to-server calls prove who sent them** with the `x-service-token` header, compared in constant time. New integration routes use `requireServiceToken`.
- **Invite and reset links are single-use and stored hashed.** Invites last 7 days, resets 1 hour; "forgot password" answers the same whether or not the email exists.
- **Backups can be encrypted** (AES-256-GCM, `BACKUP_ENCRYPTION_KEY`); `scripts/restore-backup.js` decrypts with the same key.
- **Tests cover these rules.** `npm test` runs `test/security.test.js` and `test/server.test.js` (in-memory MongoDB, no network). A change to who may do what comes with a test.
- Pull updates from upstream regularly; security fixes arrive that way ([docs/SETUP.md](docs/SETUP.md#updating)).
