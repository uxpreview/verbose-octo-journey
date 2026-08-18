/* Coverage: how much of the ground that wants water actually gets it.
 *
 * One grid, three consumers — the map paints it, the auto-layout prunes
 * against it, and the tests assert on it. Keeping a single implementation is
 * the point: a solver that optimises against a different coverage measure than
 * the one on screen will confidently produce a plan that looks wrong.
 *
 * The grid is in plan feet with the origin at the lot's bottom-left. Cell
 * values are the number of heads reaching that cell, or NOT_TARGET for ground
 * nobody is trying to water (paving, buildings, rough, and everything outside
 * the drawn areas). */

import { pointInPoly, inSector, bounds } from './geometry.js';
import { isIrrigable, isObstacle } from './site.js';
import { effectiveRadius } from './hydraulics.js';

export const NOT_TARGET = -1;
/** Internal marker for a drip-fed cell while the grid is being built. */
const DRIP = -2;

/**
 * @param {object} state
 * @param {object} [opts]
 * @param {number} [opts.res]      cells per foot; 3 for display, 1.5 for solving
 * @param {Array}  [opts.heads]    override the head list (used when testing a candidate set)
 * @param {Set}    [opts.dripAreaIds] bed ids on a drip zone: counted as covered, twice over
 * @param {Set}    [opts.targetAreaIds] limit the measured ground to these areas.
 *                 Used when one zone is in focus, so the wash answers "does
 *                 this zone cover what it is responsible for" rather than
 *                 painting the whole yard red for ground it was never given.
 */
export function buildCoverageGrid(state, opts = {}) {
  const res = opts.res ?? 3;
  const heads = opts.heads ?? state.heads;
  const dripIds = opts.dripAreaIds ?? new Set();
  const psi = state.supply.psi;

  const b = bounds(state.site.lot);
  const minX = b.minX - 2, maxX = b.maxX + 2, minY = b.minY - 2, maxY = b.maxY + 2;
  const w = Math.max(1, Math.ceil((maxX - minX) * res));
  const h = Math.max(1, Math.ceil((maxY - minY) * res));

  const only = opts.targetAreaIds;
  const targets = state.areas.filter((a) => isIrrigable(a) && (!only || only.has(a.id)));
  const blocks = state.areas.filter(isObstacle);
  const reach = heads.map((hd) => ({ hd, r: effectiveRadius(hd, psi) }));

  const count = new Int16Array(w * h).fill(NOT_TARGET);
  let nTarget = 0, c1 = 0, c2 = 0;

  // Pass one: which cells are ground somebody is trying to water. This is
  // O(cells x areas) and is the fixed cost of the grid.
  for (let gy = 0; gy < h; gy++) {
    const y = minY + (gy + 0.5) / res;
    for (let gx = 0; gx < w; gx++) {
      const p = { x: minX + (gx + 0.5) / res, y };
      let onTarget = null;
      for (const a of targets) if (pointInPoly(p, a.pts)) { onTarget = a; break; }
      if (!onTarget) continue;
      if (blocks.some((a) => pointInPoly(p, a.pts))) continue;
      nTarget++;
      // A bed on a drip zone is watered by definition — there is no throw to
      // model — so it reads as fully covered rather than as a red hole. It is
      // parked at DRIP so the head pass leaves it alone, and read as 2 below.
      count[gy * w + gx] = dripIds.has(onTarget.id) ? DRIP : 0;
    }
  }

  // Pass two: each head touches only the cells inside its own throw, so the
  // cost is heads x footprint rather than cells x heads. On a large lot with
  // many heads that is the difference between a frame and a frozen tab.
  for (const { hd, r } of reach) {
    const gx0 = Math.max(0, Math.floor((hd.x - r - minX) * res) - 1);
    const gx1 = Math.min(w - 1, Math.ceil((hd.x + r - minX) * res) + 1);
    const gy0 = Math.max(0, Math.floor((hd.y - r - minY) * res) - 1);
    const gy1 = Math.min(h - 1, Math.ceil((hd.y + r - minY) * res) + 1);
    for (let gy = gy0; gy <= gy1; gy++) {
      const y = minY + (gy + 0.5) / res;
      for (let gx = gx0; gx <= gx1; gx++) {
        const i = gy * w + gx;
        if (count[i] < 0) continue; // not target, or drip
        if (inSector(hd, r, { x: minX + (gx + 0.5) / res, y })) count[i]++;
      }
    }
  }

  for (let i = 0; i < count.length; i++) {
    if (count[i] === DRIP) count[i] = 2;
    if (count[i] >= 1) c1++;
    if (count[i] >= 2) c2++;
  }
  return {
    minX, maxX, minY, maxY, res, w, h, count, nTarget,
    cellArea: 1 / (res * res),
    pct: nTarget ? (100 * c1) / nTarget : null,
    pct2: nTarget ? (100 * c2) / nTarget : null,
  };
}

/** Coverage of one polygon only, sampled directly. Cheap enough to call inside
 *  the pruning loop, which runs it once per candidate removal. */
export function polygonCoverage(poly, heads, psi, blocks = [], res = 1.5) {
  const b = bounds(poly);
  const reach = heads.map((hd) => ({ hd, r: effectiveRadius(hd, psi) }));
  let n = 0, hit = 0, twice = 0;
  for (let y = b.minY; y <= b.maxY; y += 1 / res) {
    for (let x = b.minX; x <= b.maxX; x += 1 / res) {
      const p = { x, y };
      if (!pointInPoly(p, poly)) continue;
      if (blocks.some((a) => pointInPoly(p, a.pts))) continue;
      n++;
      let c = 0;
      for (const { hd, r } of reach) if (inSector(hd, r, p) && ++c === 2) break;
      if (c >= 1) hit++;
      if (c >= 2) twice++;
    }
  }
  // pct2 is not a nicety. Head-to-head design means every point is reached by
  // at least two heads, because a single head's own throw is far from uniform
  // -- it puts down most of its water close in. A plan with 100 % single
  // coverage and no overlap browns out in rings at the edge of every arc.
  return { n, hit, twice, pct: n ? (100 * hit) / n : null, pct2: n ? (100 * twice) / n : null };
}

/** The same sample points as `polygonCoverage`, held once so a set of heads
 *  can be tried many ways against them without re-sampling the ground.
 *
 * The pruner used to call `polygonCoverage` once per candidate removal, which
 * made it O(heads² × area) and froze the tab for ten seconds on a 200 × 260 ft
 * lot. Here each head knows which cells it reaches, and a removal only touches
 * that footprint: the inner loop is "one head's throw", not "the whole lawn".
 * Percentages match `polygonCoverage` exactly, because the points are the
 * same points — the map, the solver and the tests still share one measure. */
export class CoverageSampler {
  constructor(poly, blocks = [], res = 1.5) {
    const b = bounds(poly);
    const xs = [], ys = [];
    for (let y = b.minY; y <= b.maxY; y += 1 / res) ys.push(y);
    for (let x = b.minX; x <= b.maxX; x += 1 / res) xs.push(x);
    this.res = res; this.minX = b.minX; this.minY = b.minY;
    this.nx = xs.length; this.ny = ys.length;
    // Compact index of every sample cell that is on this polygon and not on
    // an obstacle; -1 elsewhere. Head footprints are lists of these indices.
    this.cellIndex = new Int32Array(this.nx * this.ny).fill(-1);
    this.px = []; this.py = [];
    for (let gy = 0; gy < this.ny; gy++) {
      for (let gx = 0; gx < this.nx; gx++) {
        const p = { x: xs[gx], y: ys[gy] };
        if (!pointInPoly(p, poly)) continue;
        if (blocks.some((a) => pointInPoly(p, a.pts))) continue;
        this.cellIndex[gy * this.nx + gx] = this.px.length;
        this.px.push(p.x); this.py.push(p.y);
      }
    }
    this.n = this.px.length;
  }

  /** Compact cell indices a head reaches at this pressure. */
  footprint(head, psi) {
    const r = effectiveRadius(head, psi);
    const { res, minX, minY, nx, ny, cellIndex } = this;
    const gx0 = Math.max(0, Math.floor((head.x - r - minX) * res) - 1);
    const gx1 = Math.min(nx - 1, Math.ceil((head.x + r - minX) * res) + 1);
    const gy0 = Math.max(0, Math.floor((head.y - r - minY) * res) - 1);
    const gy1 = Math.min(ny - 1, Math.ceil((head.y + r - minY) * res) + 1);
    const out = [];
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const i = cellIndex[gy * nx + gx];
        if (i < 0) continue;
        if (inSector(head, r, { x: this.px[i], y: this.py[i] })) out.push(i);
      }
    }
    return out;
  }

  /** A running head-count per cell, with pct / pct2 kept current as heads are
   *  added and removed. Same shape of answer as `polygonCoverage`. */
  counter(heads, psi) {
    const count = new Int16Array(this.n);
    const prints = new Map();
    const c = { n: this.n, hit: 0, twice: 0, pct: null, pct2: null };
    const refresh = () => { c.pct = c.n ? (100 * c.hit) / c.n : null; c.pct2 = c.n ? (100 * c.twice) / c.n : null; };
    const add = (h) => {
      let fp = prints.get(h);
      if (!fp) { fp = this.footprint(h, psi); prints.set(h, fp); }
      for (const i of fp) { const v = ++count[i]; if (v === 1) c.hit++; else if (v === 2) c.twice++; }
      refresh();
    };
    const remove = (h) => {
      const fp = prints.get(h) || [];
      for (const i of fp) { const v = --count[i]; if (v === 0) c.hit--; else if (v === 1) c.twice--; }
      refresh();
    };
    for (const h of heads) add(h);
    return { stats: c, add, remove };
  }
}

/** Paint a grid into RGBA bytes: red where nothing reaches, faint green for
 *  single coverage, blue where two heads overlap (which is what you want, and
 *  is why it is not a warning colour). */
export function gridToRgba(grid, out) {
  const data = out ?? new Uint8ClampedArray(grid.w * grid.h * 4);
  for (let i = 0; i < grid.count.length; i++) {
    const n = grid.count[i], o = i * 4;
    if (n === NOT_TARGET) { data[o + 3] = 0; continue; }
    if (n === 0) { data[o] = 214; data[o + 1] = 64; data[o + 2] = 42; data[o + 3] = 95; }
    else if (n === 1) { data[o] = 122; data[o + 1] = 190; data[o + 2] = 132; data[o + 3] = 60; }
    else { data[o] = 44; data[o + 1] = 132; data[o + 2] = 168; data[o + 3] = 105; }
  }
  return data;
}
