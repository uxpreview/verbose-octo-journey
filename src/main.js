/* Irrigation Lab — wiring.
 *
 * Three screens: the start screen where a site gets created, the planner, and
 * the printable sheet. State is one plain object (see site.js), saved to
 * localStorage on every change and exportable as JSON. Nothing is sent
 * anywhere; there is no network call in this repository. */

import {
  dist, clamp, bounds, centroid, polyArea, polyPerimeter, bearing, aimVec,
  nearestOnSegment, pointInPoly,
} from './geometry.js';
import {
  HEAD_TYPES, headGpm, effectiveRadius, bucketGpm,
  fmtLen, fmtArea, fmtFlow, toLen, fromLen, toFlow, fromFlow, UNITS,
} from './hydraulics.js';
import {
  AREA_KINDS, defaultState, sampleSite, blankSite, tracedSite, normalise,
  load, save as persist, newId, resetIds, peekId, isIrrigable, STORAGE_KEY,
} from './site.js';
import { autoLayout, FLOW_SAFETY } from './autolayout.js';
import { buildSvg, renderPlan, zoneColor, zonePalette, el, planFigureSvg } from './render.js';
import { renderSheet, summarise } from './sheet.js';

const $ = (id) => document.getElementById(id);
const svg = $('plan');

let state = defaultState();
let groups = null;
let history = [];
let mode = 'select';
let draft = null;
let cursor = null;
let selectedHeadId = null;
let selectedShape = null;
let selectedSourceId = null;
let focusZone = null;
let lastNotes = [];
let coverage = null;

const view = { x: -10, y: -130, w: 100, h: 140 };
let pxPerFt = 6;

/* --- units -------------------------------------------------------------- */

const U = () => UNITS[state.units];
const showLen = (ft, d = 0) => fmtLen(ft, state.units, d);
const showArea = (sq) => fmtArea(sq, state.units);
const showFlow = (gpm, d = 1) => fmtFlow(gpm, state.units, d);

function syncUnitLabels() {
  const u = U();
  for (const n of document.querySelectorAll('.u-len')) n.textContent = u.len;
  for (const n of document.querySelectorAll('.u-flow')) n.textContent = u.flow;
  for (const n of document.querySelectorAll('.u-depth')) n.textContent = u.depth;
  $('units').value = state.units;
}

/* --- screens ------------------------------------------------------------ */

function show(which) {
  for (const id of ['screen-start', 'screen-plan', 'screen-sheet']) $(id).hidden = id !== `screen-${which}`;
  document.body.dataset.screen = which;
  if (which === 'plan') { applyView(); renderAll(); }
}

/* --- persistence -------------------------------------------------------- */

function save() {
  const ok = persist(state);
  $('save-note').textContent = ok
    ? 'Saved in this browser as you work. Nothing is sent anywhere.'
    : 'Too large to save in this browser — most likely the reference image. Export the JSON to keep it.';
  $('save-note').classList.toggle('danger-text', !ok);
}
function pushHistory() {
  history.push(JSON.stringify(state));
  if (history.length > 60) history.shift();
}
function undo() {
  const prev = history.pop();
  if (!prev) return;
  state = normalise(JSON.parse(prev));
  selectedHeadId = null; selectedShape = null; selectedSourceId = null;
  save(); renderAll();
}

function adopt(next, { notes = [] } = {}) {
  state = next;
  history = [];
  lastNotes = notes;
  selectedHeadId = null; selectedShape = null; selectedSourceId = null; focusZone = null;
  syncUnitLabels();
  $('site-name').value = state.site.name;
  save();
  show('plan');
  fitLot();
}

/* --- view --------------------------------------------------------------- */

function applyView() {
  svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
  const r = svg.getBoundingClientRect();
  pxPerFt = Math.min(r.width / view.w, r.height / view.h) || 6;
  updateScalebar();
}
function fitLot() {
  const b = bounds(state.site.lot);
  const r = svg.getBoundingClientRect();
  const pad = Math.max(6, (b.maxX - b.minX) * 0.06);
  const w = b.maxX - b.minX + pad * 2, h = b.maxY - b.minY + pad * 2;
  const aspect = (r.width || 900) / Math.max(1, r.height || 600);
  let vw = w, vh = h;
  if (vw / vh < aspect) vw = vh * aspect; else vh = vw / aspect;
  view.w = vw; view.h = vh;
  view.x = (b.minX + b.maxX) / 2 - vw / 2;
  view.y = -((b.minY + b.maxY) / 2) - vh / 2;
  applyView(); renderAll();
}
function zoomAt(factor, cx, cy) {
  const nw = clamp(view.w * factor, 12, 2000), ratio = nw / view.w, nh = view.h * ratio;
  view.x = cx - (cx - view.x) * ratio;
  view.y = cy - (cy - view.y) * ratio;
  view.w = nw; view.h = nh;
  applyView(); renderAll();
}
function clientToSvg(cx, cy) {
  const pt = svg.createSVGPoint();
  pt.x = cx; pt.y = cy;
  const m = svg.getScreenCTM();
  if (!m) return { x: 0, y: 0 };
  const q = pt.matrixTransform(m.inverse());
  return { x: q.x, y: q.y };
}
const clientToPlan = (cx, cy) => { const q = clientToSvg(cx, cy); return { x: q.x, y: -q.y }; };
const px = (n) => n / pxPerFt;

function updateScalebar() {
  // Step through round numbers in the *display* unit, so the bar reads 10 m
  // rather than 32.8 ft worth of metres.
  const steps = state.units === 'metric' ? [0.5, 1, 2, 5, 10, 20, 50, 100] : [1, 2, 5, 10, 20, 50, 100, 200];
  let chosen = steps[0];
  for (const s of steps) if (fromLen(s, state.units) * pxPerFt <= 150) chosen = s;
  document.querySelector('.scalebar .bar').style.width = `${fromLen(chosen, state.units) * pxPerFt}px`;
  $('scale-txt').textContent = `${chosen} ${U().len}`;
}

/* --- render ------------------------------------------------------------- */

const shapeObj = () => {
  if (!selectedShape) return null;
  return (selectedShape.kind === 'area' ? state.areas : state.pipes).find((x) => x.id === selectedShape.id) || null;
};

function renderAll() {
  if (!groups) return;
  const ctx = {
    groups, state, svg, px, pxPerFt, mode, draft, cursor,
    selectedHeadId, selectedShape, selectedSourceId, shapeObj: shapeObj(), focusZone,
    showCoverage: $('chk-coverage').checked,
    showArcs: $('chk-arcs').checked,
    showLabels: $('chk-labels').checked,
    draftColor: draft?.kind === 'pipe' ? zoneColor(Number($('pipe-zone').value) || 1) : zonePalette().warm,
    draftClosed: draft?.kind === 'area' && !AREA_KINDS[$('area-type').value]?.open,
    fmtLen: (v) => showLen(v, 1),
  };
  renderPlan(ctx);
  coverage = ctx.coverage;
  renderPanel();
  $('compass-rot').setAttribute('transform', `rotate(${-(state.site.northDeg || 0)})`);
}

/* --- panel -------------------------------------------------------------- */

function fillZoneSelect(sel, value, max) {
  const n = Math.max(6, max || 0);
  sel.innerHTML = '';
  for (let z = 1; z <= n; z++) {
    const o = document.createElement('option');
    o.value = z; o.textContent = `Zone ${z}`;
    sel.append(o);
  }
  sel.value = value || 1;
}

function renderPanel() {
  const sum = summarise(state);
  const maxZone = Math.max(1, ...sum.zones.map((z) => z.zone));

  $('psi').value = state.supply.psi; $('psi-out').value = state.supply.psi;
  $('gpm').value = state.supply.gpm; $('gpm-out').value = toFlow(state.supply.gpm, state.units).toFixed(1);
  $('north').value = state.site.northDeg; $('north-out').value = state.site.northDeg;
  $('water-week').value = state.schedule.inchesPerWeek;
  $('water-out').value = state.units === 'metric'
    ? (state.schedule.inchesPerWeek * 25.4).toFixed(0)
    : state.schedule.inchesPerWeek.toFixed(2);
  $('days-week').value = state.schedule.daysPerWeek;
  $('days-out').value = state.schedule.daysPerWeek;

  // Zone focus
  const focusSel = $('sel-focus');
  const wanted = focusZone ? String(focusZone) : 'all';
  focusSel.innerHTML = '<option value="all">All zones</option>';
  for (const z of sum.zones) {
    const o = document.createElement('option');
    o.value = z.zone; o.textContent = `Zone ${z.zone} only`;
    focusSel.append(o);
  }
  focusSel.value = wanted;
  if (focusSel.value !== wanted) { focusZone = null; focusSel.value = 'all'; }

  // Zones table
  const rows = sum.zones.map((z) => `
    <tr class="${focusZone === z.zone ? 'focused' : ''}">
      <td><span class="swatch" style="background:${zoneColor(z.zone)}"></span>${z.zone}</td>
      <td>${z.heads.length ? z.heads.length : `${z.drip.length}×drip`}</td>
      <td class="${z.over ? 'over' : ''}">${showFlow(z.gpm)}${z.over ? ' ⚠' : ''}</td>
      <td>${z.run ? (z.run.perStartMin < 90 ? `${Math.round(z.run.perStartMin)} min` : `${(z.run.perStartMin / 60).toFixed(1)} hr`) : '—'}</td>
      <td>${showLen(z.pipeFt)}</td>
    </tr>`).join('');
  $('zones-table').innerHTML = sum.zones.length
    ? `<table class="zones"><thead><tr><th>Zone</th><th>Out</th><th>Flow</th><th>Per start</th><th>Trench</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="empty">No zones yet. Draw the yard, then press <b>Generate the layout</b>.</p>';

  const covPct = coverage?.pct;
  const cov2Pct = coverage?.pct2;
  const covClass = covPct == null ? '' : covPct >= 92 ? '' : covPct >= 80 ? 'warn' : 'bad';
  $('stats').innerHTML = `
    <div class="stat"><span class="k">Heads</span><span class="v">${sum.headCount}</span></div>
    <div class="stat"><span class="k">Trench</span><span class="v">${showLen(sum.totalPipe)}</span></div>
    <div class="stat"><span class="k">${focusZone ? `Zone ${focusZone} covers` : 'Covered'}</span><span class="v ${covClass}">${covPct == null ? '–' : `${covPct.toFixed(0)}%`}</span></div>
    <div class="stat"><span class="k">Head to head</span><span class="v">${cov2Pct == null ? '–' : `${cov2Pct.toFixed(0)}%`}</span></div>`;

  // Notes from the last auto-layout run
  $('auto-notes').innerHTML = lastNotes.map((n) => `<p>${n.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</p>`).join('');

  // Selected head
  const h = state.heads.find((x) => x.id === selectedHeadId);
  $('head-controls').hidden = !h;
  $('head-empty').hidden = !!h;
  $('head-title').textContent = h ? `#${state.heads.indexOf(h) + 1}` : '';
  if (h) {
    const t = HEAD_TYPES[h.type];
    $('h-type').value = h.type;
    $('h-radius').min = t.min; $('h-radius').max = t.max;
    $('h-radius').value = h.radius; $('h-radius-out').value = toLen(h.radius, state.units).toFixed(1);
    $('h-arc').value = h.arc; $('h-arc-out').value = h.arc;
    $('h-aim').value = h.aim; $('h-aim-out').value = h.aim;
    fillZoneSelect($('h-zone'), h.zone, maxZone);
    $('h-gpm').textContent = `${showFlow(headGpm(h, state.supply.psi), 2)} · reaches ${showLen(effectiveRadius(h, state.supply.psi), 1)}`;
  }
  fillZoneSelect($('pipe-zone'), Number($('pipe-zone').value) || 1, maxZone + 1);

  // Areas
  const list = $('areas-list');
  list.innerHTML = '';
  for (const a of state.areas) {
    const kind = AREA_KINDS[a.type];
    const row = document.createElement('div');
    row.className = 'item' + (selectedShape?.kind === 'area' && selectedShape.id === a.id ? ' sel' : '');
    const size = kind.open ? showLen(polyPerimeter(a.pts, false)) : showArea(polyArea(a.pts));
    row.innerHTML = `<span class="swatch" style="background:${swatchFor(a.type)}"></span><span class="name" title="Select on the plan">${escapeHtml(a.name)}</span><span class="muted small">${size}</span>`;
    row.querySelector('.name').onclick = () => { setMode('select'); selectShape('area', a.id); };
    const ren = mkButton('Rename', () => {
      const n = prompt('Name this area', a.name);
      if (n) { pushHistory(); a.name = n; save(); renderAll(); }
    });
    const del = mkButton('×', () => {
      pushHistory();
      state.areas = state.areas.filter((x) => x.id !== a.id);
      if (selectedShape?.id === a.id) selectedShape = null;
      save(); renderAll();
    }, 'danger-text');
    row.append(ren, del);
    list.append(row);
  }
  if (!state.areas.length) list.innerHTML = '<p class="empty">Nothing drawn yet. Pick a type above, choose the <b>Area</b> tool and click the corners.</p>';

  // Sources
  const sl = $('sources-list');
  sl.innerHTML = '';
  for (const s of state.sources) {
    const row = document.createElement('div');
    row.className = 'item' + (selectedSourceId === s.id ? ' sel' : '');
    row.innerHTML = `<span class="swatch" style="background:${zonePalette().accent};border-radius:50% 50% 50% 0"></span><span class="name" title="Select on the plan">${escapeHtml(s.name)}</span>`;
    row.querySelector('.name').onclick = () => {
      setMode('select');
      selectedSourceId = s.id; selectedHeadId = null; selectedShape = null;
      renderAll();
    };
    row.append(mkButton('Rename', () => {
      const n = prompt('Name this water source', s.name);
      if (n) { pushHistory(); s.name = n; save(); renderAll(); }
    }));
    sl.append(row);
  }

  renderLegend();
}

function swatchFor(type) {
  const map = { lawn: '--lawn', bed: '--bed', hardscape: '--paving', structure: '--built', rough: '--rough', tree: '--lawn-line', fence: '--ink' };
  return getComputedStyle(document.documentElement).getPropertyValue(map[type] || '--muted').trim() || '#999';
}
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function mkButton(text, onclick, cls = '') {
  const b = document.createElement('button');
  b.className = `ghost ${cls}`.trim();
  b.textContent = text;
  b.onclick = onclick;
  return b;
}

/** The legend is not decoration. With the zone palette running one adjacent
 *  pair inside the CVD floor band, identity may never rest on colour alone —
 *  so the zone number rides on every head and is repeated here. */
function renderLegend() {
  const sum = summarise(state);
  const box = $('legend');
  if (!$('chk-coverage').checked && !sum.zones.length) { box.hidden = true; return; }
  box.hidden = false;
  // When a zone is in focus the wash measures only that zone against only the
  // ground it was given, so the legend has to say so — an unqualified "not
  // reached" over a field of red reads as a broken plan rather than a filter.
  const covRows = $('chk-coverage').checked ? `
    <div class="lrow"><span class="chip" style="background:#d6402a55"></span> not reached${focusZone ? ' by this zone' : ''}</div>
    <div class="lrow"><span class="chip" style="background:#7abe8455"></span> one head</div>
    <div class="lrow"><span class="chip" style="background:#2c84a866"></span> two or more — the target</div>` : '';
  const zoneRows = sum.zones.map((z) => `<div class="lrow"><span class="chip" style="background:${zoneColor(z.zone)}"></span> zone ${z.zone}${z.over ? ' ⚠' : ''}</div>`).join('');
  box.innerHTML = `${covRows ? `<h3>Coverage${focusZone ? ` · zone ${focusZone}` : ''}</h3>${covRows}` : ''}${zoneRows ? `<h3>Zones</h3>${zoneRows}` : ''}`;
}

/* --- modes -------------------------------------------------------------- */

const HINTS = {
  select: 'Click a head to edit it. Drag heads, water sources or the aim handle. Click an area or a pipe to reshape it. Scroll to zoom, drag the ground to pan.',
  head: 'Click on the plan to drop a sprinkler head. Press V or Esc when you are done.',
  pipe: 'Click along the trench. Click a head or a water source to snap to it. Double-click or Enter to finish.',
  area: 'Click each corner. Double-click or Enter to close the shape. Fence lines stay open.',
  measure: 'Click two or more points to measure. Enter or Esc to finish.',
};
function setMode(m) {
  mode = m;
  finishDraft(false);
  selectedShape = null;
  if (m !== 'select') selectedSourceId = null;
  for (const b of document.querySelectorAll('.tool')) b.setAttribute('aria-pressed', String(b.dataset.mode === m));
  $('map').className = `mode-${m}`;
  $('hint').textContent = HINTS[m];
  renderAll();
}
function selectShape(kind, id) {
  selectedShape = { kind, id };
  selectedHeadId = null; selectedSourceId = null;
  $('hint').textContent = 'Drag the corner dots to reshape. Click a hollow dot to add a corner, right-click one to remove it. Delete removes the whole shape.';
  renderAll();
}

/** Point a new head away from whatever it is standing next to — a wall, a
 *  fence, the lot line — because that is what a person would do. */
function guessAim(p) {
  let best = null;
  const edges = [state.site.lot, ...state.areas.filter((a) => a.type === 'structure' || a.type === 'fence').map((a) => a.pts)];
  for (const poly of edges) {
    for (let i = 0; i < poly.length; i++) {
      const { q, d } = nearestOnSegment(p, poly[i], poly[(i + 1) % poly.length]);
      if (!best || d < best.d) best = { d, q };
    }
  }
  if (!best || best.d > 8) return 0;
  return Math.round(bearing(best.q, p));
}

function planClick(p, snap) {
  if (mode === 'head') {
    pushHistory();
    const t = HEAD_TYPES[state.defaults.type];
    const head = {
      id: newId(), x: p.x, y: p.y, type: state.defaults.type,
      radius: clamp(state.defaults.radius, t.min, t.max), arc: state.defaults.arc,
      aim: guessAim(p), zone: Number($('pipe-zone').value) || 1,
    };
    const area = state.areas.find((a) => isIrrigable(a) && pointInPoly(p, a.pts));
    if (area) { head.areaId = area.id; head.areaName = area.name; }
    state.heads.push(head);
    selectedHeadId = head.id;
    save(); renderAll();
    return;
  }
  if (mode === 'pipe' || mode === 'area' || mode === 'measure') {
    if (!draft) draft = { kind: mode, pts: [] };
    const pt = { x: p.x, y: p.y };
    if (mode === 'pipe') {
      const tol = px(12);
      if (snap?.head) { pt.x = snap.head.x; pt.y = snap.head.y; pt.headId = snap.head.id; }
      else if (snap?.source) { pt.x = snap.source.x; pt.y = snap.source.y; pt.sourceId = snap.source.id; }
      else {
        for (const h of state.heads) if (dist(h, p) < tol) { pt.x = h.x; pt.y = h.y; pt.headId = h.id; break; }
        if (pt.headId == null) for (const s of state.sources) if (dist(s, p) < tol) { pt.x = s.x; pt.y = s.y; pt.sourceId = s.id; break; }
      }
    }
    draft.pts.push(pt);
    renderAll();
  }
}

function finishDraft(commit) {
  if (!draft) return;
  const d = draft;
  draft = null; cursor = null;
  if (!commit) { renderAll(); return; }
  if (d.kind === 'pipe' && d.pts.length >= 2) {
    pushHistory();
    state.pipes.push({ id: newId(), zone: Number($('pipe-zone').value) || 1, pts: d.pts });
    save();
  } else if (d.kind === 'area') {
    const type = $('area-type').value;
    const open = !!AREA_KINDS[type].open;
    if (d.pts.length < (open ? 2 : 3)) { renderAll(); return; }
    const n = state.areas.filter((a) => a.type === type).length + 1;
    const name = prompt('Name this area', `${AREA_KINDS[type].label} ${n}`);
    if (name == null) { renderAll(); return; }
    pushHistory();
    state.areas.push({ id: newId(), type, name, pts: d.pts, ...(open ? { open: true } : {}) });
    save();
  }
  renderAll();
}

function deleteSelected() {
  if (selectedSourceId) {
    if (state.sources.length <= 1) { alert('Keep at least one water source — the trenches have to start somewhere.'); return; }
    pushHistory();
    state.sources = state.sources.filter((s) => s.id !== selectedSourceId);
    for (const p of state.pipes) for (const pt of p.pts) if (pt.sourceId === selectedSourceId) delete pt.sourceId;
    selectedSourceId = null;
    save(); renderAll();
    return;
  }
  if (selectedShape) {
    pushHistory();
    if (selectedShape.kind === 'area') state.areas = state.areas.filter((a) => a.id !== selectedShape.id);
    else state.pipes = state.pipes.filter((p) => p.id !== selectedShape.id);
    selectedShape = null;
    save(); renderAll();
    return;
  }
  if (selectedHeadId == null) return;
  pushHistory();
  state.heads = state.heads.filter((h) => h.id !== selectedHeadId);
  for (const p of state.pipes) for (const pt of p.pts) if (pt.headId === selectedHeadId) delete pt.headId;
  selectedHeadId = null;
  save(); renderAll();
}

function syncPipesToAnchors() {
  for (const p of state.pipes) {
    for (const pt of p.pts) {
      if (pt.headId != null) { const h = state.heads.find((x) => x.id === pt.headId); if (h) { pt.x = h.x; pt.y = h.y; } }
      if (pt.sourceId) { const s = state.sources.find((x) => x.id === pt.sourceId); if (s) { pt.x = s.x; pt.y = s.y; } }
    }
  }
}

/* --- pointer ------------------------------------------------------------ */

let ptr = null;
svg.addEventListener('pointerdown', (e) => {
  if (e.button === 2) return;
  svg.focus({ preventScroll: true });
  const dragEl = e.target.closest('.drag');
  ptr = { start: { cx: e.clientX, cy: e.clientY }, moved: false, view0: { ...view }, p0: clientToPlan(e.clientX, e.clientY), target: e.target };
  if (dragEl && mode === 'select') {
    ptr.type = dragEl.dataset.drag;
    ptr.id = Number(dragEl.dataset.id);
    ptr.sid = dragEl.dataset.id;
    ptr.index = Number(dragEl.dataset.index);
    ptr.pushed = false;
  } else ptr.type = 'pan';
  svg.setPointerCapture(e.pointerId);
  e.preventDefault();
});

svg.addEventListener('pointermove', (e) => {
  const p = clientToPlan(e.clientX, e.clientY);
  if (draft) { cursor = p; renderAll(); }
  if (!ptr) return;
  if (!ptr.moved && Math.hypot(e.clientX - ptr.start.cx, e.clientY - ptr.start.cy) < 4) return;
  ptr.moved = true;
  if (ptr.type === 'pan') {
    const r = svg.getBoundingClientRect();
    view.x = ptr.view0.x - (e.clientX - ptr.start.cx) * (view.w / r.width);
    view.y = ptr.view0.y - (e.clientY - ptr.start.cy) * (view.h / r.height);
    applyView(); renderAll();
    return;
  }
  if (!ptr.pushed) { pushHistory(); ptr.pushed = true; }
  if (ptr.type === 'head') {
    const h = state.heads.find((x) => x.id === ptr.id);
    if (!h) return;
    h.x = p.x; h.y = p.y;
    const area = state.areas.find((a) => isIrrigable(a) && pointInPoly(p, a.pts));
    h.areaId = area?.id; h.areaName = area?.name;
    syncPipesToAnchors();
    selectedHeadId = h.id; selectedShape = null;
  } else if (ptr.type === 'source') {
    const s = state.sources.find((x) => x.id === ptr.sid);
    if (!s) return;
    s.x = p.x; s.y = p.y;
    syncPipesToAnchors();
  } else if (ptr.type === 'aim') {
    const h = state.heads.find((x) => x.id === ptr.id);
    if (!h) return;
    const t = HEAD_TYPES[h.type];
    h.aim = Math.round(bearing(h, p));
    const scale = effectiveRadius({ type: h.type, radius: 1 }, state.supply.psi);
    h.radius = Math.round(clamp(dist(h, p) / scale, t.min, t.max) * 2) / 2;
  } else if (ptr.type === 'vtx') {
    const obj = shapeObj();
    if (!obj) return;
    const pt = obj.pts[ptr.index];
    pt.x = p.x; pt.y = p.y;
    delete pt.headId; delete pt.sourceId;
  }
  renderAll();
});

svg.addEventListener('pointerup', (e) => {
  if (!ptr) return;
  const was = ptr;
  ptr = null;
  try { svg.releasePointerCapture(e.pointerId); } catch (_) { /* already gone */ }
  if (was.moved) { if (was.type !== 'pan') { save(); renderAll(); } return; }
  const t = was.target;
  if (mode === 'select') {
    const mid = t.closest('.mid');
    if (mid) {
      const obj = shapeObj();
      if (obj) {
        const i = Number(mid.dataset.mid);
        const a = obj.pts[i], b = obj.pts[(i + 1) % obj.pts.length];
        pushHistory();
        obj.pts.splice(i + 1, 0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        save(); renderAll();
      }
      return;
    }
    const dragEl = t.closest('.drag');
    if (dragEl?.dataset.drag === 'head') {
      selectedHeadId = Number(dragEl.dataset.id);
      selectedShape = null; selectedSourceId = null;
      renderAll();
      return;
    }
    if (dragEl?.dataset.drag === 'source') {
      selectedSourceId = dragEl.dataset.id;
      selectedHeadId = null; selectedShape = null;
      $('hint').textContent = 'Water source selected. Drag it to move; Delete removes it. Rename it in the panel.';
      renderAll();
      return;
    }
    if (dragEl) return;
    const shape = t.closest('.shape');
    if (shape) { selectShape(shape.dataset.kind, Number(shape.dataset.id)); return; }
    selectedHeadId = null; selectedShape = null; selectedSourceId = null;
    $('hint').textContent = HINTS.select;
    renderAll();
    return;
  }
  const dragEl = t.closest('.drag');
  const snap = {};
  if (dragEl?.dataset.drag === 'head') snap.head = state.heads.find((x) => x.id === Number(dragEl.dataset.id));
  if (dragEl?.dataset.drag === 'source') snap.source = state.sources.find((x) => x.id === dragEl.dataset.id);
  planClick(was.p0, snap);
});

svg.addEventListener('dblclick', (e) => {
  e.preventDefault();
  if (!draft) return;
  if (draft.pts.length > 1) draft.pts.pop();
  finishDraft(true);
});
svg.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const v = e.target.closest('.vtx');
  if (!v) return;
  const obj = shapeObj();
  if (!obj) return;
  const min = selectedShape.kind === 'area' && !AREA_KINDS[obj.type]?.open ? 3 : 2;
  if (obj.pts.length <= min) return;
  pushHistory();
  obj.pts.splice(Number(v.dataset.index), 1);
  save(); renderAll();
});
svg.addEventListener('wheel', (e) => {
  e.preventDefault();
  const q = clientToSvg(e.clientX, e.clientY);
  zoomAt(Math.exp(e.deltaY * 0.0015), q.x, q.y);
}, { passive: false });
window.addEventListener('resize', () => { if (!$('screen-plan').hidden) { applyView(); renderAll(); } });

document.addEventListener('keydown', (e) => {
  if ($('screen-plan').hidden) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if (e.key === 'Enter') { finishDraft(true); return; }
  if (e.key === 'Escape') { draft ? finishDraft(false) : setMode('select'); return; }
  const k = e.key.toLowerCase();
  const modes = { v: 'select', h: 'head', p: 'pipe', a: 'area', m: 'measure' };
  if (modes[k]) { setMode(modes[k]); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selectedHeadId != null || selectedShape || selectedSourceId) { e.preventDefault(); deleteSelected(); }
    return;
  }
  if (selectedHeadId != null && (e.key === '[' || e.key === ']')) {
    const h = state.heads.find((x) => x.id === selectedHeadId);
    if (!h) return;
    h.aim = (h.aim + (e.key === ']' ? 5 : -5) + 360) % 360;
    save(); renderAll();
  }
});

/* --- start screen ------------------------------------------------------- */

$('start-sample').onclick = () => {
  const s = sampleSite();
  const plan = autoLayout(s);
  s.heads = plan.heads; s.pipes = plan.pipes; s.drip = plan.drip; s.nextId = peekId();
  adopt(s, { notes: plan.notes });
};

$('start-blank').onclick = () => {
  const unit = $('lot-units').value;
  const w = fromLen(Number($('lot-w').value) || 70, unit);
  const d = fromLen(Number($('lot-d').value) || 120, unit);
  const s = blankSite(w, d);
  s.units = unit;
  adopt(s, { notes: ['Draw the house, the drive and the beds over the lawn, then generate a layout.'] });
};

/* Tracing an image: read it off disk, ask for a scale by clicking two points,
   then build the site around it. The file never leaves the page — it becomes a
   data URL held in the same state object as everything else. */
let pendingImage = null;
const scaleDialog = $('scale-dialog');
const scaleCanvas = $('scale-canvas');
let scalePts = [];

/** Longest edge, in pixels, that a traced image is kept at. A phone photo is
 *  4000 px and 3-8 MB; as a data URL inside the saved plan that blows the
 *  ~5 MB localStorage quota and the plan silently stops persisting. At 2000 px
 *  the underlay is still sharper than anyone traces, and it fits. */
const MAX_IMAGE_EDGE = 2000;
/** Above this, a data URL is re-encoded even if it is not oversized: a large
 *  PNG screenshot is worth as much as a JPEG once it is only an underlay. */
const MAX_IMAGE_BYTES = 1_500_000;

/** Bring an image down to something the plan can carry: bounded on its long
 *  edge and re-encoded as JPEG on a white ground (a transparent sketch would
 *  otherwise come out black). Small images pass through untouched so a crisp
 *  little plan drawing keeps its pixels. Resolves to {img, src}. */
function shrinkImage(img, src) {
  const long = Math.max(img.width, img.height);
  const s = Math.min(1, MAX_IMAGE_EDGE / long);
  if (s === 1 && src.length <= MAX_IMAGE_BYTES) return Promise.resolve({ img, src });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.width * s));
  canvas.height = Math.max(1, Math.round(img.height * s));
  const c = canvas.getContext('2d');
  c.fillStyle = '#fff';
  c.fillRect(0, 0, canvas.width, canvas.height);
  c.drawImage(img, 0, 0, canvas.width, canvas.height);
  const out = canvas.toDataURL('image/jpeg', 0.85);
  return new Promise((resolve) => {
    const small = new Image();
    small.onload = () => resolve({ img: small, src: out });
    small.onerror = () => resolve({ img, src }); // keep the original rather than lose the picture
    small.src = out;
  });
}

function openImage(file, onDone) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = async () => {
      const { img: use, src } = await shrinkImage(img, reader.result);
      pendingImage = { img: use, src, onDone };
      scalePts = [];
      const maxW = 680;
      const s = Math.min(1, maxW / use.width);
      scaleCanvas.width = Math.round(use.width * s);
      scaleCanvas.height = Math.round(use.height * s);
      drawScaleCanvas();
      $('scale-status').textContent = 'Click the first point.';
      $('scale-dist').value = '';
      $('scale-ok').disabled = true;
      $('scale-units').value = state.units;
      scaleDialog.showModal();
    };
    img.onerror = () => alert('That file did not open as an image.');
    img.src = reader.result;
  };
  reader.onerror = () => alert('Could not read that file.');
  reader.readAsDataURL(file);
}

function drawScaleCanvas() {
  const c = scaleCanvas.getContext('2d');
  c.clearRect(0, 0, scaleCanvas.width, scaleCanvas.height);
  c.drawImage(pendingImage.img, 0, 0, scaleCanvas.width, scaleCanvas.height);
  const ink = zonePalette().warm;
  c.strokeStyle = ink; c.fillStyle = ink; c.lineWidth = 2;
  if (scalePts.length === 2) {
    c.beginPath();
    c.moveTo(scalePts[0].x, scalePts[0].y);
    c.lineTo(scalePts[1].x, scalePts[1].y);
    c.stroke();
  }
  for (const p of scalePts) {
    c.beginPath();
    c.arc(p.x, p.y, 5, 0, Math.PI * 2);
    c.fill();
  }
}

scaleCanvas.addEventListener('click', (e) => {
  const r = scaleCanvas.getBoundingClientRect();
  const p = { x: ((e.clientX - r.left) / r.width) * scaleCanvas.width, y: ((e.clientY - r.top) / r.height) * scaleCanvas.height };
  if (scalePts.length >= 2) scalePts = [];
  scalePts.push(p);
  drawScaleCanvas();
  $('scale-status').textContent = scalePts.length === 1
    ? 'Now click the second point.'
    : 'Two points set. Type the real distance between them.';
  updateScaleOk();
});
$('scale-dist').addEventListener('input', updateScaleOk);
function updateScaleOk() {
  $('scale-ok').disabled = !(scalePts.length === 2 && Number($('scale-dist').value) > 0);
}

scaleDialog.addEventListener('close', () => {
  if (scaleDialog.returnValue !== 'ok' || !pendingImage) { pendingImage = null; return; }
  const unit = $('scale-units').value;
  const realFt = fromLen(Number($('scale-dist').value), unit);
  const pxDist = dist(scalePts[0], scalePts[1]);
  if (!(pxDist > 2) || !(realFt > 0)) { pendingImage = null; return; }
  const ftPerCanvasPx = realFt / pxDist;
  const wFt = scaleCanvas.width * ftPerCanvasPx;
  const hFt = scaleCanvas.height * ftPerCanvasPx;
  const placed = { src: pendingImage.src, u0: 0, u1: wFt, v0: 0, v1: hFt };
  const done = pendingImage.onDone;
  pendingImage = null;
  done(placed, unit);
});

$('start-image').onchange = (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  openImage(file, (placed, unit) => {
    const s = tracedSite(placed);
    s.units = unit;
    adopt(s, {
      notes: [
        'Trace the lawn and the beds over the image with the Area tool, then generate a layout.',
        'Drag the water source to where your spigot actually is — every trench starts there.',
      ],
    });
  });
};

$('start-resume').onclick = () => {
  const saved = load();
  if (!saved) return;
  adopt(saved, { notes: ['Picked up where you left off.'] });
};
$('start-discard').onclick = () => {
  if (!confirm('Discard the saved plan in this browser? This cannot be undone.')) return;
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* private mode */ }
  $('resume-row').hidden = true;
};

/* --- planner wiring ----------------------------------------------------- */

for (const b of document.querySelectorAll('.tool')) b.onclick = () => setMode(b.dataset.mode);
$('btn-undo').onclick = undo;
$('btn-fit').onclick = fitLot;
$('zoom-in').onclick = () => zoomAt(0.8, view.x + view.w / 2, view.y + view.h / 2);
$('zoom-out').onclick = () => zoomAt(1.25, view.x + view.w / 2, view.y + view.h / 2);
$('chk-coverage').onchange = renderAll;
$('chk-arcs').onchange = renderAll;
$('chk-labels').onchange = renderAll;
$('sel-focus').onchange = (e) => { focusZone = e.target.value === 'all' ? null : Number(e.target.value); renderAll(); };
$('btn-home').onclick = () => { refreshResume(); show('start'); };
$('site-name').oninput = (e) => { state.site.name = e.target.value; save(); };

const liveSlider = (id, fn) => {
  $(id).addEventListener('input', (e) => fn(Number(e.target.value)));
  $(id).addEventListener('change', save);
};
liveSlider('psi', (v) => { state.supply.psi = v; renderAll(); });
liveSlider('gpm', (v) => { state.supply.gpm = v; renderAll(); });
liveSlider('north', (v) => { state.site.northDeg = v; renderAll(); });
liveSlider('water-week', (v) => { state.schedule.inchesPerWeek = v; renderAll(); });
liveSlider('days-week', (v) => { state.schedule.daysPerWeek = v; renderAll(); });

$('units').onchange = (e) => { state.units = e.target.value; syncUnitLabels(); save(); applyView(); renderAll(); };

$('btn-bucket').onclick = () => {
  const vol = Number($('bucket-vol').value), secs = Number($('bucket-sec').value);
  const gpm = bucketGpm(vol, secs, state.units);
  if (gpm == null) { $('bucket-out').textContent = 'Enter a bucket size and a time.'; return; }
  pushHistory();
  state.supply.gpm = clamp(gpm, 2, 30);
  $('bucket-out').textContent = `That is ${showFlow(gpm)}. Zones will be sized at ${showFlow(gpm * FLOW_SAFETY)}.`;
  save(); renderAll();
};

const withHead = (fn) => (e) => {
  const h = state.heads.find((x) => x.id === selectedHeadId);
  if (h) fn(h, e);
};
let armed = true;
const headSlider = (id, key) => {
  $(id).addEventListener('input', withHead((h, e) => {
    if (armed) { pushHistory(); armed = false; }
    h[key] = Number(e.target.value);
    renderAll();
  }));
  $(id).addEventListener('change', () => { armed = true; save(); });
};
headSlider('h-radius', 'radius');
headSlider('h-arc', 'arc');
headSlider('h-aim', 'aim');
$('h-type').onchange = withHead((h, e) => {
  pushHistory();
  h.type = e.target.value;
  const t = HEAD_TYPES[h.type];
  h.radius = clamp(h.radius, t.min, t.max);
  state.defaults.type = h.type;
  save(); renderAll();
});
$('h-zone').onchange = withHead((h, e) => { pushHistory(); h.zone = Number(e.target.value); save(); renderAll(); });
$('btn-del').onclick = deleteSelected;
$('btn-dup').onclick = withHead((h) => {
  pushHistory();
  const c = { ...h, id: newId(), x: h.x + 3, y: h.y + 3 };
  state.heads.push(c);
  selectedHeadId = c.id;
  save(); renderAll();
});

$('btn-add-source').onclick = () => {
  pushHistory();
  const b = bounds(state.site.lot);
  const id = `s${newId()}`;
  state.sources.push({ id, name: `Source ${state.sources.length + 1}`, x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
  selectedSourceId = id;
  setMode('select');
  save(); renderAll();
};

$('btn-auto').onclick = () => {
  const hasWork = state.heads.length || state.pipes.length;
  if (hasWork && !confirm('Replace the current heads, zones and trenches with a generated layout?')) return;
  pushHistory();
  const plan = autoLayout(state, { nozzle: $('auto-nozzle').value, dripBeds: $('auto-drip').checked });
  state.heads = plan.heads;
  state.pipes = plan.pipes;
  state.drip = plan.drip;
  state.nextId = peekId();
  lastNotes = plan.notes;
  selectedHeadId = null; selectedShape = null; focusZone = null;
  save(); renderAll();
};
$('btn-clear-heads').onclick = () => {
  if (!state.heads.length && !state.pipes.length) return;
  if (!confirm('Remove every head, trench and drip zone? The yard itself stays.')) return;
  pushHistory();
  state.heads = []; state.pipes = []; state.drip = [];
  lastNotes = [];
  selectedHeadId = null;
  save(); renderAll();
};

$('btn-sheet').onclick = () => { renderSheet(state, $('sheet')); show('sheet'); };
$('btn-sheet-back').onclick = () => show('plan');
$('btn-print').onclick = () => window.print();

$('underlay-file').onchange = (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  openImage(file, (placed) => {
    pushHistory();
    state.underlay = { ...placed, opacity: Number($('underlay-op').value) || 0.85 };
    save(); renderAll();
  });
};
$('underlay-clear').onclick = () => { pushHistory(); state.underlay = null; save(); renderAll(); };
$('underlay-op').oninput = (e) => {
  $('underlay-op-out').value = e.target.value;
  if (state.underlay) { state.underlay.opacity = Number(e.target.value); renderAll(); }
};

$('btn-export').onclick = () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(state.site.name || 'irrigation-plan').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('file-import').onchange = (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  f.text()
    .then((t) => adopt(normalise(JSON.parse(t)), { notes: ['Imported.'] }))
    .catch(() => alert('That file did not read as a plan.'));
};
$('btn-reset').onclick = () => {
  if (!confirm('Clear this plan and go back to the start?')) return;
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* private mode */ }
  state = defaultState();
  history = [];
  $('resume-row').hidden = true;
  show('start');
};

/* --- boot --------------------------------------------------------------- */

function fillAreaTypes() {
  const sel = $('area-type');
  sel.innerHTML = '';
  for (const [key, kind] of Object.entries(AREA_KINDS)) {
    const o = document.createElement('option');
    o.value = key;
    o.textContent = kind.label;
    sel.append(o);
  }
}
function refreshResume() {
  let has = false;
  try { has = !!localStorage.getItem(STORAGE_KEY); } catch (_) { has = false; }
  $('resume-row').hidden = !has;
}

fillAreaTypes();
groups = buildSvg(svg);
setMode('select');
refreshResume();
syncUnitLabels();
show('start');
