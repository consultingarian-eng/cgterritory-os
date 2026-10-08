'use strict';
// Ring slimming shared by the adapters (not an adapter itself — parcels.js
// loads adapters by name only). Cached parcels keep at most 12 vertices at
// 5 dp; maxAllowableOffset already generalises to ≈3 m, this only catches
// the odd long lot that still comes back with 20+.

const MAX_VERTS = 12;

// Area of the triangle a-b-c in degree² (relative sizes only matter here).
const triArea = (a, b, c) => Math.abs((b[1] - a[1]) * (c[0] - a[0]) - (c[1] - a[1]) * (b[0] - a[0])) / 2;

// [[lat,lng]...] (closed or open) → open ring of ≤ max vertices, 5 dp.
// Drops the least significant vertex (smallest triangle with its
// neighbours) until it fits — Visvalingam on a ring this small is cheap.
function slimRing(ring, max = MAX_VERTS) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  let r = [];
  for (const [la, ln] of ring) {
    const v = [+(+la).toFixed(5), +(+ln).toFixed(5)];
    const prev = r[r.length - 1];
    if (!prev || prev[0] !== v[0] || prev[1] !== v[1]) r.push(v);   // rounding folds neighbours together
  }
  const last = r[r.length - 1];
  if (r.length >= 3 && last[0] === r[0][0] && last[1] === r[0][1]) r = r.slice(0, -1);
  if (r.length < 3) return null;                                     // a condo "lot" a metre wide collapses at 5 dp
  while (r.length > max) {
    let worst = -1, worstA = Infinity;
    for (let i = 0; i < r.length; i++) {
      const a = triArea(r[(i + r.length - 1) % r.length], r[i], r[(i + 1) % r.length]);
      if (a < worstA) { worstA = a; worst = i; }
    }
    r.splice(worst, 1);
  }
  return r.length >= 3 ? r : null;
}

module.exports = { slimRing, MAX_VERTS };
