'use strict';
/**
 * A made-up street map for one sample ZIP, so walking routes can be generated
 * on a fresh clone with no OpenStreetMap (Overpass) or assessor call.
 *
 * It returns the same shape lib/osm.js gets back from Overpass ({ ways,
 * buildings, addrNodes }): a small grid of fictional streets ("Alder Sample
 * St", "1st Fixture Ave", …) with numbered houses on both sides and a few
 * three-unit buildings. lib/osm.js buildGraph() turns it into the street
 * graph the route generator walks. Nothing here is real: the streets will not
 * line up with the basemap underneath.
 *
 * Deterministic: the same ZIP + centre always gives the same graph (stable
 * block ids, so saved plans keep pointing at the same blocks).
 *
 * Used by scripts/seed-sample.js (writes it into the osmcaches collection,
 * flagged `fixture: true` so the server never refreshes it from OSM) and by
 * test/routegen.test.js.
 */
const geo = require('../../lib/geo');
const osm = require('../../lib/osm');

const SAMPLE_ZIP = '01108';
const EW_NAMES = ['Alder', 'Birch', 'Cedar', 'Dogwood', 'Elm', 'Fir', 'Ginkgo', 'Hazel'];
const ORD = n => n + ((n % 100 >= 11 && n % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'));

// Raw Overpass-shaped data for a `rows × cols` grid centred on [lat, lng].
function rawGrid([lat, lng], { rows = 8, cols = 8, spacingM = 130, houseEveryM = 24, setbackM = 14 } = {}) {
  const P = geo.projector(lat, lng);
  const x0 = -((cols - 1) * spacingM) / 2, y0 = -((rows - 1) * spacingM) / 2;
  const nodeId = (i, j) => 9_000_000 + i * 100 + j;           // row i, column j
  const at = (i, j) => P.toLL(x0 + j * spacingM, y0 + i * spacingM);
  const ways = [], buildings = [];
  let wayId = 8_000_000, bId = 7_000_000;

  const addStreet = (name, hw, pts) => {
    ways.push({
      type: 'way', id: ++wayId, tags: { highway: hw, name },
      nodes: pts.map(p => p.id), geometry: pts.map(p => ({ lat: +p.ll[0].toFixed(7), lon: +p.ll[1].toFixed(7) })),
    });
    // Houses along each block, both sides; odd numbers on the left.
    let odd = 1, even = 2;
    for (let k = 1; k < pts.length; k++) {
      const a = P.toXY(...pts[k - 1].ll), b = P.toXY(...pts[k].ll);
      const len = Math.hypot(b.x - a.x, b.y - a.y), ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
      for (let s = 16; s <= len - 16; s += houseEveryM) {
        for (const side of [1, -1]) {
          const cx = a.x + ux * s - uy * setbackM * side, cy = a.y + uy * s + ux * setbackM * side;
          const [cLat, cLng] = P.toLL(cx, cy);
          const [sLat, wLng] = P.toLL(cx - 5, cy - 5), [nLat, eLng] = P.toLL(cx + 5, cy + 5);
          const num = side === 1 ? (odd += 2) - 2 : (even += 2) - 2;
          const tags = { building: 'house', 'addr:housenumber': String(num), 'addr:street': name };
          // Every ninth building is a three-family, to exercise multi-unit doors.
          if (++bId % 9 === 0) { tags.building = 'residential'; tags['building:flats'] = '3'; }
          buildings.push({
            type: 'way', id: bId, tags,
            bounds: { minlat: sLat, minlon: wLng, maxlat: nLat, maxlon: eLng },
            center: { lat: cLat, lon: cLng }, areaM2: 75,
          });
        }
      }
    }
  };
  for (let i = 0; i < rows; i++)
    addStreet(`${EW_NAMES[i % EW_NAMES.length]} Sample St`, 'residential',
      Array.from({ length: cols }, (_, j) => ({ id: nodeId(i, j), ll: at(i, j) })));
  for (let j = 0; j < cols; j++)
    addStreet(`${ORD(j + 1)} Fixture Ave`, j === Math.floor(cols / 2) ? 'tertiary' : 'residential',
      Array.from({ length: rows }, (_, i) => ({ id: nodeId(i, j), ll: at(i, j) })));
  return { ways, buildings, addrNodes: [] };
}

// The grid's centre for a ZIP: the middle of its bounding box (the sample
// ZIP's is inside it).
function centreOf(zip) {
  const geom = osm.zipGeometry(zip);
  if (!geom) throw new Error(`No boundary on file for ZIP ${zip}`);
  const bb = geo.bboxOf(geo.outerRings(geom));
  return [+((bb.s + bb.n) / 2).toFixed(5), +((bb.w + bb.e) / 2).toFixed(5)];
}

// The finished street graph (same shape as a cached OSM graph), flagged as a fixture.
function buildFixtureGraph(zip = SAMPLE_ZIP, centre = null, opts = {}) {
  const geom = osm.zipGeometry(zip);
  if (!geom) throw new Error(`No boundary on file for ZIP ${zip}`);
  const c = centre || centreOf(zip);
  const rings = geo.outerRings(geom);
  const graph = osm.buildGraph(zip, rings, rawGrid(c, opts), null, geo.polysOf(geom), null);
  graph.fixture = true;
  graph.pv = 0;
  graph.centre = c;
  return graph;
}

module.exports = { SAMPLE_ZIP, rawGrid, centreOf, buildFixtureGraph };
