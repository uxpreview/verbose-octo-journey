/* The auto-layout: turn a drawn yard into a working sprinkler plan.
 *
 * The version of this tool that modelled one property had a "recommended
 * layout" that was a literal list of thirty-four hand-typed coordinates. It was
 * a drawing of an answer, not a method, and it could not survive the yard
 * changing by a foot. This file is the method.
 *
 *   1. size the nozzle to the shape           — how wide is the narrowest part?
 *   2. ring the perimeter, then fill the middle — corners, edges, interior
 *   3. drop what the ground does not want      — heads inside the patio, the house
 *   4. prune whatever earns nothing            — greedy, measured against coverage
 *   5. pack heads into zones under the flow budget
 *   6. drip the beds, which are not a throw problem
 *   7. trench each zone as a minimum spanning tree that would rather not go
 *      under the house
 *
 * Every stage records what it did in `notes`, because a plan you cannot argue
 * with is a plan you should not dig. */

import {
  dist, clamp, deg, rad, pointInPoly, polyArea, centroid, bounds,
  distToBoundary, nearestOnSegment, segmentCrossesPoly, offsetCorners, aimVec,
} from './geometry.js';
import { HEAD_TYPES, headGpm, dripGpm, dripTubingFt, effectiveRadius } from './hydraulics.js';
import { isIrrigable, isObstacle, newId, peekId } from './site.js';
import { polygonCoverage, CoverageSampler } from './coverage.js';

/** Fraction of the measured supply a single zone is allowed to draw. Sizing a
 *  zone at 100 % of a bucket test is how you get a zone that browns out the
 *  last head on a hot afternoon. */
export const FLOW_SAFETY = 0.85;
/** Practical ceiling per valve, regardless of flow. Past this a zone is hard to
 *  balance and hard to fault-find. */
export const MAX_HEADS_PER_ZONE = 14;
/** The fewest full-circle heads a zone should be able to carry. A nozzle that
 *  can only run one or two at a time on this supply is the wrong nozzle for
 *  this supply, however well it fits the ground: a designer with a small meter
 *  runs more, smaller heads per valve rather than one big rotor at a time. */
export const MIN_HEADS_PER_ZONE = 3;
/** Coverage the pruner refuses to fall below when dropping a head. */
export const MIN_COVERAGE_PCT = 95;
/** How much head-to-head overlap the pruner may trade away, in percentage
 *  points. Small on purpose: the overlap is the design, not slack in it. */
export const MAX_OVERLAP_LOSS_PCT = 4;

const bearingOf = (v) => ((deg(Math.atan2(v.x, v.y)) + 360) % 360);
const norm = (v) => { const L = Math.hypot(v.x, v.y) || 1; return { x: v.x / L, y: v.y / L }; };

/* --- 1. Nozzle sizing --------------------------------------------------- */

/** The radius of the largest circle that fits inside the polygon, found by
 *  sampling. This is the honest measure of "how wide is this piece of lawn",
 *  and it is what decides between a rotor and a spray head — area alone would
 *  put a rotor on a long thin side yard and soak the siding. */
export function inradius(poly, blocks = [], res = 1.5) {
  const b = bounds(poly);
  let best = 0;
  for (let y = b.minY; y <= b.maxY; y += 1 / res) {
    for (let x = b.minX; x <= b.maxX; x += 1 / res) {
      const p = { x, y };
      if (!pointInPoly(p, poly)) continue;
      if (blocks.some((a) => pointInPoly(p, a.pts))) continue;
      const d = distToBoundary(p, poly);
      if (d > best) best = d;
    }
  }
  return best;
}

/** Pick a nozzle family and a throw for a piece of ground.
 *  `prefer` of 'auto' lets the shape decide; anything else forces the family
 *  and only the radius is fitted. `budget` is the per-zone flow: the throw is
 *  stepped down until at least MIN_HEADS_PER_ZONE full-circle heads fit a
 *  zone, and if the family cannot get there at its shortest throw the next
 *  family down is tried (unless the family was forced). */
export function pickNozzle(poly, { prefer = 'auto', blocks = [], psi = 50, budget = Infinity } = {}) {
  const inr = inradius(poly, blocks);
  const width = inr * 2;
  let type = prefer;
  if (prefer === 'auto') {
    if (width >= 42) type = 'rotor';
    else if (width >= 16) type = 'mp';
    else type = 'spray';
  }
  const perHead = budget / MIN_HEADS_PER_ZONE;
  const fit = (family) => {
    const t = HEAD_TYPES[family];
    // Aim for a throw that spans the narrow direction in one or two hops, then
    // clamp into what the family can actually do at this pressure.
    const wanted = width >= 2 * t.max ? t.max : Math.max(t.min, width / 2);
    let radius = clamp(wanted, t.min, t.max);
    // Then shrink until the supply can run a few of them at once. Flow goes as
    // radius squared, so this converges fast; the loop is only for the clamp.
    while (radius > t.min && headGpm({ type: family, radius, arc: 360 }, psi) > perHead) radius = Math.max(t.min, radius - 0.5);
    const gpm = headGpm({ type: family, radius, arc: 360 }, psi);
    return { type: family, radius: Math.round(radius * 2) / 2, fits: gpm <= perHead + 1e-9, gpm };
  };
  let pick = fit(type);
  if (!pick.fits && prefer === 'auto') {
    // Step down the family ladder until one fits; if none does, the smallest
    // spray is the honest answer and the zone count says the rest.
    for (const family of ['mp', 'spray']) {
      if (family === type) continue;
      const alt = fit(family);
      if (alt.fits || alt.gpm < pick.gpm) pick = alt;
      if (alt.fits) break;
    }
  }
  return { type: pick.type, radius: pick.radius, inradius: inr, psiRadius: effectiveRadius({ type: pick.type, radius: pick.radius }, psi), budgeted: pick.fits };
}

/* --- 2. Placement ------------------------------------------------------- */

const signedArea = (poly) => {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j].x * poly[i].y - poly[i].x * poly[j].y;
  return a / 2;
};

/** Unit vector pointing into the polygon from the edge a→b. */
function inwardNormal(a, b, ccw) {
  const d = norm({ x: b.x - a.x, y: b.y - a.y });
  return ccw ? { x: -d.y, y: d.x } : { x: d.y, y: -d.x };
}

/** Interior angle at vertex i, in degrees, and the bisector pointing inwards.
 *  Found by construction and then verified against the polygon, so it is right
 *  for reflex corners too — an L-shaped lawn has at least one. */
function cornerGeometry(poly, i) {
  const v = poly[i], p = poly[(i - 1 + poly.length) % poly.length], n = poly[(i + 1) % poly.length];
  const u = norm({ x: p.x - v.x, y: p.y - v.y });
  const w = norm({ x: n.x - v.x, y: n.y - v.y });
  let bis = norm({ x: u.x + w.x, y: u.y + w.y });
  if (!Math.hypot(u.x + w.x, u.y + w.y)) bis = { x: -u.y, y: u.x }; // straight-through vertex
  const theta = deg(Math.acos(clamp(u.x * w.x + u.y * w.y, -1, 1)));
  const probe = { x: v.x + bis.x * 0.35, y: v.y + bis.y * 0.35 };
  const inside = pointInPoly(probe, poly);
  if (!inside) bis = { x: -bis.x, y: -bis.y };
  return { bisector: bis, interior: inside ? theta : 360 - theta };
}

/** Ring the boundary, then fill the middle on a triangular lattice.
 *  Head-to-head spacing — every head reaching its neighbour — is the whole
 *  trick. It is why sprinklers look absurdly overlapped on paper and why
 *  anything less leaves dry rings you cannot fix by turning up the water. */
export function placeHeads(poly, nozzle, { blocks = [], inset = 0.75 } = {}) {
  const R = nozzle.radius;
  const ccw = signedArea(poly) > 0;
  const heads = [];
  const blocked = (p) => blocks.some((a) => pointInPoly(p, a.pts)) || !pointInPoly(p, poly);

  // Corners: arc matched to the interior angle, aimed down the bisector.
  for (let i = 0; i < poly.length; i++) {
    const { bisector, interior } = cornerGeometry(poly, i);
    const back = inset / Math.max(0.25, Math.sin(rad(Math.min(interior, 180) / 2)));
    const p = { x: poly[i].x + bisector.x * back, y: poly[i].y + bisector.y * back };
    if (blocked(p)) continue;
    heads.push({ x: p.x, y: p.y, type: nozzle.type, radius: R, arc: Math.round(clamp(interior, 45, 360) / 5) * 5, aim: Math.round(bearingOf(bisector)), role: 'corner' });
  }

  // Edges: half-circles facing in, spaced so neighbours reach each other.
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const L = dist(a, b);
    const k = Math.max(0, Math.ceil(L / R) - 1);
    if (!k) continue;
    const nrm = inwardNormal(a, b, ccw);
    for (let j = 1; j <= k; j++) {
      const t = j / (k + 1);
      const p = { x: a.x + (b.x - a.x) * t + nrm.x * inset, y: a.y + (b.y - a.y) * t + nrm.y * inset };
      if (blocked(p)) continue;
      heads.push({ x: p.x, y: p.y, type: nozzle.type, radius: R, arc: 180, aim: Math.round(bearingOf(nrm)), role: 'edge' });
    }
  }

  // Interior: full circles where the perimeter ring cannot reach.
  const rowStep = R * Math.sqrt(3) / 2;
  const b = bounds(poly);
  let row = 0;
  for (let y = b.minY + rowStep / 2; y <= b.maxY; y += rowStep, row++) {
    const offset = row % 2 ? R / 2 : 0;
    for (let x = b.minX + offset; x <= b.maxX; x += R) {
      const p = { x, y };
      if (blocked(p)) continue;
      if (distToBoundary(p, poly) < R * 0.8) continue;
      if (heads.some((h) => dist(h, p) < R * 0.6)) continue;
      heads.push({ x, y, type: nozzle.type, radius: R, arc: 360, aim: 0, role: 'interior' });
    }
  }
  return heads;
}

/* --- 4. Pruning --------------------------------------------------------- */

/** Drop every head the plan does not miss.
 *
 * Greedy and deliberately cautious: heads are tried cheapest-first (smallest
 * flow, so the pruner prefers keeping the ones that were expensive to buy),
 * and one is only removed if coverage of this polygon stays at or above the
 * floor. It is not optimal — set cover is NP-hard and a yard does not deserve
 * a branch-and-bound — but it reliably removes the 20-30 % of placements that
 * the corner and edge passes double up on. */
export function pruneHeads(poly, heads, { psi = 50, blocks = [], floor = MIN_COVERAGE_PCT, overlapLoss = MAX_OVERLAP_LOSS_PCT } = {}) {
  if (heads.length < 2) {
    const c = polygonCoverage(poly, heads, psi, blocks);
    return { heads, removed: 0, coverage: { pct: c.pct, pct2: c.pct2 } };
  }
  // One sampling of the ground, then every trial removal costs one head's
  // footprint rather than a re-measure of the whole polygon.
  const sampler = new CoverageSampler(poly, blocks);
  const cov = sampler.counter(heads, psi);
  const floorPct = Math.min(floor, cov.stats.pct ?? 0);
  const floorPct2 = Math.max(0, (cov.stats.pct2 ?? 0) - overlapLoss);
  const kept = new Set(heads);
  // Cheapest first, so the pruner spends its budget on the heads that were
  // least useful to buy rather than on whichever one it happened to see first.
  const order = [...heads].sort((a, b) => headGpm(a, psi) - headGpm(b, psi));
  let removed = 0;
  for (const h of order) {
    if (kept.size <= 2) break;
    cov.remove(h);
    if ((cov.stats.pct ?? 0) >= floorPct - 0.25 && (cov.stats.pct2 ?? 0) >= floorPct2) { kept.delete(h); removed++; }
    else cov.add(h);
  }
  return { heads: heads.filter((h) => kept.has(h)), removed, coverage: { pct: cov.stats.pct, pct2: cov.stats.pct2 } };
}

/* --- 5. Zoning ---------------------------------------------------------- */

/** Nearest-neighbour chain from the point nearest `start`. Keeps a zone
 *  contiguous, which is what makes the trench short and the fault-finding
 *  possible: zone 3 is a place in the yard, not a scattering. */
export function chainByProximity(items, start) {
  const left = [...items];
  const chain = [];
  let cur = start;
  while (left.length) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < left.length; i++) { const d = dist(cur, left[i]); if (d < bd) { bd = d; bi = i; } }
    cur = left[bi];
    chain.push(cur);
    left.splice(bi, 1);
  }
  return chain;
}

/** Greedy bin packing under a flow budget, walking the chain in order so each
 *  zone stays in one part of the yard. */
export function packZones(chain, gpmOf, budget, maxPerZone = MAX_HEADS_PER_ZONE) {
  const zones = [];
  let cur = [], curGpm = 0;
  for (const item of chain) {
    const g = gpmOf(item);
    const wouldOverflow = cur.length && (curGpm + g > budget || cur.length >= maxPerZone);
    if (wouldOverflow) { zones.push(cur); cur = []; curGpm = 0; }
    cur.push(item);
    curGpm += g;
  }
  if (cur.length) zones.push(cur);
  return zones;
}

/** Even out a packing without adding a valve.
 *
 * `packZones` is greedy and, for a fixed chain, greedy is optimal for the
 * *number* of zones — but it fills each zone to the brim and leaves the
 * remainder in the last one, so a 40-head yard comes out 14 / 14 / 11 / 1: a
 * single head on its own valve, which is a real solenoid, a real wire run and
 * a real controller station for nothing. This keeps the zone count and the
 * chain order, and re-cuts the chain into that many contiguous runs so that
 * the busiest zone draws as little as possible. It is the classic linear
 * partition, solved exactly by dynamic programming — cheap at the size of a
 * yard. The zone count itself is not negotiable here: it is whatever the flow
 * budget and the head cap force. */
export function balanceZones(chain, gpmOf, budget, maxPerZone = MAX_HEADS_PER_ZONE) {
  const greedy = packZones(chain, gpmOf, budget, maxPerZone);
  const K = greedy.length, n = chain.length;
  if (K < 2 || n < 2) return greedy;
  const g = chain.map(gpmOf);
  const pre = [0];
  for (const v of g) pre.push(pre[pre.length - 1] + v);
  const sum = (j, i) => pre[i] - pre[j]; // flow of items j..i-1
  // best[k][i]: least possible "busiest zone" for the first i items in k zones;
  // cut[k][i]: where the last zone starts.
  const INF = Infinity;
  const best = Array.from({ length: K + 1 }, () => new Float64Array(n + 1).fill(INF));
  const cut = Array.from({ length: K + 1 }, () => new Int32Array(n + 1).fill(-1));
  best[0][0] = 0;
  for (let k = 1; k <= K; k++) {
    for (let i = 1; i <= n; i++) {
      for (let j = Math.max(k - 1, i - maxPerZone); j < i; j++) {
        if (best[k - 1][j] === INF) continue;
        const v = Math.max(best[k - 1][j], sum(j, i));
        if (v < best[k][i]) { best[k][i] = v; cut[k][i] = j; }
      }
    }
  }
  // Greedy already found a feasible K-way cut, so this cannot fail; if it ever
  // does, the greedy answer is still a valid plan.
  if (best[K][n] === INF || best[K][n] > budget + 1e-9) return greedy;
  const zones = [];
  for (let k = K, i = n; k > 0; k--) { const j = cut[k][i]; zones.unshift(chain.slice(j, i)); i = j; }
  return zones;
}

/** Zone the heads: try a chain from every source, keep whichever needs the
 *  fewest valves (then the lowest peak flow), and balance it. */
export function zoneHeads(heads, sources, gpmOf, budget, maxPerZone = MAX_HEADS_PER_ZONE) {
  let bestZones = null, bestPeak = Infinity;
  const starts = sources.length ? sources : [{ x: 0, y: 0 }];
  for (const start of starts) {
    const zones = balanceZones(chainByProximity(heads, start), gpmOf, budget, maxPerZone);
    const peak = Math.max(0, ...zones.map((z) => z.reduce((t, h) => t + gpmOf(h), 0)));
    if (!bestZones || zones.length < bestZones.length || (zones.length === bestZones.length && peak < bestPeak)) {
      bestZones = zones; bestPeak = peak;
    }
  }
  return bestZones;
}

/* --- 7. Trenching ------------------------------------------------------- */

/** How much longer a run is allowed to look when it crosses paving. A walk can
 *  be sleeved or bored under; a driveway is a real job. It is a price, not a
 *  wall — the router still crosses paving when going round would be absurd. */
export const PAVING_FACTOR = 1.8;
/** How far a routed trench turns clear of a building's corner, in feet. */
export const CORNER_MARGIN = 1.5;

/** Routes a trench between two points without going under a building.
 *
 * The straight line is used whenever it stays out of every structure. When it
 * would go through one, the run is bent around it: the corners of every
 * building, pushed out by a small margin, form a visibility graph, and the
 * shortest path through it is the route. That is the standard answer to
 * shortest-path-around-obstacles and at the size of a yard it is instant.
 * Paving is not an obstacle here, only a price — see PAVING_FACTOR.
 *
 * Built once per trenching pass so the corner-to-corner visibility is
 * computed once and shared by every query. */
export class TrenchRouter {
  constructor(structures = [], paving = [], margin = CORNER_MARGIN) {
    this.structures = structures;
    this.paving = paving;
    // Corner nodes: every building's offset corners, dropping any that land
    // inside another building (two touching structures) since a trench cannot
    // turn there.
    this.corners = [];
    for (const st of structures) {
      for (const c of offsetCorners(st.pts, margin)) {
        if (structures.some((o) => pointInPoly(c, o.pts))) continue;
        this.corners.push(c);
      }
    }
    const n = this.corners.length;
    this.cc = new Float64Array(n * n).fill(Infinity);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const w = this.leg(this.corners[i], this.corners[j]);
        this.cc[i * n + j] = w; this.cc[j * n + i] = w;
      }
    }
  }

  blocked(a, b) { return this.structures.some((st) => segmentCrossesPoly(a, b, st.pts)); }

  /** Cost of one straight leg, or Infinity if it goes under a building. */
  leg(a, b) {
    if (this.blocked(a, b)) return Infinity;
    const L = dist(a, b);
    return this.paving.some((pv) => segmentCrossesPoly(a, b, pv.pts)) ? L * PAVING_FACTOR : L;
  }

  /** @returns {{pts: Array<{x:number,y:number}>, cost: number, routed: boolean}} */
  route(a, b) {
    const direct = this.leg(a, b);
    if (direct < Infinity) return { pts: [a, b], cost: direct, routed: false };
    const n = this.corners.length;
    if (!n) return { pts: [a, b], cost: dist(a, b) * 8, routed: false };
    // Dijkstra over a, the corners, and b. Nodes 0..n-1 are corners, n is a,
    // n+1 is b. Small enough that a plain array scan beats a heap.
    const N = n + 2, A = n, B = n + 1;
    const cost = new Float64Array(N).fill(Infinity);
    const prev = new Int32Array(N).fill(-1);
    const done = new Uint8Array(N);
    const fromA = this.corners.map((c) => this.leg(a, c));
    const toB = this.corners.map((c) => this.leg(c, b));
    cost[A] = 0;
    for (;;) {
      let u = -1;
      for (let i = 0; i < N; i++) if (!done[i] && cost[i] < Infinity && (u < 0 || cost[i] < cost[u])) u = i;
      if (u < 0 || u === B) break;
      done[u] = 1;
      const relax = (v, w) => { if (w < Infinity && cost[u] + w < cost[v]) { cost[v] = cost[u] + w; prev[v] = u; } };
      if (u === A) { for (let j = 0; j < n; j++) relax(j, fromA[j]); }
      else { for (let j = 0; j < n; j++) relax(j, this.cc[u * n + j]); relax(B, toB[u]); }
    }
    if (cost[B] === Infinity) {
      // Boxed in — a source inside a courtyard, say. Draw it straight and
      // price it as the tunnelling job it would be, so the tree avoids it if
      // it possibly can.
      return { pts: [a, b], cost: dist(a, b) * 8, routed: false };
    }
    const pts = [b];
    for (let v = prev[B]; v !== A && v >= 0; v = prev[v]) pts.unshift(this.corners[v]);
    pts.unshift(a);
    return { pts, cost: cost[B], routed: true };
  }
}

/** Prim's minimum spanning tree from the source out to every head in the zone.
 *
 * Every edge is a routed trench, so its weight is the length you would
 * actually dig — round the house, priced up across paving — and the tree
 * chooses its topology on that basis. The result is a list of polylines, each
 * from a node in the tree to a new node, with the corner turns included. */
export function trenchTree(source, heads, { structures = [], paving = [], router } = {}) {
  const nodes = [{ x: source.x, y: source.y, sourceId: source.id }, ...heads];
  const R = router ?? new TrenchRouter(structures, paving);
  // Textbook Prim: every node outside the tree remembers its cheapest link
  // into it, and each newly added node offers itself to the rest once. That is
  // O(n²) route evaluations in total, rather than re-scoring every
  // tree × outside pair on every step.
  const n = nodes.length;
  const inTree = new Uint8Array(n);
  const key = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  const via = new Array(n).fill(null);
  const edges = [];
  let cur = 0;
  inTree[0] = 1;
  for (let added = 1; added < n; added++) {
    for (let j = 1; j < n; j++) {
      if (inTree[j]) continue;
      const r = R.route(nodes[cur], nodes[j]);
      if (r.cost < key[j]) { key[j] = r.cost; parent[j] = cur; via[j] = r.pts; }
    }
    let best = -1;
    for (let j = 1; j < n; j++) if (!inTree[j] && (best < 0 || key[j] < key[best])) best = j;
    if (best < 0) break;
    inTree[best] = 1;
    edges.push([parent[best], best, via[best]]);
    cur = best;
  }
  const ref = (n) => (n.sourceId ? { x: n.x, y: n.y, sourceId: n.sourceId } : { x: n.x, y: n.y, headId: n.id });
  return edges.map(([i, j, pts]) => [ref(nodes[i]), ...pts.slice(1, -1).map((p) => ({ x: p.x, y: p.y })), ref(nodes[j])]);
}

/* --- The whole thing ---------------------------------------------------- */

/**
 * @param {object} state    a site with areas, sources and a supply
 * @param {object} [opts]
 * @param {string} [opts.nozzle]   'auto' | 'spray' | 'rotor' | 'mp'
 * @param {boolean}[opts.dripBeds] run beds on drip rather than spray
 * @returns {{heads:Array, pipes:Array, drip:Array, notes:string[]}}
 */
export function autoLayout(state, opts = {}) {
  const { nozzle: prefer = 'auto', dripBeds = true } = opts;
  const psi = state.supply.psi;
  const budget = Math.max(0.5, state.supply.gpm * FLOW_SAFETY);
  const notes = [];

  const blocks = state.areas.filter(isObstacle);
  const structures = state.areas.filter((a) => a.type === 'structure');
  const paving = state.areas.filter((a) => a.type === 'hardscape');
  const targets = state.areas.filter(isIrrigable);
  const lawns = targets.filter((a) => a.type === 'lawn');
  const beds = targets.filter((a) => a.type === 'bed');
  const sprayed = dripBeds ? lawns : targets;

  if (!targets.length) {
    return { heads: [], pipes: [], drip: [], notes: ['Nothing to water yet — draw a lawn or a bed first.'] };
  }
  if (!state.sources.length) {
    return { heads: [], pipes: [], drip: [], notes: ['No water source. Add a hose bib before generating a layout.'] };
  }

  notes.push(`Sizing every zone to ${budget.toFixed(1)} GPM — ${Math.round(FLOW_SAFETY * 100)} % of the ${state.supply.gpm} GPM supply, at ${psi} PSI.`);

  // --- heads, area by area ---
  const placed = [];
  for (const area of sprayed) {
    if (polyArea(area.pts) < 12) continue; // a strip this small is a watering can
    const noz = pickNozzle(area.pts, { prefer, blocks, psi, budget });
    if (!noz.budgeted) notes.push(`${area.name}: even a ${noz.radius} ft ${HEAD_TYPES[noz.type].label.toLowerCase()} draws more than a third of a zone on this supply — expect small zones, or measure the flow again.`);
    const raw = placeHeads(area.pts, noz, { blocks });
    if (!raw.length) { notes.push(`${area.name}: too tight for a head at ${noz.radius} ft — left dry.`); continue; }
    const { heads: kept, removed, coverage: cov } = pruneHeads(area.pts, raw, { psi, blocks });
    for (const h of kept) { h.areaId = area.id; h.areaName = area.name; }
    placed.push(...kept);
    notes.push(
      `${area.name} (${Math.round(polyArea(area.pts)).toLocaleString()} sq ft, ${(noz.inradius * 2).toFixed(0)} ft across at the widest): ` +
      `${kept.length} x ${HEAD_TYPES[noz.type].label.toLowerCase()} at ${noz.radius} ft` +
      `${removed ? `, ${removed} redundant head${removed > 1 ? 's' : ''} pruned` : ''} — ` +
      `${cov.pct.toFixed(0)} % covered, ${cov.pct2.toFixed(0)} % head-to-head.`
    );
  }

  // --- zones ---
  const primary = state.sources[0];
  const groups = zoneHeads(placed, state.sources, (h) => headGpm(h, psi), budget);

  const heads = [];
  groups.forEach((group, i) => {
    for (const h of group) heads.push({ ...h, id: newId(), zone: i + 1, radius: h.radius, arc: h.arc, aim: h.aim });
  });

  // --- drip for the beds ---
  const drip = [];
  let zoneNo = groups.length;
  if (dripBeds && beds.length) {
    const withArea = beds.map((b) => ({ ...b, sqft: polyArea(b.pts), c: centroid(b.pts) }));
    const bedChain = chainByProximity(withArea.map((b) => ({ ...b.c, bed: b })), primary).map((p) => p.bed);
    const bedZones = packZones(bedChain, (b) => dripGpm(b.sqft), budget, 99);
    for (const group of bedZones) {
      zoneNo++;
      for (const b of group) {
        drip.push({ id: newId(), zone: zoneNo, areaId: b.id, name: b.name, sqft: b.sqft, gpm: dripGpm(b.sqft), tubingFt: dripTubingFt(b.sqft) });
      }
    }
    const totalBed = withArea.reduce((s, b) => s + b.sqft, 0);
    notes.push(`${beds.length} bed${beds.length > 1 ? 's' : ''} (${Math.round(totalBed).toLocaleString()} sq ft) on drip line, ${bedZones.length} zone${bedZones.length > 1 ? 's' : ''} — ${dripGpm(totalBed).toFixed(1)} GPM and about ${Math.round(dripTubingFt(totalBed))} ft of tubing. Drip needs its own filter and a 25 PSI regulator.`);
  }

  // --- trenches ---
  const pipes = [];
  const byZone = new Map();
  for (const h of heads) { if (!byZone.has(h.zone)) byZone.set(h.zone, []); byZone.get(h.zone).push(h); }
  const router = new TrenchRouter(structures, paving);
  for (const [zone, group] of byZone) {
    const c = centroid(group);
    const src = state.sources.reduce((best, s) => (dist(s, c) < dist(best, c) ? s : best), state.sources[0]);
    for (const pts of trenchTree(src, group, { router })) {
      pipes.push({ id: newId(), zone, pts });
    }
  }
  // Drip zones get the same treatment: one tree per zone reaching each bed's
  // centre, rather than a star of straight lines from the bib through the house.
  const dripByZone = new Map();
  for (const d of drip) {
    const area = state.areas.find((a) => a.id === d.areaId);
    if (!area) continue;
    if (!dripByZone.has(d.zone)) dripByZone.set(d.zone, []);
    dripByZone.get(d.zone).push({ ...centroid(area.pts), id: d.id });
  }
  for (const [zone, group] of dripByZone) {
    const c = centroid(group);
    const src = state.sources.reduce((best, s) => (dist(s, c) < dist(best, c) ? s : best), state.sources[0]);
    for (const pts of trenchTree(src, group, { router })) {
      const last = pts.length - 1;
      pipes.push({ id: newId(), zone, pts: pts.map((p, i) => (i === last ? { x: p.x, y: p.y } : p)), drip: true });
    }
  }

  const zoneCount = zoneNo;
  notes.push(`${heads.length} heads and ${zoneCount} zone${zoneCount > 1 ? 's' : ''}. A controller needs at least ${zoneCount} station${zoneCount > 1 ? 's' : ''}; buy the next size up.`);
  if (state.sources.length === 1) notes.push('Everything is fed from one source. A second bib on the far side of the house would halve the longest trench.');

  return { heads, pipes, drip, notes, nextId: peekId() };
}
