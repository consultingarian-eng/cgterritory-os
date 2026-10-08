'use strict';
// Security helpers shared by server.js and the tests (test/*.test.js).
//
// Everything a browser can store and someone else's browser later renders is
// validated here on the way in: ZIP edits (incidents above all), coverage
// strokes, per-user preferences. The client escapes on the way out as well;
// this is the second wall, and the one that also protects old data from new
// client code.
//
// Also here: the in-memory rate limiter, the CSRF guard, the security
// headers (with a Content-Security-Policy that hashes each page's inline
// scripts) and the "don't leak internals in a 500" helper.

const crypto = require('crypto');

// ── Small validators ─────────────────────────────────────────────────────────
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// A real calendar date in YYYY-MM-DD form (2026-02-30 is refused).
function isDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
// Best effort: "2026-10-08", "10/08/2026", "8 Oct 2026" → "YYYY-MM-DD" or ''.
function toDate(v) {
  if (isDate(v)) return v;
  if (v == null || v === '') return '';
  const s = String(v).trim().slice(0, 40);
  const t = Date.parse(s);
  if (isNaN(t)) return '';
  const out = new Date(t).toISOString().slice(0, 10);
  return isDate(out) ? out : '';
}
const str = (v, max) => (v == null ? '' : String(v)).slice(0, max);
const finite = v => (v === null || v === undefined || v === '' ? null : (Number.isFinite(+v) ? +v : null));

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const ROLES = ['sector_leader', 'client', 'admin'];

// ── Incidents ────────────────────────────────────────────────────────────────
// Keep in step with INCIDENT_TYPES in public/js/app.js.
const INCIDENT_TYPES = [
  'weapons', 'safety_threat', 'violent_crime',
  'police_stop', 'permit_denied', 'moved_on',
  'complaint', 'dnk_issue', 'access_issue', 'other',
];
const AUTO_RED_INCIDENTS = new Set(['weapons', 'safety_threat', 'violent_crime']);
const MAX_INCIDENTS_PER_AREA = 500;

// One incident → its clean form. Unknown types become "other" and a date
// that can't be read becomes `today`, so an import from a messy sheet still
// lands; coordinates that are not real numbers are dropped (the incident
// keeps its address but gets no map pin). Unknown keys are not kept.
function sanitizeIncident(inc, today) {
  if (!inc || typeof inc !== 'object' || Array.isArray(inc)) return null;
  const out = {
    date: toDate(inc.date) || today,
    type: INCIDENT_TYPES.includes(inc.type) ? inc.type : 'other',
    notes: str(inc.notes, 2000),
  };
  if (inc.address != null && inc.address !== '') out.address = str(inc.address, 300);
  const lat = finite(inc.lat), lng = finite(inc.lng);
  if (lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) { out.lat = lat; out.lng = lng; }
  return out;
}
function sanitizeIncidents(list, today) {
  if (!Array.isArray(list)) return { error: 'incidents must be a list' };
  if (list.length > MAX_INCIDENTS_PER_AREA) return { error: `At most ${MAX_INCIDENTS_PER_AREA} incidents per area` };
  return { value: list.map(i => sanitizeIncident(i, today)).filter(Boolean) };
}

// Who logged each incident (`by`, a user id) is the server's to say: it is
// carried over from the stored list and stamped on new entries, never taken
// from the request. A sector leader may only ADD incidents and remove ones
// they logged themselves — everyone else's (and older unattributed ones) stay,
// so a safety warning can't be wiped quietly. Admins and clients can edit freely.
//   existing  — the stored incidents (already clean)
//   submitted — the sanitised list from the request
// → { list: what to store, added: the entries that are new }
function mergeIncidents(existing, submitted, { userId, leaderOnly }) {
  const keyOf = i => JSON.stringify([i.date, i.type, i.notes, i.address ?? null, i.lat ?? null, i.lng ?? null]);
  const old = (Array.isArray(existing) ? existing : []).filter(i => i && typeof i === 'object');
  const pool = new Map();   // key → stored incidents not yet matched
  for (const i of old) { const k = keyOf(i); if (!pool.has(k)) pool.set(k, []); pool.get(k).push(i); }
  const kept = new Set(), added = [];
  for (const i of submitted) {
    const match = pool.get(keyOf(i))?.shift();
    if (match) kept.add(match);
    else added.push(userId ? { ...i, by: String(userId) } : { ...i });
  }
  if (!leaderOnly) {
    // Submitted order, attribution carried over from the stored copies.
    const out = [], again = new Map();
    for (const i of old) { const k = keyOf(i); if (kept.has(i)) { if (!again.has(k)) again.set(k, []); again.get(k).push(i); } }
    let a = 0;
    for (const i of submitted) {
      const m = again.get(keyOf(i))?.shift();
      out.push(m ? m : added[a++]);
    }
    return { list: out.slice(0, MAX_INCIDENTS_PER_AREA), added };
  }
  const mine = i => userId && i.by === String(userId);
  const out = old.filter(i => kept.has(i) || !mine(i)).concat(added);
  return { list: out.slice(0, MAX_INCIDENTS_PER_AREA), added };
}

// ── ZIP edits ────────────────────────────────────────────────────────────────
// Field names: plain identifiers only (no "$", no dots — those would be Mongo
// operators or nested paths). Values: anything JSON, capped in size, with
// the fields the board renders or schedules on checked for shape.
const FIELD_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX_EDIT_BYTES = 64 * 1024;
const MAX_TEXT_FIELD = 4000;
// Master fields an edit may shadow that must stay numeric / plain text.
// Keep NUMERIC_FIELD_RE in step with NUMERIC_EDIT_RE in public/js/app.js.
const NUMERIC_FIELD_RE = /^(households|(dist_miles|drive_mins|transit_mins)(_[A-Za-z0-9_]+)?)$/;
const PLACE_FIELDS = new Set(['state', 'county', 'primary_city', 'municipality', 'city']);

// One ZIP's patch → { set, unset } or { error }. `ctx` carries the owner's
// settings: { today, hubKeys, officeKeys, isAreaId }.
function validateEditPatch(data, ctx) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'Each area must map to an object' };
  if (JSON.stringify(data).length > MAX_EDIT_BYTES) return { error: 'Edit too large' };
  const set = {}, unset = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === 'zip') continue;
    if (!FIELD_RE.test(k)) return { error: `Invalid field name "${String(k).slice(0, 40)}"` };
    // Names every plain object already has (constructor, toString, …) would
    // shadow Object.prototype on the board and break code that looks fields up.
    if (k in Object.prototype) return { error: `Reserved field name "${k}"` };
    if (v === null || v === undefined) { unset[k] = ''; continue; }
    const bad = msg => ({ error: `${k}: ${msg}` });
    switch (k) {
      case 'incidents': {
        const r = sanitizeIncidents(v, ctx.today);
        if (r.error) return bad(r.error);
        set[k] = r.value; continue;
      }
      case 'color':
        if (typeof v !== 'string' || !/^[A-Z]{1,16}$/.test(v)) return bad('must be a status colour key');
        break;
      case 'pipeline_stage':
        if (typeof v !== 'string' || !/^[a-z_]{1,32}$/.test(v)) return bad('must be a stage key');
        break;
      case 'delivery_day':
        if (v !== '' && !DAY_KEYS.includes(v)) return bad('must be mon…sun');
        break;
      case 'hub':
        if (v !== '' && !(ctx.hubKeys || []).includes(v)) return bad('unknown hub');
        break;
      case 'office':
        if (v !== '' && !(ctx.officeKeys || []).includes(v)) return bad('unknown office');
        break;
      case 'work_date':
        if (v !== '' && !isDate(v)) return bad('must be YYYY-MM-DD');
        break;
      case 'blocked_by':
        if (v !== '' && !(ctx.isAreaId && ctx.isAreaId(v))) return bad('must be an area id');
        break;
      case 'day_change':
        if (typeof v !== 'object' || Array.isArray(v) || !DAY_KEYS.includes(v.to) || !isDate(v.on))
          return bad('must be { to: mon…sun, on: YYYY-MM-DD }');
        set[k] = { to: v.to, on: v.on }; continue;
      case 'constraints': {
        if (typeof v !== 'object' || Array.isArray(v)) return bad('must be an object');
        for (const [ck, cv] of Object.entries(v)) {
          if (!FIELD_RE.test(ck) || ck in Object.prototype) return bad('invalid key');
          if (!(typeof cv === 'boolean' || cv === '' || isDate(cv))) return bad(`${ck} must be true/false or a date`);
        }
        break;
      }
      case 'sales_target':
        if (!(v === '' || (typeof v === 'string' && /^\d{1,7}(\.\d{1,2})?$/.test(v)) || (Number.isFinite(v) && v >= 0 && v < 1e7)))
          return bad('must be a number');
        break;
      case 'difficulty':
        if (!(v === '' || [1, 2, 3, 4, 5].includes(+v))) return bad('must be 1–5');
        break;
      default:
        // Figures the board does arithmetic on are stored as numbers, never text.
        if (NUMERIC_FIELD_RE.test(k)) {
          const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
          if (!Number.isFinite(n) || n < 0 || n > 1e7) return bad('must be a number');
          set[k] = n; continue;
        }
        // Place names are plain text: no markup characters.
        if (PLACE_FIELDS.has(k) && (typeof v !== 'string' || v.length > 120 || /[<>"`]/.test(v)))
          return bad('must be plain text (no < > " `), at most 120 characters');
        // Everything else is a free-text / flag field: one plain value, never
        // a list or object (the board calls string methods on these).
        if (typeof v === 'string') { if (v.length > MAX_TEXT_FIELD) return bad(`at most ${MAX_TEXT_FIELD} characters`); }
        else if (typeof v === 'number') { if (!Number.isFinite(v)) return bad('must be a finite number'); }
        else if (typeof v !== 'boolean') return bad('must be text, a number or true/false');
    }
    set[k] = v;
  }
  return { set, unset };
}

// ── Coverage strokes ─────────────────────────────────────────────────────────
const MAX_STROKE_POINTS = 5000;
const STYLE_ENUMS = { lineCap: ['round', 'square', 'butt'], lineJoin: ['round', 'miter', 'bevel'] };
function sanitizeStrokeStyle(s) {
  const out = {};
  if (!s || typeof s !== 'object' || Array.isArray(s)) return out;
  if (typeof s.color === 'string' && /^(#[0-9a-fA-F]{3,8}|[a-z]{3,20})$/.test(s.color)) out.color = s.color;
  if (Number.isFinite(+s.weight) && +s.weight > 0 && +s.weight <= 80) out.weight = +s.weight;
  if (Number.isFinite(+s.opacity) && +s.opacity >= 0 && +s.opacity <= 1) out.opacity = +s.opacity;
  for (const [k, allowed] of Object.entries(STYLE_ENUMS)) if (allowed.includes(s[k])) out[k] = s[k];
  return out;
}
// Body of POST /api/knocks → { value: { zip, latlngs, date, style } } or { error }.
// `round` is the server's point rounder (5 decimals, consecutive dedupe).
function sanitizeKnock(body, { isAreaId, round }) {
  const b = body && typeof body === 'object' ? body : {};
  if (!isDate(b.date)) return { error: 'date must be YYYY-MM-DD' };
  if (!Array.isArray(b.latlngs) || b.latlngs.length > MAX_STROKE_POINTS)
    return { error: `latlngs must be a list of at most ${MAX_STROKE_POINTS} points` };
  const zip = b.zip == null || b.zip === '' ? '' : String(b.zip);
  if (zip && !isAreaId(zip)) return { error: 'zip must be an area id' };
  const latlngs = round(b.latlngs).filter(([lat, lng]) => Math.abs(lat) <= 90 && Math.abs(lng) <= 180);
  if (!latlngs.length) return { error: 'latlngs and date required' };
  return { value: { zip, latlngs, date: b.date, style: sanitizeStrokeStyle(b.style) } };
}

// ── Per-user preferences ─────────────────────────────────────────────────────
// Only the keys the client saves (savePrefs in public/js/app.js), each with
// its type. Anything else — userId above all — is dropped.
const PREF_BOOLS = ['showAllCoverage', 'showAllIncidents', 'showDifficulty', 'showSalesLayer',
  'showSalesOnly', 'showSalesPins', 'showWorkedDoors', 'showHelpers'];
const PREF_KEYS = ['baseLayer', 'deliveryFilter', 'hubFilter', 'activeOffice', 'coverageFilterMode',
  'incidentTypeFilter', 'salesPinDateMode', 'workedDoorMode'];
const PREF_DATES = ['coverageFrom', 'coverageTo', 'salesPinFrom', 'salesPinTo', 'workedDoorFrom', 'workedDoorTo'];
function sanitizePrefs(p) {
  const out = {};
  if (!p || typeof p !== 'object' || Array.isArray(p)) return out;
  for (const k of PREF_BOOLS) if (typeof p[k] === 'boolean') out[k] = p[k];
  for (const k of PREF_KEYS) if (typeof p[k] === 'string' && /^[\w-]{0,40}$/.test(p[k])) out[k] = p[k];
  for (const k of PREF_DATES) if (p[k] === '' || isDate(p[k])) out[k] = p[k];
  if (Number.isFinite(p.overlayOpacity) && p.overlayOpacity >= 0 && p.overlayOpacity <= 1) out.overlayOpacity = p.overlayOpacity;
  if (Array.isArray(p.activeStates))
    out.activeStates = p.activeStates.filter(s => typeof s === 'string' && /^[\w-]{1,16}$/.test(s)).slice(0, 100);
  return out;
}

// ── Rate limiting ────────────────────────────────────────────────────────────
// Fixed window per key, in memory (the board runs as one process). hit()
// counts and answers; check() only answers; reset() forgets a key (a
// successful login clears that email's failures).
function createRateLimiter({ windowMs, max, maxKeys = 50_000 }) {
  const hits = new Map();   // key -> { n, until }
  const live = (key, now) => { const h = hits.get(key); return h && h.until > now ? h : null; };
  function sweep(now) {
    if (hits.size < maxKeys) return;
    for (const [k, h] of hits) if (h.until <= now) hits.delete(k);
    if (hits.size >= maxKeys) hits.clear();   // pathological flood: start over rather than grow
  }
  return {
    // → { limited, retryAfter (s), remaining }
    hit(key, now = Date.now()) {
      sweep(now);
      let h = live(key, now);
      if (!h) { h = { n: 0, until: now + windowMs }; hits.set(key, h); }
      h.n++;
      return { limited: h.n > max, retryAfter: Math.ceil((h.until - now) / 1000), remaining: Math.max(0, max - h.n) };
    },
    check(key, now = Date.now()) {
      const h = live(key, now);
      return { limited: !!h && h.n >= max, retryAfter: h ? Math.ceil((h.until - now) / 1000) : 0 };
    },
    reset(key) { hits.delete(key); },
    size() { return hits.size; },
  };
}
function tooMany(res, retryAfter, msg = 'Too many attempts — please wait a few minutes and try again') {
  res.set('Retry-After', String(Math.max(1, retryAfter | 0)));
  return res.status(429).json({ error: msg });
}

// ── CSRF ─────────────────────────────────────────────────────────────────────
// Session cookies are SameSite=Lax, which still lets a sibling subdomain
// ("same-site") post with them. So every state-changing API request must:
//   • carry a JSON body if it carries a body at all (an HTML form can't send
//     application/json without a CORS preflight, which this server never
//     answers), and
//   • not come from another origin, by the browser's own Origin /
//     Sec-Fetch-Site headers.
// Server-to-server routes (x-service-token) are exempt: no cookie, no browser.
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
function csrfGuard({ allowedHosts = [] } = {}) {
  return (req, res, next) => {
    if (!UNSAFE.has(req.method)) return next();
    // Field-app routes authenticate with FIELD_APP_TOKEN, not the session cookie.
    // (Mounted under app.use('/api/'), so req.path has lost its /api prefix.)
    if ((req.originalUrl || req.path || '').startsWith('/api/integrations/')) return next();
    const site = req.get('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none')
      return res.status(403).json({ error: 'Cross-site request refused' });
    const origin = req.get('origin');
    if (origin && origin !== 'null') {
      let host = '';
      try { host = new URL(origin).host; } catch {}
      if (!host || (host !== req.get('host') && !allowedHosts.includes(host)))
        return res.status(403).json({ error: 'Cross-origin request refused' });
    } else if (origin === 'null') {
      return res.status(403).json({ error: 'Cross-origin request refused' });
    }
    const hasBody = +(req.get('content-length') || 0) > 0 || !!req.get('transfer-encoding');
    if (hasBody && !req.is('application/json'))
      return res.status(415).json({ error: 'Send JSON (Content-Type: application/json)' });
    next();
  };
}

// ── Security headers + CSP ───────────────────────────────────────────────────
// One policy for every response. Pages with inline <script> blocks (login,
// set-password, export map) get those blocks' hashes added, computed from the
// exact bytes served, so the policy never needs 'unsafe-inline' for scripts.
// Styles do need it: the app builds markup with style="" attributes.
// The CDN is allowed for ONE file (the spreadsheet parser, also pinned by SRI
// in app.js), never the whole origin: unpkg serves any package anyone
// publishes, so allowing https://unpkg.com would let injected markup load
// attacker script. Change this together with ensureXLSX() in app.js.
const CDN_SCRIPT = 'https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js';
function cspHeader(scriptHashes = []) {
  return [
    "default-src 'self'",
    `script-src 'self' ${CDN_SCRIPT}${scriptHashes.map(h => ` '${h}'`).join('')}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https:",
    `connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com ${CDN_SCRIPT}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}
function inlineScriptHashes(html) {
  const out = [];
  const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (/\ssrc\s*=/i.test(m[1] || '')) continue;
    out.push('sha256-' + crypto.createHash('sha256').update(m[2], 'utf8').digest('base64'));
  }
  return out;
}
function securityHeaders({ hsts = false } = {}) {
  const csp = cspHeader();
  return (req, res, next) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=(), payment=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    if (hsts) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  };
}

// ── Errors ───────────────────────────────────────────────────────────────────
// A 4xx carries its own message (it is about the request); anything else is
// logged here and answered generically, so stack details, driver messages and
// third-party error bodies never reach a browser.
function sendError(res, e, tag = 'error') {
  const status = Number.isInteger(e?.status) && e.status >= 400 && e.status < 500 ? e.status : 500;
  if (status < 500) return res.status(status).json({ error: String(e.message || 'Bad request').slice(0, 300) });
  console.error(`[${tag}]`, e?.stack || e?.message || e);
  return res.status(500).json({ error: 'Something went wrong on the server — try again, or ask an admin to check the logs' });
}

// ── Backup encryption (lib/backup.js, scripts/restore-backup.js) ─────────────
// AES-256-GCM. File layout: "CGTENC1" | 12-byte IV | 16-byte tag | ciphertext.
// The key is BACKUP_ENCRYPTION_KEY: 64 hex characters, or any passphrase
// (stretched with scrypt and a fixed, public salt — the passphrase is the secret).
const ENC_MAGIC = Buffer.from('CGTENC1');
function backupKey(secret) {
  if (!secret) return null;
  if (/^[0-9a-fA-F]{64}$/.test(secret)) return Buffer.from(secret, 'hex');
  return crypto.scryptSync(String(secret), 'cgterritory-backup-v1', 32);
}
function encryptBuffer(buf, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([ENC_MAGIC, iv, c.getAuthTag(), body]);
}
const isEncrypted = buf => Buffer.isBuffer(buf) && buf.length > ENC_MAGIC.length + 28 && buf.subarray(0, ENC_MAGIC.length).equals(ENC_MAGIC);
function decryptBuffer(buf, key) {
  const o = ENC_MAGIC.length;
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(o, o + 12));
  d.setAuthTag(buf.subarray(o + 12, o + 28));
  return Buffer.concat([d.update(buf.subarray(o + 28)), d.final()]);
}

module.exports = {
  isDate, toDate, DAY_KEYS, ROLES,
  INCIDENT_TYPES, AUTO_RED_INCIDENTS, sanitizeIncident, sanitizeIncidents,
  validateEditPatch, mergeIncidents, sanitizeKnock, sanitizeStrokeStyle, MAX_STROKE_POINTS, sanitizePrefs,
  createRateLimiter, tooMany, csrfGuard,
  cspHeader, inlineScriptHashes, securityHeaders, sendError,
  backupKey, encryptBuffer, decryptBuffer, isEncrypted,
};
