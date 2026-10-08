'use strict';
// Owner settings: everything that is about YOUR business rather than about
// how the board works — brand, offices, hubs, regions, time zone, labels.
//
// Read once at boot from config/territory.json (or the file CGT_SETTINGS_FILE
// points at), merged over the neutral defaults below. Secrets never live
// here: keys, tokens and connection strings come from the environment only.
//
// The browser gets the public part of this file as window.CGT_CONFIG through
// /config.js (see server.js), so app.js and the server agree on office keys,
// hub keys and labels without either hardcoding them.

const fs   = require('fs');
const path = require('path');

const DEFAULTS = {
  brand: {
    appName: 'CGTerritory',
    tagline: 'Territory & Permit Board',
    description: 'Territory intelligence & permit board for door-to-door canvassing.',
    orgName: '',
    orgUrl: '',
    logo: '/logo.svg',
    logoPng: '/logo.png',
    themeColor: '#0a0610',
  },
  // IANA zone every calendar date on the board is kept in ("today", stroke
  // dates, plan expiry, the nightly backup hour, the sales refresh times).
  // Europe/London for the UK. The APP_TIMEZONE environment variable, when
  // set, wins over this key — one setting, read once, used everywhere.
  timezone: 'America/New_York',
  // ISO country code(s) handed to Nominatim when an address is geocoded.
  // The US Census geocoder is tried first only when this includes "us".
  countryCodes: ['us'],
  // What one territory unit is called on screen: "ZIP" (US) or "Sector" (UK).
  areaLabel: 'ZIP',
  // Area ids the API accepts. Default: a 5-digit US ZIP or a UK postcode
  // sector ("SW1A 1", "M1 1"). Must match the ids in public/data/master.json.
  areaIdPattern: '^(\\d{5}|[A-Z]{1,2}\\d[A-Z\\d]? \\d)$',
  // Region = the group a polygon file belongs to (a US state, a UK county or
  // postcode area). Each region is one GeoJSON file under public/data.
  regions: [],
  // Offices the teams drive out from. key is stored on users and ZIPs, so
  // pick it once and keep it. regions = the regions this office owns by
  // default; a ZIP in a region two offices share goes to the nearer one
  // (dist_miles_<key> on the master record).
  offices: [
    { key: 'main', label: 'Main Office', color: '#3B82F6', regions: [], address: '', lat: null, lng: null },
  ],
  // Distribution hubs / depots a ZIP can be serviced from (Balance board).
  // aliases = other spellings an import sheet may use.
  hubs: [],
  client: {
    name: 'Client',
    salesLabel: 'Client sales',
  },
  fieldApp: {
    name: 'the field app',
  },
  sales: {
    // Times (HH:MM, in `timezone`) the sales source is re-read each day.
    refreshTimes: ['08:10', '08:20'],
    // Sale pins outside this box are ignored (swapped or junk columns).
    // [minLat, minLng, maxLat, maxLng]
    pinBounds: [-90, -180, 90, 180],
  },
  research: {
    // Steers the AI permit research toward your jurisdiction's rules.
    region: 'the United States',
    notes: [],
  },
  // Optional 'YYYY-MM-DD': the day you started tracking hub cycles on the
  // Balance board. Older sales never count toward a synthesized first cycle.
  balanceEpoch: '',
  // Optional override of the route generator's field-time model (see FIELD in
  // lib/routegen.js for the shape and the illustrative defaults).
  routePlanning: null,
};

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function merge(base, over) {
  if (!isObj(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (k.startsWith('_')) continue;   // "_comment" keys are notes for humans
    out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

function load() {
  const file = process.env.CGT_SETTINGS_FILE
    ? path.resolve(process.env.CGT_SETTINGS_FILE)
    : path.join(__dirname, '..', 'config', 'territory.json');
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`[settings] ${file}: ${e.message}`);
    console.warn(`[settings] ${file} not found — running on built-in defaults`);
  }
  const s = merge(DEFAULTS, raw);

  if (process.env.APP_TIMEZONE && process.env.APP_TIMEZONE.trim()) s.timezone = process.env.APP_TIMEZONE.trim();
  // A typo here would silently shift every "today" on the board — refuse it.
  try { new Intl.DateTimeFormat('en-CA', { timeZone: s.timezone }).format(new Date()); }
  catch { throw new Error(`[settings] timezone "${s.timezone}" is not a valid IANA zone (e.g. America/New_York, Europe/London)`); }

  s.offices = (Array.isArray(s.offices) && s.offices.length ? s.offices : DEFAULTS.offices)
    .filter(o => o && /^[a-z0-9_]+$/.test(o.key || ''))
    .map(o => ({ color: '#3B82F6', regions: [], address: '', lat: null, lng: null, ...o, label: o.label || o.key }));
  if (!s.offices.length) throw new Error('[settings] offices: at least one office with a lowercase key is required');
  s.hubs = (Array.isArray(s.hubs) ? s.hubs : [])
    .filter(h => h && /^[a-z0-9_]+$/.test(h.key || ''))
    .map(h => ({ aliases: [], ...h, label: h.label || h.key, short: h.short || String(h.key).slice(0, 3).toUpperCase() }));
  s.regions = (Array.isArray(s.regions) ? s.regions : [])
    .filter(r => r && r.code)
    .map(r => ({ label: r.code, file: `/data/${String(r.code).toLowerCase()}.geojson`, ...r }));
  if (!Array.isArray(s.countryCodes)) s.countryCodes = String(s.countryCodes || 'us').split(',');
  s.countryCodes = s.countryCodes.map(c => String(c).trim().toLowerCase()).filter(Boolean);

  // Derived helpers
  s.officeKeys = s.offices.map(o => o.key);
  s.hubKeys = s.hubs.map(h => h.key);
  s.areaRe = new RegExp(s.areaIdPattern);
  // Regions an office geocodes in, in order (its own first, then the rest).
  s.officeRegions = Object.fromEntries(s.offices.map(o => [o.key, (o.regions || []).slice()]));
  s.allRegionCodes = s.regions.map(r => r.code);
  return s;
}

const settings = load();

// "02139", "2139", "02139-1234" → "02139"; "sw1a 1aa" / "SW1A1AA" → "SW1A 1"
// (a full UK postcode folds to its sector); anything else is upper-cased and
// space-collapsed. Returns '' when the result is not a valid area id.
function normalizeAreaId(v) {
  let s = String(v ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!s) return '';
  if (/^\d{3,5}(-\d{4})?$/.test(s)) s = s.split('-')[0].padStart(5, '0');
  else if (/^\d+(\.0+)?$/.test(s)) s = String(parseInt(s, 10)).padStart(5, '0');   // spreadsheets store ZIPs as numbers
  else {
    const uk = s.replace(/\s/g, '').match(/^([A-Z]{1,2}\d[A-Z\d]?)(\d)([A-Z]{2})?$/);
    if (uk) s = `${uk[1]} ${uk[2]}`;
  }
  return settings.areaRe.test(s) ? s : '';
}
const isAreaId = v => typeof v === 'string' && settings.areaRe.test(v);

// The subset the browser may see (no file paths, nothing secret — there is
// nothing secret in this file, but keep the surface small anyway).
function publicConfig() {
  return {
    brand: settings.brand,
    timezone: settings.timezone,
    areaLabel: settings.areaLabel,
    areaIdPattern: settings.areaIdPattern,
    regions: settings.regions.map(({ code, label, file }) => ({ code, label, file })),
    offices: settings.offices.map(({ key, label, color, regions, address }) => ({ key, label, color, regions, address })),
    hubs: settings.hubs.map(({ key, label, short, aliases }) => ({ key, label, short, aliases })),
    client: settings.client,
    fieldApp: settings.fieldApp,
    balanceEpoch: settings.balanceEpoch || '',
  };
}

// User-Agent for the public services this server calls (Overpass, Nominatim,
// county parcel servers). Their usage policies ask for a way to reach you.
const USER_AGENT = `${settings.brand.appName.replace(/[^\w.-]/g, '')}/1.0 (${
  process.env.GEOCODER_CONTACT || process.env.ADMIN_EMAIL || process.env.APP_URL || 'self-hosted'})`;

module.exports = { settings, normalizeAreaId, isAreaId, publicConfig, USER_AGENT };
