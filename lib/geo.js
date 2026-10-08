'use strict';
// Small planar-ish geometry helpers shared by the OSM loader and the route
// generator. Everything works in [lat, lng] pairs and metres; at ZIP scale a
// local equirectangular projection is accurate to well under a metre.

const R_EARTH = 6371000;
const DEG = Math.PI / 180;

function distM(aLat, aLng, bLat, bLng) {
  const x = (bLng - aLng) * DEG * Math.cos(((aLat + bLat) / 2) * DEG);
  const y = (bLat - aLat) * DEG;
  return Math.sqrt(x * x + y * y) * R_EARTH;
}

// Local metre frame around an origin: [lat,lng] → {x,y} in metres.
function projector(oLat, oLng) {
  const kx = R_EARTH * DEG * Math.cos(oLat * DEG), ky = R_EARTH * DEG;
  return {
    toXY: (lat, lng) => ({ x: (lng - oLng) * kx, y: (lat - oLat) * ky }),
    toLL: (x, y) => [oLat + y / ky, oLng + x / kx],
  };
}

// Closest point on segment ab to p (all {x,y}); returns {t, x, y, d, side}
// side = +1 when p is to the left of a→b, -1 to the right.
function projectToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a.x + t * dx, y = a.y + t * dy;
  const cross = dx * (p.y - a.y) - dy * (p.x - a.x);
  return { t, x, y, d: Math.hypot(p.x - x, p.y - y), side: cross >= 0 ? 1 : -1 };
}

// Ray-cast point in ring. ring = [[lat,lng],...]
function ptInRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i], [yj, xj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// GeoJSON Polygon/MultiPolygon (in [lng,lat] order) → list of outer rings as [lat,lng].
function outerRings(geometry) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polys.map(p => p[0].map(([lng, lat]) => [lat, lng]));
}

function ptInGeometry(lat, lng, rings) {
  for (const r of rings) if (ptInRing(lat, lng, r)) return true;
  return false;
}

// GeoJSON Polygon/MultiPolygon → list of polygons, each a list of rings
// (outer first, then holes) as [lat,lng]. Holes matter: an enclave ZIP sits
// inside its neighbour's outer ring.
function polysOf(geometry) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polys.map(p => p.map(ring => ring.map(([lng, lat]) => [lat, lng])));
}

// Even-odd test over every ring, so a point inside a hole is outside.
function ptInPolys(lat, lng, polys) {
  for (const rings of polys) {
    let inside = false;
    for (const r of rings) if (ptInRing(lat, lng, r)) inside = !inside;
    if (inside) return true;
  }
  return false;
}

function bboxOf(rings) {
  let s = 90, n = -90, w = 180, e = -180;
  for (const r of rings) for (const [lat, lng] of r) {
    if (lat < s) s = lat; if (lat > n) n = lat; if (lng < w) w = lng; if (lng > e) e = lng;
  }
  return { s, n, w, e };
}

// Monotone-chain convex hull of [lat,lng] points → [lat,lng] ring (no repeat).
function convexHull(points) {
  const pts = points.slice().sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[1] - o[1]) * (b[0] - o[0]) - (a[0] - o[0]) * (b[1] - o[1]);
  const lower = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

// Uniform grid over metre-space points for nearest-neighbour queries.
class Grid {
  constructor(cell = 100) { this.cell = cell; this.map = new Map(); }
  key(x, y) { return `${Math.floor(x / this.cell)}:${Math.floor(y / this.cell)}`; }
  add(x, y, item) {
    const k = this.key(x, y);
    let b = this.map.get(k); if (!b) { b = []; this.map.set(k, b); }
    b.push(item);
  }
  // All items in cells within `radius` metres (superset — caller filters).
  near(x, y, radius) {
    const c = this.cell, r = Math.ceil(radius / c);
    const cx = Math.floor(x / c), cy = Math.floor(y / c), out = [];
    for (let i = cx - r; i <= cx + r; i++) for (let j = cy - r; j <= cy + r; j++) {
      const b = this.map.get(`${i}:${j}`); if (b) for (const it of b) out.push(it);
    }
    return out;
  }
}

// Binary min-heap keyed on .k
class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(k, v) { const a = this.a; a.push({ k, v }); let i = a.length - 1; while (i) { const p = (i - 1) >> 1; if (a[p].k <= a[i].k) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() {
    const a = this.a; if (!a.length) return null;
    const top = a[0], last = a.pop();
    if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l].k < a[m].k) m = l; if (r < a.length && a[r].k < a[m].k) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
    return top;
  }
}

module.exports = { distM, projector, projectToSegment, ptInRing, ptInGeometry, polysOf, ptInPolys, outerRings, bboxOf, convexHull, Grid, MinHeap };
