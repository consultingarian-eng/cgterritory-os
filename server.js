require('dotenv').config({ quiet: true });
const express      = require('express');
const compression  = require('compression');
const path         = require('path');
const mongoose     = require('mongoose');
const crypto       = require('crypto');
const jwt          = require('jsonwebtoken');
const bcrypt       = require('bcryptjs');
const cookieParser = require('cookie-parser');
const sgMail       = require('@sendgrid/mail');
const { setupSectorLeader } = require('./lib/sector_leader_setup');
const { settings, normalizeAreaId, isAreaId, publicConfig } = require('./lib/settings');
const sec = require('./lib/security');
const osm = require('./lib/osm');

const app  = express();
const PORT = process.env.PORT || 3000;
app.disable('x-powered-by');
// The sign-in throttle keys on the client's address. By default
// X-Forwarded-For is believed only when the connection itself comes from a
// private / loopback address — i.e. from a host's proxy (Railway, Render, Fly…
// reach the app over a private network). A browser connecting straight in
// (a VPS with no proxy) comes from a public address, so a header it made up
// is ignored. TRUST_PROXY overrides: 0 = never trust the header, a number =
// that many proxy hops, or an Express subnet list.
const PRIVATE_PROXY_NETS = 'loopback, linklocal, uniquelocal, 100.64.0.0/10';
function trustProxySetting(v = '') {
  v = String(v).trim();
  if (!v) return PRIVATE_PROXY_NETS;
  if (/^(0|false|off)$/i.test(v)) return false;
  if (/^\d+$/.test(v)) return +v;
  return v;
}
app.set('trust proxy', trustProxySetting(process.env.TRUST_PROXY));

// ── Constants ────────────────────────────────────────────────────────────────
// Secrets come from the environment only. A missing JWT_SECRET is a refusal
// to start, not a random fallback: sessions signed with a throwaway key
// silently die on every restart and hide the misconfiguration.
const JWT_SECRET = process.env.JWT_SECRET || '';
if (JWT_SECRET.length < 32) {
  console.error('[auth] JWT_SECRET must be set to a random string of at least 32 characters (e.g. `openssl rand -hex 32`). Refusing to start.');
  process.exit(1);
}

const COOKIE_NAME = 'cgt_session';
// Every cached body carries "<boot nonce>-<revision>": the nonce changes per
// process (a restart can never reproduce an old tag) and the revision bumps
// on every mutation of that store, including replacements and removals.
const BOOT = crypto.randomBytes(4).toString('hex');
const APP_NAME    = settings.brand.appName;
const APP_URL     = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const FROM_EMAIL  = process.env.MAIL_FROM || '';
const FROM_NAME   = process.env.MAIL_FROM_NAME || APP_NAME;
// The first admin account (seeded from INITIAL_ADMIN_PASSWORD) and the
// address that hears about failed backups. No default: set it in the env.
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').toLowerCase().trim();
const ADMIN_NAME  = process.env.ADMIN_NAME || 'Admin';
// Identifies this deployment to the free geocoders (Nominatim's usage policy
// asks for a contact). Falls back to the admin address, then the app URL.
const GEOCODER_CONTACT = process.env.GEOCODER_CONTACT || ADMIN_EMAIL || APP_URL;
// The timezone every "today" on the board is kept in: APP_TIMEZONE, else
// `timezone` in config/territory.json, else America/New_York (lib/settings.js).
const TZ = settings.timezone;
// Office keys a user or a door may carry; 'both' = every office.
const OFFICE_KEYS = settings.officeKeys;
const USER_OFFICES = [...OFFICE_KEYS, 'both'];

if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ── MongoDB models ───────────────────────────────────────────────────────────
const UserSchema = new mongoose.Schema({
  email:             { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
  name:              { type: String, required: true },
  passwordHash:      { type: String, default: null },      // null = invite pending
  role:              { type: String, enum: ['sector_leader','client','admin'], default: 'sector_leader' },
  // An office key from config/territory.json, or 'both' = every office.
  // Not an enum: renaming an office in settings must not invalidate users.
  office:            { type: String, default: 'both' },
  emailVerified:     { type: Boolean, default: false },
  inviteToken:       { type: String,  default: null },
  inviteTokenExpiry: { type: Date,    default: null },
  resetToken:        { type: String,  default: null },
  resetTokenExpiry:  { type: Date,    default: null },
  active:            { type: Boolean, default: true },
  demo:              { type: Boolean, default: false },     // trial account: sees everything, writes are refused
  // Bumped on password change/reset and deactivation: every session signed
  // with an older value stops working at once (see loadSession).
  tokenVersion:      { type: Number,  default: 0 },
  createdAt:         { type: Date,    default: Date.now },
});
const User = mongoose.model('User', UserSchema);
const USER_ROLES = sec.ROLES;

// Sessions ended with "Sign out" before their 30 days were up. The token id
// (jti) is kept until the token would have expired anyway; the in-memory set
// is the fast path, the collection survives restarts.
const RevokedToken = mongoose.model('RevokedToken', new mongoose.Schema({
  jti: { type: String, required: true, unique: true },
  exp: { type: Date, required: true, index: { expires: 0 } },
}));
const revokedJtis = new Set();

const Edit = mongoose.model('Edit',
  new mongoose.Schema({ zip: { type: String, required: true, unique: true } }, { strict: false })
);

const Knock = mongoose.model('Knock', new mongoose.Schema({
  zip:      { type: String,  default: '' },
  latlngs:  { type: [[Number]], required: true },
  date:     { type: String,  required: true },
  style:    { type: mongoose.Schema.Types.Mixed, default: {} },
  userId:   { type: String,  default: null },
  userName: { type: String,  default: null },
}));

// Auto-synced door events pushed by your field app (see POST
// /api/integrations/worked-doors). Kept in their own collection — deliberately
// NOT Knock — so the manual mark-off flow, the eraser, and the field app's
// "who hasn't drawn coverage?" aggregation are completely untouched by the sync.
const WorkedDoorSchema = new mongoose.Schema({
  externalId:  { type: String, required: true, unique: true }, // the field app's own id for the door event — idempotent re-sync
  date:        { type: String, required: true },               // YYYY-MM-DD field day (board timezone, stamped by the field app)
  houseNumber: { type: String, default: '' },
  streetName:  { type: String, default: '' },
  aptNumber:   { type: String, default: '' },
  city:        { type: String, default: '' },
  address:     { type: String, default: '' },                  // display string from the field app
  zip:         { type: String, default: '' },
  lat:         { type: Number, default: null },
  lng:         { type: Number, default: null },
  geoFailed:   { type: Boolean, default: false },              // both geocoders struck out — don't retry forever
  batchTried:  { type: Boolean, default: false },              // been through a Census batch pass (leftovers go to the drip worker)
  outcome:     { type: String, default: '' },                  // won | partially_won | lost | swing_by_later | not_knocked
  baName:      { type: String, default: '' },
  baEmail:     { type: String, default: '' },
  office:      { type: String, default: '' },                  // an office key from settings, or ''
  sectorId:    { type: String, default: '' },                  // field-app sector/turf the rep ran that day
  sectorName:  { type: String, default: '' },
  zipSource:   { type: String, default: '' },                  // 'sector_majority' when normalized (see pass below)
  posSuspect:  { type: Boolean, default: false },              // coords couldn't be verified against the sector — keep the door, hide the pin
  tsEpoch:     { type: Number, default: null },                // when the door was actually marked
  syncedAt:    { type: Date,   default: Date.now },
});
WorkedDoorSchema.index({ date: 1 });
WorkedDoorSchema.index({ sectorId: 1, date: 1 });
WorkedDoorSchema.index({ lat: 1, geoFailed: 1 });
WorkedDoorSchema.index({ syncedAt: 1 });
const WorkedDoor = mongoose.model('WorkedDoor', WorkedDoorSchema);

// Permanent address→coordinate cache. The in-memory geocodeCache below resets
// on every deploy; door addresses repeat across re-knocks, so cache them in
// Mongo — each house is only ever geocoded once. ok:false = negative cache.
const GeoCache = mongoose.model('GeoCache', new mongoose.Schema({
  key:       { type: String, required: true, unique: true },   // normalized query
  ok:        { type: Boolean, default: false },
  lat:       { type: Number, default: null },
  lng:       { type: Number, default: null },
  zip:       { type: String, default: '' },
  matched:   { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
}));

// ── Board time ───────────────────────────────────────────────────────────────
// Every date on the platform is a calendar date in the board's timezone
// (settings.timezone; the et* names date from when that was always US
// Eastern). Server clocks (and toISOString()) are UTC — deriving a date from
// them directly shifts evening events onto tomorrow. These are the only
// sanctioned ways to get "today".
function etToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}
function etDaysAgo(n) {
  const t = new Date(etToday() + 'T00:00:00Z');   // UTC-space math on a pure calendar date
  t.setUTCDate(t.getUTCDate() - n);
  return t.toISOString().split('T')[0];
}

if (process.env.MONGODB_URI) {
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => {
      console.log('MongoDB connected'); seedAdmin();
      RevokedToken.find({ exp: { $gt: new Date() } }).select('jti').lean()
        .then(rows => rows.forEach(r => revokedJtis.add(r.jti)))
        .catch(e => console.error('[auth] could not load revoked sessions:', e.message));
      // Warm the RAM stores immediately — first visitors shouldn't be the trigger
      setTimeout(warmEditsStore, 500);
      setTimeout(warmKnocksStore, 3_000);
      setTimeout(warmDoorStore, 8_000);
      // Keep them current with small deltas; a full re-read only rarely. The
      // Atlas shared tier meters transfer, and re-reading every stroke
      // and doors every few minutes is what got the cluster throttled.
      setInterval(() => refreshKnocksRecent().catch(() => {}), 10 * 60 * 1000);
      setInterval(() => refreshDoorStoreRecent().catch(() => {}), 15 * 60 * 1000);
      setInterval(warmKnocksStore, 12 * 60 * 60 * 1000);
      setInterval(warmDoorStore, 6 * 60 * 60 * 1000);
      // Scripts write Edit directly (import-dnk, import-hubs, backfills):
      // re-read every half hour and bump only when something changed.
      setInterval(warmEditsStore, 30 * 60 * 1000);
      setTimeout(precompressStatic, 2_000);
      // Resume geocoding any worked doors left over from before a restart
      setTimeout(() => runGeoWorker().catch(e => console.error('[geo-worker]', e.message)), 20_000);
      // Worked doors keep 6 months — the map filter offers windows up to
      // "6 months", so retention must cover it. (Coverage strokes still purge
      // at 84 days; doors older than 84 days before this change are already
      // gone, so the longer windows fill in as new history accrues.)
      const purgeWorkedDoors = async () => {
        try {
          const cutoff = etDaysAgo(186);
          const r = await WorkedDoor.deleteMany({ date: { $lt: cutoff } });
          if (r.deletedCount) console.log(`[worked-doors] purged ${r.deletedCount} older than ${cutoff}`);
        } catch (e) { console.error('[worked-doors] purge failed:', e.message); }
      };
      setTimeout(purgeWorkedDoors, 30_000);
      setInterval(purgeWorkedDoors, 12 * 60 * 60 * 1000);
      // Nightly copy of every collection to R2/S3 (lib/backup.js) — once per board
      // day after 03:00; the first tick waits for the RAM stores to warm.
      setTimeout(() => backup.tick(), 10 * 60 * 1000);
      setInterval(() => backup.tick(), 20 * 60 * 1000);
    })
    .catch(err => { console.error('MongoDB error:', err.message); setTimeout(() => process.exit(1), 2000); });
}

// ── Email helpers ────────────────────────────────────────────────────────────
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function emailLayout(body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
</head>
<body style="margin:0;padding:0;background:#E8EAF0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#E8EAF0;padding:40px 0;">
  <tr><td align="center">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;padding:0 16px;">
      <tr><td style="padding-bottom:24px;text-align:center;">
        <img src="${APP_URL}${settings.brand.logoPng}" alt="${escHtml(settings.brand.orgName || APP_NAME)}" width="64"
          style="display:inline-block;">
        <div style="margin-top:10px;font-size:13px;font-weight:700;letter-spacing:.08em;color:#374151;text-transform:uppercase;">${escHtml(APP_NAME)}</div>
      </td></tr>
      <tr><td style="background:#160d24;border-radius:18px;padding:40px 36px;border:1px solid #2c1a43;">
        ${body}
      </td></tr>
      <tr><td style="padding-top:20px;text-align:center;color:#9CA3AF;font-size:11px;line-height:1.7;">
        ${escHtml(APP_NAME)} &mdash; ${escHtml(settings.brand.tagline)}${settings.brand.orgName ? `<br>
        ${escHtml(settings.brand.orgName)}` : ''}${settings.brand.orgUrl ? ` &nbsp;&middot;&nbsp; <a href="${escHtml(settings.brand.orgUrl)}" style="color:#9CA3AF;text-decoration:none;">${escHtml(settings.brand.orgUrl.replace(/^https?:\/\//, ''))}</a>` : ''}
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

async function sendMail(to, subject, html) {
  if (!process.env.SENDGRID_API_KEY || !FROM_EMAIL) {
    console.warn('[email] SENDGRID_API_KEY or MAIL_FROM not set — skipping email to', to, '| Subject:', subject);
    return;
  }
  try {
    await sgMail.send({ to, from: { email: FROM_EMAIL, name: FROM_NAME }, subject, html });
  } catch(e) {
    console.error('[email] SendGrid error:', e?.response?.body || e.message);
  }
}

async function sendInviteEmail(user, token) {
  const link = `${APP_URL}/set-password?token=${token}&mode=invite`;
  const roleLabels = { sector_leader:'Sector Leader', client:'Client', admin:'Admin' };
  const roleColor  = { sector_leader:'#10B981', client:'#06B6D4', admin:'#ec008c' };
  const html = emailLayout(`
    <p style="margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#6B7280;">You&rsquo;re invited</p>
    <h1 style="margin:0 0 20px;font-size:26px;font-weight:700;color:#F9FAFB;line-height:1.2;">Welcome to<br>${escHtml(APP_NAME)}</h1>
    <p style="margin:0 0 28px;font-size:15px;line-height:1.65;color:#9CA3AF;">
      Hi <strong style="color:#F9FAFB;">${escHtml(cap(user.name))}</strong> — you&rsquo;ve been added as a
      <span style="display:inline-block;padding:2px 9px;border-radius:999px;background:${(roleColor[user.role]||'#ec008c')}22;color:${roleColor[user.role]||'#ec008c'};border:1px solid ${(roleColor[user.role]||'#ec008c')}55;font-size:13px;font-weight:600;">${roleLabels[user.role] || user.role}</span>
      on the territory &amp; permit board. Click below to set your password and get started.
    </p>
    <a href="${link}"
      style="display:block;background:#c026a9;background:linear-gradient(135deg,#ec008c,#7a2a9e);color:#fff;text-decoration:none;text-align:center;padding:15px 24px;border-radius:999px;font-size:15px;font-weight:700;letter-spacing:.01em;margin-bottom:28px;">
      Set your password &rarr;
    </a>
    <hr style="border:none;border-top:1px solid #2c1a43;margin:0 0 20px;">
    <p style="margin:0;font-size:12px;color:#6B7280;line-height:1.6;">
      This link expires in <strong style="color:#9CA3AF;">7 days</strong>.
      If you weren&rsquo;t expecting this invitation, you can safely ignore this email.
    </p>
  `);
  await sendMail(user.email, `You've been invited to ${APP_NAME}`, html);
}

async function sendResetEmail(user, token) {
  const link = `${APP_URL}/set-password?token=${token}&mode=reset`;
  const html = emailLayout(`
    <p style="margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#6B7280;">Password reset</p>
    <h1 style="margin:0 0 20px;font-size:26px;font-weight:700;color:#F9FAFB;line-height:1.2;">Reset your<br>password</h1>
    <p style="margin:0 0 28px;font-size:15px;line-height:1.65;color:#9CA3AF;">
      Hi <strong style="color:#F9FAFB;">${escHtml(cap(user.name))}</strong> — we received a password reset request for your ${escHtml(APP_NAME)} account.
    </p>
    <a href="${link}"
      style="display:block;background:#c026a9;background:linear-gradient(135deg,#ec008c,#7a2a9e);color:#fff;text-decoration:none;text-align:center;padding:15px 24px;border-radius:999px;font-size:15px;font-weight:700;letter-spacing:.01em;margin-bottom:28px;">
      Reset password &rarr;
    </a>
    <hr style="border:none;border-top:1px solid #2c1a43;margin:0 0 20px;">
    <p style="margin:0;font-size:12px;color:#6B7280;line-height:1.6;">This link expires in <strong style="color:#9CA3AF;">1 hour</strong>. If you didn&rsquo;t request this, you can safely ignore it.</p>
  `);
  await sendMail(user.email, `Reset your ${APP_NAME} password`, html);
}

// ── Auth helpers ──────────────────────────────────────────────────────────────
const SESSION_DAYS = 30;
function signToken(user) {
  return jwt.sign(
    { id: String(user._id), email: user.email, name: user.name, role: user.role, office: user.office || 'both',
      tv: user.tokenVersion || 0 },
    JWT_SECRET,
    { expiresIn: `${SESSION_DAYS}d`, jwtid: crypto.randomBytes(12).toString('hex'), algorithm: 'HS256' }
  );
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV !== 'development',
    sameSite: 'lax',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  });
}
function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: process.env.NODE_ENV !== 'development', sameSite: 'lax', path: '/' });
}

// JWTs live 30 days, so role/active can't be trusted from the token alone —
// re-check the DB (cached 60s) so deactivations and role changes apply to API
// calls immediately, not at token expiry.
const userAuthCache = new Map(); // userId -> { role, office, active, exp, tv, ... }
function forgetUser(id) { userAuthCache.delete(String(id)); }

// ── Demo/trial accounts ──────────────────────────────────────────────────────
// A user doc with demo: true is a walk-around trial: it sees everything its
// role sees, but no mutation may reach production data. The decision lives
// here in requireAuth rather than in the /api/ gate further down, because that
// gate only covers routes registered BELOW it — user management and
// change-password are registered above it and were writing freely. Route order
// must never be the thing keeping a trial account read-only.
const DEMO_READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function demoWriteBlocked(req) {
  if (!req.user?.demo) return false;
  return !DEMO_READ_METHODS.has(req.method);
}

function refuseDemoWrite(res) {
  return res.status(403).json({ error: "Demo account — this trial doesn't save changes." });
}

// The one place a session cookie becomes a user. Used by the API gate
// (requireAuth) AND the page/static gate (authGate), so a deactivated,
// deleted, signed-out or password-changed session loses the Do-Not-Knock
// list and the territory files at the same moment it loses the API.
// → { user } | { error, status, clear } | { unknown: payload } (DB down, nothing cached)
async function loadSession(token) {
  if (!token) return { error: 'Not authenticated', status: 401 };
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }); }
  catch { return { error: 'Session expired — please log in again', status: 401, clear: true }; }
  if (payload.jti && revokedJtis.has(payload.jti))
    return { error: 'Signed out — please log in again', status: 401, clear: true };
  let u = userAuthCache.get(payload.id);
  try {
    if (!u || u.exp < Date.now()) {
      const doc = mongoose.isValidObjectId(payload.id)
        ? await User.findById(payload.id).select('role office active demo name tokenVersion').lean()
        : null;
      u = { exists: !!doc, role: doc?.role, office: doc?.office, active: !!doc?.active, demo: !!doc?.demo,
            name: doc?.name, tv: doc?.tokenVersion || 0, exp: Date.now() + 60_000 };
      userAuthCache.set(payload.id, u);
    }
  } catch {
    // DB hiccup. A stale cache entry still tells the truth about this account,
    // so keep using it. With nothing cached the caller decides.
    if (!u) return { unknown: payload };
  }
  if (!u.exists || !u.active) return { error: 'Account deactivated', status: 401, clear: true };
  if ((payload.tv || 0) !== u.tv) return { error: 'Session ended — please log in again', status: 401, clear: true };
  return { user: { ...payload, name: u.name || payload.name, role: u.role, office: u.office || 'both', demo: u.demo } };
}

async function requireAuth(req, res, next) {
  const s = await loadSession(req.cookies?.[COOKIE_NAME]);
  if (s.unknown) {
    // Nothing cached and the DB is down: we cannot know whether this is a
    // trial account, so refuse to write rather than guess — that costs a
    // real user nothing, since the write needed the same database anyway.
    req.user = s.unknown;
    if (!DEMO_READ_METHODS.has(req.method))
      return res.status(503).json({ error: 'Temporarily unavailable — please try again' });
    return next();
  }
  if (s.error) {
    if (s.clear) clearAuthCookie(res);
    return res.status(s.status).json({ error: s.error });
  }
  req.user = s.user;
  if (demoWriteBlocked(req)) return refuseDemoWrite(res);
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role))
      return res.status(403).json({ error: 'Insufficient permissions' });
    next();
  };
}

async function authGate(req, res, next) {
  // A redirect must never be cached against an asset URL: a browser that
  // remembered "/js/app.js?v=… → /login" would keep loading HTML as script.
  const toLogin = () => { res.set('Cache-Control', 'no-store'); res.redirect('/login'); };
  const s = await loadSession(req.cookies?.[COOKIE_NAME]);
  if (s.user) { req.user = s.user; return next(); }
  // DB down with nothing cached: a valid signature is all we can check, and
  // locking every user out of the app shell for a blip helps nobody.
  if (s.unknown) { req.user = s.unknown; return next(); }
  if (s.clear) clearAuthCookie(res);
  toLogin();
}

// Ends every session of one account (password change/reset, deactivation).
async function bumpTokenVersion(userId) {
  await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
  forgetUser(userId);
}

// ── Throttles ─────────────────────────────────────────────────────────────────
// In memory (one process). Login: a tight limit per (address, account) pair,
// a limit per address across accounts, and a much looser ceiling per account.
// So one address gets 8 guesses at an account, but can't lock its real owner
// out from somewhere else; only many addresses together reach the account
// ceiling. The bcrypt compare is skipped once a limit is hit.
const loginFailsByPair  = sec.createRateLimiter({ windowMs: 15 * 60_000, max: 8 });
const loginFailsByIp    = sec.createRateLimiter({ windowMs: 15 * 60_000, max: 30 });
const loginFailsByEmail = sec.createRateLimiter({ windowMs: 15 * 60_000, max: 60 });
const forgotByIp        = sec.createRateLimiter({ windowMs: 15 * 60_000, max: 10 });
const forgotByEmail     = sec.createRateLimiter({ windowMs: 60 * 60_000, max: 3 });
const setPasswordByIp   = sec.createRateLimiter({ windowMs: 15 * 60_000, max: 20 });
const changePwByUser    = sec.createRateLimiter({ windowMs: 15 * 60_000, max: 8 });
const geocodeByUser     = sec.createRateLimiter({ windowMs: 60_000, max: 120 });
const parseByUser       = sec.createRateLimiter({ windowMs: 10 * 60_000, max: 10 });
const salesRefreshByUser = sec.createRateLimiter({ windowMs: 5 * 60_000, max: 3 });
const emailKey = e => String(e || '').toLowerCase().trim().slice(0, 254);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(sec.securityHeaders({ hsts: process.env.NODE_ENV === 'production' || /^https:/.test(APP_URL) }));
app.use(compression());
app.use(cookieParser());
// JSON only — no urlencoded parser, so a plain HTML form can't post here.
// Bodies are small everywhere except the AI territory import (base64 photos
// and PDFs) and the field app's door push.
const jsonSmall = express.json({ limit: '2mb' });
const jsonLarge = express.json({ limit: '15mb' });
const jsonDoors = express.json({ limit: '8mb' });
app.use((req, res, next) => {
  if (req.path === '/api/parse-territories') return jsonLarge(req, res, next);
  if (req.path === '/api/integrations/worked-doors') return jsonDoors(req, res, next);
  return jsonSmall(req, res, next);
});
// Cross-site write protection for every cookie-authenticated API call.
const APP_HOST = (() => { try { return new URL(APP_URL).host; } catch { return ''; } })();
app.use('/api/', sec.csrfGuard({ allowedHosts: APP_HOST ? [APP_HOST] : [] }));

// ── Crawlers ─────────────────────────────────────────────────────────────────
// This is an internal tool, not a website. Everything past /login is private
// territory data, and /api/* answers 401 to anyone without a session — which
// Googlebot reported as "Blocked due to unauthorized request (401)" after
// rendering /login and following its fetch('/api/auth/me').
//
// Both signals are sent because they do different jobs: robots.txt stops the
// crawl (no more 401s in Search Console), X-Robots-Tag stops indexing of
// anything already discovered. The robots.txt route sits above authGate —
// without it the static handler redirects /robots.txt to /login, and a
// robots.txt that answers with HTML is read as "no robots.txt, crawl freely".
app.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});
app.get('/robots.txt', (req, res) =>
  res.type('text/plain').send('User-agent: *\nDisallow: /\n'));

// Health check (unauthenticated)
// Railway switches traffic to a new container only once this says 200 —
// after the RAM stores are warm, so nobody sees "warming" after a deploy.
app.get('/healthz', (req, res) => {
  if (process.env.MONGODB_URI && mongoose.connection.readyState === 1) {
    // A warm that failed once (a throttled read, a blip) would otherwise never
    // run again and the deploy would time out — each warm is idempotent.
    if (!editsStore.docs && !editsStore.warming) warmEditsStore();
    if (!knocksStore.docs && !knocksStore.warming) warmKnocksStore();
    if (!doorStore.docs && !doorStore.warming) warmDoorStore();
  }
  const ready = !process.env.MONGODB_URI || (editsStore.docs && knocksStore.docs);
  res.status(ready ? 200 : 503).send(ready ? 'ok' : 'warming');
});

// The first admin is created at start-up by seedAdmin() (bottom of this file),
// and only into an empty user collection.

// No-cache for HTML
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

// ── Branded pages ─────────────────────────────────────────────────────────────
// The HTML pages carry {{APP_NAME}}-style placeholders filled from
// settings.brand (config/territory.json), so a rebrand is a settings edit,
// not a hunt through markup. Rendered once per file and kept in memory.
const BRAND_VARS = {
  APP_NAME: settings.brand.appName,
  TAGLINE: settings.brand.tagline,
  DESCRIPTION: settings.brand.description,
  ORG_NAME: settings.brand.orgName || settings.brand.appName,
  ORG_URL: settings.brand.orgUrl || '',
  ORG_HOST: (settings.brand.orgUrl || '').replace(/^https?:\/\//, '').replace(/\/$/, ''),
  LOGO: settings.brand.logo,
  LOGO_PNG: settings.brand.logoPng,
  THEME_COLOR: settings.brand.themeColor,
};
const brandedCache = new Map();
function sendBranded(res, file) {
  let page = brandedCache.get(file);
  if (page == null) {
    const html = require('fs').readFileSync(path.join(__dirname, 'public', file), 'utf8')
      .replace(/\{\{(\w+)\}\}/g, (m, k) => (k in BRAND_VARS ? escHtml(BRAND_VARS[k]) : m))
      // No org URL in settings: drop the empty link (and its separator).
      .replace(/( &middot; )?<a [^>]*href=""[^>]*>[^<]*<\/a>/g, '');
    // The page's own inline <script> blocks are allowed by hash, computed
    // from the exact bytes served — nothing else inline can run.
    page = { html, csp: sec.cspHeader(sec.inlineScriptHashes(html)) };
    brandedCache.set(file, page);
  }
  res.set('Content-Security-Policy', page.csp);
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.type('html').send(page.html);
}

// ── Public pages ──────────────────────────────────────────────────────────────
app.get('/login',        (req, res) => sendBranded(res, 'login.html'));
app.get('/set-password', (req, res) => sendBranded(res, 'set-password.html'));
app.get('/view', authGate, (req, res) => sendBranded(res, 'index.html'));
// The page files by name, so the static handler never serves an unfilled template.
app.get('/index.html', authGate, (req, res) => sendBranded(res, 'index.html'));
app.get('/export-map.html', authGate, (req, res) => sendBranded(res, 'export-map.html'));
app.get('/login.html', (req, res) => sendBranded(res, 'login.html'));
app.get('/set-password.html', (req, res) => sendBranded(res, 'set-password.html'));

// Owner settings the app needs (offices with addresses, hubs, regions, labels,
// brand). Signed-in only: the login and set-password pages are branded on the
// server (sendBranded), so nothing before sign-in needs this.
app.get('/config.js', authGate, (req, res) => {
  res.type('application/javascript; charset=utf-8');
  res.set('Cache-Control', 'no-cache');
  res.send(`window.CGT_CONFIG = ${JSON.stringify(publicConfig())};\n`);
});

// Public branding/PWA assets — referenced by the login/set-password pages and
// needed by the browser BEFORE auth (install prompt, home-screen icons, tab icon).
app.get([
  '/logo.png', '/logo.svg', '/favicon.png', '/favicon-32.png', '/favicon-16.png',
  '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png',
], (req, res) => res.sendFile(path.join(__dirname, 'public', req.path)));
// A custom logo path from settings (e.g. /brand/acme.svg) is public too.
for (const p of new Set([settings.brand.logo, settings.brand.logoPng])) {
  if (/^\/[\w./-]+\.(png|svg|jpe?g|webp)$/.test(p || '') && !p.includes('..') && !['/logo.png', '/logo.svg'].includes(p))
    app.get(p, (req, res) => res.sendFile(path.join(__dirname, 'public', p)));
}

// PWA manifest — public so the app is installable from the login screen too.
// Name, description and colours come from settings.brand.
app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json');
  const m = JSON.parse(require('fs').readFileSync(path.join(__dirname, 'public', 'manifest.webmanifest'), 'utf8'));
  m.name = `${settings.brand.appName} — ${settings.brand.tagline}`;
  m.short_name = settings.brand.appName;
  m.description = settings.brand.description;
  m.background_color = m.theme_color = settings.brand.themeColor;
  res.send(JSON.stringify(m, null, 2));
});

// Service worker — must be reachable unauthenticated, live at the site root so
// its scope covers the whole origin, and never cached by the browser itself.
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// ── Auth routes ───────────────────────────────────────────────────────────────
// A bcrypt hash to compare against when the account doesn't exist, so a
// wrong email costs the same time as a wrong password (no account probing).
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 12);

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password)
      return res.status(400).json({ error: 'Email and password required' });
    if (password.length > 200) return res.status(400).json({ error: 'Invalid email or password' });
    const ek = emailKey(email);
    const pk = `${req.ip}|${ek}`;
    const limits = [loginFailsByPair.check(pk), loginFailsByIp.check(req.ip), loginFailsByEmail.check(ek)];
    if (limits.some(l => l.limited)) return sec.tooMany(res, Math.max(...limits.map(l => l.retryAfter)));
    const user = await User.findOne({ email: ek, active: true });
    const ok = await bcrypt.compare(password, user?.passwordHash || DUMMY_HASH);
    if (!user || !user.passwordHash || !ok) {
      loginFailsByPair.hit(pk); loginFailsByIp.hit(req.ip); loginFailsByEmail.hit(ek);
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    loginFailsByPair.reset(pk);
    const token = signToken(user);
    setAuthCookie(res, token);
    res.json({ ok: true, user: { id: user._id, email: user.email, name: user.name, role: user.role } });
  } catch(e) { sec.sendError(res, e, 'login'); }
});

// Signing out ends THIS session for good (its token id is revoked until it
// would have expired), not just the cookie in this browser.
app.post('/api/auth/logout', async (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (token) {
    try {
      const p = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
      if (p.jti) {
        revokedJtis.add(p.jti);
        await RevokedToken.updateOne({ jti: p.jti }, { $set: { jti: p.jti, exp: new Date(p.exp * 1000) } }, { upsert: true });
      }
    } catch {}
  }
  clearAuthCookie(res);
  res.set('Clear-Site-Data', '"cache"');
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  // requireAuth has just re-read role/office/active/demo (cached a minute),
  // so the launch path needs no second database round-trip — which on a
  // throttled day was 5–7 s before the app could start.
  const out = u => ({ id: String(u.id || u._id), email: u.email, name: u.name, role: u.role, office: u.office || 'both', demo: !!u.demo });
  if (!req.query.fresh) return res.json({ user: out(req.user) });
  try {
    const u = await User.findById(req.user.id).lean();
    if (u) {
      if (!u.active) {
        clearAuthCookie(res);
        return res.status(401).json({ error: 'Account deactivated' });
      }
      // `demo` comes back so the client can say "View only" out loud and hide
      // the controls it would only be refused on.
      return res.json({ user: out(u) });
    }
  } catch {}
  res.json({ user: out(req.user) });
});

app.post('/api/auth/forgot-password', async (req, res) => {
  // Same answer, at the same speed, whether or not the account exists: the
  // lookup and the mail happen after the response is sent.
  const generic = { ok: true, message: 'If that email exists, a reset link has been sent.' };
  const email = req.body?.email;
  if (typeof email !== 'string' || !email.includes('@')) return res.json(generic);
  const ek = emailKey(email);
  const byIp = forgotByIp.hit(req.ip);
  if (byIp.limited) return sec.tooMany(res, byIp.retryAfter);
  res.json(generic);
  if (forgotByEmail.hit(ek).limited) return;   // no more than 3 mails an hour to one inbox
  (async () => {
    const user = await User.findOne({ email: ek, active: true });
    if (!user || !user.passwordHash) return;
    const token = crypto.randomBytes(32).toString('hex');
    user.resetToken       = crypto.createHash('sha256').update(token).digest('hex');
    user.resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await user.save();
    await sendResetEmail(user, token);
  })().catch(e => console.error('forgot-password:', e.message));
});

app.post('/api/auth/set-password', async (req, res) => {
  try {
    const { token, password, mode } = req.body || {};
    if (typeof token !== 'string' || typeof password !== 'string' || password.length < 8 || password.length > 200)
      return res.status(400).json({ error: 'Token and password (8–200 characters) required' });
    const lim = setPasswordByIp.hit(req.ip);
    if (lim.limited) return sec.tooMany(res, lim.retryAfter);

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const field     = mode === 'invite' ? 'inviteToken' : 'resetToken';
    const expField  = mode === 'invite' ? 'inviteTokenExpiry' : 'resetTokenExpiry';
    const user = await User.findOne({ [field]: tokenHash, [expField]: { $gt: new Date() }, active: true });
    if (!user) return res.status(400).json({ error: 'Invalid or expired link — please request a new one' });

    user.passwordHash    = await bcrypt.hash(password, 12);
    user.emailVerified   = true;
    user[field]          = null;
    user[expField]       = null;
    // A new password ends every existing session (a stolen cookie included).
    user.tokenVersion    = (user.tokenVersion || 0) + 1;
    await user.save();
    forgetUser(user._id);

    const jwtToken = signToken(user);
    setAuthCookie(res, jwtToken);
    res.json({ ok: true, user: { id: user._id, email: user.email, name: user.name, role: user.role } });
  } catch(e) { sec.sendError(res, e, 'set-password'); }
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 200)
      return res.status(400).json({ error: 'Current password and new password (8–200 characters) required' });
    const lim = changePwByUser.hit(req.user.id);
    if (lim.limited) return sec.tooMany(res, lim.retryAfter);
    const user = await User.findById(req.user.id);
    if (!user || !user.passwordHash) return res.status(401).json({ error: 'Account not found' });
    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });
    user.passwordHash = await bcrypt.hash(newPassword, 12);
    // Sign out every other device; this one gets a fresh cookie below.
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();
    forgetUser(user._id);
    setAuthCookie(res, signToken(user));
    res.json({ ok: true });
  } catch(e) { sec.sendError(res, e, 'change-password'); }
});

// ── User management (admin only) ──────────────────────────────────────────────
const EMAIL_RE = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[^\s@<>"']{2,}$/;
const cleanName = v => String(v ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 120);

app.get('/api/users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const raw = await User.find({}).sort({ createdAt: 1 }).lean();
    const users = raw.map(({ passwordHash, inviteToken, resetToken, inviteTokenExpiry, resetTokenExpiry, tokenVersion, ...u }) => ({
      ...u,
      invitePending: !!inviteToken,
      hasPassword:   !!passwordHash,
    }));
    res.json({ users });
  } catch(e) { sec.sendError(res, e, 'users'); }
});

app.post('/api/users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { role, office } = req.body || {};
    const name = cleanName(req.body?.name);
    const email = emailKey(req.body?.email);
    if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'That email address does not look right' });
    if (role && !USER_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (office != null && office !== '' && !USER_OFFICES.includes(office)) return res.status(400).json({ error: 'Invalid office' });
    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ error: 'A user with that email already exists' });

    const rawToken = crypto.randomBytes(32).toString('hex');
    const user = await User.create({
      name,
      email,
      role: role || 'sector_leader',
      office: USER_OFFICES.includes(office) ? office : 'both',
      inviteToken:       crypto.createHash('sha256').update(rawToken).digest('hex'),
      inviteTokenExpiry: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    });

    await sendInviteEmail(user, rawToken);
    res.json({ ok: true, user: { id: user._id, name: user.name, email: user.email, role: user.role } });
  } catch(e) { sec.sendError(res, e, 'users'); }
});

app.put('/api/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'User not found' });
    const { name, role, active, office } = req.body || {};
    const update = {};
    if (name  !== undefined) {
      update.name = cleanName(name);
      if (!update.name) return res.status(400).json({ error: 'Name required' });
    }
    if (role  !== undefined) {
      if (!USER_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
      update.role = role;
    }
    if (active !== undefined) {
      if (typeof active !== 'boolean') return res.status(400).json({ error: 'active must be true or false' });
      if (!active && req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot deactivate your own account' });
      update.active = active;
    }
    if (office !== undefined) {
      if (!USER_OFFICES.includes(office))
        return res.status(400).json({ error: 'Invalid office' });
      update.office = office;
    }
    // Deactivating ends every session that account has, everywhere, now.
    const ops = active === false ? { $set: update, $inc: { tokenVersion: 1 } } : { $set: update };
    const user = await User.findByIdAndUpdate(req.params.id, ops, { new: true, runValidators: true })
      .select('-passwordHash -inviteToken -resetToken -tokenVersion');
    if (!user) return res.status(404).json({ error: 'User not found' });
    forgetUser(req.params.id); // role/office/active change applies on their next request
    res.json({ ok: true, user });
  } catch(e) { sec.sendError(res, e, 'users'); }
});

app.delete('/api/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    if (req.params.id === req.user.id)
      return res.status(400).json({ error: 'Cannot delete your own account' });
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'User not found' });
    await User.findByIdAndDelete(req.params.id);
    forgetUser(req.params.id);
    res.json({ ok: true });
  } catch(e) { sec.sendError(res, e, 'users'); }
});

app.post('/api/users/:id/resend-invite', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'User not found' });
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.passwordHash) return res.status(400).json({ error: 'User has already set a password' });
    const rawToken = crypto.randomBytes(32).toString('hex');
    user.inviteToken       = crypto.createHash('sha256').update(rawToken).digest('hex');
    user.inviteTokenExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await user.save();
    await sendInviteEmail(user, rawToken);
    res.json({ ok: true });
  } catch(e) { sec.sendError(res, e, 'users'); }
});

// ── Service-to-service integration (your field app) ───────────────────────────
// Your field / CRM app talks to the board server-to-server: it pushes worked
// doors, asks "who marked a map off between these dates?" (so it can remind
// sector leaders who ran a sector but never drew their coverage), lists active
// accounts and sets sector leaders up. Registered BEFORE the cookie-session
// gate below because the caller is a server, not a browser: it authenticates
// with a shared secret in the x-service-token header instead. Leave
// FIELD_APP_TOKEN unset and every one of these routes answers 503.
const FIELD_APP_TOKEN = process.env.FIELD_APP_TOKEN || '';
if (FIELD_APP_TOKEN && FIELD_APP_TOKEN.length < 24)
  console.warn('[integration] FIELD_APP_TOKEN is shorter than 24 characters — use a long random value');

// Shared gate for the server-to-server routes. Sends the error response
// itself and returns false; callers just `if (!requireServiceToken(req,res)) return`.
function requireServiceToken(req, res) {
  if (!FIELD_APP_TOKEN) {
    res.status(503).json({ error: 'Integration disabled — FIELD_APP_TOKEN is not set' });
    return false;
  }
  // Compare fixed-length digests: constant time, and any input (a different
  // length, multi-byte characters) is simply a mismatch, never an exception.
  const digest = v => crypto.createHash('sha256').update(String(v), 'utf8').digest();
  const ok = crypto.timingSafeEqual(digest(req.get('x-service-token') || ''), digest(FIELD_APP_TOKEN));
  if (!ok) { res.status(401).json({ error: 'Invalid service token' }); return false; }
  return true;
}

// Active accounts — lets the field app see who actually runs sectors /
// manages maps here. Clients (map viewers) and demo accounts don't count.
app.get('/api/integrations/users', async (req, res) => {
  try {
    if (!requireServiceToken(req, res)) return;
    const rows = await User.find({
      active: true,
      demo: { $ne: true },
      role: { $in: ['sector_leader', 'admin'] },
    }).select('email name role office passwordHash').lean();
    res.json({
      items: rows.map(u => ({
        email: u.email || '',
        name: u.name || '',
        role: u.role,
        office: u.office,
        invitePending: !u.passwordHash,   // never set a password yet
      })),
    });
  } catch (e) { sec.sendError(res, e, 'api'); }
});

// The field app's admin screen: "set this leader up on the board". Creates
// their sector leader account with the office view the field app has them in
// (or brings an existing account in line) and emails the invite. See
// lib/sector_leader_setup.
app.post('/api/integrations/sector-leaders', async (req, res) => {
  try {
    if (!requireServiceToken(req, res)) return;
    const makeInvite = () => {
      const raw = crypto.randomBytes(32).toString('hex');
      return { raw, hash: crypto.createHash('sha256').update(raw).digest('hex') };
    };
    const out = await setupSectorLeader(User, req.body || {}, { makeInvite });
    if (out.rawToken) await sendInviteEmail(out.user, out.rawToken);
    forgetUser(out.user._id); // a role/office change applies on their next request
    const u = out.user;
    res.json({
      status: out.status,
      changed: out.changed,
      matchedBy: out.matchedBy,
      user: { email: u.email, name: u.name, role: u.role, office: u.office, invitePending: !u.passwordHash },
    });
  } catch (e) { sec.sendError(res, e, 'api'); }
});

app.get('/api/integrations/markoffs', async (req, res) => {
  try {
    if (!requireServiceToken(req, res)) return;

    const from = String(req.query.from || '').trim();
    const to   = String(req.query.to   || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
      return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' });

    // One row per (user, date). `date` is the day the stroke was FILED FOR;
    // created_at comes from the ObjectId, so the caller can tell a same-day mark-off
    // from someone catching up on yesterday's map the next morning.
    const rows = await Knock.aggregate([
      { $match: { date: { $gte: from, $lte: to } } },
      { $group: {
          _id: { userId: '$userId', date: '$date' },
          userName: { $last: '$userName' },
          count: { $sum: 1 },
          first_created_at: { $min: { $toDate: '$_id' } },
          last_created_at:  { $max: { $toDate: '$_id' } },
      } },
    ]);

    // Attach emails so the caller can match on something stabler than a display name.
    const ids = [...new Set(rows.map(r => r._id.userId).filter(Boolean))];
    const emailById = {};
    if (ids.length) {
      const valid = ids.filter(id => mongoose.Types.ObjectId.isValid(id));
      for (const u of await User.find({ _id: { $in: valid } }).select('email name').lean())
        emailById[String(u._id)] = u.email || '';
    }

    res.json({
      from, to,
      items: rows.map(r => ({
        userId: r._id.userId || null,
        userName: r.userName || null,
        email: r._id.userId ? (emailById[r._id.userId] || null) : null,
        date: r._id.date,
        count: r.count,
        first_created_at: r.first_created_at,
        last_created_at: r.last_created_at,
      })),
    });
  } catch (e) { sec.sendError(res, e, 'api'); }
});

// The field app pushes the day's door events here (e.g. hourly). Upserts are
// keyed on externalId so re-pushing the same day is a no-op, not a duplicate.
// Doors arrive as text addresses; the geocode worker below fills in
// lat/lng/zip asynchronously so this request returns fast. A door that
// already carries lat/lng (and zip) is placed as sent and never geocoded —
// the way to go outside the US, where the Census geocoder can't help.
//
// Body: { doors: [{ id, date: 'YYYY-MM-DD', house_number, street_name,
//   apt_number, city, address, outcome, ba_name, ba_email, office,
//   sector_id, sector_name, ts_epoch, lat?, lng?, zip? }] }
app.post('/api/integrations/worked-doors', async (req, res) => {
  try {
    if (!requireServiceToken(req, res)) return;

    const doors = req.body?.doors;
    if (!Array.isArray(doors)) return res.status(400).json({ error: 'Body must be { doors: [...] }' });
    if (doors.length > 5000) return res.status(400).json({ error: 'Max 5000 doors per request' });

    const ops = [];
    let skipped = 0;
    for (const d of doors) {
      const externalId = String(d?.id || '').trim();
      const date = String(d?.date || '').trim();
      if (!externalId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { skipped++; continue; }
      // Coordinates from the field app itself: place the door as sent.
      const lat = +d.lat, lng = +d.lng;
      const placed = d.lat != null && d.lng != null && Number.isFinite(lat) && Number.isFinite(lng) &&
        Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
      // The area comes from the door's own zip (a full UK postcode folds to
      // its sector) or, when that is blank, from the polygon the point falls
      // in. Neither → the stored area is left as it was, never blanked.
      const area = placed ? (normalizeAreaId(d.zip) || osm.areaAt(lat, lng)) : '';
      const placedSet = placed
        ? { lat, lng, ...(area ? { zip: area } : {}), geoFailed: false, batchTried: true, posSuspect: false }
        : {};
      ops.push({ updateOne: {
        filter: { externalId },
        update: {
          // lat/lng/zip/geoFailed deliberately untouched — geocoding survives re-syncs
          $set: {
            date,
            houseNumber: String(d.house_number || '').slice(0, 20),
            streetName:  String(d.street_name  || '').slice(0, 120),
            aptNumber:   String(d.apt_number   || '').slice(0, 20),
            city:        String(d.city         || '').slice(0, 80),
            address:     String(d.address      || '').slice(0, 250),
            outcome:     String(d.outcome      || '').slice(0, 40),
            baName:      String(d.ba_name      || '').slice(0, 120),
            baEmail:     String(d.ba_email     || '').toLowerCase().trim().slice(0, 200),
            office:      OFFICE_KEYS.includes(d.office) ? d.office : '',
            sectorId:    String(d.sector_id   || '').slice(0, 40),
            sectorName:  String(d.sector_name || '').slice(0, 120),
            tsEpoch:     Number.isFinite(+d.ts_epoch) ? +d.ts_epoch : null,
            syncedAt:    new Date(),
            ...placedSet,
          },
        },
        upsert: true,
      } });
    }

    let upserted = 0, matched = 0;
    if (ops.length) {
      const r = await WorkedDoor.bulkWrite(ops, { ordered: false });
      upserted = r.upsertedCount || 0;
      matched  = r.matchedCount  || 0;
      setImmediate(() => runGeoWorker().catch(e => console.error('[geo-worker]', e.message)));
    }
    res.json({ ok: true, received: doors.length, upserted, updated: matched, skipped });
  } catch (e) { sec.sendError(res, e, 'api'); }
});

// ── API auth gate ─────────────────────────────────────────────────────────────
// Runs for all /api/ routes NOT already handled above.
// Demo accounts (demo: true on the user doc) see everything their role sees,
// but every mutation is refused so a trial can't touch real territory data.
// Refresh-style POSTs that only PULL fresh data stay open to them.
// Demo accounts are refused inside requireAuth, so every authenticated route
// is covered wherever it sits in this file — including /worked-doors/sync,
// which looks like a "pull-only refresh" but in fact makes the field app
// upsert real door rows. Doors still land on their own schedule, so a trial
// loses nothing it can see.
app.use('/api/', (req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();
  requireAuth(req, res, next);
});

// ── Static files ──────────────────────────────────────────────────────────────
// Session required: /data/*.json (incl. the Do-Not-Knock list), the app JS/CSS,
// and index.html must not be publicly downloadable.
// Precompressed static assets. app.js, style.css and the ZIP polygons are
// compressed once at brotli-11 (GeoJSON shrinks far more than with the
// on-the-fly quality-4 result) and served as-is; ?v= URLs are immutable.
const STATIC_DIR = path.join(__dirname, 'public');
const brotliReady = new Set();
const MIME = { '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.geojson': 'application/geo+json; charset=utf-8' };
async function precompressStatic() {
  const zlib = require('zlib');
  const fsp = require('fs/promises');
  const targets = [];
  for (const rel of ['js/app.js', 'css/style.css', 'data/master.json', 'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css']) targets.push(rel);
  try { for (const f of await fsp.readdir(path.join(STATIC_DIR, 'data'))) if (f.endsWith('.geojson')) targets.push('data/' + f); } catch {}
  for (const rel of targets) {
    const src = path.join(STATIC_DIR, rel), out = src + '.br';
    try {
      const st = await fsp.stat(src);
      let fresh = false;
      try { fresh = (await fsp.stat(out)).mtimeMs >= st.mtimeMs; } catch {}
      if (!fresh) {
        const buf = await fsp.readFile(src);
        const br = await new Promise((res, rej) => zlib.brotliCompress(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }, (e, r) => e ? rej(e) : res(r)));
        await fsp.writeFile(out, br);
      }
      brotliReady.add(rel);
    } catch (e) { if (e.code !== 'ENOENT') console.warn(`[static] ${rel}: ${e.message}`); }
  }
  if (brotliReady.size) console.log(`[static] ${brotliReady.size} assets precompressed`);
}
app.use(authGate, (req, res, next) => {
  if (req.method !== 'GET') return next();
  const ext = path.extname(req.path);
  const rel = req.path.replace(/^\//, '');
  if (!MIME[ext] || !brotliReady.has(rel) || req.acceptsEncodings('br', 'identity') !== 'br') return next();
  const versioned = !!req.query.v;
  res.sendFile(path.join(STATIC_DIR, rel + '.br'), {
    headers: {
      'Content-Type': MIME[ext], 'Content-Encoding': 'br', 'Vary': 'Accept-Encoding',
      'Cache-Control': versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=86400',
    },
  }, err => { if (err) next(); });
});
app.use(express.static(STATIC_DIR, {
  index: false,
  setHeaders(res, filePath) {
    const q = res.req?.query || {};
    if (q.v) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    else if (/\.(png|svg|ico|webmanifest|woff2?)$/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=86400');
    else res.setHeader('Cache-Control', 'public, max-age=3600');
  },
}));

// ── Edits (persisted ZIP overrides) ──────────────────────────────────────────
// The ZIP edit docs add up to hundreds of KB, and every launch and every
// 45-second poll used to read them from the database — seconds on a throttled day, awaited
// before the map could draw. They live in RAM now: warmed at boot, updated
// in place by every writer in this file, served with an ETag so an
// unchanged poll is a 304.
const editsStore = { docs: null, json: '', etag: '', version: 0, warming: null };
function bumpEdits() {
  editsStore.version++;
  editsStore.json = JSON.stringify(editsStore.docs);
  editsStore.etag = `"e${BOOT}-${editsStore.version}"`;
}
function warmEditsStore() {
  if (editsStore.warming) return editsStore.warming;
  editsStore.warming = (async () => {
    const t0 = Date.now();
    const docs = await Edit.find({}).lean();
    const result = {};
    docs.forEach(({ zip, _id, __v, ...rest }) => { result[zip] = rest; });
    const json = JSON.stringify(result);
    const changed = json !== editsStore.json;
    editsStore.docs = result;
    if (changed || !editsStore.etag) bumpEdits();
    if (!editsStore.warmedOnce || changed) console.log(`[edits-store] ${docs.length} ZIPs in ${((Date.now() - t0) / 1000).toFixed(1)}s${editsStore.warmedOnce ? ' (changed outside this process)' : ''}`);
    editsStore.warmedOnce = true;
  })().catch(e => console.error('[edits-store]', e.message)).finally(() => { editsStore.warming = null; });
  return editsStore.warming;
}
// After a write: re-read just those ZIPs (a handful of small docs). Waits
// for a warm in flight so a write that lands mid-warm isn't lost.
async function refreshEditsFor(zips) {
  if (editsStore.warming) await editsStore.warming.catch(() => {});
  if (!editsStore.docs || !zips.length) return;
  const docs = await Edit.find({ zip: { $in: zips } }).lean();
  const seen = new Set();
  for (const { zip, _id, __v, ...rest } of docs) { editsStore.docs[zip] = rest; seen.add(zip); }
  for (const z of zips) if (!seen.has(z)) delete editsStore.docs[z];
  bumpEdits();
}
app.get('/api/edits', async (req, res) => {
  try {
    if (req.query.nocache && req.user?.role === 'admin') {
      const docs = await Edit.find({}).lean();
      const result = {};
      docs.forEach(({ zip, _id, __v, ...rest }) => { result[zip] = rest; });
      return res.json(result);
    }
    if (!editsStore.docs) await warmEditsStore();
    if (!editsStore.docs) return res.status(503).json({ error: 'Edits still loading' });
    res.set('ETag', editsStore.etag);
    res.set('Cache-Control', 'private, no-cache');
    if (req.headers['if-none-match'] === editsStore.etag) return res.status(304).end();
    res.type('application/json').send(editsStore.json);
  } catch(err) { sec.sendError(res, err, 'api'); }
});
// One tiny request tells the app whether anything changed since its last
// sync — edits, coverage strokes, worked doors — so the 45-second poll no
// longer moves megabytes when nothing did.
app.get('/api/sync/version', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    edits: editsStore.etag || null,
    knocks: knocksStore.docs ? `k${BOOT}-${knocksStore.rev || 0}` : null,
    doors: doorStore.docs ? `d${BOOT}-${doorStore.rev || 0}` : null,
  });
});

// Fields a sector leader may write — incident logging only
const SECTOR_LEADER_FIELDS = new Set(['incidents']);
// Incident types that force a territory to RED / flagged (mirrors client INCIDENT_TYPES autoRed)
const AUTO_RED_INCIDENTS = sec.AUTO_RED_INCIDENTS;

app.post('/api/edits', async (req, res) => {
  try {
    const incoming = req.body;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming))
      return res.status(400).json({ error: 'Body must be an object keyed by ZIP' });
    if (Object.keys(incoming).length > 5000)
      return res.status(400).json({ error: 'At most 5000 areas per request' });

    const isSectorLeader = req.user?.role === 'sector_leader';
    // Every field is checked before anything is written (lib/security.js):
    // incidents are rebuilt from known keys, dates and keys checked, field
    // names restricted to plain identifiers.
    const ctx = { today: etToday(), hubKeys: settings.hubKeys, officeKeys: OFFICE_KEYS, isAreaId };
    const ops = [];
    for (const [zip, data] of Object.entries(incoming)) {
      if (!isAreaId(zip) || !data || typeof data !== 'object') continue;
      if (isSectorLeader) {
        const disallowed = Object.keys(data).filter(k => !SECTOR_LEADER_FIELDS.has(k));
        if (disallowed.length)
          return res.status(403).json({ error: 'Sector leaders can only log incidents' });
      }
      // null values mean "remove this field" — $set can never delete, so split into $set/$unset
      const v = sec.validateEditPatch(data, ctx);
      if (v.error) return res.status(400).json({ error: `${zip}: ${v.error}` });
      const set = { zip, ...v.set }, unset = v.unset;
      // Incidents: attribution kept server-side; sector leaders can only add,
      // or remove their own (lib/security.js mergeIncidents).
      if (isSectorLeader && 'incidents' in unset)
        return res.status(403).json({ error: 'Sector leaders can only add incidents or remove their own' });
      if (Array.isArray(set.incidents)) {
        if (editsStore.warming) await editsStore.warming.catch(() => {});
        const stored = editsStore.docs ? editsStore.docs[zip] : await Edit.findOne({ zip }, { incidents: 1, pipeline_stage: 1 }).lean();
        const m = sec.mergeIncidents(stored?.incidents, set.incidents,
          { userId: req.user?.id, leaderOnly: isSectorLeader });
        set.incidents = m.list;
        // Sector leaders can't write color/pipeline_stage, so apply the critical-incident
        // escalation (RED + flagged) on their behalf — same rule the client uses —
        // for a newly logged incident only.
        if (isSectorLeader && m.added.some(i => AUTO_RED_INCIDENTS.has(i?.type))) {
          set.color = 'RED';
          if (stored?.pipeline_stage) set.pipeline_stage = 'flagged';
        }
      }
      const update = { $set: set };
      if (Object.keys(unset).length) update.$unset = unset;
      ops.push({ updateOne: { filter: { zip }, update, upsert: true } });
    }
    if (ops.length) {
      await Edit.bulkWrite(ops);
      // Apply the same $set/$unset to the RAM copy — no second round-trip,
      // nothing to fail after the write has already happened.
      try {
        if (editsStore.warming) await editsStore.warming.catch(() => {});
        if (editsStore.docs) {
          for (const { updateOne: { filter: { zip }, update } } of ops) {
            const cur = editsStore.docs[zip] || {};
            for (const [k, v] of Object.entries(update.$set || {})) if (k !== 'zip') cur[k] = v;
            for (const k of Object.keys(update.$unset || {})) delete cur[k];
            editsStore.docs[zip] = cur;
          }
          bumpEdits();
        }
      } catch (e) { console.warn('[edits-store] in-memory apply failed:', e.message); }
    }
    res.json({ ok: true });
  } catch(err) { sec.sendError(res, err, 'edits'); }
});

// ── Per-user UI preferences ──────────────────────────────────────────────────
// Map/filter settings (state chips, base layer, overlays, …) keyed by user so
// they survive refresh, re-login, and follow the user across devices.
const Pref = mongoose.model('Pref',
  new mongoose.Schema({ userId: { type: String, required: true, unique: true } }, { strict: false })
);

app.get('/api/prefs', async (req, res) => {
  try {
    const doc = await Pref.findOne({ userId: req.user.id }).lean();
    // Filtered on the way out too, so nothing stored before the allow-list
    // existed can reach the page.
    res.json(sec.sanitizePrefs(doc || {}));
  } catch (e) { sec.sendError(res, e, 'api'); }
});

app.post('/api/prefs', async (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return res.status(400).json({ error: 'Body must be an object' });
    if (JSON.stringify(body).length > 20000)
      return res.status(400).json({ error: 'Prefs too large' });
    // Known keys only, each with its type — and the owner is always the
    // signed-in user: a userId in the body is dropped with everything else.
    const prefs = sec.sanitizePrefs(body);
    await Pref.updateOne(
      { userId: req.user.id },
      { $set: { ...prefs, userId: req.user.id } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (e) { sec.sendError(res, e, 'api'); }
});

// ── Address geocoding (incident ✕ pins) ──────────────────────────────────────
// US Census geocoder first (free, no key, house-level for US addresses),
// Nominatim/OSM as fallback. Cached in memory — incident addresses repeat
// (re-imports, edits) and both providers are rate-limited public services.
const geocodeCache = new Map(); // normalized query -> { lat, lng, matched } | null

async function censusGeocode(q) {
  return (await censusGeocodeAll(q))[0] || null;
}

// All Census candidates for a query — the sector pass picks the one in the
// right ZIP instead of trusting whichever candidate Census ranks first.
async function censusGeocodeAll(q) {
  const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(q)}&benchmark=Public_AR_Current&format=json`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) return [];
  const d = await r.json();
  return (d?.result?.addressMatches || []).filter(m => m?.coordinates).map(m => ({
    lat: m.coordinates.y, lng: m.coordinates.x, matched: m.matchedAddress || q,
    zip: String(m.addressComponents?.zip || ''),
  }));
}

// The Census geocoder only knows US addresses; outside the US (countryCodes
// in settings without "us") every lookup goes straight to Nominatim.
const CENSUS_OK = settings.countryCodes.includes('us');

// Nominatim's usage policy: at most one request a second from the whole
// deployment. Every caller (the address box, the door worker) queues here.
// The queue is bounded: past NOMINATIM_MAX_WAITING callers, the address box
// is told to try again (429) instead of piling up behind the door worker.
let nominatimNext = 0, nominatimWaiting = 0;
const NOMINATIM_MAX_WAITING = 20;
const nominatimBusy = () => nominatimWaiting >= NOMINATIM_MAX_WAITING;
async function nominatimSlot() {
  const wait = Math.max(0, nominatimNext - Date.now());
  nominatimNext = Math.max(Date.now(), nominatimNext) + 1100;
  if (!wait) return;
  nominatimWaiting++;
  try { await new Promise(r => setTimeout(r, wait)); } finally { nominatimWaiting--; }
}

async function nominatimGeocode(q) {
  await nominatimSlot();
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&addressdetails=1&countrycodes=${encodeURIComponent(settings.countryCodes.join(','))}`;
  const r = await fetch(url, {
    headers: { 'User-Agent': `${APP_NAME}/1.0 (${GEOCODER_CONTACT})` },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) return null;
  const hit = (await r.json())?.[0];
  if (!hit?.lat) return null;
  // The postcode (US ZIP or UK postcode → sector) from the structured address,
  // else the last 5-digit run in display_name ("…, 06511, United States").
  const zipMatch = String(hit.display_name || '').match(/\b(\d{5})(?:-\d{4})?\b(?!.*\b\d{5}\b)/);
  return { lat: parseFloat(hit.lat), lng: parseFloat(hit.lon), matched: hit.display_name || q,
           zip: normalizeAreaId(hit.address?.postcode) || (zipMatch ? zipMatch[1] : '') };
}

app.get('/api/geocode', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 200);
  if (!q) return res.status(400).json({ error: 'q required' });
  const lim = geocodeByUser.hit(req.user?.id || req.ip);
  if (lim.limited) return sec.tooMany(res, lim.retryAfter, 'Too many address lookups — wait a minute');
  const key = q.toLowerCase().replace(/\s+/g, ' ');
  if (geocodeCache.has(key)) {
    const hit = geocodeCache.get(key);
    return hit ? res.json(hit) : res.status(404).json({ error: 'Address not found' });
  }
  // Demo accounts look around; they don't send lookups to the free geocoders.
  if (req.user?.demo) return res.status(404).json({ error: 'Address lookup is off on the demo account' });
  try {
    let result = null;
    if (CENSUS_OK) { try { result = await censusGeocode(q); } catch {} }
    if (!result && nominatimBusy()) return sec.tooMany(res, 30, 'The address service is busy — try again in a minute');
    if (!result) { try { result = await nominatimGeocode(q); } catch {} }
    if (geocodeCache.size > 5000) geocodeCache.clear();
    geocodeCache.set(key, result);
    if (!result) return res.status(404).json({ error: 'Address not found' });
    res.json(result);
  } catch (e) { sec.sendError(res, e, 'api'); }
});

// ── Worked-door geocode worker ───────────────────────────────────────────────
// Drains WorkedDoor docs that still lack lat/lng, one address at a time, paced
// to stay polite to the free Census/Nominatim services. Field-app doors may
// carry no state — try the door's office's regions in order (city + state
// disambiguates), then every region on the board.
// Results land in the permanent GeoCache first, so a re-knocked house or a
// re-run after a crash never re-hits the geocoders.
const ALL_REGIONS = settings.allRegionCodes.length ? settings.allRegionCodes : [''];
const regionsFor = office => {
  const own = settings.officeRegions[office] || [];
  return own.length ? own : ALL_REGIONS;
};
const withRegion = (base, st) => st ? `${base}, ${st}` : base;
let geoWorkerRunning = false;

// One line of a Census batch-response CSV → array of fields (quoted-field aware)
function parseCsvLine(line) {
  const out = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// Census BATCH geocoder — up to 10k addresses per request, which is what makes
// a 12-week backfill take minutes instead of days. rows: [{key,street,city,state}].
// Returns Map key → {lat,lng,zip,matched} for matches, null for looked-up misses.
async function censusBatchGeocode(rows) {
  const csvCellQ = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = rows.map(r =>
    [r.key, r.street, r.city, r.state, ''].map(csvCellQ).join(',')).join('\n');
  const fd = new FormData();
  fd.append('benchmark', 'Public_AR_Current');
  fd.append('addressFile', new Blob([csv], { type: 'text/csv' }), 'addresses.csv');
  const r = await fetch('https://geocoding.geo.census.gov/geocoder/locations/addressbatch', {
    method: 'POST', body: fd, signal: AbortSignal.timeout(300000),
  });
  if (!r.ok) throw new Error(`census batch HTTP ${r.status}`);
  const text = await r.text();
  const out = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    // fields: id, input, Match|No_Match|Tie, Exact|Non_Exact, matched addr, "lng,lat", tigerId, side
    const f = parseCsvLine(line);
    const key = f[0];
    if (!key) continue;
    const status = (f[2] || '').trim();
    // 'Tie' (several candidates) is NOT a definitive miss — the single-address
    // endpoint resolves ties, so leave the key unset and the drip worker will
    // retry it there. Only 'No_Match' is negative-cacheable.
    if (status === 'Tie') continue;
    if (status !== 'Match') { out.set(key, null); continue; }
    const [lng, lat] = String(f[5] || '').split(',').map(Number);
    const zipm = String(f[4] || '').match(/\b(\d{5})(?:-\d{4})?\s*$/);
    out.set(key, (isFinite(lat) && isFinite(lng))
      ? { lat, lng, matched: f[4] || '', zip: zipm ? zipm[1] : '' }
      : null);
  }
  return out;
}

// Geocode query for a door in its office's PRIMARY state (MA / CT). Same key
// normalization as the drip worker, so both share the permanent GeoCache.
function doorPrimaryQuery(d) {
  const street = `${d.houseNumber || ''} ${d.streetName || ''}`.trim();
  if (!street || !d.city) return null;
  const state = regionsFor(d.office)[0];
  const q = withRegion(`${street}, ${d.city}`, state);
  return { street, city: d.city, state, q, key: q.toLowerCase().replace(/\s+/g, ' ') };
}

// Bulk pass: resolve pending doors from the cache, batch-geocode the rest in
// their primary state, and flag everything batchTried so the drip worker only
// ever sees the leftovers (alt-state + Nominatim retries).
async function runBatchGeocodePass() {
  for (;;) {
    const docs = await WorkedDoor.find({ lat: null, geoFailed: false, batchTried: { $ne: true } })
      .limit(4000).lean();
    if (!docs.length) break;

    const misses = [];
    for (const d of docs) {
      const pq = doorPrimaryQuery(d);
      if (!pq) {
        await WorkedDoor.updateOne({ _id: d._id }, { $set: { geoFailed: true, batchTried: true } });
        continue;
      }
      const hit = await GeoCache.findOne({ key: pq.key }).lean();
      if (hit?.ok) {
        await WorkedDoor.updateOne({ _id: d._id },
          { $set: { lat: hit.lat, lng: hit.lng, zip: hit.zip || '', batchTried: true } });
      } else if (hit) {
        // negative-cached in the primary state — straight to the drip worker
        await WorkedDoor.updateOne({ _id: d._id }, { $set: { batchTried: true } });
      } else {
        misses.push({ d, pq });
      }
    }

    if (misses.length) {
      let res = null;
      // No US Census outside the US: leave the misses to the drip worker,
      // which falls back to Nominatim.
      if (CENSUS_OK) try {
        res = await censusBatchGeocode(misses.map(m =>
          ({ key: String(m.d._id), street: m.pq.street, city: m.pq.city, state: m.pq.state })));
        console.log(`[geo-batch] ${misses.length} sent, ${[...res.values()].filter(Boolean).length} matched`);
      } catch (e) {
        console.error('[geo-batch] batch call failed:', e.message);
      }
      for (const m of misses) {
        const hit = res ? res.get(String(m.d._id)) : undefined;
        if (hit) {
          await GeoCache.updateOne({ key: m.pq.key },
            { $set: { ok: true, lat: hit.lat, lng: hit.lng, zip: hit.zip, matched: hit.matched } },
            { upsert: true }).catch(() => {});
          await WorkedDoor.updateOne({ _id: m.d._id },
            { $set: { lat: hit.lat, lng: hit.lng, zip: hit.zip || '', batchTried: true } });
        } else {
          // Negative-cache the primary state only if the batch actually answered;
          // a failed batch call must not poison the cache.
          if (res && hit === null) {
            await GeoCache.updateOne({ key: m.pq.key },
              { $set: { ok: false, lat: null, lng: null, zip: '', matched: '' } },
              { upsert: true }).catch(() => {});
          }
          await WorkedDoor.updateOne({ _id: m.d._id }, { $set: { batchTried: true } });
        }
      }
    }
  }
}

async function geocodeOneDoor(d) {
  const streetAddr = `${d.houseNumber || ''} ${d.streetName || ''}`.trim();
  if (!streetAddr || !d.city) {
    await WorkedDoor.updateOne({ _id: d._id }, { $set: { geoFailed: true } });
    return;
  }
  const states = regionsFor(d.office);
  for (const st of states) {
    const q = withRegion(`${streetAddr}, ${d.city}`, st);
    const key = q.toLowerCase().replace(/\s+/g, ' ');
    let hit = await GeoCache.findOne({ key }).lean();
    if (!hit) {
      let result = null;
      if (CENSUS_OK) { try { result = await censusGeocode(q); } catch {} }
      if (!result) { try { result = await nominatimGeocode(q); } catch {} }
      hit = { ok: !!result, lat: result?.lat ?? null, lng: result?.lng ?? null,
              zip: result?.zip || '', matched: result?.matched || '' };
      await GeoCache.updateOne({ key }, { $set: hit }, { upsert: true }).catch(() => {});
      await new Promise(r => setTimeout(r, 300));
    }
    if (hit.ok) {
      await WorkedDoor.updateOne({ _id: d._id }, { $set: { lat: hit.lat, lng: hit.lng, zip: hit.zip || '' } });
      return;
    }
  }
  await WorkedDoor.updateOne({ _id: d._id }, { $set: { geoFailed: true } });
}

// ── Sector-majority ZIP normalization ────────────────────────────────────────
// Reps sometimes tap the wrong ZIP in the field app; that mislabels the door's city,
// which can geocode the pin into the wrong town (or fail outright). A sector
// never genuinely straddles ZIPs, so: per (sector, day), take the majority
// geocoded ZIP; every door that disagrees is re-geocoded as "street, majZip"
// — Census resolves street+ZIP directly — which also rescues doors whose bad
// city made geocoding fail. If even that misses, the door keeps its coords
// but is relabeled to the sector's ZIP so per-ZIP coverage counts stay honest.
const SECTOR_MIN_DOORS = 5;    // don't trust a majority computed from a trickle
const SECTOR_MAJORITY  = 0.5;  // strict majority required before overriding
const SECTOR_RADIUS_KM = 3;    // a sector is walkable — a pin further than this from the cluster is a wrong match

const distKm = (a, b) => {
  const R = 6371, toRad = x => x * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};

// "street, city, state" but preferring the candidate in wantZip — streets that
// run through several ZIPs of one city get placed in the sector's
// ZIP instead of wherever Census's first-ranked candidate happens to sit.
async function censusPreferZipGeocode(street, city, st, wantZip) {
  const q = `${street}, ${city}, ${st}`;
  const key = `${q} @${wantZip}`.toLowerCase().replace(/\s+/g, ' ');
  let hit = await GeoCache.findOne({ key }).lean();
  if (!hit) {
    let cand = null;
    try { cand = (await censusGeocodeAll(q)).find(c => c.zip === wantZip) || null; } catch {}
    hit = { ok: !!cand, lat: cand?.lat ?? null, lng: cand?.lng ?? null,
            zip: cand?.zip || '', matched: cand?.matched || '' };
    await GeoCache.updateOne({ key }, { $set: hit }, { upsert: true }).catch(() => {});
    await new Promise(r => setTimeout(r, 300));
  }
  return hit.ok ? hit : null;
}

async function censusZipGeocode(street, suffix) {
  const q = `${street}, ${suffix}`;
  const key = q.toLowerCase().replace(/\s+/g, ' ');
  let hit = await GeoCache.findOne({ key }).lean();
  if (!hit) {
    let result = null;
    try { result = CENSUS_OK ? await censusGeocode(q) : await nominatimGeocode(q); } catch {}
    hit = { ok: !!result, lat: result?.lat ?? null, lng: result?.lng ?? null,
            zip: result?.zip || '', matched: result?.matched || '' };
    await GeoCache.updateOne({ key }, { $set: hit }, { upsert: true }).catch(() => {});
    await new Promise(r => setTimeout(r, 300));
  }
  return hit.ok ? hit : null;
}

async function runSectorZipNormalizePass() {
  // One aggregation gives both the ZIP counts and, within each ZIP, the city
  // label counts — so we know the sector's majority ZIP *and* majority town.
  const rows = await WorkedDoor.aggregate([
    { $match: { sectorId: { $nin: [null, ''] }, lat: { $ne: null }, zip: { $regex: settings.areaRe } } },
    { $group: { _id: { s: '$sectorId', d: '$date', z: '$zip', c: '$city' }, n: { $sum: 1 } } },
  ]);
  const bySectorDay = {};
  for (const r of rows) {
    const k = `${r._id.s}|${r._id.d}`;
    const g = (bySectorDay[k] ||= { total: 0, zips: {}, cities: {} });
    g.total += r.n;
    g.zips[r._id.z] = (g.zips[r._id.z] || 0) + r.n;
    (g.cities[r._id.z] ||= {});
    if (r._id.c) g.cities[r._id.z][r._id.c] = (g.cities[r._id.z][r._id.c] || 0) + r.n;
  }
  let fixed = 0, cityFixed = 0, relabeled = 0;
  for (const [k, agg] of Object.entries(bySectorDay)) {
    if (agg.total < SECTOR_MIN_DOORS) continue;
    const [majZip, majN] = Object.entries(agg.zips).sort((a, b) => b[1] - a[1])[0];
    if (majN / agg.total <= SECTOR_MAJORITY) continue;
    const majCity = Object.entries(agg.cities[majZip] || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    const [sectorId, date] = k.split('|');
    // Where the sector actually is: centroid of the doors already sitting in
    // the majority ZIP. Any rescue placement further than SECTOR_RADIUS_KM
    // from here is a confidently-wrong street match, not a door we knocked.
    const cAgg = await WorkedDoor.aggregate([
      { $match: { sectorId, date, zip: majZip, lat: { $ne: null },
                  zipSource: { $ne: 'sector_majority_label' } } },
      { $group: { _id: null, lat: { $avg: '$lat' }, lng: { $avg: '$lng' } } },
    ]);
    const centroid = cAgg[0]?.lat != null ? { lat: cAgg[0].lat, lng: cAgg[0].lng } : null;
    const nearSector = p => !centroid || (p?.lat != null && distKm(p, centroid) <= SECTOR_RADIUS_KM);
    // Outliers: geocoded into a different ZIP, failed to geocode, or rescued on
    // an earlier pass by label/town fallback (re-check those — a town-rescued
    // pin far from the sector cluster is exactly the wrong-ZIP scatter).
    const outliers = await WorkedDoor.find({
      sectorId, date,
      $and: [
        { $or: [{ zip: { $ne: majZip } }, { zipSource: { $in: ['sector_majority_label', 'sector_majority_city'] } }] },
        { $or: [{ lat: { $ne: null } }, { geoFailed: true }] },
        { zipSource: { $ne: 'sector_majority' } },
      ],
    }).limit(500).lean();
    for (const d of outliers) {
      // Town-rescued on an earlier pass and plausibly near the cluster — keep it
      if (d.zipSource === 'sector_majority_city' && d.lat != null && nearSector(d)) continue;
      const street = `${d.houseNumber || ''} ${d.streetName || ''}`.trim();
      let set = null;
      if (street) {
        // 1) exact: the street in the sector's majority ZIP
        let hit = null;
        try { hit = await censusZipGeocode(street, majZip); } catch {}
        if (hit && hit.zip === majZip) {
          set = { lat: hit.lat, lng: hit.lng, zip: majZip, geoFailed: false, zipSource: 'sector_majority', posSuspect: false };
          fixed++;
        }
        // 1b) all candidates for street+town, preferring one in the majority
        // ZIP — catches streets whose first-ranked candidate is across town
        if (!set && majCity) {
          for (const st of (CENSUS_OK ? regionsFor(d.office) : [])) {
            try { hit = await censusPreferZipGeocode(street, majCity, st, majZip); } catch { hit = null; }
            if (hit) {
              set = { lat: hit.lat, lng: hit.lng, zip: majZip, geoFailed: false, zipSource: 'sector_majority', posSuspect: false };
              fixed++;
              break;
            }
          }
        }
        if (!set && majCity) {
          // 2) same street, the sector's majority TOWN — multi-ZIP cities
          // (one town split across three ZIPs) put the real house in a sibling ZIP.
          // Only trusted when it lands near the sector's actual cluster.
          for (const st of regionsFor(d.office)) {
            try { hit = await censusZipGeocode(street, withRegion(majCity, st)); } catch { hit = null; }
            if (hit && nearSector(hit)) {
              set = { lat: hit.lat, lng: hit.lng, zip: hit.zip || majZip, geoFailed: false, zipSource: 'sector_majority_city', posSuspect: false };
              cityFixed++;
              break;
            }
          }
        }
      }
      if (set) {
        await WorkedDoor.updateOne({ _id: d._id }, { $set: set });
      } else {
        // 3) can't place it anywhere plausible — make the ZIP label follow the
        // sector so per-ZIP counts stay honest, and mark the coords suspect so
        // the map doesn't draw a pin we know is in the wrong place
        await WorkedDoor.updateOne({ _id: d._id },
          { $set: { zip: majZip, zipSource: 'sector_majority_label', posSuspect: true } });
        if (d.zipSource !== 'sector_majority_label') relabeled++;
      }
    }
  }
  if (fixed || cityFixed || relabeled)
    console.log(`[sector-zip] re-placed ${fixed} by ZIP, ${cityFixed} by town, relabeled ${relabeled}`);
}

async function runGeoWorker() {
  if (geoWorkerRunning) return;
  geoWorkerRunning = true;
  try {
    // Bulk first: Census batch clears the vast majority in a few requests…
    try { await runBatchGeocodePass(); }
    catch (e) { console.error('[geo-batch]', e.message); }
    // …then the drip loop mops up what batch couldn't place (alt state, Nominatim).
    // Paginate by _id so a doc whose geocode errors (and thus stays lat:null)
    // is visited at most once per run instead of looping the worker forever.
    let lastId = null;
    for (;;) {
      const filter = { lat: null, geoFailed: false };
      if (lastId) filter._id = { $gt: lastId };
      const batch = await WorkedDoor.find(filter).sort({ _id: 1 }).limit(50).lean();
      if (!batch.length) break;
      lastId = batch[batch.length - 1]._id;
      for (const d of batch) {
        try { await geocodeOneDoor(d); }
        catch (e) { console.error('[geo-worker]', d.externalId, e.message); }
      }
    }
    // Finally, snap outlier ZIPs to each sector's majority for the day
    try { await runSectorZipNormalizePass(); }
    catch (e) { console.error('[sector-zip]', e.message); }
  } finally { geoWorkerRunning = false; refreshDoorStoreRecent().catch(() => {}); }
}

// ── AI permit analysis ────────────────────────────────────────────────────────
const SEARCH_QUOTA_SENTINEL = '__QUOTA_EXHAUSTED__';

async function braveSearch(query) {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) return 'Search unavailable — BRAVE_SEARCH_API_KEY not set on server';
  try {
    const r = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8&text_decorations=false`,
      { headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': key } }
    );
    if (r.status === 429 || r.status === 402 || r.status === 403) return SEARCH_QUOTA_SENTINEL;
    const d = await r.json();
    if (d.error || d.type === 'ErrorResponse') return SEARCH_QUOTA_SENTINEL;
    const hits = (d.web?.results || []).slice(0, 8);
    if (!hits.length) return 'No results found.';
    return hits.map(x => `TITLE: ${x.title}\nURL: ${x.url}\nSNIPPET: ${(x.description||'').slice(0,500)}`).join('\n\n');
  } catch(e) { return `Search error: ${e.message}`; }
}

const SEARCH_TOOL = [{
  name: 'search_web',
  description: 'Search the web for municipal ordinances, code sections, or permit requirements for door-to-door canvassing / soliciting in a specific town.',
  input_schema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Specific search query' } },
    required: ['query']
  }
}];

// The jurisdiction and any extra checks come from settings.research, so an
// owner elsewhere (another US region, the UK) steers the research without
// touching this prompt.
const RESEARCH_REGION = settings.research.region || 'the United States';
const RESEARCH_NOTES = (settings.research.notes || []).map(n => `- ${n}`).join('\n');
const RESEARCH_SYSTEM = `You are a permit compliance researcher for a door-to-door residential canvassing company operating in ${RESEARCH_REGION}. Your job is to find EXACT, actionable permit details — not generic advice. A field team leader needs to know precisely what forms to fill, who to call, how much to pay per person, and how many days in advance.

For EACH municipality, execute this search sequence:

STEP 1 — Municipal code (ordinance text):
  Search: "[town] [state] solicitor peddler canvasser ordinance"
  Also try: site:ecode360.com "[town]" solicitor OR site:municode.com "[town]" solicitor

STEP 2 — Official town website (fee schedules, application forms):
  Search: site:[town].gov solicitor permit fee OR "[town] [state] town clerk solicitor permit application"
  Look for: fee schedules, permit applications, clerk department pages
  Many towns post fees ONLY on their website, not in the ordinance text — check both.

STEP 3 — Fee and cost deep-dive (ALWAYS run this, even if you found a fee in step 1 or 2):
  Search: "[town] [state] solicitor permit fee 2024" OR "[town] [state] peddler license fee per person"
  Search: "[town] [state] canvasser background check fingerprint requirement"
  Look specifically for: per-person cost, per-company cost, renewal fees, badge/ID card cost

STEP 4 — Processing time and state / national requirements:
  Search: "[town] [state] solicitor permit processing time how long"
  Check whether a state-level (or national) licence or registration applies on top of the local permit.

CRITICAL RULES:
- "A fee may apply" is NOT acceptable. Run follow-up searches until you have a dollar amount, or explicitly state you searched the website and it was not posted.
- If the town website has a fee schedule PDF or page, that is the authoritative source — ordinances sometimes have outdated amounts.
- Per-person vs per-company distinction is critical — report both if both exist.
- Background check / fingerprint / surety bond / photo ID badge requirements must be explicitly noted.
${RESEARCH_NOTES}

Return a JSON array — one entry per ZIP. Structure:
[{
  "zip": "string",
  "status": "GREEN"|"YELLOW"|"RED",
  "summary": "One punchy line with the key facts, e.g. 'Solicitor Permit required — $100/person, submit to City Clerk, 5-day lead time'",
  "fee": "Full fee breakdown: per-person AND per-company if applicable, e.g. '$1,000 per canvasser + $50 company registration fee' — say 'Not posted on website or ordinance after search' only if genuinely not found",
  "cost_per_person": "Just the per-person dollar figure, e.g. '$1,000' — or 'Unknown' if not found",
  "processing_time": "Exact turnaround, e.g. '5 business days', 'Same day at counter', '3–5 business days per Town Clerk website' — not just 'varies'",
  "permit_process": "Numbered step-by-step: 1. [form name + where to get it] 2. [fee payment method] 3. [background check/fingerprint if required] 4. [photo ID badge if required] 5. [state-level registration if required] 6. [lead time]. Be specific.",
  "authority": "Office name + address + phone/email if found, e.g. 'City Clerk, City Hall, [street address], [town] [postcode], [phone]'",
  "hours": "Allowed canvassing hours per ordinance, e.g. '9:00am–8:00pm Mon–Sat, Sundays prohibited'",
  "days_restricted": "Restricted days explicitly, e.g. 'No Sundays', 'Holidays prohibited', or 'None specified in ordinance'",
  "other_restrictions": "Badge/ID card requirements, no-knock registry compliance, surety bond amount if required, insurance requirements, annual vs. per-campaign permit, any other operational constraints",
  "ordinance_ref": "Specific code citation if found, e.g. '[Town] Code of Ordinances Ch. 148 §4' — 'Not located' if genuinely absent"
}]

GREEN = no permit required (genuinely rare — confirm explicitly).
YELLOW = permit required but obtainable with reasonable effort.
RED = canvassing explicitly prohibited or permit effectively impossible to obtain.

Return ONLY the JSON array. No preamble, no explanation, no markdown — just the array.`;

// Extract the first well-formed JSON array from model output.
// Greedy regex (\[[\s\S]*\]) breaks when the model appends trailing text
// containing brackets (e.g. "Note: see [1]") — bracket-depth parsing is exact.
function extractJsonArray(text) {
  const start = text.indexOf('[');
  if (start === -1) return '[]';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc)              { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"')        { inStr = !inStr; continue; }
    if (inStr)            continue;
    if (c === '[')        depth++;
    else if (c === ']')   { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  // Fallback: just grab whatever looks like an array
  const m = text.match(/\[[\s\S]*\]/);
  return m ? m[0] : '[]';
}

// One model for every AI call (permit research and territory parsing).
const AI_MODEL = (process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5').trim();

// A ceiling on AI calls per board day across the whole deployment, on top
// of the per-user limits — so one account (or a stolen session) can't run up
// the bill. AI_DAILY_LIMIT=0 switches the AI features off.
// Blank (as in .env.example) means the default; anything that isn't a number switches AI off.
const AI_DAILY_LIMIT = Math.max(0, parseInt((process.env.AI_DAILY_LIMIT || '').trim() || '200', 10) || 0);
const aiBudget = { day: '', used: 0 };
function takeAiBudget(n = 1) {
  const today = etToday();
  if (aiBudget.day !== today) { aiBudget.day = today; aiBudget.used = 0; }
  if (aiBudget.used + n > AI_DAILY_LIMIT) return false;
  aiBudget.used += n;
  return true;
}

// The system prompt is identical on every research call and on every resume
// inside one, so it is marked cacheable: written once, then read at a tenth of
// the price. It also switches on the API's own caching of web-search results,
// which is what makes the pause_turn resumes below cheap — without a
// breakpoint somewhere in the request, every resume re-bills the full
// transcript of searches so far.
const RESEARCH_SYSTEM_CACHED = [
  { type: 'text', text: RESEARCH_SYSTEM, cache_control: { type: 'ephemeral' } },
];

// Primary research path: Anthropic's server-side web search tool. Searches run
// on Anthropic's side (no Brave key, no hand-rolled tool loop) and results come
// back with source citations.
async function researchZipsWithServerSearch(client, zips) {
  const zipList = zips.map(z => `${z.zip} — ${z.municipality||z.primary_city||''}, ${z.state}`).join('\n');
  let messages = [{ role:'user', content:`Research door-to-door canvassing permit requirements for these municipalities:\n${zipList}` }];
  const makeParams = () => ({
    model: AI_MODEL,
    max_tokens: 16000,
    system: RESEARCH_SYSTEM_CACHED,
    // ~25 searches for a single ZIP — the research sequence needs 4 steps plus
    // fee/ordinance follow-ups; 12 proved too tight (model reported being cut off)
    tools: [{ type:'web_search_20260209', name:'web_search', max_uses: Math.min(80, 15 * zips.length + 10) }],
    messages,
  });
  // Ground truth that the cache is actually being read. If cache_read stays 0
  // across resumes, the prefix is being rewritten somewhere and the resumes
  // are back to full price — nothing else reports that.
  const logUsage = (label, r) => {
    const u = r.usage || {};
    console.log(`[research] ${label} cache_read=${u.cache_read_input_tokens||0} ` +
                `cache_write=${u.cache_creation_input_tokens||0} fresh_in=${u.input_tokens||0}`);
  };
  let resp = await client.messages.create(makeParams());
  logUsage('initial', resp);
  // The server-side tool loop pauses every ~10 search rounds — append the
  // assistant turn and re-send to resume (no extra user message).
  for (let i = 0; i < 8 && resp.stop_reason === 'pause_turn'; i++) {
    messages = [...messages, { role:'assistant', content: resp.content }];
    resp = await client.messages.create(makeParams());
    logUsage(`resume ${i + 1}`, resp);
  }
  const text = resp.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  return JSON.parse(extractJsonArray(text));
}

// Fallback research path: hand-rolled Brave Search tool loop (used only when
// the server-side web search call fails and BRAVE_SEARCH_API_KEY is set).
async function researchZipsWithSearch(client, zips) {
  const zipList = zips.map(z => `${z.zip} — ${z.municipality||z.primary_city||''}, ${z.state}`).join('\n');
  const messages = [{ role: 'user', content: `Research door-to-door canvassing permit requirements for these municipalities:\n${zipList}` }];

  const MAX_ITER = 40;
  let iterations = 0, quotaFailures = 0;

  async function callClaude(msgs, tools = SEARCH_TOOL) {
    return client.messages.create({ model:AI_MODEL, max_tokens:8192, system:RESEARCH_SYSTEM_CACHED, tools, messages:msgs });
  }

  while (iterations < MAX_ITER) {
    iterations++;
    const resp = await callClaude(messages);

    if (resp.stop_reason === 'end_turn') {
      const text = resp.content.find(c => c.type === 'text')?.text || '[]';
      return JSON.parse(extractJsonArray(text));
    }

    if (resp.stop_reason === 'tool_use') {
      messages.push({ role:'assistant', content:resp.content });
      const results = [];
      let thisRoundQuota = false;
      for (const tu of resp.content.filter(c => c.type === 'tool_use')) {
        console.log(`  [search] (iter ${iterations}/${MAX_ITER}) ${tu.input.query}`);
        const raw = await braveSearch(tu.input.query);
        const isQuota = raw === SEARCH_QUOTA_SENTINEL;
        if (isQuota) { thisRoundQuota = true; quotaFailures++; }
        results.push({ type:'tool_result', tool_use_id:tu.id, content: isQuota ? 'Search temporarily unavailable — use training data for this query.' : raw });
      }
      // One moving breakpoint on the freshest search results: the next
      // iteration reads every prior round back from cache instead of paying
      // full price for it again. Over 40 iterations that is the difference
      // between linear and quadratic spend. Clear the previous marker first —
      // only four are allowed per request.
      for (const m of messages)
        if (Array.isArray(m.content))
          for (const b of m.content) if (b && typeof b === 'object') delete b.cache_control;
      if (results.length) results[results.length - 1].cache_control = { type: 'ephemeral' };
      messages.push({ role:'user', content:results });
      if (thisRoundQuota && quotaFailures >= 4) {
        messages.push({ role:'user', content:'Web search is temporarily unavailable. Return the best JSON you can now using your training data. Do not call search_web again.' });
      }
    } else {
      // refusal, max_tokens, anything else: re-sending the same request would
      // only bill it again.
      throw new Error(`research stopped: ${resp.stop_reason}`);
    }
  }

  console.warn(`[research] hit ${MAX_ITER} iterations — requesting partial results`);
  messages.push({ role:'user', content:'You have used the maximum number of search rounds. Return the JSON array now with whatever you have found so far. Fill any unknowns with "Not confirmed — verify with Town Clerk". Do not call search_web again.' });
  const final = await callClaude(messages, []);
  const text = final.content.find(c => c.type === 'text')?.text || '[]';
  return JSON.parse(extractJsonArray(text));
}

// Per-user limiter — research is the expensive endpoint (model + web search)
const researchCalls = new Map(); // userId -> [timestamps]
function researchRateLimited(userId, max = 10, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const hits = (researchCalls.get(userId) || []).filter(t => now - t < windowMs);
  if (hits.length >= max) { researchCalls.set(userId, hits); return true; }
  hits.push(now);
  researchCalls.set(userId, hits);
  return false;
}

const MAX_RESEARCH_ZIPS = 5;
app.post('/api/analyze-permits', requireRole('admin', 'client'), async (req, res) => {
  // The UI hides research from sector leaders — the role gate enforces it.
  const { sheetText } = req.body || {};
  const zipsIn = req.body?.zips;
  if (!sheetText && (!Array.isArray(zipsIn) || !zipsIn.length)) return res.status(400).json({ error: 'Provide sheetText or zips[]' });
  if (Array.isArray(zipsIn) && zipsIn.length > MAX_RESEARCH_ZIPS)
    return res.status(400).json({ error: `At most ${MAX_RESEARCH_ZIPS} areas per research request` });
  if (sheetText != null && (typeof sheetText !== 'string' || sheetText.length > 20000))
    return res.status(400).json({ error: 'sheetText must be text of at most 20,000 characters' });
  // Only the fields the prompt uses, as short strings.
  const zips = Array.isArray(zipsIn) ? zipsIn.map(z => ({
    zip: String(z?.zip ?? '').slice(0, 12),
    municipality: String(z?.municipality ?? '').slice(0, 80),
    primary_city: String(z?.primary_city ?? '').slice(0, 80),
    county: String(z?.county ?? '').slice(0, 80),
    state: String(z?.state ?? '').slice(0, 40),
  })).filter(z => isAreaId(z.zip)) : [];
  if (!sheetText && !zips.length) return res.status(400).json({ error: 'No valid areas in zips[]' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set on server' });
  if (researchRateLimited(req.user?.id || 'anon'))
    return res.status(429).json({ error: 'Too many research requests — try again in a few minutes' });
  if (!takeAiBudget()) return res.status(429).json({ error: "Today's AI allowance for this board is used up — try again tomorrow" });
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic.default({ apiKey });
    if (zips?.length) {
      try {
        return res.json({ results: await researchZipsWithServerSearch(client, zips) });
      } catch (e) {
        console.warn('[research] server-side web search failed — falling back:', e.message);
        if (process.env.BRAVE_SEARCH_API_KEY) {
          return res.json({ results: await researchZipsWithSearch(client, zips) });
        }
      }
    }
    const prompt = `You are a permit compliance researcher for door-to-door canvassing in ${RESEARCH_REGION}.\n\nFor each ZIP below, return permit requirements based on what you know:\n${sheetText || JSON.stringify(zips)}\n\nReturn a JSON array. Each entry:\n{ "zip":"string", "status":"GREEN"|"YELLOW"|"RED", "summary":"string", "permit_process":"string", "authority":"string", "hours":"string", "days_restricted":"string", "other_restrictions":"string", "ordinance_ref":"string" }\n\nGREEN = no permit. YELLOW = permit required. RED = banned. Return ONLY the JSON array.`;
    const message = await client.messages.create({ model:AI_MODEL, max_tokens:8192, messages:[{ role:'user', content:prompt }] });
    if (message.stop_reason === 'refusal') return res.status(422).json({ error: 'The AI declined this request' });
    const text = message.content.find(c => c.type === 'text')?.text || '[]';
    res.json({ results: JSON.parse(extractJsonArray(text)) });
  } catch(err) {
    sec.sendError(res, err, 'analyze-permits');
  }
});

// ── AI territory import parsing ────────────────────────────────────────────────
// Extracts structured Add-Territories fields from a messy spreadsheet. Uses
// Haiku 4.5 — cheap/fast, well-suited to bounded structured extraction.
const HUB_PROMPT_LIST = settings.hubs.length
  ? settings.hubs.map(h => `"${h.key}" (${[h.label, ...(h.aliases || [])].join(' / ')})`).join(', ')
  : '(no hubs are configured — always use an empty string)';
const PARSE_TERRITORIES_SYSTEM = `You extract door-to-door canvassing territory assignments into a clean, structured JSON array. The input may be spreadsheet rows, pasted text, a JSON export, a PDF, or a photo/screenshot of a schedule (printed or handwritten) — read whatever is provided.

Each output entry corresponds to one ZIP code to add to the pipeline. Map whatever columns exist to these fields:

- "zip": the territory id as a string — a 5-digit US ZIP code or a UK postcode sector such as "SW1A 1" (required — skip any row without one)
- "delivery_day": the weekday the territory is serviced, normalized to a 3-letter lowercase key: one of "mon","tue","wed","thu","fri","sat","sun". Accept full names, abbreviations, or a weekday number (1=Monday…7=Sunday). Empty string if not present.
- "hub": the distribution hub / depot servicing the ZIP, normalized to one of these keys: ${HUB_PROMPT_LIST}. Accept spelling variants of the hub names. Empty string if not present or not one of those.
- "work_date": the date to start working the ZIP, as "YYYY-MM-DD". Empty string if not present.
- "sales_target": the numeric sales/appointment target, digits only as a string. Empty string if not present.
- "blocked_by": a territory id (same format as "zip") that must be completed before this one ("complete first" / "prerequisite" / "after"). Empty string if not present.
- "notes": any free-text note or comment for the ZIP. Empty string if not present.

Return ONLY a JSON array of objects with exactly those keys. No preamble, no markdown, no explanation. If a field is unknown, use an empty string (do not invent values).`;

const PARSE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// About 10 MB of file once base64-encoded (the request body itself is capped at 15 MB).
const MAX_PARSE_B64 = 14_000_000;
const MAX_PARSE_TEXT = 40000;
app.post('/api/parse-territories', requireRole('admin', 'client'), async (req, res) => {
  const { rows, text, image, pdf } = req.body || {};
  const hasRows = Array.isArray(rows) && rows.length;
  if (!hasRows && !text && !image?.data && !pdf)
    return res.status(400).json({ error: 'Provide rows[], text, image, or pdf' });
  if ((image?.data && String(image.data).length > MAX_PARSE_B64) || (pdf && String(pdf).length > MAX_PARSE_B64))
    return res.status(413).json({ error: 'File too large — keep photos and PDFs under 10 MB' });
  // Rows and pasted text go to the model as one text block; both share the
  // same 40,000-character ceiling.
  const rowsText = hasRows ? JSON.stringify(rows.slice(0, 300)) : '';
  if (rowsText.length > MAX_PARSE_TEXT)
    return res.status(413).json({ error: 'Too much data — send at most 300 rows and 40,000 characters at a time' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set on server' });
  const lim = parseByUser.hit(req.user.id);
  if (lim.limited) return sec.tooMany(res, lim.retryAfter, 'Too many imports read by AI — try again in a few minutes');
  if (!takeAiBudget()) return res.status(429).json({ error: "Today's AI allowance for this board is used up — try again tomorrow" });
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic.default({ apiKey });
    // Build the user content from whichever input arrived: photo, PDF, or text/rows
    const content = [];
    if (image?.data) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: PARSE_IMAGE_TYPES.has(image.media_type) ? image.media_type : 'image/jpeg',
          data: String(image.data),
        },
      });
      content.push({ type: 'text', text: 'Extract territory assignments from this image of a schedule/spreadsheet.' });
    } else if (pdf) {
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: String(pdf) },
      });
      content.push({ type: 'text', text: 'Extract territory assignments from this document.' });
    } else {
      const payload = hasRows ? rowsText : String(text).slice(0, MAX_PARSE_TEXT);
      content.push({ type: 'text', text: `Extract territory assignments from this data:\n${payload}` });
    }
    const message = await client.messages.create({
      model: AI_MODEL,
      max_tokens: 8192,
      system: PARSE_TERRITORIES_SYSTEM,
      messages: [{ role: 'user', content }],
    });
    if (message.stop_reason === 'refusal') return res.status(422).json({ error: 'The AI declined to read this file' });
    const out = message.content.find(c => c.type === 'text')?.text || '[]';
    res.json({ rows: JSON.parse(extractJsonArray(out)) });
  } catch(err) {
    sec.sendError(res, err, 'parse-territories');
  }
});

// ── Sales data ────────────────────────────────────────────────────────────────
// One row per sale, from either source (first one configured wins):
//   SALES_SHEET_ID (+ SALES_SHEET_GID, GOOGLE_SHEETS_CREDENTIALS) — a Google
//     Sheet read with a service account that has view access to it
//   SALES_CSV_URL  — any CSV over HTTPS (e.g. a sheet "published to the web")
//   SALES_CSV_FILE — a CSV on disk (samples/sales.sample.csv for a local try)
// Columns are matched by header, case-insensitively: a ZIP/postcode column
// (preferring one whose header also says "out", else "zip"/"postcode"), a
// date column (date / signed / signup / install), and optionally
// latitude/longitude (per-sale map pins), badge or code, cancel(led), and
// delivery 1–4.
const SALES_SHEET_ID  = process.env.SALES_SHEET_ID || '';
const SALES_SHEET_GID = process.env.SALES_SHEET_GID ? +process.env.SALES_SHEET_GID : null;
const SALES_CSV_URL   = process.env.SALES_CSV_URL || '';
const SALES_CSV_FILE  = process.env.SALES_CSV_FILE || '';
const SALES_ENABLED   = !!((SALES_SHEET_ID && process.env.GOOGLE_SHEETS_CREDENTIALS) || SALES_CSV_URL || SALES_CSV_FILE);
const [PIN_MIN_LAT, PIN_MIN_LNG, PIN_MAX_LAT, PIN_MAX_LNG] = settings.sales.pinBounds || [-90, -180, 90, 180];
let salesCache = { data:{}, datesByZip:{}, strongWeekByZip:{}, pins:[], lastUpdated:null, error:null };

async function fetchSalesRows() {
  if (SALES_SHEET_ID) {
    const credsRaw = process.env.GOOGLE_SHEETS_CREDENTIALS;
    if (!credsRaw) throw new Error('SALES_SHEET_ID is set but GOOGLE_SHEETS_CREDENTIALS is not');
    const { google } = require('googleapis');
    const credentials = typeof credsRaw === 'string' ? JSON.parse(credsRaw) : credsRaw;
    const auth = new google.auth.GoogleAuth({ credentials, scopes:['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const sheets = google.sheets({ version:'v4', auth });
    const meta = await sheets.spreadsheets.get({ spreadsheetId:SALES_SHEET_ID });
    const sheet = SALES_SHEET_GID != null
      ? meta.data.sheets.find(s => s.properties.sheetId === SALES_SHEET_GID)
      : meta.data.sheets[0];
    const sheetName = sheet?.properties?.title || 'Sheet1';
    // Read well past the usual layout so appended latitude/longitude columns
    // are actually fetched — with A:Z they can fall outside the range.
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId:SALES_SHEET_ID, range:`${sheetName}!A:BZ` });
    return resp.data.values || [];
  }
  const { parseCsv } = require('./scripts/lib/csv');
  if (SALES_CSV_URL) {
    const r = await fetch(SALES_CSV_URL, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`SALES_CSV_URL HTTP ${r.status}`);
    return parseCsv(await r.text());
  }
  if (SALES_CSV_FILE) return parseCsv(await require('fs/promises').readFile(path.resolve(SALES_CSV_FILE), 'utf8'));
  throw new Error('No sales source configured (SALES_SHEET_ID, SALES_CSV_URL or SALES_CSV_FILE)');
}

async function fetchSalesByZip() {
  const rows = await fetchSalesRows();
  if (rows.length < 2) return { counts:{}, datesByZip:{}, pins:[] };
  const headers = rows[0].map(h => String(h).toLowerCase().trim());
  let zipCol = headers.findIndex(h => /zip|postcode|postal/.test(h) && h.includes('out'));
  if (zipCol < 0) zipCol = headers.findIndex(h => /zip|postcode|postal|sector/.test(h));
  if (zipCol < 0) throw new Error('Sales source has no ZIP / postcode column');
  let dateCol = headers.findIndex(h => /date|signed|signup|install/.test(h));
  if (dateCol < 0) dateCol = 0;

  // Per-sale map pins — header matching is fuzzy so pins activate as soon as
  // latitude/longitude columns appear
  const latCol    = headers.findIndex(h => /\blat(itude)?\b/.test(h));
  const lngCol    = headers.findIndex(h => /\b(lng|lon|long|longitude)\b/.test(h));
  const badgeCol  = headers.findIndex(h => /badge/.test(h) || (/discount|code/.test(h) && !/zip|post/.test(h)));
  const cancelCol = headers.findIndex(h => /cancel/.test(h));
  const delivCols = headers.map((h, i) => ({ h, i })).filter(x => /deliv/.test(x.h));
  const d1Col = delivCols.find(x => /1|first/.test(x.h))?.i  ?? -1;
  const d2Col = delivCols.find(x => /2|second/.test(x.h))?.i ?? -1;
  const d3Col = delivCols.find(x => /3|third/.test(x.h))?.i  ?? -1;
  const d4Col = delivCols.find(x => /4|fourth/.test(x.h))?.i ?? -1;

  const cell = (row, col) => col >= 0 ? String(row[col] ?? '').trim() : '';
  const counts = {}, datesByZip = {}, pins = [];
  for (let i = 1; i < rows.length; i++) {
    const rawZip = String(rows[i][zipCol] || '').trim();
    if (!rawZip) continue;
    const zip = normalizeAreaId(rawZip);
    if (!zip) continue;
    counts[zip] = (counts[zip] || 0) + 1;
    const rawDate = String(rows[i][dateCol] || '').trim();
    if (rawDate) { if (!datesByZip[zip]) datesByZip[zip] = []; datesByZip[zip].push(rawDate); }

    if (latCol >= 0 && lngCol >= 0 && pins.length < 25000) {
      const lat = parseFloat(cell(rows[i], latCol));
      const lng = parseFloat(cell(rows[i], lngCol));
      // Sanity window (settings.sales.pinBounds) — skips blanks, header junk, and swapped columns
      if (isFinite(lat) && isFinite(lng) && lat >= PIN_MIN_LAT && lat <= PIN_MAX_LAT && lng >= PIN_MIN_LNG && lng <= PIN_MAX_LNG) {
        pins.push({
          lat, lng, zip,
          date:      rawDate,
          badge:     cell(rows[i], badgeCol),
          d1:        cell(rows[i], d1Col),
          d2:        cell(rows[i], d2Col),
          d3:        cell(rows[i], d3Col),
          d4:        cell(rows[i], d4Col),
          cancelled: cell(rows[i], cancelCol),
        });
      }
    }
  }
  return { counts, datesByZip, pins };
}

function findLastStrongWeek(dates, threshold = 5) {
  if (!dates || dates.length < threshold) return null;
  const ms = dates.map(d => new Date(d).getTime()).filter(t => !isNaN(t)).sort((a,b) => b-a);
  if (ms.length < threshold) return null;
  const week = 7*24*60*60*1000;
  for (let i = 0; i < ms.length; i++) {
    const end = ms[i], start = end - week;
    if (ms.filter(t => t >= start && t <= end).length >= threshold) {
      const endDate = new Date(end);
      const daysToSun = (7 - endDate.getUTCDay()) % 7;
      endDate.setUTCDate(endDate.getUTCDate() + daysToSun);
      return endDate.toISOString().split('T')[0];
    }
  }
  return null;
}

// ── Auto-field hot ZIPs ──────────────────────────────────────────────────────
// 5+ sales inside the trailing 4 weeks means a crew is clearly working the ZIP
// — its pipeline card moves to In Field automatically. One-shot per ZIP (the
// auto_fielded flag): once fired it never fires again, so if someone later
// drags the card elsewhere the automation respects the human move and the
// card stays wherever a person put it.
const AUTO_FIELD_SALES = 5;
const AUTO_FIELD_WINDOW_DAYS = 28;
async function autoFieldHotZips(datesByZip) {
  // Window anchored to the board's calendar day, not the server's UTC clock
  const now = Date.now();
  const windowStart = new Date(etDaysAgo(AUTO_FIELD_WINDOW_DAYS) + 'T00:00:00Z').getTime();
  const hot = Object.entries(datesByZip)
    .filter(([, dates]) => dates
      .map(d => new Date(d).getTime())
      .filter(t => !isNaN(t) && t >= windowStart && t <= now + 24 * 60 * 60 * 1000)
      .length >= AUTO_FIELD_SALES)
    .map(([zip]) => zip);
  const sample = Object.values(datesByZip)[0]?.slice(0, 3);
  console.log(`[auto-field] ${hot.length} hot of ${Object.keys(datesByZip).length} ZIPs with dates · sample dates: ${JSON.stringify(sample)}`);
  if (!hot.length) return;
  const docs = await Edit.find({ zip: { $in: hot } }).lean();
  let moved = 0; const movedZips = [];
  for (const doc of docs) {
    if (!doc.pipeline_stage || ['active', 'completed'].includes(doc.pipeline_stage) || doc.auto_fielded) continue;
    await Edit.updateOne({ zip: doc.zip }, { $set: { pipeline_stage: 'active', auto_fielded: true } });
    moved++; movedZips.push(doc.zip);
  }
  if (moved) { console.log(`[auto-field] moved ${moved} hot ZIP(s) to In Field`); refreshEditsFor(movedZips).catch(() => {}); }
}

// One refresh at a time: when the cache goes stale on a busy morning, every
// concurrent /api/sales-by-zip hit used to launch its own sheet fetch + full pin
// parse. They all await the same in-flight run now.
let salesRefreshInFlight = null;
// autoField=false refills the RAM cache but skips the ZIP auto-fielding write.
// A demo account may see fresh numbers; it may not move a ZIP into the active
// pipeline. The next real refresh does the fielding, so nothing is lost.
function refreshSalesCache(autoField = true) {
  if (!salesRefreshInFlight)
    salesRefreshInFlight = _refreshSalesCache(autoField).finally(() => { salesRefreshInFlight = null; });
  return salesRefreshInFlight;
}

async function _refreshSalesCache(autoField = true) {
  try {
    const { counts, datesByZip, pins } = await fetchSalesByZip();
    const strongWeekByZip = {};
    for (const [zip, dates] of Object.entries(datesByZip)) {
      const sw = findLastStrongWeek(dates);
      if (sw) strongWeekByZip[zip] = sw;
    }
    salesCache = { data:counts, datesByZip, strongWeekByZip, pins: pins || [], lastUpdated:new Date().toISOString(), error:null };
    console.log(`Sales cache: ${Object.keys(counts).length} ZIPs with sales · ${(pins||[]).length} geo pins`);
    if (autoField) {
      try { await autoFieldHotZips(datesByZip); }
      catch (e) { console.error('[auto-field]', e.message); }
    }
  } catch(err) {
    console.error('Sales cache refresh failed:', err.message);
    // The browser gets a plain notice; the detail (a file path, an HTTP body)
    // stays in the server log.
    salesCache.error = 'Sales source could not be read — the server log has the details';
  }
}

// Wall-clock time in the board's timezone (settings.timezone).
function boardClock() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', hour12:false,
  }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t).value;
  let hh = get('hour'); if (hh === '24') hh = '00';  // Intl emits "24" at midnight in some runtimes
  const mm = get('minute');
  return { h:parseInt(hh,10), m:parseInt(mm,10), hm:`${hh}:${mm}`, dateKey:`${get('year')}-${get('month')}-${get('day')}` };
}

app.get('/api/sales-by-zip', async (req, res) => {
  if (!SALES_ENABLED) return res.json({ data:{}, datesByZip:{}, strongWeekByZip:{}, pins:[], lastUpdated:null, error:null, disabled:true });
  const stale = !salesCache.lastUpdated || (Date.now()-new Date(salesCache.lastUpdated).getTime()) > 60*60*1000;
  // A forced re-read (?refresh=1) is for people who can act on fresh numbers,
  // a few times per five minutes each; demo accounts just get the cache.
  let force = req.query.refresh === '1' && !req.user?.demo;
  if (force && salesRefreshByUser.hit(req.user.id).limited) force = false;
  if (stale || force) await refreshSalesCache(!req.user?.demo);
  // datesByZip drives the hub day-balance panel — it needs per-sale dates to
  // count only the sales inside the current cycle, not the all-time total.
  res.json({ data:salesCache.data, datesByZip:salesCache.datesByZip, strongWeekByZip:salesCache.strongWeekByZip, pins:salesCache.pins, lastUpdated:salesCache.lastUpdated, error:salesCache.error });
});

// ── Hub delivery-day goals ───────────────────────────────────────────────────
// A client can cap sales per delivery day per hub and rotate once a day fills
// (e.g. "N sales on each delivery day, then rotate back through"). Unlike
// prefs these are org-wide — everyone works to the same cap — so they live in
// their own collection rather than per user.
const DAY_KEYS = new Set(['mon','tue','wed','thu','fri','sat','sun']);
const HubGoal = mongoose.model('HubGoal',
  new mongoose.Schema({
    hub:        { type: String, required: true, unique: true },
    cap:        { type: Number, default: 50 },   // keep in step with DEFAULT_HUB_CAP in app.js
    cycleStart: { type: String, default: '' },   // YYYY-MM-DD; sales before this don't count
    cycle:      { type: Number, default: 1 },    // increments each rotation, for the header
    // Per-delivery-day targets, e.g. { mon: 12, tue: 10 } — a client may send
    // different targets per day. A day without one falls back to the flat cap.
    // 0 is a real target, not "unset": it means the client wants no sales on
    // that day this cycle (a day paused for the month), so the board stops offering
    // it as work next instead of reading it as instantly capped.
    caps:       { type: mongoose.Schema.Types.Mixed, default: {} },
    // Targets booked for a FUTURE cycle, keyed by cycle number:
    // { "2": { mon: 8, tue: 6, wed: 0, thu: 6, fri: 0 } }. A client may plan
    // in phases and send several sets at once; without
    // this, rotation carried the old numbers over and someone had to remember
    // to retype the next phase. A rotation into a planned cycle applies its
    // targets and consumes the entry.
    plan:       { type: mongoose.Schema.Types.Mixed, default: {} },
    // Closed cycle windows, oldest first. `end` is the next cycle's start
    // (exclusive); start '' = everything before `end`. Pushed automatically on
    // rotation — without this, starting a new cycle discarded where the old one
    // began and its numbers became unviewable. cap/caps snapshot what the cycle
    // ran under, so next month's quotas don't rewrite last month's board.
    history:    { type: [new mongoose.Schema({
      cycle: Number, start: String, end: String, cap: Number, caps: mongoose.Schema.Types.Mixed,
    }, { _id: false })], default: [] },
    updatedAt:  { type: Date,   default: Date.now },
    updatedBy:  { type: String, default: '' },
  })
);

app.get('/api/hub-goals', async (req, res) => {
  try { res.json({ goals: await HubGoal.find({}).lean() }); }
  catch (e) { sec.sendError(res, e, 'api'); }
});

app.post('/api/hub-goals', requireRole('admin','client'), async (req, res) => {
  try {
    const { hub, cap, caps, cycleStart, cycle, plan } = req.body || {};
    if (!hub || typeof hub !== 'string') return res.status(400).json({ error: 'hub required' });
    // Only hubs this board is configured with (config/territory.json → hubs).
    if (!(settings.hubKeys || []).includes(hub)) return res.status(400).json({ error: 'unknown hub' });
    const $set = { hub, updatedAt: new Date(), updatedBy: req.user?.name || '' };
    if (cap != null) {
      const n = parseInt(cap, 10);
      if (!isFinite(n) || n < 1 || n > 100000) return res.status(400).json({ error: 'cap must be 1–100000' });
      $set.cap = n;
    }
    // A day map: { mon: 12, … }. 0 is allowed and means "no sales wanted here";
    // null/'' clears the day back to the flat cap. Shared by `caps` and by each
    // cycle in `plan`, so a booked phase can't hold a number the live strip would refuse.
    const cleanCaps = (obj, label) => {
      if (typeof obj !== 'object' || obj === null || Array.isArray(obj))
        throw new Error(`${label} must be an object`);
      const clean = {};
      for (const [day, v] of Object.entries(obj)) {
        if (!DAY_KEYS.has(day)) throw new Error(`unknown day "${day}" in ${label}`);
        if (v === null || v === '') continue;   // cleared → back to the flat cap
        const n = parseInt(v, 10);
        if (!isFinite(n) || n < 0 || n > 100000) throw new Error(`${label} ${day} target must be 0–100000`);
        clean[day] = n;
      }
      return clean;
    };
    try {
      if (caps != null) $set.caps = cleanCaps(caps, 'caps');
      if (plan != null) {
        if (typeof plan !== 'object' || Array.isArray(plan)) return res.status(400).json({ error: 'plan must be an object' });
        const cleanPlan = {};
        for (const [k, v] of Object.entries(plan)) {
          const c = parseInt(k, 10);
          if (!isFinite(c) || c < 1 || String(c) !== String(k).trim())
            return res.status(400).json({ error: `plan key "${k}" must be a cycle number` });
          if (v === null) continue;             // cleared → that cycle is unbooked
          const days = cleanCaps(v, `plan.${c}`);
          if (Object.keys(days).length) cleanPlan[c] = days;
        }
        $set.plan = cleanPlan;
      }
    } catch (e) { return res.status(400).json({ error: e.message }); }
    if (cycleStart != null) {
      if (cycleStart !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(cycleStart))
        return res.status(400).json({ error: 'cycleStart must be YYYY-MM-DD' });
      $set.cycleStart = cycleStart;
    }
    if (cycle != null) {
      const n = parseInt(cycle, 10);
      if (isFinite(n) && n > 0) $set.cycle = n;
    }
    const update = { $set };
    // A cycle bump is a rotation: archive the outgoing window before its start
    // date is overwritten. One entry per cycle number, so a replayed save can't
    // double-push.
    const prev = await HubGoal.findOne({ hub }).lean();
    const prevCycle = prev?.cycle || 1;
    if ($set.cycle != null && prev && $set.cycle > prevCycle
        && !(prev.history || []).some(h => h.cycle === prevCycle)) {
      update.$push = { history: {
        cycle: prevCycle,
        start: prev.cycleStart || '',
        end:   $set.cycleStart || boardClock().dateKey,
        cap:   prev.cap ?? 50,
        caps:  prev.caps || {},
      } };
      // Rotating into a cycle the client already planned: adopt its targets and
      // consume the booking, so the next phase lands without anyone retyping it.
      // An explicit `caps` in the same request still wins — the operator typing
      // numbers is more current than a booking made weeks ago.
      const plans = $set.plan ?? prev.plan ?? {};   // a plan sent in this same request wins
      const booked = plans[String($set.cycle)];
      if (booked && $set.caps == null) {
        $set.caps = booked;
        $set.plan = Object.fromEntries(
          Object.entries(plans).filter(([k]) => k !== String($set.cycle)));
      }
    }
    await HubGoal.updateOne({ hub }, update, { upsert: true });
    res.json({ ok: true, goal: await HubGoal.findOne({ hub }).lean() });
  } catch (e) { sec.sendError(res, e, 'api'); }
});

// ── Scheduled delivery-day moves ─────────────────────────────────────────────
// A client can re-route ZIPs between delivery days on a set date ("these two
// move Thu → Tue on the 18th — don't work them until then"). Stored on the ZIP
// as day_change = { to, on }; the board shows a hold chip until `on`, and this
// tick flips delivery_day and clears the hold once that date arrives (board timezone).
let lastDayChangeRun = '';
async function applyDueDayChanges(){
  const { dateKey } = boardClock();
  const due = await Edit.find({ 'day_change.on': { $lte: dateKey } }).lean();
  for (const e of due) {
    const to = e.day_change?.to;
    const update = DAY_KEYS.has(to)
      ? { $set: { delivery_day: to }, $unset: { day_change: '' } }
      : { $unset: { day_change: '' } };   // malformed — drop it rather than retry forever
    await Edit.updateOne({ zip: e.zip }, update);
    await refreshEditsFor([e.zip]).catch(() => {});
    console.log(`Delivery-day move applied: ${e.zip} → ${to} (scheduled ${e.day_change?.on})`);
  }
}
setInterval(() => {
  const { dateKey } = boardClock();
  if (dateKey === lastDayChangeRun) return;
  lastDayChangeRun = dateKey;
  applyDueDayChanges().catch(err => { lastDayChangeRun = ''; console.error('Day-change tick failed:', err.message); });
}, 60*1000);

if (SALES_ENABLED) {
  refreshSalesCache().catch(()=>{});
  // If the sales source is itself filled by a morning job, read a few minutes
  // AFTER it lands, with a backup mark in case it runs late or a tick is
  // missed (settings.sales.refreshTimes). Each mark fires at most once a day.
  const MORNING_REFRESH_MARKS = settings.sales.refreshTimes || [];
  let lastMorningRefresh = '';  // "YYYY-MM-DD HH:MM" of the mark we last ran
  setInterval(() => {
    const { hm, dateKey } = boardClock();
    const key = `${dateKey} ${hm}`;
    if (MORNING_REFRESH_MARKS.includes(hm) && lastMorningRefresh !== key) {
      lastMorningRefresh = key;
      console.log(`Scheduled ${hm} sales refresh`);
      refreshSalesCache().catch(()=>{});
    }
  }, 30*1000);  // 30s tick so a minute mark is never skipped by timer drift
}

// ── Coverage knocks ───────────────────────────────────────────────────────────
// ── RAM stores for the two bulk collections ──────────────────────────────────
// Shared database tiers (e.g. Atlas M0/Flex) throttle bulk reads hard once the
// data-transfer allowance is burned — a full stroke read can take over a minute PER REQUEST.
// Strokes and door pins therefore live in server memory: warmed in the
// background with partitioned parallel cursors (the throttle punishes each
// round-trip, so few big parallel batches beat many small ones), refreshed
// stale-while-revalidate, and mutated in place on writes. Clients read RAM.
const knocksStore = { docs: null, at: 0, warming: null };
function warmKnocksStore() {
  if (knocksStore.warming) return knocksStore.warming;
  knocksStore.warming = (async () => {
    const t0 = Date.now();
    const cutoff = etDaysAgo(84);
    const q = { date: { $gte: cutoff } };
    const total = await Knock.countDocuments(q);
    const PART = 8, per = Math.ceil(total / PART) || 1;
    const parts = await Promise.all([...Array(PART)].map((_, i) =>
      Knock.find(q).sort({ _id: 1 }).skip(i * per).limit(per)
        .select('zip latlngs date style userId userName').lean()
        .setOptions({ batchSize: 4000 })));
    const deleted = knocksStore.deleted || new Set();
    knocksStore.docs = parts.flat().filter(k => !deleted.has(String(k._id)));
    knocksStore.deleted = new Set();
    knocksStore.at = Date.now(); knocksStore.rev = (knocksStore.rev || 0) + 1;
    console.log(`[knocks-store] ${knocksStore.docs.length} strokes in ${((Date.now()-t0)/1000).toFixed(1)}s`);
  })().catch(e => console.error('[knocks-store]', e.message))
      .finally(() => { knocksStore.warming = null; });
  return knocksStore.warming;
}

const doorStore = { docs: null, pending: null, failed: null, at: 0, warming: null };
function warmDoorStore() {
  if (doorStore.warming) return doorStore.warming;
  doorStore.warming = (async () => {
    const t0 = Date.now();
    const pinnable = { lat: { $ne: null }, posSuspect: { $ne: true } };
    const total = await WorkedDoor.countDocuments(pinnable);
    const PART = 10, per = Math.ceil(total / PART) || 1;
    const parts = await Promise.all([...Array(PART)].map((_, i) =>
      WorkedDoor.find(pinnable).sort({ _id: 1 }).skip(i * per).limit(per)
        .select('date lat lng zip outcome baName address city office tsEpoch sectorName')
        .lean().setOptions({ batchSize: 8000 })));
    // pending/failed only need their dates — the endpoint just counts them
    const [pending, failed] = await Promise.all([
      WorkedDoor.find({ lat: null, geoFailed: false }).select('date').lean().setOptions({ batchSize: 8000 }),
      WorkedDoor.find({ $or: [{ geoFailed: true }, { posSuspect: true }] }).select('date').lean().setOptions({ batchSize: 8000 }),
    ]);
    doorStore.docs = parts.flat();
    doorStore.pending = pending.map(d => d.date);
    doorStore.failed = failed.map(d => d.date);
    doorStore.at = Date.now(); doorStore.rev = (doorStore.rev || 0) + 1;
    console.log(`[door-store] ${doorStore.docs.length} doors in ${((Date.now()-t0)/1000).toFixed(1)}s`);
  })().catch(e => console.error('[door-store]', e.message))
      .finally(() => { doorStore.warming = null; });
  return doorStore.warming;
}

// Doors synced or geocoded in the last day and a half, merged in place —
// the geocoder places pins minutes after the field app pushes them, so a small
// recent window keeps the store current without a full re-read.
async function refreshDoorStoreRecent() {
  if (!doorStore.docs || doorStore.refreshing) return;
  doorStore.refreshing = true;
  try {
    const since = new Date(Date.now() - 36 * 3600 * 1000);
    const fresh = await WorkedDoor.find({ lat: { $ne: null }, posSuspect: { $ne: true }, syncedAt: { $gte: since } })
      .select('date lat lng zip outcome baName address city office tsEpoch sectorName').lean();
    const idx = new Map();
    doorStore.docs.forEach((d, i) => idx.set(String(d._id), i));
    let changed = 0;
    for (const d of fresh) {
      const i = idx.get(String(d._id));
      if (i == null) { doorStore.docs.push(d); changed++; }
      else if (doorStore.docs[i].lat !== d.lat || doorStore.docs[i].lng !== d.lng || doorStore.docs[i].outcome !== d.outcome || doorStore.docs[i].zip !== d.zip) { doorStore.docs[i] = d; changed++; }
    }
    // Pins the geocoder or the sector-majority pass has since flagged as
    // failed or misplaced leave the map now, not at the next full re-read.
    const [pending, failed] = await Promise.all([
      WorkedDoor.find({ lat: null, geoFailed: false }).select('date').lean(),
      WorkedDoor.find({ $or: [{ geoFailed: true }, { posSuspect: true }] }).select('date').lean(),
    ]);
    const failedIds = new Set(failed.map(d => String(d._id)));
    const before = doorStore.docs.length;
    if (failedIds.size) doorStore.docs = doorStore.docs.filter(d => !failedIds.has(String(d._id)));
    if (before !== doorStore.docs.length) changed++;
    doorStore.pending = pending.map(d => d.date);
    doorStore.failed = failed.map(d => d.date);
    if (changed) { doorStore.at = Date.now(); doorStore.rev = (doorStore.rev || 0) + 1; }
  } catch (e) { console.error('[door-store] refresh', e.message); }
  finally { doorStore.refreshing = false; }
}

app.get('/api/knocks', async (req, res) => {
  try {
    if (!knocksStore.docs) {
      warmKnocksStore();   // fire and forget — client retries while we warm
      return res.json({ knocks: [], warming: true });
    }
    const etag = `"k${BOOT}-${knocksStore.rev || 0}"`;
    res.set('ETag', etag);
    res.set('Cache-Control', 'private, no-cache');
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    const cutoff = etDaysAgo(84);
    // isDate: a stroke stored before dates were validated never reaches a page.
    res.json({ knocks: knocksStore.docs.filter(k => k.date >= cutoff && sec.isDate(k.date)) });
  } catch(e) { sec.sendError(res, e, 'api'); }
});

// New strokes since the last one we hold, plus the 84-day expiry — instead of
// re-reading every stroke every ten minutes.
async function refreshKnocksRecent() {
  if (!knocksStore.docs || knocksStore.refreshing) return;
  knocksStore.refreshing = true;
  try {
    let last = '';
    for (const k of knocksStore.docs) { const id = String(k._id); if (id > last) last = id; }
    const q = last ? { _id: { $gt: new mongoose.Types.ObjectId(last) } } : { date: { $gte: etDaysAgo(84) } };
    const fresh = await Knock.find(q).select('zip latlngs date style userId userName').lean();
    const have = new Set(knocksStore.docs.map(k => String(k._id)));
    let added = 0;
    for (const k of fresh) if (!have.has(String(k._id))) { knocksStore.docs.push(k); added++; }
    const cutoff = etDaysAgo(84);
    const before = knocksStore.docs.length;
    knocksStore.docs = knocksStore.docs.filter(k => k.date >= cutoff);
    if (added || before !== knocksStore.docs.length) { knocksStore.at = Date.now(); knocksStore.rev = (knocksStore.rev || 0) + 1; }
  } catch (e) { console.error('[knocks-store] refresh', e.message); }
  finally { knocksStore.refreshing = false; }
}

// Freehand strokes don't need sub-metre precision: 5 decimals ≈ 1.1m, and the
// full 17-digit doubles were the bulk of the coverage payload (the whole
// stroke set ships to every client at boot). Consecutive points that collapse
// to the same rounded spot are dropped too — dense finger-drags dedupe hard.
function roundStroke(latlngs){
  const r5 = v => Math.round(v * 1e5) / 1e5;
  const out = [];
  for (const p of latlngs || []) {
    const lat = r5(Array.isArray(p) ? p[0] : p?.lat);
    const lng = r5(Array.isArray(p) ? p[1] : p?.lng);
    if (!isFinite(lat) || !isFinite(lng)) continue;
    const prev = out[out.length - 1];
    if (prev && prev[0] === lat && prev[1] === lng) continue;
    out.push([lat, lng]);
  }
  return out;
}

app.post('/api/knocks', async (req, res) => {
  try {
    // Date strictly YYYY-MM-DD, at most 5000 points, style from a short
    // allow-list (lib/security.js): every stroke ships to every client at boot
    // and its date is shown in a popup.
    const v = sec.sanitizeKnock(req.body, { isAreaId, round: roundStroke });
    if (v.error) return res.status(400).json({ error: v.error });
    const { zip, latlngs: pts, date, style } = v.value;
    const doc = await Knock.create({
      zip, latlngs: pts, date, style,
      userId:   req.user?.id   || null,
      userName: req.user?.name || null,
    });
    // Keep the RAM store current — a fresh stroke must show without a rewarm
    knocksStore.rev = (knocksStore.rev || 0) + 1;
    if (knocksStore.docs) knocksStore.docs.push({
      _id: doc._id, zip: doc.zip, latlngs: doc.latlngs, date: doc.date,
      style: doc.style, userId: doc.userId, userName: doc.userName,
    });
    res.json({ ok:true, id:doc._id });
  } catch(e) { sec.sendError(res, e, 'api'); }
});

// ── Worked doors (auto-synced from the field app) ────────────────────────────
// Visible to every logged-in role. Sector leaders still mark coverage manually
// (and still get nagged) — the auto pins are informational, not a replacement.
app.get('/api/worked-doors', requireAuth, async (req, res) => {
  try {
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : etDaysAgo(6);
    const to   = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)   ? req.query.to   : etToday();

    if (!doorStore.docs) {
      warmDoorStore();   // fire and forget — client retries while we warm
      return res.json({ from, to, doors: [], total: 0, warming: true, pendingGeocode: 0, failedGeocode: 0 });
    }
    const etag = `"d${BOOT}-${doorStore.rev || 0}-${from}-${to}"`;
    res.set('ETag', etag);
    res.set('Cache-Control', 'private, no-cache');
    if (req.headers['if-none-match'] === etag) return res.status(304).end();

    const inWin = d => d >= from && d <= to;
    const doors = doorStore.docs.filter(d => inWin(d.date));
    const pending = doorStore.pending.reduce((n, d) => n + (inWin(d) ? 1 : 0), 0);
    const failed  = doorStore.failed.reduce((n, d) => n + (inWin(d) ? 1 : 0), 0);

    // Every pin is a real door at its exact coordinates — no grouping, ever.
    // But past 40k doors the full records are tens of MB of JSON (that's what
    // OOM-crashed the server): huge windows ship slim pins (position +
    // outcome), so they stay exact — the tap card just loses address detail.
    const SLIM_THRESHOLD = 40000;
    const slim = doors.length > SLIM_THRESHOLD;
    res.json({
      from, to, total: doors.length, slim,
      doors: slim ? doors.map(d => ({ lat: d.lat, lng: d.lng, outcome: d.outcome })) : doors,
      pendingGeocode: pending, failedGeocode: failed,
    });
  } catch (e) { sec.sendError(res, e, 'api'); }
});

// Full record for one slim pin, looked up by its exact coordinates. Slim doors
// ship the same lat/lng doubles as the full docs (JSON round-trips them
// losslessly), so an exact-ish match against the RAM store finds the doc. Two
// knocks at the same spot resolve to the most recent one in the window.
app.get('/api/worked-doors/detail', requireAuth, async (req, res) => {
  try {
    const lat = +req.query.lat, lng = +req.query.lng;
    if (!isFinite(lat) || !isFinite(lng)) return res.status(400).json({ error: 'lat and lng required' });
    if (!doorStore.docs) { warmDoorStore(); return res.json({ warming: true }); }
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : null;
    const to   = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)   ? req.query.to   : null;
    const EPS = 1e-5;   // ≈1 m — well under the gap between two distinct doors
    let best = null;
    for (const d of doorStore.docs) {
      if (Math.abs(d.lat - lat) > EPS || Math.abs(d.lng - lng) > EPS) continue;
      if (from && d.date < from) continue;
      if (to && d.date > to) continue;
      if (!best || (d.tsEpoch || 0) > (best.tsEpoch || 0)) best = d;
    }
    if (!best) return res.status(404).json({ error: 'No door at that spot' });
    res.json({ door: best });
  } catch (e) { sec.sendError(res, e, 'api'); }
});

// ── Manual door sync (topbar "↻ Sync doors" button) ──────────────────────────
// Asks the field app to push its latest doors now (e.g. today + yesterday)
// instead of waiting for its own schedule, then rewarms the RAM store so the
// fresh pins show on the next fetch. Optional: set FIELD_APP_SYNC_URL to an
// endpoint on your field app that accepts
//   POST  (header x-service-token: FIELD_APP_TOKEN)
// pushes its doors to /api/integrations/worked-doors before it answers, and
// replies { days: [{ date, pushed, push_upserted, error? }] }. The same token
// secures both directions of the integration.
const FIELD_APP_SYNC_URL = process.env.FIELD_APP_SYNC_URL || '';
// https anywhere, or plain http only to this computer (local testing).
function syncUrlIsSafe(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.username || u.password) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}
let doorSyncInFlight = null;   // concurrent presses share one round-trip
// Each press makes the field app walk its own vendor, so presses inside two
// minutes of a finished sync get that sync's answer instead of a new one.
const DOOR_SYNC_COOLDOWN_MS = 2 * 60_000;
let doorSyncLast = { at: 0, result: null };
app.post('/api/worked-doors/sync', requireAuth, async (req, res) => {
  // The token unlocks /api/integrations/*, so never send it in clear text.
  if (FIELD_APP_SYNC_URL && !syncUrlIsSafe(FIELD_APP_SYNC_URL))
    return res.status(503).json({ error: 'Door sync disabled — FIELD_APP_SYNC_URL must be an https:// address' });
  if (!FIELD_APP_TOKEN || !FIELD_APP_SYNC_URL)
    return res.status(503).json({ error: 'Door sync disabled — set FIELD_APP_TOKEN and FIELD_APP_SYNC_URL' });
  if (!doorSyncInFlight && doorSyncLast.result && Date.now() - doorSyncLast.at < DOOR_SYNC_COOLDOWN_MS)
    return res.json({ ...doorSyncLast.result, cached: true });
  if (!doorSyncInFlight) {
    doorSyncInFlight = (async () => {
      // A field app walking its own vendor can take a while — allow a few minutes.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 240_000);
      try {
        const r = await fetch(FIELD_APP_SYNC_URL, {
          method: 'POST',
          headers: { 'x-service-token': FIELD_APP_TOKEN },
          signal: ctrl.signal,
        });
        if (!r.ok) {
          console.error(`[door-sync] field app HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
          throw new Error(`Field app answered HTTP ${r.status}`);
        }
        const days = (await r.json())?.days || [];
        // The push already kicked the geocode worker — give it a moment to
        // finish so the fresh pins land placed, not pending, then rewarm.
        for (let i = 0; i < 30 && geoWorkerRunning; i++) await new Promise(t => setTimeout(t, 1000));
        if (doorStore.warming) await doorStore.warming.catch(() => {});
        doorStore.at = 0;
        await warmDoorStore();
        const result = {
          ok: true,
          newDoors: days.reduce((n, d) => n + (+d.push_upserted || 0), 0),
          days: days.slice(0, 31).map(d => ({ date: String(d.date || '').slice(0, 10), pushed: +d.pushed || 0, new: +d.push_upserted || 0,
                                              error: d.error ? String(d.error).slice(0, 200) : undefined })),
        };
        doorSyncLast = { at: Date.now(), result };
        return result;
      } finally { clearTimeout(timer); }
    })().finally(() => { doorSyncInFlight = null; });
  }
  try { res.json(await doorSyncInFlight); }
  catch (e) {
    console.error('[door-sync]', e.message);
    res.status(502).json({ error: /^Field app answered HTTP \d+$/.test(e.message) ? e.message : 'Could not reach the field app' });
  }
});

app.delete('/api/knocks/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error:'Not found' });
    const knock = await Knock.findById(req.params.id);
    if (!knock) return res.status(404).json({ error:'Not found' });
    // Sector leaders can only delete their own strokes (not unattributed ones)
    if (req.user?.role === 'sector_leader' && !(knock.userId && knock.userId === req.user.id))
      return res.status(403).json({ error:'You can only delete your own coverage strokes' });
    await knock.deleteOne();
    (knocksStore.deleted ||= new Set()).add(String(req.params.id));   // survives a full re-read in flight
    knocksStore.rev = (knocksStore.rev || 0) + 1;
    if (knocksStore.docs)
      knocksStore.docs = knocksStore.docs.filter(k => String(k._id) !== String(req.params.id));
    res.json({ ok:true });
  } catch(e) { sec.sendError(res, e, 'api'); }
});

// ── Nightly backup (lib/backup.js) ───────────────────────────────────────────
// Free database tiers keep no backups; this copies every collection to an
// S3-compatible bucket (Cloudflare R2, AWS S3, …) each night when CGT_S3_* is
// set. Restore with scripts/restore-backup.js.
const backup = require('./lib/backup')({
  mongoose, etToday, timezone: TZ,
  notify: e => ADMIN_EMAIL && sendMail(ADMIN_EMAIL, `${APP_NAME} backup failed`,
    `<p>Last night's database backup to R2 failed:</p><pre>${String(e.message).replace(/</g, '&lt;')}</pre>` +
    `<p>It retries every 20 minutes; this mail goes out once a day at most.</p>`),
});
app.get('/api/admin/backups', requireAuth, requireRole('admin'), async (req, res) => {
  try { res.json({ ...await backup.listNights(), status: backup.status }); }
  catch (e) { sec.sendError(res, e, 'api'); }
});

// ── Walking routes (lib/routes_api.js) ───────────────────────────────────────
// Generate pre-planned laps for a team inside a ZIP from OSM streets + houses,
// minus what worked-door pins, coverage strokes and recent plans already cover.
require('./lib/routes_api')(app, { mongoose, requireAuth, doorStore, warmDoorStore, knocksStore, warmKnocksStore, etDaysAgo, etToday, timezone: TZ, isAreaId });

// ── Authenticated pages ───────────────────────────────────────────────────────
app.get('/', authGate, (req, res) => sendBranded(res, 'index.html'));
app.get('*', authGate, (req, res) => sendBranded(res, 'index.html'));

// ── Seed admin ────────────────────────────────────────────────────────────────
// Only into an EMPTY user collection: once anyone exists, a missing or renamed
// admin is never re-created from the environment (that would hand a leaked
// INITIAL_ADMIN_PASSWORD a fresh admin account after every restart).
async function seedAdmin() {
  try {
    const users = await User.countDocuments();
    if (users > 0) {
      if (process.env.INITIAL_ADMIN_PASSWORD)
        console.warn('[seed] Users exist — INITIAL_ADMIN_PASSWORD is ignored. Remove it from the environment.');
      return;
    }
    if (!ADMIN_EMAIL || !process.env.INITIAL_ADMIN_PASSWORD) {
      console.warn('[seed] No users exist. Set ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD to create the first admin.');
      return;
    }
    if (process.env.INITIAL_ADMIN_PASSWORD.length < 12)
      console.warn('[seed] INITIAL_ADMIN_PASSWORD is short — change it in the app right after the first sign-in.');
    const hash = await bcrypt.hash(process.env.INITIAL_ADMIN_PASSWORD, 12);
    await User.create({ email:ADMIN_EMAIL, name:ADMIN_NAME, passwordHash:hash, role:'admin', emailVerified:true, active:true });
    console.log(`[seed] Admin user created: ${ADMIN_EMAIL} — remove INITIAL_ADMIN_PASSWORD from the environment now`);
  } catch(e) { console.error('[seed] Failed to seed admin:', e.message); }
}

// Last stop for errors nothing else caught (a malformed JSON body, a body
// over the size limit): a short JSON answer, never a stack trace.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON' });
  sec.sendError(res, err, 'unhandled');
});

app.listen(PORT, () => console.log(`${APP_NAME} running on port ${PORT}`));
