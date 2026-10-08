'use strict';
// Walking-route endpoints: generate routes for a team in a ZIP, list what has
// been generated, release a plan. The maths lives in lib/routegen.js and the
// street data in lib/osm.js; this file owns persistence and permissions.

const osm      = require('./osm');
const routegen = require('./routegen');
const geo      = require('./geo');
const parcels  = require('./parcels');
const blobs    = require('./blobstore');
const sec      = require('./security');

const ROTATION_DAYS  = 90;   // doors worked inside this window are not fresh territory
const WARM_DAYS      = 14;   // ZIPs with plans this recent get their graphs warmed after a deploy
const GRAPH_TTL_DAYS = 30;   // streets and houses barely change; re-fetch monthly
const PARCEL_TTL_DAYS = 180; // assessor rolls turn over yearly; the join re-runs with each graph refresh
const RAM_GRAPHS     = 24;   // ZIP graphs kept in memory
// Longest one lap may take (minutes, at the office's conservative timings):
// the team works the territory three times a day in 5.5–6 hours.
const LAP_MAX_MIN    = Math.max(45, Math.min(240, +process.env.ROUTE_LAP_MAX_MIN || 120));

// Plans live by the board's calendar (settings.timezone). A plan holds its
// streets only on the day it's made (two plans that day never share a block);
// from the next day the doors it didn't reach are free again, since the ones
// it did are pinned by then. It stays on the map through that next day, so
// leaders can mark off from it in the morning, and comes off at midnight that night.
const { settings, isAreaId } = require('./settings');
const TZ = settings.timezone;
const etDayKey = d => new Date(d).toLocaleDateString('en-CA', { timeZone: TZ });
const etHour = t => +new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).formatToParts(t).find(x => x.type === 'hour').value % 24;
function planExpiry(createdAt) {
  const [y, m, d] = etDayKey(createdAt).split('-').map(Number);
  // Midnight at the start of day d+2 in the board's zone: scan the UTC hours
  // around it (offsets run from UTC-12 to UTC+14) for the one that reads 00
  // on that calendar day.
  const target = new Date(Date.UTC(y, m - 1, d + 2)).toISOString().split('T')[0];
  for (let h = -14; h <= 12; h++) {
    const t = new Date(Date.UTC(y, m - 1, d + 2, 0) - h * 3600e3);
    if (etDayKey(t) === target && etHour(t) === 0) return t;
  }
  return new Date(Date.UTC(y, m - 1, d + 2, 5));
}

module.exports = function mountRoutes(app, deps) {
  const { mongoose, requireAuth, doorStore, warmDoorStore, knocksStore, warmKnocksStore, etDaysAgo, etToday } = deps;

  // Per-ZIP OSM graph, fetched once and reused (one Overpass round-trip is
  // 5–40 s; a Mongo read of the cached doc is a second or two).
  // Per-ZIP graph: the 1–3 MB body lives in object storage when CGT_S3_* is
  // set (`blob` = its key), else inline in `graph`. Either way this doc is
  // the index: zip, when, stats.
  const OsmCache = mongoose.model('OsmCache', new mongoose.Schema({
    zip:       { type: String, required: true, unique: true },
    fetchedAt: { type: Date, default: Date.now },
    stats:     { type: mongoose.Schema.Types.Mixed, default: {} },
    v:         { type: Number, default: 1 },
    pv:        { type: Number, default: 0 },   // parcel logic the units came from; 0 = built without the assessor
    fixture:   { type: Boolean, default: false }, // made-up street map (scripts/seed-sample.js): never refreshed from OSM
    blob:      { type: String, default: '' },
    graph:     { type: mongoose.Schema.Types.Mixed, default: null },
  }));

  // Per-ZIP normalised assessor parcels (units per building). Never sent to
  // the client; read only when a ZIP's graph is (re)built.
  const ParcelCache = mongoose.model('ParcelCache', new mongoose.Schema({
    zip:         { type: String, required: true, unique: true },
    source:      { type: String, default: '' },
    attribution: { type: String, default: '' },
    rollNote:    { type: String, default: '' },
    fetchedAt:   { type: Date, default: Date.now },
    count:       { type: Number, default: 0 },
    pv:          { type: Number, default: 1 },
    blob:        { type: String, default: '' },
    parcels:     { type: mongoose.Schema.Types.Mixed, default: [] },
  }));

  // Body in R2, pointer in Mongo. Falls back to inline storage when R2 is
  // off or fails, so a bad R2 day costs latency, never data.
  async function storeBody(Model, zip, field, body, set) {
    const key = `${field === 'graph' ? 'graphs' : 'parcels'}/${zip}.json.gz`;
    if (blobs.enabled) {
      try { await blobs.putJson(key, body); await Model.updateOne({ zip }, { $set: { ...set, blob: key }, $unset: { [field]: '' } }, { upsert: true }); return; }
      catch (e) { console.warn(`[blobs] ${key}: ${e.message} — storing inline`); }
    }
    await Model.updateOne({ zip }, { $set: { ...set, [field]: body, blob: '' } }, { upsert: true });
  }
  async function loadBody(doc, field) {
    if (!doc) return null;
    if (doc.blob && blobs.enabled) {
      try { const body = await blobs.getJson(doc.blob); if (body) return body; }
      catch (e) { console.warn(`[blobs] ${doc.blob}: ${e.message}`); }
    }
    return doc[field] || null;
  }

  const RoutePlan = mongoose.model('RoutePlan', new mongoose.Schema({
    zip:        { type: String, required: true, index: true },
    office:     { type: String, default: '' },
    status:     { type: String, default: 'active' },        // active | cancelled
    createdAt:  { type: Date, default: Date.now },
    createdBy:  { type: mongoose.Schema.Types.Mixed, default: {} },   // { id, name, email }
    params:     { type: mongoose.Schema.Types.Mixed, default: {} },
    meeting:    { type: [Number], default: [] },            // [lat, lng]
    need:       { type: Number, default: 0 },
    patchDoors: { type: Number, default: 0 },
    short:      { type: Boolean, default: false },
    stats:      { type: mongoose.Schema.Types.Mixed, default: {} },
    routes:     { type: [mongoose.Schema.Types.Mixed], default: [] },
    segIds:     { type: [String], default: [] },
  }, { strict: false }));
  RoutePlan.schema.index({ zip: 1, createdAt: -1 });

  // ── Graph cache (RAM → Mongo → Overpass) ──────────────────────────────────
  const ram = new Map();           // zip → graph
  const inflight = new Map();      // zip → promise
  // A graph is stale when it is old, from before a rule change, or built
  // without the assessor's units in a ZIP that has an assessor (the fetch
  // failed that day). The last one is retried daily, not on every open.
  const hasAdapter = zip => { try { return !!parcels.adapterNameFor(zip, parcels.metaFor(zip)); } catch { return false; } };
  function graphStale(zip, m) {
    if (!m) return true;
    if (m.fixture) return false;     // a sample street map is never rebuilt from OpenStreetMap
    const age = Date.now() - new Date(m.fetchedAt || 0).getTime();
    if (age > GRAPH_TTL_DAYS * 864e5) return true;
    if ((m.v || 1) < osm.GRAPH_VERSION) return true;
    if ((m.pv || 0) < parcels.PARCEL_VERSION && hasAdapter(zip) && age > 864e5) return true;
    return false;
  }
  async function getGraph(zip, { refresh = false, staleOk = false, onFetch = null } = {}) {
    if (!refresh && ram.has(zip)) {
      const g = ram.get(zip); ram.delete(zip); ram.set(zip, g);
      if (graphStale(zip, g)) scheduleRebuild(zip);   // serve this one, rebuild behind it
      return g;
    }
    if (inflight.has(zip)) return inflight.get(zip);
    const p = (async () => {
      const doc = refresh ? null : await OsmCache.findOne({ zip }).lean();
      const fresh = doc && !graphStale(zip, { v: doc.v || doc.graph?.v || 1, pv: doc.pv, fetchedAt: doc.fetchedAt, fixture: doc.fixture });
      // A read-only caller (coverage) takes whatever is cached, whatever its
      // age — a live OpenStreetMap fetch has no place inside a drawer open.
      if (doc && (fresh || staleOk)) { const g = await loadBody(doc, 'graph'); if (g) return remember(zip, g, doc); }
      try {
        onFetch?.();
        return remember(zip, await fetchAndStore(zip));
      } catch (e) {
        const g = doc ? await loadBody(doc, 'graph') : null;
        if (g) { console.warn(`[routes] ${zip}: OSM refresh failed (${e.message}) — using the ${Math.round((Date.now() - new Date(doc.fetchedAt)) / 864e5)}-day-old graph`); return remember(zip, g, doc); }
        throw e;
      }
    })().finally(() => inflight.delete(zip));
    inflight.set(zip, p);
    // Whatever was served — a stale graph taken as-is, or an old one kept
    // after a failed refresh — gets its rebuild queued behind the response.
    p.then(g => { if (graphStale(zip, g)) scheduleRebuild(zip); }, () => {});
    return p;
  }
  // Background rebuilds run one at a time, and a ZIP whose rebuild failed
  // (Overpass down, assessor down) waits half an hour before it is tried
  // again — a bad afternoon costs a few log lines, not a fetch per drawer
  // open. The old graph stays in RAM and keeps serving meanwhile.
  const rebuildTriedAt = new Map();
  const rebuildQueue = []; let rebuilding = false;
  function scheduleRebuild(zip) {
    if (inflight.has(zip) || rebuildQueue.includes(zip)) return;
    if (Date.now() - (rebuildTriedAt.get(zip) || 0) < 30 * 60_000) return;
    rebuildQueue.push(zip);
    if (!rebuilding) drainRebuilds();
  }
  async function drainRebuilds() {
    rebuilding = true;
    while (rebuildQueue.length) {
      const zip = rebuildQueue.shift();
      rebuildTriedAt.set(zip, Date.now());
      const p = fetchAndStore(zip).then(g => remember(zip, g)).finally(() => inflight.delete(zip));
      inflight.set(zip, p);
      try { await p; } catch (e) { console.warn(`[routes] ${zip}: background rebuild failed: ${e.message}`); }
    }
    rebuilding = false;
  }
  // Assessor parcels for a ZIP: cached for 180 days; a failed refresh keeps
  // the old set; no adapter or a first-time failure → null (OSM hints).
  async function getParcels(zip) {
    const geom = osm.zipGeometry(zip);
    if (!geom) return null;
    const doc = await ParcelCache.findOne({ zip }).lean();
    const current = doc && (doc.pv || 1) >= parcels.PARCEL_VERSION && Date.now() - new Date(doc.fetchedAt).getTime() < PARCEL_TTL_DAYS * 864e5;
    const withBody = async d => { if (!d?.count) return null; const body = await loadBody(d, 'parcels'); return body ? { ...d, parcels: body } : null; };
    if (current) {
      // A current doc with no parcels is a known-empty ZIP. One whose body
      // can't be read (R2 down, inline lost) is fetched again, not treated as
      // empty for the next six months.
      if (!doc.count) return { parcels: [], pv: doc.pv, source: doc.source, fetchedAt: doc.fetchedAt, empty: true };
      const got = await withBody(doc); if (got) return got;
      console.warn(`[parcels] ${zip}: cached body unreadable — fetching again`);
    }
    try {
      const info = await parcels.fetchZipParcels(zip, geom);
      if (!info) {   // no adapter for this ZIP: OSM hints are all there is, and that is not stale
        if (!doc || !doc.pv) await ParcelCache.updateOne({ zip }, { $set: { source: '', fetchedAt: new Date(), count: 0, parcels: [], blob: '', pv: parcels.PARCEL_VERSION } }, { upsert: true });
        return null;
      }
      console.log(`[parcels] ${zip}: ${info.parcels.length} residential parcels from ${info.source} in ${(info.ms / 1000).toFixed(1)}s${blobs.enabled ? ' → R2' : ''}`);
      await storeBody(ParcelCache, zip, 'parcels', info.parcels, { source: info.source, pv: info.pv, attribution: info.attribution, rollNote: info.rollNote, fetchedAt: new Date(), count: info.parcels.length });
      return { ...info, count: info.parcels.length };
    } catch (e) {
      console.warn(`[parcels] ${zip}: ${e.message}${doc?.count ? ' — using cached parcels' : ''}`);
      return withBody(doc);
    }
  }

  async function fetchAndStore(zip) {
    const t0 = Date.now();
    const geom = osm.zipGeometry(zip);
    if (!geom) throw Object.assign(new Error(`No boundary on file for ZIP ${zip}`), { status: 404 });
    const rings = geo.outerRings(geom);
    // Streets/buildings from OSM and units from the assessor, side by side;
    // a parcel failure never fails the graph (it falls back to OSM hints).
    const [raw, pinfo] = await Promise.all([osm.fetchRaw(rings), getParcels(zip)]);
    const graph = osm.buildGraph(zip, rings, raw, null, geo.polysOf(geom), pinfo);
    // pv records which parcel logic the units came from; 0 means the
    // assessor fetch failed (or there is none), and graphStale retries daily.
    graph.pv = pinfo ? (pinfo.pv || parcels.PARCEL_VERSION) : 0;
    graph.fetchedAt = graph.fetchedAt || new Date().toISOString();
    console.log(`[routes] ${zip}: ${graph.stats.segs} blocks, ${graph.stats.buildings} buildings, ${graph.stats.doors} doors (${graph.stats.unitsSource}) in ${((Date.now() - t0) / 1000).toFixed(1)}s${blobs.enabled ? ' → R2' : ''}`);
    // A graph that could not be stored still serves this request from RAM.
    try { await storeBody(OsmCache, zip, 'graph', graph, { fetchedAt: new Date(), stats: graph.stats, v: graph.v || 1, pv: graph.pv }); }
    catch (e) { console.warn(`[routes] ${zip}: could not store the graph (${e.message}) — serving it from RAM`); }
    return graph;
  }
  function remember(zip, graph, doc = null) {
    if (doc) { graph.fetchedAt = graph.fetchedAt || doc.fetchedAt; graph.v = graph.v || doc.v || 1; if (graph.pv == null) graph.pv = doc.pv || 0; if (doc.fixture) graph.fixture = true; }
    ram.set(zip, graph);
    while (ram.size > RAM_GRAPHS) ram.delete(ram.keys().next().value);
    return graph;
  }

  // Every deploy empties RAM, and a 1–3 MB graph read from the throttled
  // Atlas tier can take many seconds — so warm the cached graphs back into
  // RAM shortly after boot, then quietly pre-fetch the ZIPs the teams have
  // been in over the last two weeks that aren't mapped yet (one at a time,
  // spaced out, so a bad Overpass day costs nothing but log lines).
  async function warmGraphs() {
    try {
      const since = new Date(Date.now() - WARM_DAYS * 864e5);
      const zips = await RoutePlan.distinct('zip', { status: 'active', createdAt: { $gte: since } });
      if (blobs.enabled) console.log(`[blobs] graphs and parcels go to R2 bucket "${blobs.bucket}"`);
      for (const zip of zips.slice(0, RAM_GRAPHS)) { try { await getGraph(zip, { staleOk: true }); } catch {} }
      if (zips.length) console.log(`[routes] ${zips.length} ZIP graphs warm`);
      // Maps from before a rule change rebuild in the background, one at a time.
      const old = await OsmCache.find({ v: { $lt: osm.GRAPH_VERSION }, fixture: { $ne: true } }).select('zip').lean();
      for (const { zip } of old) scheduleRebuild(zip);
      if (old.length) console.log(`[routes] ${old.length} ZIP maps queued to rebuild (v${osm.GRAPH_VERSION})`);
    } catch (e) { console.error('[routes] warm:', e.message); }
    // One-off after R2 is switched on: move the inline bodies over, one at
    // a time (each is a 1–3 MB read from the throttled tier).
    if (blobs.enabled) try {
      // Docs from before the pointer field existed have no `blob` at all.
      const gs = await OsmCache.find({ blob: { $in: ['', null] }, graph: { $ne: null } }).select('zip').lean();
      for (const { zip } of gs) {
        const doc = await OsmCache.findOne({ zip }).lean(); if (!doc?.graph) continue;
        await storeBody(OsmCache, zip, 'graph', doc.graph, { fetchedAt: doc.fetchedAt, stats: doc.stats, v: doc.v || doc.graph.v || 1, pv: doc.pv || 0, fixture: !!doc.fixture });
        await new Promise(r => setTimeout(r, 2000));
      }
      const ps = await ParcelCache.find({ blob: { $in: ['', null] }, count: { $gt: 0 } }).select('zip').lean();
      for (const { zip } of ps) {
        const doc = await ParcelCache.findOne({ zip }).lean(); if (!doc?.parcels?.length) continue;
        await storeBody(ParcelCache, zip, 'parcels', doc.parcels, { source: doc.source, pv: doc.pv || 1, attribution: doc.attribution, rollNote: doc.rollNote, fetchedAt: doc.fetchedAt, count: doc.count });
        await new Promise(r => setTimeout(r, 2000));
      }
      if (gs.length || ps.length) console.log(`[blobs] moved ${gs.length} graphs and ${ps.length} parcel sets to R2`);
    } catch (e) { console.error('[blobs] migrate:', e.message); }
    try {
      if (!doorStore.docs) await warmDoorStore();
      const since = etDaysAgo(14), counts = new Map();
      for (const d of doorStore.docs || []) if (d.date >= since && isAreaId(d.zip || '')) counts.set(d.zip, (counts.get(d.zip) || 0) + 1);
      const wanted = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([z]) => z).filter(z => osm.zipGeometry(z));
      for (const zip of wanted) {
        if (ram.has(zip) || await OsmCache.exists({ zip })) continue;
        try { await fetchAndStore(zip); } catch (e) { console.warn(`[routes] prefetch ${zip}: ${e.message}`); }
        await new Promise(r => setTimeout(r, 30_000));
      }
    } catch (e) { console.error('[routes] prefetch:', e.message); }
  }
  setTimeout(warmGraphs, 45_000);

  // ── What's already worked ────────────────────────────────────────────────
  async function workedIn(zip) {
    if (!doorStore.docs) await warmDoorStore();
    if (!knocksStore.docs) await warmKnocksStore();
    if (!doorStore.docs || !knocksStore.docs)
      throw Object.assign(new Error('Worked-door history is still loading — try again in a minute'), { status: 503 });
    const cutoff = etDaysAgo(ROTATION_DAYS);
    const geom = osm.zipGeometry(zip);
    const rings = geom ? geo.outerRings(geom) : [];
    const bb = rings.length ? geo.bboxOf(rings) : null;
    const worked = [];
    for (const d of doorStore.docs || []) {
      if (d.date < cutoff || d.lat == null) continue;
      // The ZIP a pin carries can be wrong (sector-majority fixes some, not
      // all) — anything geographically inside the boundary counts.
      if (d.zip !== zip) {
        if (!bb || d.lat < bb.s || d.lat > bb.n || d.lng < bb.w || d.lng > bb.e) continue;
        if (!geo.ptInGeometry(d.lat, d.lng, rings)) continue;
      }
      worked.push({ lat: d.lat, lng: d.lng });
    }
    const strokes = (knocksStore.docs || []).filter(k => k.zip === zip && Array.isArray(k.latlngs)).map(k => k.latlngs);
    return { worked, strokes };
  }

  // Blocks in plans made today (Eastern) — see planExpiry above.
  async function reservedIn(zip, excludePlanId) {
    const q = { zip, status: 'active', createdAt: { $gte: new Date(Date.now() - 26 * 3600e3) } };
    if (excludePlanId) q._id = { $ne: excludePlanId };
    const today = etToday();
    const plans = (await RoutePlan.find(q).select('segIds createdAt').lean()).filter(p => etDayKey(p.createdAt) === today);
    return new Set(plans.flatMap(p => p.segIds || []));
  }

  // createdBy goes out as id + name only: every role reads plans, and the
  // creator's email is not theirs to see.
  const publicPlan = (p, { slim = false } = {}) => ({
    id: String(p._id), zip: p.zip, status: p.status, createdAt: p.createdAt, expiresAt: planExpiry(p.createdAt),
    createdBy: { id: p.createdBy?.id || null, name: p.createdBy?.name || '' },
    params: p.params, meeting: p.meeting, need: p.need, patchDoors: p.patchDoors, short: p.short,
    shortReason: p.shortReason || null, nearUsed: p.nearUsed ?? null, meetingName: p.meetingName || null, seedReason: p.seedReason || null,
    stats: p.stats, label: p.label || '', slim,
    // Older plans ship without their geometry — a plan is 15–150 KB with
    // it, and the drawer only draws one at a time.
    routes: (p.routes || []).map(r => { const { segIds, path, steps, ...rest } = r; return slim ? rest : { ...rest, path, steps }; }),
  });

  // ── Endpoints ────────────────────────────────────────────────────────────
  app.get('/api/routes', requireAuth, async (req, res) => {
    try {
      const zip = String(req.query.zip || '');
      if (!isAreaId(zip)) return res.status(400).json({ error: 'zip required' });
      const since = new Date(Date.now() - 3 * 864e5), now = Date.now();
      const plans = (await RoutePlan.find({ zip, status: 'active', createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(24).select('-segIds').lean())
        .filter(p => planExpiry(p.createdAt).getTime() > now).slice(0, 12);
      res.json({ zip, plans: plans.map((p, i) => publicPlan(p, { slim: i > 0 })), rotationDays: ROTATION_DAYS });
    } catch (e) { sec.sendError(res, e, 'routes'); }
  });

  app.get('/api/routes/:id([0-9a-f]{24})', requireAuth, async (req, res) => {
    try {
      const plan = await RoutePlan.findById(req.params.id).select('-segIds').lean();
      if (!plan || plan.status !== 'active') return res.status(404).json({ error: 'Not found' });
      res.json({ plan: publicPlan(plan) });
    } catch (e) { sec.sendError(res, e, 'routes'); }
  });

  // Street/door coverage for a ZIP — cheap once cached, lets the drawer show
  // "N doors mapped · M worked · K free" before anyone generates.
  app.get('/api/routes/coverage', requireAuth, async (req, res) => {
    try {
      const zip = String(req.query.zip || '');
      if (!isAreaId(zip)) return res.status(400).json({ error: 'zip required' });
      if (!ram.has(zip) && !(await OsmCache.exists({ zip }))) return res.json({ zip, mapped: false });
      const graph = await getGraph(zip, { staleOk: true });
      // An old graph (a rule change, a day the assessor was down) is served
      // as is and rebuilt behind the response, so the next open is current.
      if (graphStale(zip, graph)) scheduleRebuild(zip);
      const { worked, strokes } = await workedIn(zip);
      const reserved = await reservedIn(zip);
      const G = routegen.prepare(graph);
      const stats = routegen.applyExclusions(G, { worked, strokes, reserved });
      res.json({ zip, mapped: true, fetchedAt: graph.fetchedAt, graphVersion: graph.v || 1, graphStats: graph.stats, ...stats, reservedBlocks: reserved.size });
    } catch (e) { sec.sendError(res, e, 'routes'); }
  });

  // Generation runs as a background job. The first time in a ZIP the OSM
  // fetch alone can take minutes when the public mirrors are struggling —
  // far longer than a phone keeps a request open — so the POST answers as
  // soon as the plan is ready or after a few seconds with "pending", and
  // the app polls /api/routes/generate/status until it's done.
  const jobs = new Map();   // zip → { startedAt, phase, done, plan, error, by }
  const JOB_TTL_MS = 10 * 60 * 1000;
  // A ZIP not yet in RAM can mean a multi-minute Overpass + assessor fetch.
  // At most ROUTE_COLD_JOBS of those run at once across the board, and one
  // person can start at most ROUTE_JOBS_PER_USER jobs in ten minutes.
  const ROUTE_COLD_JOBS = Math.max(1, +process.env.ROUTE_COLD_JOBS || 2);
  const ROUTE_JOBS_PER_USER = 10;
  let coldJobs = 0;
  const jobsByUser = sec.createRateLimiter({ windowMs: 10 * 60_000, max: ROUTE_JOBS_PER_USER });
  function startJob(zip, req, params) {
    const job = { startedAt: Date.now(), phase: 'starting', done: false, plan: null, error: null, by: req.user.id };
    jobs.set(zip, job);
    (async () => {
      const cold = !ram.has(zip) || !!params.refresh;
      if (cold) coldJobs++;
      try {
        // "osm" only once a live fetch actually starts — a cached ZIP whose
        // graph merely needs reading from Mongo must not promise "a few minutes".
        job.phase = ram.has(zip) && !params.refresh ? 'worked' : 'loading';
        // A cached map from before a rule change is used as it is (it's
        // rebuilt behind the plan); only a ZIP never mapped waits on OSM.
        const graph = await getGraph(zip, { refresh: params.refresh, staleOk: !params.refresh, onFetch: () => { job.phase = 'osm'; } });
        job.phase = 'worked';
        const { worked, strokes } = await workedIn(zip);
        const reserved = await reservedIn(zip);
        job.phase = 'routing';
        const plan = routegen.generate(graph, { worked, strokes, reserved, ...params, lapMaxMin: LAP_MAX_MIN });
        if (plan.lapFallbacks) console.warn(`[routes] ${zip}: ${plan.lapFallbacks} route(s) fell back to the old lap order`);
        const doc = await RoutePlan.create({
          zip, office: req.user.office || '', status: 'active',
          createdBy: { id: req.user.id, name: req.user.name || '', email: req.user.email || '' },
          label: params.label,
          params: plan.params, meeting: plan.meeting, need: plan.need, patchDoors: plan.patchDoors, short: plan.short,
          shortReason: plan.shortReason, nearUsed: plan.nearUsed, meetingName: plan.meetingName, seedReason: plan.seedReason,
          stats: { ...plan.stats, rotationDays: ROTATION_DAYS, strokes: strokes.length, reservedBlocks: reserved.size, graphFetchedAt: graph.fetchedAt, lapMaxMin: plan.lapMaxMin || LAP_MAX_MIN },
          routes: plan.routes, segIds: plan.routes.flatMap(r => r.segIds || []),
        });
        job.plan = publicPlan(doc.toObject());
      } catch (e) {
        console.error(`[routes] ${zip}: ${e.stack || e.message}`);
        // A 4xx (no boundary, nothing left to route…) is for the user; an
        // internal failure gets a generic line, with the detail in the log.
        const status = e.status && e.status < 500 ? e.status : (e.status === 503 ? 503 : 500);
        job.error = { message: status < 500 || status === 503 ? e.message : 'Route generation failed — try again in a few minutes', status, stats: e.stats || null };
      } finally {
        if (cold) coldJobs--;
        job.done = true; job.finishedAt = Date.now();
        setTimeout(() => { if (jobs.get(zip) === job) jobs.delete(zip); }, JOB_TTL_MS);
      }
    })();
    return job;
  }
  const jobView = job => ({
    pending: !job.done, phase: job.phase, startedAt: job.startedAt, elapsedMs: Date.now() - job.startedAt,
    plan: job.plan || undefined, error: job.error?.message || undefined, stats: job.error?.stats || undefined,
  });

  app.post('/api/routes/generate', requireAuth, async (req, res) => {
    const zip = String(req.body?.zip || '');
    if (!isAreaId(zip)) return res.status(400).json({ error: 'zip required' });
    if (!osm.zipGeometry(zip)) return res.status(404).json({ error: `No boundary on file for ZIP ${zip}` });
    const doorsPerPerson = +req.body.doorsPerPerson || 100;
    const pairings = Math.max(0, parseInt(req.body.pairings, 10) || 0);
    const solos    = Math.max(0, parseInt(req.body.solos, 10) || 0);
    if (!pairings && !solos) return res.status(400).json({ error: 'Ask for at least one pairing or solo' });
    const near = Array.isArray(req.body.near) && req.body.near.length === 2 && req.body.near.every(Number.isFinite) ? req.body.near : null;
    if (!near) return res.status(400).json({ error: "Set where you'll park first" });
    const refresh = !!req.body.refreshGraph && req.user.role === 'admin';
    let job = jobs.get(zip);
    if (job && !job.done && job.by !== req.user.id)
      return res.status(409).json({ error: 'Someone else is generating routes in this ZIP right now — give it a minute' });
    if (!job || job.done) {
      if (coldJobs >= ROUTE_COLD_JOBS && (!ram.has(zip) || refresh))
        return res.status(429).json({ error: 'Street maps are being fetched for other ZIPs right now — try again in a couple of minutes' });
      const lim = jobsByUser.hit(req.user.id);
      if (lim.limited) return sec.tooMany(res, lim.retryAfter, 'Too many route requests — wait a few minutes');
    }
    if (!job || job.done) job = startJob(zip, req, { doorsPerPerson, pairings, solos, near, refresh, label: String(req.body.label || '').slice(0, 80) });
    // Give a cached ZIP a moment to finish inline; otherwise hand back the job.
    for (let i = 0; i < 12 && !job.done; i++) await new Promise(r => setTimeout(r, 500));
    if (job.done && job.error) return res.status(job.error.status).json({ error: job.error.message, stats: job.error.stats });
    res.json({ ok: true, ...jobView(job) });
  });

  app.get('/api/routes/generate/status', requireAuth, (req, res) => {
    const zip = String(req.query.zip || '');
    const job = jobs.get(zip);
    if (!job || job.by !== req.user.id) return res.json({ pending: false, none: true });
    res.json(jobView(job));
  });

  app.delete('/api/routes/:id', requireAuth, async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Not found' });
      const plan = await RoutePlan.findById(req.params.id);
      if (!plan || plan.status !== 'active') return res.status(404).json({ error: 'Not found' });
      if (req.user.role === 'sector_leader' && plan.createdBy?.id !== req.user.id)
        return res.status(403).json({ error: 'You can only remove routes you generated' });
      plan.status = 'cancelled';
      await plan.save();
      res.json({ ok: true });
    } catch (e) { sec.sendError(res, e, 'routes'); }
  });

  return { getGraph, RoutePlan, OsmCache, ParcelCache };
};
