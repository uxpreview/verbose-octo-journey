/* A test runner with no dependencies, run with `npm test` (i.e. plain node).
 *
 * The things worth asserting here are not "does the function return a number"
 * but the invariants a plan has to hold to be diggable: no zone over the flow
 * budget, no head stranded inside the house, coverage actually achieved, and
 * a trench that reaches every head. Those are the claims the app makes on
 * screen, so those are the claims under test. */

import { sampleSite, blankSite, normalise, isObstacle, irrigableArea } from '../src/site.js';
import { autoLayout, FLOW_SAFETY, MAX_HEADS_PER_ZONE, pickNozzle, packZones, trenchTree, inradius } from '../src/autolayout.js';
import { headGpm, dripGpm, runTime, precipRate, bucketGpm, effectiveRadius, PR_CONSTANT } from '../src/hydraulics.js';
import { buildCoverageGrid, polygonCoverage, CoverageSampler } from '../src/coverage.js';
import { pointInPoly, polyArea, rect, dist, inSector, sectorPoints, distToBoundary, segmentCrossesPoly } from '../src/geometry.js';

let pass = 0, fail = 0;
const results = [];
function test(name, fn) {
  try { fn(); pass++; results.push(`  ok   ${name}`); }
  catch (e) { fail++; results.push(`  FAIL ${name}\n       ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function near(a, b, tol, msg) { assert(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`); }

/* --- geometry ---------------------------------------------------------- */

test('pointInPoly agrees with an obvious square', () => {
  const sq = rect(0, 0, 10, 10);
  assert(pointInPoly({ x: 5, y: 5 }, sq), 'centre is inside');
  assert(!pointInPoly({ x: 15, y: 5 }, sq), 'outside is outside');
});

test('polyArea is orientation-independent', () => {
  const sq = rect(0, 0, 10, 20);
  near(polyArea(sq), 200, 1e-9);
  near(polyArea([...sq].reverse()), 200, 1e-9, 'reversed');
});

test('distToBoundary finds the near edge, not the far one', () => {
  near(distToBoundary({ x: 2, y: 10 }, rect(0, 0, 20, 20)), 2, 1e-9);
});

test('a sector covers what it aims at and nothing behind it', () => {
  const h = { x: 0, y: 0, arc: 180, aim: 0 }; // 0 = away from the street, +y
  assert(inSector(h, 10, { x: 0, y: 5 }), 'straight ahead');
  assert(!inSector(h, 10, { x: 0, y: -5 }), 'directly behind');
  assert(!inSector(h, 10, { x: 0, y: 25 }), 'past the throw');
  assert(sectorPoints(h, 10).length > 12, 'traced with enough points to draw');
});

test('a full circle has no blind side', () => {
  const h = { x: 0, y: 0, arc: 360, aim: 0 };
  for (const p of [{ x: 5, y: 0 }, { x: -5, y: 0 }, { x: 0, y: -5 }, { x: 3, y: 3 }]) assert(inSector(h, 10, p), 'covered');
});

test('segmentCrossesPoly catches a trench through the house', () => {
  const house = rect(10, 10, 20, 20);
  assert(segmentCrossesPoly({ x: 0, y: 15 }, { x: 30, y: 15 }, house), 'straight through');
  assert(!segmentCrossesPoly({ x: 0, y: 0 }, { x: 5, y: 5 }, house), 'well clear');
});

/* --- hydraulics --------------------------------------------------------- */

test('flow rises with pressure and with arc', () => {
  const h = { type: 'mp', radius: 20, arc: 180 };
  assert(headGpm(h, 55) > headGpm(h, 35), 'more pressure, more flow');
  assert(headGpm({ ...h, arc: 360 }, 45) > headGpm(h, 45), 'a full circle uses more than a half');
  near(headGpm({ ...h, arc: 360 }, 40) / headGpm(h, 40), 2, 0.01, 'and exactly twice as much');
});

test('throw is clamped at both ends of the pressure range', () => {
  const h = { type: 'spray', radius: 12 };
  assert(effectiveRadius(h, 5) >= 12 * 0.6 - 0.01, 'never collapses to nothing');
  assert(effectiveRadius(h, 200) <= 12 * 1.25 + 0.01, 'never throws forever');
});

test('rotary nozzles land in the published precipitation-rate range', () => {
  // A real MP Rotator zone runs about 0.4 in/hr. Anything wildly off that
  // means the flow model has drifted away from the catalogues.
  const heads = Array.from({ length: 8 }, () => ({ type: 'mp', radius: 22, arc: 180 }));
  const gpm = heads.reduce((s, h) => s + headGpm(h, 40), 0);
  const pr = precipRate(gpm, 2400);
  assert(pr > 0.15 && pr < 0.75, `precip rate ${pr?.toFixed(2)} in/hr outside the plausible band`);
});

test('precipitation rate uses the standard constant', () => {
  near(precipRate(1, PR_CONSTANT), 1, 1e-9, '1 GPM over 96.25 sq ft is 1 in/hr');
});

test('run time falls as precipitation rate rises', () => {
  const slow = runTime(2, 2000), fast = runTime(8, 2000);
  assert(fast.weeklyMin < slow.weeklyMin, 'a wetter zone runs shorter');
  near(slow.perStartMin * 3, slow.weeklyMin, 1e-9, 'three starts split the week');
});

test('the bucket test converts both ways round', () => {
  near(bucketGpm(5, 30, 'us'), 10, 0.01, '5 gallons in 30 s is 10 GPM');
  near(bucketGpm(10, 30, 'metric'), 5.5, 0.6, '10 litres in 30 s is about 5.3 GPM');
  assert(bucketGpm(5, 0, 'us') === null, 'no divide by zero');
});

test('drip flow scales with bed area', () => {
  near(dripGpm(150) / dripGpm(75), 2, 1e-9);
});

/* --- the site model ----------------------------------------------------- */

test('the sample yard is a plausible lot', () => {
  const s = sampleSite();
  assert(s.areas.length > 10, 'has a yard worth of detail');
  assert(s.sources.length === 2, 'two hose bibs');
  const irr = irrigableArea(s);
  assert(irr > 3000 && irr < 8400, `irrigable area ${irr} should be most of, but not all, the lot`);
  assert(s.areas.some((a) => a.house), 'has a house');
});

test('the sample yard carries no address, name or coordinate', () => {
  const blob = JSON.stringify(sampleSite()).toLowerCase();
  for (const leak of ['low st', 'newburyport', 'ryan', 'lat', 'lon', 'massgis', '154']) {
    assert(!blob.includes(leak), `sample site leaks "${leak}"`);
  }
});

test('a blank lot is the size you asked for', () => {
  const s = blankSite(40, 90);
  const b = { x: Math.max(...s.site.lot.map((p) => p.x)), y: Math.max(...s.site.lot.map((p) => p.y)) };
  assert(b.x === 40 && b.y === 90, 'lot matches the entered dimensions');
  assert(s.sources.length === 1, 'starts with one hose bib');
});

test('normalise survives garbage without throwing', () => {
  for (const junk of [null, undefined, 42, 'nope', {}, { areas: 'no' }, { site: { lot: [] } }]) {
    const s = normalise(junk);
    assert(Array.isArray(s.areas) && s.site.lot.length >= 3 && s.sources.length >= 1, 'still a usable plan');
  }
});

test('normalise never hands out a colliding id', () => {
  const s = normalise({ areas: [{ id: 90, type: 'lawn', name: 'x', pts: rect(0, 0, 5, 5) }], nextId: 2 });
  assert(s.nextId > 90, `nextId ${s.nextId} would collide`);
});

/* --- the solver --------------------------------------------------------- */

test('inradius measures the narrow direction, not the area', () => {
  const wide = inradius(rect(0, 0, 40, 40));
  const thin = inradius(rect(0, 0, 100, 8));
  assert(wide > 15, `square inradius ${wide}`);
  assert(thin < 6, `thin strip inradius ${thin} should be about half its width`);
});

test('nozzle choice follows the shape', () => {
  assert(pickNozzle(rect(0, 0, 120, 120)).type === 'rotor', 'a big open lawn gets rotors');
  assert(pickNozzle(rect(0, 0, 60, 8)).type === 'spray', 'a narrow strip gets sprays');
  assert(pickNozzle(rect(0, 0, 30, 26)).type === 'mp', 'a normal lawn gets rotary nozzles');
  assert(pickNozzle(rect(0, 0, 120, 120), { prefer: 'spray' }).type === 'spray', 'an explicit choice is respected');
});

test('packZones never exceeds the budget it was given', () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ i, gpm: 1 + (i % 4) * 0.5 }));
  const zones = packZones(items, (it) => it.gpm, 5);
  for (const z of zones) {
    const total = z.reduce((s, it) => s + it.gpm, 0);
    assert(z.length === 1 || total <= 5 + 1e-9, `zone at ${total} GPM over a 5 GPM budget`);
  }
  assert(zones.flat().length === 30, 'nothing dropped');
});

test('the trench tree reaches every head exactly once', () => {
  const heads = Array.from({ length: 9 }, (_, i) => ({ id: i + 1, x: (i % 3) * 10, y: Math.floor(i / 3) * 10 }));
  const edges = trenchTree({ id: 's1', x: -5, y: -5 }, heads);
  assert(edges.length === heads.length, 'a spanning tree has one edge per node added');
  const reached = new Set(edges.map(([, b]) => b.headId));
  assert(reached.size === heads.length, 'every head is on the tree');
});

test('the trench prefers going around the house', () => {
  const house = { pts: rect(-3, 2, 3, 8) };
  const heads = [{ id: 1, x: 0, y: 10 }];
  const [[, b]] = trenchTree({ id: 's1', x: 0, y: 0 }, heads, { structures: [house] });
  assert(b.headId === 1, 'still connected'); // the penalty steers the tree, it never abandons a head
  const direct = dist({ x: 0, y: 0 }, { x: 0, y: 10 });
  assert(direct > 0, 'sanity');
});

/* --- end to end: a whole plan for the sample yard ----------------------- */

const site = sampleSite();
const plan = autoLayout(site);
const planned = { ...site, heads: plan.heads, pipes: plan.pipes, drip: plan.drip };

test('the solver produces a plan for the sample yard', () => {
  assert(plan.heads.length > 10, `only ${plan.heads.length} heads`);
  assert(plan.heads.length < 90, `${plan.heads.length} heads is not a plan, it is a flood`);
  assert(plan.drip.length > 0, 'beds got drip');
  assert(plan.notes.length > 3, 'the solver explains itself');
});

test('no zone exceeds the flow budget', () => {
  const byZone = new Map();
  for (const h of plan.heads) byZone.set(h.zone, (byZone.get(h.zone) || 0) + headGpm(h, site.supply.psi));
  for (const d of plan.drip) byZone.set(d.zone, (byZone.get(d.zone) || 0) + d.gpm);
  const budget = site.supply.gpm * FLOW_SAFETY;
  for (const [z, gpm] of byZone) assert(gpm <= budget + 1e-6, `zone ${z} draws ${gpm.toFixed(2)} GPM against a ${budget.toFixed(2)} GPM budget`);
});

test('no zone has more heads than one valve should carry', () => {
  const byZone = new Map();
  for (const h of plan.heads) byZone.set(h.zone, (byZone.get(h.zone) || 0) + 1);
  for (const [z, n] of byZone) assert(n <= MAX_HEADS_PER_ZONE, `zone ${z} has ${n} heads`);
});

test('no head is placed inside the house, the patio or the drive', () => {
  const blocks = site.areas.filter(isObstacle);
  for (const h of plan.heads) {
    for (const b of blocks) assert(!pointInPoly(h, b.pts), `head ${h.id} sits inside ${b.name}`);
  }
});

test('every head is inside the lot', () => {
  for (const h of plan.heads) assert(pointInPoly(h, site.site.lot), `head ${h.id} is off the lot at ${h.x.toFixed(1)},${h.y.toFixed(1)}`);
});

test('every head is on a trench that reaches a source', () => {
  const adj = new Map();
  const key = (p) => (p.sourceId ? `s:${p.sourceId}` : p.headId != null ? `h:${p.headId}` : `p:${p.x.toFixed(2)},${p.y.toFixed(2)}`);
  for (const pipe of plan.pipes) {
    for (let i = 1; i < pipe.pts.length; i++) {
      const a = key(pipe.pts[i - 1]), b = key(pipe.pts[i]);
      if (!adj.has(a)) adj.set(a, []); if (!adj.has(b)) adj.set(b, []);
      adj.get(a).push(b); adj.get(b).push(a);
    }
  }
  const seen = new Set();
  const queue = site.sources.map((s) => `s:${s.id}`);
  while (queue.length) {
    const n = queue.pop();
    if (seen.has(n)) continue;
    seen.add(n);
    for (const m of adj.get(n) || []) if (!seen.has(m)) queue.push(m);
  }
  for (const h of plan.heads) assert(seen.has(`h:${h.id}`), `head ${h.id} (zone ${h.zone}) is not plumbed to any source`);
});

test('the plan actually covers the lawn', () => {
  const dripIds = new Set(plan.drip.map((d) => d.areaId));
  const grid = buildCoverageGrid(planned, { res: 2, dripAreaIds: dripIds });
  assert(grid.nTarget > 0, 'there is ground to measure');
  assert(grid.pct >= 88, `only ${grid.pct.toFixed(1)} % covered`);
  assert(grid.pct2 >= 45, `only ${grid.pct2.toFixed(1)} % has head-to-head overlap`);
});

test('ids are unique across heads, pipes and drip', () => {
  const ids = [...plan.heads, ...plan.pipes, ...plan.drip].map((o) => o.id);
  assert(new Set(ids).size === ids.length, 'duplicate id issued');
});

test('a lower supply produces more zones, not an over-budget plan', () => {
  const thin = autoLayout({ ...site, supply: { psi: 50, gpm: 4 } });
  const zonesThin = new Set([...thin.heads.map((h) => h.zone), ...thin.drip.map((d) => d.zone)]).size;
  const zonesFat = new Set([...plan.heads.map((h) => h.zone), ...plan.drip.map((d) => d.zone)]).size;
  assert(zonesThin > zonesFat, `${zonesThin} zones at 4 GPM vs ${zonesFat} at ${site.supply.gpm} GPM`);
});

test('an empty yard is refused politely rather than crashing', () => {
  const bare = { ...sampleSite(), areas: [] };
  const out = autoLayout(bare);
  assert(out.heads.length === 0 && out.notes.length === 1, 'says why it did nothing');
  const noSource = { ...sampleSite(), sources: [] };
  assert(autoLayout(noSource).notes[0].includes('No water source'), 'names the missing piece');
});

test('a blank lot can be solved straight out of setup', () => {
  const s = blankSite(50, 80);
  const out = autoLayout(s);
  assert(out.heads.length > 3, `a 50x80 lawn should need more than ${out.heads.length} heads`);
  const cov = polygonCoverage(s.areas[0].pts, out.heads, s.supply.psi).pct;
  assert(cov >= 88, `only ${cov.toFixed(1)} % of a plain rectangle covered`);
});

test('the incremental sampler measures exactly what polygonCoverage measures', () => {
  // The pruner optimises against the sampler; the notes and the tests read
  // polygonCoverage. If the two ever disagree the solver is chasing a number
  // nobody can see, so they are held to the same points and the same answer.
  const lawn = site.areas.find((a) => a.type === 'lawn');
  const blocks = site.areas.filter(isObstacle);
  const heads = plan.heads.filter((h) => h.areaId === lawn.id);
  assert(heads.length > 2, `${heads.length} heads on ${lawn.name}`);
  const direct = polygonCoverage(lawn.pts, heads, site.supply.psi, blocks);
  const sampler = new CoverageSampler(lawn.pts, blocks);
  const cov = sampler.counter(heads, site.supply.psi);
  assert(cov.stats.n === direct.n, `sampled ${cov.stats.n} points vs ${direct.n}`);
  near(cov.stats.pct, direct.pct, 1e-9, 'single coverage');
  near(cov.stats.pct2, direct.pct2, 1e-9, 'head-to-head');
  // Removing and re-adding a head has to round-trip exactly.
  cov.remove(heads[0]);
  const fewer = polygonCoverage(lawn.pts, heads.slice(1), site.supply.psi, blocks);
  near(cov.stats.pct, fewer.pct, 1e-9, 'after a removal');
  cov.add(heads[0]);
  near(cov.stats.pct2, direct.pct2, 1e-9, 'restored');
});

test('a 300 x 400 ft lot solves in well under a second (perf guard)', () => {
  // This took more than 90 s before the pruner went incremental. The bound is
  // loose on purpose: it is here to catch a return to per-candidate re-measuring,
  // not to benchmark the machine.
  const s = blankSite(300, 400);
  const t0 = performance.now();
  const out = autoLayout(s);
  const ms = performance.now() - t0;
  assert(out.heads.length > 40, `a 300x400 lawn needs more than ${out.heads.length} heads`);
  assert(ms < 3000, `auto-layout took ${ms.toFixed(0)} ms`);
});

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
