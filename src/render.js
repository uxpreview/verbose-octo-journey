/* Drawing the plan.
 *
 * This is a plan, not a map. Every polygon on it is a measured shape somebody
 * typed or traced, so it is drawn the way a plan is drawn — paper, ink, flat
 * tints, a scale bar and a north arrow — rather than styled to imitate an
 * aerial photograph it is not. The old version rendered dark green "grass" and
 * asphalt textures over a satellite underlay, and the effect was to promise a
 * fidelity the geometry never had.
 *
 * Screen y is flipped exactly once, here, in `P`. Everywhere else in the app,
 * larger y means further from the street. */

import { sectorPoints, centroid, bounds, dist, aimVec, polyArea, polyPerimeter } from './geometry.js';
import { AREA_KINDS } from './site.js';
import { effectiveRadius } from './hydraulics.js';
import { buildCoverageGrid, gridToRgba } from './coverage.js';

const NS = 'http://www.w3.org/2000/svg';
export const GROUPS = ['ground', 'underlay', 'areas', 'coverage', 'features', 'arcs', 'pipes', 'sources', 'heads', 'handles', 'draft', 'labels'];

export const el = (tag, attrs, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
};
export const P = (p) => `${p.x.toFixed(2)},${(-p.y).toFixed(2)}`;
export const pointsAttr = (pts) => pts.map(P).join(' ');

/* The palette lives in CSS so there is one place to change it, and one place
   where the validator's output is recorded. */
let palette = null;
function css(name, fallback) {
  if (typeof getComputedStyle !== 'function') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
export function zonePalette() {
  if (!palette) {
    palette = {
      zones: [1, 2, 3, 4, 5].map((i) => css(`--zone-${i}`, '#0b8fa8')),
      neutral: css('--muted', '#5f6e73'),
      ink: css('--ink', '#1d2b2e'),
      accent: css('--accent', '#003f48'),
      warm: css('--accent-warm-ink', '#bf3400'),
      paper: css('--paper', '#fbf3e4'),
      paperLine: css('--paper-line', '#cdbfa5'),
    };
  }
  return palette;
}
/** Zone identity. Never cycled: past the fifth zone the colour goes neutral and
 *  the number on the head does the identifying, which is why the number is
 *  always drawn. */
export function zoneColor(z) {
  const p = zonePalette();
  return p.zones[z - 1] || p.neutral;
}
/** A per-zone dash, so zone identity survives a greyscale print and a reader
 *  who cannot separate two of the hues. */
export function zoneDash(z, s) {
  const patterns = [[7, 4], [2.5, 3], [10, 4, 2.5, 4], [5, 3, 1.5, 3], [12, 5]];
  return (patterns[(z - 1) % patterns.length]).map((n) => (n * s).toFixed(2)).join(' ');
}

const FILL = {
  lawn: ['--lawn', '--lawn-line'],
  bed: ['--bed', '--bed-line'],
  hardscape: ['--paving', '--paving-line'],
  structure: ['--built', '--built-line'],
  rough: ['--rough', '--rough-line'],
};
const kindFill = (type) => (FILL[type] ? css(FILL[type][0], '#ddd') : '#ddd');
const kindLine = (type) => (FILL[type] ? css(FILL[type][1], '#888') : '#888');

export function buildSvg(svg) {
  svg.innerHTML = '';
  const defs = el('defs', {}, svg);
  // Hatches carry the ground type without relying on colour alone, which also
  // means the plan survives being printed in black and white.
  defs.innerHTML = `
    <pattern id="hatch-built" width="2.2" height="2.2" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="2.2" stroke="${css('--built-line', '#6d6659')}" stroke-width="0.4" opacity="0.38"/>
    </pattern>
    <pattern id="hatch-bed" width="3" height="3" patternUnits="userSpaceOnUse">
      <circle cx="1.5" cy="1.5" r="0.42" fill="${css('--bed-line', '#b99a68')}" opacity="0.75"/>
    </pattern>
    <pattern id="hatch-rough" width="4" height="4" patternUnits="userSpaceOnUse">
      <circle cx="1.2" cy="1.2" r="0.75" fill="${css('--rough-line', '#7f9179')}" opacity="0.5"/>
      <circle cx="3.1" cy="3.2" r="0.5" fill="${css('--rough-line', '#7f9179')}" opacity="0.35"/>
    </pattern>
    <pattern id="hatch-paving" width="4" height="4" patternUnits="userSpaceOnUse">
      <path d="M0 0 H4 M0 0 V4" stroke="${css('--paving-line', '#ab9f8c')}" stroke-width="0.35" opacity="0.6"/>
    </pattern>`;
  el('clipPath', { id: 'clip-lot' }, defs);
  const groups = {};
  for (const g of GROUPS) groups[g] = el('g', { id: `g-${g}` }, svg);
  // A head on the boundary really does throw over the fence, but what the plan
  // is measuring is water landing on *this* ground. Clipping the arcs and the
  // coverage wash to the lot says that, and stops a corner rotor from painting
  // a third of the drawing with spray the reader does not own.
  for (const g of ['coverage', 'arcs']) groups[g].setAttribute('clip-path', 'url(#clip-lot)');
  return groups;
}

/* --- the passes ---------------------------------------------------------- */

const clear = (g) => { while (g.firstChild) g.removeChild(g.firstChild); };

function renderGround(ctx) {
  const { groups, state, px } = ctx;
  const g = groups.ground; clear(g);
  const p = zonePalette();
  const b = bounds(state.site.lot);
  const clip = ctx.svg?.querySelector('#clip-lot') ?? document.getElementById('clip-lot');
  if (clip) { clip.innerHTML = ''; el('polygon', { points: pointsAttr(state.site.lot) }, clip); }
  const pad = 400;
  el('rect', { x: b.minX - pad, y: -(b.maxY + pad), width: (b.maxX - b.minX) + pad * 2, height: (b.maxY - b.minY) + pad * 2, fill: css('--bg', '#fef6e9') }, g);
  el('polygon', { points: pointsAttr(state.site.lot), fill: p.paper, stroke: p.paperLine, 'stroke-width': px(1.5) }, g);
  // The lot line, drawn the way a plot plan draws one.
  el('polygon', {
    points: pointsAttr(state.site.lot), fill: 'none', stroke: p.ink,
    'stroke-width': px(1.6), 'stroke-dasharray': `${px(11)} ${px(4)} ${px(2)} ${px(4)}`,
    opacity: 0.75, 'pointer-events': 'none',
  }, g);

  const u = groups.underlay; clear(u);
  const ul = state.underlay;
  if (ul?.src) {
    el('image', {
      href: ul.src, x: ul.u0, y: -ul.v1, width: ul.u1 - ul.u0, height: ul.v1 - ul.v0,
      preserveAspectRatio: 'none', opacity: ul.opacity ?? 0.85, 'pointer-events': 'none',
    }, u);
  }
  // With a reference image showing, the drawing steps back so you can trace.
  groups.areas.setAttribute('opacity', ul?.src ? 0.5 : 1);
  groups.features.setAttribute('opacity', ul?.src ? 0.7 : 1);
}

function renderAreas(ctx) {
  const { groups, state, px, selectedShape } = ctx;
  clear(groups.areas); clear(groups.features);
  const order = { lawn: 0, rough: 1, bed: 2, hardscape: 3, structure: 4, tree: 5, fence: 6 };
  const sorted = [...state.areas].sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9));
  for (const a of sorted) {
    const kind = AREA_KINDS[a.type];
    if (!kind) continue;
    const g = (order[a.type] ?? 0) >= 4 ? groups.features : groups.areas;
    const sel = selectedShape?.kind === 'area' && selectedShape.id === a.id;
    let node;
    if (kind.open) {
      node = el('polyline', { points: pointsAttr(a.pts), fill: 'none', stroke: zonePalette().ink, 'stroke-width': px(2), 'stroke-dasharray': `${px(1)} ${px(5)}`, 'stroke-linecap': 'round', opacity: 0.8 }, g);
      for (const q of a.pts) el('circle', { cx: q.x, cy: -q.y, r: px(2), fill: zonePalette().ink, opacity: 0.7, 'pointer-events': 'none' }, g);
    } else if (a.type === 'tree') {
      node = el('circle', { cx: centroid(a.pts).x, cy: -centroid(a.pts).y, r: Math.sqrt(polyArea(a.pts) / Math.PI), fill: css('--lawn-line', '#8ba173'), 'fill-opacity': 0.3, stroke: css('--lawn-line', '#8ba173'), 'stroke-width': px(1), 'stroke-dasharray': `${px(4)} ${px(3)}` }, g);
    } else {
      node = el('polygon', { points: pointsAttr(a.pts), fill: kindFill(a.type), stroke: kindLine(a.type), 'stroke-width': px(a.type === 'structure' ? 1.6 : 1) }, g);
      const hatch = { structure: 'hatch-built', bed: 'hatch-bed', rough: 'hatch-rough', hardscape: 'hatch-paving' }[a.type];
      if (hatch) el('polygon', { points: pointsAttr(a.pts), fill: `url(#${hatch})`, stroke: 'none', 'pointer-events': 'none' }, g);
    }
    if (sel) { node.setAttribute('stroke', zonePalette().warm); node.setAttribute('stroke-width', px(2.5)); }
    node.dataset.kind = 'area';
    node.dataset.id = a.id;
    node.classList.add('shape');
  }
}

function renderCoverage(ctx) {
  const g = ctx.groups.coverage; clear(g);
  ctx.coverage = null;
  if (!ctx.showCoverage) return;
  // Focusing a zone asks a different question — "does this zone on its own
  // cover what it is responsible for?" — so the wash answers that one.
  const inFocus = (z) => !ctx.focusZone || z === ctx.focusZone;
  const dripAreaIds = new Set(ctx.state.drip.filter((d) => inFocus(d.zone)).map((d) => d.areaId));
  const focusHeads = ctx.state.heads.filter((h) => inFocus(h.zone));
  const grid = buildCoverageGrid(ctx.state, {
    res: 2.5, dripAreaIds, heads: focusHeads,
    targetAreaIds: ctx.focusZone
      ? new Set([...focusHeads.map((h) => h.areaId), ...dripAreaIds].filter((id) => id != null))
      : null,
  });
  ctx.coverage = grid;
  if (!grid.nTarget) return;
  const canvas = document.createElement('canvas');
  canvas.width = grid.w; canvas.height = grid.h;
  const c2d = canvas.getContext('2d');
  const img = c2d.createImageData(grid.w, grid.h);
  // The grid runs bottom-up in plan space and top-down in image space.
  const rgba = gridToRgba(grid);
  for (let row = 0; row < grid.h; row++) {
    const src = (grid.h - 1 - row) * grid.w * 4;
    img.data.set(rgba.subarray(src, src + grid.w * 4), row * grid.w * 4);
  }
  c2d.putImageData(img, 0, 0);
  el('image', {
    href: canvas.toDataURL(), x: grid.minX, y: -grid.maxY,
    width: grid.maxX - grid.minX, height: grid.maxY - grid.minY,
    preserveAspectRatio: 'none', 'pointer-events': 'none', style: 'image-rendering: pixelated',
  }, g);
}

function renderArcs(ctx) {
  const { groups, state, px, focusZone, showArcs } = ctx;
  const g = groups.arcs; clear(g);
  if (!showArcs) return;
  for (const h of state.heads) {
    const dim = focusZone && h.zone !== focusZone;
    const color = dim ? zonePalette().neutral : zoneColor(h.zone);
    el('polygon', {
      points: pointsAttr(sectorPoints(h, effectiveRadius(h, state.supply.psi))),
      // Forty arcs at 0.13 stack into mud. The stroke is what says "this head
      // reaches here"; the fill only has to hint at the body of the throw.
      fill: color, 'fill-opacity': dim ? 0.03 : 0.07,
      stroke: color, 'stroke-width': px(1), 'stroke-opacity': dim ? 0.25 : 0.6,
      'pointer-events': 'none',
    }, g);
  }
}

function renderPipes(ctx) {
  const { groups, state, px, selectedShape, focusZone } = ctx;
  const g = groups.pipes; clear(g);
  for (const p of state.pipes) {
    const dim = focusZone && p.zone !== focusZone;
    const sel = selectedShape?.kind === 'pipe' && selectedShape.id === p.id;
    const color = dim ? zonePalette().neutral : zoneColor(p.zone);
    const shadow = el('polyline', { points: pointsAttr(p.pts), fill: 'none', stroke: zonePalette().paper, 'stroke-width': px(sel ? 8 : 6), 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: dim ? 0.3 : 0.9 }, g);
    const line = el('polyline', {
      points: pointsAttr(p.pts), fill: 'none', stroke: color,
      'stroke-width': px(sel ? 4 : 2.6), 'stroke-dasharray': p.drip ? `${px(2)} ${px(3)}` : zoneDash(p.zone, px(1)),
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: dim ? 0.35 : 1,
    }, g);
    for (const n of [shadow, line]) { n.dataset.kind = 'pipe'; n.dataset.id = p.id; n.classList.add('shape'); }
  }
}

function renderSources(ctx) {
  const { groups, state, px, selectedSourceId } = ctx;
  const g = groups.sources; clear(g);
  const r = px(8);
  for (const s of state.sources) {
    const sel = selectedSourceId === s.id;
    const grp = el('g', { class: 'drag', 'data-drag': 'source', 'data-id': s.id, transform: `translate(${s.x},${-s.y})` }, g);
    el('path', {
      d: `M0,0 C${-r},${-r * 1.2} ${-r},${-r * 2.2} 0,${-r * 2.4} C${r},${-r * 2.2} ${r},${-r * 1.2} 0,0 Z`,
      fill: zonePalette().accent, stroke: zonePalette().paper, 'stroke-width': px(sel ? 2.6 : 1.4),
    }, grp);
    el('circle', { cx: 0, cy: -r * 1.5, r: r * 0.32, fill: zonePalette().paper }, grp);
    el('title', {}, grp).textContent = `${s.name} — drag to move; pipes snap to it`;
  }
}

function renderHeads(ctx) {
  const { groups, state, px, selectedHeadId, focusZone } = ctx;
  const g = groups.heads; clear(g);
  state.heads.forEach((h, i) => {
    const dim = focusZone && h.zone !== focusZone;
    const sel = h.id === selectedHeadId;
    const color = dim ? zonePalette().neutral : zoneColor(h.zone);
    const r = px(sel ? 8 : 7);
    const grp = el('g', { class: 'drag', 'data-drag': 'head', 'data-id': h.id, transform: `translate(${h.x},${-h.y})`, opacity: dim ? 0.4 : 1 }, g);
    el('title', {}, grp).textContent = `Head ${i + 1} · zone ${h.zone} · ${h.radius} ft · ${h.arc}°`;
    el('circle', { r: r + px(1.6), fill: zonePalette().paper }, grp);
    el('circle', { r, fill: color, stroke: zonePalette().paper, 'stroke-width': px(sel ? 2.4 : 1.4) }, grp);
    // The zone number is the secondary encoding the palette validation requires.
    // It is never optional, which is why it is not behind the Labels toggle.
    el('text', {
      y: px(3.4), 'font-size': px(9.5), 'text-anchor': 'middle', fill: '#fff',
      'font-weight': 700, 'pointer-events': 'none', 'font-family': 'inherit',
    }, grp).textContent = h.zone;
  });
}

function renderHandles(ctx) {
  const { groups, state, px, mode, selectedHeadId, selectedShape, shapeObj } = ctx;
  const g = groups.handles; clear(g);
  if (mode !== 'select') return;
  const h = state.heads.find((x) => x.id === selectedHeadId);
  if (h) {
    const r = effectiveRadius(h, state.supply.psi), v = aimVec(h.aim);
    const tip = { x: h.x + r * v.x, y: h.y + r * v.y };
    el('line', { x1: h.x, y1: -h.y, x2: tip.x, y2: -tip.y, stroke: zonePalette().ink, 'stroke-width': px(1.2), 'stroke-dasharray': `${px(3)} ${px(3)}`, 'pointer-events': 'none' }, g);
    const hd = el('circle', { class: 'drag', 'data-drag': 'aim', 'data-id': h.id, cx: tip.x, cy: -tip.y, r: px(6), fill: zonePalette().paper, stroke: zonePalette().ink, 'stroke-width': px(1.6) }, g);
    el('title', {}, hd).textContent = 'Drag to aim the head and set how far it throws';
    return;
  }
  const obj = shapeObj;
  if (!obj) return;
  const closed = selectedShape.kind === 'area' && !AREA_KINDS[obj.type]?.open;
  obj.pts.forEach((pt, i) => el('circle', { class: 'drag vtx', 'data-drag': 'vtx', 'data-index': i, cx: pt.x, cy: -pt.y, r: px(5), fill: zonePalette().paper, stroke: zonePalette().warm, 'stroke-width': px(1.6) }, g));
  const n = closed ? obj.pts.length : obj.pts.length - 1;
  for (let i = 0; i < n; i++) {
    const a = obj.pts[i], b = obj.pts[(i + 1) % obj.pts.length];
    el('circle', { class: 'mid', 'data-mid': i, cx: (a.x + b.x) / 2, cy: -(a.y + b.y) / 2, r: px(4), fill: 'none', stroke: zonePalette().warm, 'stroke-width': px(1.3), opacity: 0.8 }, g);
  }
}

function renderDraft(ctx) {
  const { groups, px, draft, cursor, draftColor, draftClosed } = ctx;
  const g = groups.draft; clear(g);
  if (!draft?.pts.length) return;
  const pts = [...draft.pts];
  if (cursor) pts.push(cursor);
  const closed = draftClosed && pts.length > 2;
  el(closed ? 'polygon' : 'polyline', {
    points: pointsAttr(pts), fill: closed ? draftColor : 'none', 'fill-opacity': 0.12,
    stroke: draftColor, 'stroke-width': px(2), 'stroke-dasharray': `${px(4)} ${px(4)}`, 'pointer-events': 'none',
  }, g);
  for (const q of draft.pts) el('circle', { cx: q.x, cy: -q.y, r: px(3), fill: draftColor, 'pointer-events': 'none' }, g);
  if (draft.kind === 'measure' || draft.kind === 'pipe') {
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
    const at = pts[pts.length - 1];
    el('text', {
      x: at.x + px(10), y: -at.y + px(4), 'font-size': px(12), fill: zonePalette().ink,
      'font-weight': 700, 'paint-order': 'stroke', stroke: zonePalette().paper, 'stroke-width': px(3.5),
      'pointer-events': 'none', 'font-family': 'inherit',
    }, g).textContent = ctx.fmtLen(len);
  }
}

function renderLabels(ctx) {
  const { groups, state, px, pxPerFt, showLabels } = ctx;
  const g = groups.labels; clear(g);
  if (!showLabels) return;
  const ink = zonePalette().ink;
  const text = (x, y, s, opts = {}) => el('text', {
    x, y: -y, 'font-size': px(opts.size || 10), fill: opts.fill || ink,
    'text-anchor': 'middle', 'dominant-baseline': 'middle', 'font-weight': opts.weight || 500,
    'paint-order': 'stroke', stroke: zonePalette().paper, 'stroke-width': px(3),
    'pointer-events': 'none', 'font-family': 'inherit', opacity: opts.opacity ?? 0.95,
  }, g).textContent = s;

  for (const a of state.areas) {
    if (a.type === 'fence') continue;
    const b = bounds(a.pts);
    const wPx = (b.maxX - b.minX) * pxPerFt, hPx = (b.maxY - b.minY) * pxPerFt;
    if (wPx < a.name.length * 5.5 || hPx < 16) continue;
    const c = centroid(a.pts);
    text(c.x, c.y, a.name, { size: 10 });
  }
  for (const s of state.sources) text(s.x, s.y + px(26), s.name, { size: 10, fill: zonePalette().accent, weight: 600 });
}

/* --- the whole frame ---------------------------------------------------- */

export function renderPlan(ctx) {
  renderGround(ctx);
  renderAreas(ctx);
  renderCoverage(ctx);
  renderArcs(ctx);
  renderPipes(ctx);
  renderSources(ctx);
  renderHeads(ctx);
  renderHandles(ctx);
  renderDraft(ctx);
  renderLabels(ctx);
}

/** A standalone, self-contained SVG of the plan for the printed sheet: no
 *  handles, no coverage wash, heavier line weights so it survives paper. */
let figureSeq = 0;
export function planFigureSvg(state, { width = 900 } = {}) {
  const b = bounds(state.site.lot);
  const pad = 6;
  const w = b.maxX - b.minX + pad * 2, h = b.maxY - b.minY + pad * 2;
  const s = width / w;
  const svg = el('svg', {
    xmlns: NS, viewBox: `${b.minX - pad} ${-(b.maxY + pad)} ${w} ${h}`,
    width, height: Math.round(width * (h / w)), 'font-family': 'inherit',
  });
  const clipId = `clip-fig-${++figureSeq}`;
  const defs = el('defs', {}, svg);
  const clip = el('clipPath', { id: clipId }, defs);
  el('polygon', { points: pointsAttr(state.site.lot) }, clip);
  const groups = {};
  for (const g of GROUPS) groups[g] = el('g', {}, svg);
  groups.arcs.setAttribute('clip-path', `url(#${clipId})`);
  const px = (n) => n / s;
  const ctx = {
    groups, state, px, pxPerFt: s, showCoverage: false, showArcs: true, showLabels: true,
    mode: 'print', selectedHeadId: null, selectedShape: null, selectedSourceId: null, svg,
    focusZone: null, draft: null, cursor: null, fmtLen: (v) => `${v.toFixed(0)} ft`,
  };
  renderPlan(ctx);
  return svg;
}
