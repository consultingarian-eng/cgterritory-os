'use strict';
// Walking-route generator.
//
// Given a ZIP's street graph (lib/osm.js) plus what has already been worked,
// hand out N routes for a team:
//
//   1. Exclude doors worked in the rotation window (worked-door pins), streets
//      marked off by hand (coverage strokes) and streets reserved by a plan
//      generated in the last few days.
//   2. Find the densest free spot in the ZIP and grow a patch outward along
//      the streets until it holds enough doors for everyone.
//   3. Slice the patch like a pie around the meeting point — one slice per
//      route, sized to its door target — so every route starts at the car
//      and the team stays together.
//   4. Order each slice as a LAP: walk out covering the right-hand side of
//      each street, come back covering the other side, and finish across the
//      road from where you started. Doubling every block makes the slice
//      Eulerian, so such a closed tour always exists (Hierholzer).
//
// Everything here is pure: no I/O, no Mongo. server.js feeds it data.

const geo = require('./geo');

const NO_HANDOUT_HW = new Set(['primary', 'trunk', 'secondary', 'primary_link', 'trunk_link', 'secondary_link']);   // main roads: walkable connectors, but nobody's route
const PIN_TO_SEG_M    = 40;   // a worked pin counts against the block within this distance
const PIN_TO_DOOR_M   = 22;   // ...and marks the specific house within this distance
const STROKE_TO_SEG_M = 35;   // a hand-drawn stroke marks off blocks within this distance
// Time in the field — a planning model for a "3-lap field day" (the same
// territory worked three times a day). The defaults below are illustrative
// planning assumptions, not measurements: seconds waiting after a knock,
// an intro when someone answers, minutes for a pitch, the close and a
// signup, and per lap the share of doors knocked / answering / pitched /
// closed / signed. Tune them to your own field data in config/territory.json
// under "routePlanning" (same shape as FIELD). Walking comes from the
// route's own metres rather than a flat per-door figure, so spread-out
// streets cost what they really cost — and they are walked on every lap.
const FIELD = Object.assign({
  waitS: 12, introS: 20, pitchMin: 2, closeMin: 5, signupMin: 12,
  laps: [
    { knock: 1.00, answer: 0.20, pitch: 0.05, close: 0.03, signup: 0.01 },
    { knock: 0.80, answer: 0.15, pitch: 0.05, close: 0.03, signup: 0.01 },
    { knock: 0.65, answer: 0.10, pitch: 0.05, close: 0.03, signup: 0.02 },
  ],
}, require('./settings').settings.routePlanning || {});
// Minutes at the door per door of territory, lap by lap.
const DOOR_MIN = FIELD.laps.map(l => l.knock * FIELD.waitS / 60 + l.answer * FIELD.introS / 60 + l.pitch * FIELD.pitchMin + l.close * FIELD.closeMin + l.signup * FIELD.signupMin);
const WALK_M_PER_MIN  = 75;   // 4.5 km/h, street crossings included
const APPROACH_S      = 10;   // up the path to the porch and back, per house visited
const LAP_MAX_MIN     = 120;  // three laps have to fit a 5.5–6 hour day
// One lap's minutes for one person. A pair walks the lap together and
// splits the houses between them.
function lapMinutes(lenM, buildings, doors, people = 1) {
  const walk = lenM / WALK_M_PER_MIN;
  return FIELD.laps.map((l, k) => walk + (buildings * l.knock * APPROACH_S / 60 + doors * DOOR_MIN[k]) / (people || 1));
}

const ang = (dx, dy) => Math.atan2(dy, dx);
// A door is a building; it carries `u` dwelling units (absent = 1). Routes
// are sized in units — a triple-decker is three knocks on one porch.
const U   = d  => d.u || 1;
const cnt = ds => ds.reduce((n, d) => n + U(d), 0);
// Buildings of 5+ units are not knocked (field rule): a route is
// houses, two-families, triple-deckers and 4-unit buildings. `big` marks a
// block whose count was unknown or above the unit cap — also out.
const MAX_UNITS = 4;
const tooBig = d => d.big || U(d) > MAX_UNITS;

function prepare(graph) {
  const P = geo.projector(graph.origin[0], graph.origin[1]);
  const nodeXY = {};
  for (const [id, [lat, lng]] of Object.entries(graph.nodes)) nodeXY[id] = P.toXY(lat, lng);
  const segs = graph.segs.map((s, i) => {
    const xy = s.coords.map(([la, ln]) => P.toXY(la, ln));
    let mx = 0, my = 0; for (const p of xy) { mx += p.x; my += p.y; }
    return {
      ...s, i, xy, mid: { x: mx / xy.length, y: my / xy.length },
      doors: s.doors.filter(d => !tooBig(d)).map(d => ({ ...d, xy: P.toXY(d.lat, d.lng), workedU: 0 })),
      bigSkipped: s.doors.filter(tooBig).length,
      workedPins: 0, sidePins: { 1: 0, '-1': 0 }, worked: false, reserved: false,
    };
  });
  const byId = new Map(segs.map(s => [s.id, s]));
  const adj = {};
  for (const s of segs) { (adj[s.a] ||= []).push(s); (adj[s.b] ||= []).push(s); }
  // Piece grid for nearest-block queries
  const pieces = new geo.Grid(80);
  for (const s of segs) for (let k = 1; k < s.xy.length; k++)
    pieces.add((s.xy[k - 1].x + s.xy[k].x) / 2, (s.xy[k - 1].y + s.xy[k].y) / 2, { s, a: s.xy[k - 1], b: s.xy[k] });
  const nearestSeg = (p, maxM) => {
    let best = null;
    for (const it of pieces.near(p.x, p.y, maxM + 60)) {
      const pr = geo.projectToSegment(p, it.a, it.b);
      if (pr.d <= maxM && (!best || pr.d < best.d)) best = { d: pr.d, s: it.s, side: (it.b.x - it.a.x) * (p.y - it.a.y) - (it.b.y - it.a.y) * (p.x - it.a.x) > 0 ? 1 : -1 };
    }
    return best;
  };
  const G = { P, nodeXY, segs, byId, adj, nearestSeg, bizKnown: !!graph.bizKnown };
  // A block (corner to corner) that's mostly 5+-unit buildings isn't a route
  // at all: its few small houses would cost a walk past the big ones. One big
  // building on an ordinary street is just skipped on its own (above).
  {
    const { blocks } = cornerBlocks(G);
    for (const run of blocks) {
      let big = 0, small = 0;
      for (const s of run) { big += s.bigSkipped + (s.bigB || 0); small += s.doors.length; }
      if (big >= 2 && big >= small) for (const s of run) { s.bigSkipped += s.doors.length; s.aptBlock = true; s.doors = []; }
    }
  }
  // Main roads are handed out block by block (field rule): a stretch
  // lined with houses is a route like any other, one mixed with shops isn't.
  // Businesses are the commercial/industrial lots the assessor lists along
  // it, a shop-with-flats counts as half. Maps built before that count was
  // kept keep main roads out altogether.
  if (G.bizKnown) {
    const { blocks } = cornerBlocks(G);
    for (const run of blocks) {
      if (!run.some(s => NO_HANDOUT_HW.has(s.hw))) continue;
      let homes = 0, mixed = 0, biz = 0;
      for (const s of run) { homes += s.doors.length; mixed += s.doors.filter(d => d.mx).length; biz += s.biz || 0; }
      const ok = homes >= 2 && (biz + 0.5 * mixed) <= 0.3 * (homes + biz);
      for (const s of run) s.mainOk = ok;
    }
  }
  return G;
}
// Off limits as a route: a main road, unless its block is a block of houses.
const offLimits = s => NO_HANDOUT_HW.has(s.hw) && !s.mainOk;

// ── 1. Exclusions ────────────────────────────────────────────────────────────
function applyExclusions(G, { worked = [], strokes = [], reserved = new Set() }) {
  const doorGrid = new geo.Grid(50);
  for (const s of G.segs) for (const d of s.doors) doorGrid.add(d.xy.x, d.xy.y, d);

  let matchedPins = 0;
  for (const w of worked) {
    if (w.lat == null || w.lng == null) continue;
    const p = G.P.toXY(w.lat, w.lng);
    const ns = G.nearestSeg(p, PIN_TO_SEG_M);
    if (!ns) continue;
    matchedPins++;
    // Each pin fills one unit of the nearest building that still has one
    // open — three pins at one geocoded triple-decker fill it 3/3.
    let bd = null, bdd = PIN_TO_DOOR_M;
    for (const d of doorGrid.near(p.x, p.y, PIN_TO_DOOR_M)) {
      const dd = Math.hypot(d.xy.x - p.x, d.xy.y - p.y);
      if (dd <= bdd) { bd = d; bdd = dd; }
    }
    // The block rule counts buildings, not pins: three pins at one
    // triple-decker are one building pinned. A fourth pin on a full
    // building is a same-day re-log, not the neighbour's house.
    const side = bd ? bd.side : ns.side;
    if (bd) { if (bd.workedU >= U(bd)) continue; if (!bd.workedU) { ns.s.workedPins++; ns.s.sidePins[side]++; } bd.workedU++; }
    else { ns.s.workedPins++; ns.s.sidePins[side]++; }
  }
  for (const s of G.segs) {
    // A side of a block with a real share of its doors pinned was walked; the
    // rest of that side are no-answers or geocoder misses, not fresh
    // territory. Each side is judged on its own: a team that did one side of
    // a street left the other side's doors for someone else.
    s.workedSides = new Set();
    for (const side of [1, -1]) {
      const n = s.doors.filter(d => d.side === side).length;
      if (n && s.sidePins[side] >= Math.max(2, Math.ceil(0.3 * n))) s.workedSides.add(side);
    }
    const sidesWithDoors = new Set(s.doors.map(d => d.side));
    if (sidesWithDoors.size && [...sidesWithDoors].every(sd => s.workedSides.has(sd))) s.worked = true;
    if (!s.doors.length && s.workedPins > 0) s.worked = true;
  }
  // A stroke marks the blocks it runs along, not the cross streets it
  // passes: a block counts as marked off once ≥40 m (or 40% of its length)
  // of stroke lies beside it.
  const strokeM = new Map();
  for (const line of strokes) {
    if (!Array.isArray(line) || line.length < 2) continue;
    for (let i = 1; i < line.length; i++) {
      const a = G.P.toXY(line[i - 1][0], line[i - 1][1]), b = G.P.toXY(line[i][0], line[i][1]);
      const L = Math.hypot(b.x - a.x, b.y - a.y), steps = Math.max(1, Math.ceil(L / 12)), step = L / steps;
      for (let k = 0; k <= steps; k++) {
        const p = { x: a.x + (b.x - a.x) * k / steps, y: a.y + (b.y - a.y) * k / steps };
        const ns = G.nearestSeg(p, STROKE_TO_SEG_M);
        if (ns) strokeM.set(ns.s.id, (strokeM.get(ns.s.id) || 0) + step);
      }
    }
  }
  let strokeHits = 0;
  for (const s of G.segs) {
    const m = strokeM.get(s.id) || 0;
    if (m >= Math.min(40, 0.4 * Math.max(s.len, 1)) && !s.worked) { s.worked = true; strokeHits++; }
  }
  for (const s of G.segs) if (reserved.has(s.id)) s.reserved = true;

  let total = 0, workedDoors = 0, free = 0, buildings = 0;
  for (const s of G.segs) {
    // avail entries carry the units still open on that building
    s.avail = (s.worked || s.reserved || offLimits(s)) ? [] : s.doors.filter(d => d.workedU < U(d) && !s.workedSides.has(d.side)).map(d => ({ ...d, u: U(d) - d.workedU }));
    total += cnt(s.doors); buildings += s.doors.length;
    workedDoors += s.worked ? cnt(s.doors) : s.doors.reduce((n, d) => n + (s.workedSides.has(d.side) ? U(d) : d.workedU), 0);
    free += cnt(s.avail);
  }
  return { totalDoors: total, buildings, workedDoors, freeDoors: free, matchedPins, strokeBlocks: strokeHits, bigSkipped: G.segs.reduce((n, s) => n + (s.bigSkipped || 0), 0), maxUnits: MAX_UNITS };
}

// ── 2. Seed + patch ──────────────────────────────────────────────────────────
function pickSeed(G, need, near) {
  const r = 150 + 12 * Math.sqrt(need);
  const midGrid = new geo.Grid(100);
  for (const s of G.segs) if (s.avail.length) midGrid.add(s.mid.x, s.mid.y, s);
  const score = p => {
    let n = 0;
    for (const s of midGrid.near(p.x, p.y, r)) if (Math.hypot(s.mid.x - p.x, s.mid.y - p.y) <= r) n += cnt(s.avail);
    return n;
  };
  // A tapped spot is where the car will be: meet at the closest corner that
  // has free doors around it.
  const nearXY = near ? G.P.toXY(near[0], near[1]) : null;
  let bestLocal = null, bestLocalD = 350;
  const scored = [];
  for (const [id, p] of Object.entries(G.nodeXY)) {
    if (!(G.adj[id] || []).some(s => s.avail.length)) continue;
    const sc = score(p);
    if (nearXY) {
      const d = Math.hypot(p.x - nearXY.x, p.y - nearXY.y);
      if (d <= bestLocalD && sc >= need * 0.15) { bestLocal = id; bestLocalD = d; }
    }
    if (sc > 0) scored.push({ id, p, sc });
  }
  if (bestLocal) return { id: bestLocal, nearUsed: true, reason: 'tapped' };
  // Otherwise: of the densest-looking corners (as the crow flies), keep the
  // one whose patch grown along the streets reaches the target soonest —
  // a river, railway or worked-out estate makes those two very different.
  scored.sort((x, y) => y.sc - x.sc);
  const cands = [];
  for (const c of scored) {
    if (cands.length >= 24) break;
    if (cands.every(o => Math.hypot(o.p.x - c.p.x, o.p.y - c.p.y) >= 150)) cands.push(c);
  }
  // …plus the outer corners of the free area, one per compass point: the
  // densest corners are always mid-territory, and a fresh ZIP (nothing
  // worked yet) has no worked edge to start from — so work in from its
  // edge (the water, the ZIP line), not out from its middle.
  const withSc = scored.filter(c => c.sc >= need * 0.15), outer = new Set();
  for (let k = 0; k < 16; k++) {
    const ax = Math.cos(k * Math.PI / 8), ay = Math.sin(k * Math.PI / 8);
    let best = null;
    for (const c of withSc) if (!best || c.p.x * ax + c.p.y * ay > best.p.x * ax + best.p.y * ay) best = c;
    if (!best) continue;
    outer.add(best.id);
    if (cands.every(o => Math.hypot(o.p.x - best.p.x, o.p.y - best.p.y) >= 150)) cands.push(best);
  }
  // Fresh territory: almost nothing worked in the rotation, so there is no
  // worked edge to grow from.
  let doorsAll = 0, doorsWorked = 0;
  for (const s of G.segs) { if (offLimits(s)) continue; const n = cnt(s.doors); doorsAll += n; doorsWorked += n - cnt(s.avail); }   // main roads are nobody's
  const fresh = doorsAll > 0 && doorsWorked / doorsAll < 0.05;
  // ...and, among spots that are about as tight, the one that works from
  // the edge: a patch whose border mostly touches streets already done, the
  // ZIP line or dead ends extends the worked area; one whose border is all
  // fresh streets is an island that leaves strips around it for later.
  const evals = [];
  for (const c of cands) {
    const { dist } = dijkstra(G, [c.id]);
    const ranked = G.segs.filter(s => s.avail.length && dist.has(s.a))
      .map(s => ({ s, d: Math.min(dist.get(s.a), dist.get(s.b)) + s.len / 2 }))
      .sort((x, y) => x.d - y.d);
    let got = 0, reach = Infinity;
    const patch = new Set();
    for (const r of ranked) { patch.add(r.s.id); got += cnt(r.s.avail); if (got >= need) { reach = r.d; break; } }
    let freeEdge = 0, doneEdge = 0;
    for (const id of patch) {
      const s = G.byId.get(id);
      for (const node of [s.a, s.b]) {
        const around = (G.adj[node] || []).filter(n => n !== s);
        if (!around.length) { doneEdge++; continue; }               // dead end / ZIP line
        for (const n of around) { if (patch.has(n.id)) continue; if (n.avail.length) freeEdge++; else doneEdge++; }
      }
    }
    evals.push({ id: c.id, reach, got, freeRatio: (freeEdge + doneEdge) ? freeEdge / (freeEdge + doneEdge) : 1 });
  }
  if (!evals.length) return null;
  const reachable = evals.filter(e => e.reach < Infinity);
  if (!reachable.length) return { id: evals.sort((x, y) => y.got - x.got)[0].id, nearUsed: false, reason: 'scattered' };
  const tightest = Math.min(...reachable.map(e => e.reach));
  // A fresh ZIP is worked in from its outer edge (field rule: edge to edge, so
  // the ZIP gets worked tightly over the days): only the outer corners
  // compete, the most edge-hugging wins even if it fills more slowly — the
  // lap cap keeps the walking in check. Otherwise, within 15% of the
  // tightest, the spot hugging the worked edge wins.
  // Of the outer corners that really sit on an edge, the one with the
  // most houses close by (fills up soonest) — a thin industrial or park
  // edge would cost doors in a two-hour lap.
  const outerOk = fresh ? reachable.filter(e => outer.has(e.id) && e.freeRatio < 0.5 && e.reach <= tightest * 5) : [];
  const pick = outerOk.length
    ? outerOk.sort((x, y) => x.reach - y.reach)[0]
    : reachable.filter(e => e.reach <= tightest * 1.15).sort((x, y) => x.freeRatio - y.freeRatio || x.reach - y.reach)[0];
  return { id: pick.id, nearUsed: false, reason: pick.freeRatio < 0.5 ? 'edge' : 'open', freeRatio: +pick.freeRatio.toFixed(2) };
}

function dijkstra(G, sources) {
  const dist = new Map(), prev = new Map(), h = new geo.MinHeap();
  for (const s of sources) { dist.set(s, 0); h.push(0, s); }
  while (h.size) {
    const { k, v } = h.pop();
    if (k > dist.get(v)) continue;
    for (const s of G.adj[v] || []) {
      const u = s.a === v ? s.b : s.a, nd = k + s.len;
      if (nd < (dist.get(u) ?? Infinity)) { dist.set(u, nd); prev.set(u, { via: s, from: v }); h.push(nd, u); }
    }
  }
  return { dist, prev };
}

function growPatch(G, seed, need) {
  const { dist } = dijkstra(G, [seed]);
  const ranked = G.segs
    .filter(s => s.avail.length && dist.has(s.a))
    .map(s => ({ s, d: Math.min(dist.get(s.a), dist.get(s.b)) + s.len / 2 }))
    .sort((x, y) => x.d - y.d);
  const patch = []; let got = 0;
  for (const { s } of ranked) { patch.push(s); got += cnt(s.avail); if (got >= need * 1.08) break; }
  return { patch, got, dist };
}

// ── 3. Slices ────────────────────────────────────────────────────────────────
// Every route grows at the same time, block by adjacent block, from a start
// near the car. Each route prefers its own wedge of the compass (a pie cut
// around the meeting point, sized to its door target), so the team fans out
// from the car — but growth only ever crosses a shared corner, so a route is
// one connected walk by construction and bends around a main road or a park
// instead of leaping over it.
function slicePatch(G, patch, seed, specs, patchTotal, dist) {
  const c = G.nodeXY[seed];
  const angleOf = s => ang(s.mid.x - c.x, s.mid.y - c.y);
  const angDiff = (a, b) => { const d = Math.abs(a - b) % (2 * Math.PI); return d > Math.PI ? 2 * Math.PI - d : d; };

  // Wedges: sweep the patch by angle from the widest gap, cut at cumulative targets.
  const items = patch.map(s => ({ s, a: angleOf(s) })).sort((x, y) => x.a - y.a);
  let gapAt = 0, gapMax = -1;
  for (let i = 0; i < items.length; i++) {
    const a1 = items[i].a, a2 = i + 1 < items.length ? items[i + 1].a : items[0].a + 2 * Math.PI;
    if (a2 - a1 > gapMax) { gapMax = a2 - a1; gapAt = i + 1; }
  }
  const order = items.slice(gapAt).concat(items.slice(0, gapAt));
  const need = specs.reduce((n, s) => n + s.target, 0);
  const scale = patchTotal / need;
  const wedge = specs.map(() => []);
  let k = 0, cum = 0, boundary = specs[0].target * scale;
  for (const it of order) {
    if (k < specs.length - 1 && cum >= boundary) { k++; boundary += specs[k].target * scale; }
    wedge[k].push(it); cum += cnt(it.s.avail);
  }
  const centre = wedge.map((w, i) => {
    if (!w.length) return (2 * Math.PI * i) / specs.length;
    let x = 0, y = 0; for (const it of w) { x += Math.cos(it.a); y += Math.sin(it.a); }
    return Math.atan2(y, x);
  });

  // Grow, taking turns: the route furthest behind its target adds its best
  // block next, so nobody boxes the others in. Nearness to the car comes
  // first (routes fill outward edge to edge, no pockets left behind); the
  // wedge heading only decides which route a block belongs to — 1 rad off
  // costs like 70 m of extra distance.
  const seedDist = s => Math.min(dist.get(s.a) ?? Infinity, dist.get(s.b) ?? Infinity);
  // Deadwalk a block would add to the lap: a side with nothing to knock is
  // walked for nothing on one of the two passes, and a long block with two
  // houses is mostly walking. Half a metre of cost per metre of deadwalk.
  const deadOf = s => {
    const L = cnt(s.avail.filter(d => d.side === 1)), R = cnt(s.avail.filter(d => d.side === -1));
    return (L ? 0 : s.len) + (R ? 0 : s.len) + Math.max(0, s.len * 2 - 30 * (L + R));
  };
  const prio = (i, s) => angDiff(angleOf(s), centre[i]) * 70 + seedDist(s) + 0.2 * deadOf(s);
  const assigned = new Map();
  const slices = specs.map(() => []);
  const doors = specs.map(() => 0);
  const frontier = specs.map(() => new geo.MinHeap());
  const done = specs.map(() => false);
  // A route may grow through a short door-less stretch (a main road, a
  // worked or empty block) to reach the free streets beyond it — those
  // blocks join the route as walk-throughs.
  const THROUGH_MAX_M = 250;
  const take = (i, s, via = []) => {
    for (const c of via) if (!slices[i].includes(c)) slices[i].push(c);
    assigned.set(s.id, i); if (!slices[i].includes(s)) slices[i].push(s); doors[i] += cnt(s.avail);
    const seen = new Set([s.id]);
    const q = [{ node: s.a, via: [], len: 0 }, { node: s.b, via: [], len: 0 }];
    while (q.length) {
      const { node, via: path, len } = q.shift();
      for (const n of G.adj[node] || []) {
        if (seen.has(n.id)) continue; seen.add(n.id);
        if (!isFinite(seedDist(n))) continue;
        // Walking past worked streets to reach a block costs 1.5× its length,
        // so contiguous free streets win when there's a choice.
        if (n.avail.length) { if (!assigned.has(n.id)) frontier[i].push(prio(i, n) + 2 * len, { s: n, via: path }); }
        else if (len + n.len <= THROUGH_MAX_M) q.push({ node: n.a === node ? n.b : n.a, via: path.concat(n), len: len + n.len });
      }
    }
  };
  specs.forEach((_, i) => {
    const pool = wedge[i].length ? wedge[i].map(it => it.s) : patch;
    let start = null, sd = Infinity;
    for (const s of pool) { if (assigned.has(s.id)) continue; const d = seedDist(s); if (d < sd) { sd = d; start = s; } }
    if (start) take(i, start); else done[i] = true;
  });
  // Boxed in early: jump to the nearest free block within a short walk of
  // the route, measured along the streets (connect() bridges the gap as a
  // walk-through). A couple of jumps at most — beyond that the route is
  // better off short than scattered.
  const RESEED_MAX_M = 250, reseeds = specs.map(() => 0);
  const reseed = i => {
    if (doors[i] >= specs[i].target * 0.85 || reseeds[i] >= 2) return false;
    const { dist: d } = dijkstra(G, [...new Set(slices[i].flatMap(s => [s.a, s.b]))]);
    let best = null, bd = RESEED_MAX_M;
    for (const s of G.segs) {
      if (assigned.has(s.id) || !s.avail.length) continue;
      const dd = Math.min(d.get(s.a) ?? Infinity, d.get(s.b) ?? Infinity);
      if (dd < bd) { bd = dd; best = s; }
    }
    if (!best) return false;
    reseeds[i]++; take(i, best); return true;
  };
  // Boxed in by a neighbour: take one of its blocks that touches us and let
  // the neighbour regrow outward — the way you'd redraw the boundary by
  // hand. If that block was holding a tail of the neighbour together (a
  // chain through a cul-de-sac estate), the tail comes with it, so the
  // neighbour stays one walk.
  const steals = specs.map(() => 0);
  const steal = i => {
    if (doors[i] >= specs[i].target * 0.85 || steals[i] >= 40) return false;
    const mine = new Set(slices[i].flatMap(s => [s.a, s.b]));
    let best = null, bj = -1, bp = Infinity, bundle = null;
    specs.forEach((sp, j) => {
      if (j === i || doors[j] < sp.target * 0.6) return;
      for (const s of slices[j]) {
        if (!s.avail.length) continue;                        // a walk-through is nobody's to steal
        if (!(mine.has(s.a) || mine.has(s.b))) continue;
        const p = prio(i, s);
        if (p >= bp) continue;
        // What leaves j: the block plus the pieces that hang off it (the
        // biggest remaining piece stays; pieces detached earlier by a reseed
        // are j's own business).
        const rest = components(slices[j].filter(x => x !== s)).sort((x, y) => doorsIn(y) - doorsIn(x));
        const hangs = piece => piece.some(x => x.a === s.a || x.b === s.a || x.a === s.b || x.b === s.b);
        const moving = [s].concat(rest.slice(1).filter(hangs).flat());
        const lost = moving.reduce((n, x) => n + cnt(x.avail), 0);
        if (slices[j].length - moving.length < 1 || doors[j] - lost < sp.target * 0.5) continue;
        bp = p; best = s; bj = j; bundle = moving;
      }
    });
    if (!best) return false;
    const ids = new Set(bundle.map(x => x.id));
    slices[bj] = slices[bj].filter(x => !ids.has(x.id));
    doors[bj] -= bundle.reduce((n, x) => n + cnt(x.avail), 0); done[bj] = false;
    for (const x of bundle) assigned.delete(x.id);
    steals[i]++;
    take(i, best, bundle.filter(x => x !== best && !x.avail.length));
    for (const x of bundle) if (x !== best && x.avail.length) take(i, x);
    return true;
  };
  // Rounds: a route boxed in early gets another go once its neighbours have
  // grown enough to give up an edge block.
  for (let round = 0; round < 4; round++) {
    specs.forEach((sp, k) => { done[k] = doors[k] >= sp.target; });
    let progress = false;
    for (let guard = 0; guard < 20000; guard++) {
      let i = -1, ratio = Infinity;
      specs.forEach((sp, k) => { if (!done[k]) { const r = doors[k] / sp.target; if (r < ratio) { ratio = r; i = k; } } });
      if (i < 0) break;
      if (doors[i] >= specs[i].target) { done[i] = true; continue; }
      let next = null;
      while (frontier[i].size) { const c = frontier[i].pop().v; if (!assigned.has(c.s.id)) { next = c; break; } }
      if (next) { take(i, next.s, next.via); progress = true; }
      else if (reseed(i) || steal(i)) progress = true;
      else done[i] = true;
    }
    if (!progress || specs.every((sp, k) => doors[k] >= sp.target * 0.85)) break;
  }

  // A route that ended under half its target was boxed in from the start.
  // Give it back to the pool and regrow it from the free block nearest the
  // car, then run the growth loop once more.
  let regrew = false;
  specs.forEach((sp, i) => {
    if (doors[i] >= sp.target * 0.5) return;
    for (const s of slices[i]) assigned.delete(s.id);
    slices[i] = []; doors[i] = 0; frontier[i] = new geo.MinHeap(); reseeds[i] = 0; steals[i] = 0;
    // Start where there is room to grow: among the free blocks nearest the
    // car, the one with the most free doors reachable within ~350 m of
    // free streets — not a lone stub.
    const cands = G.segs.filter(s => !assigned.has(s.id) && s.avail.length && isFinite(seedDist(s)))
      .sort((x, y) => seedDist(x) - seedDist(y)).slice(0, 40);
    let start = null, bestScore = -Infinity;
    for (const c of cands) {
      const seen = new Set([c.id]); const q = [{ s: c, d: 0 }]; let mass = 0;
      while (q.length) {
        const { s: cur, d } = q.shift(); mass += cnt(cur.avail);
        for (const node of [cur.a, cur.b]) for (const n of G.adj[node] || []) {
          if (seen.has(n.id) || assigned.has(n.id) || !n.avail.length || d + n.len > 350) continue;
          seen.add(n.id); q.push({ s: n, d: d + n.len });
        }
      }
      const score = Math.min(mass, sp.target) - seedDist(c) / 20;
      if (score > bestScore) { bestScore = score; start = c; }
    }
    if (start) { take(i, start); regrew = true; }
  });
  if (regrew) {
    specs.forEach((sp, k) => { done[k] = doors[k] >= sp.target; });
    for (let guard = 0; guard < 20000; guard++) {
      let i = -1, ratio = Infinity;
      specs.forEach((sp, k) => { if (!done[k]) { const r = doors[k] / sp.target; if (r < ratio) { ratio = r; i = k; } } });
      if (i < 0) break;
      if (doors[i] >= specs[i].target) { done[i] = true; continue; }
      let next = null;
      while (frontier[i].size) { const c = frontier[i].pop().v; if (!assigned.has(c.s.id)) { next = c; break; } }
      if (next) take(i, next.s, next.via);
      else if (!reseed(i) && !steal(i)) done[i] = true;
    }
  }

  // Shed overshoot, close the pockets, then shed again from the outside —
  // with the pocket blocks protected, so the fill isn't undone.
  trimSlices(slices, specs, dist, assigned);
  slices.forEach((sl, i) => { doors[i] = doorsIn(sl); });   // the trim changed the counts

  // No spots left behind: a small group of free blocks hemmed in by the
  // routes (and worked streets) joins the touching route that is furthest
  // under target, even a little over — nobody comes back for six houses.
  for (let pass = 0; pass < 6; pass++) {
    let moved = false;
    const free = G.segs.filter(s => !assigned.has(s.id) && s.avail.length && isFinite(seedDist(s)));
    for (const group of components(free)) {
      const nodes = new Set(group.flatMap(s => [s.a, s.b]));
      const touching = new Set();
      for (const node of nodes) for (const n of G.adj[node] || []) if (assigned.has(n.id)) touching.add(assigned.get(n.id));
      if (!touching.size) continue;
      const gd = doorsIn(group);
      let best = -1, ratio = Infinity;
      for (const i of touching) {
        if (gd > Math.max(15, 0.2 * specs[i].target)) continue;   // that's open territory, not a pocket
        const r = (doors[i] + gd) / specs[i].target;
        if (r < ratio) { ratio = r; best = i; }
      }
      // Up to 15% over target: measured across 9 ZIPs, that halves the stubs
      // left behind while keeping the median route at 103% of its target.
      if (best < 0 || ratio > 1.15) continue;
      for (const s of group) { assigned.set(s.id, best); slices[best].push(s); }
      doors[best] += gd; moved = true;
    }
    if (!moved) break;
  }
  return slices;
}

const doorsIn = sl => sl.reduce((t, s) => t + cnt(s.avail), 0);

// The free streets nobody has, in connected groups, each marked `hemmed` when
// no other free street is within POCKET_REACH_M (walking through worked,
// empty or taken streets): a dead-end pocket, like the top of a road that
// ends at a park.
const POCKET_REACH_M = 250;
function freeGroups(G, isFree) {
  const groups = components(G.segs.filter(isFree)).map(g => ({ segs: g, doors: doorsIn(g), hemmed: true }));
  const groupOf = new Map(); groups.forEach(gr => gr.segs.forEach(s => groupOf.set(s.id, gr)));
  for (const gr of groups) {
    const seen = new Set(gr.segs.map(s => s.id));
    const q = [...new Set(gr.segs.flatMap(s => [s.a, s.b]))].map(n => ({ n, d: 0 }));
    while (q.length && gr.hemmed) {
      const { n, d } = q.shift();
      for (const o of G.adj[n] || []) {
        if (seen.has(o.id)) continue; seen.add(o.id);
        if (groupOf.has(o.id)) { gr.hemmed = false; break; }
        if (d + o.len <= POCKET_REACH_M) q.push({ n: o.a === n ? o.b : o.a, d: d + o.len });
      }
    }
  }
  return { groups, groupOf };
}

// Shed overshoot from the outside in, but only leaf blocks — removing one
// never splits the walk. A door-less leaf (a walk-through into nothing) goes
// whatever the count.
function trimSlices(slices, specs, dist, assigned, keep = new Set()) {
  slices.forEach((sl, i) => {
    const target = specs[i].target;
    let n = doorsIn(sl);
    for (let guard = 0; guard < 300 && sl.length > 1; guard++) {
      const deg = {};
      for (const s of sl) { deg[s.a] = (deg[s.a] || 0) + 1; deg[s.b] = (deg[s.b] || 0) + 1; }
      const leaves = sl.filter(s => (deg[s.a] === 1 || deg[s.b] === 1) && !keep.has(s.id));
      // the leaf that costs the most walking per door goes first
      const perDoor = s => { const L = cnt(s.avail.filter(d => d.side === 1)), R = cnt(s.avail.filter(d => d.side === -1)); return ((L ? 0 : s.len) + (R ? 0 : s.len) + s.len * 2) / Math.max(1, L + R); };
      leaves.sort((x, y) => perDoor(y) - perDoor(x) || Math.max(dist.get(y.a), dist.get(y.b)) - Math.max(dist.get(x.a), dist.get(x.b)));
      const leaf = leaves.find(l => !l.avail.length) || leaves.find(l => n - cnt(l.avail) >= target);
      if (!leaf) break;
      sl.splice(sl.indexOf(leaf), 1); n -= cnt(leaf.avail);
      if (assigned) assigned.delete(leaf.id);
    }
  });
}

// ── 4. The lap ───────────────────────────────────────────────────────────────
function components(segs) {
  const parent = new Map();
  const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (const s of segs) { parent.set(s.a, s.a); parent.set(s.b, s.b); }
  for (const s of segs) parent.set(find(s.a), find(s.b));
  const groups = new Map();
  for (const s of segs) { const r = find(s.a); (groups.get(r) || groups.set(r, []).get(r)).push(s); }
  return [...groups.values()];
}

function connect(G, segs, seedDist) {
  // Bridge disconnected pieces with the shortest street path through the ZIP.
  const inRoute = new Set(segs.map(s => s.id));
  const transit = [];
  let comps = components(segs);
  let guard = 0;
  while (comps.length > 1 && guard++ < 50) {
    comps.sort((x, y) => Math.min(...x.map(s => Math.min(seedDist.get(s.a) ?? 1e9, seedDist.get(s.b) ?? 1e9))) - Math.min(...y.map(s => Math.min(seedDist.get(s.a) ?? 1e9, seedDist.get(s.b) ?? 1e9))));
    const main = comps[0];
    const mainNodes = new Set(main.flatMap(s => [s.a, s.b]));
    const otherNodes = new Map();
    comps.slice(1).forEach((c, ci) => c.forEach(s => { otherNodes.set(s.a, ci); otherNodes.set(s.b, ci); }));
    const { dist, prev } = dijkstra(G, [...mainNodes]);
    let best = null;
    for (const [n] of otherNodes) if (dist.has(n) && (!best || dist.get(n) < dist.get(best))) best = n;
    if (!best) break;   // unreachable (island) — drop the rest
    let n = best;
    while (!mainNodes.has(n)) { const p = prev.get(n); if (!p) break; if (!inRoute.has(p.via.id)) { inRoute.add(p.via.id); transit.push(p.via); } n = p.from; }
    comps = components(segs.concat(transit));
  }
  if (comps.length > 1) {   // islands: keep only the main component
    comps.sort((x, y) => y.length - x.length);
    const keep = new Set(comps[0].map(s => s.id));
    return { segs: segs.filter(s => keep.has(s.id)), transit: transit.filter(s => keep.has(s.id)) };
  }
  return { segs, transit };
}

// A street is stored in pieces of at most 120 m, so one block between two
// corners can be two or three pieces. Routes are handed whole blocks, corner
// to corner — a lap that turns back in the middle of a block leaves its
// other half to someone else, or to nobody. blockOf maps each piece to the
// run of pieces between two real corners (nodes that aren't just a join).
function cornerBlocks(G) {
  const blockOf = new Map(), blocks = [];
  const deg = n => (G.adj[n] || []).length;
  for (const s of G.segs) {
    if (blockOf.has(s)) continue;
    const run = [s], id = blocks.length;
    blockOf.set(s, id);
    for (const start of [s.a, s.b]) {
      let prev = s, n = start;
      while (deg(n) === 2) {
        const next = G.adj[n].find(o => o !== prev);
        if (!next || blockOf.has(next)) break;
        blockOf.set(next, id); run.push(next);
        n = next.a === n ? next.b : next.a; prev = next;
      }
    }
    blocks.push(run);
  }
  return { blockOf, blocks };
}
// Each block goes whole to the route holding most of its doors, with any of
// its free pieces nobody was given.
function wholeBlocks(G, slices) {
  const { blockOf, blocks } = cornerBlocks(G);
  const owner = new Map();
  slices.forEach((sl, i) => sl.forEach(s => owner.set(s, i)));
  const touched = new Set();
  for (const [s] of owner) touched.add(blockOf.get(s));
  for (const b of touched) {
    const byRoute = new Map();
    for (const s of blocks[b]) if (owner.has(s)) byRoute.set(owner.get(s), (byRoute.get(owner.get(s)) || 0) + cnt(s.avail) + 0.001);
    const win = [...byRoute.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0][0];
    for (const s of blocks[b]) {
      if (owner.has(s) && owner.get(s) !== win) { const sl = slices[owner.get(s)]; sl.splice(sl.indexOf(s), 1); owner.delete(s); }
      if (!owner.has(s) && s.avail.length) { slices[win].push(s); owner.set(s, win); }
    }
  }
  return blockOf;
}

// Where a route runs out along a street, it goes on only while there's
// something to knock for the walk: a stretch with no doors left on one side
// (or none at all) is worth walking to reach doors further down, as long as
// there's at least one door per DOOR_EVERY_M of street from the last kept
// point. Past that the route turns back at its last door, rather than walk
// to the bottom of the road for a handful of houses on the far side.
const DOOR_EVERY_M = 30;
function trimSparseEnds(sl, start) {
  let out = sl.slice();
  for (let pass = 0; pass < 20; pass++) {
    const deg = new Map(), at = new Map();
    for (const s of out) for (const n of [s.a, s.b]) { deg.set(n, (deg.get(n) || 0) + 1); (at.get(n) || at.set(n, []).get(n)).push(s); }
    const drop = new Set();
    for (const [leaf, d] of deg) {
      if (d !== 1 || leaf === start) continue;
      const chain = [];   // leaf → base
      let n = leaf, prev = null;
      for (;;) {
        const s = at.get(n).find(x => x !== prev && !chain.includes(x));
        if (!s) break;
        chain.push(s);
        n = s.a === n ? s.b : s.a; prev = s;
        if (deg.get(n) !== 2 || n === start) break;
      }
      chain.reverse();   // base → leaf
      let kept = 0, doors = 0, len = 0;
      for (let j = 0; j < chain.length; j++) {
        doors += cnt(chain[j].avail); len += chain[j].len;
        if (doors * DOOR_EVERY_M >= len) { kept = j + 1; doors = 0; len = 0; }
      }
      for (const s of chain.slice(kept)) drop.add(s);
    }
    if (!drop.size || drop.size >= out.length) break;
    out = out.filter(s => !drop.has(s));
  }
  return out;
}

// Door-less blocks left hanging off a slice (after its far end was given
// up) lead nowhere: walking them would be pure deadwalk.
function pruneDangling(sl) {
  let out = sl.slice(), changed = true;
  while (changed) {
    changed = false;
    const deg = {};
    for (const s of out) { deg[s.a] = (deg[s.a] || 0) + 1; deg[s.b] = (deg[s.b] || 0) + 1; }
    const keep = out.filter(s => s.avail.length || (deg[s.a] > 1 && deg[s.b] > 1));
    if (keep.length < out.length) { out = keep; changed = true; }
  }
  return out;
}

function eulerLap(G, segs, transit, start) {
  // Lanes. A block with doors on both sides gets an out-lane and a back-lane
  // (one pass per side). A block with doors on one side only gets ONE lane —
  // its return leg would be a deadwalk — and so does a connector. Single
  // lanes leave some corners with an odd number of lanes; the shortest walks
  // pairing those corners up are added as extra lanes (the postman trick),
  // so a closed loop through every lane exists again.
  const sidesOf = s => ({ L: cnt(s.avail.filter(d => d.side === 1)), R: cnt(s.avail.filter(d => d.side === -1)) });
  const directed = [];   // { s, dir, transit }
  const single = [];     // { s, transit } — direction decided below
  for (const s of segs) {
    const { L, R } = sidesOf(s);
    if (L && R) directed.push({ s, dir: 1, transit: false, used: false }, { s, dir: -1, transit: false, used: false });
    else single.push({ s, transit: !L && !R, used: false });
  }
  for (const s of transit) single.push({ s, transit: true, used: false });

  // Odd corners → pair them by shortest walk, closest pairs first (a greedy
  // matching). If the pairing walks cost more than the return legs they
  // replace, the plain doubled lap is the better one — use that instead.
  const deg = {};
  for (const l of single) { deg[l.s.a] = (deg[l.s.a] || 0) + 1; deg[l.s.b] = (deg[l.s.b] || 0) + 1; }
  const odd = Object.keys(deg).filter(n => deg[n] % 2 === 1);
  // The doubled lap walks every single lane twice — one-sided blocks,
  // door-less blocks and connectors alike — so that is what the pairing
  // walks have to beat.
  const saved = single.reduce((n, l) => n + l.s.len, 0);
  const sp = new Map();   // odd node → { dist, prev }
  for (const o of odd) sp.set(o, dijkstra(G, [o]));
  const D = (a, b) => sp.get(a).dist.get(b);
  let chosen = [];
  if (odd.length <= 16 && odd.length % 2 === 0) {
    // Exact minimum-weight matching by bitmask DP (≤ 8 pairs).
    const n = odd.length, full = (1 << n) - 1, dp = new Float64Array(1 << n).fill(Infinity), choice = new Int32Array(1 << n).fill(-1);
    dp[0] = 0;
    for (let mask = 0; mask < full; mask++) {
      if (dp[mask] === Infinity) continue;
      let i = 0; while (mask & (1 << i)) i++;
      for (let j = i + 1; j < n; j++) {
        if (mask & (1 << j)) continue;
        const d = D(odd[i], odd[j]); if (d == null) continue;
        const m2 = mask | (1 << i) | (1 << j);
        if (dp[mask] + d < dp[m2]) { dp[m2] = dp[mask] + d; choice[m2] = i * 16 + j; }
      }
    }
    if (dp[full] < Infinity) { let m = full; while (m) { const c = choice[m], i = Math.floor(c / 16), j = c % 16; chosen.push({ a: odd[i], b: odd[j], d: D(odd[i], odd[j]) }); m &= ~((1 << i) | (1 << j)); } }
  }
  if (!chosen.length) {
    // Greedy: closest pairs first.
    const pairs = [];
    for (let i = 0; i < odd.length; i++) for (let j = i + 1; j < odd.length; j++) { const d = D(odd[i], odd[j]); if (d != null) pairs.push({ a: odd[i], b: odd[j], d }); }
    pairs.sort((x, y) => x.d - y.d);
    const taken = new Set();
    for (const pr of pairs) { if (taken.has(pr.a) || taken.has(pr.b)) continue; taken.add(pr.a); taken.add(pr.b); chosen.push(pr); }
  }
  const paired = new Set(); let added = 0; const dups = [];
  for (const pr of chosen) {
    paired.add(pr.a); paired.add(pr.b); added += pr.d;
    const { prev } = sp.get(pr.a);
    let n = pr.b;
    while (n !== pr.a) { const p = prev.get(n); if (!p) break; dups.push({ s: p.via, transit: true, dup: true, used: false }); n = p.from; }
  }
  if (added >= saved || paired.size < odd.length) {
    // no gain (or a corner nobody can reach): every block gets both lanes
    for (const l of single.splice(0)) directed.push({ s: l.s, dir: 1, transit: l.transit, used: false }, { s: l.s, dir: -1, transit: l.transit, used: false });
  } else {
    single.push(...dups);
  }

  // Orient the single lanes: an Euler circuit of that part on its own fixes
  // a direction for each, and a circuit is balanced by construction.
  const outU = {};
  for (const l of single) { (outU[l.s.a] ||= []).push(l); (outU[l.s.b] ||= []).push(l); }
  for (const l of single) {
    if (l.used) continue;
    const stack = [l.s.a];
    while (stack.length) {
      const v = stack[stack.length - 1];
      const next = (outU[v] || []).find(x => !x.used);
      if (!next) { stack.pop(); continue; }
      next.used = true; next.dir = v === next.s.a ? 1 : -1;
      stack.push(next.dir === 1 ? next.s.b : next.s.a);
    }
  }
  const lanes = directed.concat(single.map(l => ({ s: l.s, dir: l.dir || 1, transit: l.transit, dup: !!l.dup, used: false })));

  const out = {};
  // Each lane leaves from its own end only, so the two passes of a two-sided
  // block are always opposite directions — and opposite sides of the street.
  for (const l of lanes) (out[l.dir === 1 ? l.s.a : l.s.b] ||= []).push(l);
  const lanePair = new Map();   // lane → its sibling (other direction), two-sided blocks only
  for (let i = 0; i < directed.length; i += 2) { lanePair.set(lanes[i], lanes[i + 1]); lanePair.set(lanes[i + 1], lanes[i]); }

  const heading = (s, from) => {
    const xy = s.xy, a = from === s.a ? xy[0] : xy[xy.length - 1], b = from === s.a ? xy[1] : xy[xy.length - 2];
    return ang(b.x - a.x, b.y - a.y);
  };
  const stack = [{ node: start, via: null }];
  const circuit = [];
  while (stack.length) {
    const top = stack[stack.length - 1];
    const cands = (out[top.node] || []).filter(l => !l.used && (top.via ? l.s !== top.via.s || lanePair.get(top.via) !== l : true));
    let pick = cands.length ? cands : (out[top.node] || []).filter(l => !l.used);   // u-turn only when nothing else
    if (!pick.length) { circuit.push(stack.pop()); continue; }
    // Prefer real blocks over transit, then the straightest continuation.
    const h0 = top.via ? heading(top.via.s, top.via.from === top.via.s.a ? top.via.s.b : top.via.s.a) + Math.PI : null;
    pick.sort((x, y) => {
      if (x.transit !== y.transit) return x.transit ? 1 : -1;
      if (h0 == null) return 0;
      const turn = l => { let t = Math.abs(heading(l.s, top.node) - h0); t = Math.min(t, 2 * Math.PI - t); return t; };
      return turn(x) - turn(y);
    });
    const l = pick[0];
    l.used = true;
    const from = top.node, to = l.dir === 1 ? l.s.b : l.s.a;
    l.from = from;
    stack.push({ node: to, via: l });
  }
  circuit.reverse();
  return circuit.filter(e => e.via).map(e => e.via);   // ordered traversals
}

// The lap the way a team walks it (field rule): "walk forward,
// do doors on the left side of the road, turn left to a new road, get to the
// end, turn back, get back to the original road, then stick left to get back
// on the same side of the road you started on". So: keep the houses on your
// left; at every corner take the first road on your left that isn't done;
// at the end of a road turn back; never step onto a street you're already
// part-way through from somewhere else — you'll finish it when you come back
// along it. Side streets and cul-de-sacs are taken as you pass, every street
// is one loop out one side and back the other, and the lap ends across the
// road from where it started. Each block is walked twice, once per side.
// Returns null if anything was missed (the caller falls back to eulerLap).
const FAR_SIDE_TURN = Math.PI / 4;   // sharper than this to the right = a street across the road
function keepLeftLap(G, segs, transit, start, hand = 'left') {
  const mirror = hand === 'left' ? 1 : -1;   // keep-right is the same walk in a mirror
  const all = segs.concat(transit.filter(t => !segs.includes(t)));
  if (!all.length) return [];
  const isConnector = new Set(transit.map(s => s.id));
  // A street = connected blocks carrying the same name (an unnamed way is its
  // own street). Walking it straight on is continuing; anything else is a turn.
  const keyOf = s => s.name ? 'n:' + s.name.trim().toLowerCase() : 'w:' + String(s.id).split(':')[0];
  const at = {};
  for (const s of all) { (at[s.a] ||= []).push(s); (at[s.b] ||= []).push(s); }
  const street = new Map();
  let nStreets = 0;
  for (const s of all) {
    if (street.has(s)) continue;
    const id = nStreets++, k = keyOf(s), stack = [s];
    street.set(s, id);
    while (stack.length) {
      const c = stack.pop();
      for (const n of [c.a, c.b]) for (const o of at[n]) if (!street.has(o) && keyOf(o) === k) { street.set(o, id); stack.push(o); }
    }
  }
  // Heading leaving node n along block s, measured ~12 m in (a kerb-side view
  // of the corner, not the first survey point).
  const leave = (s, n, dir = n === s.a ? 1 : -1) => {
    const xy = dir === 1 ? s.xy : s.xy.slice().reverse();
    let i = 1, d = 0;
    while (i < xy.length - 1 && d + Math.hypot(xy[i].x - xy[i - 1].x, xy[i].y - xy[i - 1].y) < 12) { d += Math.hypot(xy[i].x - xy[i - 1].x, xy[i].y - xy[i - 1].y); i++; }
    return Math.atan2(xy[i].y - xy[0].y, xy[i].x - xy[0].x);
  };
  const turnOf = (hIn, hOut) => { let t = hOut - hIn; while (t <= -Math.PI) t += 2 * Math.PI; while (t > Math.PI) t -= 2 * Math.PI; return t; };   // + = left
  const doorsOf = s => cnt(s.avail || []);
  const streetDoors = new Map();
  for (const s of all) streetDoors.set(street.get(s), (streetDoors.get(street.get(s)) || 0) + doorsOf(s));

  const walked = new Set(), active = new Set(), done = new Set(), out = [];
  const pass = (s, from, dir, back) => out.push({ s, dir, from, transit: isConnector.has(s.id), dup: back && isConnector.has(s.id) });
  // Corners already passed on the way here: a road leading back to one is
  // left for the way home, taken then as a stub off that corner.
  const onPath = new Map();
  // May we step onto block s from the street we're on?
  const allowed = (s, cur, node) => {
    if (walked.has(s) || !(street.get(s) === cur || !active.has(street.get(s)))) return false;
    const far = s.a === node ? s.b : s.a;
    return far === node || !onPath.get(far);
  };
  const walk = (node, cur, heading) => {
    onPath.set(node, (onPath.get(node) || 0) + 1);
    try { for (;;) {
      let best = null, bt = -Infinity;
      for (const s of at[node] || []) {
        if (!allowed(s, cur, node)) continue;
        const t = heading == null ? 0 : mirror * turnOf(heading, leave(s, node));
        // First move of the lap: along the street with the most doors.
        const score = heading == null ? streetDoors.get(street.get(s)) * 1e4 + doorsOf(s) : t;
        if (score > bt) { bt = score; best = s; }
      }
      // A street on the far side (a right turn while keeping left) taken here
      // means crossing the road mid-street, doing it, and crossing back to
      // carry on. If the way ahead, or a left, is only waiting because it
      // leads back to a corner already passed, walk that first: the lap comes
      // back up the other side and takes the side street on its own side.
      // Same blocks, same metres; only the order changes.
      if (best && heading != null && bt < -FAR_SIDE_TURN) {
        for (const s of at[node] || []) {
          if (walked.has(s) || allowed(s, cur, node) || !(street.get(s) === cur || !active.has(street.get(s)))) continue;
          const t = mirror * turnOf(heading, leave(s, node));
          if (t >= -FAR_SIDE_TURN && t > bt) { bt = t; best = s; }
        }
      }
      if (!best) {
        // Nothing left to start from here; a road back to a passed corner
        // is fine now (it becomes a stub walked out and back).
        for (const s of at[node] || []) if (!walked.has(s) && (street.get(s) === cur || !active.has(street.get(s)))) { const t = heading == null ? 0 : mirror * turnOf(heading, leave(s, node)); if (t > bt) { bt = t; best = s; } }
        if (!best) return;
      }
      const s = best, to = s.a === node ? s.b : s.a, st = street.get(s), fresh = !active.has(st);
      walked.add(s);
      if (fresh) active.add(st);
      const d0 = node === s.a ? 1 : -1;                      // a loop (a === b) goes round a→b, comes back b→a
      pass(s, node, d0, false);                              // out, houses on your side
      walk(to, st, leave(s, to, -d0) + Math.PI);             // …and everything past it
      pass(s, to, -d0, true);                                // back, the other side
      if (fresh) { active.delete(st); done.add(st); }
      heading = leave(s, node, d0) + Math.PI;                // arriving back here
    } } finally { onPath.set(node, onPath.get(node) - 1); }
  };
  walk(start, null, null);
  if (walked.size !== all.length) return null;
  return out;
}

function otherStreetAt(G, node, name) {
  const names = new Set((G.adj[node] || []).map(s => s.name).filter(n => n && n !== name));
  return [...names][0] || '';
}

function describe(G, traversals, seedLL, people, hand = 'left') {
  const steps = [];
  let path = [];
  let doorsTotal = 0, bldgTotal = 0, bigTotal = 0, lenTotal = 0, transitTotal = 0, deadTotal = 0;
  const deadBy = { transit: 0, oneSided: 0, empty: 0 };   // where the deadwalk comes from
  const sideDone = new Map();   // seg id → sides already knocked on earlier passes
  for (const t of traversals) {
    const s = t.s;
    const coords = t.dir === 1 ? s.coords : s.coords.slice().reverse();
    path = path.length ? path.concat(coords.slice(1)) : coords.slice();
    // On each pass knock the side you're walking on — the LEFT, the lap keeps
    // the houses on your left (walking a→b the left-hand side is side 1); if
    // only the far side has doors left, cross over and take that. One side
    // per pass, no zigzag.
    // Door-less blocks a route grows through, and postman duplicates, are
    // walk-throughs.
    const wasConnector = t.transit || !!t.dup;   // bridge / pairing walk, before the reclassification below
    if (!s.avail.length || t.dup) t.transit = true;
    let side = null;
    if (!t.transit) {
      const done = sideDone.get(s.id) || new Set();
      const right = -t.dir, left = t.dir;
      const has = sd => !done.has(sd) && s.avail.some(d => d.side === sd);
      // Keep-side laps pass every block both ways, so each house is knocked on
      // the pass that has it on your side; the old circuit may cross over.
      side = hand === 'left' ? (has(left) ? left : null) : hand === 'keepright' ? (has(right) ? right : null) : (has(right) ? right : has(left) ? left : null);
      if (side != null) { done.add(side); sideDone.set(s.id, done); }
      else t.transit = true;   // nothing left to knock on this pass: a deadwalk
    }
    const doorList = side == null ? [] : s.avail.filter(d => d.side === side);
    const doors = cnt(doorList), bldgs = doorList.length, big = doorList.filter(d => d.big).length;
    t.side = side == null ? null : (side === -t.dir ? 'right' : 'left');
    const from = t.from, to = t.dir === 1 ? s.b : s.a;
    const last = steps[steps.length - 1];
    if (last && last.name === s.name && last.transit === t.transit && last.side === t.side && last.toNode === from) {
      last.doors += doors; last.buildings += bldgs; last.big += big; last.lenM += s.len; last.toNode = to;
    } else {
      steps.push({ name: s.name || (t.transit ? 'connector' : 'unnamed street'), transit: t.transit, side: t.side, doors, buildings: bldgs, big, lenM: s.len, fromNode: from, toNode: to });
    }
    doorsTotal += doors; bldgTotal += bldgs; bigTotal += big; lenTotal += s.len; if (t.transit) transitTotal += s.len;
    if (!doors) {   // a deadwalk: nothing to knock on the side you're walking
      deadTotal += s.len;
      if (wasConnector) deadBy.transit += s.len; else if (cnt(s.avail)) deadBy.oneSided += s.len; else deadBy.empty += s.len;
    }
  }
  const out = steps.map((st, i) => ({
    n: i + 1, name: st.name, transit: st.transit, side: st.side, doors: st.doors, buildings: st.buildings, big: st.big, lenM: Math.round(st.lenM),
    from: otherStreetAt(G, st.fromNode, st.name), to: otherStreetAt(G, st.toNode, st.name),
    at: G.nodeXY[st.fromNode] ? G.P.toLL(G.nodeXY[st.fromNode].x, G.nodeXY[st.fromNode].y).map(v => +v.toFixed(6)) : null,
  }));
  const startNode = traversals[0]?.from;
  return {
    steps: out, path, doors: doorsTotal, buildings: bldgTotal, big: bigTotal, lenM: Math.round(lenTotal), transitM: Math.round(transitTotal), deadM: Math.round(deadTotal), deadBy,
    // estMin is one lap (the first, the longest); the day is all three.
    ...(() => { const laps = lapMinutes(lenTotal, bldgTotal, doorsTotal, people).map(Math.round); return { estMin: laps[0], estLapsMin: laps, estDayMin: laps.reduce((a, b) => a + b, 0), walkMin: Math.round(lenTotal / WALK_M_PER_MIN) }; })(),
    start: startNode ? G.P.toLL(G.nodeXY[startNode].x, G.nodeXY[startNode].y) : seedLL,
    closed: !!startNode && traversals.length > 0 && (traversals[traversals.length - 1].dir === 1 ? traversals[traversals.length - 1].s.b : traversals[traversals.length - 1].s.a) === startNode,
  };
}

// ── Entry point ──────────────────────────────────────────────────────────────
function generate(graph, opts) {
  const doorsPerPerson = Math.max(20, Math.min(400, +opts.doorsPerPerson || 100));
  const pairings = Math.max(0, Math.min(12, +opts.pairings || 0));
  const solos    = Math.max(0, Math.min(24, +opts.solos || 0));
  if (!pairings && !solos) throw Object.assign(new Error('Ask for at least one pairing or solo'), { status: 400 });

  const G = prepare(graph);
  const excl = applyExclusions(G, opts);
  const specs = [
    ...Array.from({ length: pairings }, (_, i) => ({ label: `Pair ${i + 1}`, kind: 'pair', people: 2, target: doorsPerPerson * 2 })),
    ...Array.from({ length: solos },    (_, i) => ({ label: `Solo ${i + 1}`, kind: 'solo', people: 1, target: doorsPerPerson })),
  ];
  const need = specs.reduce((n, s) => n + s.target, 0);
  if (excl.freeDoors < Math.min(need, 40))
    throw Object.assign(new Error(`Only ${excl.freeDoors} free doors left in this ZIP for the current rotation`), { status: 409, stats: excl });

  const picked = pickSeed(G, need, opts.near);
  if (!picked) throw Object.assign(new Error('No free streets found'), { status: 409, stats: excl });
  const seed = picked.id;
  const { patch, got, dist } = growPatch(G, seed, need);
  const slices = slicePatch(G, patch, seed, specs, got, dist);
  const blockOf = wholeBlocks(G, slices);
  const seedLL = G.P.toLL(G.nodeXY[seed].x, G.nodeXY[seed].y);

  const lapMax = Math.max(45, Math.min(240, +opts.lapMaxMin || LAP_MAX_MIN));
  const lapOf = (sl, people) => {
    const { segs, transit } = connect(G, sl, dist);
    // Start at the slice's block nearest the car.
    let start = null, sd = Infinity;
    for (const s of segs) for (const n of [s.a, s.b]) { const d = dist.get(n) ?? Infinity; if (d < sd) { sd = d; start = n; } }
    // The keep-left lap; if it ever can't cover the slice, the old circuit
    // (houses on the right) — and the route says which, so it's drawn and
    // knocked on the side it's walked.
    // Walked keeping left and keeping right are the same distance; keep the
    // one that reads shorter on the list, then the one with less empty walking.
    let best = null;
    for (const side of ['left', 'right']) {
      let lap = null;
      try { lap = keepLeftLap(G, segs, transit, start, side); } catch { lap = null; }   // (a pathological depth)
      if (!lap) continue;
      const d = { ...describe(G, lap, seedLL, people, side === 'left' ? 'left' : 'keepright'), hand: side };
      if (!best || d.steps.length < best.steps.length || (d.steps.length === best.steps.length && d.deadM < best.deadM)) best = d;
    }
    if (!best) { fallbacks++; best = { ...describe(G, eulerLap(G, segs, transit, start), seedLL, people, 'right'), hand: 'right' }; }
    return { segs, d: best };
  };
  const far = s => Math.min(dist.get(s.a) ?? 1e9, dist.get(s.b) ?? 1e9);
  let fallbacks = 0;
  const built = specs.map((spec, i) => {
    let sl = slices[i];
    if (sl.length) {
      let start = null, sd = Infinity;
      for (const s of sl) for (const n of [s.a, s.b]) { const d = dist.get(n) ?? Infinity; if (d < sd) { sd = d; start = n; } }
      sl = trimSparseEnds(sl, start);
    }
    if (!sl.length) return { spec, empty: true };
    let lap = lapOf(sl, spec.people), capped = false;
    // A lap has to fit the day: the team walks it three times. Where the
    // houses are spread out, the route gives up its farthest blocks until
    // one lap fits — fewer doors, done properly, beats a lap nobody finishes.
    for (let k = 0; k < 8 && lap.d.estMin > lapMax; k++) {
      const knock = sl.filter(s => s.avail.length).sort((x, y) => far(y) - far(x));
      if (knock.length <= 1) break;
      const drop = new Set(); let saved = 0;
      for (const s of knock) {
        if (saved >= lap.d.estMin - lapMax || drop.size >= knock.length - 1) break;
        if (drop.has(s.id)) continue;
        // whole blocks only: the rest of this one goes with it
        for (const o of sl) if (blockOf.get(o) === blockOf.get(s) && !drop.has(o.id)) {
          drop.add(o.id);
          saved += 2 * o.len / WALK_M_PER_MIN + (o.avail.length * APPROACH_S / 60 + cnt(o.avail) * DOOR_MIN[0]) / spec.people;
        }
      }
      sl = pruneDangling(sl.filter(s => !drop.has(s.id)));
      lap = lapOf(sl, spec.people); capped = true;
    }
    return { spec, sl, lap, capped };
  });

  // Pockets left behind: a dead-end group of free doors (no other free street
  // within a short walk) next to a route, too small to be anyone's plan.
  // Nobody comes back for those, so the route beside it finishes it: added
  // outright when the lap still fits the day, else traded for blocks on the
  // route's open side (they border free streets the next plan reaches anyway)
  // as long as the trade gains doors. (Seen in the field: the top of two
  // dead-end roads was left behind when a solo's lap was cut for time.)
  const POCKET_MIN = 5, POCKET_MAX = 40;
  const inPlan = new Set(built.flatMap(b => b.empty ? [] : b.sl.map(s => s.id)));
  // An open-side block of this route to give up (whole block, never splitting
  // the route, never one of `keep`), the one with the most walking per door.
  const peelOne = (b, sl, keep) => {
    const mine = new Set(sl.map(s => s.id)), others = new Set([...inPlan].filter(id => !b.sl.some(s => s.id === id)));
    const { groupOf } = freeGroups(G, s => s.avail.length && !mine.has(s.id) && !others.has(s.id) && isFinite(dist.get(s.a) ?? Infinity));
    const open = s => [s.a, s.b].some(n => (G.adj[n] || []).some(o => groupOf.has(o.id) && !groupOf.get(o.id).hemmed));
    const perDoor = s => 2 * s.len / Math.max(1, cnt(s.avail));
    const parts = components(sl).length;
    for (const s of sl.filter(x => x.avail.length && !keep.has(x.id) && open(x)).sort((x, y) => perDoor(y) - perDoor(x))) {
      const block = sl.filter(o => blockOf.get(o) === blockOf.get(s));
      if (block.some(o => keep.has(o.id))) continue;
      const rest = sl.filter(o => !block.includes(o));
      if (rest.length && components(rest).length <= parts) return block;
    }
    return null;
  };
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    const { groups } = freeGroups(G, s => s.avail.length && !inPlan.has(s.id) && isFinite(dist.get(s.a) ?? Infinity));
    for (const gr of groups) {
      if (!gr.hemmed || gr.doors < POCKET_MIN || gr.doors > POCKET_MAX) continue;
      const nodes = new Set(gr.segs.flatMap(s => [s.a, s.b]));
      const touching = built.filter(b => !b.empty && b.sl.some(s => nodes.has(s.a) || nodes.has(s.b)))
        .sort((x, y) => x.lap.d.estMin - y.lap.d.estMin);   // the route with the most time to spare first
      for (const b of touching) {
        const keep = new Set(gr.segs.map(s => s.id));
        let sl = b.sl.concat(gr.segs), lap = lapOf(sl, b.spec.people), lost = 0;
        while (lap.d.estMin > lapMax && lost < gr.doors) {
          const block = peelOne(b, sl, keep);
          if (!block) break;
          lost += doorsIn(block);
          sl = pruneDangling(sl.filter(s => !block.includes(s)));
          lap = lapOf(sl, b.spec.people);
        }
        if (lap.d.estMin > lapMax || lost >= gr.doors || !gr.segs.every(s => lap.segs.includes(s))) continue;
        for (const s of b.sl) inPlan.delete(s.id);
        b.sl = sl; b.lap = lap; b.capped = b.capped || lost > 0;
        for (const s of sl) inPlan.add(s.id);
        moved = true; break;
      }
    }
    if (!moved) break;
  }

  const routes = built.map(b => {
    if (b.empty) return { ...b.spec, empty: true, doors: 0, steps: [], path: [], segIds: [] };
    const { segs, d } = b.lap;
    return { ...b.spec, ...d, capped: b.capped, segIds: segs.map(s => s.id), blocks: segs.length,
      streets: [...new Set(segs.map(s => s.name).filter(Boolean))] };
  });

  const short = routes.some(r => r.doors < r.target * 0.85);
  const cutForTime = routes.some(r => r.capped && r.doors < r.target * 0.85);
  // "Meet at Example St & Sample Ave" — the streets at the meeting corner.
  const cornerNames = [...new Set((G.adj[seed] || []).map(s => s.name).filter(Boolean))];
  return {
    meeting: seedLL,
    meetingName: cornerNames.slice(0, 2).join(' & ') || null,
    seedReason: picked.reason || null,
    nearUsed: opts.near ? picked.nearUsed : null,
    params: { doorsPerPerson, pairings, solos, near: opts.near || null },
    need, patchDoors: got, short,
    shortReason: !short ? null : excl.freeDoors < need ? 'zip' : cutForTime ? 'time' : 'scattered',
    lapMaxMin: lapMax,
    ...(fallbacks ? { lapFallbacks: fallbacks } : {}),
    stats: excl,
    routes,
  };
}

module.exports = { generate, applyExclusions, prepare };
