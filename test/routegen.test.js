'use strict';
// Route generator on the made-up sample street map (scripts/lib/street-fixture.js).
// Pure: no database, no OpenStreetMap, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const routegen = require('../lib/routegen');
const { SAMPLE_ZIP, buildFixtureGraph } = require('../scripts/lib/street-fixture');

const graph = buildFixtureGraph(SAMPLE_ZIP);
const none = { worked: [], strokes: [], reserved: new Set() };

test('fixture: a deterministic, door-lined street graph inside the sample ZIP', () => {
  assert.equal(graph.zip, SAMPLE_ZIP);
  assert.equal(graph.fixture, true);
  assert.ok(graph.stats.segs > 50, 'blocks');
  assert.equal(graph.stats.doorsOutside, 0);
  assert.equal(graph.stats.estimated, false);
  assert.ok(graph.stats.multi.three > 0, 'some three-family buildings');
  // Same input, same block ids: saved plans keep pointing at the same blocks.
  assert.deepEqual(buildFixtureGraph(SAMPLE_ZIP).segs.map(s => s.id), graph.segs.map(s => s.id));
});

test('generate: one pair and one solo from the park pin, sized to the door target', () => {
  const plan = routegen.generate(graph, { ...none, pairings: 1, solos: 1, doorsPerPerson: 100, near: graph.centre });
  assert.equal(plan.short, false);
  assert.deepEqual(plan.routes.map(r => r.people), [2, 1]);
  for (const r of plan.routes) {
    assert.ok(r.doors >= 0.6 * 100 * r.people, `route ${r.label} has enough doors (${r.doors})`);
    assert.ok(r.segIds.length > 0 && r.steps.length > 0);
  }
  // Routes never share a block.
  const ids = plan.routes.flatMap(r => r.segIds);
  assert.equal(new Set(ids).size, ids.length);
});

test('generate: blocks reserved by another plan and worked doors are skipped', () => {
  const first = routegen.generate(graph, { ...none, pairings: 1, solos: 0, doorsPerPerson: 100, near: graph.centre });
  const taken = new Set(first.routes.flatMap(r => r.segIds));
  const second = routegen.generate(graph, { ...none, reserved: taken, pairings: 1, solos: 0, doorsPerPerson: 100, near: graph.centre });
  for (const id of second.routes.flatMap(r => r.segIds)) assert.equal(taken.has(id), false, `block ${id} reused`);

  // Every door on every block marked worked: nothing is left to hand out.
  const worked = graph.segs.flatMap(s => s.doors.map(d => ({ lat: d.lat, lng: d.lng })));
  const G = routegen.prepare(graph);
  const stats = routegen.applyExclusions(G, { worked, strokes: [], reserved: new Set() });
  assert.ok(stats.freeDoors < stats.totalDoors * 0.05, `free ${stats.freeDoors} of ${stats.totalDoors}`);
});
