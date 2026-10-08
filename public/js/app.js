/* Dispatch — Territory & Permit Board */

// Owner settings (config/territory.json on the server), served as /config.js
// before this file loads: brand, offices, hubs, regions, timezone, labels.
const CFG = window.CGT_CONFIG || {};

const COLOR_DEFAULTS = { GREEN:'#3FAE6A', YELLOW:'#E8B339', RED:'#E5484D', GREY:'#5B6472', TEAL:'#06B6D4' };
const STATUS_LABELS  = { GREEN:'Good to Pitch', YELLOW:'Permit Needed', RED:'Big Blocker', GREY:'Not Reviewed', TEAL:'Permit Secured' };
// Regions = groups of polygons (a US state, a UK county …), one GeoJSON each.
const REGIONS = Array.isArray(CFG.regions) ? CFG.regions : [];
const STATES = REGIONS.map(r => r.code);

// Offices the teams drive out from. Keys are stored on users and ZIPs.
const OFFICE_LIST = (Array.isArray(CFG.offices) && CFG.offices.length) ? CFG.offices
  : [{ key:'main', label:'Main Office', color:'#3B82F6', regions:[], address:'' }];
const OFFICE_KEYS = OFFICE_LIST.map(o => o.key);
const OFFICES = Object.fromEntries(OFFICE_LIST.map(o => [o.key, o.label]));
const OFFICE_COLORS = Object.fromEntries(OFFICE_LIST.map(o => [o.key, o.color || '#3B82F6']));
const isOfficeKey = k => OFFICE_KEYS.includes(k);
const ALL_OFFICES_LABEL = OFFICE_LIST.length === 2 ? 'Both offices' : 'All offices';
const CLIENT_SALES_LABEL = CFG.client?.salesLabel || 'Client sales';
const FIELD_APP_NAME = CFG.fieldApp?.name || 'the field app';
const AREA_LABEL = CFG.areaLabel || 'ZIP';
const BOARD_TZ = CFG.timezone || 'America/New_York';

// Area ids: a US ZIP ("02139") or a UK postcode sector ("SW1A 1"), matching
// settings.areaIdPattern. A full UK postcode folds to its sector; a ZIP
// typed without its leading zero gets it back.
const AREA_RE = (() => { try { return new RegExp(CFG.areaIdPattern || '^\\d{5}$'); } catch { return /^\d{5}$/; } })();
function normalizeAreaId(v){
  let s = String(v ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!s) return '';
  if (/^\d{3,5}(-\d{4})?$/.test(s)) s = s.split('-')[0].padStart(5, '0');
  else if (/^\d+(\.0+)?$/.test(s)) s = String(parseInt(s, 10)).padStart(5, '0');
  else {
    const uk = s.replace(/\s/g, '').match(/^([A-Z]{1,2}\d[A-Z\d]?)(\d)([A-Z]{2})?$/);
    if (uk) s = `${uk[1]} ${uk[2]}`;
  }
  return AREA_RE.test(s) ? s : '';
}

const PIPELINE_STAGES = [
  { key:'incoming',       label:'Incoming',          desc:'Assigned — set work date, target & notes',  color:'#6B7280' },
  { key:'research',       label:'Researching',        desc:'Permit research underway',                  color:'#ec008c' },
  { key:'flagged',        label:'Needs Permits',      desc:'Permit needed — not applied or not yet secured (critical incidents land here too)', color:'#EF4444' },
  { key:'permit_secured', label:'Permit Secured',     desc:'Permit obtained — record who holds it',     color:'#06B6D4' },
  { key:'ready',          label:'No Permit Needed',   desc:'No permit required — cleared to deploy',    color:'#10B981' },
  { key:'active',         label:'In Field',           desc:'Team is currently working this territory',  color:'#F59E0B' },
  { key:'completed',      label:'Completed',          desc:'Territory finished — work done',            color:'#374151' },
];

// Scheduling constraints — the reasons a territory can't go out right now.
// Stored per-ZIP as edits[zip].constraints = { key: true | 'YYYY-MM-DD' }
// (the date form is for hasDate keys — when the permit was applied for).
// Shown as chips on pipeline cards and rolled up into the strip above the
// board so the client sees the "why not more?" story without asking.
const CONSTRAINTS = [
  { key:'needs_cars',      icon:'🚗', short:'cars',    label:'Needs cars',      desc:'Territory needs vehicles we don\'t have spare',                          color:'#F59E0B' },
  { key:'partial_permits', icon:'🪪', short:'partial', label:'Partial permits', desc:'Not everyone on the team is permitted here',                             color:'#A78BFA' },
  { key:'permit_pending',  icon:'⏳', short:'pending', label:'Permit pending',  desc:'Permit applied for — awaiting a response',                hasDate:true,  color:'#06B6D4' },
  { key:'resting',         icon:'😴', short:'resting', label:'Resting',         desc:'Worked recently — resting before the next pass',                         color:'#10B981' },
  { key:'awaiting_date',   icon:'📅', short:'no date', label:'Awaiting date',   desc:'Ready to go but no work date agreed yet',                                color:'#9CA3AF' },
];

// Delivery day of the week each ZIP is serviced on (client delivers on a fixed day)
const DELIVERY_DAYS = [
  { key:'mon', label:'Monday',    short:'Mon' },
  { key:'tue', label:'Tuesday',   short:'Tue' },
  { key:'wed', label:'Wednesday', short:'Wed' },
  { key:'thu', label:'Thursday',  short:'Thu' },
  { key:'fri', label:'Friday',    short:'Fri' },
  { key:'sat', label:'Saturday',  short:'Sat' },
  { key:'sun', label:'Sunday',    short:'Sun' },
];
const dayShort = k => DELIVERY_DAYS.find(d => d.key === k)?.short || '';

// Distribution hubs the client services territory from (settings.hubs). A
// ZIP's hub comes from the client's territory sheets (scripts/import-hubs.js),
// not from geography — hub and office are independent: one hub's ZIPs can all
// belong to one office while that office also covers ZIPs from other hubs.
const HUBS = Array.isArray(CFG.hubs) ? CFG.hubs : [];
const hubLabel = k => HUBS.find(h => h.key === k)?.label || '';
const hubShort = k => HUBS.find(h => h.key === k)?.short || '';
// Normalize free-text ("Wednesday", "WED", "3", "weds") → a delivery-day key
function normalizeDay(v){
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return '';
  const num = { '1':'mon','2':'tue','3':'wed','4':'thu','5':'fri','6':'sat','7':'sun' };
  if (num[s]) return num[s];
  const hit = DELIVERY_DAYS.find(d => s.startsWith(d.key) || d.label.toLowerCase().startsWith(s.slice(0,3)));
  return hit ? hit.key : '';
}

// Hub names arrive as free text from the client's sheets ("Riverside Depot",
// "riverside") — fold to the app's key (or one of the hub's aliases) or return
// '' so a bad value is skipped rather than stored and silently unmatched.
function normalizeHub(v){
  const fold = x => String(x ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const s = fold(v);
  if (!s) return '';
  const hit = HUBS.find(h => fold(h.key) === s || fold(h.label) === s || (h.aliases || []).some(a => fold(a) === s));
  return hit ? hit.key : '';
}

// Permit difficulty 1 (easiest / no permit) → 5 (extremely hard). Green→red scale.
const DIFFICULTY_COLORS = { 1:'#3FAE6A', 2:'#93C572', 3:'#E8B339', 4:'#F0803C', 5:'#E5484D' };

const INCIDENT_TYPES = [
  // Critical — staff safety
  { key:'weapons',        label:'Weapons / Armed Threat',        severity:'critical', autoRed:true,  color:'#ef4444' },
  { key:'safety_threat',  label:'Threat to Staff / Intimidation', severity:'critical', autoRed:true,  color:'#f43f5e' },
  { key:'violent_crime',  label:'Violent Crime / Active Scene',   severity:'critical', autoRed:true,  color:'#dc2626' },
  // High — permit / police
  { key:'police_stop',    label:'Police Stop — No Permit',       severity:'high',     autoRed:false, color:'#f97316' },
  { key:'permit_denied',  label:'Permit Application Denied',     severity:'high',     autoRed:false, color:'#eab308' },
  { key:'moved_on',       label:'Moved On by Police / Authority', severity:'high',     autoRed:false, color:'#f59e0b' },
  // Operational
  { key:'complaint',      label:'Resident Complaint',            severity:'medium',   autoRed:false, color:'#facc15' },
  { key:'dnk_issue',      label:'Do-Not-Knock Issue',            severity:'medium',   autoRed:false, color:'#ec008c' },
  { key:'access_issue',   label:'Access Issue',                  severity:'low',      autoRed:false, color:'#3b82f6' },
  { key:'other',          label:'Other',                         severity:'low',      autoRed:false, color:'#9ca3af' },
];

let COLORS = { ...COLOR_DEFAULTS };
let edits  = {};
let MASTER = [], MASTER_ORIG = [];
let GEO = Object.fromEntries(STATES.map(st => [st, null]));
let map, geoLayers = {}, layerByZip = {}, activeBaseTile = null;
let salesByZip = {};       // { "01001": 7, "01056": 3, ... }
let salesDatesByZip = {};  // { "01056": ["2026-09-11", …] } — per-sale dates, for cycle counting
let hubGoals = Object.create(null);   // { <hub key>: { cap, cycleStart, cycle } } — org-wide, from /api/hub-goals
let strongWeekByZip = {};  // { "01001": "2026-09-22", ... }
let salesLayer = null;     // L.layerGroup for bubble overlays
let showSalesLayer = false;
let showSalesOnly  = false;
let salesPins = [];        // per-sale {lat,lng,date,badge,d1,d2,d4,cancelled} from the sheet
let salesPinsLayer = null;
let showSalesPins  = false;
let showAllCoverage = false;
let showDifficulty  = false;   // map recolored by permit difficulty (1–5) instead of status

// Worked doors — auto-synced from the field app's door logs. Sector leaders
// still mark coverage off manually; the pins are informational. mode: 'today' | 'yesterday' | 'last7' | 'last30' | 'custom'.
// Changing the mode REFETCHES (the server holds up to 12 weeks; only the
// selected window is pulled down).
let workedDoors = [];          // {date,lat,lng,zip,outcome,baName,address,city,office,tsEpoch}
let workedDoorsPending = 0;    // doors received but not yet geocoded (server-side)
let workedDoorsLayer = null;
let showWorkedDoors  = false;
let workedDoorMode   = 'today';
let workedDoorFrom = null, workedDoorTo = null;  // 'YYYY-MM-DD' for custom
let workedDoorsSlim = false;   // big windows ship position+outcome only — still one pin per real door
let workedDoorsTotal = 0;      // true door count behind whatever was returned

// Coverage date filter — which day(s) of freehand knocks to show.
// mode: 'all' | 'today' | 'yesterday' | 'last7' | 'last30' | 'custom'
let coverageFilterMode = 'last30';
let coverageFrom = null;  // 'YYYY-MM-DD' inclusive lower bound (custom mode)
let coverageTo   = null;  // 'YYYY-MM-DD' inclusive upper bound (custom mode)

// ─── Board time ──────────────────────────────────────────────────────────────
// Every date on the platform — stroke dates, "today", filter windows — is a
// calendar date in the board's timezone (settings.timezone; the et* names
// date from when it was always US Eastern). Never derive one via
// toISOString() (that's UTC: a stroke drawn at 9pm in New York would land on
// tomorrow) or from the device's own timezone (a viewer elsewhere would
// disagree with the field).
const ET_DATE_FMT = new Intl.DateTimeFormat('en-CA', { timeZone:BOARD_TZ });
const etToday = () => ET_DATE_FMT.format(new Date());   // 'YYYY-MM-DD'

// Shift a 'YYYY-MM-DD' string by n days. The arithmetic runs in UTC-space on
// purpose: these are pure calendar dates, so UTC math can't DST-skip a day.
function isoAddDays(iso, n){
  const t = new Date(iso + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().split('T')[0];
}
// Resolve the active coverage window to inclusive {from,to} date strings (null = unbounded)
function getCoverageBounds(){
  const today = etToday();
  switch (coverageFilterMode) {
    case 'today':     return { from: today, to: today };
    case 'yesterday': { const y = isoAddDays(today, -1); return { from: y, to: y }; }
    case 'last7':     return { from: isoAddDays(today, -6),  to: today };
    case 'last30':    return { from: isoAddDays(today, -29), to: today };
    case 'custom':    return { from: coverageFrom || null, to: coverageTo || null };
    case 'all':
    default:          return { from: null, to: null };
  }
}
// Re-render whichever coverage view is currently on screen
function refreshCoverage(){
  if (showAllCoverage) renderKnocks('__ALL__');
  else renderKnocks(drawerZip);
}
// Show a "N strokes · M days" summary of what the current coverage filter is displaying
function updateCoverageCaption(strokes, days){
  const cap = document.getElementById('covCaption');
  if (!cap) return;
  cap.textContent = strokes
    ? `${strokes} stroke${strokes!==1?'s':''} · ${days} day${days!==1?'s':''}`
    : 'No coverage in range';
}

const VIEW_MODE = new URLSearchParams(location.search).get('mode') === 'view';
let searchFilterZips = null; // null = no filter, Set = only show these ZIPs on map

const isMob = () => window.innerWidth <= 768;

// Escape user-entered / AI-returned text before injecting into innerHTML
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

let currentUser = null; // { id, email, name, role, office }

// Office scope for pipeline/schedule/stats. 'all' = every office.
// Single-office accounts are locked to their office.
let activeOffice = 'all';
const canSwitchOffice = () => (currentUser?.office ?? 'both') === 'both' && OFFICE_LIST.length > 1;

// Distance / drive / transit from one office to a ZIP. The master record
// carries dist_miles_<office key> and drive_mins_<office key> (written by
// scripts/import-territory.js); plain dist_miles / drive_mins / transit_mins
// are read as the FIRST office's figures.
function officeDist(r, office){
  if (!r) return { dist:null, drive:null, transit:null };
  let dist = r['dist_miles_' + office], drive = r['drive_mins_' + office], transit = r['transit_mins_' + office];
  if (dist == null && office === OFFICE_KEYS[0]) { dist = r.dist_miles; drive = r.drive_mins; transit = r.transit_mins; }
  const num = v => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;
  return { dist: num(dist), drive: num(drive), transit: num(transit) };
}

// A ZIP's office: explicit assignment wins; otherwise the office(s) whose
// regions include the ZIP's region, and among several the nearest one.
function zipOffice(zip){
  const o = edits[zip]?.office;
  if (isOfficeKey(o)) return o;
  const r = byZip[zip];
  if (!r) return OFFICE_KEYS[0];
  const owners = OFFICE_LIST.filter(of => (of.regions || []).includes(r.state));
  const pool = owners.length ? owners : OFFICE_LIST;
  if (pool.length === 1) return pool[0].key;
  let best = null, bestD = Infinity;
  for (const of of pool) {
    const d = officeDist(r, of.key).dist;
    if (d != null && d < bestD) { bestD = d; best = of.key; }
  }
  return best || pool[0].key;
}
const officeMatch = zip => activeOffice === 'all' || zipOffice(zip) === activeOffice;

// Delivery-day filter for map/pipeline/schedule. 'all' = every day.
let deliveryFilter = 'all';
const deliveryMatch = zip => deliveryFilter === 'all' || edits[zip]?.delivery_day === deliveryFilter;

// Hub filter for map/pipeline/schedule. 'all' = every hub. Applies alongside
// the office switcher and the day filter — all three must pass.
let hubFilter = 'all';
const hubMatch = zip => hubFilter === 'all' || edits[zip]?.hub === hubFilter;

// ── Priority / blocking ──────────────────────────────────────────────────────
// A ZIP can require another ZIP to be fully worked (Completed) before it deploys.
// Soft lock: shows a badge + warns on advance, never hard-stops.
function blockerFor(zip){
  const bz = edits[zip]?.blocked_by;
  if (!bz || bz === zip) return null;
  return { zip: bz, done: edits[bz]?.pipeline_stage === 'completed' };
}

// ── Permit difficulty (auto-computed, manual override wins) ───────────────────
function parseDollars(s){
  const m = String(s || '').replace(/,/g, '').match(/\$?\s*(\d+(?:\.\d+)?)/);
  return m ? +m[1] : null;
}
function parseDays(s){
  s = String(s || '').toLowerCase();
  if (/same[- ]?day|counter|immediate|on the spot/.test(s)) return 0;
  const nums = (s.match(/\d+/g) || []).map(Number);
  if (!nums.length) return null;
  let d = Math.max(...nums);
  if (/week/.test(s)) d *= 7;
  return d;
}
// Returns 1–5, or null when there's no record. 1 = no permit, 5 = extremely hard.
function computeDifficulty(zip){
  const r = byZip[zip], e = edits[zip] || {};
  if (!r) return null;
  const noPermit = e.permit_needed === false || r.color === 'GREEN' ||
                   /^n$/i.test(e.permit_required || r.permit_required || '');
  if (noPermit) return 1;
  if (r.color === 'RED') return 5;
  const cost = parseDollars(e.cost_per_person || e.fee || r.fee);
  const days = parseDays(e.processing_time || r.processing_time);
  const dist = officeDist(r, zipOffice(zip)).dist;
  let s = 2; // baseline for "permit needed"
  if (cost != null) s += cost >= 1000 ? 2 : cost >= 250 ? 1.5 : cost >= 50 ? 1 : cost > 0 ? 0.5 : 0;
  if (days != null) s += days >= 14 ? 1.5 : days >= 7 ? 1 : days >= 3 ? 0.5 : 0;
  if (dist != null) s += dist >= 75 ? 1 : dist >= 40 ? 0.5 : 0;
  return Math.max(2, Math.min(5, Math.round(s)));
}
// Manual override (edits[zip].difficulty) wins over the auto score.
function difficultyFor(zip){
  const m = +edits[zip]?.difficulty;
  return (m >= 1 && m <= 5) ? m : computeDifficulty(zip);
}

const BASE_LAYERS = {
  // Carto basemaps went API-key-only (watermarked tiles, 2026-08) — both
  // styles now come from keyless providers. Esri's dark canvas has no tiles
  // past z16, so Leaflet upscales them (maxNativeZoom) for house-level zoom.
  dark:      { label:'Dark',      url:'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', opts:{ attribution:'&copy; Esri', maxNativeZoom:16, maxZoom:19 } },
  street:    { label:'Street',    url:'https://tile.openstreetmap.org/{z}/{x}/{y}.png', opts:{ attribution:'&copy; OpenStreetMap contributors', maxZoom:19 } },
  // Satellite reads like Google's: Esri's sharper "Clarity" imagery with the
  // street names and roads drawn over it (and town names). A tile Clarity
  // can't serve falls back to the standard World Imagery tile.
  satellite: { label:'Satellite', url:'https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
               fallbackUrl:'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
               opts:{ attribution:'&copy; Esri, Maxar, Earthstar Geographics', maxNativeZoom:19, maxZoom:19 },
               labelsUrls:['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
                           'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'] },
};
// Layers that were folded into another (a saved choice still works)
const BASE_ALIASES = { hybrid: 'satellite' };

let activeStates = new Set(STATES);
let activeColor  = 'pipeline'; // default: show only in-pipeline ZIPs
let sortKey = 'zip', sortDir = 1;
let byZip   = {};
let selectMode = false, selectedZips = new Set();
let paintMode  = false, paintZip = null;
let drawerZip  = null;
let drawerSecOpen = {};  // drawer section open/closed choices (per session)
let currentView = 'map';
let drawerActiveTab = 'overview';
let overlayOpacity = parseFloat(localStorage.getItem('dispatch_opacity') || '0.55');
let activeLabelsTile = null;
let drawMode = false, drawActive = false, drawPoints = [], drawLine = null;
let knockLayer = null, allKnocks = [], covRenderer = null;
let incidentLayer = null;        // ✕ pins at geocoded incident addresses
let showAllIncidents = true;     // map-wide incident pin overlay — always on so
                                 // the day's incidents can't be missed (forced on
                                 // at load below regardless of saved pref)
let incidentTypeFilter = 'all';  // 'all' | incident type key — filters the overlay
let calYear = null, calMonth = null;

// ─── Storage ─────────────────────────────────────────────────────────────────
// The 314 KB spreadsheet parser is only needed for imports — fetched the
// first time one starts, not on every launch.
let _xlsxLoad = null;
function ensureXLSX(){
  if (window.XLSX) return Promise.resolve();
  if (!_xlsxLoad) _xlsxLoad = new Promise((res, rej) => {
    const sc = document.createElement('script');
    sc.src = 'https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js';
    // Subresource integrity: the browser refuses the file if the CDN ever
    // serves different bytes. Change both lines together, and CDN_SCRIPT in
    // lib/security.js (the CSP allows this one file, not all of unpkg).
    sc.integrity = 'sha384-vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw';
    sc.crossOrigin = 'anonymous';
    sc.onload = () => res(); sc.onerror = () => { _xlsxLoad = null; rej(new Error('xlsx failed to load')); };
    document.head.appendChild(sc);
  });
  return _xlsxLoad;
}

// States a user's office works, loaded before the others.
// Bump DATA_V whenever a file in public/data changes: the URLs are cached as
// immutable, so this is what gets a polygon fix onto phones.
const DATA_V = '2026-10-08';
const STATE_FILES = Object.fromEntries(REGIONS.map(r => [r.code, `${r.file}${String(r.file).includes('?') ? '&' : '?'}v=${DATA_V}`]));
function officeStates(office){
  const own = OFFICE_LIST.find(o => o.key === office)?.regions || [];
  if (own.length) return own.filter(st => STATE_FILES[st]);
  return [...new Set(OFFICE_LIST.flatMap(o => o.regions || []))].filter(st => STATE_FILES[st]);
}

function loadStorage(){
  try {
    const c = localStorage.getItem('dispatch_colors'); if (c) COLORS = { ...COLOR_DEFAULTS, ...JSON.parse(c) };
    const e = localStorage.getItem('dispatch_edits');  if (e) edits  = cleanEdits(JSON.parse(e));
  } catch {}
}
const saveColors = () => localStorage.setItem('dispatch_colors', JSON.stringify(COLORS));

// ── Toast notifications ──────────────────────────────────────────────────────
let toastTimer = null;
function toast(msg, type = 'info'){
  let el = document.getElementById('appToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'appToast';
    el.className = 'app-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = `app-toast app-toast-${type} visible`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 3500);
}

// ── Delta saves ──────────────────────────────────────────────────────────────
// Only the changed fields for the changed ZIPs go to the server. null = remove
// the field (server converts to $unset). Never POST the whole edits object —
// that clobbers other users' concurrent changes.
let pendingSaves = 0;
function postEdits(payload){
  pendingSaves++;
  return fetch('/api/edits', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(payload)
  }).then(async r => {
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || `Save failed (${r.status})`);
    }
  }).catch(err => {
    toast(`⚠ ${err.message} — restoring server data`, 'error');
    // Roll the optimistic local change back to server truth so a failed save
    // can't linger in localStorage as a ghost edit
    setTimeout(() => syncFromServer(true), 400);
  }).finally(() => { pendingSaves = Math.max(0, pendingSaves - 1); });
}

function patchEdit(zip, patch){
  edits[zip] = { ...(edits[zip]||{}), ...patch };
  localStorage.setItem('dispatch_edits', JSON.stringify(edits));
  return postEdits({ [zip]: patch });
}

function patchEditsBulk(patchByZip){
  Object.entries(patchByZip).forEach(([zip, patch]) => {
    edits[zip] = { ...(edits[zip]||{}), ...patch };
  });
  localStorage.setItem('dispatch_edits', JSON.stringify(edits));
  return postEdits(patchByZip);
}

// Edits shadow master fields. The server validates new writes, but older
// rows were stored as given, so the board re-checks on load: fields it does
// arithmetic on (households, distances, drive/transit minutes) become finite
// numbers, key fields (status colour, stage, day, hub, office, dates) must look
// like keys, and anything else is dropped. Free text is escaped where drawn.
const NUMERIC_EDIT_RE = /^(households|(dist_miles|drive_mins|transit_mins)(_[A-Za-z0-9_]+)?)$/;
const KEY_EDIT_RE = { color: /^[A-Z]{1,16}$/, pipeline_stage: /^[a-z_]{1,32}$/, delivery_day: /^(mon|tue|wed|thu|fri|sat|sun)?$/,
  hub: /^[A-Za-z0-9_-]{0,40}$/, office: /^[A-Za-z0-9_-]{0,40}$/, work_date: /^(\d{4}-\d{2}-\d{2})?$/, blocked_by: /^[A-Za-z0-9 ]{0,12}$/ };
// The only fields that hold a list or an object; every other one is plain text,
// a number or true/false. Lookups check own keys only so a stored field named
// like an Object.prototype member (constructor, toString, …) can't stand in
// for a rule, and one bad field is dropped without aborting the board's boot.
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const OBJECT_EDIT_FIELDS = { incidents: 'array', constraints: 'object', day_change: 'object' };
function cleanEdits(obj){
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  for (const [zip, e] of Object.entries(obj)) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) { delete obj[zip]; continue; }
    for (const k of Object.keys(e)) {
      try {
        if (k in Object.prototype) { delete e[k]; continue; }
        const v = e[k];
        if (v == null) continue;
        if (NUMERIC_EDIT_RE.test(k)) {
          const n = Number(v);
          if (Number.isFinite(n)) e[k] = n; else delete e[k];
        } else if (hasOwn(KEY_EDIT_RE, k)) {
          if (!(typeof v === 'string' && KEY_EDIT_RE[k].test(v))) delete e[k];
        } else if (hasOwn(OBJECT_EDIT_FIELDS, k)) {
          const wantArray = OBJECT_EDIT_FIELDS[k] === 'array';
          if (typeof v !== 'object' || Array.isArray(v) !== wantArray) delete e[k];
        } else if (typeof v === 'object') {
          delete e[k];
        }
      } catch { delete e[k]; }
    }
  }
  return obj;
}

function applyEdits(){
  MASTER = MASTER_ORIG.map(r => { const e = edits[r.zip]; return e ? { ...r, ...e } : r; });
  byZip  = Object.fromEntries(MASTER.map(r => [r.zip, r]));
}

// ── Live sync ────────────────────────────────────────────────────────────────
// The server is the source of truth. Poll it so edits made by other users show
// up without a reload, and so failed saves get rolled back to server state.
let lastSyncSnapshot = null;
let lastSyncVersion = {};
let syncInFlight = false;

async function syncFromServer(force = false){
  // Never yank state out from under an active drawing/erasing session or an
  // in-flight save (except a forced rollback after a failed save)
  if (syncInFlight || drawMode || actionStack.length) return;
  if (!force && pendingSaves > 0) return;
  syncInFlight = true;
  try {
    // One small request says whether edits or strokes changed; only then
    // are the bodies fetched (they are 0.8 MB and 2 MB on the wire).
    const ver = await fetch('/api/sync/version', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null);
    const editsChanged  = force || !ver || ver.edits !== lastSyncVersion.edits;
    const knocksChanged = force || !ver || ver.knocks !== lastSyncVersion.knocks;
    if (!editsChanged && !knocksChanged) return;
    const [serverEdits, knocksResp] = await Promise.all([
      editsChanged  ? fetch('/api/edits').then(r => r.ok ? r.json() : null).catch(() => null) : Promise.resolve(null),
      knocksChanged ? fetch('/api/knocks').then(r => r.ok ? r.json() : null).catch(() => null) : Promise.resolve(null),
    ]);
    // A version is only "seen" once its body has landed — a blip mid-fetch
    // must not skip that change until the next unrelated one.
    if (ver && serverEdits) lastSyncVersion.edits = ver.edits;
    if (ver && knocksResp?.knocks) lastSyncVersion.knocks = ver.knocks;
    if (knocksResp?.knocks) {
      allKnocks = knocksResp.knocks;
      const el0 = document.activeElement;
      if (!(el0 && /^(INPUT|TEXTAREA|SELECT)$/.test(el0.tagName)) && !document.querySelector('.modal-overlay.open')) renderKnocks(showAllCoverage ? '__ALL__' : drawerZip);
    }
    if (knocksResp?.warming) retryKnocksWarm();
    if (serverEdits && typeof serverEdits === 'object') {
      const snapshot = JSON.stringify(serverEdits);
      if (force || snapshot !== lastSyncSnapshot) {
        lastSyncSnapshot = snapshot;
        edits = cleanEdits(serverEdits);
        localStorage.setItem('dispatch_edits', snapshot);
        applyEdits();
        refreshAllStyles();
        updateStats();
        // Don't rebuild interactive views mid-interaction — a re-render would
        // wipe an input being typed in or close an open modal flow
        const el = document.activeElement;
        const typing = el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
        const modalOpen = document.querySelector('.modal-overlay.open') ||
          document.getElementById('addTerritoriesOverlay')?.classList.contains('open') ||
          document.getElementById('importOverlay')?.classList.contains('open');
        if (!typing && !modalOpen) {
          if (currentView === 'pipeline') renderPipeline();
          if (currentView === 'calendar') renderCalendar();
          renderKnocks(drawerZip);
          refreshIncidentPins();
        }
      }
    }
  } finally { syncInFlight = false; }
}

function startLiveSync(){
  fetch('/api/sync/version', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(v => { if (v) lastSyncVersion = { ...v, edits: lastSyncVersion.edits || v.edits }; }).catch(() => {});
  setInterval(() => { if (!document.hidden) syncFromServer(); }, 45000);
}

// Registered once the app is up. A first install no longer reloads the page
// (that used to cancel every download in flight); a later update just offers
// a tap-to-refresh so nobody is yanked mid-shift.
function registerServiceWorker(){
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || document.getElementById('swToast')) return;
    const t = document.createElement('div');
    t.id = 'swToast'; t.className = 'sw-toast'; t.textContent = 'CGTerritory updated — tap to refresh';
    t.addEventListener('click', () => location.reload());
    document.body.appendChild(t);
  });
}

// The server re-reads the sales sheet after the client's morning sync lands
// (settings.sales.refreshTimes) + hourly-on-demand + the "Sync sales" button below.
// An open PWA session should pick that up without a manual reload, so poll the
// cheap in-memory-cached endpoint every 30 min and rebuild the sales pins ONLY
// when the server's lastUpdated actually changes (no needless 25k-marker redraws).
let salesLastUpdated = null;

// Fold a /api/sales-by-zip response into the in-memory sales state and rebuild
// the map layers. Shared by the initial load, the 30-min poll, the topbar Sync
// button, and the per-ZIP drawer refresh so they can't drift apart. Returns true
// if data landed, false for an empty/failed response.
function applySalesResponse(resp){
  if (!resp || !resp.data) return false;
  salesByZip = resp.data;
  if (resp.strongWeekByZip) strongWeekByZip = resp.strongWeekByZip;
  if (resp.datesByZip) salesDatesByZip = resp.datesByZip;
  if (Array.isArray(resp.pins)) { salesPins = resp.pins; markSalesPinGeo(); }
  if (resp.lastUpdated) salesLastUpdated = resp.lastUpdated;
  buildSalesLayer(); buildSalesPinsLayer();
  return true;
}

// Human-readable "last synced" stamp in the board's timezone.
function fmtSalesUpdated(){
  if (!salesLastUpdated) return 'never';
  try {
    return new Date(salesLastUpdated).toLocaleString('en-US', {
      timeZone:BOARD_TZ, month:'short', day:'numeric',
      hour:'numeric', minute:'2-digit', timeZoneName:'short',
    });
  } catch { return salesLastUpdated; }
}

// Re-render whatever view is on screen so refreshed sales/balances show at once.
function rerenderCurrentView(){
  renderTable();
  if (currentView === 'pipeline') renderPipeline();
  else if (currentView === 'calendar') renderCalendar();
  else if (currentView === 'balance') renderBalance();
  updateStats();
}

function startSalesAutoRefresh(){
  setInterval(async () => {
    if (document.hidden) return;
    try {
      const resp = await fetch('/api/sales-by-zip').then(r => r.json());
      if (!resp || !resp.lastUpdated || resp.lastUpdated === salesLastUpdated) return;
      applySalesResponse(resp);
    } catch {}
  }, 30 * 60 * 1000);
}

// Topbar "↻ Sync sales" — pull the newest sales/pins/balances on demand, for the
// mornings the client's sheet lands late or someone just needs it now.
function wireSalesSync(){
  const btn = document.getElementById('syncSalesBtn');
  if (!btn) return;
  const setTitle = () => { btn.title = `Latest sales sync: ${fmtSalesUpdated()}. Click to pull the newest sales, pins & balances now.`; };
  setTitle();
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = '↻ Syncing…';
    try {
      const resp = await fetch('/api/sales-by-zip?refresh=1').then(r => r.json());
      if (applySalesResponse(resp)) {
        rerenderCurrentView();
        toast(`Sales synced — updated ${fmtSalesUpdated()}`, 'ok');
      } else {
        toast('Sync returned no sales data', 'error');
      }
      if (resp?.error) toast(`Sheet sync warning: ${resp.error}`, 'error');
    } catch(e) {
      toast(`Sync failed: ${e.message}`, 'error');
    } finally {
      btn.textContent = label; btn.disabled = false; setTitle();
    }
  });
}

// Topbar "↻ Sync doors" — ask the field app to push its latest doors now, for
// the moments its own schedule is too far away. The server call covers the
// whole chain (field app → push → geocode → store rewarm), so it can take a
// couple of minutes. Needs FIELD_APP_SYNC_URL on the server.
function wireDoorsSync(){
  const btn = document.getElementById('syncDoorsBtn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = '↻ Syncing…';
    try {
      const r = await fetch('/api/worked-doors/sync', { method: 'POST' });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d || d.error) throw new Error(d?.error || `HTTP ${r.status}`);
      await loadWorkedDoors();
      const fresh = d.newDoors || 0;
      toast(fresh ? `Doors synced — ${fresh} new pin${fresh === 1 ? '' : 's'} from ${FIELD_APP_NAME}`
                  : 'Doors synced — already up to date', 'ok');
      const bad = (d.days || []).find(x => x.error);
      if (bad) toast(`Sync warning ${bad.date}: ${bad.error}`, 'error');
    } catch(e) {
      toast(`Door sync failed: ${e.message}`, 'error');
    } finally {
      btn.textContent = label; btn.disabled = false;
    }
  });
}

// ── Per-user preferences ─────────────────────────────────────────────────────
// Map/filter settings saved server-side per user, so they survive refresh,
// re-login, and follow the user across devices. Applied before UI builds.
const isSectorLeader = () => currentUser?.role === 'sector_leader';
const isAdmin        = () => currentUser?.role === 'admin';

// Saved dates are YYYY-MM-DD or nothing (the server checks too).
const prefDate = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) ? v : null;
function applyPrefs(p){
  if (!p || typeof p !== 'object') return;
  if (Array.isArray(p.activeStates)) {
    const valid = p.activeStates.filter(s => STATES.includes(s));
    if (valid.length) activeStates = new Set(valid);
  }
  if (typeof p.overlayOpacity === 'number' && p.overlayOpacity >= .05 && p.overlayOpacity <= .9)
    overlayOpacity = p.overlayOpacity;
  if (p.baseLayer && BASE_LAYERS[BASE_ALIASES[p.baseLayer] || p.baseLayer]) localStorage.setItem('dispatch_base', BASE_ALIASES[p.baseLayer] || p.baseLayer);
  if (p.deliveryFilter === 'all' || DELIVERY_DAYS.some(d => d.key === p.deliveryFilter))
    deliveryFilter = p.deliveryFilter;
  if (p.hubFilter === 'all' || HUBS.some(h => h.key === p.hubFilter))
    hubFilter = p.hubFilter;
  if ((p.activeOffice === 'all' || isOfficeKey(p.activeOffice)) && canSwitchOffice())
    activeOffice = p.activeOffice;
  if (['all','today','yesterday','last7','last30','custom'].includes(p.coverageFilterMode))
    coverageFilterMode = p.coverageFilterMode;
  if (typeof p.coverageFrom === 'string') coverageFrom = prefDate(p.coverageFrom);
  if (typeof p.coverageTo === 'string') coverageTo = prefDate(p.coverageTo);
  showAllCoverage  = !!p.showAllCoverage;
  showAllIncidents = true;  // always-on: ignore any saved-off pref
  if (p.incidentTypeFilter === 'all' || INCIDENT_TYPES.some(t => t.key === p.incidentTypeFilter))
    incidentTypeFilter = p.incidentTypeFilter;
  showDifficulty = !!p.showDifficulty && !isSectorLeader();  // admin/client only
  showSalesLayer = !!p.showSalesLayer;
  showSalesOnly  = !!p.showSalesOnly;
  showSalesPins  = !!p.showSalesPins;
  if (['all','yesterday','week','month','3m','6m','custom'].includes(p.salesPinDateMode))
    salesPinDateMode = p.salesPinDateMode;
  if (typeof p.salesPinFrom === 'string') salesPinFrom = prefDate(p.salesPinFrom);
  if (typeof p.salesPinTo === 'string') salesPinTo = prefDate(p.salesPinTo);
  showWorkedDoors = !!p.showWorkedDoors;
  if (['today','yesterday','thisweek','lastweek','last7','last30','last90','last6mo','custom'].includes(p.workedDoorMode)) workedDoorMode = p.workedDoorMode;
  if (typeof p.workedDoorFrom === 'string') workedDoorFrom = prefDate(p.workedDoorFrom);
  if (typeof p.workedDoorTo === 'string') workedDoorTo = prefDate(p.workedDoorTo);
  if (typeof p.showHelpers === 'boolean') {
    showHelpers = p.showHelpers;
    try { localStorage.setItem('cgt_helpers', showHelpers ? '1' : '0'); } catch {}
  }
}

let prefsSaveTimer = null;
function savePrefs(){
  if (VIEW_MODE || !currentUser) return;
  clearTimeout(prefsSaveTimer);
  prefsSaveTimer = setTimeout(() => {
    fetch('/api/prefs', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        activeStates: [...activeStates],
        baseLayer: localStorage.getItem('dispatch_base') || 'street',
        overlayOpacity,
        deliveryFilter,
        hubFilter,
        activeOffice,
        coverageFilterMode, coverageFrom: coverageFrom || '', coverageTo: coverageTo || '',
        showAllCoverage, showAllIncidents, incidentTypeFilter,
        showDifficulty, showSalesLayer, showSalesOnly, showSalesPins,
        salesPinDateMode, salesPinFrom: salesPinFrom || '', salesPinTo: salesPinTo || '',
        showWorkedDoors, workedDoorMode,
        workedDoorFrom: workedDoorFrom || '', workedDoorTo: workedDoorTo || '',
        showHelpers,
      }),
    }).catch(() => {});
  }, 600);
}

// ── Page helpers ─────────────────────────────────────────────────────────────
// The small ⓘ buttons that open a page's guide (GUIDES, at the bottom of this
// file). On by default; the Account switch hides every one at once. Saved with
// the other prefs so it follows the user, and in localStorage so the first
// paint already has it right.
let showHelpers = (() => { try { return localStorage.getItem('cgt_helpers') !== '0'; } catch { return true; } })();
const helpBtn = (guide, sec = '', cls = '') =>
  `<button type="button" class="help-i${cls ? ' ' + cls : ''}" data-help="${guide}"${sec ? ` data-help-sec="${sec}"` : ''} aria-label="How this works" title="How this works">i</button>`;

function applyHelpers(){
  document.body.classList.toggle('helpers-off', !showHelpers);
  const chk = document.getElementById('mobHelpersChk');
  if (chk) chk.checked = showHelpers;
  const st = document.getElementById('helpersState');
  if (st) { st.textContent = showHelpers ? 'On' : 'Off'; st.classList.toggle('on', showHelpers); }
}
function setHelpers(on){
  showHelpers = !!on;
  try { localStorage.setItem('cgt_helpers', showHelpers ? '1' : '0'); } catch {}
  applyHelpers(); savePrefs();
}
applyHelpers();

// Sign out: end the session on the server, then drop every offline copy
// this device holds (territory files, the Do-Not-Knock list, the app shell),
// so the next person on a shared phone starts from nothing.
async function signOut(){
  try { await fetch('/api/auth/logout', { method:'POST' }); } catch {}
  try { if (window.caches) await Promise.all((await caches.keys()).map(k => caches.delete(k))); } catch {}
  location.replace('/login');
}

// ─── Boot ────────────────────────────────────────────────────────────────────
init();
async function init(){
  // init() is called halfway down this file. The normal boot waits on
  // /api/auth/me before doing anything, which lets the rest of the file load
  // first; the view-mode boot skips that wait and used to build the map
  // before constants further down existed (INCIDENT_PIN_METERS crashed it).
  await null;
  // Auth check — redirect to login if session invalid (skip for /view mode)
  if (!VIEW_MODE) {
    try {
      const authResp = await fetch('/api/auth/me');
      if (!authResp.ok) { location.replace('/login'); return; }
      const { user } = await authResp.json();
      currentUser = user;
      if (isOfficeKey(user.office)) activeOffice = user.office;
    } catch { location.replace('/login'); return; }
  }

  loadStorage();
  // The map first: tiles are on screen within a second or two. The ZIP
  // polygons stream in state by state behind it (the office's states
  // first), edits arrive from the server's RAM store, and sales pins load
  // off the critical path. Nothing here waits on the slowest download.
  buildMap();
  // The map is created before the phone's layout has settled (fonts, chips,
  // table collapse, safe areas). Leaflet sizes its tile grid and vector
  // layer from the size it saw at creation — a stale size leaves a band of
  // missing tiles and clips every polygon to a rectangle — so re-measure
  // whenever the container's size changes, and once more after boot.
  const mapEl = document.getElementById('map');
  if (window.ResizeObserver && mapEl) {
    let rsTimer = null;
    new ResizeObserver(() => { clearTimeout(rsTimer); rsTimer = setTimeout(() => map.invalidateSize(false), 80); }).observe(mapEl);
  }
  window.addEventListener('load', () => map.invalidateSize(false));
  [600, 1500, 3500].forEach(t => setTimeout(() => map.invalidateSize(false), t));
  const bootChip = document.getElementById('bootChip');
  const [master, serverEdits, serverPrefs, goalsResp] = await Promise.all([
    fetch(`/data/master.json?v=${DATA_V}`).then(r=>r.json()),
    fetch('/api/edits').then(r => { if (!r.ok) return null; lastSyncVersion.edits = r.headers.get('ETag') || null; return r.json(); }).catch(() => null),
    VIEW_MODE ? Promise.resolve(null)
              : fetch('/api/prefs').then(r => r.ok ? r.json() : null).catch(() => null),
    fetch('/api/hub-goals').then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  MASTER_ORIG = master;
  if (Array.isArray(goalsResp?.goals)) goalsResp.goals.forEach(g => { if (g && HUBS.some(h => h.key === g.hub)) hubGoals[g.hub] = g; });
  // Server is authoritative; localStorage is only an offline fallback.
  // (Merging local over server used to resurrect ghost edits from failed saves.)
  if (serverEdits && typeof serverEdits === 'object') {
    edits = cleanEdits(serverEdits);
    lastSyncSnapshot = JSON.stringify(serverEdits);
    localStorage.setItem('dispatch_edits', lastSyncSnapshot);
  }
  applyEdits();
  applyPrefs(serverPrefs);  // per-user saved filters/toggles — before any UI builds
  applyHelpers();
  buildChips(); buildCoverageControl();

  const firstStates = officeStates(activeOffice);
  const stateOrder = [...firstStates, ...STATES.filter(st => !firstStates.includes(st) && STATE_FILES[st])];
  let officePending = firstStates.length, statesPending = stateOrder.length;
  const stateLoads = stateOrder.map(st => fetch(STATE_FILES[st]).then(r => r.ok ? r.json() : null).catch(() => null).then(gj => {
    if (gj) { GEO[st] = gj; addStateLayer(st); }
    if (firstStates.includes(st) && --officePending === 0) { bootChip?.classList.add('hide'); map.invalidateSize(false); }
    if (--statesPending === 0) { bootChip?.classList.add('hide'); renderTable(); updateStats(); map.invalidateSize(false); }
  }));
  const officeLoads = stateLoads.slice(0, firstStates.length);
  const salesLoad = fetch('/api/sales-by-zip').then(r=>r.json()).catch(()=>({ data:{} })).then(salesResp => {
    if (salesResp?.data) salesByZip = salesResp.data;
    if (salesResp?.strongWeekByZip) strongWeekByZip = salesResp.strongWeekByZip;
    if (Array.isArray(salesResp?.pins)) salesPins = salesResp.pins;
    if (salesResp?.datesByZip) salesDatesByZip = salesResp.datesByZip;
    if (salesResp?.lastUpdated) salesLastUpdated = salesResp.lastUpdated;
  });
  // Sales pins show as soon as the office's own states are in; the flag for
  // bad geocodes waits for every state, since it tests every polygon.
  Promise.all([salesLoad, ...officeLoads]).then(() => { buildSalesLayer(); buildSalesPinsLayer(); refreshAllStyles(); updateStats(); });
  Promise.all([salesLoad, ...stateLoads]).then(() => {
    markSalesPinGeo();  // flag bad geocodes once GEO polygons are loaded
    buildSalesPinsLayer();
    refreshAllStyles(); updateStats();
    const editing = document.getElementById('drawerCancelBtn') || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (drawerZip && !editing) renderDrawerWithTab(drawerZip, drawerActiveTab);
  });
  loadKnocks().then(() => { if (showAllCoverage) renderKnocks('__ALL__'); });
  renderTable(); wireControls();
  buildColorEditor(); wireActionBar();
  if (!VIEW_MODE) buildPaintPicker();
  wireImport(); wireDragSelect(); wireMobile(); updateLegend(); wireSalesSync(); wireDoorsSync();
  wireViewTabs(); wireAddTerritories(); buildOfficeSwitcher(); updateStats();
  wireTableCollapse();
  // Worked doors are the biggest download; they come after the map is usable.
  // The switch itself is drawn now either way — it used to appear only once
  // doors had loaded, so with the layer off it never showed up at all.
  if (currentUser && showWorkedDoors) (window.requestIdleCallback || (f => setTimeout(f, 1500)))(() => loadWorkedDoors());
  else renderWorkedDoorsToggle();

  // Restore map state from saved prefs
  if (activeStates.size < STATES.length) refreshMapVisibility();
  if (showAllIncidents) refreshIncidentPins();

  if (VIEW_MODE) applyViewMode();
  if (!VIEW_MODE && currentUser) applyAuth();
  wireHelpers();
  startLiveSync();
  map.invalidateSize(false);
  registerServiceWorker();
  startSalesAutoRefresh();

  // Re-measure map after CSS fixed-layout settles (especially on mobile)
  setTimeout(() => map?.invalidateSize(true), 300);
}

function applyViewMode(){
  // Hide edit action buttons from topbar
  const actionsHide = ['paintModeBtn','selectModeBtn','importBtn','colorEditorBtn','addTerritoriesBtn'];
  actionsHide.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
  // Hide pipeline view tab
  document.querySelectorAll('.view-tab[data-view="pipeline"]').forEach(el => el.style.display = 'none');
  // Hide mobile pipeline tab
  document.querySelectorAll('.mob-tab[data-tab="pipeline"]').forEach(el => el.style.display = 'none');
  // Hide mobile action buttons
  ['mobAddBtn','mobPaintBtn','mobSelectBtn','mobImportBtn','mobColorsBtn'].forEach(id => {
    const el = document.getElementById(id); if (el) el.style.display = 'none';
  });
  // Add client view badge to brand
  const brandText = document.querySelector('.brand-text');
  if (brandText) {
    const badge = document.createElement('span');
    badge.className = 'view-mode-badge';
    badge.textContent = 'Client View';
    brandText.appendChild(badge);
  }
}

// ─── Polygon area (sq miles, equirectangular shoelace) ───────────────────────
function polygonAreaSqMi(zip) {
  const layer = layerByZip[zip]; if (!layer) return 0;
  let poly = layer.getLatLngs();
  // getLatLngs() returns [[LatLng,...]] for polygons — unwrap one level
  if (Array.isArray(poly[0])) poly = poly[0];
  if (!poly || poly.length < 3) return 0;
  const n = poly.length;
  const latRad = poly.reduce((s,p) => s + p.lat, 0) / n * Math.PI / 180;
  const cosLat = Math.cos(latRad);
  const R = 3958.8; // miles
  let area = 0;
  for (let i = 0, j = n-1; i < n; j = i++) {
    const xi = poly[i].lng * cosLat * Math.PI / 180 * R;
    const yi = poly[i].lat * Math.PI / 180 * R;
    const xj = poly[j].lng * cosLat * Math.PI / 180 * R;
    const yj = poly[j].lat * Math.PI / 180 * R;
    area += (xj + xi) * (yj - yi);
  }
  return Math.abs(area / 2);
}

// ─── View tabs ───────────────────────────────────────────────────────────────
function wireViewTabs(){
  document.querySelectorAll('.view-tab').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
  // Only the view-tabs select here; the layer-switcher copy is wired in
  // buildLayerSwitcher (it's rebuilt independently). setDeliveryFilter keeps
  // all copies in sync.
  const sel = document.getElementById('deliveryFilter');
  if (sel) {
    sel.value = deliveryFilter;
    sel.addEventListener('change', () => setDeliveryFilter(sel.value));
  }
  const hubSel = document.getElementById('hubFilter');
  if (hubSel) {
    hubSel.innerHTML = `<option value="all">All hubs</option>` +
      HUBS.map(h => `<option value="${h.key}">${h.label}</option>`).join('');
    hubSel.value = hubFilter;
    hubSel.addEventListener('change', () => setHubFilter(hubSel.value));
  }
}

// Filter map/pipeline/schedule to a single delivery day (or 'all')
function setDeliveryFilter(day){
  deliveryFilter = day || 'all';
  document.querySelectorAll('.delivery-filter-sel').forEach(s => { if (s.value !== deliveryFilter) s.value = deliveryFilter; });
  refreshAllStyles();
  renderPipeline();
  renderCalendar();
  updateStats();   // also refreshes the today bar
  savePrefs();
}

// Filter map/pipeline/schedule to a single distribution hub (or 'all')
function setHubFilter(hub){
  hubFilter = hub || 'all';
  document.querySelectorAll('.hub-filter-sel').forEach(s => { if (s.value !== hubFilter) s.value = hubFilter; });
  if (hubFilter !== 'all') balanceHub = hubFilter;   // keep the balance view on the hub you're looking at
  refreshAllStyles();
  renderPipeline();
  renderCalendar();
  renderBalance();
  updateStats();   // also refreshes the today bar
  savePrefs();
}

// Sector leaders don't get the Pipeline or Schedule, and the read-only view
// doesn't get the Pipeline. The tabs are hidden in applyAuth/applyViewMode;
// this keeps every other way in (Balance's board buttons, the stats bar) shut.
const canSeeView = view =>
  !((view === 'pipeline' || view === 'calendar') && isSectorLeader()) && !(view === 'pipeline' && VIEW_MODE);

function switchView(view){
  if (!canSeeView(view)) return;
  currentView = view;
  const statsBar = document.getElementById('statsBar');
  if (statsBar) statsBar.style.display = view === 'map' ? 'none' : '';
  document.getElementById('mapTableView').style.display   = view === 'map'      ? '' : 'none';
  document.getElementById('pipelineView').style.display   = view === 'pipeline' ? 'flex' : 'none';
  document.getElementById('calendarView').style.display   = view === 'calendar' ? 'flex' : 'none';
  const balEl = document.getElementById('balanceView');
  if (balEl) balEl.style.display = view === 'balance' ? 'flex' : 'none';
  document.querySelectorAll('.view-tab').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.mob-tab[data-tab]').forEach(b => {
    if (b.dataset.tab !== 'menu') b.classList.toggle('active', b.dataset.tab === view);
  });
  // Mobile floating "+" — pipeline view, editors only
  const fab = document.getElementById('mobAddFab');
  if (fab) fab.style.display =
    (view === 'pipeline' && isMob() && !VIEW_MODE && currentUser && currentUser.role !== 'sector_leader') ? 'flex' : 'none';
  updateOfficeBarVisibility();
  if (view === 'pipeline') renderPipeline();
  if (view === 'calendar') renderCalendar();
  if (view === 'balance')  renderBalance();
  if (view === 'map') setTimeout(() => map.invalidateSize(), 50);
}

// ─── Scheduled delivery-day moves ────────────────────────────────────────────
// edits[zip].day_change = { to:'tue', on:'YYYY-MM-DD' }: the client re-routes
// the ZIP to another delivery day on that date. Until then it's ON HOLD — a
// customer signed today would need their day changed straight away. The server
// flips delivery_day when the date arrives; here it's a chip, and held ZIPs
// sink to the bottom of every "work next" list.
function dayChangeFor(zip){
  const dc = edits[zip]?.day_change;
  return dc && dc.to && /^\d{4}-\d{2}-\d{2}$/.test(dc.on || '') ? dc : null;
}
const onHold = zip => !!dayChangeFor(zip);
function holdChipHtml(zip, cls = ''){
  const dc = dayChangeFor(zip);
  if (!dc) return '';
  const day = DELIVERY_DAYS.find(d => d.key === dc.to)?.label || dc.to;
  return `<span class="hold-chip${cls ? ' ' + cls : ''}" title="Client is moving this ZIP to ${day} on ${dc.on} — don't work it until then">⏸ hold · → ${dayShort(dc.to)} ${fmtConDate(dc.on)}</span>`;
}

// ─── Hub day balance ─────────────────────────────────────────────────────────
// A client can cap sales per delivery day per hub and rotate once a day fills
// ("N sales on each delivery day, then rotate back through to keep the
// balance"). A cycle is one pass through every delivery day; a day is done
// when it hits the cap, and the cycle restarts once all days have.
//
// Rotation is deliberately NOT automatic — the cycle only advances when someone
// presses "Start new cycle". An auto-reset would silently wipe the numbers a
// client may be reviewing at month end.
const DEFAULT_HUB_CAP = 50;
const goalFor = hub => ({ cap: DEFAULT_HUB_CAP, caps: {}, plan: {}, cycleStart: '', cycle: 1, history: [], ...(hubGoals[hub] || {}) });
// The target for one delivery day inside a cycle window. A client may send
// different targets per day (Mon 12 … Tue 10); a day without its own number
// falls back to the window's flat cap. A target of 0 is deliberate — the client
// wants no sales on that day this cycle — so it must survive ?? rather than
// collapse to the fallback.
const capFor = (win, day) => win.caps?.[day] ?? win.cap ?? DEFAULT_HUB_CAP;
// Targets the client has booked for a cycle that hasn't started yet. Phase 2 of
// a plan is just cycle 2's numbers, waiting for the rotation that reaches it.
const plannedFor = (hub, cycle) => goalFor(hub).plan?.[String(cycle)] || null;

// Sale dates come off the sales sheet as free text — ISO from a date cell,
// "29-May-26" from a formatted one. Anything unparseable is skipped rather than
// counted at epoch, which would wrongly land it before every cycle start.
function parseSaleDate(s){
  const raw = String(s || '').trim();
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const t = new Date(raw).getTime();
  if (isNaN(t)) return null;
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}

// Sales for one ZIP counted on/after `since` ('' = all time).
function salesSince(zip, since){
  const dates = salesDatesByZip[zip];
  if (!dates) return since ? 0 : (salesByZip[zip] || 0);
  if (!since) return dates.length;
  let n = 0;
  for (const raw of dates) { const d = parseSaleDate(raw); if (d && d >= since) n++; }
  return n;
}

// Sales for one ZIP inside [since, until). The exclusive end is what makes
// cycles partition cleanly — a sale on the day a new cycle starts belongs to
// the new cycle, matching salesSince(zip, newStart) on the current one.
function salesBetween(zip, since, until){
  if (!until) return salesSince(zip, since);
  let n = 0;
  for (const raw of (salesDatesByZip[zip] || [])) {
    const d = parseSaleDate(raw);
    if (d && (!since || d >= since) && d < until) n++;
  }
  return n;
}

// Optional floor for cycle windows (settings.balanceEpoch, 'YYYY-MM-DD'): the
// day you started tracking hub cycles. A past window with no recorded start
// is floored here; without it, a synthesized cycle 1 counts every sale in
// the sales source's whole history.
const BAL_EPOCH = /^\d{4}-\d{2}-\d{2}$/.test(CFG.balanceEpoch || '') ? CFG.balanceEpoch : '';

// Every cycle window we can reconstruct for a hub, oldest first, the live one
// last. Each carries the targets it ran under (history snapshots cap/caps at
// rotation) so changing this month's quotas doesn't rewrite last cycle's board.
// One synthesized window fills the gap before the oldest thing we know about
// (a rotation from before history existed): everything between the balance
// epoch and that start IS the previous cycle. It predates per-day targets, so
// it runs on the flat cap.
function cycleWindowsFor(hub){
  const g = goalFor(hub);
  const wins = (g.history || [])
    .filter(h => h && h.end)
    .map(h => ({ cycle: h.cycle || 1, start: h.start || BAL_EPOCH, end: h.end, current: false,
                 cap: h.cap ?? g.cap, caps: h.caps || {} }))
    .sort((a, b) => a.cycle - b.cycle);
  const cur = { cycle: g.cycle || 1, start: g.cycleStart || '', end: '', current: true, cap: g.cap, caps: g.caps || {} };
  const first = wins[0] || cur;
  if (first.cycle > 1 && first.start && first.start > BAL_EPOCH)
    wins.unshift({ cycle: first.cycle - 1, start: BAL_EPOCH, end: first.start, current: false, cap: g.cap, caps: {} });
  wins.push(cur);
  return wins;
}

// Per-delivery-day totals for a hub. Only days that actually have ZIPs appear —
// a hub that runs Mon–Fri gets no Sat/Sun rows of noise.
function hubBalance(hub, win){
  const zipsByDay = {};
  Object.entries(edits).forEach(([zip, e]) => {
    if (e?.hub !== hub || !e?.delivery_day) return;
    (zipsByDay[e.delivery_day] ||= []).push(zip);
  });
  return DELIVERY_DAYS.filter(d => zipsByDay[d.key]?.length).map(d => {
    const zips = zipsByDay[d.key];
    const cap  = capFor(win, d.key);
    const sold = zips.reduce((n, z) => n + salesBetween(z, win.start, win.end), 0);
    return {
      key: d.key, label: d.label, zips: zips.length, sold, cap,
      remaining: Math.max(0, cap - sold),
      pct: cap > 0 ? Math.min(100, Math.round(sold / cap * 100)) : 0,
      // A 0-target day is paused, not capped. Without the distinction `sold >= 0`
      // reads as instantly finished: the cycle would look complete the moment
      // every other day filled, and the day would never be offered as work next.
      paused: cap === 0,
      capped: cap > 0 && sold >= cap,
    };
  });
}

// "Last worked" = the most recent evidence anyone touched the ZIP: a sale, or a
// coverage stroke drawn on the map. Coverage only goes back 84 days server-side,
// so for older territory the sale date is usually what answers.
function lastWorkedFor(zip){
  let best = null, src = '';
  for (const raw of (salesDatesByZip[zip] || [])) {
    const d = parseSaleDate(raw);
    if (d && (!best || d > best)) { best = d; src = 'sale'; }
  }
  for (const k of allKnocks) {
    if (k.zip !== zip) continue;
    const d = parseSaleDate(k.date);
    if (d && (!best || d > best)) { best = d; src = 'knocked'; }
  }
  return { date: best, src };
}

const todayISO = () => etToday();
// Rounded UP, the way a "Weeks Since Last Sale" column in a territory sheet
// usually counts — 12 days reads as 2 weeks — so the board and the sheet agree.
function weeksSince(iso){
  if (!iso) return null;
  const ms = new Date(todayISO()).getTime() - new Date(iso).getTime();
  return Math.max(0, Math.ceil(ms / (7*24*60*60*1000)));
}

// The hub the balance view is showing. Follows the hub filter when one is set;
// otherwise opens on the first hub in settings (put your busiest first).
let balanceHub = HUBS[0]?.key || '';
// Which cycle each hub's board is showing (cycle number). Absent = the live
// one. Deliberately not persisted — a fresh load always opens on the present.
let balCycleByHub = {};
// Expanded day in the balance view (null = none) and the ZIP sort direction.
// 'stale' = longest-unworked first, which is the order you'd work them in.
let balOpenDay = null;
let balSort = 'stale';

// Balance mode is PER HUB: one hub may run the cycle/cap layout while another
// just wants "where haven't we been" — flipping one hub must not change the
// other. 'cycle' (caps + rotation) | 'workable' (every day open, stalest first,
// sales over a rolling 3 months instead of a cycle window).
let balModeByHub = {};
try { balModeByHub = JSON.parse(localStorage.getItem('dispatch_bal_mode') || '{}') || {}; } catch { balModeByHub = {}; }
const balModeFor = hub => balModeByHub[hub] === 'workable' ? 'workable' : 'cycle';

function isoMonthsAgo(n){
  const [y, m, d] = etToday().split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 - n, d)).toISOString().split('T')[0];
}

function renderBalance(){
  const el = document.getElementById('balanceView');
  if (!el) return;
  const hub = balanceHub;
  if (balModeFor(hub) === 'workable') { renderWorkable(el, hub); return; }
  const { cycleStart } = goalFor(hub);
  const wins = cycleWindowsFor(hub);
  const win = wins.find(w => w.cycle === balCycleByHub[hub]) || wins[wins.length - 1];
  const rows = hubBalance(hub, win);
  const canEdit = !VIEW_MODE && currentUser && currentUser.role !== 'sector_leader';

  if (!rows.length) {
    el.innerHTML = `
      <div class="bal-wrap">
        ${balHeader(hub, cycleStart, wins, win, canEdit)}
        <div class="bal-empty">No ZIPs are tagged to this hub yet, or none of them have a delivery day.<br>
        Import the hub's territory sheet, or set the hub on a ZIP from its drawer.</div>
      </div>`;
    wireBalance();
    return;
  }

  const totalSold = rows.reduce((n, r) => n + r.sold, 0);
  const totalCap  = rows.reduce((n, r) => n + r.cap, 0);
  // Paused days sit outside the cycle: they can't fill, so they can't hold the
  // rotation open, and a hub where every working day is capped is still done.
  const working   = rows.filter(r => !r.paused);
  const allCapped = working.length > 0 && working.every(r => r.capped);
  // "Work next" = the open day with the most headroom, which is what keeps the
  // hub balanced rather than just filling whichever day is easiest. A finished
  // cycle has no next — its board is a record, not a to-do list.
  const next = win.current ? working.filter(r => !r.capped).sort((a,b) => b.remaining - a.remaining)[0] : null;
  // Past cycles answer "how balanced were we" — each day's share of the cycle's
  // sales, the number a client tends to quote back ("Wed+Fri were half").
  const share = r => totalSold ? Math.round(r.sold / totalSold * 100) : 0;

  el.innerHTML = `
    <div class="bal-wrap">
      ${balHeader(hub, cycleStart, wins, win, canEdit)}
      ${balTargets(rows, win, canEdit, totalCap, hub)}
      ${allCapped && win.current ? `<div class="bal-banner bal-banner-done">
        ✓ Every working delivery day has hit its cap — rotate back through by starting a new cycle.
      </div>` : ''}
      ${win.current && rows.some(r => r.paused && r.sold) ? `<div class="bal-banner bal-banner-warn">
        ${rows.filter(r => r.paused && r.sold).map(r => `${r.sold} sold on ${r.label}`).join(' · ')} —
        this cycle sets no target there. Check the day's ZIPs are meant to be worked.
      </div>` : ''}
      <div class="bal-rows">
        ${rows.map(r => `
          <div class="bal-group">
            <button class="bal-row${r.capped ? ' bal-capped' : ''}${r.paused ? ' bal-paused' : ''}${next && r.key === next.key ? ' bal-next' : ''}${balOpenDay === r.key ? ' bal-open' : ''}"
                    data-bal-day="${r.key}" title="${r.paused ? 'No target this cycle — the client wants no sales on this day. Tap to see its ZIPs anyway.' : 'Show this day\'s ZIPs by when they were last worked'}">
              <span class="bal-day"><span class="bal-caret">${balOpenDay === r.key ? '▾' : '▸'}</span> ${r.label}</span>
              <span class="bal-bar"><span class="bal-fill" style="width:${r.pct}%"></span></span>
              <span class="bal-count">${r.sold}${r.paused ? '' : ` / ${r.cap}`}</span>
              <span class="bal-remain">${r.paused ? '⏻ no target' : win.current ? (r.capped ? '✓ capped' : `${r.remaining} to go`) : `${share(r)}% of cycle`}</span>
              <span class="bal-zips">${r.zips} ZIP${r.zips!==1?'s':''}</span>
            </button>
            ${balOpenDay === r.key ? balZipList(hub, r.key, win) : ''}
          </div>`).join('')}
      </div>
      <div class="bal-foot">
        ${win.current ? `<span><b>${totalSold}</b> / ${totalCap} this cycle</span>`
                      : `<span><b>${totalSold}</b> sold in cycle ${win.cycle}</span>`}
        ${next ? `<span class="bal-foot-next">Work next: <b>${next.label}</b> — ${next.remaining} to go</span>` : ''}
        ${!win.current ? `<span class="bal-foot-since">Cycle ${esc(win.cycle)}: ${win.start ? `${esc(win.start)} → ${esc(win.end)}` : `everything before ${esc(win.end)}`}</span>`
          : cycleStart ? `<span class="bal-foot-since">Counting sales since ${esc(cycleStart)}</span>`
                       : `<span class="bal-foot-since bal-warn">Counting all sales ever — set a cycle start</span>`}
      </div>
    </div>`;
  wireBalance();
}

// One hub+day's ZIPs ordered by when they were last worked. Never-worked ZIPs
// sort as the stalest — they're the ones with the most untouched doors.
function balZipList(hub, day, win){
  const list = Object.entries(edits)
    .filter(([zip, e]) => e?.hub === hub && e?.delivery_day === day && byZip[zip])
    .map(([zip]) => {
      const { date, src } = lastWorkedFor(zip);
      return { zip, date, src, hold: onHold(zip), weeks: weeksSince(date), sold: salesBetween(zip, win.start, win.end), total: salesSince(zip, ''), rec: byZip[zip] };
    })
    .sort((a, b) => {
      if (a.hold !== b.hold) return a.hold ? 1 : -1;   // on hold = never "work next", so last
      if (a.date === b.date) return a.zip.localeCompare(b.zip);
      if (!a.date) return balSort === 'stale' ? -1 : 1;   // never worked = stalest
      if (!b.date) return balSort === 'stale' ? 1 : -1;
      return balSort === 'stale' ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date);
    });

  if (!list.length) return `<div class="bal-ziplist"><div class="bal-zip-empty">No ZIPs on this day.</div></div>`;

  return `
    <div class="bal-ziplist">
      <div class="bal-zip-head">
        <span>${list.length} ZIP${list.length!==1?'s':''} · ${balSort === 'stale' ? 'longest unworked first' : 'most recently worked first'}</span>
        <button class="bal-sort-flip" data-bal-flip="1">⇅ Flip order</button>
        ${canSeeView('pipeline') ? `<button class="bal-goboard" data-bal-board="${day}">Open on board →</button>` : ''}
      </div>
      ${list.map(r => `
        <button class="bal-zip-row${!r.date ? ' bal-zip-never' : ''}${r.hold ? ' bal-zip-hold' : ''}" data-bal-zip="${r.zip}" title="Open ${r.zip}">
          <span class="bal-zip-code">${r.zip}</span>
          <span class="bal-zip-town">${holdChipHtml(r.zip)}${esc(r.rec.municipality || r.rec.primary_city || '')}</span>
          <span class="bal-zip-when">${r.date ? `${esc(r.date)} <span class="bal-zip-src">${esc(r.src)}</span>` : 'never worked'}</span>
          <span class="bal-zip-weeks">${r.weeks == null ? '—' : `${r.weeks}w ago`}</span>
          <span class="bal-zip-sold${r.total ? '' : ' wk-sales-zero'}">${r.sold ? `${r.sold} cycle · ` : ''}${r.total} total</span>
        </button>`).join('')}
    </div>`;
}

// Per-day targets strip. Live cycle: editable, each box saves into caps[day].
// Past cycle: the numbers that cycle actually ran under, locked.
//
// Under the live strip sits the next cycle's booking, when the client has sent
// its numbers ahead ("Phase 1 … Phase 2"). It is the same editable strip
// writing into plan[cycle+1]; rotating applies it server-side and clears it, so
// the phase lands without anyone transcribing a table twice.
function balTargets(rows, win, canEdit, totalCap, hub){
  const editable = canEdit && win.current;
  const nextCycle = (win.cycle || 1) + 1;
  const booked = win.current ? plannedFor(hub, nextCycle) : null;
  // Sum what the strip SHOWS, not just what's booked: a day the client hasn't
  // given a number for displays today's target, so the total has to include it
  // or the two lines disagree on screen.
  const bookedTotal = booked ? rows.reduce((n, r) => n + (booked[r.key] ?? r.cap), 0) : 0;
  const box = (day, value, attr, on) => `
    <label class="bal-target"><span>${dayShort(day)}</span>
      <input type="number" min="0" max="100000" data-${attr}="${day}" value="${value}" ${on?'':'disabled'}>
    </label>`;
  return `
    <div class="bal-targets">
      <span class="bal-targets-lbl">${win.current ? 'Targets / day' : `Cycle ${win.cycle} targets`}</span>
      ${rows.map(r => box(r.key, r.cap, 'bal-cap', editable)).join('')}
      <span class="bal-targets-total">= ${totalCap}</span>
      ${editable && !booked ? `<button class="bal-book" id="balBook" title="Enter the targets this hub switches to at the next rotation">+ Book cycle ${nextCycle}</button>` : ''}
    </div>
    ${booked ? `
    <div class="bal-targets bal-targets-next">
      <span class="bal-targets-lbl">Cycle ${nextCycle} booked</span>
      ${rows.map(r => box(r.key, booked[r.key] ?? r.cap, 'bal-plan', editable)).join('')}
      <span class="bal-targets-total">= ${bookedTotal}</span>
      ${editable ? `<button class="bal-book bal-unbook" id="balUnbook" title="Drop the booking — the current targets would carry over instead">× Clear</button>` : ''}
    </div>` : ''}`;
}

function balHeader(hub, cycleStart, wins, win, canEdit){
  // More than one window → the badge becomes a picker so past cycles stay
  // viewable after a rotation. Targets / cycle-start always configure the LIVE
  // cycle, so they lock while a past one is on screen — otherwise editing
  // "Cycle start" under a Cycle 1 header would silently move Cycle 2's fence.
  const cycleCtl = wins.length > 1
    ? `<select class="bal-cycle bal-cycle-sel" id="balCycleSel" title="View another cycle's numbers">
        ${wins.map(w => `<option value="${esc(w.cycle)}" ${w.cycle===win.cycle?'selected':''}>Cycle ${esc(w.cycle)}${w.current?' · now':''}</option>`).join('')}
      </select>`
    : `<span class="bal-cycle">Cycle ${esc(win.cycle)}</span>`;
  const editable = canEdit && win.current;
  return `
    <div class="bal-head">
      <select class="bal-hub-sel" id="balHubSel">
        ${HUBS.map(h => `<option value="${h.key}" ${hub===h.key?'selected':''}>${h.label}</option>`).join('')}
      </select>
      ${balModeToggle(hub)}
      ${helpBtn('balance', 'cycle')}
      ${cycleCtl}
      <div class="bal-head-right">
        <label class="bal-field">Cycle start
          <input type="date" id="balCycleStart" value="${esc(win.current ? cycleStart : win.start)}" ${editable?'':'disabled'}>
        </label>
        ${editable ? `<button class="bal-rotate" id="balRotate" title="Reset the counts and begin the next pass">↻ Start new cycle</button>` : ''}
      </div>
    </div>`;
}

function balModeToggle(hub){
  const mode = balModeFor(hub);
  return `
    <div class="bal-mode" role="tablist">
      <button class="bal-mode-btn${mode==='cycle'?' active':''}" data-bal-mode="cycle" title="Caps per delivery day with cycle rotation">Cycle</button>
      <button class="bal-mode-btn${mode==='workable'?' active':''}" data-bal-mode="workable" title="Every day's ZIPs, longest unworked first, with sales over the last 3 months">Workable</button>
    </div>`;
}

// ─── Workable ZIPs ───────────────────────────────────────────────────────────
// The no-targets layout: every delivery day open at once, days AND their ZIPs
// ordered longest-unworked first, so "where do we go next" is just the top of
// the page. Sales count over a rolling 3 months — there is no cycle here.
//
// "Last worked" here is the last STRONG week — the most recent 7-day stretch
// with 5+ sales (server-computed, week ending Sunday). A lone stray sale or a
// coverage stroke doesn't count as having worked the ZIP; a crew actually on
// the doors does. ZIPs that never had a 5+ week sort as the stalest.
function renderWorkable(el, hub){
  const since = isoMonthsAgo(3);
  const zipsByDay = {};
  Object.entries(edits).forEach(([zip, e]) => {
    if (e?.hub !== hub || !byZip[zip]) return;
    (zipsByDay[e.delivery_day || 'none'] ||= []).push(zip);
  });

  const stale = balSort === 'stale';
  const byWorked = (a, b) => {
    if (!!a.hold !== !!b.hold) return a.hold ? 1 : -1;   // on hold = last, whatever the sort
    if (a.date === b.date) return a.zip ? a.zip.localeCompare(b.zip) : 0;
    if (!a.date) return stale ? -1 : 1;   // never had a 5+ week = stalest
    if (!b.date) return stale ? 1 : -1;
    return stale ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date);
  };

  const groups = [...DELIVERY_DAYS.map(d => ({ key:d.key, label:d.label })), { key:'none', label:'No delivery day' }]
    .filter(d => zipsByDay[d.key]?.length)
    .map(d => {
      const zips = zipsByDay[d.key].map(zip => {
        const date = strongWeekByZip[zip] || null;
        return { zip, date, hold: onHold(zip), weeks: weeksSince(date), sold: salesSince(zip, since), total: salesSince(zip, ''), rec: byZip[zip] };
      }).sort(byWorked);
      // The day was "last worked" when ANY of its ZIPs last had a strong week.
      const last = zips.reduce((m, z) => (z.date && (!m || z.date > m)) ? z.date : m, null);
      return { ...d, zips, last, weeks: weeksSince(last), sold: zips.reduce((n, z) => n + z.sold, 0) };
    })
    .sort((a, b) => {
      // "No delivery day" is a data-hygiene bucket, not a route — pin it last.
      if (a.key === 'none') return 1;
      if (b.key === 'none') return -1;
      return byWorked({ date:a.last, zip:'' }, { date:b.last, zip:'' });
    });

  if (!groups.length) {
    el.innerHTML = `
      <div class="bal-wrap">
        ${workableHeader(hub)}
        <div class="bal-empty">No ZIPs are tagged to this hub yet.<br>
        Import the hub's territory sheet, or set the hub on a ZIP from its drawer.</div>
      </div>`;
    wireBalance();
    return;
  }

  const totalZips = groups.reduce((n, g) => n + g.zips.length, 0);
  const totalSold = groups.reduce((n, g) => n + g.sold, 0);

  el.innerHTML = `
    <div class="bal-wrap">
      ${workableHeader(hub)}
      <div class="bal-rows">
        ${groups.map(g => `
          <div class="bal-wday">
            <div class="bal-wday-head">
              <div class="bal-wday-top">
                <span class="bal-day">${g.label}</span>
                <span class="bal-zips">${g.zips.length} ZIP${g.zips.length!==1?'s':''}</span>
                ${g.key !== 'none' && canSeeView('pipeline') ? `<button class="bal-goboard" data-bal-board="${g.key}">Board →</button>` : ''}
              </div>
              <div class="bal-wday-sub">
                <span class="bal-wday-last">${g.last
                  ? `last worked ${g.last} · ${g.weeks}w ago`
                  : `<span class="bal-warn">no 5+ sales week yet</span>`}</span>
                <span class="bal-wday-sold">${g.sold} sale${g.sold!==1?'s':''} / 3 mo</span>
              </div>
            </div>
            <div class="bal-wday-list">
              ${g.zips.map(r => `
                <button class="wk-row${!r.date ? ' wk-never' : ''}${r.hold ? ' wk-hold' : ''}" data-bal-zip="${r.zip}" title="Open ${r.zip}">
                  <span class="wk-zip">${r.zip}</span>
                  <span class="wk-town">${holdChipHtml(r.zip)}${esc(r.rec.municipality || r.rec.primary_city || '')}</span>
                  <span class="wk-when">${r.date ? esc(r.date) : 'no 5+ week yet'}</span>
                  <span class="wk-weeks">${r.weeks == null ? '—' : `${r.weeks}w`}</span>
                  <span class="wk-sales${r.total ? '' : ' wk-sales-zero'}">${r.sold} / 3mo · ${r.total} total</span>
                </button>`).join('')}
            </div>
          </div>`).join('')}
      </div>
      <div class="bal-foot">
        <span><b>${totalZips}</b> ZIPs · <b>${totalSold}</b> sales in the last 3 months</span>
        <span class="bal-foot-since">Last worked = latest week with 5+ sales · 3-mo window since ${since}</span>
      </div>
    </div>`;
  wireBalance();
}

function workableHeader(hub){
  return `
    <div class="bal-head">
      <select class="bal-hub-sel" id="balHubSel">
        ${HUBS.map(h => `<option value="${h.key}" ${hub===h.key?'selected':''}>${h.label}</option>`).join('')}
      </select>
      ${balModeToggle(hub)}
      ${helpBtn('balance', 'workable')}
      <div class="bal-head-right">
        <button class="bal-sort-flip" data-bal-flip="1">⇅ ${balSort === 'stale' ? 'Longest unworked first' : 'Most recent first'}</button>
      </div>
    </div>`;
}

function wireBalance(){
  document.getElementById('balHubSel')?.addEventListener('change', e => {
    balanceHub = e.target.value;
    renderBalance();
  });
  document.getElementById('balCycleSel')?.addEventListener('change', e => {
    balCycleByHub[balanceHub] = parseInt(e.target.value, 10);
    renderBalance();
  });
  // Clicking a day expands its ZIPs in place, ordered by last worked. Jumping
  // straight to the board is still one click away, via "Open on board".
  document.querySelectorAll('[data-bal-day]').forEach(b =>
    b.addEventListener('click', () => {
      balOpenDay = balOpenDay === b.dataset.balDay ? null : b.dataset.balDay;
      renderBalance();
    }));
  document.querySelectorAll('[data-bal-mode]').forEach(b =>
    b.addEventListener('click', () => {
      balModeByHub[balanceHub] = b.dataset.balMode;
      try { localStorage.setItem('dispatch_bal_mode', JSON.stringify(balModeByHub)); } catch {}
      renderBalance();
    }));
  document.querySelector('[data-bal-flip]')?.addEventListener('click', e => {
    e.stopPropagation();
    balSort = balSort === 'stale' ? 'recent' : 'stale';
    renderBalance();
  });
  document.querySelectorAll('[data-bal-board]').forEach(b =>
    b.addEventListener('click', e => {
      e.stopPropagation();
      setHubFilter(balanceHub);
      setDeliveryFilter(b.dataset.balBoard);
      switchView('pipeline');
    }));
  document.querySelectorAll('[data-bal-zip]').forEach(b =>
    b.addEventListener('click', e => { e.stopPropagation(); openDrawer(b.dataset.balZip); }));

  const save = patch => saveHubGoal(balanceHub, patch);
  // 0 is a target ("no sales wanted this day"), so only a negative or unparseable
  // entry reverts. Clearing the box back to the flat cap isn't offered here —
  // the client always sends a number for every day they deliver on.
  document.querySelectorAll('[data-bal-cap]').forEach(inp =>
    inp.addEventListener('change', () => {
      const day = inp.dataset.balCap, g = goalFor(balanceHub);
      const n = parseInt(inp.value, 10);
      if (!isFinite(n) || n < 0) { inp.value = g.caps?.[day] ?? g.cap; return; }
      save({ caps: { ...(g.caps || {}), [day]: n } });
    }));
  document.querySelectorAll('[data-bal-plan]').forEach(inp =>
    inp.addEventListener('change', () => {
      const day = inp.dataset.balPlan, g = goalFor(balanceHub);
      const next = String((g.cycle || 1) + 1);
      const booked = g.plan?.[next] || {};
      const n = parseInt(inp.value, 10);
      if (!isFinite(n) || n < 0) { inp.value = booked[day] ?? (g.caps?.[day] ?? g.cap); return; }
      save({ plan: { ...(g.plan || {}), [next]: { ...booked, [day]: n } } });
    }));
  document.getElementById('balBook')?.addEventListener('click', () => {
    // Seed the booking from what's running now, so the strip opens on real
    // numbers to edit rather than empty boxes.
    const g = goalFor(balanceHub);
    const next = String((g.cycle || 1) + 1);
    const seed = {};
    for (const d of DELIVERY_DAYS) if (g.caps?.[d.key] != null) seed[d.key] = g.caps[d.key];
    save({ plan: { ...(g.plan || {}), [next]: Object.keys(seed).length ? seed : { mon: g.cap } } });
  });
  document.getElementById('balUnbook')?.addEventListener('click', () => {
    const g = goalFor(balanceHub);
    const next = String((g.cycle || 1) + 1);
    if (!confirm(`Clear cycle ${next}'s booked targets for ${hubLabel(balanceHub)}?\n\nThe current targets would carry over at the next rotation instead.`)) return;
    save({ plan: { ...(g.plan || {}), [next]: null } });
  });
  document.getElementById('balCycleStart')?.addEventListener('change', e => save({ cycleStart: e.target.value || '' }));
  document.getElementById('balRotate')?.addEventListener('click', () => {
    const today = etToday();
    const g = goalFor(balanceHub);
    const nextCycle = (g.cycle || 1) + 1;
    const booked = plannedFor(balanceHub, nextCycle);
    const targetLine = booked
      ? `Cycle ${nextCycle}'s booked targets take over: ${DELIVERY_DAYS.filter(d => booked[d.key] != null).map(d => `${d.short} ${booked[d.key]}`).join(' · ')}`
      : 'Per-day targets carry over';
    if (!confirm(`Start a new cycle for ${hubLabel(balanceHub)}?\n\nCounts reset to zero and only sales from ${today} onward will count.\n${targetLine}. The finished cycle stays viewable from the cycle picker.`)) return;
    delete balCycleByHub[balanceHub];   // land on the new live cycle, not its archive
    save({ cycleStart: today, cycle: nextCycle });
  });
}

async function saveHubGoal(hub, patch){
  hubGoals[hub] = { ...goalFor(hub), ...patch, hub };   // optimistic — the panel redraws instantly
  renderBalance();
  try {
    const resp = await fetch('/api/hub-goals', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ hub, ...patch }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Save failed');
    if (data.goal) { hubGoals[hub] = data.goal; renderBalance(); }
  } catch (e) {
    toast(`Could not save hub goal: ${e.message}`, 'error');
  }
}

// ─── Table collapse ──────────────────────────────────────────────────────────
function wireTableCollapse(){
  const btn = document.getElementById('tableCollapseBtn');
  const pane = document.getElementById('tablePane');
  if (!btn || !pane) return;
  const collapsed = localStorage.getItem('dispatch_table_collapsed') === '1';
  if (collapsed) { pane.classList.add('table-collapsed'); btn.classList.add('collapsed'); setTimeout(() => map.invalidateSize(), 100); }
  btn.addEventListener('click', () => {
    const isCollapsed = pane.classList.toggle('table-collapsed');
    btn.classList.toggle('collapsed', isCollapsed);
    localStorage.setItem('dispatch_table_collapsed', isCollapsed ? '1' : '0');
    setTimeout(() => map.invalidateSize(), 260);
  });
}

// ─── Office switcher ─────────────────────────────────────────────────────────
// Rendered twice: inline in the desktop view-tabs bar, and as a fixed strip
// under the topbar on mobile (only while pipeline/schedule views are open).
function buildOfficeSwitcher(){
  const containers = [document.getElementById('officeSwitcher'), document.getElementById('officeBar')];
  if (!canSwitchOffice()) {
    containers.forEach(el => { if (el) el.style.display = 'none'; });
    return;
  }
  const opts = [['all','All'], ...OFFICE_LIST.map(o => [o.key, o.label])];
  containers.forEach(el => {
    if (!el) return;
    el.innerHTML = opts.map(([key, label]) =>
      `<button class="office-opt${activeOffice===key?' active':''}" data-office="${key}">${label}</button>`).join('');
    el.querySelectorAll('.office-opt').forEach(btn => btn.addEventListener('click', () => {
      activeOffice = btn.dataset.office;
      buildOfficeSwitcher();
      updateStats();
      if (currentView === 'pipeline') renderPipeline();
      if (currentView === 'calendar') renderCalendar();
      savePrefs();
    }));
  });
  updateOfficeBarVisibility();
}

function updateOfficeBarVisibility(){
  const bar = document.getElementById('officeBar');
  if (!bar) return;
  const show = canSwitchOffice() && isMob() && (currentView === 'pipeline' || currentView === 'calendar');
  bar.classList.toggle('visible', show);
  document.body.classList.toggle('office-bar-on', show);
}

// ─── Today bar (today's scheduled territories, shown on the map) ─────────────
function renderTodayBar(){
  const bar = document.getElementById('todayBar');
  if (!bar) return;
  const today = etToday();
  const todays = Object.entries(edits)
    .filter(([zip, e]) => e?.work_date === today && e?.pipeline_stage && byZip[zip] && officeMatch(zip) && deliveryMatch(zip) && hubMatch(zip))
    .map(([zip]) => byZip[zip]);
  if (!todays.length) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  bar.innerHTML = `<span class="today-bar-lbl">Today</span>` + todays.map(r => {
    const c = COLORS[r.color] || COLORS.GREY;
    return `<button class="today-chip" data-today-zip="${r.zip}" style="--tc:${c};--tc-bg:${c}20;--tc-line:${c}60">
      <span class="today-chip-zip">${r.zip}</span>
      <span class="today-chip-town">${esc(r.municipality || r.primary_city || '')}</span>
    </button>`;
  }).join('');
  bar.querySelectorAll('[data-today-zip]').forEach(btn =>
    btn.addEventListener('click', () => openDrawer(btn.dataset.todayZip)));
}

// ─── Stats bar ───────────────────────────────────────────────────────────────
function updateStats(){
  renderTodayBar();
  const bar = document.getElementById('statsBar');
  if (!bar) return;
  // Pipeline counts are noise on the map view — only show on pipeline/schedule
  bar.style.display = currentView === 'map' ? 'none' : '';

  const counts = {};
  PIPELINE_STAGES.forEach(s => { counts[s.key] = 0; });
  Object.entries(edits).forEach(([zip, e]) => {
    // Match the pipeline board's filters exactly — the chips link to it, so a
    // count that ignored the day/hub filters would contradict what you land on
    if (!officeMatch(zip) || !deliveryMatch(zip) || !hubMatch(zip)) return;
    if (e.pipeline_stage && counts[e.pipeline_stage] !== undefined) counts[e.pipeline_stage]++;
  });

  const total = Object.values(counts).reduce((a,b) => a+b, 0);
  if (total === 0) { bar.style.display = 'none'; return; }

  bar.innerHTML = `
    <span class="stats-label">PIPELINE</span>
    ${PIPELINE_STAGES.map(s => counts[s.key] > 0 ? `
      <div class="stat-chip${canSeeView('pipeline') ? '' : ' stat-chip-static'}" style="--stat-color:${s.color}"${canSeeView('pipeline') ? ` data-go-view="pipeline"` : ''}>
        <span class="stat-num">${counts[s.key]}</span>
        <span class="stat-name">${s.label}</span>
      </div>` : '').join('')}
  `;
  // No inline onclick: the Content-Security-Policy only runs script files.
  bar.querySelectorAll('[data-go-view]').forEach(el =>
    el.addEventListener('click', () => switchView(el.dataset.goView)));
}

// ─── Pipeline ────────────────────────────────────────────────────────────────
let pipelineSelected = new Set(); // zips ticked for bulk move / remove
let pipelineExpanded = new Set(); // zips showing full card detail (collapsed by default)
let rollupExpanded   = false;     // Zipcode Feedback strip starts as a slim one-line bar

// ── Scheduling constraints (chips + roll-up) ─────────────────────────────────
const fmtConDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d.slice(8,10)}/${d.slice(5,7)}` : '';

function constraintChipsHtml(zip){
  const c = edits[zip]?.constraints || {};
  return CONSTRAINTS.filter(k => c[k.key]).map(k => {
    const date = k.hasDate && typeof c[k.key] === 'string' ? ` ${fmtConDate(c[k.key])}` : '';
    return `<span class="pc-meta-chip pc-con-chip" style="--cc:${k.color}" title="${k.label}">${k.icon} ${k.short}${date}</span>`;
  }).join('');
}

function constraintEditorHtml(zip){
  const c = edits[zip]?.constraints || {};
  return CONSTRAINTS.map(k =>
    `<button class="pc-con-btn${c[k.key] ? ' on' : ''}" style="--cc:${k.color}" data-con-zip="${zip}" data-con-key="${k.key}" title="${k.desc}">${k.icon} ${k.label}</button>`
  ).join('') + (c.permit_pending ? `
    <input type="date" class="pc-con-date" data-zip="${zip}" title="Permit applied on"
      value="${typeof c.permit_pending === 'string' ? esc(c.permit_pending) : ''}">` : '');
}

// ── Resting guard ────────────────────────────────────────────────────────────
// A ZIP that had a strong week (5+ sales in 7 days) within the last 12 weeks
// isn't ready to go out again. Adding it to the pipeline with no start date —
// or attaching a work date that lands inside its rest window — raises a
// heads-up: skip the ZIP, or override and it enters the board with the
// 😴 Resting constraint already on. A ZIP whose card already carries Resting
// has been acknowledged, so it never re-prompts.
const REST_WEEKS = 12;
function restCheck(zip, workDate){
  if (edits[zip]?.constraints?.resting) return null;   // already acknowledged
  const last = strongWeekByZip[zip];
  if (!last) return null;
  const untilISO = isoAddDays(last, REST_WEEKS * 7);
  const ref = workDate || todayISO();
  if (ref >= untilISO) return null;
  return { last, until: untilISO, weeks: weeksSince(last) };
}
function confirmRestOverride(zip, rest, action){
  return confirm(
    `Heads-up — ${zip} has been worked within the last ${REST_WEEKS} weeks ` +
    `(week of ${rest.last}, ${rest.weeks}w ago) and requires further resting until ${rest.until}.\n\n` +
    `OK — override: ${action}, with 😴 Resting toggled on the card.\nCancel — skip.`);
}
// Fold the Resting constraint into a patch, preserving existing constraints.
const withResting = (zip, patch) =>
  ({ ...patch, constraints: { ...(edits[zip]?.constraints || {}), resting: true } });

function wireConstraintControls(scope){
  scope.querySelectorAll('[data-con-key]').forEach(btn =>
    btn.addEventListener('click', e => {
      e.stopPropagation();
      toggleConstraint(btn.dataset.conZip, btn.dataset.conKey);
    }));
  scope.querySelectorAll('.pc-con-date').forEach(inp =>
    inp.addEventListener('change', () => {
      const zip = inp.dataset.zip;
      const c = { ...(edits[zip]?.constraints || {}) };
      if (!c.permit_pending) return;
      c.permit_pending = inp.value || true;
      patchEdit(zip, { constraints: c });
      refreshCardConstraints(zip);
    }));
}

function toggleConstraint(zip, key){
  const c = { ...(edits[zip]?.constraints || {}) };
  if (c[key]) delete c[key];
  else c[key] = CONSTRAINTS.find(k => k.key === key)?.hasDate
    ? etToday() : true;
  patchEdit(zip, { constraints: Object.keys(c).length ? c : null });
  refreshCardConstraints(zip);
}

// In-place patch (no full board re-render) so column scroll, card expansion
// and input focus all survive a chip toggle.
function refreshCardConstraints(zip){
  document.querySelectorAll(`[data-con-chips="${zip}"]`).forEach(el => { el.innerHTML = constraintChipsHtml(zip); });
  document.querySelectorAll(`[data-con-editor="${zip}"]`).forEach(el => {
    el.innerHTML = constraintEditorHtml(zip);
    wireConstraintControls(el);
  });
  renderConstraintRollup();
}

// "Zipcode Feedback" strip above the board — constrained ZIPs grouped by their
// pipeline stage (board order), one compact row per ZIP with town, all its
// toggles, and the scheduled date + sales target. Blocks flow into columns so
// a long list stays shallow.
function renderConstraintRollup(){
  const el = document.getElementById('pipelineRollup');
  if (!el) return;
  const byStage = new Map();  // stage key -> [{zip, town, html}]
  let total = 0;
  MASTER.forEach(r => {
    const e = edits[r.zip];
    if (!e?.pipeline_stage || e.pipeline_stage === 'completed') return;
    if (!officeMatch(r.zip) || !deliveryMatch(r.zip) || !hubMatch(r.zip)) return;
    const c = e.constraints || {};
    const active = CONSTRAINTS.filter(k => c[k.key]);
    if (!active.length) return;
    const chips = active.map(k => {
      const date = k.hasDate && typeof c[k.key] === 'string' ? ` ${fmtConDate(c[k.key])}` : '';
      return `<span class="pr-chip" style="--cc:${k.color}" title="${k.label}">${k.icon} ${k.short}${date}</span>`;
    }).join('');
    const workDate = e.work_date ? `<span class="pr-meta" title="Work date">📅 ${fmtConDate(e.work_date)}</span>` : '';
    const target   = e.sales_target ? `<span class="pr-meta" title="Sales target">🎯 ${esc(e.sales_target)}</span>` : '';
    const town = r.municipality || r.primary_city || '—';
    if (!byStage.has(e.pipeline_stage)) byStage.set(e.pipeline_stage, []);
    byStage.get(e.pipeline_stage).push({
      zip: r.zip, town,
      html: `<div class="pr-item" data-pr-zip="${r.zip}" title="Open ${r.zip} details">
        <span class="pr-zip">${r.zip}</span><span class="pr-town">${esc(town)}</span><span class="pr-chipset">${chips}</span>${workDate}${target}
      </div>`,
    });
    total++;
  });
  el.style.display = total ? '' : 'none';
  if (!total) { el.innerHTML = ''; return; }
  const blocks = PIPELINE_STAGES.filter(s => byStage.has(s.key)).map(s => {
    const rows = byStage.get(s.key)
      .sort((a, b) => a.town.localeCompare(b.town) || a.zip.localeCompare(b.zip));
    return `
    <div class="pr-stageblock" style="--sc:${s.color}">
      <div class="pr-stagename">${s.label} · ${rows.length}</div>
      ${rows.map(x => x.html).join('')}
    </div>`;
  }).join('');
  el.classList.toggle('pr-open', rollupExpanded);
  el.innerHTML = `
    <div class="pr-head" id="prHead" title="${rollupExpanded ? 'Collapse' : 'Expand'}">
      <span class="pr-chevron">${rollupExpanded ? '▾' : '▸'}</span>
      <span class="pr-title">Zipcode Feedback</span><span class="pr-count">${total} ZIP${total === 1 ? '' : 's'}</span>
    </div>
    ${rollupExpanded ? `<div class="pr-groups">${blocks}</div>` : ''}`;
  document.getElementById('prHead')?.addEventListener('click', () => {
    rollupExpanded = !rollupExpanded;
    renderConstraintRollup();
  });
  el.querySelectorAll('[data-pr-zip]').forEach(row =>
    row.addEventListener('click', () => openDrawer(row.dataset.prZip)));
}

function renderPipeline(){
  const container = document.getElementById('pipelineView');
  if (!container) return;

  // Prune selection — ZIPs may have left the pipeline since last render
  [...pipelineSelected].forEach(z => { if (!edits[z]?.pipeline_stage) pipelineSelected.delete(z); });
  [...pipelineExpanded].forEach(z => { if (!edits[z]?.pipeline_stage) pipelineExpanded.delete(z); });

  const byStage = {};
  PIPELINE_STAGES.forEach(s => { byStage[s.key] = []; });
  MASTER.forEach(r => {
    const stage = edits[r.zip]?.pipeline_stage;
    if (stage && byStage[stage] && officeMatch(r.zip) && deliveryMatch(r.zip) && hubMatch(r.zip)) byStage[stage].push(r);
  });

  container.innerHTML = `
    <div class="pipeline-bulk-bar${pipelineSelected.size ? ' visible' : ''}" id="pipelineBulkBar">
      <span class="pbb-count" id="pbbCount">${pipelineSelected.size} selected</span>
      <span class="ab-sep">·</span>
      <select id="pbbStage" class="pbb-sel">
        <option value="">Move to…</option>
        ${PIPELINE_STAGES.map(s => `<option value="${s.key}">${s.label}</option>`).join('')}
      </select>
      <button id="pbbMove" class="pbb-move">Move</button>
      <button id="pbbRemove" class="pbb-remove" title="Remove from pipeline">Remove</button>
      <button id="pbbClear" class="ab-clear">Clear</button>
    </div>
    <div class="pipeline-rollup" id="pipelineRollup" style="display:none"></div>
    <div class="pipeline-board">` + PIPELINE_STAGES.map(stage => {
    const zips = byStage[stage.key] || [];
    return `
      <div class="pipeline-col">
        <div class="pipeline-col-header" style="border-top:3px solid ${stage.color}" title="${stage.desc}">
          <div class="pipeline-col-top">
            <span class="pipeline-col-label">${stage.label}${helpBtn('pipeline', stage.key)}</span>
            <span class="pipeline-col-count" style="color:${stage.color}">${zips.length}</span>
          </div>
        </div>
        <div class="pipeline-col-body" data-stage-key="${stage.key}">
          ${zips.length === 0
            ? '<div class="pipeline-empty">Drop here</div>'
            : zips.map(r => renderPipelineCard(r, stage)).join('')}
        </div>
      </div>
    `;
  }).join('') + '</div>';

  // Multi-select checkboxes + bulk action bar
  container.querySelectorAll('.pc-select').forEach(chk =>
    chk.addEventListener('change', () => {
      const zip = chk.dataset.selectZip;
      if (chk.checked) pipelineSelected.add(zip); else pipelineSelected.delete(zip);
      chk.closest('.pipeline-card')?.classList.toggle('pc-selected', chk.checked);
      updatePipelineBulkBar();
    }));
  document.getElementById('pbbMove')?.addEventListener('click', () => {
    const stage = document.getElementById('pbbStage').value;
    if (!stage || !pipelineSelected.size) return;
    setPipelineStageBulk([...pipelineSelected], stage);
  });
  document.getElementById('pbbRemove')?.addEventListener('click', () => {
    const zips = [...pipelineSelected];
    if (!zips.length) return;
    if (!confirm(`Remove ${zips.length} ZIP${zips.length>1?'s':''} from the pipeline?`)) return;
    const patches = {};
    zips.forEach(z => { patches[z] = { pipeline_stage: null }; });
    pipelineSelected.clear();
    patchEditsBulk(patches);
    applyEdits(); updateStats(); renderPipeline();
    toast(`Removed ${zips.length} ZIP${zips.length>1?'s':''} from the pipeline`, 'ok');
  });
  document.getElementById('pbbClear')?.addEventListener('click', () => {
    pipelineSelected.clear();
    renderPipeline();
  });

  container.querySelectorAll('[data-pipeline-open]').forEach(btn =>
    btn.addEventListener('click', () => openDrawer(btn.dataset.pipelineOpen)));
  container.querySelectorAll('[data-pipeline-advance]').forEach(btn =>
    btn.addEventListener('click', () => advancePipelineStage(btn.dataset.pipelineAdvance)));
  container.querySelectorAll('[data-pipeline-back]').forEach(btn =>
    btn.addEventListener('click', () => backPipelineStage(btn.dataset.pipelineBack)));
  container.querySelectorAll('[data-pipeline-delete]').forEach(btn =>
    btn.addEventListener('click', e => { e.stopPropagation(); removeFromPipeline(btn.dataset.pipelineDelete); }));
  // Direct move buttons
  container.querySelectorAll('[data-pipeline-to]').forEach(btn =>
    btn.addEventListener('click', () => setPipelineStage(btn.dataset.pipelineZip, btn.dataset.pipelineTo)));
  // Office chip — click to move the territory to the other office
  container.querySelectorAll('[data-office-toggle]').forEach(btn =>
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const zip = btn.dataset.officeToggle;
      const next = nextOffice(zipOffice(zip));
      patchEdit(zip, { office: next });
      applyEdits(); updateStats(); renderPipeline();
      toast(`${zip} moved to ${OFFICES[next]}`, 'ok');
    }));
  // ZIP number opens the full drawer; the rest of the card toggles collapse
  container.querySelectorAll('.pipeline-card-zip').forEach(z =>
    z.addEventListener('click', e => {
      e.stopPropagation();
      openDrawer(z.closest('.pipeline-card').dataset.dragZip);
    }));
  // Collapse / expand — click anywhere on a card that isn't a control.
  // Toggles in place (no re-render) so column scroll and input focus survive.
  container.querySelectorAll('.pipeline-card').forEach(card =>
    card.addEventListener('click', e => {
      if (e.target.closest('button, input, select, .pc-schedule')) return;
      const zip  = card.dataset.dragZip;
      const open = !pipelineExpanded.has(zip);
      if (open) pipelineExpanded.add(zip); else pipelineExpanded.delete(zip);
      card.classList.toggle('pc-collapsed', !open);
      const chev = card.querySelector('.pc-chevron');
      if (chev) chev.textContent = open ? '▾' : '▸';
    }));
  // Inline extras on all cards
  container.querySelectorAll('.pc-extra-input').forEach(inp =>
    inp.addEventListener('change', () => {
      // Resting guard: scheduling a work date inside the ZIP's rest window
      if (inp.dataset.field === 'work_date' && inp.value) {
        const rest = restCheck(inp.dataset.zip, inp.value);
        if (rest) {
          if (!confirmRestOverride(inp.dataset.zip, rest, `schedule it for ${inp.value}`)) {
            inp.value = edits[inp.dataset.zip]?.work_date || '';
            return;
          }
          patchEdit(inp.dataset.zip, withResting(inp.dataset.zip, { work_date: inp.value }));
          refreshCardConstraints(inp.dataset.zip);
          renderTodayBar();
          return;
        }
      }
      patchEdit(inp.dataset.zip, { [inp.dataset.field]: inp.value || null });
      if (inp.dataset.field === 'work_date') renderTodayBar();
      // Delivery-day change can move a card in/out of an active day filter, and
      // affects the map recolor/popup — re-render both.
      if (inp.dataset.field === 'delivery_day') { applyEdits(); refreshAllStyles(); renderPipeline(); }
    }));

  wireConstraintControls(container);
  renderConstraintRollup();

  wirePipelineDragDrop(container);
}

// The office after this one (the office chip cycles through them).
const nextOffice = k => OFFICE_KEYS[(OFFICE_KEYS.indexOf(k) + 1) % OFFICE_KEYS.length];

function renderPipelineCard(r, stage){
  const stageIdx   = PIPELINE_STAGES.findIndex(s => s.key === stage.key);
  const canBack    = stageIdx > 0;
  const color      = COLORS[r.color] || COLORS.GREY;
  const cardOffice = zipOffice(r.zip);
  const cardDist   = officeDist(r, cardOffice);
  const incidents  = (edits[r.zip]?.incidents || []).length;
  const sales      = salesByZip[r.zip];
  // Permit info — auto-filled from research
  const permitRequired = edits[r.zip]?.permit_required;
  const rawSummary     = String(edits[r.zip]?.permit_summary || '');
  const permitSummary  = rawSummary.replace(/not researched|not located|verify before fielding/gi,'').trim();
  const rawAuth        = String(edits[r.zip]?.authority || '');
  const authority      = rawAuth.replace(/\(verify[^)]*\)/gi,'').trim();
  const hours          = edits[r.zip]?.hours || '';
  const ordinanceRef   = edits[r.zip]?.ordinance_ref || '';
  const fee            = String(edits[r.zip]?.fee || '').replace(/not specified.*$/i,'').trim();
  const processingTime = String(edits[r.zip]?.processing_time || '').replace(/not specified.*$/i,'').trim();

  // Schedule fields
  const workDate    = edits[r.zip]?.work_date || '';
  const salesTarget = edits[r.zip]?.sales_target || '';
  const clientNotes = edits[r.zip]?.client_notes || '';
  const deliveryDay = edits[r.zip]?.delivery_day || '';
  const cardHub     = edits[r.zip]?.hub || '';

  // Difficulty (auto 1–5 unless manually overridden) + blocking
  const diff    = difficultyFor(r.zip);
  const blocker = blockerFor(r.zip);

  // Permit block
  let permitBlock = '';
  if (permitRequired === 'N') {
    permitBlock = `<div class="pc-permit pc-permit-ok">No permit required</div>`;
  } else if (r.color === 'RED') {
    permitBlock = `<div class="pc-permit pc-permit-red">Canvassing restricted — check before fielding</div>`;
  } else if (permitSummary) {
    const refLine  = ordinanceRef ? `<span class="pc-permit-ref">${esc(ordinanceRef.slice(0,50))}</span>` : '';
    const feeTimeParts = [fee, processingTime].filter(Boolean).map(esc);
    const metaParts = [authority.replace(/,.*$/,'').slice(0,35), hours.slice(0,35)].filter(Boolean).map(esc);
    permitBlock = `
      <div class="pc-permit">
        <div class="pc-permit-summary">${esc(permitSummary.slice(0,72))}${permitSummary.length>72?'…':''}</div>
        ${feeTimeParts.length ? `<div class="pc-permit-feetime">${feeTimeParts.join(' · ')}</div>` : ''}
        ${metaParts.length ? `<div class="pc-permit-meta">${metaParts.join(' · ')}</div>` : ''}
        ${refLine}
      </div>`;
  } else {
    permitBlock = `<div class="pc-permit pc-permit-dim">Permit research pending</div>`;
  }

  const permitHolder = edits[r.zip]?.permitted_who || edits[r.zip]?.permit_holder || '';

  // Schedule section — shown on ALL stages
  const scheduleSection = `
    <div class="pc-schedule">
      <div class="pc-extra-row">
        <span class="pc-extra-lbl">Date</span>
        <input type="date" class="pc-extra-input" data-zip="${r.zip}" data-field="work_date" value="${esc(workDate)}">
      </div>
      <div class="pc-extra-row">
        <span class="pc-extra-lbl">Day</span>
        <select class="pc-extra-input pc-day-sel" data-zip="${r.zip}" data-field="delivery_day">
          <option value="">— delivery day —</option>
          ${DELIVERY_DAYS.map(d => `<option value="${d.key}" ${deliveryDay===d.key?'selected':''}>${d.label}</option>`).join('')}
        </select>
      </div>
      <div class="pc-extra-row">
        <span class="pc-extra-lbl">Target</span>
        <input type="number" class="pc-extra-input pc-extra-num" data-zip="${r.zip}" data-field="sales_target" value="${esc(salesTarget)}" placeholder="—" min="0">
        <input type="text" class="pc-extra-input pc-notes-input" data-zip="${r.zip}" data-field="client_notes" value="${esc(clientNotes)}" placeholder="Notes…">
      </div>
      ${stage.key === 'permit_secured' ? `
      <div class="pc-extra-row">
        <span class="pc-extra-lbl">Rep</span>
        <input type="text" class="pc-extra-input pc-notes-input" data-zip="${r.zip}" data-field="permitted_who" value="${esc(permitHolder)}" placeholder="Who holds the permit?">
      </div>` : ''}
    </div>`;

  // Advance buttons
  let advanceHtml = '';
  if (stage.key === 'research') {
    advanceHtml = `
      <div class="pc-branch-btns">
        <button class="pc-btn pc-btn-flag" data-pipeline-to="flagged" data-pipeline-zip="${r.zip}">🪪 Needs Permit</button>
        <button class="pc-btn pc-btn-advance" data-pipeline-to="ready" data-pipeline-zip="${r.zip}">No Permit →</button>
      </div>`;
  } else if (stageIdx < PIPELINE_STAGES.length - 1) {
    const nextLabel = stage.key === 'flagged' ? 'Permit Secured →'
                    : stage.key === 'permit_secured' ? 'No Permit Needed →'
                    : stage.key === 'ready' ? 'Deploy →'
                    : stage.key === 'active' ? 'Complete →'
                    : 'Next →';
    advanceHtml = `<button class="pc-btn pc-btn-advance" data-pipeline-advance="${r.zip}">${nextLabel}</button>`;
  }

  const expanded = pipelineExpanded.has(r.zip);

  // Compact permit hint — only visible while the card is collapsed
  let permitMini = '';
  if (permitRequired === 'N')  permitMini = `<span class="pc-meta-chip pc-collapsed-only pc-mini-ok">no permit</span>`;
  else if (r.color === 'RED')  permitMini = `<span class="pc-meta-chip pc-collapsed-only pc-mini-red">restricted</span>`;
  else if (permitSummary)      permitMini = `<span class="pc-meta-chip pc-collapsed-only pc-mini-permit">🪪 permit</span>`;
  else                         permitMini = `<span class="pc-meta-chip pc-collapsed-only">permit ?</span>`;
  const dateMini = workDate ? `<span class="pc-meta-chip pc-collapsed-only">📅 ${workDate.slice(8,10)}/${workDate.slice(5,7)}</span>` : '';

  return `
    <div class="pipeline-card${expanded?'':' pc-collapsed'}${stage.key==='completed'?' pc-completed':''}${blocker && !blocker.done?' pc-blocked':''}${pipelineSelected.has(r.zip)?' pc-selected':''}" draggable="true" data-drag-zip="${r.zip}">
      <div class="pipeline-card-top">
        <div class="pc-top-left">
          <input type="checkbox" class="pc-select" data-select-zip="${r.zip}" ${pipelineSelected.has(r.zip)?'checked':''} title="Select for bulk move / remove">
          <span class="pc-chevron">${expanded?'▾':'▸'}</span>
          <span class="pipeline-card-zip">${r.zip}</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <span class="pipeline-card-dot" style="background:${color}" title="${STATUS_LABELS[r.color]||'Not Reviewed'}"></span>
          <button class="pc-btn pc-btn-delete" data-pipeline-delete="${r.zip}" title="Remove from pipeline">✕</button>
        </div>
      </div>
      <div class="pipeline-card-muni">${esc(r.municipality || r.primary_city || '')}, ${esc(r.state)}
        <button class="pc-office-chip" data-office-toggle="${r.zip}" style="--oc:${OFFICE_COLORS[cardOffice]}"
          title="Switch to ${esc(OFFICES[nextOffice(cardOffice)])}">${esc(OFFICES[cardOffice])}</button>
      </div>
      ${blocker ? (blocker.done
        ? `<div class="pc-blocker pc-blocker-done">✓ ${blocker.zip} completed</div>`
        : `<div class="pc-blocker">🔒 Finish ${blocker.zip} first</div>`) : ''}
      <div class="pipeline-card-meta">
        ${cardDist.drive ? `<span class="pc-meta-chip" title="Drive from ${esc(OFFICES[cardOffice])}">🚗 ${fmtTime(cardDist.drive)}</span>` : ''}
        ${deliveryDay ? `<span class="pc-meta-chip pc-day-chip">🚚 ${dayShort(deliveryDay)}</span>` : ''}
        ${cardHub ? `<span class="pc-meta-chip pc-hub-chip" title="${hubLabel(cardHub)} hub">🏭 ${hubShort(cardHub)}</span>` : ''}
        ${holdChipHtml(r.zip, 'pc-meta-chip')}
        ${diff ? `<span class="pc-meta-chip pc-difficulty" style="--dc:${DIFFICULTY_COLORS[diff]}" title="Permit difficulty ${diff}/5${edits[r.zip]?.difficulty?'':' (auto)'}">⚡ D${diff}</span>` : ''}
        ${sales != null ? `<span class="pc-meta-chip pc-sales">📦 ${sales} sale${sales!==1?'s':''}</span>` : ''}
        ${incidents ? `<span class="pc-meta-chip pc-incidents">⚠ ${incidents}</span>` : ''}
        ${permitMini}
        ${dateMini}
        <span class="pc-con-chips" data-con-chips="${r.zip}">${constraintChipsHtml(r.zip)}</span>
      </div>
      <div class="pc-details">
        ${permitHolder ? `<div class="pc-permit-holder">🪪 ${esc(permitHolder)}</div>` : ''}
        ${permitBlock}
        <div class="pc-constraints" data-con-editor="${r.zip}">${constraintEditorHtml(r.zip)}</div>
        ${scheduleSection}
        <div class="pipeline-card-actions">
          <div class="pca-row">
            ${canBack ? `<button class="pc-btn pc-btn-back" data-pipeline-back="${r.zip}">← Back</button>` : `<span></span>`}
            <button class="pc-btn pc-btn-open" data-pipeline-open="${r.zip}">Details</button>
          </div>
          ${advanceHtml ? `<div class="pca-advance">${advanceHtml}</div>` : ''}
        </div>
      </div>
    </div>
  `;
}

function updatePipelineBulkBar(){
  const bar = document.getElementById('pipelineBulkBar');
  if (!bar) return;
  const count = document.getElementById('pbbCount');
  if (count) count.textContent = `${pipelineSelected.size} selected`;
  bar.classList.toggle('visible', pipelineSelected.size > 0);
}

// Move several ZIPs to a stage in one save (bulk bar or multi-card drag)
function setPipelineStageBulk(zips, stageKey){
  if (stageKey === 'ready' || stageKey === 'active'){
    // Same soft lock as single moves — one combined warning for the batch
    const blocked = zips.filter(z => { const b = blockerFor(z); return b && !b.done; });
    if (blocked.length &&
        !confirm(`${blocked.join(', ')} ${blocked.length>1?'have':'has'} an unfinished "complete first" ZIP. Move anyway?`)){
      renderPipeline();
      return;
    }
  }
  const patches = {};
  zips.forEach(z => {
    const patch = { pipeline_stage: stageKey };
    if (!edits[z]?.office) patch.office = activeOffice !== 'all' ? activeOffice : zipOffice(z);
    patches[z] = patch;
  });
  pipelineSelected.clear();
  patchEditsBulk(patches);
  applyEdits(); updateStats();
  if (drawerZip && zips.includes(drawerZip)) renderDrawerWithTab(drawerZip, drawerActiveTab);
  renderPipeline();
  const label = PIPELINE_STAGES.find(s => s.key === stageKey)?.label || stageKey;
  toast(`Moved ${zips.length} ZIP${zips.length>1?'s':''} to ${label}`, 'ok');
}

function setPipelineStage(zip, stageKey){
  // Soft lock: warn (don't hard-stop) when deploying a ZIP whose prerequisite
  // ("complete X first") isn't Completed yet.
  if ((stageKey === 'ready' || stageKey === 'active')) {
    const b = blockerFor(zip);
    if (b && !b.done &&
        !confirm(`${zip} is blocked — ${b.zip} isn't marked Completed yet. Deploy ${zip} anyway?`)) {
      renderPipeline(); // revert any drag that moved the card in the DOM
      return;
    }
  }
  const patch = { pipeline_stage: stageKey };
  // Entering the pipeline without an explicit office: stamp the office being
  // viewed (or the state-derived one) so it stays visible to whoever added it
  if (stageKey && !edits[zip]?.office)
    patch.office = activeOffice !== 'all' ? activeOffice : zipOffice(zip);
  patchEdit(zip, patch);
  applyEdits(); updateStats();
  if (drawerZip === zip) renderDrawerWithTab(zip, drawerActiveTab);
  renderPipeline();
}

function advancePipelineStage(zip){
  const idx = PIPELINE_STAGES.findIndex(s => s.key === edits[zip]?.pipeline_stage);
  if (idx >= 0 && idx < PIPELINE_STAGES.length - 1)
    setPipelineStage(zip, PIPELINE_STAGES[idx+1].key);
}

function backPipelineStage(zip){
  const idx = PIPELINE_STAGES.findIndex(s => s.key === edits[zip]?.pipeline_stage);
  if (idx > 0) setPipelineStage(zip, PIPELINE_STAGES[idx-1].key);
}

function removeFromPipeline(zip){
  if (!confirm(`Remove ${zip} from the pipeline?`)) return;
  // null (not delete) so the removal reaches the server as $unset
  patchEdit(zip, { pipeline_stage: null });
  applyEdits(); updateStats();
  if (drawerZip === zip) renderDrawerWithTab(zip, drawerActiveTab);
  renderPipeline();
}

function wirePipelineDragDrop(container){
  let dragZip = null;

  container.querySelectorAll('.pipeline-card[draggable]').forEach(card => {
    card.addEventListener('dragstart', e => {
      dragZip = card.dataset.dragZip;
      e.dataTransfer.effectAllowed = 'move';
      // Dragging a selected card drags the whole selection
      const multi = pipelineSelected.has(dragZip) && pipelineSelected.size > 1;
      setTimeout(() => {
        if (multi) container.querySelectorAll('.pc-selected').forEach(c => c.classList.add('dragging'));
        else card.classList.add('dragging');
      }, 0);
    });
    card.addEventListener('dragend', () => {
      container.querySelectorAll('.pipeline-card.dragging').forEach(c => c.classList.remove('dragging'));
      dragZip = null;
      container.querySelectorAll('.pipeline-col-body').forEach(c => c.classList.remove('drag-over'));
    });
  });

  container.querySelectorAll('.pipeline-col-body').forEach(col => {
    col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', e => { if (!col.contains(e.relatedTarget)) col.classList.remove('drag-over'); });
    col.addEventListener('drop', e => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const zip = dragZip;
      const stageKey = col.dataset.stageKey;
      if (!zip || !stageKey) return;
      // Dropping a selected card moves every selected card with it
      const fromSelection = pipelineSelected.has(zip) && pipelineSelected.size > 1;
      const moving = (fromSelection ? [...pipelineSelected] : [zip])
        .filter(z => edits[z]?.pipeline_stage !== stageKey);
      if (!moving.length) return;
      if (fromSelection) setPipelineStageBulk(moving, stageKey);
      else setPipelineStage(moving[0], stageKey);
    });
  });
}

// ─── Add Territories ─────────────────────────────────────────────────────────
// Structured multi-row entry + CSV template + spreadsheet upload + AI extraction.
let terrFileMode = 'map'; // 'map' = header auto-map · 'ai' = Claude extraction

function wireAddTerritories(){
  document.getElementById('addTerritoriesBtn').addEventListener('click', openAddTerritoriesModal);
  document.getElementById('addTerritoriesClose').addEventListener('click', closeAddTerritoriesModal);
  document.getElementById('addTerritoriesOverlay').addEventListener('click', e => {
    if (e.target === document.getElementById('addTerritoriesOverlay')) closeAddTerritoriesModal();
  });
  document.getElementById('addTerritoriesApply').addEventListener('click', applyAddTerritories);
  document.getElementById('terrAddRow').addEventListener('click', () => atAddRow({}));
  document.getElementById('terrTemplateBtn').addEventListener('click', terrDownloadTemplate);
  document.getElementById('terrQuickAdd').addEventListener('click', terrQuickToRows);

  const fileInput = document.getElementById('terrFile');
  // Deterministic upload only reads spreadsheets; the AI path takes anything —
  // photos, PDFs, JSON, text — so the picker's accept list switches per mode
  const SHEET_ACCEPT = '.xlsx,.xls,.csv';
  const AI_ACCEPT    = '.xlsx,.xls,.csv,.pdf,.json,.txt,.png,.jpg,.jpeg,.webp,.gif,.heic,image/*';
  document.getElementById('terrUploadBtn').addEventListener('click', () => { terrFileMode = 'map'; fileInput.accept = SHEET_ACCEPT; fileInput.value = ''; fileInput.click(); });
  document.getElementById('terrAiBtn').addEventListener('click',    () => { terrFileMode = 'ai';  fileInput.accept = AI_ACCEPT;    fileInput.value = ''; fileInput.click(); });
  fileInput.addEventListener('change', e => {
    const f = e.target.files[0]; if (!f) return;
    if (terrFileMode === 'ai') terrAiExtract(f); else terrHandleFile(f);
  });
}

function openAddTerritoriesModal(){
  document.getElementById('addTerritoriesInput').value = '';
  document.getElementById('addTerritoriesResult').textContent = '';
  setTerrBulkMsg('');
  terrRestQueue = [];
  renderTerrRestReview();
  document.getElementById('addTerritoriesApply').textContent = 'Add to Pipeline';
  atSetRows([]);  // one empty row
  // Office picker: locked for single-office accounts, preselected from the active tab
  const sel = document.getElementById('addTerritoriesOffice');
  if (sel) {
    if (!sel.options.length)
      sel.innerHTML = OFFICE_LIST.map(o => `<option value="${esc(o.key)}">${esc(o.label)}</option>`).join('');
    if (!canSwitchOffice()) { sel.value = isOfficeKey(currentUser?.office) ? currentUser.office : OFFICE_KEYS[0]; sel.disabled = true; }
    else { sel.disabled = false; if (activeOffice !== 'all') sel.value = activeOffice; }
  }
  document.getElementById('addTerritoriesOverlay').classList.add('open');
}

function closeAddTerritoriesModal(){
  document.getElementById('addTerritoriesOverlay').classList.remove('open');
}

function setTerrBulkMsg(msg){ const el = document.getElementById('terrBulkMsg'); if (el) el.textContent = msg || ''; }

// ── Structured rows ──
function atRowHtml(row = {}){
  return `<tr class="terr-row">
    <td><input class="terr-in terr-in-zip" data-k="zip" type="text" inputmode="numeric" maxlength="5" value="${esc(row.zip||'')}" placeholder="ZIP"></td>
    <td><select class="terr-in" data-k="delivery_day">
      <option value="">—</option>
      ${DELIVERY_DAYS.map(d => `<option value="${d.key}" ${row.delivery_day===d.key?'selected':''}>${d.short}</option>`).join('')}
    </select></td>
    <td><select class="terr-in" data-k="hub">
      <option value="">—</option>
      ${HUBS.map(h => `<option value="${h.key}" ${row.hub===h.key?'selected':''}>${h.short}</option>`).join('')}
    </select></td>
    <td><input class="terr-in" data-k="work_date" type="date" value="${esc(row.work_date||'')}"></td>
    <td><input class="terr-in terr-in-num" data-k="sales_target" type="number" min="0" value="${esc(row.sales_target||'')}" placeholder="—"></td>
    <td><input class="terr-in" data-k="blocked_by" type="text" inputmode="numeric" maxlength="5" value="${esc(row.blocked_by||'')}" placeholder="ZIP"></td>
    <td><input class="terr-in terr-in-notes" data-k="notes" type="text" value="${esc(row.notes||'')}" placeholder="Notes…"></td>
    <td><button class="terr-row-del" title="Remove row">✕</button></td>
  </tr>`;
}
function atAddRow(row = {}){
  const body = document.getElementById('atRowsBody');
  if (!body) return;
  body.insertAdjacentHTML('beforeend', atRowHtml(row));
  body.lastElementChild.querySelector('.terr-row-del').addEventListener('click', e => {
    e.target.closest('tr').remove();
    if (!document.querySelector('#atRowsBody tr')) atAddRow({}); // keep at least one row
  });
}
function atSetRows(rows){
  const body = document.getElementById('atRowsBody');
  if (!body) return;
  body.innerHTML = '';
  (rows.length ? rows : [{}]).forEach(atAddRow);
}
function atReadRows(){
  return [...document.querySelectorAll('#atRowsBody tr')].map(tr => {
    const o = {};
    tr.querySelectorAll('[data-k]').forEach(el => o[el.dataset.k] = (el.value || '').trim());
    return o;
  });
}

// ── CSV template ──
function csvCell(v){ v = String(v ?? ''); return /[",\n]/.test(v) ? `"${v.replace(/"/g,'""')}"` : v; }
function terrDownloadTemplate(){
  const headers = ['ZIP','Delivery Day','Work From Date','Target','Complete First','Notes'];
  const sample  = ['01001','Wednesday','2026-07-15','12','','High-density — start north end'];
  const csv = headers.map(csvCell).join(',') + '\n' + sample.map(csvCell).join(',') + '\n';
  const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'territory-import-template.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setTerrBulkMsg('Template downloaded');
}

// ── Date normalizer (shared by upload + AI + apply) ──
function pad2(n){ return String(n).padStart(2,'0'); }
function normalizeDate(v){
  if (v == null || v === '') return '';
  if (v instanceof Date && !isNaN(v)) return `${v.getFullYear()}-${pad2(v.getMonth()+1)}-${pad2(v.getDate())}`;
  if (typeof v === 'number' && v > 59) {            // Excel serial date
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth()+1)}-${pad2(d.getUTCDate())}`;
  }
  const s = String(v).trim();
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${pad2(iso[2])}-${pad2(iso[3])}`;
  const md = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
  if (md) { let [,m,d,y] = md; if (y.length === 2) y = '20'+y; return `${y}-${pad2(m)}-${pad2(d)}`; }
  return '';
}

// ── Spreadsheet upload (deterministic header auto-map) ──
function mapSheetRow(obj){
  const find = re => { const k = Object.keys(obj).find(h => re.test(h)); return k != null ? obj[k] : ''; };
  const zip = normalizeAreaId(find(/zip|postal|postcode|sector/i));
  return {
    zip,
    delivery_day: normalizeDay(find(/deliver|(^|[^a-z])day([^a-z]|$)/i)),
    hub:          normalizeHub(find(/^hub$|depot|hub/i)),
    work_date:    normalizeDate(find(/work|date|start|from/i)),
    sales_target: String(find(/target|goal|quota/i) || '').replace(/\D/g,''),
    blocked_by:   normalizeAreaId(find(/complete|before|block|prereq|first|depend/i)),
    notes:        String(find(/note|comment|desc/i) || '').trim(),
  };
}
function terrHandleFile(file){
  if (!window.XLSX){ ensureXLSX().then(() => terrHandleFile(file)).catch(() => toast('Spreadsheet parser not loaded — check your connection', 'error')); return; }
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const wb = XLSX.read(ev.target.result, { type:'array' });
      const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval:'' });
      if (!data.length){ toast('Sheet appears empty', 'error'); return; }
      const rows = data.map(mapSheetRow).filter(r => r.zip);
      if (!rows.length){ toast('No ZIP column detected — try “Extract with AI”', 'error'); return; }
      atSetRows(rows);
      setTerrBulkMsg(`${rows.length} row${rows.length!==1?'s':''} loaded`);
    } catch(e){ toast('Could not read file: ' + e.message, 'error'); }
  };
  reader.readAsArrayBuffer(file);
}

// ── AI extraction (any format: spreadsheets, photos, PDFs, JSON, text) ──
function terrReadFile(file, as){
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Could not read file'));
    if (as === 'text') r.readAsText(file);
    else if (as === 'dataurl') r.readAsDataURL(file);
    else r.readAsArrayBuffer(file);
  });
}

// Downscale + re-encode a photo to JPEG base64 (bounds upload size; also
// converts HEIC on browsers that can decode it, i.e. Safari/iPhone)
function terrImageToJpegBase64(file, maxDim = 2000, quality = 0.85){
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale  = Math.min(1, maxDim / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width  = Math.max(1, Math.round(img.width  * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality).split(',')[1]);
      } catch(e){ reject(e); }
      finally { URL.revokeObjectURL(url); }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not decode that image — for HEIC photos, try a screenshot or JPEG'));
    };
    img.src = url;
  });
}

async function terrAiRequest(body){
  const resp = await fetch('/api/parse-territories', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'AI extraction failed');
  return (data.rows || []).map(r => ({
    zip:          normalizeAreaId(r.zip),
    delivery_day: normalizeDay(r.delivery_day),
    hub:          normalizeHub(r.hub),
    work_date:    normalizeDate(r.work_date),
    sales_target: String(r.sales_target||'').replace(/\D/g,''),
    blocked_by:   normalizeAreaId(r.blocked_by),
    notes:        String(r.notes||'').trim(),
  })).filter(r => r.zip);
}

async function terrAiExtract(file){
  const name = (file.name || '').toLowerCase();
  const type = file.type || '';
  setTerrBulkMsg('🤖 Reading with AI…');
  try {
    let body;
    if (/\.(xlsx|xls|csv)$/.test(name)) {
      if (!window.XLSX) await ensureXLSX();
      const wb = XLSX.read(await terrReadFile(file, 'array'), { type:'array' });
      const rawRows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval:'' });
      if (!rawRows.length) throw new Error('Sheet appears empty');
      body = { rows: rawRows.slice(0, 300) };
    } else if (type.startsWith('image/') || /\.(png|jpe?g|webp|gif|heic|heif)$/.test(name)) {
      setTerrBulkMsg('🤖 Preparing photo…');
      const data = await terrImageToJpegBase64(file);
      setTerrBulkMsg('🤖 Reading with AI…');
      body = { image: { media_type: 'image/jpeg', data } };
    } else if (type === 'application/pdf' || /\.pdf$/.test(name)) {
      if (file.size > 12 * 1024 * 1024) throw new Error('PDF too large — keep it under 12 MB');
      body = { pdf: String(await terrReadFile(file, 'dataurl')).split(',')[1] };
    } else if (type === 'application/json' || /\.json$/.test(name)) {
      const txt = String(await terrReadFile(file, 'text'));
      let parsed = null;
      try { parsed = JSON.parse(txt); } catch {}
      // A JSON array of row objects goes down the structured path; anything
      // else is handed over as raw text for the model to make sense of
      body = Array.isArray(parsed) && parsed.length && typeof parsed[0] === 'object'
        ? { rows: parsed.slice(0, 300) }
        : { text: txt.slice(0, 40000) };
    } else {
      const txt = String(await terrReadFile(file, 'text')).trim();
      if (!txt) throw new Error('File appears empty');
      body = { text: txt.slice(0, 40000) };
    }
    const rows = await terrAiRequest(body);
    if (!rows.length) throw new Error('AI found no valid ZIPs in that file');
    atSetRows(rows);
    setTerrBulkMsg(`🤖 ${rows.length} row${rows.length!==1?'s':''} extracted`);
  } catch(e){
    setTerrBulkMsg('');
    toast(e.message, 'error');
  }
}

// ── Resting review — ZIPs held out of a batch add, approved one by one ──
let terrRestQueue = [];   // [{ zip, patch, rest:{last,until,weeks} }]
function renderTerrRestReview(){
  const el = document.getElementById('terrRestReview');
  if (!el) return;
  if (!terrRestQueue.length) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="trr-title">⚠️ Worked within the last ${REST_WEEKS} weeks — approve each ZIP or skip it:</div>
    ${terrRestQueue.map(q => `
      <div class="trr-row">
        <span class="trr-zip">${q.zip}</span>
        <span class="trr-msg">worked week of ${q.rest.last} (${q.rest.weeks}w ago) · rest until ${q.rest.until}</span>
        <button class="trr-btn trr-skip" data-trr-skip="${q.zip}">Skip</button>
        <button class="trr-btn trr-ok" data-trr-ok="${q.zip}" title="Add to the pipeline with 😴 Resting toggled">Override + 😴</button>
      </div>`).join('')}`;
  el.querySelectorAll('[data-trr-skip]').forEach(b => b.addEventListener('click', () => {
    terrRestQueue = terrRestQueue.filter(q => q.zip !== b.dataset.trrSkip);
    renderTerrRestReview();
  }));
  el.querySelectorAll('[data-trr-ok]').forEach(b => b.addEventListener('click', () => {
    const q = terrRestQueue.find(x => x.zip === b.dataset.trrOk);
    if (!q) return;
    patchEdit(q.zip, withResting(q.zip, q.patch));
    applyEdits(); updateStats();
    if (currentView === 'pipeline') renderPipeline();
    terrRestQueue = terrRestQueue.filter(x => x.zip !== q.zip);
    renderTerrRestReview();
    toast(`${q.zip} added with 😴 Resting`, 'ok');
  }));
}

// ── Quick-paste bare ZIPs → rows ──
function terrQuickToRows(){
  const raw  = document.getElementById('addTerritoriesInput').value;
  // One id per line/comma; a piece that isn't one id on its own (several
  // ZIPs separated by spaces) is split on whitespace. UK sectors keep their space.
  const zips = [...new Set(raw.split(/[\n,;]+/).flatMap(piece => {
    const one = normalizeAreaId(piece);
    return one ? [one] : piece.split(/\s+/).map(normalizeAreaId);
  }).filter(Boolean))];
  if (!zips.length){ toast(`No valid ${AREA_LABEL}s found`, 'error'); return; }
  const existing = atReadRows().filter(r => r.zip);
  const have = new Set(existing.map(r => r.zip));
  atSetRows([...existing, ...zips.filter(z => !have.has(z)).map(z => ({ zip:z }))]);
  document.getElementById('addTerritoriesInput').value = '';
  setTerrBulkMsg(`+${zips.length} ZIP${zips.length!==1?'s':''}`);
}

function applyAddTerritories(){
  const office = document.getElementById('addTerritoriesOffice')?.value || OFFICE_KEYS[0];
  const rows = atReadRows();

  let added = 0, updated = 0, alreadyIn = 0, skipped = 0;
  const patches = {}, seen = new Set();
  rows.forEach(row => {
    const zip = normalizeAreaId(row.zip);
    if (!zip || !byZip[zip]) { if (row.zip) skipped++; return; }
    if (seen.has(zip)) return; seen.add(zip);

    const isNew = !edits[zip]?.pipeline_stage;
    const patch = {};
    if (isNew) { patch.pipeline_stage = 'incoming'; patch.office = office; }

    const day = normalizeDay(row.delivery_day);   if (day) patch.delivery_day = day;
    const hub = normalizeHub(row.hub);             if (hub) patch.hub = hub;
    const wd  = normalizeDate(row.work_date);      if (wd)  patch.work_date = wd;
    const tgt = String(row.sales_target||'').replace(/\D/g,''); if (tgt) patch.sales_target = tgt;
    const blk = normalizeAreaId(row.blocked_by);
    if (blk && blk !== zip && byZip[blk]) patch.blocked_by = blk;
    if (row.notes) patch.client_notes = row.notes;

    // Resting guard: entering the pipeline (no date = judged against today) or
    // attaching a date inside the rest window holds the ZIP out of the batch —
    // it must be approved one by one in the review list below.
    const rest = (isNew || wd) ? restCheck(zip, wd || null) : null;
    if (rest) {
      if (!terrRestQueue.some(q => q.zip === zip)) terrRestQueue.push({ zip, patch, rest });
      return;
    }

    if (Object.keys(patch).length) patches[zip] = patch;
    if (isNew) added++;
    else if (Object.keys(patch).length) { alreadyIn++; updated++; }
    else alreadyIn++;
  });

  if (Object.keys(patches).length) patchEditsBulk(patches);
  applyEdits(); updateStats();

  const parts = [];
  if (added)    parts.push(`✓ Added ${added} to ${OFFICES[office]||office} Incoming`);
  if (updated)  parts.push(`${updated} existing updated`);
  if (alreadyIn - updated > 0) parts.push(`${alreadyIn - updated} already in pipeline`);
  if (skipped)  parts.push(`${skipped} not found / invalid`);
  if (terrRestQueue.length) parts.push(`⚠️ ${terrRestQueue.length} held back — worked too recently, review below`);
  document.getElementById('addTerritoriesResult').textContent =
    parts.join(' · ') || 'Nothing to add — enter at least one valid ZIP';
  renderTerrRestReview();

  if (added || updated){
    if (currentView === 'pipeline') renderPipeline();
    if (deliveryFilter !== 'all') refreshAllStyles();
    document.getElementById('addTerritoriesApply').textContent = 'Add More';
  }
}

// ─── Chips ───────────────────────────────────────────────────────────────────
function buildChips(){
  const wrap = document.getElementById('stateChips');
  STATES.forEach(st => {
    const b = document.createElement('button');
    b.className = 'chip' + (activeStates.has(st) ? ' active' : '');
    b.textContent = st; b.dataset.state = st;
    b.addEventListener('click', () => {
      if (activeStates.has(st)){ activeStates.delete(st); b.classList.remove('active'); }
      else { activeStates.add(st); b.classList.add('active'); }
      renderTable(); refreshMapVisibility(); savePrefs();
    });
    wrap.appendChild(b);
  });
}

// ─── Map ─────────────────────────────────────────────────────────────────────
// Last map/polygon click position (container px), used to decide whether a ZIP
// popup should instead show a sales-pin card for a pin under the cursor.
let _lastClickPt = null;
function buildMap(){
  map = L.map('map', { zoomControl:true, attributionControl:true }).setView([41.95, -71.4], 9);
  map.attributionControl.setPosition('bottomleft');
  const savedRaw = localStorage.getItem('dispatch_base') || 'street';
  const savedBase = BASE_LAYERS[BASE_ALIASES[savedRaw] || savedRaw] ? (BASE_ALIASES[savedRaw] || savedRaw) : 'street';
  switchBaseLayer(savedBase, true);
  buildLayerSwitcher(savedBase);

  // ZIP polygons are added per state by addStateLayer() as each file loads.

  incidentLayer = L.layerGroup().addTo(map);
  map.on('zoomend', updateIncidentPinScale);
  map.on('zoomend', updateSalesPinRadius);
  updateIncidentPinScale();

  // Sales pins can also sit over the base map (outside any ZIP polygon); catch
  // those taps here. Over a polygon the layer's own handler runs first (and its
  // mouse events don't bubble to the map), so this won't double-fire.
  map.on('click', e => {
    if (document.getElementById('parkPicker')) { map.panTo(e.latlng); return; }
    if (drawMode || selectMode || paintMode) return;
    const pin = salesPinAt(e.containerPoint);
    if (pin) { openSalesPinPopup(pin); return; }
    const door = workedDoorAt(e.containerPoint);
    if (door) openWorkedDoorPopup(door);
  });
}

// One state's ZIP polygons, added the moment its file arrives.
function addStateLayer(st){
  if (!GEO[st] || !map) return;
  if (typeof _zipBBox !== 'undefined') _zipBBox = null;   // rebuilt on next use with this state in
  if (geoLayers[st]) { map.removeLayer(geoLayers[st]); }
  geoLayers[st] = L.geoJSON(GEO[st], {
    style: feature => {
      const p = feature.properties;
      return styleFor(p, p.POSTCODE || p.ZCTA5CE10 || '');
    },
    onEachFeature: (feature, layer) => {
      const p = feature.properties, zip = p.POSTCODE || p.ZCTA5CE10 || '';
      layerByZip[zip] = layer;
      layer.on('click', e => {
        _lastClickPt = e.containerPoint;
        if (document.getElementById('parkPicker')) { map.panTo(e.latlng); return; }   // placing the P: a tap just moves the map
        if (drawMode) return;
        // A sales/worked-door pin sits visually on top of the ZIP — if the tap
        // landed on one, the popup (below) shows that pin's card, not the drawer.
        if (!selectMode && !paintMode && (salesPinAt(e.containerPoint) || workedDoorAt(e.containerPoint))) return;
        if      (selectMode) toggleZipSel(zip);
        else if (paintMode)  showPaintPicker(zip, e.containerPoint);
        else                 openDrawer(zip, { zoom:false });
      });
      // Function content so the popup re-renders fresh each open (stage,
      // delivery day, and sales change after load). One popup, two possible
      // contents: the tapped sales pin's card, else the ZIP summary — so the
      // pin card can't be overridden by a second ZIP popup.
      layer.bindPopup(() => {
        const pin = _lastClickPt ? salesPinAt(_lastClickPt) : null;
        if (pin) return salesPinPopupHtml(pin);
        const door = _lastClickPt ? workedDoorAt(_lastClickPt) : null;
        return door ? workedDoorPopupHtml(door) : popupHtml(p, zip);
      });
      layer.on('popupopen', () => { if (drawMode) layer.closePopup(); });
      layer.on('mouseover', () => {
        if (drawMode) return;
        if (selectedZips.has(zip)) return;
        if (searchFilterZips && !searchFilterZips.has(zip)) return;
        if (showSalesOnly && !salesByZip[zip]) return;
        layer.setStyle({ weight:2.5, fillOpacity: Math.min(overlayOpacity + 0.10, 0.95) });
      });
      layer.on('mouseout', () => { if (!drawMode) layer.setStyle(styleFor(p, zip)); });
    }
  });
  if (activeStates.has(st)) geoLayers[st].addTo(map);
  if (typeof refreshAllStyles === 'function') geoLayers[st].eachLayer(l => { const p = l.feature.properties; l.setStyle(styleFor(p, p.POSTCODE || p.ZCTA5CE10 || '')); });
}

// Keep ✕ pins at a fixed *geographic* size (~a house footprint) instead of a
// fixed screen size — tiny dots when zoomed out, house-sized when zoomed in.
const INCIDENT_PIN_METERS = 16;
function updateIncidentPinScale(){
  if (!map) return;
  const mpp = 40075016.686 * Math.abs(Math.cos(map.getCenter().lat * Math.PI / 180))
            / (256 * Math.pow(2, map.getZoom()));
  const px = Math.max(5, Math.min(44, INCIDENT_PIN_METERS / mpp));
  map.getContainer().style.setProperty('--inc-pin-scale', (px / 22).toFixed(3));
}

// ─── Incident pins (✕ at geocoded incident addresses) ────────────────────────
// Mirrors coverage: a ZIP's pins show when its drawer is open; the layers-panel
// "Incident pins" toggle shows every geocoded incident map-wide ('__ALL__').
function renderIncidentPins(zip){
  if (!incidentLayer) return;
  incidentLayer.clearLayers();
  if (!zip && showAllIncidents) zip = '__ALL__';
  if (!zip) return;
  const zips = zip === '__ALL__' ? Object.keys(edits) : [zip];
  for (const z of zips){
    for (const inc of (edits[z]?.incidents || [])){
      // Only real coordinates: one malformed incident must not throw and
      // take every other safety pin off the map with it.
      if (inc?.lat == null || inc?.lng == null) continue;
      const ilat = +inc.lat, ilng = +inc.lng;
      if (!Number.isFinite(ilat) || !Number.isFinite(ilng) || Math.abs(ilat) > 90 || Math.abs(ilng) > 180) continue;
      // Type filter only applies to the map-wide overlay — an open drawer
      // always shows all of its ZIP's pins
      if (zip === '__ALL__' && incidentTypeFilter !== 'all' && inc.type !== incidentTypeFilter) continue;
      const cfg   = INCIDENT_TYPES.find(t => t.key === inc.type);
      const color = cfg?.color || '#9ca3af';
      // Zero-size icon anchored at the point; the span centers itself on it and
      // scales via --inc-pin-scale so the pin tracks real-world (house) size
      const icon  = L.divIcon({
        className: 'incident-pin-wrap',
        html: `<span class="incident-pin" style="--ipc:${color}">✕</span>`,
        iconSize: [0, 0], iconAnchor: [0, 0],
      });
      L.marker([ilat, ilng], { icon }).addTo(incidentLayer).bindPopup(
        `<div style="font-family:system-ui;font-size:12px;min-width:160px;max-width:230px">
           <strong style="color:${color}">${esc(cfg?.label || inc.type)}</strong>
           ${inc.address ? `<br><span style="color:#333">${esc(inc.address)}</span>` : ''}
           <br><span style="font-size:10px;color:#888">${esc(inc.date || '')} · ${esc(z)}</span>
           ${inc.notes ? `<br><span style="font-size:11px;color:#555;white-space:normal">${esc(inc.notes)}</span>` : ''}
         </div>`, { closeButton:false });
    }
  }
}
// Re-render whichever incident-pin view is on screen
function refreshIncidentPins(){ renderIncidentPins(showAllIncidents ? '__ALL__' : drawerZip); }

async function geocodeAddress(q){
  try {
    const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
    if (!r.ok) return null;
    const d = await r.json();
    return d?.lat != null ? d : null;
  } catch { return null; }
}

function switchBaseLayer(key, init=false){
  key = BASE_ALIASES[key] || key;
  const cfg = BASE_LAYERS[key]; if (!cfg) return;
  if (activeBaseTile) map.removeLayer(activeBaseTile);
  if (activeLabelsTile) { map.removeLayer(activeLabelsTile); activeLabelsTile = null; }
  activeBaseTile = L.tileLayer(cfg.url, cfg.opts).addTo(map);
  if (cfg.fallbackUrl) activeBaseTile.on('tileerror', e => {
    if (e.tile.dataset.fb) return;   // once per tile
    e.tile.dataset.fb = '1';
    e.tile.src = L.Util.template(cfg.fallbackUrl, { ...e.coords });
  });
  activeBaseTile.bringToBack();
  if (cfg.labelsUrls) {
    activeLabelsTile = L.layerGroup(cfg.labelsUrls.map(u => L.tileLayer(u, { maxNativeZoom:19, maxZoom:19, opacity:0.95 }))).addTo(map);
  }
  if (!init) { localStorage.setItem('dispatch_base', key); savePrefs(); }
  document.querySelectorAll('.layer-btn').forEach(b => b.classList.toggle('active', b.dataset.layer === key));
}

function buildLayerSwitcher(activeKey){
  const ctrl = document.getElementById('layerSwitcher');
  const pct = Math.round(overlayOpacity * 100);
  // Default collapsed on phones (no saved preference) — the expanded panel
  // covers a third of the map on small screens
  const lsSaved = localStorage.getItem('dispatch_ls_collapsed');
  const lsCollapsed = lsSaved === null ? isMob() : lsSaved === '1';
  if (lsCollapsed) ctrl.classList.add('ls-collapsed');

  // Restore saved position — desktop only (mobile has fixed CSS position)
  if (!isMob()) {
    try {
      const pos = JSON.parse(localStorage.getItem('dispatch_ls_pos') || 'null');
      if (pos) { ctrl.style.left = pos.left + 'px'; ctrl.style.top = pos.top + 'px'; ctrl.style.right = 'auto'; }
    } catch(e) {}
  }

  ctrl.innerHTML = `
    <div class="ls-handle${lsCollapsed ? '' : ' ls-expanded'}" id="lsHandle" title="Tap to open/close · drag to move">
      <span class="ls-handle-icon" id="lsToggle">⊞</span>
      <span class="ls-handle-lbl${lsCollapsed ? ' hidden' : ''}">Layers</span>
      ${helpBtn('layers', 'base')}
      <span class="ls-handle-x${lsCollapsed ? ' hidden' : ''}">✕</span>
    </div>
    <div class="ls-panel">
      <div class="ls-buttons">
        ${Object.entries(BASE_LAYERS).map(([key, cfg]) =>
          `<button class="layer-btn${key===activeKey?' active':''}" data-layer="${key}">${cfg.label}</button>`
        ).join('')}
      </div>
      <div class="ls-divider"></div>
      <div class="ls-opacity">
        <span class="ls-opacity-label">Fill</span>
        <input type="range" id="overlayOpacitySlider" min="5" max="90" step="5" value="${pct}">
        <span class="ls-opacity-val" id="overlayOpacityVal">${pct}%</span>
      </div>
      <div class="ls-divider"></div>
      <label class="ls-coverage-toggle">
        <input type="checkbox" id="showAllCoverageChk" ${showAllCoverage ? 'checked' : ''}>
        <span title="Show all coverage strokes on the map">✏ Coverage</span>
        ${helpBtn('layers', 'coverage')}
      </label>
      <div class="ls-cov-dates" id="lsCovDates">
        <div class="ls-cov-presets">
          ${[['all','All'],['today','Today'],['yesterday','Yesterday'],['last7','7d'],['last30','30d']]
            .map(([m,l]) => `<button type="button" class="ls-cov-btn${coverageFilterMode===m?' active':''}" data-cov="${m}">${l}</button>`).join('')}
        </div>
        <div class="ls-cov-custom">
          <input type="date" id="covFrom" class="ls-cov-date" value="${esc(coverageFrom||'')}" aria-label="Coverage from date">
          <span class="ls-cov-dash">–</span>
          <input type="date" id="covTo" class="ls-cov-date" value="${esc(coverageTo||'')}" aria-label="Coverage to date">
        </div>
        <div class="ls-cov-caption" id="covCaption"></div>
      </div>
      <div class="ls-divider"></div>
      <label class="ls-coverage-toggle">
        <input type="checkbox" id="showAllIncidentsChk" ${showAllIncidents ? 'checked' : ''}>
        <span title="Show all incident pins on the map">✕ Incidents</span>
        ${helpBtn('layers', 'incidents')}
      </label>
      <div class="ls-inc-filter${showAllIncidents ? '' : ' hidden'}" id="lsIncFilter">
        <select id="incidentTypeFilterSel" class="ls-delivery-sel">
          <option value="all">All types</option>
          ${INCIDENT_TYPES.map(t => `<option value="${t.key}" ${incidentTypeFilter===t.key?'selected':''}>${t.label}</option>`).join('')}
        </select>
      </div>
      ${isSectorLeader() ? '' : `
      <div class="ls-divider"></div>
      <label class="ls-coverage-toggle">
        <input type="checkbox" id="showDifficultyChk" ${showDifficulty ? 'checked' : ''}>
        <span title="Recolor map by permit difficulty">⚡ Difficulty</span>
        ${helpBtn('layers', 'difficulty')}
      </label>
      <div class="ls-diff-legend${showDifficulty ? '' : ' hidden'}" id="lsDiffLegend">
        <span class="ls-diff-lbl">Easy</span>
        ${[1,2,3,4,5].map(d => `<span class="ls-diff-sw" style="background:${DIFFICULTY_COLORS[d]}" title="${d}">${d}</span>`).join('')}
        <span class="ls-diff-lbl">Hard</span>
      </div>`}
      <div class="ls-divider"></div>
      <div class="ls-delivery">
        <span class="ls-delivery-lbl">🚚 Day</span>
        <select class="delivery-filter-sel ls-delivery-sel">
          <option value="all">All days</option>
          ${DELIVERY_DAYS.map(d => `<option value="${d.key}">${d.label}</option>`).join('')}
        </select>
        ${helpBtn('layers', 'dayhub')}
      </div>
      <div class="ls-delivery">
        <span class="ls-delivery-lbl">🏭 Hub</span>
        <select class="hub-filter-sel ls-delivery-sel">
          <option value="all">All hubs</option>
          ${HUBS.map(h => `<option value="${h.key}">${h.label}</option>`).join('')}
        </select>
      </div>
    </div>
  `;
  ctrl.querySelectorAll('.layer-btn').forEach(btn => btn.addEventListener('click', () => switchBaseLayer(btn.dataset.layer)));
  document.getElementById('overlayOpacitySlider').addEventListener('input', e => {
    overlayOpacity = parseInt(e.target.value) / 100;
    document.getElementById('overlayOpacityVal').textContent = e.target.value + '%';
    localStorage.setItem('dispatch_opacity', String(overlayOpacity));
    refreshAllStyles(); savePrefs();
  });

  document.getElementById('showAllCoverageChk').addEventListener('change', e => {
    showAllCoverage = e.target.checked;
    if (showAllCoverage) renderKnocks('__ALL__');
    else renderKnocks(drawerZip); // revert to single-ZIP or clear
    savePrefs();
  });

  document.getElementById('showAllIncidentsChk').addEventListener('change', e => {
    showAllIncidents = e.target.checked;
    document.getElementById('lsIncFilter')?.classList.toggle('hidden', !showAllIncidents);
    refreshIncidentPins(); savePrefs();
  });
  document.getElementById('incidentTypeFilterSel').addEventListener('change', e => {
    incidentTypeFilter = e.target.value;
    refreshIncidentPins(); savePrefs();
  });

  // Coverage date filter — preset buttons + custom range
  const covBtns = ctrl.querySelectorAll('.ls-cov-btn');
  const covFromInp = document.getElementById('covFrom');
  const covToInp   = document.getElementById('covTo');
  const setCovActive = mode => covBtns.forEach(b => b.classList.toggle('active', b.dataset.cov === mode));
  covBtns.forEach(btn => btn.addEventListener('click', () => {
    coverageFilterMode = btn.dataset.cov;
    coverageFrom = coverageTo = null;
    if (covFromInp) covFromInp.value = '';
    if (covToInp)   covToInp.value = '';
    setCovActive(coverageFilterMode);
    refreshCoverage(); savePrefs();
  }));
  const onCustomDate = () => {
    coverageFrom = covFromInp?.value || null;
    coverageTo   = covToInp?.value   || null;
    coverageFilterMode = (coverageFrom || coverageTo) ? 'custom' : 'all';
    setCovActive(coverageFilterMode === 'custom' ? '__none__' : coverageFilterMode);
    refreshCoverage(); savePrefs();
  };
  covFromInp?.addEventListener('change', onCustomDate);
  covToInp?.addEventListener('change', onCustomDate);

  document.getElementById('showDifficultyChk')?.addEventListener('change', e => {
    showDifficulty = e.target.checked;
    document.getElementById('lsDiffLegend')?.classList.toggle('hidden', !showDifficulty);
    refreshAllStyles(); savePrefs();
  });

  const lsDay = ctrl.querySelector('.delivery-filter-sel');
  if (lsDay) {
    lsDay.value = deliveryFilter;
    lsDay.addEventListener('change', e => setDeliveryFilter(e.target.value));
  }
  const lsHub = ctrl.querySelector('.hub-filter-sel');
  if (lsHub) {
    lsHub.value = hubFilter;
    lsHub.addEventListener('change', e => setHubFilter(e.target.value));
  }

  // Collapse toggle — the WHOLE handle bar is the tap target (the old ⊞-only
  // target was near-impossible to hit on a phone). A real drag suppresses the
  // click that follows it, so desktop users can still grab the bar to move
  // the panel without toggling it.
  const handle = document.getElementById('lsHandle');
  let dragMoved = false;
  handle.addEventListener('click', () => {
    if (dragMoved) { dragMoved = false; return; }   // that was a drag, not a tap
    const collapsed = ctrl.classList.toggle('ls-collapsed');
    localStorage.setItem('dispatch_ls_collapsed', collapsed ? '1' : '0');
    handle.classList.toggle('ls-expanded', !collapsed);
    handle.querySelector('.ls-handle-lbl').classList.toggle('hidden', collapsed);
    handle.querySelector('.ls-handle-x').classList.toggle('hidden', collapsed);
  });

  // Drag (mouse only — on touch the bar is purely a toggle)
  let dragging = false, ox = 0, oy = 0, startL = 0, startT = 0;
  handle.addEventListener('mousedown', e => {
    dragging = true; dragMoved = false;
    ox = e.clientX; oy = e.clientY;
    const parentRect = ctrl.parentElement.getBoundingClientRect();
    const ctrlRect  = ctrl.getBoundingClientRect();
    startL = ctrlRect.left - parentRect.left;
    startT = ctrlRect.top  - parentRect.top;
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    if (Math.abs(e.clientX - ox) + Math.abs(e.clientY - oy) > 4) dragMoved = true;
    if (!dragMoved) return;
    const parent = ctrl.parentElement.getBoundingClientRect();
    const newL = Math.max(0, Math.min(startL + e.clientX - ox, parent.width  - ctrl.offsetWidth));
    const newT = Math.max(0, Math.min(startT + e.clientY - oy, parent.height - ctrl.offsetHeight));
    ctrl.style.left = newL + 'px'; ctrl.style.top = newT + 'px'; ctrl.style.right = 'auto';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    if (!dragMoved) return;   // plain click — nothing moved, nothing to save
    localStorage.setItem('dispatch_ls_pos', JSON.stringify({ left: parseInt(ctrl.style.left), top: parseInt(ctrl.style.top) }));
  });
}

function styleFor(p, zip){
  if ((searchFilterZips && zip && !searchFilterZips.has(zip)) ||
      (showSalesOnly && zip && !salesByZip[zip]) ||
      (deliveryFilter !== 'all' && zip && edits[zip]?.delivery_day !== deliveryFilter) ||
      (hubFilter !== 'all' && zip && edits[zip]?.hub !== hubFilter)) {
    return { stroke:false, fill:false, opacity:0, fillOpacity:0, weight:0 };
  }
  const rec = zip ? byZip[zip] : null;
  // Difficulty mode recolors polygons by permit hardness (1–5) instead of status.
  let fill;
  if (showDifficulty && zip) {
    const d = difficultyFor(zip);
    fill = d ? DIFFICULTY_COLORS[d] : COLORS.GREY;
  } else {
    const colorKey = rec ? (rec.color||'GREY') : (p['MapHub Color']||'GREY');
    fill = COLORS[colorKey] || COLORS.GREY;
  }
  const sel  = zip && selectedZips.has(zip);
  // opacity:1 must be explicit — Leaflet merges styles, so a polygon hidden by
  // a search filter (opacity:0) would otherwise keep an invisible border forever
  return { stroke:true, fill:true, opacity:1, color: sel?'#ec008c':'#453455', weight: sel?2.5:0.8, fillColor:fill, fillOpacity: sel?Math.min(overlayOpacity+.2,.92):overlayOpacity };
}

function popupHtml(p, zip){
  const r = byZip[zip];
  const od = officeDist(r, zipOffice(zip));
  const dist = od.dist != null ? ` · ${od.dist} mi` : '';
  const stage = edits[zip]?.pipeline_stage;
  const stageCfg = stage ? PIPELINE_STAGES.find(s => s.key === stage) : null;
  const sales = salesByZip[zip];
  const salesHtml = sales ? `<br><span style="color:#3FAE6A">📦 ${sales} sale${sales!==1?'s':''}</span>` : '';
  const day = edits[zip]?.delivery_day;
  const dayHtml = day ? `<br><span style="color:#ff4da6">🚚 ${dayShort(day)} delivery</span>` : '';
  const diff = showDifficulty ? difficultyFor(zip) : null;
  const diffHtml = diff ? `<br><span style="color:${DIFFICULTY_COLORS[diff]}">⚡ Difficulty ${diff}/5</span>` : '';
  return `<b>${esc(zip)}</b> — ${esc(p.PC_NAME||p.Municipality||'')}${dist}${stageCfg?`<br><span style="color:${stageCfg.color}">${stageCfg.label}</span>`:''}${dayHtml}${salesHtml}${diffHtml}`;
}

function refreshAllStyles(){
  STATES.forEach(st => { if (!geoLayers[st]) return;
    geoLayers[st].eachLayer(l => { const p=l.feature.properties; l.setStyle(styleFor(p, p.POSTCODE||p.ZCTA5CE10||'')); });
  });
}
function refreshLayerStyle(zip){ const l=layerByZip[zip]; if(l) l.setStyle(styleFor(l.feature.properties,zip)); }
function refreshMapVisibility(){
  STATES.forEach(st => {
    const has=activeStates.has(st), layer=geoLayers[st];
    if(!layer) return;
    if(has && !map.hasLayer(layer)) map.addLayer(layer);
    if(!has && map.hasLayer(layer)) map.removeLayer(layer);
  });
}

// ─── Paint mode ──────────────────────────────────────────────────────────────
function buildPaintPicker(){
  const dots = document.getElementById('ppColors');
  Object.entries(STATUS_LABELS).forEach(([key, label]) => {
    const btn = document.createElement('button');
    btn.className = 'pp-dot'; btn.dataset.color = key; btn.title = label;
    btn.style.background = COLORS[key];
    btn.addEventListener('click', () => applyPaintColor(paintZip, key));
    dots.appendChild(btn);
  });
  document.getElementById('paintPickerClose').addEventListener('click', hidePaintPicker);
  document.addEventListener('keydown', e => { if (e.key==='Escape') hidePaintPicker(); });
}

function togglePaintMode(){
  if (selectMode) toggleSelectMode();
  paintMode = !paintMode;
  document.getElementById('paintModeBtn').classList.toggle('active', paintMode);
  document.getElementById('map').classList.toggle('paint-cursor', paintMode);
  if (!paintMode) hidePaintPicker();
}

function showPaintPicker(zip, pt){
  paintZip = zip;
  const r = byZip[zip];
  document.getElementById('ppTitle').textContent = zip + (r ? ' — ' + (r.municipality||r.primary_city||'') : '');
  document.querySelectorAll('.pp-dot').forEach(b => { b.style.background = COLORS[b.dataset.color]; });
  const mapSize = map.getSize();
  const pw = 190, ph = 90;
  const x = Math.min(pt.x + 10, mapSize.x - pw - 10);
  const y = Math.min(pt.y + 10, mapSize.y - ph - 10);
  document.getElementById('paintPicker').style.left = x + 'px';
  document.getElementById('paintPicker').style.top  = y + 'px';
  document.getElementById('paintPicker').classList.add('visible');
}

function hidePaintPicker(){
  document.getElementById('paintPicker').classList.remove('visible');
  paintZip = null;
}

function applyPaintColor(zip, colorKey){
  if (!zip) return;
  // Sync permit_needed to match the new color so status & color stay correlated
  const permitSync = colorKey === 'GREEN' ? false
                   : (colorKey === 'YELLOW' || colorKey === 'RED' || colorKey === 'TEAL') ? true
                   : undefined;
  patchEdit(zip, {
    color: colorKey,
    ...(permitSync !== undefined ? { permit_needed: permitSync } : {}),
  });
  applyEdits();
  refreshLayerStyle(zip);
  updateStats();
  if (currentView === 'pipeline') renderPipeline();
  if (drawerZip === zip) renderDrawerWithTab(zip, drawerActiveTab);
  hidePaintPicker();
}

// ─── Multi-select ────────────────────────────────────────────────────────────
function toggleSelectMode(){
  if (paintMode) togglePaintMode();
  selectMode = !selectMode;
  document.getElementById('selectModeBtn').classList.toggle('active', selectMode);
  document.getElementById('map').classList.toggle('select-cursor', selectMode);
  if (!selectMode){ selectedZips.clear(); updateActionBar(); refreshAllStyles(); renderTable(); }
}

function toggleZipSel(zip){
  if (selectedZips.has(zip)) selectedZips.delete(zip); else selectedZips.add(zip);
  updateActionBar(); refreshLayerStyle(zip); renderTable();
}

function updateActionBar(){
  const n = selectedZips.size;
  document.getElementById('abCount').textContent = `${n} ZIP${n!==1?'s':''} selected`;
  document.getElementById('actionBar').classList.toggle('visible', n>0);
}

function wireActionBar(){
  document.getElementById('abApply').addEventListener('click', applyBulkStatus);
  document.getElementById('abClear').addEventListener('click', () => {
    selectedZips.clear(); updateActionBar(); refreshAllStyles(); renderTable();
  });
}

function applyBulkStatus(){
  const status = document.getElementById('abStatus').value;
  if (!status || !selectedZips.size) return;
  // Same permit_needed sync as paint mode — bulk apply must not desync them
  const permitSync = status === 'GREEN' ? false
                   : (status === 'YELLOW' || status === 'RED' || status === 'TEAL') ? true
                   : undefined;
  const patch = { color: status, ...(permitSync !== undefined ? { permit_needed: permitSync } : {}) };
  const patches = {};
  selectedZips.forEach(zip => { patches[zip] = { ...patch }; });
  patchEditsBulk(patches);
  applyEdits(); selectedZips.clear(); updateActionBar(); refreshAllStyles(); renderTable();
  if (drawerZip) renderDrawerWithTab(drawerZip, drawerActiveTab);
}

// ─── Drag-to-select ──────────────────────────────────────────────────────────
let dragSel = { active:false, startX:0, startY:0, curX:0, curY:0 };

// Real polygon-vs-rectangle test — bbox intersection alone over-selects
// neighbors of irregular ZIP shapes. True when any polygon vertex falls inside
// the rectangle, or any rectangle corner falls inside the polygon.
function polyIntersectsBounds(layer, bounds){
  if (!layer.getBounds().intersects(bounds)) return false; // fast reject
  const verts = [];
  (function walk(a){
    if (!a) return;
    if (a.lat !== undefined) verts.push(a);
    else if (Array.isArray(a)) a.forEach(walk);
  })(layer.getLatLngs());
  if (verts.some(pt => bounds.contains(pt))) return true;
  let ring = layer.getLatLngs();
  while (Array.isArray(ring[0])) ring = ring[0];
  return [bounds.getSouthWest(), bounds.getNorthWest(), bounds.getNorthEast(), bounds.getSouthEast()]
    .some(c => ptInPoly(c.lat, c.lng, ring));
}

function wireDragSelect(){
  const container = map.getContainer();
  const rectEl = document.getElementById('dragSelectRect');

  container.addEventListener('mousedown', e => {
    if (!selectMode || e.button !== 0) return;
    const r = container.getBoundingClientRect();
    dragSel.active = false;
    dragSel.startX = e.clientX - r.left;
    dragSel.startY = e.clientY - r.top;
    dragSel._pending = true;
  });

  document.addEventListener('mousemove', e => {
    if (!dragSel._pending) return;
    const r = container.getBoundingClientRect();
    dragSel.curX = e.clientX - r.left;
    dragSel.curY = e.clientY - r.top;
    const dx = dragSel.curX - dragSel.startX, dy = dragSel.curY - dragSel.startY;
    if (!dragSel.active && Math.sqrt(dx*dx+dy*dy) > 8) {
      dragSel.active = true;
      map.dragging.disable();
    }
    if (dragSel.active) {
      const x = Math.min(dragSel.startX, dragSel.curX);
      const y = Math.min(dragSel.startY, dragSel.curY);
      const w = Math.abs(dx), h = Math.abs(dy);
      rectEl.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;`;
      rectEl.classList.add('active');
    }
  });

  document.addEventListener('mouseup', e => {
    if (!dragSel._pending) return;
    dragSel._pending = false;
    if (!dragSel.active) { map.dragging.enable(); return; }
    rectEl.classList.remove('active');
    map.dragging.enable();
    dragSel.active = false;

    const r = container.getBoundingClientRect();
    const x2 = e.clientX - r.left, y2 = e.clientY - r.top;
    const p1 = map.containerPointToLatLng([dragSel.startX, dragSel.startY]);
    const p2 = map.containerPointToLatLng([x2, y2]);
    const bounds = L.latLngBounds(p1, p2);

    let added = 0;
    STATES.forEach(st => {
      if (!geoLayers[st] || !activeStates.has(st)) return;
      geoLayers[st].eachLayer(l => {
        const p = l.feature.properties, zip = p.POSTCODE||p.ZCTA5CE10||'';
        if (!zip) return;
        try { if (polyIntersectsBounds(l, bounds)) { selectedZips.add(zip); added++; } } catch {}
      });
    });

    if (added) { updateActionBar(); refreshAllStyles(); renderTable(); }
  });
}

// ─── Schedule Calendar ───────────────────────────────────────────────────────
const CAL_DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const CAL_MONTHS = ['January','February','March','April','May','June',
                    'July','August','September','October','November','December'];

function renderCalendar(){
  const [etY, etM, etD] = etToday().split('-').map(Number);   // ET, not device-local
  if (calYear === null)  calYear  = etY;
  if (calMonth === null) calMonth = etM - 1;

  const container = document.getElementById('calendarView');
  if (!container) return;

  // Collect all pipeline ZIPs with a work_date
  const scheduled = [];
  for (const [zip, e] of Object.entries(edits)){
    if (!e.work_date || !e.pipeline_stage || !officeMatch(zip) || !deliveryMatch(zip) || !hubMatch(zip)) continue;
    const r = byZip[zip]; if (!r) continue;
    scheduled.push({ zip, date: e.work_date, town: r.municipality || r.primary_city || zip, color: r.color || 'GREY' });
  }

  // Group by YYYY-MM-DD key
  const byDate = {};
  for (const s of scheduled) (byDate[s.date] = byDate[s.date] || []).push(s);

  const firstDay = new Date(calYear, calMonth, 1);
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const startDow = firstDay.getDay();

  const fillColor = key => ({ GREEN:'#3FAE6A', TEAL:'#0D9488', YELLOW:'#E8B339', RED:'#E5484D', GREY:'#5B6472' }[key] || '#5B6472');

  // Day cells
  let cells = '';
  for (let i = 0; i < startDow; i++) cells += `<div class="cal-cell cal-cell-empty"></div>`;
  for (let d = 1; d <= daysInMonth; d++){
    const dateStr = `${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const isToday = d === etD && calMonth === etM - 1 && calYear === etY;
    const zips = byDate[dateStr] || [];
    cells += `<div class="cal-cell${isToday?' cal-today':''}">
      <span class="cal-date-num${isToday?' cal-today-num':''}">${d}</span>
      <div class="cal-chips">
        ${zips.map(s => {
          const c = fillColor(s.color);
          return `<div class="cal-zip-chip" data-cal-zip="${s.zip}" data-cal-date="${dateStr}"
            style="background:${c}18;border:1px solid ${c}50;color:${c}">
            <span class="cal-chip-zip">${s.zip}</span>
            <span class="cal-chip-town">${esc(s.town)}</span>
            <button class="cal-chip-reschedule" data-cal-zip="${s.zip}" title="Change date">✎</button>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }

  container.innerHTML = `
    <div class="cal-wrap">
      <div class="cal-nav">
        <button class="cal-nav-btn" id="calPrev">‹ Prev</button>
        <span class="cal-month-label">${CAL_MONTHS[calMonth]} ${calYear}${helpBtn('calendar')}</span>
        <button class="cal-nav-btn" id="calNext">Next ›</button>
      </div>
      <div class="cal-grid">
        ${CAL_DAYS.map(d => `<div class="cal-day-head">${d}</div>`).join('')}
        ${cells}
      </div>
      ${scheduled.length === 0 ? `<div class="cal-empty">Nothing scheduled</div>` : ''}
    </div>`;

  document.getElementById('calPrev').addEventListener('click', () => {
    calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; }
    renderCalendar();
  });
  document.getElementById('calNext').addEventListener('click', () => {
    calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; }
    renderCalendar();
  });

  // Open drawer on chip click
  container.querySelectorAll('.cal-zip-chip').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.cal-chip-reschedule')) return;
      openDrawer(el.dataset.calZip);
    });
  });

  // Inline date-change on ✎ button
  container.querySelectorAll('.cal-chip-reschedule').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const zip = btn.dataset.calZip;
      const chip = btn.closest('.cal-zip-chip');
      const cur = edits[zip]?.work_date || '';
      const inp = document.createElement('input');
      inp.type = 'date'; inp.value = cur; inp.className = 'cal-inline-date';
      inp.style.cssText = 'position:absolute;z-index:200;top:0;left:0;background:#1e1233;border:1px solid #ec008c;border-radius:6px;color:#f7eefb;padding:4px 6px;font-size:11px;';
      chip.style.position = 'relative';
      chip.appendChild(inp);
      inp.showPicker?.();
      inp.focus();
      const commit = () => {
        const val = inp.value;
        inp.remove();
        if (!val) return;
        // Resting guard: rescheduling into the ZIP's rest window
        const rest = restCheck(zip, val);
        if (rest) {
          if (!confirmRestOverride(zip, rest, `schedule it for ${val}`)) { renderCalendar(); return; }
          patchEdit(zip, withResting(zip, { work_date: val }));
        } else {
          patchEdit(zip, { work_date: val });
        }
        renderCalendar(); renderTodayBar();
      };
      inp.addEventListener('change', commit);
      inp.addEventListener('blur', () => setTimeout(() => inp.isConnected && inp.remove(), 200));
    });
  });
}

// ─── Coverage (freehand street markup) ───────────────────────────────────────
let actionStack = [];   // { type:'draw', _id, zip, line } | { type:'erase', knock }
let drawTool    = 'pen';
let drawColor   = '#f97316';

let drawWidth   = 5;

function strokeStyle(){
  return drawTool === 'highlighter'
    ? { color:drawColor, weight:drawWidth*4, opacity:.32, lineCap:'square',  lineJoin:'round' }
    : { color:drawColor, weight:drawWidth,   opacity:.88, lineCap:'round',   lineJoin:'round' };
}

// Point-in-polygon (ray-casting) — polygon is array of Leaflet LatLng objects
function ptInPoly(lat, lng, poly){
  let inside = false;
  for (let i=0, j=poly.length-1; i<poly.length; j=i++){
    const xi = poly[i].lat, yi = poly[i].lng;
    const xj = poly[j].lat, yj = poly[j].lng;
    if (((yi>lng)!==(yj>lng)) && (lat < (xj-xi)*(lng-yi)/(yj-yi)+xi)) inside=!inside;
  }
  return inside;
}
function detectZipForPoint(lat, lng, fallback = null){
  // Leaflet gives a Polygon as [outer, ...holes] and a MultiPolygon as
  // [[outer, ...holes], ...]. A point inside a hole belongs to the enclave
  // ZIP, and when boundaries overlap the smallest ZIP wins.
  let best = null, bestArea = Infinity;
  for (const [zip, layer] of Object.entries(layerByZip)){
    try {
      const b = layer.getBounds();
      if (!b.contains([lat,lng])) continue;
      const ll = layer.getLatLngs();
      const polys = ll.length && Array.isArray(ll[0]) && ll[0].length && Array.isArray(ll[0][0]) ? ll : [ll];
      const inside = polys.some(rings => rings[0] && ptInPoly(lat, lng, rings[0]) && !rings.slice(1).some(h => ptInPoly(lat, lng, h)));
      if (!inside) continue;
      const area = (b.getNorth() - b.getSouth()) * (b.getEast() - b.getWest());
      if (area < bestArea) { best = zip; bestArea = area; }
    } catch {}
  }
  if (best) return best;
  // Coverage strokes default to the open drawer's ZIP; callers that must not
  // guess (incident import) pass fallback ''
  return fallback !== null ? fallback : (drawerZip || '');
}

async function loadKnocks(){
  try {
    const d = await fetch('/api/knocks').then(r => r.json());
    if (d.warming) return retryKnocksWarm();   // server RAM store still filling after a deploy
    allKnocks = d.knocks || [];
    // Don't render on load — strokes only show when a ZIP is selected
  } catch(e) { console.warn('loadKnocks:', e); }
}

// Right after a deploy the server answers { warming:true } while it pulls the
// stroke set from the (throttled) database once. Poll until the real data
// lands, then repaint whatever coverage view is open — never leave the map
// looking like the strokes are gone.
function retryKnocksWarm(){
  setTimeout(async () => {
    try {
      const d = await fetch('/api/knocks').then(r => r.json());
      if (d?.warming) return retryKnocksWarm();
      allKnocks = d.knocks || [];
      refreshCoverage();
      if (drawerZip) renderDrawerWithTab(drawerZip, drawerActiveTab);
    } catch { retryKnocksWarm(); }
  }, 20000);
}

function renderKnocks(zip){
  if (!knockLayer) return;
  knockLayer.clearLayers();
  // In "show all" mode keep strokes visible even when drawer closes
  if (!zip && showAllCoverage) zip = '__ALL__';
  if (!zip) { updateCoverageCaption(0, 0); return; }
  const { from, to } = getCoverageBounds();
  const inRange = d => (!from || d >= from) && (!to || d <= to);
  const visible = zip === '__ALL__'
    ? allKnocks.filter(k => inRange(k.date))
    : allKnocks.filter(k => k.zip === zip && inRange(k.date));
  updateCoverageCaption(visible.length, new Set(visible.map(k => k.date)).size);
  // One shared canvas for every stroke — 4k+ SVG <path> nodes made phones
  // crawl in "show all" mode; canvas draws them in a single element.
  if (!covRenderer) covRenderer = L.canvas({ padding: 0.3 });
  for (const k of visible){
    const s    = k.style || { color:'#f97316', weight:5, opacity:.88, lineCap:'round', lineJoin:'round' };
    const line = L.polyline(k.latlngs, { ...s, renderer: covRenderer }).addTo(knockLayer);
    const creator   = esc(k.userName || 'Team member');
    const canDelete = currentUser?.role !== 'sector_leader' || (k.userId && k.userId === currentUser?.id);
    line.bindPopup(
      `<div style="font-family:system-ui;font-size:12px;min-width:120px">
         <strong style="color:#333">${esc(k.date)}</strong>
         <br><span style="font-size:10px;color:#555">by ${creator}</span>
         ${canDelete ? `<br><button data-del-knock="${esc(k._id)}" style="margin-top:6px;padding:3px 10px;background:#ef4444;color:#fff;border:none;border-radius:4px;font-size:11px;cursor:pointer">Delete</button>` : ''}
       </div>`,
      { closeButton: false }
    );
    line.on('popupopen', () => {
      document.querySelector(`[data-del-knock="${k._id}"]`)?.addEventListener('click', async () => {
        line.closePopup();
        await deleteKnock(k._id, zip);
      });
    });
  }
}

async function deleteKnock(id, zip){
  await fetch(`/api/knocks/${id}`, { method:'DELETE' });
  allKnocks = allKnocks.filter(k => String(k._id) !== String(id));
  renderKnocks(zip || drawerZip);
  if (drawerZip) renderDrawerWithTab(drawerZip, drawerActiveTab);
}

async function deleteKnocksByDate(zip, date, mineOnly = false){
  const targets = allKnocks.filter(k => {
    if (k.zip !== zip || k.date !== date) return false;
    if (mineOnly && k.userId && k.userId !== currentUser?.id) return false;
    return true;
  });
  await Promise.all(targets.map(k => fetch(`/api/knocks/${k._id}`, { method:'DELETE' })));
  const deletedIds = new Set(targets.map(k => String(k._id)));
  allKnocks = allKnocks.filter(k => !deletedIds.has(String(k._id)));
  renderKnocks(zip);
  if (drawerZip) renderDrawerWithTab(drawerZip, drawerActiveTab);
}

async function saveStroke(s){
  const today = etToday();
  try {
    const body = { zip: s.zip, latlngs: s.latlngs, date: today, style: s.style };
    const res  = await fetch('/api/knocks', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body)
    }).then(r => r.json());
    if (res.ok){
      s._id = res.id;
      if (s._cancelled) { // undone/cancelled while the save was in flight
        fetch(`/api/knocks/${res.id}`, { method:'DELETE' }).catch(() => {});
        return;
      }
      allKnocks.push({ _id: res.id, ...body, userId: currentUser?.id || null, userName: currentUser?.name || null });
    }
  } catch(e) { console.error('saveStroke:', e); }
}

function cancelMarkupSession(){
  let hadErase = false;
  for (const a of actionStack) {
    if (a.type === 'draw') {
      if (a.line) knockLayer.removeLayer(a.line);
      // Strokes auto-save on draw — cancel must also remove them server-side,
      // or they'd silently reappear on the next reload
      if (a._id) {
        fetch(`/api/knocks/${a._id}`, { method:'DELETE' }).catch(() => {});
        allKnocks = allKnocks.filter(k => String(k._id) !== String(a._id));
      } else {
        a._cancelled = true; // save in flight — deleted once the id arrives
      }
    }
    if (a.type === 'erase') { allKnocks.push(a.knock); hadErase = true; }
  }
  actionStack = [];
  if (hadErase) renderKnocks(drawerZip);
  exitDrawMode();
}

async function undoLastStroke(){
  if (!actionStack.length) return;
  const last = actionStack.pop();
  if (last.type === 'draw') {
    if (last.line) knockLayer.removeLayer(last.line);
    if (last._id) await deleteKnock(last._id, last.zip || drawerZip);
    else last._cancelled = true; // save still in flight — deleted once the id arrives
  } else if (last.type === 'erase') {
    allKnocks.push(last.knock);
    renderKnocks(drawerZip);
  }
}

function enterDrawMode(){
  drawMode = true;
  map.closePopup(); // dismiss any open ZIP tooltip before drawing starts
  // Collapse the drawer so the full map is usable for drawing
  const drawer = document.getElementById('drawer');
  const overlay = document.getElementById('drawerOverlay');
  if (drawer?.classList.contains('open')) {
    drawer.dataset.wasOpen = '1';
    drawer.classList.remove('open');
    overlay?.classList.remove('open');
  }
  // Disable one-finger pan; keep pinch-zoom (touchZoom) enabled for mobile
  map.dragging.disable();
  map.doubleClickZoom.disable(); map.boxZoom.disable();
  if (map.keyboard) map.keyboard.disable();
  // tap and touchZoom intentionally left enabled — tap would open popup but draw mode's
  // onStart already returns early if not drawMode; touchZoom lets user pinch-zoom while drawing
  map.getContainer().classList.add('draw-mode');
  document.getElementById('markupToolbar')?.classList.add('visible');
  document.getElementById('mobNav')?.classList.add('draw-hidden');
  document.getElementById('mapTableView')?.classList.add('draw-expanded');
  document.body.classList.add('draw-active');
  // Fade polygon fills so roads are visible while drawing
  STATES.forEach(st => { if (!geoLayers[st]) return;
    geoLayers[st].eachLayer(l => l.setStyle({ fillOpacity: 0.06 }));
  });
}

function exitDrawMode(){
  drawMode = false;
  if (drawActive) {
    if (drawLine) knockLayer.removeLayer(drawLine);
    drawActive = false; drawPoints = []; drawLine = null;
  }
  map.dragging.enable();
  map.doubleClickZoom.enable(); map.scrollWheelZoom.enable();
  map.boxZoom.enable();
  if (map.keyboard) map.keyboard.enable();
  map.getContainer().classList.remove('draw-mode', 'eraser-mode');
  document.getElementById('markupToolbar')?.classList.remove('visible');
  document.getElementById('mobNav')?.classList.remove('draw-hidden');
  document.getElementById('mapTableView')?.classList.remove('draw-expanded');
  document.body.classList.remove('draw-active');
  // Restore polygon fill opacities
  STATES.forEach(st => { if (!geoLayers[st]) return;
    geoLayers[st].eachLayer(l => { const p=l.feature.properties; l.setStyle(styleFor(p, p.POSTCODE||p.ZCTA5CE10||'')); });
  });
  // Restore drawer if it was open before drawing started
  const drawer = document.getElementById('drawer');
  const overlay = document.getElementById('drawerOverlay');
  if (drawer?.dataset.wasOpen === '1') {
    delete drawer.dataset.wasOpen;
    drawer.classList.add('open');
    overlay?.classList.add('open');
  }
}

function toggleDrawMode(){ drawMode ? cancelMarkupSession() : enterDrawMode(); }

function eraserHit(ll){
  const zoom = map.getZoom();
  const mpp = 40075016.686 * Math.abs(Math.cos(ll.lat * Math.PI / 180)) / (256 * Math.pow(2, zoom));
  const radiusM = 30 * mpp; // 30px eraser radius at current zoom
  const cosLat = Math.cos(ll.lat * Math.PI / 180);
  const isSL = currentUser?.role === 'sector_leader';
  const hits = allKnocks.filter(k => {
    if (isSL && !(k.userId && k.userId === currentUser?.id)) return false;
    return k.latlngs.some(([lat, lng]) => {
      const dlat = (lat - ll.lat) * 111320;
      const dlng = (lng - ll.lng) * 111320 * cosLat;
      return dlat*dlat + dlng*dlng <= radiusM*radiusM;
    });
  });
  if (!hits.length) return;
  const hitIds = new Set(hits.map(k => String(k._id)));
  // Stage erasures locally — only DELETE from server when user hits Done
  for (const k of hits) actionStack.push({ type:'erase', knock: {...k} });
  allKnocks = allKnocks.filter(k => !hitIds.has(String(k._id)));
  renderKnocks(drawerZip);
}

function buildCoverageControl(){
  knockLayer = L.layerGroup().addTo(map);
  const cont = map.getContainer();
  let lastSample = 0;
  let drawStartTimer = null; // delay before stroke begins

  // Per-stroke tracking — used to reject glitch strokes (see finalizeStroke)
  let drawTouchId   = null;   // identifier of the finger that owns the stroke
  let strokeStart   = 0;      // stroke start timestamp
  let strokeFirstPt = null;   // first sampled container point (px)
  let strokePathPx  = 0;      // finger travel in px
  let lastPt = null, lastPtTime = 0;

  function getPt(e){
    const rect = cont.getBoundingClientRect();
    const src  = e.touches ? e.touches[0] : e;
    return L.point(src.clientX - rect.left, src.clientY - rect.top);
  }
  function getLL(e){ return map.containerPointToLatLng(getPt(e)); }
  function isToolbar(e){ return !!e.target.closest?.('#markupToolbar'); }

  function beginStroke(ll, pt, touchId){
    if (!drawMode) return; // mode exited during the delay
    drawActive    = true;
    drawTouchId   = touchId ?? null;
    strokeStart   = Date.now();
    strokeFirstPt = pt || null;
    strokePathPx  = 0;
    lastPt = pt || null; lastPtTime = Date.now();
    drawPoints = [[ll.lat, ll.lng]];
    drawLine = L.polyline([[ll.lat, ll.lng]], strokeStyle()).addTo(knockLayer);
  }

  // Close out the active stroke: save it if it looks like intentional marking.
  // Dropped: micro-dots (<4 points or barely any travel) and fast straight
  // swipes — a failed one-finger pan reads as a quick, almost perfectly
  // straight flick, which is how stray lines were getting saved.
  function finalizeStroke(){
    const line = drawLine, pts = drawPoints;
    const duration = Date.now() - strokeStart;
    const chordPx  = (lastPt && strokeFirstPt) ? lastPt.distanceTo(strokeFirstPt) : 0;
    const pathPx   = strokePathPx;
    drawActive = false; drawTouchId = null;
    drawLine = null; drawPoints = [];
    lastPt = null; strokeFirstPt = null; strokePathPx = 0;
    if (!line) return;
    const speed        = pathPx / Math.max(1, duration);   // px per ms
    const straightness = pathPx > 0 ? chordPx / pathPx : 0;
    const isSwipe = duration < 300 && speed > 1.2 && straightness > 0.92 && pathPx > 60;
    if (!isSwipe && pts.length >= 4 && pathPx > 24) {
      const mid = pts[Math.floor(pts.length/2)];
      const zip = detectZipForPoint(mid[0], mid[1]);
      // One shared object on the stack AND in saveStroke — saveStroke stamps
      // _id onto it, which undo needs to delete the stroke server-side
      const entry = { type:'draw', latlngs:[...pts], style:strokeStyle(), line, zip };
      actionStack.push(entry);
      saveStroke(entry); // auto-save immediately
    } else {
      knockLayer.removeLayer(line);
      if (isSwipe) toast('Fast swipe ignored — use two fingers to move the map', 'info');
    }
  }

  function onStart(e){
    if (!drawMode || isToolbar(e)) return;
    if (e.touches && e.touches.length !== 1) return; // two-finger = pinch-zoom, not draw
    e.stopPropagation(); if (e.preventDefault) e.preventDefault();
    // A new touch while a stroke is still active means we never saw the last
    // touch end (missed touchend/touchcancel) — close it out now, or the old
    // stroke would jump-join to wherever this finger lands
    if (drawActive && drawTool !== 'eraser') finalizeStroke();
    if (drawTool === 'eraser') { drawActive = true; eraserHit(getLL(e)); return; }
    // 120ms delay — short taps (panning attempts) cancel before drawing starts
    const pt = getPt(e), ll = map.containerPointToLatLng(pt);
    const touchId = e.touches ? e.touches[0].identifier : 'mouse';
    drawStartTimer = setTimeout(() => { drawStartTimer = null; beginStroke(ll, pt, touchId); }, 120);
  }
  function onMove(e){
    if (!drawMode || isToolbar(e)) return;
    if (e.touches && e.touches.length !== 1) {
      // Second finger = pinch-zoom — close out the stroke instead of leaving
      // it dangling (finalizeStroke keeps real work, drops accidental marks)
      if (drawStartTimer) { clearTimeout(drawStartTimer); drawStartTimer = null; }
      if (drawActive && drawTool !== 'eraser') finalizeStroke();
      drawActive = false;
      return;
    }
    if (!drawActive) return; // still in pre-draw delay, let map handle it
    if (e.preventDefault) e.preventDefault();
    // The stroke follows only the finger that started it — moves from a
    // different finger (after a missed touchend) must not extend the line
    if (e.touches && drawTouchId != null && e.touches[0].identifier !== drawTouchId) return;
    const now = Date.now(); if (now - lastSample < 30) return; lastSample = now;
    const pt = getPt(e), ll = map.containerPointToLatLng(pt);
    if (drawTool === 'eraser') { eraserHit(ll); return; }
    if (lastPt) {
      const dist = pt.distanceTo(lastPt);
      // Teleport guard: a finger can't jump this far between samples — it's a
      // dropped/merged touch (double-tap glitch). Split into two strokes
      // instead of drawing a straight line across the gap.
      if (dist > 150 && dist / Math.max(1, now - lastPtTime) > 3) {
        const tid = drawTouchId;
        finalizeStroke();
        beginStroke(ll, pt, tid);
        return;
      }
      strokePathPx += dist;
    }
    lastPt = pt; lastPtTime = now;
    drawPoints.push([ll.lat, ll.lng]);
    drawLine?.setLatLngs(drawPoints);
  }
  function onEnd(e){
    if (!drawMode || isToolbar(e)) return;
    // Cancel pending delay — tap lifted before drawing started
    if (drawStartTimer) { clearTimeout(drawStartTimer); drawStartTimer = null; return; }
    if (!drawActive) return;
    if (e.preventDefault) e.preventDefault();
    // Only the stroke's own finger lifting ends the stroke
    if (e.changedTouches && drawTouchId != null &&
        ![...e.changedTouches].some(t => t.identifier === drawTouchId)) return;
    if (drawTool === 'eraser') { drawActive = false; return; }
    finalizeStroke();
  }
  // iOS/Android cancel touches mid-stroke (notifications, palm rejection,
  // system gestures). Without this, the stroke stayed active and the next tap
  // extended it — drawing a stray straight line between the two points.
  function onCancel(){
    if (!drawMode) return;
    if (drawStartTimer) { clearTimeout(drawStartTimer); drawStartTimer = null; }
    if (!drawActive) return;
    if (drawTool === 'eraser') { drawActive = false; return; }
    finalizeStroke();
  }

  cont.addEventListener('mousedown',  onStart, true);
  cont.addEventListener('mousemove',  onMove,  true);
  cont.addEventListener('mouseup',    onEnd,   true);
  cont.addEventListener('touchstart', onStart, { passive:false, capture:true });
  cont.addEventListener('touchmove',  onMove,  { passive:false, capture:true });
  cont.addEventListener('touchend',   onEnd,   { passive:false, capture:true });
  cont.addEventListener('touchcancel', onCancel, { passive:true, capture:true });

  // ── Markup toolbar (injected into #map so it sits above the caption bar) ──
  const tb = document.createElement('div');
  tb.id = 'markupToolbar';
  tb.className = 'markup-toolbar';
  tb.innerHTML = `
    <div class="markup-row markup-row-tools">
      <button class="markup-tool active" data-tool="pen"         title="Pen">Pen</button>
      <button class="markup-tool"        data-tool="highlighter" title="Highlighter">Marker</button>
      <button class="markup-tool markup-tool-erase" data-tool="eraser" title="Eraser">Erase</button>
      <div class="markup-sep"></div>
      <button class="markup-width active" data-width="3"  title="Thin">  <span class="mw-line" style="height:2px"></span></button>
      <button class="markup-width"        data-width="6"  title="Medium"><span class="mw-line" style="height:5px"></span></button>
      <button class="markup-width"        data-width="11" title="Thick"> <span class="mw-line" style="height:8px"></span></button>
    </div>
    <div class="markup-row markup-row-colors">
      <button class="markup-swatch active" data-color="#f97316" style="background:#f97316"></button>
      <button class="markup-swatch"        data-color="#ef4444" style="background:#ef4444"></button>
      <button class="markup-swatch"        data-color="#facc15" style="background:#facc15"></button>
      <button class="markup-swatch"        data-color="#22c55e" style="background:#22c55e"></button>
      <button class="markup-swatch"        data-color="#3b82f6" style="background:#3b82f6"></button>
      <button class="markup-swatch"        data-color="#a855f7" style="background:#a855f7"></button>
      <button class="markup-swatch markup-swatch-white" data-color="#ffffff" style="background:#fff"></button>
    </div>
    <div class="markup-row markup-row-actions">
      <button id="markupUndoBtn" class="markup-action markup-action-undo" title="Undo last stroke">↩ Undo</button>
      <button id="markupDoneBtn" class="markup-action markup-save"        title="Done drawing">✓ Done</button>
    </div>`;
  cont.appendChild(tb);  // inside #map (Leaflet container) so bottom:0 is above the caption

  tb.querySelectorAll('.markup-tool').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    tb.querySelectorAll('.markup-tool').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    drawTool = btn.dataset.tool;
    const isEraser = drawTool === 'eraser';
    tb.querySelector('.markup-row-colors').style.opacity = isEraser ? '0.3' : '';
    tb.querySelectorAll('.markup-width').forEach(b => b.style.opacity = isEraser ? '0.3' : '');
    cont.classList.toggle('eraser-mode', isEraser);
  }));
  tb.querySelectorAll('.markup-width').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    tb.querySelectorAll('.markup-width').forEach(b => b.classList.remove('active'));
    btn.classList.add('active'); drawWidth = parseInt(btn.dataset.width);
  }));
  tb.querySelectorAll('.markup-swatch').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    tb.querySelectorAll('.markup-swatch').forEach(b => b.classList.remove('active'));
    btn.classList.add('active'); drawColor = btn.dataset.color;
  }));
  document.getElementById('markupUndoBtn').addEventListener('click', e => { e.stopPropagation(); undoLastStroke(); });
  document.getElementById('markupDoneBtn').addEventListener('click', e => {
    e.stopPropagation();
    // Commit staged erasures to the server now that the user confirmed Done
    actionStack.filter(a => a.type === 'erase').forEach(a => {
      fetch(`/api/knocks/${a.knock._id}`, { method:'DELETE' }).catch(() => {});
    });
    actionStack = [];
    exitDrawMode();
  });

}

// Body of the drawer's Coverage section (the "Mark Off" button lives in the
// section header, added by renderDrawerWithTab)
function renderCoverageSection(zip){
  const cutoff    = Date.now() - 84*24*60*60*1000;
  const zipKnocks = allKnocks.filter(k => k.zip === zip && new Date(k.date).getTime() >= cutoff);
  const wksLeft   = date => Math.max(0, Math.ceil((new Date(date).getTime()+84*24*60*60*1000-Date.now())/(7*24*60*60*1000)));

  if (!zipKnocks.length) return `<div class="coverage-empty">No coverage yet</div>`;

  // Group by date, track who drew each session
  const byDate = {};
  for (const k of zipKnocks){
    if (!byDate[k.date]) byDate[k.date] = { strokes:[], names: new Set() };
    byDate[k.date].strokes.push(k);
    if (k.userName) byDate[k.date].names.add(k.userName);
  }

  const isSL = isSectorLeader();

  return `
      <div class="coverage-list">
        ${Object.entries(byDate).sort(([a],[b])=>b.localeCompare(a)).map(([date, info])=>{
          const names = esc(info.names.size ? [...info.names].join(', ') : 'Team');
          const myStrokes    = info.strokes.filter(k => k.userId && k.userId === currentUser?.id);
          const allMine      = myStrokes.length === info.strokes.length;
          // Admin/client: delete all; sector leader: delete all only if all are theirs; else delete mine
          const delBtn = !isSL
            ? `<button class="coverage-date-del" data-zip="${zip}" data-date="${date}" title="Delete all coverage from this day">×</button>`
            : allMine
              ? `<button class="coverage-date-del" data-zip="${zip}" data-date="${date}" title="Delete your coverage from this day">×</button>`
              : myStrokes.length > 0
                ? `<button class="coverage-date-del-mine" data-zip="${zip}" data-date="${date}" title="Delete only your strokes from this day">Delete mine</button>`
                : '';
          return `
          <div class="coverage-date-row">
            <div class="coverage-date-header">
              <div class="coverage-date-main">
                <span class="coverage-date-lbl">${date}</span>
                <span class="coverage-marked-by">by ${names}</span>
              </div>
              <span class="coverage-expiry">resets in ${wksLeft(date)}w</span>
              ${delBtn}
            </div>
          </div>`;
        }).join('')}
      </div>`;
}

// ─── Table (view removed — kept as a no-op so call sites stay harmless) ──────
function renderTable(){}

function searchFlyToResults(){
  const q = document.getElementById('searchInput').value.trim().toLowerCase();
  if (!q || q.length < 2) {
    // Clear filter when search is empty
    if (searchFilterZips !== null) { searchFilterZips = null; refreshAllStyles(); }
    return;
  }
  const matchSet = new Set();
  const bounds = L.latLngBounds([]);
  MASTER.forEach(r => {
    if (!activeStates.has(r.state)) return;
    const match = r.zip.includes(q) || (r.municipality||'').toLowerCase().includes(q) ||
                  (r.primary_city||'').toLowerCase().includes(q) || (r.county||'').toLowerCase().includes(q);
    if (!match) return;
    matchSet.add(r.zip);
    const layer = layerByZip[r.zip];
    if (layer) bounds.extend(layer.getBounds());
  });
  searchFilterZips = matchSet;
  refreshAllStyles();
  if (bounds.isValid()) map.flyToBounds(bounds, { maxZoom:13, padding:[30,30], duration:.6 });
}

// ─── Drawer ──────────────────────────────────────────────────────────────────
function openDrawer(zip, opts){
  drawerZip = zip;
  const r = byZip[zip]; if (!r) return;
  renderDrawerWithTab(zip, drawerActiveTab);
  document.getElementById('drawer').classList.add('open');
  document.getElementById('drawer').classList.remove('expanded');  // each open starts at the peek snap
  document.getElementById('drawerOverlay').classList.add('open');
  document.getElementById('drawer').setAttribute('aria-hidden','false');
  // Beat iOS auto-scroll-to-focused-select: blur + reset at multiple intervals
  const resetScroll = () => {
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    if (opts?.scrollTo === 'routes') { document.querySelector('[data-sec="routes"]')?.scrollIntoView({ block: 'start' }); return; }
    const dc = document.getElementById('drawerContent');
    if (dc) dc.scrollTop = 0;
  };
  resetScroll();
  [80, 200, 400].forEach(t => setTimeout(resetScroll, t));
  renderKnocks(zip);  // show only this ZIP's coverage
  refreshIncidentPins();  // ✕ pins for this ZIP (or all, if the overlay is on)
  if (routesLayer && !(routePlansByZip[zip] || []).some(p => p.id === routeSelPlan)) { map.removeLayer(routesLayer); routesLayer = null; syncRouteSelBar(zip, null); }
  loadRoutePlans(zip);  // walking-route plans + free-door coverage for this ZIP
  if (currentView === 'map'){
    const l = layerByZip[zip];
    // opts.zoom === false (a direct map tap) → open the card without recentering
    // or zooming, which was distracting. List/search opens still zoom to locate.
    if (l){ if (opts?.zoom !== false) map.fitBounds(l.getBounds(), { maxZoom:13 }); l.openPopup(); }
  }
}

function renderDrawerWithTab(zip, tab){
  drawerActiveTab = tab;
  const r = byZip[zip]; if (!r) return;
  const color = COLORS[r.color] || COLORS.GREY;
  const pipelineStage = edits[zip]?.pipeline_stage;
  const stageCfg = pipelineStage ? PIPELINE_STAGES.find(s => s.key === pipelineStage) : null;
  const incidents = edits[zip]?.incidents || [];
  const sales = salesByZip[r.zip];

  const e = edits[zip] || {};
  const clean = v => (!v || /not researched|not located|not on record|verify/i.test(v)) ? '' : v;

  // Permit data
  let permitNeeded = e.permit_needed;
  if (permitNeeded === undefined) {
    if (r.color === 'GREEN') permitNeeded = false;
    else if (r.color === 'YELLOW' || r.color === 'RED') permitNeeded = true;
    else permitNeeded = null;
  }
  const permittedWho   = clean(e.permitted_who    || r.permitted_who    || e.permit_holder || '');
  const requirements   = clean(e.permit_required  || r.permit_required  || '');
  const permitSummary  = e.permit_summary || r.permit_summary || '';
  const fee            = clean(e.fee              || r.fee              || '');
  const costPerPerson  = clean(e.cost_per_person  || r.cost_per_person  || '');
  const processingTime = clean(e.processing_time  || r.processing_time  || '');
  const process        = clean(e.permit_process   || r.permit_process   || '');
  const authority      = clean(e.authority        || r.authority        || '');
  const hours          = clean(e.hours            || r.hours            || '');
  const days          = clean(e.days_restricted || r.days_restricted || '');
  const otherRestrict  = clean(e.other_restrictions || r.other_restrictions || '');
  const ordinanceRef   = e.ordinance_ref  || r.ordinance_ref  || '';
  const howToObtain    = process || authority || '';

  // Territory
  const density    = e.household_density || r.household_density || '';
  const DENSITIES    = ['Low', 'Medium', 'High'];
  // Scheduling / priority / difficulty
  const deliveryDay = e.delivery_day || '';
  const zipHub      = e.hub || '';
  const blockedBy   = e.blocked_by || '';
  const dayChange   = dayChangeFor(zip);
  const manualDiff  = +e.difficulty || 0;      // 0 = using auto
  const effDiff     = difficultyFor(zip);      // effective 1–5 (auto or override)

  // Pipeline options
  const pipelineOptions = [
    `<option value="">— Not in pipeline —</option>`,
    ...PIPELINE_STAGES.map(s =>
      `<option value="${s.key}" ${e.pipeline_stage===s.key?'selected':''}>${s.label}</option>`)
  ].join('');

  // Notes
  const internalNotes = clean(e.internal_notes || r.internal_notes || '');
  const manualNotes   = r.manual_notes || '';
  const hasNotes = internalNotes || manualNotes || r.discrepancy;

  // Distance — measured from the ZIP's assigned office
  const zOffice = zipOffice(zip), zDist = officeDist(r, zOffice);
  const distMi    = zDist.dist != null ? (+zDist.dist).toFixed(1) : null;
  const driveMins  = zDist.drive || null;
  const transitMins = zDist.transit || null;
  const officeLabel = `from ${esc(OFFICES[zOffice] || '')}`;

  // Household density stat
  const hhCount = byZip[zip]?.households || edits[zip]?.households || null;
  const areaSqMi = polygonAreaSqMi(zip);
  const densityPerSqMi = (hhCount && areaSqMi > 0) ? Math.round(hhCount / areaSqMi) : null;

  // Last strong week
  const lastStrong = strongWeekByZip[zip] || null;

  const typeOptions = INCIDENT_TYPES.map(t => `<option value="${t.key}">${t.label}</option>`).join('');
  const canEdit = !VIEW_MODE && !isSectorLeader();  // data edits (permit/territory)

  // Collapsible section wrapper — open state persists per section for the session
  const secOpen = (id, def) => drawerSecOpen[id] === undefined ? def : drawerSecOpen[id];
  const sec = (id, title, body, { open = true, head = '', help = '' } = {}) => `
    <div class="dr-section dr-collapsible${secOpen(id, open) ? '' : ' dr-collapsed'}" data-sec="${id}">
      <div class="dr-section-head dr-sec-toggle" data-sec-toggle="${id}">
        <span class="dr-section-title">${title}</span>
        ${help ? helpBtn('drawer', help) : ''}
        <span class="dr-sec-spacer"></span>
        ${head}
        <span class="dr-sec-caret">▸</span>
      </div>
      <div class="dr-sec-body">${body}</div>
    </div>`;

  // ── Section bodies ──
  const permitChip = permitNeeded === true
    ? `<span class="dr-mini-chip" style="--mc:#E8B339">YES${costPerPerson ? ` · ${esc(costPerPerson)}` : ''}</span>`
    : permitNeeded === false
      ? `<span class="dr-mini-chip" style="--mc:#3FAE6A">NO</span>`
      : `<span class="dr-mini-chip" style="--mc:#5B6472">?</span>`;

  const permitBody = `
      ${canEdit ? `
      <div class="dr-permit-ctl-row">
        <button class="ai-research-btn" id="aiResearchBtn">🤖 Research with AI</button>
        <div class="fc2-yn" data-field="permit_needed">
          <button class="fc2-yn-btn${permitNeeded===true?' fc2-yn-yes':''}" data-val="true">YES</button>
          <button class="fc2-yn-btn${permitNeeded===false?' fc2-yn-no':''}" data-val="false">NO</button>
        </div>
      </div>` : ''}
      ${permitNeeded === false ? `
        <div class="fc2-permit-clear">✓ No permit needed</div>
      ` : permitNeeded === true ? `
        <div class="fc2-fields">
          ${permitSummary ? `<div class="fc2-field fc2-field-summary"><div class="fc2-field-val">${esc(permitSummary)}</div></div>` : ''}
          ${(costPerPerson || fee) ? `
          <div class="fc2-cost-row">
            ${costPerPerson ? `<div class="fc2-cost-chip"><div class="fc2-cost-lbl">Per person</div><div class="fc2-cost-val">${esc(costPerPerson)}</div></div>` : ''}
            ${fee && fee !== costPerPerson ? `<div class="fc2-cost-chip fc2-cost-full"><div class="fc2-cost-lbl">Full fee</div><div class="fc2-cost-val">${esc(fee)}</div></div>` : ''}
            ${processingTime ? `<div class="fc2-cost-chip fc2-cost-time"><div class="fc2-cost-lbl">Lead time</div><div class="fc2-cost-val">${esc(processingTime)}</div></div>` : ''}
          </div>` : processingTime ? `<div class="fc2-field"><div class="fc2-field-label">Lead Time</div><div class="fc2-field-val">${esc(processingTime)}</div></div>` : ''}
          ${process      ? `<div class="fc2-field"><div class="fc2-field-label">How to Get It</div><div class="fc2-field-val">${esc(process)}</div></div>` : ''}
          ${authority    ? `<div class="fc2-field"><div class="fc2-field-label">Contact</div><div class="fc2-field-val">${esc(authority)}</div></div>` : ''}
          ${hours        ? `<div class="fc2-field"><div class="fc2-field-label">Allowed Hours</div><div class="fc2-field-val">${esc(hours)}</div></div>` : ''}
          ${days         ? `<div class="fc2-field"><div class="fc2-field-label">Restricted Days</div><div class="fc2-field-val">${esc(days)}</div></div>` : ''}
          ${otherRestrict ? `<div class="fc2-field"><div class="fc2-field-label">Other Requirements</div><div class="fc2-field-val">${esc(otherRestrict)}</div></div>` : ''}
          ${ordinanceRef  ? `<div class="fc2-field"><div class="fc2-field-label">Ordinance</div><div class="fc2-field-val" style="font-family:var(--mono);font-size:11px;color:var(--accent)">${esc(ordinanceRef)}</div></div>` : ''}
          ${permittedWho  ? `<div class="fc2-field"><div class="fc2-field-label">Permit Held By</div><div class="fc2-field-val">${esc(permittedWho)}</div></div>` : ''}
          ${!permitSummary && !process && !fee ? `<div style="font-family:var(--mono);font-size:12px;color:var(--muted)">No details — 🤖 run research</div>` : ''}
        </div>
      ` : `
        <div class="fc2-permit-unknown">
          <span style="font-family:var(--mono);font-size:12px;color:var(--muted)">Not determined</span>
        </div>
      `}`;

  const territoryReadOnly = [
    density ? `Density: ${esc(density)}` : '',
    (!isSectorLeader() && effDiff) ? `Difficulty: ${effDiff}/5` : '',
    deliveryDay ? `Delivery: ${dayShort(deliveryDay)}` : '',
    zipHub ? `Hub: ${hubLabel(zipHub)}` : '',
    blockedBy ? `After: ${esc(blockedBy)}` : '',
    dayChange ? `⏸ On hold — moves to ${dayShort(dayChange.to)} on ${dayChange.on}` : '',
  ].filter(Boolean).map(t => `<div style="font-family:var(--mono);font-size:12px;color:var(--muted)">${t}</div>`).join('') ||
    `<div style="font-family:var(--mono);font-size:12px;color:var(--dim)">—</div>`;

  const territoryBody = canEdit ? `
      <div class="dr-chips-row">
        <span class="dr-chip-lbl">Density</span>
        <div class="fc2-chips" data-field="household_density">
          ${DENSITIES.map(d => `<button class="fc2-chip${density.toLowerCase()===d.toLowerCase()?' fc2-active':''}" data-val="${d}">${d}</button>`).join('')}
        </div>
      </div>
      <div class="dr-chips-row">
        <span class="dr-chip-lbl">Difficulty<br><span class="dr-chip-hint">1 easy · 5 hard</span></span>
        <div class="fc2-chips" data-field="difficulty">
          ${[1,2,3,4,5].map(d => `<button class="fc2-chip fc2-chip-diff${manualDiff===d?' fc2-active':''}" data-val="${d}" style="--dc:${DIFFICULTY_COLORS[d]}">${d}</button>`).join('')}
          ${effDiff ? `<span class="dr-diff-auto">${manualDiff ? 'manual' : `auto: ${effDiff}`}</span>` : ''}
        </div>
      </div>
      <div class="dr-chips-row">
        <span class="dr-chip-lbl">Delivery day</span>
        <select id="drDeliverySel" class="dr-inline-sel">
          <option value="">— none —</option>
          ${DELIVERY_DAYS.map(d => `<option value="${d.key}" ${deliveryDay===d.key?'selected':''}>${d.label}</option>`).join('')}
        </select>
      </div>
      <div class="dr-chips-row">
        <span class="dr-chip-lbl" title="Client re-routes this ZIP on a date — it's on hold until then">Scheduled move</span>
        <div class="dr-blockedby-wrap">
          <select id="drMoveDay" class="dr-inline-sel">
            <option value="">— day —</option>
            ${DELIVERY_DAYS.map(d => `<option value="${d.key}" ${dayChange?.to===d.key?'selected':''}>${d.short}</option>`).join('')}
          </select>
          <input id="drMoveOn" class="dr-inline-input" type="date" value="${esc(dayChange?.on || '')}">
          <button id="drMoveSave" class="dr-inline-save">${dayChange ? 'Update' : 'Save'}</button>
          ${dayChange ? `<button id="drMoveClear" class="dr-inline-save">Clear</button>` : ''}
        </div>
      </div>
      <div class="dr-chips-row">
        <span class="dr-chip-lbl">Hub</span>
        <select id="drHubSel" class="dr-inline-sel">
          <option value="">— none —</option>
          ${HUBS.map(h => `<option value="${h.key}" ${zipHub===h.key?'selected':''}>${h.label}</option>`).join('')}
        </select>
      </div>
      <div class="dr-chips-row">
        <span class="dr-chip-lbl" title="ZIP to finish before this one">Complete first</span>
        <div class="dr-blockedby-wrap">
          <input id="drBlockedBy" class="dr-inline-input" type="text" inputmode="numeric" maxlength="5"
            placeholder="e.g. 02101" value="${esc(blockedBy)}">
          <button id="drBlockedBySave" class="dr-inline-save">Save</button>
        </div>
      </div>` : territoryReadOnly;

  const coverageHead = VIEW_MODE ? '' :
    `<button id="coverageDrawFromDrawerBtn" class="coverage-markoff-btn">✏ Mark Off</button>`;

  const incidentsBody = `
        <div class="incidents-list">
          ${incidents.length === 0
            ? '<div class="no-incidents">None</div>'
            : [...incidents].reverse().map((inc, i) => `
              <div class="incident-item ${INCIDENT_TYPES.some(t=>t.key===inc.type) ? inc.type : 'other'}">
                <div class="incident-header">
                  <span class="incident-type">${esc(INCIDENT_TYPES.find(t=>t.key===inc.type)?.label||inc.type)}</span>
                  <span class="incident-date">${esc(inc.date)}</span>
                  ${VIEW_MODE || (currentUser?.role === 'sector_leader' && inc.by !== currentUser?.id) ? '' : `<button class="incident-delete" data-incident-idx="${incidents.length-1-i}" aria-label="Delete">×</button>`}
                </div>
                ${inc.address ? `<div class="incident-address${inc.lat!=null?' incident-address-pin':''}"${inc.lat!=null?` data-incident-fly="${esc(inc.lat)},${esc(inc.lng)}" title="Show on map"`:''}>📍 ${esc(inc.address)}</div>` : ''}
                ${inc.notes ? `<div class="incident-notes">${esc(inc.notes)}</div>` : ''}
              </div>`).join('')}
        </div>
        ${VIEW_MODE ? '' : `
        <div class="incident-add-form">
          <span class="incident-add-label">Log new incident</span>
          <select id="incidentType" class="ef-input">${typeOptions}</select>
          <input id="incidentAddress" class="ef-input" type="text" autocomplete="off"
            placeholder="Address → ✕ pin (optional)">
          <textarea id="incidentNotes" class="ef-input ef-textarea" placeholder="Describe what happened…" style="min-height:60px;"></textarea>
          <button class="dr-save-btn" id="incidentSaveBtn" style="margin-top:0">Log Incident</button>
        </div>`}`;

  const notesBody = `
      ${internalNotes ? `<div class="dr-notes-text">${esc(internalNotes)}</div>` : ''}
      ${manualNotes   ? `<div class="dr-notes-text" style="margin-top:6px">${esc(manualNotes)}</div>` : ''}
      ${r.discrepancy ? `<div class="dr-flag-box" style="margin-top:8px">⚠ ${esc(r.discrepancy)}</div>` : ''}`;

  document.getElementById('drawerContent').innerHTML = `
    <!-- HEADER -->
    <div class="dr-header">
      <div class="dr-badges">
        <span class="badge" style="background:${color}20;color:${color};border:1px solid ${color}60">${STATUS_LABELS[r.color]||r.color||'?'}</span>
        ${stageCfg && stageCfg.label !== (STATUS_LABELS[r.color]||r.color||'?') ? `<span class="pipeline-badge" style="background:${stageCfg.color}18;color:${stageCfg.color};border:1px solid ${stageCfg.color}50">${stageCfg.label}</span>` : ''}
      </div>
      <div class="dr-title">${esc(r.zip)} — ${esc(r.municipality||r.primary_city||'')}</div>
      <div class="dr-meta">${[r.county?esc(String(r.county).replace(/\s*county$/i,''))+' County':null, r.state?esc(r.state):null, Number(r.households)?'~'+Number(r.households).toLocaleString()+' hh':null].filter(Boolean).join(' · ')}</div>
    </div>

    <!-- STATS STRIP -->
    <div class="dr-stats-strip">
      ${distMi ? `<div class="dr-stat"><div class="dr-stat-val">${distMi} mi</div><div class="dr-stat-lbl">${officeLabel}</div></div>` : ''}
      ${driveMins ? `<div class="dr-stat"><div class="dr-stat-val">${driveMins}m</div><div class="dr-stat-lbl">by car</div></div>` : ''}
      ${transitMins ? `<div class="dr-stat"><div class="dr-stat-val">${transitMins}m</div><div class="dr-stat-lbl">transit</div></div>` : ''}
      ${sales != null ? `<div class="dr-stat dr-stat-sales"><div class="dr-stat-val">${sales}</div><div class="dr-stat-lbl">${esc(CLIENT_SALES_LABEL)} <a href="#" id="salesRefreshBtn" title="Refresh" style="color:var(--green);text-decoration:none;margin-left:4px;">↻</a></div></div>` : `<div class="dr-stat"><div class="dr-stat-val" style="color:var(--dim)">—</div><div class="dr-stat-lbl">no ${esc(CLIENT_SALES_LABEL.toLowerCase())} <a href="#" id="salesRefreshBtn" style="color:var(--dim);text-decoration:none;margin-left:2px;">↻</a></div></div>`}
      ${hhCount ? `<div class="dr-stat"><div class="dr-stat-val">${Number(hhCount).toLocaleString()}</div><div class="dr-stat-lbl">households</div></div>` : ''}
      ${densityPerSqMi ? `<div class="dr-stat"><div class="dr-stat-val">${densityPerSqMi.toLocaleString()}/sq mi</div><div class="dr-stat-lbl">density</div></div>` : ''}
      ${lastStrong ? `<div class="dr-stat"><div class="dr-stat-val" style="font-size:12px">${lastStrong}</div><div class="dr-stat-lbl">last worked wk</div></div>` : `<div class="dr-stat"><div class="dr-stat-val" style="color:var(--dim);font-size:12px">—</div><div class="dr-stat-lbl">last worked wk</div></div>`}
    </div>
    ${canEdit && (r.color === 'TEAL' || e.pipeline_stage === 'permit_secured' || permittedWho) ? `
    <div class="dr-permit-holder-row">
      <span class="dr-permit-holder-lbl">🪪 Permit held by</span>
      <input id="permittedWhoInput" class="dr-permit-holder-input" type="text"
        placeholder="Name or company…"
        value="${esc(permittedWho)}">
      <button id="permittedWhoSave" class="dr-permit-holder-save">Save</button>
    </div>` : !canEdit && permittedWho ? `
    <div class="dr-permit-holder-row">
      <span class="dr-permit-holder-lbl">🪪 Permit held by</span>
      <span class="dr-permit-holder-val">${esc(permittedWho)}</span>
    </div>` : ''}

    ${sec('coverage', 'Coverage', renderCoverageSection(zip), { open: true, head: coverageHead, help: 'coverage' })}

    ${sec('routes', 'Routes', renderRoutesSection(zip), { open: (routePlansByZip[zip] || []).length > 0, head: routesSectionHead(zip), help: 'routes' })}

    ${sec('incidents', 'Incidents', incidentsBody, {
      open: incidents.length > 0, help: 'incidents',
      head: incidents.length ? `<span class="dr-incidents-badge">${incidents.length}</span>` : '',
    })}

    ${sec('permit', 'Permit', permitBody, { open: false, head: permitChip, help: 'permit' })}

    ${sec('territory', 'Territory', territoryBody, {
      open: false, help: 'territory',
      head: (deliveryDay ? `<span class="dr-mini-chip" style="--mc:#ff4da6">🚚 ${dayShort(deliveryDay)}</span>` : '')
          + (zipHub ? `<span class="dr-mini-chip" style="--mc:#a78bfa">🏭 ${hubShort(zipHub)}</span>` : ''),
    })}

    ${hasNotes ? sec('notes', 'Field Notes', notesBody, { open: true }) : ''}

    <!-- ACTIONS -->
    <div class="dr-actions">
      ${canEdit ? `<button class="dr-edit-btn" id="drawerEditBtn">✏ Edit Data</button>` : ''}
      <button class="dr-export-btn" id="drawerExportBtn" title="Export map for this ZIP">⤓ Export Map</button>
    </div>
    ${e.verification_status ? `<div class="dr-verified">✓ ${esc(e.verification_status)}</div>` : ''}
  `;

  // Collapsible section carets (header buttons act without toggling)
  document.querySelectorAll('[data-sec-toggle]').forEach(h => {
    h.addEventListener('click', ev => {
      if (ev.target.closest('button,select,input,a')) return;
      const el = h.closest('.dr-collapsible');
      drawerSecOpen[h.dataset.secToggle] = el.classList.toggle('dr-collapsed') === false;
    });
  });

  wireDrawerOverview(r);
  wireRoutesSection(zip);
  wireFieldCardTab(zip);
  wireIncidentsTab(zip);
}

function wireDrawerOverview(r){
  document.getElementById('drawerEditBtn')?.addEventListener('click', () => renderDrawerEdit(r));
  document.getElementById('drawerExportBtn')?.addEventListener('click', () => {
    window.open(`/export-map.html?zip=${encodeURIComponent(r.zip)}&autoprint=1`, 'mapprint', 'width=1000,height=750,menubar=no,toolbar=no,location=no');
  });
  document.getElementById('salesRefreshBtn')?.addEventListener('click', async e => {
    e.preventDefault();
    e.target.textContent = '…';
    try {
      const resp = await fetch('/api/sales-by-zip?refresh=1').then(r=>r.json());
      if (applySalesResponse(resp)) {
        renderTable(); renderDrawerWithTab(r.zip, drawerActiveTab);
      }
    } catch { e.target.textContent = '↻'; }
  });
  document.getElementById('pipelineStageSelect')?.addEventListener('change', e => {
    const val = e.target.value || null;
    let patch = { pipeline_stage: val };
    if (val && !edits[r.zip]?.office)
      patch.office = activeOffice !== 'all' ? activeOffice : zipOffice(r.zip);
    // Resting guard on pipeline ENTRY (stage moves of a card already on the
    // board don't re-prompt) — override enters it with 😴 Resting toggled.
    if (val && !edits[r.zip]?.pipeline_stage) {
      const rest = restCheck(r.zip, edits[r.zip]?.work_date || null);
      if (rest) {
        if (!confirmRestOverride(r.zip, rest, 'add it to the pipeline')) {
          renderDrawerWithTab(r.zip, drawerActiveTab);   // revert the select
          return;
        }
        patch = withResting(r.zip, patch);
      }
    }
    patchEdit(r.zip, patch);
    applyEdits(); updateStats();
    if (currentView === 'pipeline') renderPipeline();
    renderDrawerWithTab(r.zip, drawerActiveTab);
  });
  document.getElementById('aiResearchBtn')?.addEventListener('click', () => callAIResearch(r.zip));
  document.getElementById('aiResearchBtnFC')?.addEventListener('click', () => callAIResearch(r.zip));
  document.querySelectorAll('.coverage-date-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (confirm(`Delete coverage from ${btn.dataset.date}?`))
        await deleteKnocksByDate(btn.dataset.zip, btn.dataset.date);
    });
  });
  document.querySelectorAll('.coverage-date-del-mine').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (confirm(`Delete only your strokes from ${btn.dataset.date}?`))
        await deleteKnocksByDate(btn.dataset.zip, btn.dataset.date, true);
    });
  });
  document.getElementById('coverageDrawFromDrawerBtn')?.addEventListener('click', () => {
    if (!drawMode) enterDrawMode();
  });

  // Permit holder inline save
  document.getElementById('permittedWhoSave')?.addEventListener('click', () => {
    const val = document.getElementById('permittedWhoInput')?.value.trim() || null;
    patchEdit(r.zip, { permitted_who: val });
    applyEdits();
    const btn = document.getElementById('permittedWhoSave');
    if (btn) { btn.textContent = 'Saved ✓'; setTimeout(() => { if (btn) btn.textContent = 'Save'; }, 1500); }
  });
  document.getElementById('permittedWhoInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('permittedWhoSave')?.click();
  });
}

function wireFieldCardTab(zip){
  // Density / difficulty chips — save instantly on click (click active = clear)
  document.querySelectorAll('.fc2-chips').forEach(group => {
    const field = group.dataset.field;
    group.querySelectorAll('.fc2-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const val = btn.dataset.val;
        const current = edits[zip]?.[field];
        patchEdit(zip, { [field]: String(current) === val ? null : val });
        applyEdits(); updateStats(); refreshLayerStyle(zip);
        if (currentView === 'pipeline') renderPipeline();
        renderDrawerWithTab(zip, drawerActiveTab);
      });
    });
  });

  // Delivery day select
  document.getElementById('drDeliverySel')?.addEventListener('change', e => {
    patchEdit(zip, { delivery_day: e.target.value || null });
    applyEdits(); refreshAllStyles(); updateStats();
    if (currentView === 'pipeline') renderPipeline();
  });

  // Hub select
  document.getElementById('drHubSel')?.addEventListener('change', e => {
    patchEdit(zip, { hub: e.target.value || null });
    applyEdits(); refreshAllStyles(); updateStats();
    if (currentView === 'pipeline') renderPipeline();
  });

  // Scheduled delivery-day move — hold now, the server flips the day on the date
  const afterMoveChange = () => {
    applyEdits(); refreshAllStyles(); updateStats();
    if (currentView === 'pipeline') renderPipeline();
    if (currentView === 'balance') renderBalance();
    renderDrawerWithTab(zip, drawerActiveTab);
  };
  document.getElementById('drMoveSave')?.addEventListener('click', () => {
    const to = document.getElementById('drMoveDay').value;
    const on = document.getElementById('drMoveOn').value;
    if (!to || !on)                              { toast('Pick a day and a date', 'error'); return; }
    if (to === (edits[zip]?.delivery_day || '')) { toast(`${zip} is already on ${dayShort(to)}`, 'error'); return; }
    if (on <= etToday())                         { toast('Pick a future date — or just change the delivery day', 'error'); return; }
    patchEdit(zip, { day_change: { to, on } });
    toast(`${zip} on hold — moves to ${dayShort(to)} on ${on}`, 'ok');
    afterMoveChange();
  });
  document.getElementById('drMoveClear')?.addEventListener('click', () => {
    patchEdit(zip, { day_change: null });
    toast('Scheduled move cleared', 'ok');
    afterMoveChange();
  });

  // "Complete first" prerequisite ZIP — validate before saving
  document.getElementById('drBlockedBySave')?.addEventListener('click', () => {
    const typed = (document.getElementById('drBlockedBy').value || '').trim();
    const raw = normalizeAreaId(typed);
    if (!typed) { patchEdit(zip, { blocked_by: null }); toast('Prerequisite cleared', 'ok'); }
    else if (!raw)                  { toast(`Enter a valid ${AREA_LABEL}`, 'error'); return; }
    else if (raw === zip)           { toast("A ZIP can't block itself", 'error'); return; }
    else if (!byZip[raw])           { toast(`${raw} isn't a known ZIP`, 'error'); return; }
    else { patchEdit(zip, { blocked_by: raw }); toast(`Must finish ${raw} first`, 'ok'); }
    applyEdits();
    if (currentView === 'pipeline') renderPipeline();
    renderDrawerWithTab(zip, drawerActiveTab);
  });

  // YES / NO permit toggle
  const ynGroup = document.querySelector('.fc2-yn[data-field="permit_needed"]');
  if (ynGroup) {
    ynGroup.querySelectorAll('.fc2-yn-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const val = btn.dataset.val === 'true';
        const patch = { permit_needed: val };
        const cur = edits[zip]?.color || byZip[zip]?.color || 'GREY';
        if (val && (cur === 'GREEN' || cur === 'GREY')) patch.color = 'YELLOW';
        else if (!val) patch.color = 'GREEN';
        patchEdit(zip, patch);
        applyEdits(); refreshLayerStyle(zip); updateStats();
        if (currentView === 'pipeline') renderPipeline();
        renderDrawerWithTab(zip, drawerActiveTab);
      });
    });
  }
}

function wireIncidentsTab(zip){
  document.getElementById('incidentSaveBtn')?.addEventListener('click', async () => {
    const btn     = document.getElementById('incidentSaveBtn');
    const type    = document.getElementById('incidentType').value;
    const address = document.getElementById('incidentAddress')?.value.trim() || '';
    const notes   = document.getElementById('incidentNotes').value.trim();
    const date    = etToday();
    const incidentCfg = INCIDENT_TYPES.find(t => t.key === type);
    const existing = edits[zip]?.incidents || [];
    const isSectorLeader = currentUser?.role === 'sector_leader';
    const entry = { date, type, notes };
    if (address){
      entry.address = address;
      btn.disabled = true; btn.textContent = 'Locating address…';
      const r = byZip[zip];
      const geo = await geocodeAddress(
        `${address}, ${r?.municipality || r?.primary_city || ''} ${r?.state || ''} ${zip}`);
      btn.disabled = false; btn.textContent = 'Log Incident';
      if (geo){ entry.lat = geo.lat; entry.lng = geo.lng; }
      else toast('Address not found — incident logged without a map pin', 'error');
    }
    const patch = { incidents: [...existing, entry] };
    // Auto-set RED status and flag pipeline for critical / auto-red incidents.
    // Sector leaders may only write `incidents` — the server applies the same
    // escalation for them; here we mirror it locally so the UI updates now.
    const stage = edits[zip]?.pipeline_stage;
    if (incidentCfg?.autoRed) {
      if (!isSectorLeader) patch.color = 'RED';
      else edits[zip] = { ...(edits[zip]||{}), color: 'RED' };
      if (stage) {
        if (!isSectorLeader) patch.pipeline_stage = 'flagged';
        else edits[zip].pipeline_stage = 'flagged';
      }
    } else if (incidentCfg?.severity === 'high' && stage && stage !== 'flagged') {
      if (!isSectorLeader) patch.pipeline_stage = 'flagged';
      else edits[zip] = { ...(edits[zip]||{}), pipeline_stage: 'flagged' };
    }
    patchEdit(zip, patch);
    applyEdits(); refreshLayerStyle(zip); updateStats(); refreshIncidentPins();
    if (currentView === 'pipeline') renderPipeline();
    renderDrawerWithTab(zip, drawerActiveTab);
    toast(entry.lat != null ? 'Incident logged — ✕ pinned on map' : 'Incident logged', 'ok');
  });

  document.querySelectorAll('.incident-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.incidentIdx);
      const incidents = [...(edits[zip]?.incidents || [])];
      incidents.splice(idx, 1);
      patchEdit(zip, { incidents });
      applyEdits(); updateStats(); refreshIncidentPins();
      if (currentView === 'pipeline') renderPipeline();
      renderDrawerWithTab(zip, drawerActiveTab);
    });
  });

  // 📍 on an incident with coordinates — fly the map to its ✕ pin
  document.querySelectorAll('[data-incident-fly]').forEach(el => {
    el.addEventListener('click', () => {
      const [lat, lng] = el.dataset.incidentFly.split(',').map(Number);
      if (isNaN(lat) || isNaN(lng)) return;
      if (currentView !== 'map') switchView('map');
      map.flyTo([lat, lng], 17, { duration:.8 });
    });
  });
}

// ─── AI Research ─────────────────────────────────────────────────────────────
async function callAIResearch(zip){
  const r = byZip[zip]; if (!r) return;
  const btn = document.getElementById('aiResearchBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Researching…'; }

  try {
    const resp = await fetch('/api/analyze-permits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ zips: [{ zip, municipality: r.municipality||r.primary_city, state: r.state, county: r.county }] })
    });
    const data = await resp.json();
    if (data.error) throw new Error(data.error);

    const result = data.results?.[0];
    // Model output is steered by the pages it read: keep only plain text.
    const aiText = v => (typeof v === 'string' || typeof v === 'number') ? String(v).slice(0, 4000) : '';
    if (result) {
      const today = etToday();
      const permitNeededByStatus = result.status === 'GREEN' ? false : result.status === 'YELLOW' || result.status === 'RED' ? true : undefined;
      const patch = {
        color:               /^[A-Z]{1,16}$/.test(result.status || '') ? result.status : 'GREY',
        permit_needed:       permitNeededByStatus !== undefined ? permitNeededByStatus : edits[zip]?.permit_needed,
        permit_required:     result.status === 'GREEN' ? 'N' : 'Y',
        permit_summary:      aiText(result.summary)            || edits[zip]?.permit_summary      || '',
        fee:                 aiText(result.fee)                || edits[zip]?.fee                 || '',
        cost_per_person:     aiText(result.cost_per_person)    || edits[zip]?.cost_per_person     || '',
        processing_time:     aiText(result.processing_time)    || edits[zip]?.processing_time     || '',
        permit_process:      aiText(result.permit_process)     || edits[zip]?.permit_process      || '',
        authority:           aiText(result.authority)          || edits[zip]?.authority           || '',
        hours:               aiText(result.hours)              || edits[zip]?.hours               || '',
        days_restricted:     aiText(result.days_restricted)    || edits[zip]?.days_restricted     || '',
        other_restrictions:  aiText(result.other_restrictions) || edits[zip]?.other_restrictions  || '',
        verification_status: `AI-researched ${today} — verify before fielding`,
      };
      // Auto-advance from Incoming → Researching or Ready
      if (edits[zip]?.pipeline_stage === 'incoming') {
        patch.pipeline_stage = result.status === 'GREEN' ? 'ready' : 'research';
      }
      patchEdit(zip, patch);
      applyEdits(); refreshLayerStyle(zip); renderTable(); updateStats();
      if (currentView === 'pipeline') renderPipeline();
      renderDrawerWithTab(zip, drawerActiveTab);
    }
  } catch (err) {
    alert('AI research failed: ' + (err.message || 'Server error. Is ANTHROPIC_API_KEY set?'));
    if (btn) { btn.disabled = false; btn.textContent = '🤖 Research with AI'; }
  }
}

// ─── Drawer edit mode ────────────────────────────────────────────────────────
function renderDrawerEdit(r){
  const color = COLORS[r.color]||COLORS.GREY;
  const swatches = Object.entries(STATUS_LABELS).map(([key, label]) =>
    `<button class="dr-swatch${r.color===key?' active':''}" data-color="${key}" title="${label}" style="background:${COLORS[key]}"></button>`
  ).join('');
  document.getElementById('drawerContent').innerHTML = `
    <div class="drawer-header-row">
      <span class="badge" id="drBadge" style="background:${color}22;color:${color};border:1px solid ${color}">${STATUS_LABELS[r.color]||r.color||'UNKNOWN'}</span>
      <button class="dr-action-btn" id="drawerCancelBtn">Cancel</button>
    </div>
    <h3>${esc(r.zip)} — ${esc(r.municipality||r.primary_city||'')}</h3>
    <div class="sub">${esc(r.county||'')} · ${esc(r.state)}${Number(r.households)?' · ~'+Number(r.households).toLocaleString()+' households':''}</div>
    ${distHtml(r)}
    <div class="edit-form">
      <label class="ef-label">Status — click to change</label>
      <div class="dr-color-swatches">${swatches}</div>
      <div class="ef-group-label">Territory</div>
      ${ef('Household Density (Low / Medium / High)','household_density',edits[r.zip]?.household_density||r.household_density)}
      ${ef('Your internal flag','internal_flag',r.internal_flag)}
      ${ef('Internal comment','internal_comment',r.internal_comment)}
      <div class="ef-group-label">Permit</div>
      ${ef("Who's Permitted (e.g. individual badge / company umbrella)",'permitted_who',edits[r.zip]?.permitted_who||r.permitted_who)}
      ${ef('Permit requirements (summary)','permit_required',r.permit_required)}
      ${ef('Permit obtaining process (steps, cost, lead time)','permit_process',edits[r.zip]?.permit_process||r.permit_process,true)}
      ${ef('Issuing authority','authority',r.authority)}
      ${ef('Allowed hours','hours',r.hours)}
      ${ef('Days restricted','days_restricted',r.days_restricted)}
      ${ef('Other restrictions','other_restrictions',r.other_restrictions)}
      ${ef('Verification status','verification_status',r.verification_status)}
      <div class="ef-group-label">Notes</div>
      ${ef('Internal field notes','internal_notes',r.internal_notes,true)}
      ${ef('Manual notes','manual_notes',r.manual_notes,true)}
      <button class="dr-save-btn" id="drawerSaveBtn">Save changes</button>
    </div>
  `;
  document.getElementById('drawerCancelBtn').addEventListener('click', () => renderDrawerWithTab(r.zip, drawerActiveTab));
  document.getElementById('drawerSaveBtn').addEventListener('click', () => saveDrawerEdits(r.zip));

  document.querySelectorAll('.dr-swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.color;
      document.querySelectorAll('.dr-swatch').forEach(b => b.classList.toggle('active', b===btn));
      const c = COLORS[key]||COLORS.GREY;
      const badge = document.getElementById('drBadge');
      badge.style.background = c+'22'; badge.style.color = c; badge.style.borderColor = c;
      badge.textContent = STATUS_LABELS[key]||key;
      patchEdit(r.zip, { color: key });
      applyEdits(); refreshLayerStyle(r.zip); renderTable();
    });
  });
}

function ef(label, field, value, multiline=false){
  const notRes = value === 'Not researched';
  const val = (notRes||!value) ? '' : String(value);
  const ph  = notRes ? 'Not researched' : '';
  const attrs = `class="ef-input${multiline?' ef-textarea':''}" data-field="${field}" placeholder="${ph}"`;
  return `<label class="ef-label">${label}</label>${multiline
    ? `<textarea ${attrs}>${esc(val)}</textarea>`
    : `<input type="text" ${attrs} value="${esc(val)}">`}`;
}

function saveDrawerEdits(zip){
  const fields = {};
  document.querySelectorAll('#drawerContent [data-field]').forEach(el => {
    fields[el.dataset.field] = el.value.trim() || null;
  });
  if (!fields.color) fields.color = edits[zip]?.color || 'GREY';
  patchEdit(zip, fields);
  applyEdits(); refreshLayerStyle(zip); renderTable();
  renderDrawerWithTab(zip, drawerActiveTab);
  toast('Changes saved', 'ok');
}

// Mobile bottom-sheet drag: drag the header up to expand over the topbar, drag
// down to collapse to peek (or close from peek). The × button and overlay-tap
// remain as reliable exits regardless.
function wireDrawerDrag(){
  const drawer = document.getElementById('drawer');
  const head = drawer && drawer.querySelector('.drawer-head');
  if (!drawer || !head) return;
  let startY = 0, dragging = false, moved = false;
  const peekPx = () => window.innerHeight * 0.14;
  head.addEventListener('touchstart', e => {
    if (e.target.closest('#drawerClose, .help-i')) return;   // let the × and ⓘ handle their own taps
    startY = e.touches[0].clientY; dragging = true; moved = false;
    drawer.style.transition = 'none';
  }, { passive: true });
  head.addEventListener('touchmove', e => {
    if (!dragging) return;
    const dy = e.touches[0].clientY - startY;
    if (Math.abs(dy) > 4) moved = true;
    const base = drawer.classList.contains('expanded') ? 0 : peekPx();
    drawer.style.transform = `translateY(${Math.max(0, base + dy)}px)`;
  }, { passive: true });
  head.addEventListener('touchend', e => {
    if (!dragging) return; dragging = false;
    drawer.style.transition = ''; drawer.style.transform = '';   // hand back to the CSS snap
    if (!moved) return;
    const dy = e.changedTouches[0].clientY - startY;
    const expanded = drawer.classList.contains('expanded');
    if (dy < -50) drawer.classList.add('expanded');
    else if (dy > 80) { if (expanded) drawer.classList.remove('expanded'); else closeDrawer(); }
  }, { passive: true });
}

function closeDrawer(){
  drawerZip = null;
  document.getElementById('parkPicker')?.remove();
  const dr = document.getElementById('drawer');
  dr.classList.remove('open'); dr.classList.remove('expanded'); dr.style.transform = '';
  document.getElementById('drawerOverlay').classList.remove('open');
  document.getElementById('drawer').setAttribute('aria-hidden','true');
  renderKnocks(null);  // hide all coverage strokes when drawer closes
  refreshIncidentPins();  // clear ✕ pins too (unless the map-wide overlay is on)
}

// ─── Color editor ────────────────────────────────────────────────────────────
function buildColorEditor(){
  const btn=document.getElementById('colorEditorBtn'), panel=document.getElementById('colorEditorPanel');
  panel.innerHTML = Object.entries(STATUS_LABELS).map(([key,label]) => `
    <div class="ce-row">
      <span class="ce-label">${label}</span>
      <input type="color" class="ce-swatch" data-key="${key}" value="${COLORS[key]}">
      <input type="text"  class="ce-hex"    data-key="${key}" value="${COLORS[key]}" maxlength="7">
    </div>`).join('') + `<div class="ce-footer"><button id="ceReset">Reset defaults</button></div>`;
  panel.querySelectorAll('.ce-swatch').forEach(inp => inp.addEventListener('input', e => {
    const k=e.target.dataset.key; COLORS[k]=e.target.value;
    panel.querySelector(`.ce-hex[data-key="${k}"]`).value=e.target.value; onColorsChanged();
  }));
  panel.querySelectorAll('.ce-hex').forEach(inp => inp.addEventListener('change', e => {
    const k=e.target.dataset.key, v=e.target.value.trim();
    if(/^#[0-9a-fA-F]{6}$/.test(v)){ COLORS[k]=v; panel.querySelector(`.ce-swatch[data-key="${k}"]`).value=v; onColorsChanged(); }
  }));
  document.getElementById('ceReset').addEventListener('click', () => {
    COLORS={...COLOR_DEFAULTS}; saveColors();
    panel.querySelectorAll('.ce-swatch,.ce-hex').forEach(i=>i.value=COLORS[i.dataset.key]);
    onColorsChanged();
  });
  btn.addEventListener('click', e => { e.stopPropagation(); panel.classList.toggle('open'); });
  document.addEventListener('click', e => { if(!panel.contains(e.target)&&e.target!==btn) panel.classList.remove('open'); });
}

function onColorsChanged(){ saveColors(); refreshAllStyles(); renderTable(); updateLegend(); }
function updateLegend(){
  [['dot-green','GREEN'],['dot-yellow','YELLOW'],['dot-red','RED'],['dot-grey','GREY'],['dot-teal','TEAL']]
    .forEach(([cls,key]) => { const el=document.querySelector('.'+cls); if(el) el.style.background=COLORS[key]; });
}

// ─── Excel / CSV import ──────────────────────────────────────────────────────
let importRows = [], importHeaders = [];

const IMPORT_FIELDS = [
  { field:'color',               label:'Status / Color' },
  { field:'delivery_day',        label:'Delivery day' },
  { field:'hub',                 label:'Hub' },
  { field:'household_density',   label:'Household density' },
  { field:'permitted_who',       label:"Who's permitted" },
  { field:'permit_required',     label:'Permit requirements' },
  { field:'permit_process',      label:'How to obtain permit' },
  { field:'authority',           label:'Issuing authority' },
  { field:'hours',               label:'Permitted hours' },
  { field:'days_restricted',     label:'Days restricted' },
  { field:'other_restrictions',  label:'Other restrictions' },
  { field:'internal_flag',       label:'Your flag (Y/N)' },
  { field:'internal_notes',      label:'Your notes' },
  { field:'verification_status', label:'Verification status' },
];

function wireImport(){
  document.getElementById('importBtn').addEventListener('click', openImportModal);
  document.getElementById('importClose').addEventListener('click', closeImportModal);
  document.getElementById('importOverlay').addEventListener('click', e => {
    if (e.target===document.getElementById('importOverlay')) closeImportModal();
  });
  const dropZone = document.getElementById('importDrop');
  const fileInput = document.getElementById('importFile');
  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => { if(e.target.files[0]) handleImportFile(e.target.files[0]); });
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault(); dropZone.classList.remove('drag-over');
    if(e.dataTransfer.files[0]) handleImportFile(e.dataTransfer.files[0]);
  });
  document.getElementById('importApplyBtn').addEventListener('click', applyImport);
  document.getElementById('incidentImportSwitch')?.addEventListener('click', () => {
    closeImportModal();
    openIncidentImport();
  });
}

function openImportModal(){
  document.getElementById('importMapping').style.display = 'none';
  document.getElementById('importApplyBtn').style.display = 'none';
  document.getElementById('importResult').textContent = '';
  document.getElementById('importFile').value = '';
  document.getElementById('importDrop').classList.remove('drag-over');
  document.getElementById('importOverlay').classList.add('open');
}

function closeImportModal(){ document.getElementById('importOverlay').classList.remove('open'); }

function handleImportFile(file){
  if (!window.XLSX){ ensureXLSX().then(() => handleImportFile(file)).catch(() => alert('SheetJS not loaded — check your internet connection')); return; }
  const reader = new FileReader();
  reader.onload = e => {
    const wb = XLSX.read(e.target.result, { type:'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { defval:'' });
    if (!data.length){ alert('Sheet appears empty'); return; }
    importHeaders = Object.keys(data[0]);
    importRows    = data;
    renderImportMapping();
  };
  reader.readAsArrayBuffer(file);
}

function renderImportMapping(){
  const mapping = document.getElementById('importMapping');
  let zipGuess      = importHeaders.find(h => /zip|postal|postcode/i.test(h)) || '';
  const statusGuess = importHeaders.find(h => /^status$/i.test(h) || /^color$/i.test(h)) || '';
  const noteGuess   = importHeaders.find(h => /^note[s]?$/i.test(h) || /comment/i.test(h)) || '';
  const dayGuess    = importHeaders.find(h => /deliver/i.test(h) || /^day$/i.test(h)) || '';
  const hubGuess    = importHeaders.find(h => /^hub$/i.test(h) || /depot|hub/i.test(h)) || '';
  if (!zipGuess) {
    zipGuess = importHeaders.find(h => {
      const vals = importRows.slice(0, 15).map(r => String(r[h]||'').trim());
      return vals.filter(v => normalizeAreaId(v)).length >= 2;
    }) || '';
  }
  const previewCols = importHeaders.slice(0, 8);
  const rawPreview = `
    <div class="imp-raw-preview">
      <div class="imp-raw-title">Your file — ${importRows.length} rows · scroll right to see all columns</div>
      <div class="imp-raw-scroll">
        <table class="imp-table">
          <thead><tr>${previewCols.map(h=>`<th title="${esc(h)}">${esc(h.slice(0,14))}</th>`).join('')}${importHeaders.length>8?'<th>…</th>':''}</tr></thead>
          <tbody>${importRows.slice(0,3).map(row=>`<tr>${previewCols.map(h=>`<td>${esc(String(row[h]||'').slice(0,18))}</td>`).join('')}${importHeaders.length>8?'<td>…</td>':''}</tr>`).join('')}</tbody>
        </table>
      </div>
    </div>`;
  const autoMap = { color: statusGuess, internal_notes: noteGuess, delivery_day: dayGuess, hub: hubGuess };
  mapping.innerHTML = rawPreview + `
    <div class="imp-section" style="margin-top:16px;">
      <h4>Map your columns</h4>
      <div class="imp-row">
        <label class="imp-label">ZIP column <span class="req">*</span></label>
        <select id="impZipCol" class="imp-sel">
          <option value="">— select —</option>
          ${importHeaders.map(h=>`<option value="${esc(h)}" ${h===zipGuess?'selected':''}>${esc(h)}</option>`).join('')}
        </select>
      </div>
      ${IMPORT_FIELDS.map(f => {
        const guess = autoMap[f.field] || '';
        const opts = `<option value="">— skip —</option>` +
          importHeaders.map(h=>`<option value="${esc(h)}" ${h===guess?'selected':''}>${esc(h)}</option>`).join('');
        return `<div class="imp-row">
          <label class="imp-label">${f.label}</label>
          <select class="imp-sel imp-field-map" data-field="${f.field}">${opts}</select>
        </div>`;
      }).join('')}
    </div>
    <div class="imp-preview" id="importPreview"></div>
  `;
  mapping.querySelector('#impZipCol').addEventListener('change', updateImportPreview);
  mapping.querySelectorAll('.imp-field-map').forEach(s => s.addEventListener('change', updateImportPreview));
  mapping.style.display = 'block';
  document.getElementById('importApplyBtn').style.display = 'block';
  updateImportPreview();
}

function updateImportPreview(){
  const zipCol = document.getElementById('impZipCol').value;
  const preview = document.getElementById('importPreview');
  if (!zipCol){ preview.innerHTML = ''; return; }
  const sample = importRows.slice(0,4);
  const mappedFields = [];
  document.querySelectorAll('.imp-field-map').forEach(s => { if(s.value) mappedFields.push({ field:s.dataset.field, col:s.value }); });
  preview.innerHTML = `<table class="imp-table">
    <thead><tr><th>ZIP</th>${mappedFields.map(f=>`<th>${esc(f.field)}</th>`).join('')}</tr></thead>
    <tbody>${sample.map(row => {
      const zip = String(row[zipCol]||'').trim();
      return `<tr><td class="cell-zip">${esc(zip)}</td>${mappedFields.map(f=>`<td>${esc(String(row[f.col]||'').slice(0,30))}</td>`).join('')}</tr>`;
    }).join('')}</tbody>
  </table>`;
}

function parseStatus(val){
  if (!val) return null;
  const v = String(val).toLowerCase().trim();
  if (/green|clear|#3f/.test(v))      return 'GREEN';
  if (/yellow|friction|#e8b/.test(v)) return 'YELLOW';
  if (/red|block|#e5|#e54/.test(v))   return 'RED';
  if (/gr[ae]y|unknown|#5b/.test(v))  return 'GREY';
  return null;
}

function applyImport(){
  const zipCol = document.getElementById('impZipCol').value;
  if (!zipCol){ alert('Please select a ZIP column'); return; }
  const mappings = {};
  document.querySelectorAll('.imp-field-map').forEach(s => { if(s.value) mappings[s.dataset.field]=s.value; });
  let applied=0, skipped=0;
  const patches = {};
  importRows.forEach(row => {
    const zip = normalizeAreaId(row[zipCol]);
    if (!zip || !byZip[zip]){ skipped++; return; }
    const update = {};
    if (mappings.color){
      const s = parseStatus(row[mappings.color]);
      if (s) update.color = s;
    }
    IMPORT_FIELDS.filter(f=>f.field!=='color').forEach(f => {
      if (mappings[f.field]) {
        let v = String(row[mappings[f.field]]||'').trim();
        // Delivery day must land as a normalized key ('wed'), not free text
        if (f.field === 'delivery_day') v = normalizeDay(v);
        if (f.field === 'hub')          v = normalizeHub(v);
        if (v) update[f.field] = v;
      }
    });
    if (Object.keys(update).length){ patches[zip] = update; applied++; }
    else skipped++;
  });
  if (applied) patchEditsBulk(patches);
  applyEdits(); refreshAllStyles(); renderTable();
  document.getElementById('importResult').textContent = `✓ Applied ${applied} ZIPs  ·  ${skipped} skipped`;
  document.getElementById('importApplyBtn').textContent = 'Apply again';
}

// ─── Incident list import (address-level complaints / DNKs) ──────────────────
// Upload a spreadsheet of complaint addresses; each row is geocoded and stored
// as an incident on its ZIP, so an ✕ pin appears at the exact house.
let incImportRows = [];

// Free-text incident type ("do not knock", "Complaint", …) → a type key
function normalizeIncidentType(v){
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return 'dnk_issue';
  const direct = INCIDENT_TYPES.find(t => t.key === s || t.label.toLowerCase() === s);
  if (direct) return direct.key;
  if (/knock|dnk|solicit/.test(s))   return 'dnk_issue';
  if (/weapon|gun|armed/.test(s))    return 'weapons';
  if (/violen|crime|scene/.test(s))  return 'violent_crime';
  if (/threat|intimidat/.test(s))    return 'safety_threat';
  if (/denied/.test(s))              return 'permit_denied';
  if (/moved|authority/.test(s))     return 'moved_on';
  if (/police|stop/.test(s))         return 'police_stop';
  if (/complain|resident/.test(s))   return 'complaint';
  if (/access|gate|locked/.test(s))  return 'access_issue';
  return 'other';
}

function mapIncidentRow(obj){
  const find = re => { const k = Object.keys(obj).find(h => re.test(h)); return k != null ? String(obj[k] ?? '').trim() : ''; };
  const zip = normalizeAreaId(find(/zip|postal|postcode/i));
  return {
    address: find(/addr|street|location|house/i),
    city:    find(/city|town|municip/i),
    state:   find(/^state$|^st$/i),
    zip,
    type:    normalizeIncidentType(find(/type|categor|incident|issue/i)),
    date:    normalizeDate(find(/date|when|logged/i)),
    notes:   [find(/note|comment|desc|detail/i), find(/scope/i)].filter(Boolean).join(' — '),
  };
}

function openIncidentImport(){
  let overlay = document.getElementById('incImportOverlay');
  if (!overlay){
    overlay = document.createElement('div');
    overlay.id = 'incImportOverlay';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-panel modal-panel-wide">
        <div class="modal-header">
          <h3>Import Incident / DNK List</h3>
          <button id="incImpClose" class="modal-close" aria-label="Close">&times;</button>
        </div>
        <p class="modal-desc"><strong>Address · City · State · ZIP · Type · Date · Notes</strong> — columns auto-map, each row becomes an ✕ pin.</p>
        <div class="terr-bulk-bar">
          <button id="incImpUploadBtn" class="terr-bulk-btn" type="button">📂 Upload CSV / Excel</button>
          <button id="incImpDnkBtn" class="terr-bulk-btn" type="button" title="Load the saved Do-Not-Knock list">🚫 Saved DNK list</button>
          <input type="file" id="incImpFile" accept=".xlsx,.xls,.csv" style="display:none">
          <span id="incImpMsg" class="terr-bulk-msg"></span>
        </div>
        <div class="inc-imp-preview" id="incImpPreview"></div>
        <div class="modal-footer">
          <span id="incImpResult" class="modal-result"></span>
          <button id="incImpApply" class="modal-apply-btn" disabled>Geocode &amp; Import</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    document.getElementById('incImpClose').addEventListener('click', () => overlay.classList.remove('open'));
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('open'); });

    const fileInput = document.getElementById('incImpFile');
    document.getElementById('incImpUploadBtn').addEventListener('click', () => { fileInput.value = ''; fileInput.click(); });
    fileInput.addEventListener('change', e => { if (e.target.files[0]) incImpHandleFile(e.target.files[0]); });

    document.getElementById('incImpDnkBtn').addEventListener('click', async () => {
      try {
        const list = await fetch('/data/dnk.json').then(r => r.json());
        incImportRows = (list || []).map(d => ({
          address: d.address || '', city: d.city || '', state: d.state || '', zip: d.zip || '',
          type: 'dnk_issue', date: '',
          notes: [d.scope, d.notes].filter(Boolean).join(' — '),
        })).filter(r => r.address);
        incImpRenderPreview(`Loaded ${incImportRows.length} saved DNK address(es)`);
      } catch { toast('Could not load /data/dnk.json', 'error'); }
    });

    document.getElementById('incImpApply').addEventListener('click', applyIncidentImport);
  }
  incImportRows = [];
  document.getElementById('incImpPreview').innerHTML = '';
  document.getElementById('incImpMsg').textContent = '';
  document.getElementById('incImpResult').textContent = '';
  const apply = document.getElementById('incImpApply');
  apply.disabled = true; apply.textContent = 'Geocode & Import';
  overlay.classList.add('open');
}

function incImpHandleFile(file){
  if (!window.XLSX){ ensureXLSX().then(() => incImpHandleFile(file)).catch(() => toast('Spreadsheet parser not loaded — check your connection', 'error')); return; }
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const wb = XLSX.read(ev.target.result, { type:'array' });
      const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval:'' });
      incImportRows = data.map(mapIncidentRow).filter(r => r.address || r.zip);
      if (!incImportRows.length){ toast('No address rows detected in that file', 'error'); return; }
      incImpRenderPreview(`Loaded ${incImportRows.length} row(s)`);
    } catch(e){ toast('Could not read file: ' + e.message, 'error'); }
  };
  reader.readAsArrayBuffer(file);
}

function incImpRenderPreview(msg){
  document.getElementById('incImpMsg').textContent = msg;
  const rows = incImportRows.slice(0, 8);
  document.getElementById('incImpPreview').innerHTML = `
    <table class="imp-table">
      <thead><tr><th>Address</th><th>City</th><th>ZIP</th><th>Type</th><th>Notes</th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td>${esc(r.address.slice(0,32))}</td><td>${esc(r.city.slice(0,18))}</td><td>${esc(r.zip)}</td>
        <td>${esc(INCIDENT_TYPES.find(t=>t.key===r.type)?.label || r.type)}</td>
        <td>${esc(r.notes.slice(0,32))}</td>
      </tr>`).join('')}</tbody>
    </table>
    ${incImportRows.length > 8 ? `<div class="inc-imp-more">…and ${incImportRows.length - 8} more</div>` : ''}`;
  document.getElementById('incImpApply').disabled = !incImportRows.length;
}

async function applyIncidentImport(){
  const btn = document.getElementById('incImpApply');
  const msg = document.getElementById('incImpMsg');
  btn.disabled = true;
  const today = etToday();
  const norm  = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g,'');
  let imported = 0, pinned = 0, dupes = 0, skipped = 0;
  const newByZip = {}; // zip -> new incident entries

  for (let i = 0; i < incImportRows.length; i++){
    msg.textContent = `Geocoding ${i + 1}/${incImportRows.length}…`;
    const row = incImportRows[i];
    let geo = null;
    if (row.address){
      const q = [row.address, row.city, row.state, row.zip].filter(Boolean).join(', ');
      geo = await geocodeAddress(q);
    }
    let zip = (row.zip && byZip[row.zip]) ? row.zip : '';
    if (!zip && geo) zip = detectZipForPoint(geo.lat, geo.lng, '');
    if (!zip || !byZip[zip]){ skipped++; continue; }
    // Skip rows whose address is already logged in this ZIP (safe re-imports)
    const existing = [...(edits[zip]?.incidents || []), ...(newByZip[zip] || [])];
    if (row.address && existing.some(inc => inc.address && norm(inc.address) === norm(row.address))){ dupes++; continue; }
    const entry = { date: row.date || today, type: row.type || 'dnk_issue', notes: row.notes || '' };
    if (row.address) entry.address = row.address;
    if (geo){ entry.lat = geo.lat; entry.lng = geo.lng; pinned++; }
    (newByZip[zip] = newByZip[zip] || []).push(entry);
    imported++;
  }

  const patches = {};
  for (const [zip, list] of Object.entries(newByZip))
    patches[zip] = { incidents: [...(edits[zip]?.incidents || []), ...list] };
  if (Object.keys(patches).length) patchEditsBulk(patches);
  applyEdits(); updateStats(); refreshIncidentPins();
  if (drawerZip) renderDrawerWithTab(drawerZip, drawerActiveTab);

  msg.textContent = '';
  const parts = [`✓ ${imported} imported (${pinned} pinned)`];
  if (imported - pinned > 0) parts.push(`${imported - pinned} without a pin (address not found)`);
  if (dupes)   parts.push(`${dupes} duplicate(s) skipped`);
  if (skipped) parts.push(`${skipped} skipped (no ZIP match)`);
  document.getElementById('incImpResult').textContent = parts.join(' · ');
  btn.disabled = false; btn.textContent = 'Import again';
}

// ─── Controls ────────────────────────────────────────────────────────────────
function wireControls(){
  // Logo click = back to the map view from anywhere
  const brand = document.querySelector('.brand');
  if (brand) {
    brand.style.cursor = 'pointer';
    brand.title = 'Back to map';
    brand.addEventListener('click', () => switchView('map'));
  }
  document.getElementById('searchInput').addEventListener('input', () => { searchFlyToResults(); });
  document.getElementById('selectModeBtn').addEventListener('click', toggleSelectMode);
  document.getElementById('paintModeBtn').addEventListener('click', togglePaintMode);
  // Drawer close — both click and touchend for instant iOS response
  const drawerCloseBtn = document.getElementById('drawerClose');
  drawerCloseBtn.addEventListener('click', closeDrawer);
  drawerCloseBtn.addEventListener('touchend', e => { e.preventDefault(); closeDrawer(); }, { passive: false });
  wireDrawerDrag();
  // Overlay click closes drawer (on mobile overlay has pointer-events:auto + dark bg)
  document.getElementById('drawerOverlay').addEventListener('click', closeDrawer);
  // Desktop: close on outside mousedown (overlay is pointer-events:none on desktop)
  document.addEventListener('mousedown', e => {
    const drawer = document.getElementById('drawer');
    if (drawer?.classList.contains('open') && !drawer.contains(e.target) && e.target !== document.getElementById('drawerOverlay') && !e.target.closest?.('#guideOverlay')) closeDrawer();
  });
  document.addEventListener('touchstart', e => {
    const drawer = document.getElementById('drawer');
    const overlay = document.getElementById('drawerOverlay');
    if (drawer?.classList.contains('open') && !drawer.contains(e.target) && e.target !== overlay && !e.target.closest?.('#guideOverlay')) closeDrawer();
  }, { passive: true });
  document.addEventListener('keydown', e => {
    if(e.key==='Escape'){ closeDrawer(); hidePaintPicker(); closeImportModal(); closeAddTerritoriesModal(); }
  });
}

// ─── Sales bubble layer ──────────────────────────────────────────────────────
function buildSalesLayer(){
  if (salesLayer) { map.removeLayer(salesLayer); salesLayer = null; }
  if (!Object.keys(salesByZip).length) return;

  const circles = [];
  Object.entries(salesByZip).forEach(([zip, count]) => {
    const l = layerByZip[zip];
    if (!l) return;
    try {
      const center = l.getBounds().getCenter();
      const r = Math.max(6, Math.sqrt(count) * 8);
      const circle = L.circleMarker(center, {
        radius: r,
        fillColor: '#3FAE6A',
        color: '#3D3428',
        weight: 1.5,
        fillOpacity: 0.82,
        interactive: false,
      });
      const label = L.divIcon({
        className: 'sales-label',
        html: `<span>${count}</span>`,
        iconSize: [28, 16],
        iconAnchor: [14, 8],
      });
      circles.push(circle);
      circles.push(L.marker(center, { icon: label, interactive: false }));
    } catch {}
  });

  salesLayer = L.layerGroup(circles);
  if (showSalesLayer) salesLayer.addTo(map);
  renderSalesToggle();
}

// A layers-panel button with its ⓘ beside it. The button's text is rewritten
// on every render, so the ⓘ can't live inside it; hide the row, not the button.
function lsHelpRow(panel, btn, sec){
  const row = document.createElement('div');
  row.className = 'ls-row-help';
  row.append(btn);
  row.insertAdjacentHTML('beforeend', helpBtn('layers', sec));
  panel.appendChild(row);
  return row;
}

function renderSalesToggle(){
  const hasData = Object.keys(salesByZip).length > 0;
  // Toggles live inside the layers panel so they collapse with it
  const panel = document.querySelector('#layerSwitcher .ls-panel');
  if (!panel) return;

  // Sales bubble toggle
  let btn = document.getElementById('salesToggleBtn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'salesToggleBtn';
    btn.className = 'layer-btn ls-sales-btn';
    lsHelpRow(panel, btn, 'sales');
    btn.addEventListener('click', toggleSalesLayer);
  }
  btn.textContent = showSalesLayer ? '📦 Bubbles ON' : '📦 Bubbles';
  btn.classList.toggle('active', showSalesLayer);
  btn.parentElement.style.display = hasData ? '' : 'none';

  // Sales-only filter toggle
  let btn2 = document.getElementById('salesOnlyBtn');
  if (!btn2) {
    btn2 = document.createElement('button');
    btn2.id = 'salesOnlyBtn';
    btn2.className = 'layer-btn ls-sales-btn';
    panel.appendChild(btn2);
    btn2.addEventListener('click', toggleSalesOnly);
  }
  btn2.textContent = showSalesOnly ? '⬡ Sales ZIPs ON' : '⬡ Sales ZIPs';
  btn2.classList.toggle('active', showSalesOnly);
  btn2.style.display = hasData ? '' : 'none';

  // Per-sale pin toggle — only once the sheet carries lat/lng
  let btn3 = document.getElementById('salesPinsBtn');
  if (!btn3) {
    btn3 = document.createElement('button');
    btn3.id = 'salesPinsBtn';
    btn3.className = 'layer-btn ls-sales-btn';
    btn3.title = 'Pin every sale at its address';
    panel.appendChild(btn3);
    btn3.addEventListener('click', toggleSalesPins);
  }
  if (salesPins.length) {
    // Coordinates present — normal enabled toggle.
    btn3.style.display = '';
    btn3.disabled = false;
    btn3.style.opacity = '';
    btn3.style.cursor = '';
    btn3.textContent = showSalesPins ? '📍 Sale pins ON' : '📍 Sale pins';
    btn3.classList.toggle('active', showSalesPins);
    btn3.title = 'Pin every sale at its address';
  } else if (hasData) {
    // Sales exist per-ZIP but the sales sheet has no Latitude/Longitude
    // columns yet — surface the feature as armed-but-waiting rather than hiding
    // it, so it's clear nothing is broken (just waiting on the sheet).
    btn3.style.display = '';
    btn3.disabled = true;
    btn3.style.opacity = '0.5';
    btn3.style.cursor = 'not-allowed';
    btn3.classList.remove('active');
    btn3.textContent = '📍 Sale pins · awaiting coordinates';
    btn3.title = 'Add Latitude & Longitude columns to the sales sheet to plot each sale on the map';
  } else {
    btn3.style.display = 'none';
  }
  renderSalesDateFilter();
}

// Date-range filter for the sales pins (shown under the toggle when pins are on).
function renderSalesDateFilter(){
  const panel = document.querySelector('#layerSwitcher .ls-panel');
  if (!panel) return;
  let box = document.getElementById('salesDateFilter');
  const show = salesPins.length && showSalesPins;
  if (!box){
    box = document.createElement('div');
    box.id = 'salesDateFilter';
    box.className = 'ls-salesdate';
    panel.appendChild(box);
    box.addEventListener('click', e => {
      const b = e.target.closest('[data-sdm]'); if (!b) return;
      salesPinDateMode = b.dataset.sdm;
      if (salesPinDateMode !== 'custom'){ salesPinFrom = salesPinTo = null; }
      buildSalesPinsLayer(); savePrefs();
    });
    box.addEventListener('change', e => {
      if (e.target.id === 'sdFrom') salesPinFrom = e.target.value || null;
      else if (e.target.id === 'sdTo') salesPinTo = e.target.value || null;
      else return;
      salesPinDateMode = (salesPinFrom || salesPinTo) ? 'custom' : 'all';
      buildSalesPinsLayer(); savePrefs();
    });
  }
  box.style.display = show ? '' : 'none';
  if (!show) return;
  const modes = [['all','All'],['yesterday','Yesterday'],['week','This week'],['month','This month'],['3m','3 mo'],['6m','6 mo']];
  box.innerHTML = `
    <div class="ls-salesdate-lbl">📅 Sales date · <b>${_visSales.length.toLocaleString()}</b> shown</div>
    <div class="ls-salesdate-btns">
      ${modes.map(([m,l]) => `<button type="button" class="ls-cov-btn${salesPinDateMode===m?' active':''}" data-sdm="${m}">${l}</button>`).join('')}
    </div>
    <div class="ls-salesdate-custom">
      <input type="date" id="sdFrom" class="ls-cov-date" value="${esc(salesPinFrom||'')}" aria-label="Sales from date">
      <span class="ls-salesdate-dash">–</span>
      <input type="date" id="sdTo" class="ls-cov-date" value="${esc(salesPinTo||'')}" aria-label="Sales to date">
    </div>`;
}

// ── Per-sale pins (lat/lng from the sales sheet) ─────────────────────────
// One shared canvas renderer — thousands of dots stay smooth (SVG would not)
let salesPinRenderer = null;
const SALES_PIN_METERS = 10;  // dot ≈ a house footprint, like the ✕ incident pins

function salesPinRadiusPx(){
  const mpp = 40075016.686 * Math.abs(Math.cos(map.getCenter().lat * Math.PI / 180))
            / (256 * Math.pow(2, map.getZoom()));
  return Math.max(2, Math.min(22, SALES_PIN_METERS / mpp));
}

// Keep dot size tied to real-world scale across zooms (mirrors incident pins)
function updateSalesPinRadius(){
  if (!salesPinsLayer || !showSalesPins) return;
  const r = salesPinRadiusPx();
  salesPinsLayer.eachLayer(l => l.setRadius(r));
}

// Little card shown at a sales pin (same box style as the incident-pin popup):
// date of sale · ZIP, D1–D4 delivery chips, cancellation date, and the signup
// badge/coupon code. Green ✓ when a delivery was made (sky-blue for the 4th),
// muted ○ when not yet.
// ── Sales-pin filters (bad-geocode cleanup + date range) ─────────────────────
// Bad geocodes: a sales sheet can hold sales whose lat/lng falls well
// outside the ZIP they belong to (a geocoder "not found" default dumps a cluster
// in Colorado, etc.). We hide any pin that lands outside its ZIP's bounding box
// by more than ~PAD degrees, but keep pins whose ZIP we have no polygon for.
let _zipBBox = null;
function buildZipBBox(){
  _zipBBox = {};
  const add = (fc) => {
    if (!fc || !fc.features) return;
    for (const f of fc.features){
      const pr = f.properties || {};
      const z = normalizeAreaId(pr.POSTCODE || pr.ZCTA5CE10 || '');
      if (!z || !f.geometry) continue;
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates]
                  : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [];
      let bb = _zipBBox[z];
      for (const poly of polys){
        for (const pt of poly[0]){
          const lng = pt[0], lat = pt[1];
          if (!bb) bb = { n:lat, s:lat, e:lng, w:lng };
          else { if(lat>bb.n)bb.n=lat; if(lat<bb.s)bb.s=lat; if(lng>bb.e)bb.e=lng; if(lng<bb.w)bb.w=lng; }
        }
      }
      if (bb) _zipBBox[z] = bb;
    }
  };
  STATES.forEach(k => add(GEO[k]));
}
function markSalesPinGeo(){
  if (!salesPins || !salesPins.length) return;
  if (!_zipBBox) buildZipBBox();
  const PAD = 0.07; // ~5-8km around the ZIP bbox — kills far outliers, keeps borders
  for (const p of salesPins){
    const bb = _zipBBox[normalizeAreaId(p.zip)];
    p._geoBad = !!(bb && (p.lat < bb.s-PAD || p.lat > bb.n+PAD || p.lng < bb.w-PAD || p.lng > bb.e+PAD));
  }
}

// Date range: pins carry a sale date (Paid Date). Calendar-based week/month.
let salesPinDateMode = 'all';   // all|yesterday|week|month|3m|6m|custom
let salesPinFrom = null, salesPinTo = null;  // 'YYYY-MM-DD' for custom
function salesDateRange(){
  // Inclusive {from,to} 'YYYY-MM-DD' bounds, anchored to the ET calendar.
  // Pure string-space: sale dates are bare calendar dates, so comparing date
  // strings sidesteps every midnight/UTC/DST trap the old epoch bounds had.
  const base = etToday();
  const dow = (new Date(base + 'T00:00:00Z').getUTCDay() + 6) % 7;   // days since Monday
  switch (salesPinDateMode){
    case 'yesterday': { const y = isoAddDays(base, -1); return { from: y, to: y }; }
    case 'week':  return { from: isoAddDays(base, -dow), to: base };
    case 'month': return { from: base.slice(0, 8) + '01', to: base };
    case '3m':    return { from: isoMonthsAgo(3), to: base };
    case '6m':    return { from: isoMonthsAgo(6), to: base };
    case 'custom': return { from: salesPinFrom || null, to: salesPinTo || null };
    default: return null; // all time
  }
}
function salesPinInDate(p){
  const range = salesDateRange();
  if (!range) return true;
  const iso = parseSaleDate(p.date);
  if (!iso) return false;
  return (!range.from || iso >= range.from) && (!range.to || iso <= range.to);
}
let _visSales = [];
function visibleSalesPins(){
  _visSales = salesPins.filter(p => !p._geoBad && salesPinInDate(p));
  return _visSales;
}

function salesPinPopupHtml(p){
  const dChip = (lbl, v, col, tint) => {
    const val = String(v || '').trim();
    const done = val && !/^(no|false|0|n\/a|-|—)$/i.test(val);
    const c  = done ? col : '#b0b0b0';
    const bg = done ? tint : 'rgba(0,0,0,0.05)';
    return `<span style="display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:999px;background:${bg};color:${c};font-size:10px;font-weight:800;letter-spacing:.3px">${done ? '✓' : '○'} ${lbl}</span>`;
  };
  const cancelled = String(p.cancelled || '').trim() && !/^(no|false|0)$/i.test(String(p.cancelled).trim());
  return `
    <div style="font-family:system-ui;font-size:12px;min-width:172px">
      <strong style="color:#333">📦 ${esc(p.date || 'Sale')}</strong>
      ${p.zip ? `<span style="font-size:10px;color:#888"> · ${esc(p.zip)}</span>` : ''}
      <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">
        ${dChip('D1', p.d1, '#10b981', 'rgba(16,185,129,0.14)')}
        ${dChip('D2', p.d2, '#10b981', 'rgba(16,185,129,0.14)')}
        ${dChip('D3', p.d3, '#10b981', 'rgba(16,185,129,0.14)')}
        ${dChip('D4', p.d4, '#0ea5e9', 'rgba(14,165,233,0.14)')}
      </div>
      ${cancelled ? `<div style="margin-top:6px;font-size:11px;color:#E5484D;font-weight:700">✕ Cancelled${/\d/.test(String(p.cancelled)) ? ' · ' + esc(p.cancelled) : ''}</div>` : ''}
      ${p.badge ? `<div style="margin-top:6px;font-size:11px;color:#555">Signed by <strong>${esc(p.badge)}</strong></div>` : ''}
    </div>`;
}

// The dots render on a non-interactive canvas so ZIP polygons keep their own
// clicks. Pin taps are matched here by proximity instead — this is what lets a
// 2px dot act "on top" of the polygon for tapping, without the canvas covering
// (and stealing clicks from) the whole map.
function salesPinAt(containerPoint){
  if (!showSalesPins || !_visSales.length || !map) return null;
  const TOL = 14;  // finger-friendly tap radius in px
  const b = map.getBounds();
  let best = null, bestD = TOL;
  for (const p of _visSales){
    if (p.lat < b.getSouth() || p.lat > b.getNorth() || p.lng < b.getWest() || p.lng > b.getEast()) continue;
    const cp = map.latLngToContainerPoint([p.lat, p.lng]);
    const d = Math.hypot(cp.x - containerPoint.x, cp.y - containerPoint.y);
    if (d <= bestD){ bestD = d; best = p; }
  }
  return best;
}

function openSalesPinPopup(p){
  L.popup({ closeButton:false, className:'sales-pin-popup' })
    .setLatLng([p.lat, p.lng])
    .setContent(salesPinPopupHtml(p))
    .openOn(map);
}

function buildSalesPinsLayer(){
  if (salesPinsLayer) { map.removeLayer(salesPinsLayer); salesPinsLayer = null; }
  if (!salesPins.length) { renderSalesToggle(); return; }
  if (!salesPinRenderer) salesPinRenderer = L.canvas({ padding: 0.3 });

  const pins = visibleSalesPins();   // apply bad-geocode + date-range filters
  const r = salesPinRadiusPx();
  const markers = pins.map(p => {
    const cancelled = String(p.cancelled || '').trim() && !/^(no|false|0)$/i.test(String(p.cancelled).trim());
    // interactive:false → the canvas never swallows a click, so ZIP polygons and
    // the base map keep working normally. Taps are matched by salesPinAt().
    return L.circleMarker([p.lat, p.lng], {
      renderer: salesPinRenderer, interactive: false,
      radius: r, fillColor: cancelled ? '#E5484D' : '#3FAE6A',
      color: '#10081a', weight: 1, fillOpacity: .9,
    });
  });

  salesPinsLayer = L.layerGroup(markers);
  if (showSalesPins) salesPinsLayer.addTo(map);
  renderSalesToggle();
}

function toggleSalesPins(){
  showSalesPins = !showSalesPins;
  if (salesPinsLayer) {
    if (showSalesPins) { salesPinsLayer.addTo(map); updateSalesPinRadius(); }
    else map.removeLayer(salesPinsLayer);
  }
  renderSalesToggle(); savePrefs();
}

function toggleSalesLayer(){
  showSalesLayer = !showSalesLayer;
  if (salesLayer) {
    if (showSalesLayer) salesLayer.addTo(map);
    else map.removeLayer(salesLayer);
  }
  renderSalesToggle(); savePrefs();
}

function toggleSalesOnly(){
  showSalesOnly = !showSalesOnly;
  refreshAllStyles();
  renderSalesToggle(); savePrefs();
}

// ── Worked doors (auto-synced from the field app) ────────────────────────────
// Every door the field app logged for the reps, pushed to
// /api/integrations/worked-doors and geocoded server-side. Rendered exactly like sales pins: non-interactive canvas dots + tap
// matching by proximity, so ZIP polygons keep their own clicks.
const DOOR_OUTCOMES = {
  won:            { label: 'Won',            color: '#3FAE6A' },
  partially_won:  { label: 'Partially won',  color: '#0ea5e9' },
  lost:           { label: 'Lost',           color: '#E5484D' },
  swing_by_later: { label: 'Swing by later', color: '#f59e0b' },
  not_knocked:    { label: 'Not knocked',    color: '#9ca3af' },
};
const doorOutcome = o => DOOR_OUTCOMES[o] || { label: o || 'Unknown', color: '#9ca3af' };

let workedDoorRenderer = null;
let _visDoors = [];

// The window the current mode asks the server for (Eastern field days)
function workedDoorRange(){
  const base = etToday();
  const iso = n => isoAddDays(base, -n);
  const dow = (new Date(base + 'T00:00:00Z').getUTCDay() + 6) % 7;   // days since Monday — field weeks run Mon–Sun
  switch (workedDoorMode) {
    case 'yesterday': return { from: iso(1),      to: iso(1) };
    case 'thisweek':  return { from: iso(dow),    to: iso(0) };      // Monday → today
    case 'lastweek':  return { from: iso(dow+7),  to: iso(dow+1) };  // previous Mon → Sun
    case 'last7':     return { from: iso(6),  to: iso(0) };          // legacy (old saved prefs)
    case 'last30':    return { from: iso(29), to: iso(0) };
    case 'last90':    return { from: iso(89), to: iso(0) };
    case 'last6mo':   return { from: isoMonthsAgo(6), to: iso(0) };
    case 'custom':    return { from: workedDoorFrom || iso(6), to: workedDoorTo || iso(0) };
    default:          return { from: iso(0),  to: iso(0) };  // today
  }
}

let _wdSeq = 0, _wdRetry = null;
async function loadWorkedDoors(){
  if (!currentUser) return;
  const seq = ++_wdSeq;   // a slow 90-day response must not land on top of a newer "today"
  clearTimeout(_wdRetry);
  try {
    const { from, to } = workedDoorRange();
    const r = await fetch(`/api/worked-doors?from=${from}&to=${to}`);
    if (!r.ok || seq !== _wdSeq) return;
    const d = await r.json();
    if (seq !== _wdSeq) return;
    workedDoors = Array.isArray(d.doors) ? d.doors : [];
    // Every pin is a real door at its exact spot. Big windows arrive slim
    // (position + outcome only) so the payload stays sane.
    workedDoorsSlim = !!d.slim;
    workedDoorsTotal = d.total ?? workedDoors.length;
    workedDoorsPending = d.pendingGeocode || 0;
    buildWorkedDoorsLayer();
    // Server RAM store still filling after a deploy — poll until it's real
    if (d.warming && showWorkedDoors) _wdRetry = setTimeout(loadWorkedDoors, 20000);
  } catch {}
}

function visibleWorkedDoors(){
  _visDoors = workedDoors.filter(p => p.lat != null);  // fetch already matches the window
  return _visDoors;
}

// One canvas, one draw. A 90-day window is 300k+ pins; as individual
// circle markers they froze the phone for five seconds every time the map
// moved. Here each pin is projected once (zoom-0 pixel space) and painted
// with fillRect/arc on a single canvas per move — tens of milliseconds.
const WorkedDoorsCanvas = L.Layer.extend({
  initialize(points) { this._pts = points; this._prepare(); },
  _prepare() {
    const n = this._pts.length;
    this._x = new Float32Array(n); this._y = new Float32Array(n); this._o = new Uint8Array(n);
    const keys = Object.keys(DOOR_OUTCOMES); this._colors = keys.map(k => DOOR_OUTCOMES[k].color).concat(['#9ca3af']);
    for (let i = 0; i < n; i++) {
      const p = this._pts[i];
      const pt = L.CRS.EPSG3857.latLngToPoint(L.latLng(p.lat, p.lng), 0);   // zoom-0 pixels
      this._x[i] = pt.x; this._y[i] = pt.y;
      const k = keys.indexOf(p.outcome); this._o[i] = k < 0 ? keys.length : k;
    }
  },
  onAdd(map) {
    this._map = map;
    this._canvas = L.DomUtil.create('canvas', 'leaflet-zoom-animated');
    this._canvas.style.pointerEvents = 'none';
    map.getPanes().overlayPane.appendChild(this._canvas);
    map.on('moveend zoomend viewreset resize', this._draw, this);
    // Pinch and animated zooms fire `zoom` continuously (and `zoomanim` once
    // per animated step); the canvas scales itself relative to the view it
    // was last painted at, exactly as Leaflet's own canvas renderer does,
    // and is repainted crisply at zoomend. Dragging needs nothing: the
    // canvas lives in the overlay pane and moves with it.
    map.on('zoom', this._onZoom, this);
    map.on('zoomanim', this._onZoomAnim, this);
    this._draw();
  },
  onRemove(map) {
    map.off('moveend zoomend viewreset resize', this._draw, this);
    map.off('zoom', this._onZoom, this);
    map.off('zoomanim', this._onZoomAnim, this);
    L.DomUtil.remove(this._canvas); this._canvas = null;
  },
  _onZoom() { this._updateTransform(this._map.getCenter(), this._map.getZoom()); },
  _onZoomAnim(e) { this._updateTransform(e.center, e.zoom); },
  _updateTransform(center, zoom) {
    const map = this._map; if (!this._canvas || this._center == null) return;
    const scale = map.getZoomScale(zoom, this._zoom),
          viewHalf = map.getSize().multiplyBy(0.5 + 0.3),   // half the view plus the 30% margin
          currentCenterPoint = map.project(this._center, zoom),
          topLeftOffset = viewHalf.multiplyBy(-scale).add(currentCenterPoint).subtract(map._getNewPixelOrigin(center, zoom));
    L.DomUtil.setTransform(this._canvas, topLeftOffset, scale);
  },
  _draw() {
    const map = this._map, canvas = this._canvas; if (!map || !canvas) return;
    // Painted with a 30% margin on every side, like Leaflet's renderer, so a
    // drag reveals pins instead of blank canvas until the next repaint.
    const size = map.getSize(), dpr = Math.min(2, window.devicePixelRatio || 1);
    const pw = Math.round(size.x * 0.3), ph = Math.round(size.y * 0.3), w = size.x + 2 * pw, h = size.y + 2 * ph;
    canvas.width = w * dpr; canvas.height = h * dpr;
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([-pw, -ph]));
    this._center = map.getCenter(); this._zoom = map.getZoom();   // the view this paint is for
    const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // Pixels here are container pixels (plus the margin): zoom-0 pixel ×
    // scale, minus the pixel origin (→ layer point), minus the layer point of
    // the container's top-left (→ container point). Forgetting the last term
    // draws every pin offset by however far the map was panned.
    const s = Math.pow(2, map.getZoom()), origin = map.getPixelOrigin(), tl = map.containerPointToLayerPoint([0, 0]);
    const ox = origin.x + tl.x - pw, oy = origin.y + tl.y - ph;
    const r = salesPinRadiusPx(), n = this._x.length;
    // paint by colour so the context changes five times, not 300k
    const buckets = this._colors.map(() => []);
    for (let i = 0; i < n; i++) {
      const x = this._x[i] * s - ox, y = this._y[i] * s - oy;
      if (x < -r || y < -r || x > w + r || y > h + r) continue;
      buckets[this._o[i]].push(x, y);
    }
    ctx.strokeStyle = '#10081a'; ctx.lineWidth = 1; ctx.globalAlpha = .9;
    buckets.forEach((b, ci) => {
      if (!b.length) return;
      ctx.fillStyle = this._colors[ci];
      if (r <= 2.5) { for (let i = 0; i < b.length; i += 2) ctx.fillRect(b[i] - r, b[i + 1] - r, 2 * r, 2 * r); return; }
      ctx.beginPath();
      for (let i = 0; i < b.length; i += 2) { ctx.moveTo(b[i] + r, b[i + 1]); ctx.arc(b[i], b[i + 1], r, 0, Math.PI * 2); }
      ctx.fill(); if (r >= 4) ctx.stroke();
    });
    this._visible = { s, ox: ox + pw, oy: oy + ph };   // container frame for tap lookups
  },
  // nearest pin to a container point, for the tap card
  nearest(cp, tol) {
    const v = this._visible; if (!v) return null;
    let best = -1, bd = tol;
    for (let i = 0; i < this._x.length; i++) {
      const dx = this._x[i] * v.s - v.ox - cp.x; if (dx > tol || dx < -tol) continue;
      const dy = this._y[i] * v.s - v.oy - cp.y; if (dy > tol || dy < -tol) continue;
      const d = Math.hypot(dx, dy); if (d <= bd) { bd = d; best = i; }
    }
    return best < 0 ? null : this._pts[best];
  },
});

function buildWorkedDoorsLayer(){
  if (workedDoorsLayer) { map.removeLayer(workedDoorsLayer); workedDoorsLayer = null; }
  if (!currentUser || !workedDoors.length) { renderWorkedDoorsToggle(); return; }
  workedDoorsLayer = new WorkedDoorsCanvas(visibleWorkedDoors());
  if (showWorkedDoors) workedDoorsLayer.addTo(map);
  renderWorkedDoorsToggle();
}

function updateWorkedDoorRadius(){
  if (workedDoorsLayer && showWorkedDoors && workedDoorsLayer._draw) workedDoorsLayer._draw();
}

function workedDoorAt(containerPoint){
  if (!showWorkedDoors || !_visDoors.length || !map || !workedDoorsLayer?.nearest) return null;
  return workedDoorsLayer.nearest(containerPoint, 14);
}

function workedDoorCardInner(p){
  const o = doorOutcome(p.outcome);
  const when = p.tsEpoch
    ? new Date(p.tsEpoch > 1e12 ? p.tsEpoch : p.tsEpoch * 1000)
        .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: BOARD_TZ })
    : '';
  const needsDetail = workedDoorsSlim && !p.baName && !p.tsEpoch && !p._noDetail;
  return `
      <strong style="color:#333">🚪 ${esc(p.address || 'Door')}</strong>
      ${p.zip ? `<span style="font-size:10px;color:#888"> · ${esc(p.zip)}</span>` : ''}
      <div style="margin-top:6px">
        <span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;background:${o.color}22;color:${o.color};font-size:10px;font-weight:800;letter-spacing:.3px">● ${esc(o.label)}</span>
        ${when ? `<span style="font-size:10px;color:#888;margin-left:6px">${esc(p.date || '')} · ${esc(when)}</span>` : ''}
      </div>
      ${p.baName ? `<div style="margin-top:6px;font-size:11px;color:#555">Knocked by <strong>${esc(p.baName)}</strong>${p.sectorName ? ` · ${esc(p.sectorName)}` : ''}</div>` : ''}
      ${needsDetail ? `<div style="margin-top:6px;font-size:11px;color:#999">Loading details…</div>` : ''}`;
}

const workedDoorDomId = p => `wd${Math.round(p.lat * 1e6)}_${Math.round(p.lng * 1e6)}`;

function workedDoorPopupHtml(p){
  hydrateWorkedDoor(p);
  return `
    <div id="${workedDoorDomId(p)}" style="font-family:system-ui;font-size:12px;min-width:172px">${workedDoorCardInner(p)}</div>`;
}

// Big windows ship slim pins (position + outcome only) so the payload stays
// sane — who/when arrives on tap, fetched per door and merged into the pin so
// a second tap is instant. The open popup's card is patched in place via its
// coordinate-derived DOM id, so this can't clobber a popup that has since
// moved on to another door or a ZIP summary.
async function hydrateWorkedDoor(p){
  if (!workedDoorsSlim || p.baName || p.tsEpoch || p._noDetail || p._hydrating) return;
  p._hydrating = true;
  try {
    const { from, to } = workedDoorRange();
    const r = await fetch(`/api/worked-doors/detail?lat=${p.lat}&lng=${p.lng}&from=${from}&to=${to}`);
    const door = r.ok ? (await r.json()).door : null;
    if (door) Object.assign(p, door); else p._noDetail = true;
  } catch { p._noDetail = true; }
  p._hydrating = false;
  const el = document.getElementById(workedDoorDomId(p));
  if (el) el.innerHTML = workedDoorCardInner(p);
}

function openWorkedDoorPopup(p){
  L.popup({ closeButton:false, className:'sales-pin-popup' })
    .setLatLng([p.lat, p.lng])
    .setContent(workedDoorPopupHtml(p))
    .openOn(map);
}

function renderWorkedDoorsToggle(){
  const panel = document.querySelector('#layerSwitcher .ls-panel');
  if (!panel || !currentUser) return;

  let btn = document.getElementById('workedDoorsBtn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'workedDoorsBtn';
    btn.className = 'layer-btn ls-sales-btn';
    btn.title = `Doors the reps worked, auto-synced from ${FIELD_APP_NAME}`;
    lsHelpRow(panel, btn, 'worked');
    btn.addEventListener('click', toggleWorkedDoors);
  }
  btn.textContent = showWorkedDoors ? '🚪 Worked doors ON' : '🚪 Worked doors';
  btn.classList.toggle('active', showWorkedDoors);

  let box = document.getElementById('workedDoorFilter');
  if (!box) {
    box = document.createElement('div');
    box.id = 'workedDoorFilter';
    box.className = 'ls-salesdate';
    panel.appendChild(box);
    box.addEventListener('click', e => {
      const b = e.target.closest('[data-wdm]'); if (!b) return;
      workedDoorMode = b.dataset.wdm;
      if (workedDoorMode !== 'custom') { workedDoorFrom = workedDoorTo = null; }
      loadWorkedDoors(); savePrefs();   // mode change = new window → refetch
    });
    box.addEventListener('change', e => {
      if (e.target.id === 'wdFrom') workedDoorFrom = e.target.value || null;
      else if (e.target.id === 'wdTo') workedDoorTo = e.target.value || null;
      else return;
      workedDoorMode = 'custom';
      loadWorkedDoors(); savePrefs();
    });
  }
  box.style.display = showWorkedDoors ? '' : 'none';
  if (!showWorkedDoors) return;
  const modes = [
    ['today','Today'],['yesterday','Yesterday'],['thisweek','This week'],['lastweek','Last week'],
    ['last30','30 days'],['last90','90 days'],['last6mo','6 months'],['custom','Custom'],
  ];
  const shown = workedDoorsTotal || visibleWorkedDoors().length;
  box.innerHTML = `
    <div class="ls-salesdate-lbl">🚪 Worked · <b>${shown.toLocaleString()}</b> door${shown===1?'':'s'}${workedDoorsSlim ? ' · light detail' : ''}${workedDoorsPending ? ` · ${workedDoorsPending.toLocaleString()} locating…` : ''}</div>
    <div class="ls-salesdate-btns">
      ${modes.map(([m,l]) => `<button type="button" class="ls-cov-btn${workedDoorMode===m?' active':''}" data-wdm="${m}">${l}</button>`).join('')}
    </div>
    <div class="ls-salesdate-custom">
      <input type="date" id="wdFrom" class="ls-cov-date" value="${esc(workedDoorFrom||'')}" aria-label="Worked doors from date">
      <span class="ls-salesdate-dash">–</span>
      <input type="date" id="wdTo" class="ls-cov-date" value="${esc(workedDoorTo||'')}" aria-label="Worked doors to date">
    </div>`;
}

function toggleWorkedDoors(){
  showWorkedDoors = !showWorkedDoors;
  if (showWorkedDoors) loadWorkedDoors();  // re-fetch on every open — the sync runs hourly
  else if (workedDoorsLayer) map.removeLayer(workedDoorsLayer);
  renderWorkedDoorsToggle(); savePrefs();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function distHtml(r){
  const officeKey = zipOffice(r.zip);
  const { dist, drive, transit } = officeDist(r, officeKey);
  if (dist == null) return '';
  const of = OFFICE_LIST.find(o => o.key === officeKey);
  const office = esc(of?.address || of?.label || '');
  return `<div class="dist-row">
    <span class="dist-num">${dist} mi</span>
    <span class="dist-sep">from ${office}</span>
    <span class="dist-chip">🚗 ~${fmtTime(drive)} by car</span>
    ${transit ? `<span class="dist-chip">🚌 ~${fmtTime(transit)} transit</span>` : ''}
  </div>`;
}
function fmtTime(m){ if(!m&&m!==0) return '—'; if(m<60) return `${m}m`; return `${Math.floor(m/60)}h ${m%60}m`; }
function fmt(v){ if(v==null||v===''||v==='Not researched') return '<span class="cell-muted">—</span>'; return esc(v); }

// ─── Mobile ──────────────────────────────────────────────────────────────────
function wireMobile(){
  const menuBtn = document.getElementById('mobileMenuBtn');
  const menu    = document.getElementById('mobileMenu');
  if (!menuBtn || !menu) return;

  function tapHandler(el, fn){
    let touchMoved = false;
    el.addEventListener('touchstart', () => { touchMoved = false; }, { passive:true });
    el.addEventListener('touchmove',  () => { touchMoved = true;  }, { passive:true });
    el.addEventListener('touchend', e => { if (!touchMoved){ e.preventDefault(); fn(e); } }, { passive:false });
    el.addEventListener('click', fn);
  }

  function closeMenu(){
    menu.classList.remove('open');
    menuBtn.classList.remove('active');
  }

  function toggleMenu(e){
    e.stopPropagation();
    const open = menu.classList.toggle('open');
    menuBtn.classList.toggle('active', open);
  }
  tapHandler(menuBtn, toggleMenu);

  document.addEventListener('touchstart', e => {
    if (!menu.classList.contains('open')) return;
    if (!menu.contains(e.target) && e.target !== menuBtn) closeMenu();
  }, { passive:true });
  document.addEventListener('click', e => {
    if (!menu.contains(e.target) && e.target !== menuBtn) closeMenu();
  });

  // ── Profile panel ────────────────────────────────────────────────────────
  function populateProfile(){
    if (!currentUser) return;
    const initials = currentUser.name.split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
    const el = document.getElementById('mobProfileAvatar');
    if (el) el.textContent = initials;
    const nameEl = document.getElementById('mobProfileName');
    if (nameEl) nameEl.textContent = currentUser.name;
    const emailEl = document.getElementById('mobProfileEmail');
    if (emailEl) emailEl.textContent = currentUser.email;
    const roleEl = document.getElementById('mobProfileRole');
    if (roleEl) roleEl.textContent = {sector_leader:'Sector Leader',client:'Client',admin:'Admin'}[currentUser.role] || currentUser.role;
  }
  populateProfile();

  const changePwBtn = document.getElementById('mobChangePwBtn');
  const pwMsg       = document.getElementById('mobPwMsg');
  if (changePwBtn) {
    tapHandler(changePwBtn, async () => {
      const cur = document.getElementById('mobCurrentPw')?.value.trim();
      const nw  = document.getElementById('mobNewPw')?.value.trim();
      if (!cur || !nw) { if(pwMsg){pwMsg.textContent='Fill both fields.';pwMsg.className='mob-pw-msg err';} return; }
      if (nw.length < 8) { if(pwMsg){pwMsg.textContent='New password must be at least 8 chars.';pwMsg.className='mob-pw-msg err';} return; }
      try {
        const res = await fetch('/api/auth/change-password', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ currentPassword:cur, newPassword:nw })
        });
        const data = await res.json();
        if (res.ok) {
          if(pwMsg){pwMsg.textContent='Password updated!';pwMsg.className='mob-pw-msg ok';}
          document.getElementById('mobCurrentPw').value='';
          document.getElementById('mobNewPw').value='';
        } else {
          if(pwMsg){pwMsg.textContent=data.error||'Failed.';pwMsg.className='mob-pw-msg err';}
        }
      } catch { if(pwMsg){pwMsg.textContent='Network error.';pwMsg.className='mob-pw-msg err';} }
    });
  }

  const signOutBtn = document.getElementById('mobSignOutBtn');
  if (signOutBtn) {
    tapHandler(signOutBtn, signOut);
  }

  // ── Bottom nav tabs ──────────────────────────────────────────────────────
  document.querySelectorAll('.mob-tab').forEach(btn => {
    tapHandler(btn, () => {
      const tab = btn.dataset.tab;
      if (tab === 'menu') { toggleMenu({ stopPropagation:()=>{} }); return; }
      document.querySelectorAll('.mob-tab').forEach(b => b.classList.toggle('active', b===btn));
      closeMenu();
      if (tab === 'map') {
        switchView('map');
        setTimeout(() => map.invalidateSize(), 50);
      } else if (tab === 'pipeline' || tab === 'calendar' || tab === 'balance') {
        switchView(tab);
      }
    });
  });

  // Add Territories floating button — pipeline view, admin/client only
  const fab = document.getElementById('mobAddFab');
  if (fab) fab.addEventListener('click', openAddTerritoriesModal);

  // Manage Users from the mobile account panel (admin only)
  const mobUsersBtn = document.getElementById('mobManageUsersBtn');
  if (mobUsersBtn && currentUser?.role === 'admin') {
    mobUsersBtn.style.display = 'block';
    tapHandler(mobUsersBtn, () => { closeMenu(); openUserMgmt(); });
  }

  window.addEventListener('resize', () => {
    if (isMob()) setTimeout(() => map.invalidateSize(), 100);
  });
}

// ─── Auth / Role UI ──────────────────────────────────────────────────────────
function applyAuth(){
  const role = currentUser?.role;

  // Inject user chip + logout into topbar
  const actions = document.querySelector('.topbar-actions');
  if (actions) {
    const chip = document.createElement('div');
    chip.className = 'user-chip';
    chip.innerHTML = `
      <span class="user-chip-name">${esc(currentUser.name)}</span>
      <span class="user-chip-role">${{sector_leader:'Sector Leader',client:'Client',admin:'Admin'}[role]||role}</span>
      <div class="user-chip-menu" id="userChipMenu">
        ${role === 'admin' ? '<button id="manageUsersBtn" class="ucm-item">Manage Users</button>' : ''}
        <button id="helpersToggleBtn" class="ucm-item ucm-helpers" title="Show the i buttons that explain each page">Page helpers <span class="ucm-state" id="helpersState"></span></button>
        <button id="logoutBtn" class="ucm-item ucm-logout">Sign out</button>
      </div>
    `;
    actions.appendChild(chip);
    chip.addEventListener('click', e => {
      e.stopPropagation();
      chip.classList.toggle('open');
    });
    document.addEventListener('click', () => chip.classList.remove('open'));

    document.getElementById('logoutBtn')?.addEventListener('click', signOut);

    document.getElementById('manageUsersBtn')?.addEventListener('click', () => {
      chip.classList.remove('open');
      openUserMgmt();
    });
  }

  // Demo/trial accounts: everything stays visible and clickable to read, but
  // the few controls that exist ONLY to write are taken away rather than left
  // to fail with a toast. Password change goes too — this login is shared, so
  // one person changing it would lock out everybody else.
  if (currentUser?.demo) {
    document.querySelector('.user-chip-role')?.insertAdjacentHTML('afterend',
      '<span class="user-chip-role user-chip-demo">View only</span>');
    ['syncDoorsBtn'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
    document.querySelector('.mob-pw-section')?.style.setProperty('display', 'none');
  }

  // Sector leader restrictions
  if (role === 'sector_leader') {
    const hideIds = ['paintModeBtn','selectModeBtn','importBtn','colorEditorBtn','addTerritoriesBtn',
                     'mobPaintBtn','mobSelectBtn','mobImportBtn','mobColorsBtn','mobAddBtn'];
    hideIds.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
    // Hide pipeline + calendar views — sector leaders only see the map + coverage
    document.querySelectorAll('.view-tab[data-view="pipeline"], .mob-tab[data-tab="pipeline"], .view-tab[data-view="calendar"], .mob-tab[data-tab="calendar"]').forEach(el => el.style.display = 'none');
  }
}

// ─── User Management Panel (Admin only) ──────────────────────────────────────
function openUserMgmt(){
  let overlay = document.getElementById('userMgmtOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'userMgmtOverlay';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-panel user-mgmt-panel">
        <div class="modal-header">
          <h3>Manage Users</h3>
          <button id="userMgmtClose" class="modal-close" aria-label="Close">&times;</button>
        </div>
        <div class="um-toolbar">
          <button id="addUserBtn" class="topbar-btn topbar-btn-accent">+ Add User</button>
        </div>
        <div id="userList" class="um-user-list"></div>
        <div id="userMgmtError" class="um-error"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    document.getElementById('userMgmtClose').addEventListener('click', () => overlay.classList.remove('open'));
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('open'); });
    // The list itself stays readable for a trial account; only the button that
    // creates a real user (and emails them an invite) goes away.
    if (currentUser?.demo) document.getElementById('addUserBtn').style.display = 'none';
    else document.getElementById('addUserBtn').addEventListener('click', openAddUserModal);
  }
  overlay.classList.add('open');
  loadUsers();
}

async function loadUsers(){
  const list = document.getElementById('userList');
  if (!list) return;
  list.innerHTML = '<div class="um-loading">Loading…</div>';
  try {
    const r = await fetch('/api/users');
    if (!r.ok) throw new Error((await r.json()).error);
    const { users } = await r.json();
    const roleLabels = { sector_leader:'Sector Leader', client:'Client', admin:'Admin' };
    const officeLabels = { ...OFFICES, both: ALL_OFFICES_LABEL };
    list.innerHTML = users.map(u => {
      const isPending = u.invitePending || !u.emailVerified;
      const statusLabel = !u.active ? 'Inactive' : isPending ? 'Invite pending' : 'Active';
      const statusCls   = !u.active ? 'um-inactive' : isPending ? 'um-pending' : 'um-active';
      const isSelf = u._id === currentUser?.id;
      return `
      <div class="um-user-row${u.active ? '' : ' um-row-inactive'}" data-id="${u._id}">
        <div class="um-user-info">
          <div class="um-name-role">
            <span class="um-user-name">${esc(u.name)}</span>
            ${isSelf ? `<span class="um-role-badge um-role-${u.role}">${roleLabels[u.role]||esc(u.role)} (you)</span>` : `
            <select class="um-role-select" data-action="role" data-id="${u._id}" title="Change role">
              ${Object.entries(roleLabels).map(([k,l]) => `<option value="${k}" ${u.role===k?'selected':''}>${l}</option>`).join('')}
            </select>`}
            <select class="um-role-select um-office-select" data-id="${u._id}" title="Which office's pipeline this account sees">
              ${Object.entries(officeLabels).map(([k,l]) => `<option value="${k}" ${(u.office||'both')===k?'selected':''}>${l}</option>`).join('')}
            </select>
          </div>
          <span class="um-user-email">${esc(u.email)}</span>
        </div>
        <div class="um-right">
          <span class="um-status ${statusCls}">${statusLabel}</span>
          <div class="um-actions">
            ${isPending ? `<button class="um-btn" data-action="resend" data-id="${u._id}">Resend</button>` : ''}
            ${!isSelf ? `<button class="um-btn" data-action="toggle-active" data-id="${u._id}" data-active="${u.active ? '1' : ''}">${u.active ? 'Deactivate' : 'Reactivate'}</button>` : ''}
            ${!isSelf ? `<button class="um-btn um-btn-danger" data-action="delete" data-id="${u._id}">Remove</button>` : ''}
          </div>
        </div>
      </div>`;
    }).join('') || '<div class="um-loading">No users found.</div>';

    list.querySelectorAll('.um-role-select:not(.um-office-select)').forEach(sel => {
      sel.addEventListener('change', async () => {
        const r = await fetch(`/api/users/${sel.dataset.id}`, {
          method:'PUT', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ role: sel.value })
        });
        if (r.ok) { toast('Role updated', 'ok'); loadUsers(); }
        else { toast((await r.json().catch(()=>({}))).error || 'Failed to update role', 'error'); loadUsers(); }
      });
    });

    list.querySelectorAll('.um-office-select').forEach(sel => {
      sel.addEventListener('change', async () => {
        const r = await fetch(`/api/users/${sel.dataset.id}`, {
          method:'PUT', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ office: sel.value })
        });
        if (r.ok) { toast('Office view updated — applies on their next page load', 'ok'); loadUsers(); }
        else { toast((await r.json().catch(()=>({}))).error || 'Failed to update office', 'error'); loadUsers(); }
      });
    });

    list.querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const { action, id } = btn.dataset;
        if (action === 'delete') {
          if (!confirm('Remove this user? They will lose access immediately.')) return;
          const r = await fetch(`/api/users/${id}`, { method:'DELETE' });
          if (r.ok) loadUsers(); else alert((await r.json()).error);
        } else if (action === 'resend') {
          btn.textContent = 'Sending…'; btn.disabled = true;
          const r = await fetch(`/api/users/${id}/resend-invite`, { method:'POST' });
          if (r.ok) { btn.textContent = 'Sent!'; } else { btn.textContent = 'Error'; btn.disabled = false; }
        } else if (action === 'toggle-active') {
          const makeActive = !btn.dataset.active;
          const r = await fetch(`/api/users/${id}`, {
            method:'PUT', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ active: makeActive })
          });
          if (r.ok) { toast(makeActive ? 'User reactivated' : 'User deactivated', 'ok'); loadUsers(); }
          else toast('Failed to update user', 'error');
        }
      });
    });
  } catch(e) {
    list.innerHTML = `<div class="um-loading" style="color:#EF4444">${e.message}</div>`;
  }
}

function openAddUserModal(){
  let m = document.getElementById('addUserModal');
  if (!m) {
    m = document.createElement('div');
    m.id = 'addUserModal';
    m.className = 'modal-overlay';
    m.innerHTML = `
      <div class="modal-panel" style="max-width:380px">
        <div class="modal-header">
          <h3>Add User</h3>
          <button id="addUserClose" class="modal-close">&times;</button>
        </div>
        <div style="padding:20px 24px">
          <div id="addUserErr" class="um-error" style="margin-bottom:14px"></div>
          <div class="form-field">
            <label class="ff-label">Full name</label>
            <input id="auName" class="ff-input" type="text" placeholder="Jane Smith">
          </div>
          <div class="form-field" style="margin-top:14px">
            <label class="ff-label">Email address</label>
            <input id="auEmail" class="ff-input" type="email" placeholder="jane@example.com">
          </div>
          <div class="form-field" style="margin-top:14px">
            <label class="ff-label">Role</label>
            <select id="auRole" class="ff-input">
              <option value="sector_leader">Sector Leader</option>
              <option value="client">Client</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div class="form-field" style="margin-top:14px">
            <label class="ff-label">Office view</label>
            <select id="auOffice" class="ff-input">
              <option value="both">${ALL_OFFICES_LABEL}</option>
              ${OFFICE_LIST.map(o => `<option value="${esc(o.key)}">${esc(o.label)} only</option>`).join('')}
            </select>
          </div>
          <button id="addUserSubmit" class="topbar-btn topbar-btn-accent" style="margin-top:20px;width:100%;padding:11px">Send Invite</button>
        </div>
      </div>
    `;
    document.body.appendChild(m);
    document.getElementById('addUserClose').addEventListener('click', () => m.classList.remove('open'));
    m.addEventListener('click', e => { if (e.target === m) m.classList.remove('open'); });
    document.getElementById('addUserSubmit').addEventListener('click', async () => {
      const btn = document.getElementById('addUserSubmit');
      const err = document.getElementById('addUserErr');
      const name  = document.getElementById('auName').value.trim();
      const email = document.getElementById('auEmail').value.trim();
      const role  = document.getElementById('auRole').value;
      const office = document.getElementById('auOffice').value;
      err.textContent = '';
      if (!name || !email) { err.textContent = 'Name and email are required'; return; }
      btn.disabled = true; btn.textContent = 'Sending…';
      try {
        const r = await fetch('/api/users', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ name, email, role, office }) });
        const d = await r.json();
        if (r.ok) {
          m.classList.remove('open');
          document.getElementById('auName').value = '';
          document.getElementById('auEmail').value = '';
          loadUsers();
        } else {
          err.textContent = d.error || 'Failed to add user';
        }
      } catch(e) { err.textContent = e.message; }
      btn.disabled = false; btn.textContent = 'Send Invite';
    });
  }
  m.classList.add('open');
}

// ═══════════════════════════════════════════════════════════════════════════
// WALKING ROUTES — "generate routes for 2 pairs + 1 solo in this ZIP"
// Server builds laps from OSM streets + houses minus what worked-door pins,
// coverage strokes and recent plans already cover (lib/routegen.js).
// ═══════════════════════════════════════════════════════════════════════════
const ROUTE_COLORS = ['#ffd400', '#ff3b7b', '#3b82f6', '#22d3ee', '#a855f7', '#fb923c', '#10b981', '#f43f5e', '#84cc16', '#e879f9'];
let routePlansByZip = {};      // zip → [plan]
let routeCoverageByZip = {};   // zip → coverage stats (or {mapped:false})
let routesLayer = null;
let routeSelPlan = null;       // plan id shown on the map
let routeSelIdx = null;        // highlighted route index within it
let routeNear = null;          // [lat,lng] meeting point picked on the map
let routeNearMarker = null;
let routeGen = { zip: null, busy: false, phase: '', error: '' };   // one generate at a time, tied to its ZIP
let routeStepsOpen = {};       // `${planId}:${idx}` → true

const routeColor = i => ROUTE_COLORS[i % ROUTE_COLORS.length];
// A route colour moved toward white (t > 0) or black (t < 0).
function shadeHex(hex, t){
  const n = parseInt(hex.slice(1), 16), to = t > 0 ? 255 : 0, k = Math.abs(t);
  return '#' + [n >> 16, (n >> 8) & 255, n & 255].map(c => Math.round(c + (to - c) * k).toString(16).padStart(2, '0')).join('');
}
// Cut a drawn path into `n` stretches of equal length (sharing their joins).
function pathPieces(path, n){
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], (path[i][1] - path[i - 1][1]) * Math.cos(path[0][0] * Math.PI / 180)));
  const total = cum[cum.length - 1] || 1, out = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const end = total * (k + 1) / n, piece = [path[j]];
    while (j + 1 < path.length && cum[j + 1] <= end) piece.push(path[++j]);
    if (j + 1 < path.length && cum[j] < end) {   // split the segment that crosses the cut
      const f = (end - cum[j]) / (cum[j + 1] - cum[j]), a = path[j], b = path[j + 1];
      const cut = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
      piece.push(cut); path = path.slice(); path.splice(j + 1, 0, cut); cum.splice(j + 1, 0, end); j++;
    }
    if (piece.length > 1) out.push(piece);
  }
  return out;
}
// A plan stays on the map through the next day (leaders mark off from it the
// morning after) and goes at midnight that night; the server says when.
const planExpired = p => !!p?.expiresAt && Date.now() >= Date.parse(p.expiresAt);
function pruneExpiredPlans(){
  for (const zip of Object.keys(routePlansByZip)) {
    const live = routePlansByZip[zip].filter(p => !planExpired(p));
    if (live.length === routePlansByZip[zip].length) continue;
    routePlansByZip[zip] = live;
    if (!live.some(p => p.id === routeSelPlan) && routesLayerZip === zip) { routeSelPlan = live[0]?.id || null; routeSelIdx = null; }
    refreshRoutesSection(zip);
    if (routesLayerZip === zip) renderRoutesLayer(zip);
  }
}
setInterval(pruneExpiredPlans, 5 * 60 * 1000);
const fmtKm = m => m >= 950 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m';
const fmtMins = n => n >= 60 ? `${Math.floor(n / 60)}h${String(n % 60).padStart(2, '0')}` : `${n}m`;
// Plans made since the office's timing sheet carry one lap's time (the team
// works the territory three times a day); older plans keep their old total.
const routeTime = r => r.estLapsMin ? `~${fmtMins(r.estMin || 0)} a lap` : `~${fmtMins(r.estMin || 0)}${r.people === 2 ? ' for the pair' : ''}`;
const fmtWhen = iso => { const d = new Date(iso); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); };

async function loadRoutePlans(zip){
  if (!currentUser || !zip) return;
  // Plans first — they're a small read and what the sector leader is waiting
  // for. Coverage needs the ZIP's street graph and can take seconds after a
  // deploy, so it fills in on its own when it lands.
  const plansReq = fetch(`/api/routes?zip=${zip}`).then(r => r.ok ? r.json() : null).catch(() => null);
  const covReq = fetch(`/api/routes/coverage?zip=${zip}`).then(r => r.ok ? r.json() : null).catch(() => null);
  const pr = await plansReq;
  if (pr) routePlansByZip[zip] = (pr.plans || []).filter(p => !planExpired(p));
  if (drawerZip !== zip) return;   // moved on to another ZIP while this loaded
  if (!routeSelPlan || !(routePlansByZip[zip] || []).some(p => p.id === routeSelPlan)) {
    routeSelPlan = routePlansByZip[zip]?.[0]?.id || null; routeSelIdx = null;
  }
  if (routeSelPlan && (routePlansByZip[zip] || []).find(p => p.id === routeSelPlan)?.slim) await ensurePlanGeometry(zip, routeSelPlan);
  // A ZIP with plans opens on them — unless the user closed the section themselves.
  if (drawerSecOpen.routes === undefined && (routePlansByZip[zip] || []).length) {
    document.querySelector('[data-sec="routes"]')?.classList.remove('dr-collapsed');
  }
  refreshRoutesSection(zip);
  renderRoutesLayer(zip);
  const cr = await covReq;
  routeCoverageByZip[zip] = cr || { error: true };
  if (drawerZip === zip) refreshRoutesSection(zip);
}

// Older plans arrive without geometry; fetch it when one is shown.
async function ensurePlanGeometry(zip, planId){
  const p = (routePlansByZip[zip] || []).find(x => x.id === planId);
  if (!p || !p.slim) return p;
  try {
    const r = await fetch(`/api/routes/${planId}`);
    if (!r.ok) return p;
    const full = (await r.json()).plan;
    routePlansByZip[zip] = (routePlansByZip[zip] || []).map(x => x.id === planId ? full : x);
    return full;
  } catch { return p; }
}

function refreshRoutesSection(zip){
  if (drawerZip !== zip) return;   // never paint one ZIP's section into another ZIP's drawer
  const body = document.querySelector('[data-sec="routes"] .dr-sec-body');
  if (!body) return;
  body.innerHTML = renderRoutesSection(zip);
  wireRoutesSection(zip);
  const badge = document.querySelector('[data-sec-toggle="routes"] .rt-badge');
  const n = (routePlansByZip[zip] || []).length;
  if (badge) { badge.textContent = n ? `${n} plan${n > 1 ? 's' : ''}` : ''; badge.style.display = n ? '' : 'none'; }
}

function routesSectionHead(zip){
  const n = (routePlansByZip[zip] || []).length;
  return `<span class="rt-badge" style="${n ? '' : 'display:none'}">${n ? `${n} plan${n > 1 ? 's' : ''}` : ''}</span>`;
}

function renderRoutesSection(zip){
  const plans = routePlansByZip[zip] || [];
  const cov = routeCoverageByZip[zip];
  const savedDoors = +localStorage.getItem('rt_doors') || 100;
  const savedPairs = localStorage.getItem('rt_pairs') ?? 1;
  const savedSolos = localStorage.getItem('rt_solos') ?? 0;
  const busy = routeGen.busy && routeGen.zip === zip;
  const genError = routeGen.zip === zip ? routeGen.error : '';

  const gs = cov?.graphStats || {};
  const multi = gs.multi || {};
  const multiTxt = (multi.two || multi.three || multi.fourToCap) ? ` (${[multi.two ? `${multi.two.toLocaleString()} two-family` : '', multi.three ? `${multi.three.toLocaleString()} three-family` : '', multi.fourToCap ? `${multi.fourToCap.toLocaleString()} walk-ups` : ''].filter(Boolean).join(' · ')})` : '';
  const SOURCE_NAMES = { massgis: 'MassGIS assessor data', 'pvd-cama': 'Providence assessor data', 'ri-e911': 'RI E-911 address points', 'ct-cama': 'CT statewide assessor data', 'nyc-pluto': 'NYC PLUTO', 'nys-parcels': 'NYS tax parcels', cuyahoga: 'Cuyahoga County parcels', franklin: 'Franklin County parcels', delaware: 'Delaware County parcels', ogrip: 'Ohio statewide parcels' };
  const unitsLine = !cov?.mapped ? '' : gs.unitsSource && gs.unitsSource !== 'osm-hints'
    ? `<br>Unit counts: ${SOURCE_NAMES[gs.unitsSource] || gs.unitsSource}${gs.skipped ? ` · skipped: ${[gs.skipped.condo ? `${gs.skipped.condo.toLocaleString()} condo bldgs` : '', (cov.maxUnits ? (gs.skipped.apt || 0) + (cov.bigSkipped || 0) : gs.skipped.apt) ? `${((gs.skipped.apt || 0) + (cov.maxUnits ? cov.bigSkipped || 0 : 0)).toLocaleString()} apartment buildings (${cov.maxUnits ? cov.maxUnits + 1 : gs.policy?.aptSkipMin || 9}+ units)` : '', gs.skipped.nonres ? `${gs.skipped.nonres.toLocaleString()} vacant/commercial` : ''].filter(Boolean).join(', ') || 'none'}` : ''}`
    : `<br><span style="color:var(--yellow)">No assessor data for this ZIP — multi-family homes are only partly detected from OpenStreetMap, so door counts run low.</span>`;
  const covLine = cov?.mapped
    ? `<div class="rt-cov"><b>${(cov.buildings || gs.buildings || 0).toLocaleString()}</b> buildings · <b>${cov.totalDoors.toLocaleString()}</b> doors incl. multi-family${multiTxt} · <b>${cov.workedDoors.toLocaleString()}</b> worked in the last ${cov.rotationDays || 90} days${cov.reservedBlocks ? ` · <b>${cov.reservedBlocks}</b> blocks in live plans` : ''} · <b style="color:var(--green)">${cov.freeDoors.toLocaleString()}</b> free${unitsLine}${gs.estimated ? `<br><span style="color:var(--yellow)">Door counts here are estimates — OpenStreetMap has few buildings mapped in this ZIP, so the ${Number(gs.households || 0).toLocaleString()} households were spread along the side streets.</span>` : ''}</div>`
    : cov && cov.mapped === false
      ? `<div class="rt-cov">Streets and houses get mapped from OpenStreetMap the first time you generate here (about 30 s).</div>`
      : cov && cov.error
        ? `<div class="rt-cov">Couldn't count free doors right now. <a href="#" id="rtCovRetry">Retry</a></div>`
        : `<div class="rt-cov">Counting free doors…</div>`;

  const pairsN = Math.max(0, +savedPairs || 0), solosN = Math.max(0, +savedSolos || 0);
  const teamTxt = [pairsN ? `${pairsN} pair${pairsN > 1 ? 's' : ''}` : '', solosN ? `${solosN} solo${solosN > 1 ? 's' : ''}` : ''].filter(Boolean).join(' + ') || 'nobody yet';
  const stepper = (id, label, val, min, max, step, title) => `
      <div class="rt-step-field" title="${title || ''}">
        <label>${label}</label>
        <div class="rt-stepper">
          <button type="button" class="rt-stepbtn" data-step="${id}" data-d="-${step}" aria-label="less">−</button>
          <input id="${id}" type="number" inputmode="numeric" min="${min}" max="${max}" step="${step}" value="${val}">
          <button type="button" class="rt-stepbtn" data-step="${id}" data-d="${step}" aria-label="more">+</button>
        </div>
      </div>`;
  const pinHere = routeNear && (!routeNear.zip || routeNear.zip === zip);
  const pinNote = routeNear && routeNear.zip && routeNear.zip !== zip
    ? `<div class="rt-near rt-near-warn">📍 Your parking spot is in ${esc(routeNear.zip)}, not this ZIP — it won't be used here. <a href="#" id="rtNearClear">clear</a></div>`
    : '';
  const form = `
    ${covLine}
    <div class="rt-form">
      ${stepper('rtPairs', 'Pairs', pairsN, 0, 12, 1)}
      ${stepper('rtSolos', 'Solos', solosN, 0, 24, 1)}
      ${stepper('rtDoors', 'Doors / person', savedDoors, 20, 400, 10, 'A two-family counts as 2 doors, a triple-decker as 3; buildings with 7+ units count as 1')}
    </div>
    ${pinNote}
    <div class="rt-actions">
      ${pinHere || busy
        ? `<button class="rt-gen" id="rtGenBtn" ${busy || (!pairsN && !solosN) ? 'disabled' : ''}>${busy ? '⏳ Working…' : `⚡ Generate for ${teamTxt} · ${savedDoors} doors each`}</button>`
        : `<button class="rt-gen" id="rtParkFirst">📍 Set where you park to generate</button>`}
    </div>
    ${busy ? `<div class="rt-status" id="rtStatus">${ROUTE_PHASES[routeGen.phase] || 'Working…'}</div>` : ''}
    ${pinHere ? `<div class="rt-park">
      <div class="rt-park-txt">📍 Parking: <b>set on the map</b>${routeNear.label ? ` (${esc(routeNear.label)})` : ''}</div>
      <div class="rt-park-btns"><button type="button" class="rt-pick" id="rtParkBtn">📍 Change where we park</button></div>
    </div>` : ''}
    ${genError ? `<div class="rt-err">${esc(genError)}</div>` : ''}`;

  if (!plans.length) return form + `<div class="rt-empty">No routes yet. Set how many pairs and solos are out, set where you'll park, and generate. Each route is a lap: out along one side of every street, back along the other, finishing across the road from where it started.</div>`;

  return form + plans.map(p => {
    const sel = p.id === routeSelPlan;
    const total = p.routes.reduce((n, r) => n + (r.doors || 0), 0);
    const totalB = p.routes.reduce((n, r) => n + (r.buildings || 0), 0);
    const who = p.createdBy?.name || p.createdBy?.email || 'someone';
    return `
    <div class="rt-plan${sel ? ' sel' : ''}" data-plan="${p.id}">
      <div class="rt-plan-head">
        <b>${p.routes.length} route${p.routes.length > 1 ? 's' : ''} · ${total} doors${totalB && totalB !== total ? ` <span style="font-weight:400">(${totalB} buildings)</span>` : ''}</b>
        <span>${fmtWhen(p.createdAt)} · ${esc(who)}</span>
        ${!sel ? `<button class="rt-route-btn rt-show" data-plan="${p.id}">Show</button>` : (routeSelIdx != null ? `<button class="rt-route-btn rt-all" title="Show all routes">All</button>` : '')}
        <button class="rt-x" data-del="${p.id}" title="Remove this plan (frees its streets)">×</button>
      </div>
      <div class="rt-plan-meet">🅿 Meet at <a href="https://maps.google.com/?q=${p.meeting[0]},${p.meeting[1]}" target="_blank" rel="noopener">${p.meetingName ? esc(p.meetingName) : `${p.meeting[0].toFixed(5)}, ${p.meeting[1].toFixed(5)}`}</a>${p.seedReason === 'edge' ? ' — at the edge of what\'s been worked' : p.seedReason === 'tapped' ? ' — where you pinned' : ''} · ${p.params.doorsPerPerson}/person</div>
      ${p.short ? `<div class="rt-note">${p.shortReason === 'zip' ? 'This ZIP is nearly worked out for the rotation — some routes ran short.' : p.shortReason === 'time' ? `Houses are spread out here, so laps were kept to about ${fmtMins(p.stats?.lapMaxMin || 120)}.${p.routes.some(r => r.people === 2) ? ' Two solos cover more doors than a pair.' : ''}` : 'Free streets here are scattered — some routes ran short. Try pinning a different spot.'}</div>` : ''}
      ${p.nearUsed === false ? `<div class="rt-note">No free streets near your pin — the plan meets at the best spot instead.</div>` : ''}
      <div class="rt-plan-actions"><button class="rt-route-btn rt-share-plan" data-plan="${p.id}">Share plan</button></div>
      ${p.routes.map((r, i) => {
        const key = `${p.id}:${i}`, open = !!routeStepsOpen[key];
        const hi = sel && routeSelIdx === i;
        const turns = open ? lapTurns(r).steps : [];   // the same turn badges as the map
        return `
        <div class="rt-route${hi ? ' sel' : ''}" data-plan="${p.id}" data-idx="${i}">
          <span class="rt-dot" style="background:${routeColor(i)}"></span>
          <div class="rt-route-main">
            <div class="rt-route-lbl">${esc(r.label)} <span style="font-weight:400;color:var(--muted)">· ${r.doors} doors${r.buildings && r.buildings !== r.doors ? ` · ${r.buildings} buildings` : ''}</span></div>
            <div class="rt-route-sub">${fmtKm(r.lenM || 0)} · ${routeTime(r)}${r.deadM ? ` · <span title="walked with nothing to knock on your side">${fmtKm(r.deadM)} deadwalk</span>` : ''}${r.big ? ` · ${r.big} apt bldg${r.big > 1 ? 's' : ''}` : ''}</div>
            <div class="rt-route-sub">${esc((r.streets || []).slice(0, 3).join(', '))}${(r.streets || []).length > 3 ? '…' : ''}</div>
          </div>
          <button class="rt-route-btn rt-steps-btn" data-key="${key}">${open ? 'Hide' : 'Streets'}</button>
          <button class="rt-route-btn rt-copy" data-plan="${p.id}" data-idx="${i}" title="Share or copy for WhatsApp">Share</button>
        </div>
        ${open ? `<div class="rt-steps">${(r.steps || []).map((s, k) => `
          <div class="rt-step${s.transit ? ' transit' : ''}">
            <span class="rt-turn" style="--c:${routeColor(i)}">${s.n}${turnGlyph(turns[k]?.kind)}</span>
            <span><span class="rt-step-name">${esc(s.name)}</span>${s.transit ? ' (walk through)' : s.side ? ` <span class="rt-step-side">${s.side} side</span>` : ''}${s.from ? ` <span class="rt-step-side">from ${esc(s.from)}</span>` : ''}${s.to ? ` <span class="rt-step-side">→ ${esc(s.to)}</span>` : ''}</span>
            <span class="rt-step-doors">${s.transit ? '' : (s.buildings && s.buildings !== s.doors ? `${s.doors} <span style="color:var(--dim);font-weight:400">/ ${s.buildings}</span>` : s.doors)}${!s.transit && s.big ? ` <span style="color:var(--dim);font-weight:400">+${s.big} apt</span>` : ''}</span>
          </div>`).join('')}</div>` : ''}`;
      }).join('')}
    </div>`;
  }).join('');
}

function wireRoutesSection(zip){
  const root = document.querySelector('[data-sec="routes"]');
  if (!root) return;
  const saveField = id => { const el = root.querySelector('#' + id); if (!el) return; el.value = Math.min(+el.max, Math.max(+el.min, +el.value || +el.min)); localStorage.setItem(id.replace('rt', 'rt_').toLowerCase(), el.value); };
  ['rtDoors', 'rtPairs', 'rtSolos'].forEach(id => root.querySelector('#' + id)?.addEventListener('change', () => { saveField(id); refreshRoutesSection(zip); }));
  root.querySelectorAll('.rt-stepbtn').forEach(b => b.addEventListener('click', () => {
    const el = root.querySelector('#' + b.dataset.step); if (!el) return;
    const v = Math.min(+el.max, Math.max(+el.min, (+el.value || 0) + (+b.dataset.d)));
    el.value = v; saveField(b.dataset.step); refreshRoutesSection(zip);
  }));
  root.querySelector('#rtGenBtn')?.addEventListener('click', () => generateRoutes(zip));
  root.querySelector('#rtParkBtn')?.addEventListener('click', () => startParkPicker(zip));
  root.querySelector('#rtParkFirst')?.addEventListener('click', () => startParkPicker(zip));
  root.querySelector('#rtCovRetry')?.addEventListener('click', e => { e.preventDefault(); delete routeCoverageByZip[zip]; refreshRoutesSection(zip); loadRoutePlans(zip); });
  root.querySelector('#rtNearClear')?.addEventListener('click', e => { e.preventDefault(); setRouteNear(null); refreshRoutesSection(zip); });
  root.querySelectorAll('.rt-share-plan').forEach(b => b.addEventListener('click', async e => {
    e.stopPropagation();
    const p = (routePlansByZip[zip] || []).find(x => x.id === b.dataset.plan); if (!p) return;
    shareText(`Routes ${zip} — ${fmtWhen(p.createdAt)}`, planShareText(p));
  }));
  root.querySelectorAll('.rt-show').forEach(b => b.addEventListener('click', async () => { await ensurePlanGeometry(zip, b.dataset.plan); routeSelPlan = b.dataset.plan; routeSelIdx = null; refreshRoutesSection(zip); renderRoutesLayer(zip, true); }));
  root.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Remove this plan? Its streets go back into the pool for the next generate.')) return;
    const r = await fetch(`/api/routes/${b.dataset.del}`, { method: 'DELETE' });
    if (!r.ok) { const j = await r.json().catch(() => ({})); toast(j.error || 'Could not remove plan', 'error'); return; }
    await loadRoutePlans(zip);
  }));
  root.querySelectorAll('.rt-steps-btn').forEach(b => b.addEventListener('click', async () => { await ensurePlanGeometry(zip, b.dataset.key.split(':')[0]); routeStepsOpen[b.dataset.key] = !routeStepsOpen[b.dataset.key]; refreshRoutesSection(zip); }));
  root.querySelectorAll('.rt-copy').forEach(b => b.addEventListener('click', async e => {
    e.stopPropagation();
    const p = await ensurePlanGeometry(zip, b.dataset.plan); if (!p) return;
    shareText(`${p.routes[+b.dataset.idx].label} — ${zip}`, routeShareText(p, +b.dataset.idx));
  }));
  root.querySelectorAll('.rt-all').forEach(b => b.addEventListener('click', () => { routeSelIdx = null; refreshRoutesSection(zip); renderRoutesLayer(zip, true); }));
  root.querySelectorAll('.rt-route').forEach(row => row.addEventListener('click', async e => {
    if (e.target.closest('button')) return;
    await ensurePlanGeometry(zip, row.dataset.plan);
    // Tap again to un-highlight and see the whole plan
    const idx = +row.dataset.idx, same = routeSelPlan === row.dataset.plan && routeSelIdx === idx;
    routeSelPlan = row.dataset.plan; routeSelIdx = same ? null : idx;
    refreshRoutesSection(zip);
    renderRoutesLayer(zip, true);
  }));
}

// The phone's share sheet (WhatsApp is one tap) when it exists, the
// clipboard otherwise.
async function shareText(title, text){
  if (navigator.share) { try { await navigator.share({ title, text }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
  try { await navigator.clipboard.writeText(text); toast('Copied — paste it into WhatsApp'); }
  catch { showCopyModal(text); }
}
// Fallback when neither the share sheet nor the clipboard is available:
// the text in a box you can select and copy, line breaks intact.
function showCopyModal(text){
  document.getElementById('copyModal')?.remove();
  const m = document.createElement('div'); m.id = 'copyModal'; m.className = 'copy-modal';
  m.innerHTML = `<div class="copy-modal-card"><div class="copy-modal-hd">Copy this message</div><textarea readonly></textarea><div class="copy-modal-btns"><button type="button" class="park-btn park-btn-primary" id="copyModalSel">Select all</button><button type="button" class="park-btn park-btn-ghost" id="copyModalClose">Close</button></div></div>`;
  m.querySelector('textarea').value = text;
  m.querySelector('#copyModalSel').addEventListener('click', () => { const t = m.querySelector('textarea'); t.focus(); t.select(); });
  m.querySelector('#copyModalClose').addEventListener('click', () => m.remove());
  document.body.appendChild(m);
}
function planShareText(p){
  const meet = p.meetingName ? `${p.meetingName} · https://maps.google.com/?q=${p.meeting[0]},${p.meeting[1]}` : `https://maps.google.com/?q=${p.meeting[0]},${p.meeting[1]}`;
  const lines = [`Routes for ${p.zip} — ${fmtWhen(p.createdAt)}`, `Meet: ${meet}`, ''];
  p.routes.forEach((r, i) => {
    lines.push(`${r.label}: ${r.doors} doors${r.buildings && r.buildings !== r.doors ? ` (${r.buildings} buildings)` : ''} · ${fmtKm(r.lenM || 0)} · ${routeTime(r)}`);
    lines.push(`   ${(r.streets || []).slice(0, 6).join(', ')}${(r.streets || []).length > 6 ? '…' : ''}`);
  });
  lines.push('', 'Each route is a lap: out along one side, back along the other.');
  return lines.join('\n');
}

function routeShareText(p, idx){
  const r = p.routes[idx];
  const lines = [
    `${r.label} — ${r.doors} doors${r.buildings && r.buildings !== r.doors ? ` (${r.buildings} buildings)` : ''} · ${fmtKm(r.lenM || 0)}${r.deadM ? ` (${fmtKm(r.deadM)} deadwalk)` : ''} · ${routeTime(r)}`,
    `Meet: ${p.meetingName ? p.meetingName + ' · ' : ''}https://maps.google.com/?q=${p.meeting[0]},${p.meeting[1]}`,
    r.people === 2 ? 'Pair: one of you takes each side of the street, or leapfrog every other door.' : 'Lap: out along one side, back along the other — you finish across the road from where you start.',
    '',
  ];
  let n = 0, walk = [];
  const flushWalk = () => { if (walk.length) { lines.push(`   (walk through ${walk.join(', ')})`); walk = []; } };
  for (const s of r.steps || []) {
    if (s.transit) { if (!walk.includes(s.name)) walk.push(s.name); continue; }
    flushWalk();
    const d = s.doors === 1 ? '1 door' : `${s.doors} doors`;
    lines.push(`${++n}. ${s.name}${s.side ? ` (${s.side} side)` : ''}${s.from ? ` from ${s.from}` : ''}${s.to ? ` → ${s.to}` : ''} — ${d}${s.buildings && s.buildings !== s.doors ? ` / ${s.buildings} bldgs` : ''}${s.big ? ` (+${s.big} apt bldg)` : ''}`);
  }
  flushWalk();
  return lines.join('\n');
}

const ROUTE_PHASES = {
  starting: 'Starting…',
  loading: 'Loading the streets for this ZIP…',
  osm: 'Mapping streets & houses from OpenStreetMap — first time in this ZIP, can take a few minutes…',
  worked: 'Checking what\'s already been worked…',
  routing: 'Drawing the laps…',
};
async function generateRoutes(zip){
  if (routeGen.busy) { if (routeGen.zip !== zip) { routeGen.error = ''; toast(`Still generating in ${routeGen.zip} — one at a time`); } return; }
  const doors = +document.getElementById('rtDoors')?.value || 100;
  const pairings = +document.getElementById('rtPairs')?.value || 0;
  const solos = +document.getElementById('rtSolos')?.value || 0;
  if (!pairings && !solos) { routeGen = { zip, busy: false, phase: '', error: 'Add at least one pairing or solo.' }; refreshRoutesSection(zip); return; }
  routeGen = { zip, busy: true, phase: 'starting', error: '' }; refreshRoutesSection(zip);
  const near = routeNear && (!routeNear.zip || routeNear.zip === zip) ? [routeNear.lat, routeNear.lng] : null;
  if (!near) { routeGen = { zip, busy: false, phase: '', error: 'Set where you park first.' }; refreshRoutesSection(zip); return; }
  try {
    const r = await fetch('/api/routes/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ zip, doorsPerPerson: doors, pairings, solos, near }),
    });
    let j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    // Long job (OSM fetch): poll until it lands. The plan is saved server-side
    // either way, so a dropped connection never loses it.
    const t0 = Date.now();
    while (j.pending && Date.now() - t0 < 8 * 60 * 1000) {
      routeGen.phase = j.phase || 'osm';
      if (drawerZip === zip) { const st = document.getElementById('rtStatus'); if (st) st.textContent = `${ROUTE_PHASES[routeGen.phase] || 'Working…'} · ${Math.round((Date.now() - t0) / 1000)} s`; }
      await new Promise(res => setTimeout(res, 3000));
      let sr;
      try { sr = await fetch(`/api/routes/generate/status?zip=${zip}`); }
      catch { if (drawerZip === zip) { const st = document.getElementById('rtStatus'); if (st) st.textContent = 'Reconnecting…'; } continue; }
      j = await sr.json().catch(() => ({}));
      if (j.none) { j = { none: true, restarted: true }; break; }
    }
    if (j.error) throw new Error(j.error);
    if (!j.plan) throw new Error(j.restarted ? 'The server restarted while working — tap Generate again.' : j.pending ? 'Still working — reopen this ZIP in a minute, the plan will be here.' : 'No plan came back');
    toast(`${j.plan.routes.length} route${j.plan.routes.length > 1 ? 's' : ''} ready in ${zip}`);
    routeGen = { zip, busy: false, phase: '', error: '' };
    if (near) setRouteNear(null);   // the pin did its job
    if (drawerZip === zip) {
      routeSelPlan = j.plan.id; routeSelIdx = null;
      await loadRoutePlans(zip);
      renderRoutesLayer(zip, true);
      setTimeout(() => { const el = document.querySelector(`.rt-plan[data-plan="${j.plan.id}"]`); if (el) { el.scrollIntoView({ block: 'start', behavior: 'smooth' }); el.classList.add('rt-plan-new'); } }, 100);
    } else {
      delete routePlansByZip[zip];   // reload fresh when that ZIP is opened next
    }
  } catch (e) {
    routeGen = { zip, busy: false, phase: '', error: e.message };
  } finally {
    routeGen.busy = false; routeGen.phase = '';
    refreshRoutesSection(zip);   // no-op unless this ZIP's drawer is open
  }
}

// ── Meeting point ─────────────────────────────────────────────────────────
// One button. It puts the drawer away, pins a P to the middle of the map and
// asks you to move the map until the P is where you'll park — the pattern
// every ride app uses, one thumb, no modes to learn. "Use my location" is
// there for the leader already standing at the car. No pin = automatic.
function startParkPicker(zip){
  if (!map) return;
  document.getElementById('parkPicker')?.remove();
  closeDrawer();
  if (currentView !== 'map') switchView('map');
  const l = layerByZip[zip];
  const centred = l && l.getBounds().contains(map.getCenter());
  if (l && !centred) map.fitBounds(l.getBounds(), { maxZoom: 15 });
  else if (map.getZoom() < 14) map.setZoom(15);
  const ui = document.createElement('div');
  ui.id = 'parkPicker';
  ui.innerHTML = `
    <div class="park-pin"><div class="rt-marker meet">P</div><div class="park-pin-stem"></div></div>
    <div class="park-bar">
      <div class="park-bar-txt">Move the map until the <b>P</b> is where you'll park in <b>${esc(zip)}</b></div>
      <div class="park-bar-msg" id="parkMsg"></div>
      <div class="park-bar-btns">
        <button type="button" class="park-btn park-btn-primary" id="parkUse">Use this spot</button>
        <button type="button" class="park-btn" id="parkLoc">📍 My location</button>
        <button type="button" class="park-btn park-btn-ghost" id="parkCancel">Cancel</button>
      </div>
    </div>`;
  document.getElementById('map').appendChild(ui);
  const done = () => {
    if (!ui.isConnected) return;   // a late location callback after Cancel or a chosen spot
    ui.remove();
    drawerSecOpen.routes = true;
    openDrawer(zip, { zoom: false, scrollTo: 'routes' });
    document.getElementById('drawer')?.classList.add('expanded');
  };
  L.DomEvent.disableClickPropagation(ui.querySelector('.park-bar'));
  L.DomEvent.disableScrollPropagation(ui.querySelector('.park-bar'));
  ui.querySelector('#parkCancel').addEventListener('click', done);
  ui.querySelector('#parkUse').addEventListener('click', () => {
    const c = map.getCenter();
    const here = detectZipForPoint(c.lat, c.lng);
    if (here && here !== zip) { ui.querySelector('#parkMsg').textContent = `That spot is in ${here} — move the map inside ${zip}.`; return; }
    setRouteNear({ lat: c.lat, lng: c.lng, zip, label: null });
    done();
  });
  ui.querySelector('#parkLoc').addEventListener('click', () => {
    if (!navigator.geolocation) { ui.querySelector('#parkMsg').textContent = 'Location is not available on this device.'; return; }
    ui.querySelector('#parkMsg').textContent = 'Finding you…';
    ui.querySelector('#parkLoc').disabled = true;
    navigator.geolocation.getCurrentPosition(pos => {
      if (!ui.isConnected) return;
      ui.querySelector('#parkLoc').disabled = false;
      const { latitude: lat, longitude: lng } = pos.coords;
      const here = detectZipForPoint(lat, lng);
      if (here && here !== zip) { ui.querySelector('#parkMsg').textContent = `You're in ${here}, not ${zip} — move the map instead.`; map.setView([lat, lng], Math.max(map.getZoom(), 15)); return; }
      setRouteNear({ lat, lng, zip, label: 'your location' });
      done();
    }, () => { if (!ui.isConnected) return; ui.querySelector('#parkLoc').disabled = false; ui.querySelector('#parkMsg').textContent = 'Could not get your location — check location permission.'; }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  });
}

function setRouteNear(v){
  routeNear = v;
  if (routeNearMarker) { map.removeLayer(routeNearMarker); routeNearMarker = null; }
  if (!v) return;
  routeNearMarker = L.marker([v.lat, v.lng], {
    icon: L.divIcon({ className: '', html: `<div class="rt-marker meet">P</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
    interactive: false, zIndexOffset: 900,
  }).addTo(map);
}

// ── Map layer ─────────────────────────────────────────────────────────────
// Shift a [lat,lng] path to its right-hand side by `m` metres (bisector at
// each corner so the two legs of a lap stay parallel to the street).
function offsetPathRight(path, m){
  if (!path || path.length < 2) return path || [];
  const kLat = 111320, kLng = 111320 * Math.cos(path[0][0] * Math.PI / 180);
  const dirs = [];
  for (let i = 1; i < path.length; i++) {
    const dx = (path[i][1] - path[i-1][1]) * kLng, dy = (path[i][0] - path[i-1][0]) * kLat;
    const L = Math.hypot(dx, dy) || 1; dirs.push({ x: dx / L, y: dy / L });
  }
  const out = [];
  for (let i = 0; i < path.length; i++) {
    const d1 = dirs[Math.max(0, i - 1)], d2 = dirs[Math.min(dirs.length - 1, i)];
    let nx = (d1.y + d2.y) / 2, ny = -(d1.x + d2.x) / 2;         // right-hand normal (east=x, north=y)
    const n = Math.hypot(nx, ny);
    if (n < 0.2) {
      // A U-turn (dead end): step off to the right of the way in, then the
      // right of the way out — the lap turns around at the end of the street.
      out.push([path[i][0] - d1.x * m / kLat, path[i][1] + d1.y * m / kLng]);
      out.push([path[i][0] - d2.x * m / kLat, path[i][1] + d2.y * m / kLng]);
      continue;
    }
    nx /= n; ny /= n;
    // The bisector sits further out on sharp corners; cap at 1.5× the offset
    const cosHalf = Math.sqrt(Math.max(0, (d1.x * d2.x + d1.y * d2.y + 1) / 2));
    const k = m / Math.max(cosHalf, 0.66);
    out.push([path[i][0] + ny * k / kLat, path[i][1] + nx * k / kLng]);
  }
  return out;
}

// Where a lap turns back at a corner another line runs through (the cross
// street is part of a route too), the turn is drawn `back` metres before the
// corner, so the loop's end doesn't cut across that line and read as a turn
// onto it; the team crosses just short of the corner anyway. A turn with no
// other line at its corner (a dead end) stays at the very end. `busyAt(ll, i)`
// says whether another line passes the corner at path index i.
function pullBackTurns(path, back, busyAt){
  if (!path || path.length < 3 || !(back > 0)) return path;
  const kLat = 111320, kLng = 111320 * Math.cos(path[0][0] * Math.PI / 180);
  const dist = (a, b) => Math.hypot((b[0] - a[0]) * kLat, (b[1] - a[1]) * kLng);
  const cuts = [];
  for (let i = 1; i < path.length - 1; i++) {
    const ax = (path[i][1] - path[i-1][1]) * kLng, ay = (path[i][0] - path[i-1][0]) * kLat;
    const bx = (path[i+1][1] - path[i][1]) * kLng, by = (path[i+1][0] - path[i][0]) * kLat;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (!la || !lb || (ax * bx + ay * by) / (la * lb) > -0.85) continue;   // not a turn back
    // How far the way in and the way out run together
    let k = 1, together = 0;
    while (i - k >= 0 && i + k < path.length && dist(path[i - k], path[i + k]) < 2) { together += dist(path[i - k + 1], path[i - k]); k++; }
    if (!busyAt(path[i], i, k)) continue;
    const b = Math.min(back, together * 0.4);
    if (b < 1) continue;
    // The point b metres back along the way in, and where the way out passes it
    let j = i, d = 0;
    while (j > 0 && d + dist(path[j - 1], path[j]) < b) { d += dist(path[j - 1], path[j]); j--; }
    const f = (b - d) / (dist(path[j - 1], path[j]) || 1), p0 = path[j], p1 = path[j - 1];
    const cut = [p0[0] + (p1[0] - p0[0]) * f, p0[1] + (p1[1] - p0[1]) * f];
    let m = i, e = 0;
    while (m < path.length - 1 && e + dist(path[m], path[m + 1]) <= b) { e += dist(path[m], path[m + 1]); m++; }
    cuts.push({ from: j, to: m + 1, cut });
    i = m;
  }
  if (!cuts.length) return path;
  const out = []; let at = 0;
  for (const c of cuts) { out.push(...path.slice(at, c.from), c.cut); at = c.to; }
  return out.concat(path.slice(at));
}

// The point `d` metres along a path (held to its ends), and the index of
// the segment it's on. `cum` is the running distance to each point.
function lapPointAt(path, cum, d){
  let i = 1; while (i < cum.length - 1 && cum[i] < d) i++;
  const f = Math.max(0, Math.min(1, (d - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1)));
  return { i, at: [path[i-1][0] + (path[i][0] - path[i-1][0]) * f, path[i-1][1] + (path[i][1] - path[i-1][1]) * f] };
}

// How far the walker turns at `d` metres along: the heading over the `w`
// metres before it against the `w` metres after, in degrees — positive to
// the right, near ±180 for turning back. Null where there's no path.
function lapTurnAngle(path, M, d, w){
  const P = x => lapPointAt(path, M.cum, x).at, p = P(d - w), q = P(d), s = P(d + w);
  const ax = (q[1] - p[1]) * M.kLng, ay = (q[0] - p[0]) * M.kLat, bx = (s[1] - q[1]) * M.kLng, by = (s[0] - q[0]) * M.kLat;
  if (Math.hypot(ax, ay) < .5 || Math.hypot(bx, by) < .5) return null;
  return -Math.atan2(ax * by - ay * bx, ax * bx + ay * by) * 180 / Math.PI;
}

// What the walker does where each step starts — left, right, straight on or
// back the way they came — and the stretches walked one way in between. It's
// read off the path, not stored with the plan, so plans saved before this
// get it too; the map badges and the drawer's step list both come from here,
// so they always agree. A step with no corner saved gets no turn, not a guess.
function lapTurns(r){
  const path = Array.isArray(r?.path) ? r.path : null, steps = Array.isArray(r?.steps) ? r.steps : [];
  const res = { M: null, legs: [], steps: steps.map((s, k) => ({ n: s?.n ?? k + 1, transit: !!s?.transit, kind: null, d: k ? null : 0 })) };
  if (!path || path.length < 2 || !path.every(p => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]))) return res;
  // Metres per degree near the lap (the same flat-earth sum the offset
  // uses — plenty at street scale) and the running distance to every point
  const kLat = 111320, kLng = 111320 * Math.cos(path[0][0] * Math.PI / 180), cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot((path[i][1] - path[i-1][1]) * kLng, (path[i][0] - path[i-1][0]) * kLat));
  const M = { kLat, kLng, cum }, total = cum[cum.length - 1];
  if (!(total > 0)) return res;
  res.M = M;
  // Where each step starts: its corner (`at`) pins the place, and the step
  // lengths say which pass of that corner — measured from the step before,
  // since a stored length can be a street's length rather than the walk's,
  // and that error mustn't pile up down the list.
  const lens = steps.map(s => +s?.lenM > 0 ? +s.lenM : 0), sum = lens.reduce((a, b) => a + b, 0);
  const scale = sum > 0 ? Math.min(1.25, Math.max(0.8, total / sum)) : 0;
  let lastD = 0, pending = lens[0], from = 1;
  res.steps.forEach((t, k) => {
    if (!k) return;
    const at = steps[k]?.at;
    if (!Array.isArray(at) || !isFinite(at[0]) || !isFinite(at[1])) { pending += lens[k]; return; }
    const dd = i => Math.hypot((path[i][0] - at[0]) * M.kLat, (path[i][1] - at[1]) * M.kLng);
    const want = lastD + pending * scale;
    let best = -1, bestCost = Infinity;
    for (let i = from; i < path.length - 1; i++) {
      if (dd(i) > 12) continue;
      if (!scale) { best = i; break; }   // no lengths: the first pass after the last step
      const cost = Math.abs(cum[i] - want);
      if (cost < bestCost) { bestCost = cost; best = i; }
    }
    if (best < 0) { pending += lens[k]; return; }
    // Then that pass's point nearest the corner itself: the turn is read
    // there, and a point a few metres short reads a real corner as straight.
    while (best + 1 < path.length - 1 && dd(best + 1) < dd(best)) best++;
    while (best - 1 >= from && dd(best - 1) < dd(best)) best--;
    t.d = lastD = cum[best]; from = best + 1; pending = lens[k];
  });
  // The turn at each step's start, over a few metres either side (less when
  // the steps around it are short, so a jog across a main road reads as the
  // two turns it is).
  const located = res.steps.filter(t => t.d != null);
  located.forEach((t, j) => {
    if (!j) return;
    const next = j + 1 < located.length ? located[j + 1].d : total;
    const a = lapTurnAngle(path, M, t.d, Math.max(4, Math.min(15, 0.8 * Math.min(t.d - located[j - 1].d, next - t.d))));
    t.kind = a == null ? 'straight' : Math.abs(a) >= 145 ? 'back' : a >= 30 ? 'right' : a <= -30 ? 'left' : 'straight';
  });
  // The stretches walked one way end at each step's start and at each dead
  // end a step turns back at part-way (the list merges "down and back up").
  const cuts = located.map(t => t.d);
  for (let i = 1; i < path.length - 1; i++) {
    const a = lapTurnAngle(path, M, cum[i], 10);
    if (a != null && Math.abs(a) >= 145 && !cuts.some(c => Math.abs(c - cum[i]) < 15)) cuts.push(cum[i]);
  }
  let a0 = 0;
  for (const c of cuts.concat(total).sort((a, b) => a - b)) { if (c - a0 > 1) res.legs.push({ a: a0, b: c }); a0 = c; }
  return res;
}

// Turn glyphs, pointing "ahead" like a sat-nav's — the same on the map
// badges and in the step list. Straight on has none: an arrow that isn't a
// turn is just another arrow, and the step number says enough.
const TURN_GLYPHS = {
  right:    '<path d="M4.5 14.5V9.5A3.5 3.5 0 0 1 8 6h6"/><path d="M11 3l3 3-3 3"/>',
  left:     '<path d="M11.5 14.5V9.5A3.5 3.5 0 0 0 8 6H2"/><path d="M5 3L2 6l3 3"/>',
  back:     '<path d="M11.5 14.5V7a3.5 3.5 0 0 0-7 0v6.5"/><path d="M1.5 10.5l3 3 3-3"/>',
};
const turnGlyph = kind => TURN_GLYPHS[kind] ? `<svg class="rt-g" viewBox="0 0 16 16" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${TURN_GLYPHS[kind]}</g></svg>` : '';

// The highlighted route's way round: a Start and a Finish where the lap
// begins and ends (either side of its first street, since a lap finishes
// across the road from where it started), and from zoom 15 a white chevron
// per stretch walked one way. Turn-by-turn lives in the drawer's street
// list, not on the map. Nothing covers the route numbers or the P (`taken`).
function routeDirMarkers(r, color, offM, z, taken){
  const T = lapTurns(r), M = T.M, path = r.path, sgn = r.hand === 'left' ? -1 : 1;   // the side the line is drawn on
  if (!M) return [];
  const cum = M.cum, total = cum[cum.length - 1], res = [];
  const boxes = taken.filter(ll => ll?.length === 2).map(ll => { const p = map.project(ll, z); return { x: p.x, y: p.y, w: 28, h: 28 }; });
  const mpp = 156543.03 * Math.cos(path[0][0] * Math.PI / 180) / Math.pow(2, z);
  // A point on the drawn line `d` metres along and its heading in degrees —
  // or, for a w×h label, as far out as it takes to leave the street's name clear
  const onLine = (d, w, h) => {
    const p = lapPointAt(path, cum, d), a = path[p.i - 1], b = path[p.i];
    const dx = (b[1] - a[1]) * M.kLng, dy = (b[0] - a[0]) * M.kLat, L = Math.hypot(dx, dy) || 1;
    const off = w ? Math.max(offM, (6 + (Math.abs(dy) * w + Math.abs(dx) * h) / 2 / L) * mpp) : offM;
    return { ll: [p.at[0] - sgn * dx / L * off / M.kLat, p.at[1] + sgn * dy / L * off / M.kLng], deg: Math.atan2(dx, dy) * 180 / Math.PI };
  };
  // Takes a w×h screen box there unless something already has it (`force` takes it anyway)
  const room = (ll, w, h, force) => {
    const p = map.project(ll, z), ok = force || !boxes.some(b => Math.abs(b.x - p.x) * 2 < b.w + w + 4 && Math.abs(b.y - p.y) * 2 < b.h + h + 4);
    if (ok) boxes.push({ x: p.x, y: p.y, w, h });
    return ok;
  };
  // Start a little way into the first stretch, Finish the same way back from the end
  const into = Math.min(total * 0.12, 34 * mpp + 6);
  for (const [d, text, cls] of [[into, 'Start', 'start'], [total - into, 'Finish', 'finish']]) {
    const w = 30 + 6.5 * text.length, at = onLine(d, w, 20).ll;
    room(at, w, 20, true);
    res.push(L.marker(at, {
      icon: L.divIcon({ className: '', html: `<div class="rt-pin-at"><div class="rt-end ${cls}" style="--c:${color}">${cls === 'start' ? '▶' : '🏁'} ${text}</div></div>`, iconSize: [0, 0] }),
      interactive: false, zIndexOffset: 860,
    }));
  }
  if (z < 15) return res;
  for (const leg of T.legs) {
    if (leg.b - leg.a < 60 * mpp) continue;   // too short on screen to need one
    const at = onLine((leg.a + leg.b) / 2);
    if (!room(at.ll, 14, 14)) continue;
    res.push(L.marker(at.ll, {   // the chevron points east at 0°
      icon: L.divIcon({ className: '', html: `<svg class="rt-chev" viewBox="0 0 14 14" style="transform:rotate(${Math.round(at.deg - 90)}deg)"><path class="c0" d="M4.5 2.5L9.5 7l-5 4.5"/><path class="c1" d="M4.5 2.5L9.5 7l-5 4.5"/></svg>`, iconSize: [14, 14] }),
      interactive: false, zIndexOffset: 640,
    }));
  }
  return res;
}

// The highlighted route's name across the top of the map, with an ✕ that
// goes back to the whole plan.
function syncRouteSelBar(zip, plan){
  let bar = document.getElementById('rtSelBar');
  const r = plan && routeSelIdx != null ? plan.routes?.[routeSelIdx] : null;
  if (!r) { bar?.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'rtSelBar'; bar.className = 'rt-selbar';
    document.getElementById('map').appendChild(bar);
    L.DomEvent.disableClickPropagation(bar);
    L.DomEvent.disableScrollPropagation(bar);
  }
  bar.innerHTML = `<span class="rt-dot" style="background:${routeColor(routeSelIdx)}"></span><span class="rt-selbar-txt">${esc(r.label)} · ${r.doors} doors</span><button type="button" class="rt-selbar-x" aria-label="Show all routes">✕</button>`;
  bar.querySelector('button').onclick = () => { routeSelIdx = null; refreshRoutesSection(zip); renderRoutesLayer(zip); };
}

let routesLayerZip = null;
function renderRoutesLayer(zip, fit){
  if (routesLayer) { map.removeLayer(routesLayer); routesLayer = null; }
  routesLayerZip = zip;
  if (!renderRoutesLayer._zoomWired) {
    renderRoutesLayer._zoomWired = true;
    map.on('zoomend', () => { if (routesLayer && routesLayerZip) renderRoutesLayer(routesLayerZip); });
  }
  const plan = (routePlansByZip[zip] || []).find(p => p.id === routeSelPlan && !planExpired(p));
  if (!plan) { syncRouteSelBar(zip, null); return; }
  const items = [], hits = [], routes = plan.routes || [], z = map.getZoom();
  // Metres per pixel at this zoom → an offset that clears the label at any
  // zoom: 10 px each side leaves a street name's height of road showing
  // between the two legs' casings.
  const mpp = 156543.03 * Math.cos((plan.meeting?.[0] || 42) * Math.PI / 180) / Math.pow(2, z);
  const offsetMetres = Math.max(6, 10 * mpp);
  // Every corner each route's line passes, to tell a turn back at a busy
  // corner (pulled back, see pullBackTurns) from one at a dead end.
  const cornerKey = ll => `${Math.round(ll[0] * 1e5)},${Math.round(ll[1] * 1e5)}`;
  const corners = new Map();
  routes.forEach((r, ri) => (r?.path || []).forEach((ll, vi) => { const key = cornerKey(ll); (corners.get(key) || corners.set(key, []).get(key)).push([ri, vi]); }));
  const busyAt = ri => (ll, i, span) => {
    const [la, ln] = cornerKey(ll).split(',').map(Number);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++)
      for (const [r2, v2] of corners.get(`${la + dy},${ln + dx}`) || []) if (r2 !== ri || Math.abs(v2 - i) > span) return true;
    return false;
  };
  // Far enough back that the turn clears the cross street's line and its casing
  const turnBackM = offsetMetres + 12 * mpp;
  // The highlighted route goes last, so its line sits on top of the others
  routes.map((r, i) => [r, i]).sort((a, b) => (a[1] === routeSelIdx) - (b[1] === routeSelIdx)).forEach(([r, i]) => {
    if (!r?.path?.length) return;
    const color = routeColor(i), dim = routeSelIdx != null && routeSelIdx !== i;
    const selected = routeSelIdx === i;
    // Every route is drawn the way it's walked: offset to the side the team
    // walks on (the left since the keep-left laps; plans before that kept
    // right), so the out-leg and the back-leg sit either side of the street
    // and join at the ends — the hand-drawn loop — and the road name in the
    // middle stays readable. The offset scales with zoom so it always
    // clears the label. The highlighted one is bold on a dark casing (it
    // holds on the street, dark and satellite maps); the others step back.
    const drawPath = offsetPathRight(pullBackTurns(r.path, turnBackM, busyAt(i)), (r.hand === 'left' ? -1 : 1) * offsetMetres);
    items.push(L.polyline(drawPath, { color: '#10081a', weight: selected ? 7 : dim ? 5 : 6, opacity: selected ? .8 : dim ? .12 : .45, lineJoin: 'round', interactive: false }));
    // The highlighted route goes from pale at the start to deep at the
    // finish, so where the lap passes near itself the two stretches read as
    // different shades — and the lighter one is walked first.
    const pieces = selected ? pathPieces(drawPath, 12).map((pp, k, a) => [pp, shadeHex(color, a.length > 1 ? 0.55 - 0.8 * k / (a.length - 1) : 0)]) : [[drawPath, color]];
    for (const [pp, c] of pieces) items.push(L.polyline(pp, { color: c, weight: selected ? 4.5 : dim ? 3 : 4, opacity: dim ? .4 : .95, lineJoin: 'round', lineCap: 'butt', interactive: false }));
    // A finger-wide invisible line on top takes the tap: the drawn one is
    // 4 px, which a thumb misses and the ZIP underneath catches instead.
    const hit = L.polyline(drawPath, { color: '#000', weight: 26, opacity: 0, lineJoin: 'round', bubblingMouseEvents: false });
    hit.on('click', e => {
      L.DomEvent.stopPropagation(e);
      if (routeSelIdx === i) return;   // the ✕ at the top goes back to the whole plan
      routeSelIdx = i; refreshRoutesSection(zip); renderRoutesLayer(zip);
    });
    hits.push([hit, selected]);
    if (r.start) items.push(L.marker(r.start, {
      icon: L.divIcon({ className: '', html: `<div class="rt-marker" style="background:${color}">${i + 1}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
      interactive: false, zIndexOffset: 800 + i,
    }));
  });
  if (plan.meeting?.length === 2) items.push(L.marker(plan.meeting, {
    icon: L.divIcon({ className: '', html: `<div class="rt-marker meet">P</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
    interactive: false, zIndexOffset: 950,
  }));
  const hi = routes[routeSelIdx];
  if (hi?.path?.length) items.push(...routeDirMarkers(hi, routeColor(routeSelIdx), offsetMetres, z, routes.map(r => r?.start).concat([plan.meeting])));
  // Tap targets last, the highlighted route's underneath, so a neighbour that
  // runs close by is still easy to switch to.
  hits.sort((a, b) => b[1] - a[1]).forEach(([h]) => items.push(h));
  routesLayer = L.layerGroup(items).addTo(map);
  syncRouteSelBar(zip, plan);
  if (fit && currentView === 'map') {
    const target = routeSelIdx != null ? routes[routeSelIdx]?.path : routes.flatMap(r => r?.path || []);
    const dr = document.getElementById('drawer');
    const covered = dr && dr.classList.contains('open') ? Math.max(0, Math.min(window.innerHeight * 0.6, window.innerHeight - dr.getBoundingClientRect().top)) : 0;
    if (target?.length) map.fitBounds(L.latLngBounds(target), { paddingTopLeft: [30, 30], paddingBottomRight: [30, 30 + covered], maxZoom: 17 });
  }
}

// ─── Page helpers: the ⓘ guides ──────────────────────────────────────────────
// Every ⓘ carries data-help (which guide) and maybe data-help-sec (where to
// open it). One capture-phase listener handles them all, ahead of whatever the
// ⓘ sits in — a section header that collapses, the Layers bar that folds, a
// checkbox label — so tapping one never also toggles its neighbour.
function wireHelpers(){
  const pane = document.querySelector('.map-pane');
  if (pane && !pane.querySelector('.help-i-map')) pane.insertAdjacentHTML('beforeend', helpBtn('map', '', 'help-i-map'));
  document.getElementById('mobHelpersChk')?.addEventListener('change', e => setHelpers(e.target.checked));
  document.getElementById('helpersToggleBtn')?.addEventListener('click', () => {
    setHelpers(!showHelpers);
    toast(showHelpers ? 'Page helpers on' : 'Page helpers off — turn them back on here any time', 'ok');
  });
  document.addEventListener('click', e => {
    const b = e.target.closest?.('.help-i'); if (!b) return;
    e.preventDefault(); e.stopPropagation();
    openGuide(b.dataset.help, b.dataset.helpSec || '');
  }, true);
  // Capture too, so Esc closes only the guide and not the drawer under it
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !document.getElementById('guideOverlay')?.classList.contains('open')) return;
    e.stopPropagation(); closeGuide();
  }, true);
  applyHelpers();
}

const guideRole = () => VIEW_MODE ? 'view' : (currentUser?.role || 'view');
const guideVal = (v, role) => typeof v === 'function' ? v(role) : v;

function openGuide(key, secId){
  const g = GUIDES[key]; if (!g) return;
  const role = guideRole();
  const secs = g.sections.filter(s => !s.roles || s.roles.includes(role));
  let ov = document.getElementById('guideOverlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'guideOverlay';
    ov.className = 'modal-overlay guide-overlay';
    ov.innerHTML = `
      <div class="modal-panel guide-panel" role="dialog" aria-modal="true" aria-labelledby="guideTitle">
        <div class="guide-head">
          <div class="guide-head-txt">
            <div class="guide-kicker">How it works</div>
            <h3 id="guideTitle"></h3>
            <p class="guide-lede" id="guideLede"></p>
          </div>
          <button type="button" class="modal-close guide-close" id="guideClose" aria-label="Close">&times;</button>
        </div>
        <div class="guide-jump" id="guideJump"></div>
        <div class="guide-body" id="guideBody"></div>
        <div class="guide-foot">
          <button type="button" class="guide-hide" id="guideHide">Hide these <b>i</b> helpers</button>
          <button type="button" class="guide-ok" id="guideOk">Got it</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    ov.addEventListener('click', e => { if (e.target === ov) closeGuide(); });
    document.getElementById('guideClose').addEventListener('click', closeGuide);
    document.getElementById('guideOk').addEventListener('click', closeGuide);
    document.getElementById('guideHide').addEventListener('click', () => {
      closeGuide(); setHelpers(false);
      toast(isMob() ? 'Helpers hidden — turn them back on in Account' : 'Helpers hidden — turn them back on from your name, top right', 'ok');
    });
    document.getElementById('guideJump').addEventListener('click', e => {
      const b = e.target.closest('[data-jump]'); if (b) showGuideSec(b.dataset.jump);
    });
  }
  document.getElementById('guideTitle').textContent = g.title;
  document.getElementById('guideLede').innerHTML = guideVal(g.lede, role)
    + (currentUser?.demo ? ' <b>This is a view-only trial:</b> try anything, nothing is saved.' : '');
  const jump = document.getElementById('guideJump');
  jump.innerHTML = secs.length > 2 ? secs.map(s => `<button type="button" data-jump="${s.id}">${s.chip || s.h}</button>`).join('') : '';
  jump.style.display = secs.length > 2 ? '' : 'none';
  document.getElementById('guideBody').innerHTML = secs.map(s => {
    const steps = guideVal(s.steps, role), ex = guideVal(s.ex, role), tip = guideVal(s.tip, role);
    return `
    <section class="guide-sec" id="guide-${s.id}">
      <h4>${s.h}</h4>
      ${s.p ? `<p>${guideVal(s.p, role)}</p>` : ''}
      ${steps?.length ? `<${s.list === 'ul' ? 'ul' : 'ol'}>${steps.map(t => `<li>${t}</li>`).join('')}</${s.list === 'ul' ? 'ul' : 'ol'}>` : ''}
      ${ex ? `<div class="guide-ex"><span class="guide-ex-lbl">Example</span>${ex}</div>` : ''}
      ${tip ? `<p class="guide-tip">${tip}</p>` : ''}
    </section>`;
  }).join('');
  // The public view has no account to switch helpers back on from
  document.getElementById('guideHide').style.visibility = VIEW_MODE ? 'hidden' : '';
  ov.classList.add('open');
  document.getElementById('guideBody').scrollTop = 0;
  if (secId && secs.some(s => s.id === secId)) requestAnimationFrame(() => showGuideSec(secId));
  else document.getElementById('guideOk').focus({ preventScroll: true });
}

function showGuideSec(id){
  const body = document.getElementById('guideBody');
  const el = document.getElementById('guide-' + id);
  if (!body || !el) return;
  body.scrollTo({ top: el.offsetTop - body.offsetTop - 4, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1400);
}

function closeGuide(){
  document.getElementById('guideOverlay')?.classList.remove('open');
}

// The guides. Written for the people on the street and in the office: what
// the page is for, how to do its jobs, one real example. `roles` limits a
// section to those roles ('view' = the public ?mode=view map); any text field
// can be a function of the role. Keep labels exactly as the buttons say them.
const EDITORS = ['admin', 'client'];
const GUIDES = {
  map: {
    title: 'The map',
    lede: 'Every ZIP you can work, coloured by whether you can knock there. Tap a ZIP to open everything about it.',
    sections: [
      { id: 'colours', h: 'What the colours mean', list: 'ul', steps: [
        '<b style="color:#10B981">Green — Good to Pitch.</b> No permit needed. Go.',
        '<b style="color:#06B6D4">Teal — Permit Secured.</b> We hold the permit.',
        '<b style="color:#F59E0B">Yellow — Permit Needed.</b> Don\'t knock until the permit is secured.',
        '<b style="color:#EF4444">Red — Big Blocker.</b> Don\'t go. A ZIP turns red by itself when someone logs a weapons, threat-to-staff or violent-crime incident there.',
        '<b style="color:#9CA3AF">Grey — Not Reviewed.</b> Nobody has checked it yet.',
      ] },
      { id: 'find', h: 'Find a ZIP', steps: [
        'Type a ZIP or a town in <b>Search</b> at the top.',
        'Only the matching ZIPs stay on the map, and it flies to them.',
        'Clear the search box to bring every ZIP back.',
      ], tip: r => r === 'view' ? '' : 'On a computer, the state chips next to search (MA, RI, CT…) hide or show a whole state.' },
      { id: 'open', h: 'Open a ZIP', p: 'Tap any ZIP. Its drawer opens with coverage, routes, incidents and the permit, and a small card shows the miles, delivery day and sales.',
        tip: 'Tapping right on a sale pin or a worked door shows that door\'s card instead.' },
      { id: 'today', h: 'The Today bar', p: 'When ZIPs are scheduled for today, a <b>TODAY</b> strip appears at the top of the map. Tap a ZIP in it to jump there and open it.' },
      { id: 'routes', h: 'Route lines', roles: ['admin', 'client', 'sector_leader'], p: 'Routes are made in a ZIP\'s drawer (Routes). Each one has its own colour, and <b>P</b> is where the team parks.', steps: [
        'Tap a route\'s line to pick it out: <b>Start</b>, <b>Finish</b> and arrows show which way to walk.',
        'Tap <b>✕</b> in the bar at the top to see every route again.',
      ] },
      { id: 'paint', h: 'Paint and Select (computer)', chip: 'Paint & Select', roles: EDITORS, steps: [
        '<b>Paint</b>: switch it on, tap a ZIP, pick its colour.',
        '<b>Select</b>: switch it on, tap ZIPs (or drag a box with the mouse), then pick <b>Set status…</b> and <b>Apply</b>.',
      ], ex: 'The town confirms no permit is needed in four ZIPs: <b>Select</b> → tap the four → <b>Good to Pitch</b> → <b>Apply</b>.' },
      { id: 'sync', h: 'Sync sales and Sync doors (computer)', chip: 'Sync', roles: ['admin', 'client', 'sector_leader'], p: 'Both refresh by themselves every hour. Use the buttons when you need it now.', list: 'ul', steps: [
        '<b>↻ Sync sales</b> pulls the latest sales and pins from the sales sheet.',
        '<b>↻ Sync doors</b> asks ' + FIELD_APP_NAME + ' for its latest worked doors. It can take a couple of minutes.',
      ] },
      { id: 'more', h: 'More on the map', p: 'Open <b>⊞ Layers</b> for satellite photos, coverage, incidents, sales and worked doors. Every setting there has its own <b>i</b>.' },
    ],
  },

  layers: {
    title: 'Map layers',
    lede: 'Choose what\'s drawn over the map. Your choices are saved to your account, so they\'re the same on your phone and your computer.',
    sections: [
      { id: 'base', h: 'Dark · Street · Satellite, and Fill', chip: 'Map & Fill', list: 'ul', steps: [
        '<b>Street</b> is the normal map.',
        '<b>Satellite</b> is aerial photos with street names. Use it to see houses, driveways and apartment blocks before you go.',
        '<b>Dark</b> is a muted map, so the ZIP colours stand out.',
        '<b>Fill</b> sets how see-through the ZIP colours are. Slide it down to read the streets underneath.',
      ], ex: 'Is this street houses or apartment blocks? <b>Satellite</b>, then <b>Fill</b> down to about 15%.',
        tip: r => r === 'view' ? '' : 'On a phone, tap <b>⊞</b> at the top right to open or close this panel. On a computer you can drag its bar to move it.' },
      { id: 'coverage', h: '✏ Coverage', p: 'The streets teams have marked off as knocked. They\'re drawn in a ZIP\'s drawer with <b>✏ Mark Off</b>.', list: 'ul', steps: [
        '<b>Off</b>: you only see the marks of the ZIP you have open.',
        '<b>On</b>: you see every ZIP\'s marks at once.',
        '<b>All / Today / Yesterday / 7d / 30d</b>, or two dates, choose how far back to show.',
        'Marks disappear after 12 weeks, when the street is ready to knock again.',
        'Tap a mark to see who drew it and when.',
      ], ex: 'Planning tomorrow: Coverage on, <b>7d</b>. You see everything every team marked off this week.' },
      { id: 'incidents', h: '✕ Incidents', p: 'A ✕ at every address where an incident or a Do-Not-Knock was logged. Pick a type to see only that type. Tap a ✕ to read what happened and when.',
        tip: 'Before working a street, look for ✕s. Skip any Do-Not-Knock house.' },
      { id: 'difficulty', h: '⚡ Difficulty', roles: ['admin', 'client', 'view'], p: 'Recolours every ZIP from 1 (easy) to 5 (hard) by how hard the permit is. 1 is no permit needed and 5 is a Big Blocker. In between, the score comes from the fee, how long the permit takes and the distance from the office.',
        tip: r => EDITORS.includes(r) ? 'A score set by hand in a ZIP\'s drawer (Territory) beats the automatic one.' : '' },
      { id: 'dayhub', h: '🚚 Day and 🏭 Hub', chip: 'Day & Hub', p: r => 'Show only the ZIPs on one delivery day, or served from one hub.'
          + (r === 'sector_leader' || r === 'view' ? ' The Today bar follows the same filter.' : ' Pipeline, Schedule and the Today bar follow the same filter, and choosing a hub also switches Balance to it.'),
        ex: 'Monday\'s patch from ' + (HUBS[0]?.label || 'one hub') + ': <b>Day</b> = Monday, <b>Hub</b> = ' + (HUBS[0]?.label || 'that hub') + '.',
        tip: 'ZIPs gone missing? Check these are back on <b>All days</b> and <b>All hubs</b>.' },
      { id: 'sales', h: '📦 Bubbles · ⬡ Sales ZIPs · 📍 Sale pins', chip: 'Sales', p: 'Sales from the client\'s sales sheet, refreshed every hour. These buttons appear once sales have loaded.', list: 'ul', steps: [
        '<b>📦 Bubbles</b>: a circle on each ZIP, bigger for more sales.',
        '<b>⬡ Sales ZIPs</b>: hides every ZIP with no sales.',
        '<b>📍 Sale pins</b>: a dot at each sale\'s address, green, or red if cancelled. Pick a date range under it. Tap a pin for the sale date, deliveries D1–D4 (✓ = delivered) and who signed it.',
      ], ex: 'Where did this month\'s sales land? <b>📍 Sale pins</b> → <b>This month</b>.',
        tip: '"Awaiting coordinates" means the sheet doesn\'t have Latitude and Longitude columns yet, so the pins can\'t be placed.' },
      { id: 'worked', h: '🚪 Worked doors', chip: 'Worked doors', roles: ['admin', 'client', 'sector_leader'], p: 'Every door the reps knocked, synced from ' + FIELD_APP_NAME + '.', list: 'ul', steps: [
        'Colours: <b style="color:#3FAE6A">green</b> won, <b style="color:#0ea5e9">blue</b> partly won, <b style="color:#E5484D">red</b> lost, <b style="color:#f59e0b">amber</b> swing by later, <b style="color:#9ca3af">grey</b> not knocked.',
        'Pick a window: <b>Today</b>, <b>Yesterday</b>, <b>This week</b>, <b>Last week</b>, <b>30 days</b>, <b>90 days</b>, <b>6 months</b>, or <b>Custom</b>.',
        'Tap a dot for the address, the outcome, the time, and who knocked it.',
      ], ex: 'End of the day: <b>Worked doors</b> → <b>Today</b> shows where every pair actually went.',
        tip: '"Light detail" means a lot of doors are showing, so tapping one loads its details. "Locating…" means new doors are still being placed on the map. Generated routes skip doors worked in the last 90 days.' },
    ],
  },

  drawer: {
    title: 'A ZIP\'s drawer',
    lede: 'Everything about one ZIP: its numbers, the streets already knocked, walking routes for the team, incidents and the permit. Each section opens and closes when you tap its title.',
    sections: [
      { id: 'top', h: 'The top', p: 'The status (its colour on the map), the pipeline stage, distance and drive time from the office, sales (tap <b>↻</b> to refresh), households and density, and the last week it was worked.',
        tip: 'On a phone, drag the bar at the top of the drawer up for full screen, or down to see more map.' },
      { id: 'coverage', h: 'Coverage: mark off streets', chip: 'Coverage', roles: ['admin', 'client', 'sector_leader'], steps: [
        'Tap <b>✏ Mark Off</b>.',
        'Draw along the streets you\'ve knocked with one finger. Use two fingers to move or zoom the map.',
        'Pick <b>Pen</b>, <b>Marker</b> or <b>Erase</b>, a width and a colour. <b>↩ Undo</b> takes back the last mark.',
        'Tap <b>✓ Done</b>. Each mark saves the moment you draw it, dated today with your name.',
      ], ex: 'After lap 1 on Oak St, the pair marks off both sides so the next team skips it.',
        tip: r => 'The list shows each day\'s marks and when they reset (after 12 weeks). '
          + (r === 'sector_leader' ? '<b>Delete mine</b> removes only your marks.' : '<b>×</b> deletes a day; <b>Delete mine</b> deletes only yours.')
          + ' A fast, straight swipe counts as moving the map, not drawing.' },
      { id: 'routes', h: 'Routes: laps for the team', chip: 'Routes', roles: ['admin', 'client', 'sector_leader'], steps: [
        'Set <b>Pairs</b>, <b>Solos</b> and <b>Doors / person</b>. They\'re remembered for next time.',
        'Tap <b>📍 Set where you park</b>, move the map until the <b>P</b> is on your spot, then <b>Use this spot</b> (or <b>📍 My location</b>).',
        'Tap <b>⚡ Generate</b>. The first time in a ZIP it can take a minute or two.',
        '<b>Share</b> each route to the person walking it, or <b>Share plan</b> for the whole team.',
      ], ex: 'Two pairs and a solo at 100 doors each: Pairs 2, Solos 1, Doors 100 → P at the corner you\'ll meet → Generate → Share each route to its rep.',
        tip: 'Each route is a lap: out along one side of the street and back along the other, ending near where it started. Routes skip doors worked in the last 90 days and streets already in today\'s routes, and never use main roads. Tap a route (here or on the map) to pick it out; <b>Streets</b> lists the turns. Routes come off the map at midnight the day after they\'re made, and any doors not reached go back into later routes.' },
      { id: 'incidents', h: 'Incidents: log what happened', chip: 'Incidents', roles: ['admin', 'client', 'sector_leader'], steps: [
        'Open <b>Incidents</b> and pick the type.',
        'Add the address. It\'s optional, but it puts a ✕ on the map so every team sees it.',
        'Say what happened, then tap <b>Log Incident</b>.',
      ], ex: 'A homeowner asks not to be knocked again: <b>Do-Not-Knock Issue</b>, their address, <b>Log Incident</b>. The ✕ warns every team.',
        tip: 'Weapons, threats to staff and violent crime turn the ZIP red (Big Blocker) straight away. Tap <b>📍</b> on an incident to fly to it. <b>×</b> removes one; a sector leader sees it only on incidents they logged.' },
      { id: 'permit', h: 'Permit', p: r => 'Whether a permit is needed and what it costs, with the details: fee per person, full fee, lead time, how to get it, contact, allowed hours, restricted days, other rules, the ordinance and who holds the permit.'
          + (EDITORS.includes(r) ? ' <b>YES / NO</b> sets whether one is needed. <b>🤖 Research with AI</b> fills the details from the town\'s rules. Check them before a team goes out.' : '') },
      { id: 'territory', h: 'Territory', p: r => EDITORS.includes(r)
          ? 'The delivery day, hub, density and difficulty. <b>Scheduled move</b>: the client moves this ZIP to another delivery day on a date, and it\'s on hold until then. <b>Complete first</b>: another ZIP that has to be finished before this one.'
          : 'The delivery day, hub and density, any scheduled move to another delivery day, and any ZIP that has to be finished first.' },
      { id: 'actions', h: 'Edit Data and Export Map', chip: 'Edit & Export', p: r => (EDITORS.includes(r) ? '<b>✏ Edit Data</b> changes the colour and any field for this ZIP. ' : '') + '<b>⤓ Export Map</b> makes a printable map of the ZIP.' },
    ],
  },

  pipeline: {
    title: 'Pipeline',
    lede: 'Every ZIP the office has been given, moving left to right from just assigned to finished. Each column\'s <b>i</b> explains that stage.',
    sections: [
      { id: 'move', h: 'Moving a ZIP along', chip: 'Moving ZIPs', list: 'ul', steps: [
        'Drag a card into another column, or tap the card and use its green button. <b>← Back</b> steps it back.',
        'For several at once, tick their boxes, then in the bar at the bottom choose <b>Move to…</b> and <b>Move</b>.',
        'Tap the ZIP number on a card to open its drawer.',
      ], ex: 'A new ZIP from the client lands in Incoming → set its <b>Date</b> and <b>Target</b> → <b>Next →</b> → research finds no permit → <b>No Permit →</b> → on the day, <b>Deploy →</b>.' },
      { id: 'incoming', h: 'Incoming', p: 'Just assigned. Open the card, set the work <b>Date</b>, <b>Target</b> and <b>Notes</b>, then <b>Next →</b> to start permit research.' },
      { id: 'research', h: 'Researching', p: 'Checking whether the town needs a permit. Decide with <b>🪪 Needs Permit</b> or <b>No Permit →</b>.', tip: 'The ZIP\'s drawer has <b>🤖 Research with AI</b> under Permit.' },
      { id: 'flagged', h: 'Needs Permits', p: 'A permit is needed and we don\'t have it yet, so don\'t knock. ZIPs with a serious incident land here too. Once you have the permit, <b>Permit Secured →</b>.', tip: 'Applied and waiting? Switch on <b>⏳ Permit pending</b> on the card with the date you applied.' },
      { id: 'permit_secured', h: 'Permit Secured', p: 'We hold the permit. Put who holds it in <b>Rep</b>, then move it on to the column that\'s ready to deploy.' },
      { id: 'ready', h: 'No Permit Needed', p: 'Cleared to deploy. Tap <b>Deploy →</b> when a team starts working it.' },
      { id: 'active', h: 'In Field', p: 'A team is working it now. Tap <b>Complete →</b> when it\'s done.' },
      { id: 'completed', h: 'Completed', p: 'Finished. Any ZIP that has to wait for this one (🔒) can now go out.' },
      { id: 'card', h: 'What\'s on a card', chip: 'Cards', list: 'ul', steps: [
        '🚗 drive time · 🚚 delivery day · 🏭 hub · ⏸ on hold · ⚡ permit difficulty · 📦 sales · ⚠ incidents.',
        '<b>🔒 Finish 0xxxx first</b>: another ZIP has to be completed before this one.',
        'The office chip moves the ZIP to the next office (' + OFFICE_LIST.map(o => esc(o.label)).join(' → ') + ').',
      ] },
      { id: 'constraints', h: 'Why a ZIP can\'t go out yet', chip: 'Hold-ups', p: 'On an open card, switch on whatever is holding it up: <b>🚗 Needs cars</b>, <b>🪪 Partial permits</b>, <b>⏳ Permit pending</b>, <b>😴 Resting</b> or <b>📅 Awaiting date</b>. They show on the card and add up in <b>Zipcode Feedback</b> at the top, so the client can see why without asking.',
        tip: 'A ZIP that had a strong week (5 or more sales) in the last 12 weeks needs a rest. Picking a date inside that window asks you first, and marks it 😴 Resting if you go ahead.' },
    ],
  },

  calendar: {
    title: 'Schedule',
    lede: 'A month view of every pipeline ZIP that has a work date, each in its map colour.',
    sections: [
      { id: 'read', h: 'Reading it', list: 'ul', steps: [
        'Each chip is a ZIP on its work date. Tap it to open the ZIP\'s drawer.',
        '<b>‹ Prev</b> and <b>Next ›</b> change the month. Today is highlighted.',
      ] },
      { id: 'move', h: 'Changing a date', p: 'Tap <b>✎</b> on the chip and pick the new date. If the ZIP had a strong week (5 or more sales) in the last 12 weeks, you\'re asked first.' },
      { id: 'add', h: 'Getting a ZIP onto it', p: 'Set the <b>Date</b> on its Pipeline card, or fill in <b>Work from</b> when adding territories.' },
      { id: 'filter', h: 'One route at a time', p: r => 'Use <b>🚚 Day</b> and <b>🏭 Hub</b> to see one delivery day or one hub. They\'re next to the tabs on a computer and in ⊞ Layers on a phone.' + (canSwitchOffice() ? ' <b>All / ' + OFFICE_LIST.map(o => esc(o.label)).join(' / ') + '</b> picks the office.' : ''),
        ex: 'Planning ' + (HUBS[0]?.label || 'a hub') + '\'s Tuesdays: Hub = ' + (HUBS[0]?.label || 'that hub') + ', Day = Tuesday, then <b>Next ›</b> to check every Tuesday has a ZIP.' },
    ],
  },

  balance: {
    title: 'Balance',
    lede: 'For one hub: how close each delivery day is to its sales target this cycle, and which day to work next.',
    sections: [
      { id: 'why', h: 'Why balance', p: 'The client caps sales on each delivery day. Work the day that\'s furthest from its cap. When every day has hit its cap, a new cycle starts and you go round again.' },
      { id: 'cycle', h: 'Cycle view', steps: r => [
        'Pick the hub at the top.',
        'Each row is a delivery day: sold / target, a bar, and <b>N to go</b> or <b>✓ capped</b>.',
        'A day set to <b>0</b> shows <b>⏻ no target</b> — the client wants no sales there this cycle. It still lists its ZIPs, but it is never <b>Work next</b> and never holds the cycle open.',
        '<b>Work next</b> at the bottom is the day to send teams to.',
        'Tap a day to see its ZIPs, longest-unworked first (<b>⇅</b> flips the order). Tap a ZIP to open it.' + (EDITORS.includes(r) ? ' <b>Open on board →</b> shows them on the Pipeline.' : ''),
      ], ex: 'Monday morning at ' + (HUBS[0]?.label || 'a hub') + ': <b>Cycle</b> → Work next says Thursday → tap Thursday → the top ZIP has gone longest without a visit → open it and generate routes.' },
      { id: 'targets', h: 'Targets and new cycles', chip: 'Targets', roles: EDITORS, list: 'ul', steps: [
        'Type each day\'s target under <b>Targets / day</b>. It saves straight away. <b>0</b> means no sales wanted on that day this cycle.',
        '<b>Cycle start</b> is the date sales start counting from.',
        'Client sent the next phase\'s numbers already? <b>+ Book cycle N</b> opens a second strip for them. They sit there until the rotation reaches that cycle, then take over on their own.',
        'When every working day is capped, tap <b>↻ Start new cycle</b>. Counts restart from today, the booked targets take over (or the current ones carry over if nothing is booked), and past cycles stay in the cycle picker.',
      ] },
      { id: 'workable', h: 'Workable view', p: 'No targets here. Every delivery day is listed by how long it has been since it was last worked (a week with 5 or more sales counts as worked), with its sales over the last 3 months. Use it to find where nobody has been lately.' },
    ],
  },

  addTerritories: {
    title: 'Add Territories',
    lede: 'Put new ZIPs into the Pipeline\'s Incoming column, with their delivery day, hub and start date.',
    sections: [
      { id: 'rows', h: 'Type them in', steps: [
        'Pick the <b>Office</b>.',
        'Fill a row per ZIP: <b>ZIP</b>, <b>Delivery day</b>, <b>Hub</b>, <b>Work from</b>, <b>Target</b>, <b>Complete first</b>, <b>Notes</b>. <b>+ Add row</b> adds another.',
        'Have just a list of ZIPs? <b>Quick paste bare ZIPs</b>, then <b>Add to rows ↓</b>.',
        'Tap <b>Add to Pipeline</b>.',
      ] },
      { id: 'file', h: 'From a file', list: 'ul', steps: [
        '<b>⤓ CSV template</b> downloads a sheet with the right columns.',
        '<b>📂 Upload CSV / Excel</b> fills the rows from your sheet.',
        '<b>🤖 Extract with AI</b> reads anything: a photo of a list, a PDF, an email. Check the rows before you add them.',
      ], ex: 'The client emails a PDF of 12 ZIPs for ' + (HUBS[0]?.label || 'a hub') + ': <b>🤖 Extract with AI</b> → check the rows → <b>Add to Pipeline</b>.' },
      { id: 'rest', h: 'Worked in the last 12 weeks', p: 'ZIPs that had a strong week (5 or more sales) in the last 12 weeks are held back for you to decide: <b>Skip</b>, or <b>Override + 😴</b> to add them marked Resting.' },
    ],
  },

  import: {
    title: 'Import Excel / CSV',
    lede: 'Update ZIPs that are already on the map from a spreadsheet: status, delivery day, hub, permit details and more. It doesn\'t add ZIPs to the Pipeline. Use + Add Territories for that.',
    sections: [
      { id: 'steps', h: 'Import a sheet', steps: [
        'Drop the file in, or tap to pick it (.xlsx, .xls or .csv).',
        'Under <b>Map your columns</b>, choose the <b>ZIP column</b>. The others are guessed; set any you don\'t want to <b>— skip —</b>.',
        'Check the preview, then <b>Apply import</b>.',
      ] },
      { id: 'dnk', h: 'Incident and Do-Not-Knock lists', p: '<b>✕ Incident / DNK address list →</b> takes a list of addresses and puts a ✕ on the map at each one.' },
    ],
  },
};
