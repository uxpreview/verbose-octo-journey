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
      // model — so it reads as fully covered rather than as a red hole.
      let n = dripIds.has(onTarget.id) ? 2 : 0;
      if (!n) for (const { hd, r } of reach) if (inSector(hd, r, p)) n++;
      count[gy * w + gx] = n;
      if (n >= 1) c1++;
      if (n >= 2) c2++;
    }
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
