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
  distToBoundary, nearestOnSegment, segmentCrossesPoly, aimVec,
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
 *  and only the radius is fitted. */
export function pickNozzle(poly, { prefer = 'auto', blocks = [], psi = 50 } = {}) {
  const inr = inradius(poly, blocks);
  const width = inr * 2;
  let type = prefer;
  if (prefer === 'auto') {
    if (width >= 42) type = 'rotor';
    else if (width >= 16) type = 'mp';
    else type = 'spray';
  }
  const t = HEAD_TYPES[type];
  // Aim for a throw that spans the narrow direction in one or two hops, then
  // clamp into what the family can actually do at this pressure.
  const wanted = width >= 2 * t.max ? t.max : Math.max(t.min, width / 2);
  const radius = Math.round(clamp(wanted, t.min, t.max) * 2) / 2;
  return { type, radius, inradius: inr, psiRadius: effectiveRadius({ type, radius }, psi) };
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

/* --- 7. Trenching ------------------------------------------------------- */

/** Prim's minimum spanning tree from the source out to every head in the zone.
 *
 * The edge weight is length times a penalty for what the trench would have to
 * cross, so the tree routes around the house rather than proposing that you
 * tunnel under a foundation. It is a preference, not a guarantee: on a plan
 * where the only path is through, the penalty is paid and the run is drawn
 * honestly rather than hidden. */
export function trenchTree(source, heads, { structures = [], paving = [] } = {}) {
  const nodes = [{ x: source.x, y: source.y, sourceId: source.id }, ...heads];
  const weight = (a, b) => {
    let w = dist(a, b);
    if (structures.some((s) => segmentCrossesPoly(a, b, s.pts))) w *= 8;
    else if (paving.some((s) => segmentCrossesPoly(a, b, s.pts))) w *= 1.8;
    return w;
  };
  // Textbook Prim: every node outside the tree remembers its cheapest link
  // into it, and each newly added node offers itself to the rest once. That is
  // O(n²) weight evaluations in total, rather than re-scoring every
  // tree × outside pair on every step.
  const n = nodes.length;
  const inTree = new Uint8Array(n);
  const key = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  const edges = [];
  let cur = 0;
  inTree[0] = 1;
  for (let added = 1; added < n; added++) {
    for (let j = 1; j < n; j++) {
      if (inTree[j]) continue;
      const w = weight(nodes[cur], nodes[j]);
      if (w < key[j]) { key[j] = w; parent[j] = cur; }
    }
    let best = -1;
    for (let j = 1; j < n; j++) if (!inTree[j] && (best < 0 || key[j] < key[best])) best = j;
    if (best < 0) break;
    inTree[best] = 1;
    edges.push([parent[best], best]);
    cur = best;
  }
  const ref = (n) => (n.sourceId ? { x: n.x, y: n.y, sourceId: n.sourceId } : { x: n.x, y: n.y, headId: n.id });
  return edges.map(([i, j]) => [ref(nodes[i]), ref(nodes[j])]);
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
    const noz = pickNozzle(area.pts, { prefer, blocks, psi });
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
  const chain = chainByProximity(placed, primary);
  const groups = packZones(chain, (h) => headGpm(h, psi), budget);

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
  for (const [zone, group] of byZone) {
    const c = centroid(group);
    const src = state.sources.reduce((best, s) => (dist(s, c) < dist(best, c) ? s : best), state.sources[0]);
    for (const [a, b] of trenchTree(src, group, { structures, paving })) {
      pipes.push({ id: newId(), zone, pts: [a, b] });
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
    for (const [a, b] of trenchTree(src, group, { structures, paving })) {
      pipes.push({ id: newId(), zone, pts: [{ x: a.x, y: a.y, sourceId: a.sourceId }, { x: b.x, y: b.y }], drip: true });
    }
  }

  const zoneCount = zoneNo;
  notes.push(`${heads.length} heads and ${zoneCount} zone${zoneCount > 1 ? 's' : ''}. A controller needs at least ${zoneCount} station${zoneCount > 1 ? 's' : ''}; buy the next size up.`);
  if (state.sources.length === 1) notes.push('Everything is fed from one source. A second bib on the far side of the house would halve the longest trench.');

  return { heads, pipes, drip, notes, nextId: peekId() };
}
