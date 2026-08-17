/* 154 Low St irrigation planner — 2D plan view, no build step, no map library.

   Coordinates ("plan feet"): x = feet along Low St, left→right as seen from the street;
   y = feet from the front lot line into the yard (up on screen). Everything the user
   draws is stored in plan feet. Real-world data (parcel, aerial) is converted once. */

(function () {
  'use strict';

  // ---------- constants ----------
  const STORAGE_KEY = 'irrigation-plan-v2';
  const LEGACY_KEY = 'irrigation-plan-v1';
  const ORIGIN = { lat: 42.81322278494484, lon: -70.89522501499822 };
  const FT_PER_M = 3.28084;
  const rad = (d) => (d * Math.PI) / 180;
  const M_PER_DEG_LAT = 111132.954 - 559.822 * Math.cos(2 * rad(ORIGIN.lat)) + 1.175 * Math.cos(4 * rad(ORIGIN.lat));
  const M_PER_DEG_LON = 111412.84 * Math.cos(rad(ORIGIN.lat)) - 93.5 * Math.cos(3 * rad(ORIGIN.lat));
  // plan frame: origin at the parcel's front-left corner, u along the street, v into the lot
  const FRAME = { ox: -35, oy: -3, ux: 0.524, uy: -0.852, vx: 0.852, vy: 0.524 };
  const NORTH_DEG = -58.4; // screen rotation of true north (counter-clockwise from up)
  const UNDERLAYS = {
    aerial: { src: 'img/aerial-2025.jpg', u0: -30, u1: 90, v0: -25, v1: 125 }, // MassGIS spring 2025, pre-rotated
    sketch: { src: 'img/layout-sketch.jpg', u0: -31.4, u1: 77.05, v0: -25, v1: 110.6 }, // Ryan's layout sketch (11.8 px/ft)
  };
  const SEED_VERSION = 6;

  const ZONE_COLORS = ['#6fd39b', '#4fb2ff', '#ffb648', '#ff6b9d', '#c48bff', '#4fe0d8'];
  const AREA_STYLE = {
    lawn: { label: 'Lawn', color: '#5da86a', fill: '#4c8f57', order: 0, pattern: 'url(#pat-lawn)' },
    bed: { label: 'Bed', color: '#c9a067', fill: '#8a6a3f', order: 1, pattern: 'url(#pat-bed)' },
    hardscape: { label: 'Hardscape', color: '#b9bbb6', fill: '#8d8f8a', order: 2, pattern: 'url(#pat-paver)' },
    structure: { label: 'Structure', color: '#3a3a3a', fill: '#ece8dc', order: 3, pattern: null },
    tree: { label: 'Tree', color: '#2f8f4a', fill: 'url(#grad-tree)', order: 4, pattern: null },
    woods: { label: 'Woods', color: '#2f5f3a', fill: '#24422c', order: 0.5, pattern: 'url(#pat-woods)' },
    fence: { label: 'Fence', color: '#f4f4f4', fill: 'none', order: 5, pattern: null, open: true },
  };
  // Nozzle chart approximations. radius = nominal radius at rated PSI. gpm ≈ k * r^2 * arc/360.
  const HEAD_TYPES = {
    spray: { label: 'Spray', ratedPsi: 30, k: 0.0165, min: 4, max: 15 },
    rotor: { label: 'Rotor', ratedPsi: 45, k: 0.0033, min: 15, max: 35 },
    mp: { label: 'MP rotator', ratedPsi: 40, k: 0.0028, min: 8, max: 30 },
  };

  // ---------- geometry ----------
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function lonLatToPlan([lon, lat]) {
    const x = (lon - ORIGIN.lon) * M_PER_DEG_LON * FT_PER_M, y = (lat - ORIGIN.lat) * M_PER_DEG_LAT * FT_PER_M;
    const dx = x - FRAME.ox, dy = y - FRAME.oy;
    return { x: dx * FRAME.ux + dy * FRAME.uy, y: dx * FRAME.vx + dy * FRAME.vy };
  }
  const legacyToPlan = (p) => { const dx = p.x - FRAME.ox, dy = p.y - FRAME.oy; return { x: dx * FRAME.ux + dy * FRAME.uy, y: dx * FRAME.vx + dy * FRAME.vy }; };
  function pointInPoly(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
      if (yi > pt.y !== yj > pt.y && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function polyArea(poly) { let a = 0; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y); return Math.abs(a / 2); }
  function centroid(poly) { let x = 0, y = 0; for (const p of poly) { x += p.x; y += p.y; } return { x: x / poly.length, y: y / poly.length }; }
  // aim: degrees clockwise from "up" (into the back yard)
  const aimVec = (deg) => ({ x: Math.sin(rad(deg)), y: Math.cos(rad(deg)) });
  const bearing = (from, to) => ((Math.atan2(to.x - from.x, to.y - from.y) * 180) / Math.PI + 360) % 360;
  function sectorPoints(head, r) {
    const pts = head.arc >= 360 ? [] : [{ x: head.x, y: head.y }];
    const steps = Math.max(12, Math.round(head.arc / 2));
    for (let i = 0; i <= steps; i++) {
      const a = head.aim - head.arc / 2 + (head.arc * i) / steps;
      const v = aimVec(a); pts.push({ x: head.x + r * v.x, y: head.y + r * v.y });
    }
    return pts;
  }
  function inSector(head, r, p) {
    const d = dist(head, p);
    if (d > r) return false;
    if (head.arc >= 360 || d < 0.01) return true;
    const diff = Math.abs((((bearing(head, p) - head.aim) % 360) + 540) % 360 - 180);
    return diff <= head.arc / 2 + 0.01;
  }
  // polygon strip of width w along a quadratic curve a→(control c)→b
  function curvedStrip(a, c, b, w, n = 14) {
    const left = [], right = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, mt = 1 - t;
      const p = { x: mt * mt * a.x + 2 * mt * t * c.x + t * t * b.x, y: mt * mt * a.y + 2 * mt * t * c.y + t * t * b.y };
      const d = { x: 2 * mt * (c.x - a.x) + 2 * t * (b.x - c.x), y: 2 * mt * (c.y - a.y) + 2 * t * (b.y - c.y) };
      const L = Math.hypot(d.x, d.y) || 1, nx = -d.y / L, ny = d.x / L;
      left.push({ x: p.x + nx * w / 2, y: p.y + ny * w / 2 }); right.push({ x: p.x - nx * w / 2, y: p.y - ny * w / 2 });
    }
    return [...left, ...right.reverse()];
  }
  function circlePoints(c, r, n = 40) { const pts = []; for (let i = 0; i < n; i++) pts.push({ x: c.x + r * Math.cos((2 * Math.PI * i) / n), y: c.y + r * Math.sin((2 * Math.PI * i) / n) }); return pts; }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // ---------- state ----------
  const defaultState = () => ({
    version: 2,
    supply: { psi: 50, gpm: 10 },
    defaults: { type: 'spray', arc: 180, radius: 12 },
    sources: defaultSources(),
    heads: [], pipes: [], areas: [],
    seedVersion: SEED_VERSION,
    nextId: 1,
  });
  const defaultSources = () => [
    { id: 's1', name: 'Back hose bib', x: 37, y: 79 }, // rear wall, right of the outdoor shower
    { id: 's2', name: 'Front hose bib', x: 53.2, y: 54.2 }, // front wall, near the right corner
  ];
  let state = loadState();
  let history = [];
  let selectedHeadId = null;
  let selectedShape = null; // {kind:'area'|'pipe', id}
  let selectedSourceId = null;
  let mode = 'select';
  let draft = null;
  let cursor = null; // plan point under the pointer while drafting

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const st = Object.assign(defaultState(), JSON.parse(raw));
        if (st.source && !Array.isArray(st.sources)) { st.sources = defaultSources(); delete st.source; }
        if (!Array.isArray(st.sources) || !st.sources.length) st.sources = defaultSources();
        for (const p of st.pipes || []) for (const pt of p.pts) if (pt.source === true) { pt.sourceId = 's1'; delete pt.source; }
        if ((st.seedVersion || 0) < SEED_VERSION && !st.heads.length && !st.pipes.length) st.areas = [];
        return st;
      }
      const old = localStorage.getItem(LEGACY_KEY);
      if (old) {
        const s = JSON.parse(old);
        if ((s.heads || []).length || (s.pipes || []).length) return migrateV1(s);
      }
    } catch (e) { console.warn('bad saved state', e); }
    return defaultState();
  }
  function migrateV1(s) {
    const n = Object.assign(defaultState(), { supply: s.supply, defaults: s.defaults, nextId: s.nextId });
    n.sources = defaultSources();
    n.heads = (s.heads || []).map((h) => ({ ...h, ...legacyToPlan(h), aim: Math.round((h.aim - 58.4 + 720) % 360) }));
    n.pipes = (s.pipes || []).map((p) => ({ ...p, pts: p.pts.map((pt) => { const q = { ...pt, ...legacyToPlan(pt) }; if (q.source) { q.sourceId = 's1'; delete q.source; } return q; }) }));
    n.areas = []; // old seeded areas were rough; reseed
    return n;
  }
  function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  function pushHistory() { history.push(JSON.stringify(state)); if (history.length > 80) history.shift(); }
  function undo() {
    if (!history.length) return;
    state = Object.assign(defaultState(), JSON.parse(history.pop()));
    if (!state.heads.find((h) => h.id === selectedHeadId)) selectedHeadId = null;
    selectedShape = null; save(); renderAll();
  }
  const newId = () => state.nextId++;

  // Site layout in plan feet, traced from Ryan's layout sketch (Photos/layout.heic, ~11.8 px/ft)
  // with the 2025 aerial as a cross-check. Every shape stays editable.
  function seedAreas() {
    const A = (type, name, pts, extra) => ({ id: newId(), type, name, pts, ...(extra || {}) });
    const R = (type, name, u0, v0, u1, v1) => A(type, name, [{ x: u0, y: v0 }, { x: u1, y: v0 }, { x: u1, y: v1 }, { x: u0, y: v1 }]);
    state.areas = state.areas.filter((a) => a.keep);
    state.areas.push(
      // lawns
      A('lawn', 'Left front', [{ x: -6, y: 25 }, { x: -4.3, y: 16 }, { x: -4.3, y: 8 }, { x: -0.5, y: 8 }, { x: -0.5, y: 7.2 }, { x: 13.5, y: 7.2 }, { x: 13.5, y: 46.2 }, { x: 13.1, y: 46.2 }, { x: 13.1, y: 50.8 }, { x: -6, y: 50.8 }]),
      A('lawn', 'Front lawn', [{ x: 27, y: -17 }, { x: 73.7, y: -17 }, { x: 72, y: 55.5 }, { x: 69.9, y: 55.5 }, { x: 69.9, y: 44.5 }, { x: 27, y: 44.5 }]),
      A('lawn', 'Back yard', [{ x: -6, y: 50.8 }, { x: 13.1, y: 50.8 }, { x: 13.1, y: 55.5 }, { x: 69.9, y: 55.5 }, { x: 67.3, y: 106.8 }, { x: -6, y: 106.4 }]),
      // hardscape
      A('hardscape', 'Driveway', [{ x: -0.5, y: -17 }, { x: 27, y: -17 }, { x: 27, y: 46.2 }, { x: 13.5, y: 46.2 }, { x: 13.5, y: 7.2 }, { x: -0.5, y: 7.2 }]),
      R('hardscape', 'Driveway steps', 27, 27, 31.3, 33),
      A('hardscape', 'Walk to front door', curvedStrip({ x: 42.2, y: 44.9 }, { x: 42.6, y: 31 }, { x: 31.3, y: 30.2 }, 3.4)),
      R('hardscape', 'Side steps', 9.7, 37.7, 13.5, 42.8),
      R('hardscape', 'Front steps', 38.9, 44.9, 45.3, 54.7),
      R('hardscape', 'Patio', 11.8, 68.2, 27.5, 81.8),
      A('hardscape', 'Fire pit', circlePoints({ x: 20.4, y: 96.4 }, 2.1, 16)),
      // gardens
      A('bed', 'Back fence bed', [{ x: 10, y: 102 }, { x: 66.9, y: 102 }, { x: 66.9, y: 106.8 }, { x: 10, y: 106.4 }]),
      A('bed', 'Front bed (left)', [{ x: 28.3, y: 44.9 }, { x: 38.9, y: 44.9 }, { x: 38.9, y: 54.7 }, { x: 28.3, y: 54.7 }, { x: 27.9, y: 50 }]),
      R('bed', 'Front bed (right)', 45.3, 44.5, 69.9, 55.1),
      R('bed', 'Bed by shed', 5, 96, 7.5, 103.4),
      R('bed', 'Bed below shed', -3.9, 90.5, 5.4, 93.6),
      R('bed', 'Left fence bed 1', -4.7, 84.7, -1.3, 87.7),
      R('bed', 'Left fence bed 2', -4.3, 76.7, -1.3, 81),
      R('bed', 'Left fence bed 3', -4.7, 72, -1.7, 74.6),
      R('bed', 'Gate bed 1', -4.7, 46.2, -0.9, 49.2),
      R('bed', 'Gate bed 2', 5.9, 47.5, 8, 50),
      R('bed', 'Gate bed 3', 9.7, 46.2, 12.2, 49.2),
      R('bed', 'Climbing plant', 27.1, 86.9, 34.3, 89.8),
      R('bed', 'Raised bed 1', 61.15, 68.6, 65.35, 71.2),
      R('bed', 'Raised bed 2', 60.7, 62.3, 65.8, 64.8),
      R('bed', 'Raised bed 3', 58.8, 56.4, 67.7, 58.9),
      // woods left of the fence, plus the strip in front of it down to the driveway apron
      A('woods', 'Woods', [{ x: -6, y: 106.4 }, { x: -17, y: 107 }, { x: -17, y: -14 }, { x: -0.5, y: -14 }, { x: -0.5, y: 8 }, { x: -4.3, y: 8 }, { x: -4.3, y: 16 }, { x: -6, y: 25 }, { x: -6, y: 50.8 }]),
      // structures
      A('structure', 'House', [{ x: 13.1, y: 46.2 }, { x: 27.9, y: 46.2 }, { x: 27.9, y: 54.7 }, { x: 57.1, y: 54.7 }, { x: 57.1, y: 79.7 }, { x: 27.9, y: 79.7 }, { x: 27.9, y: 68.2 }, { x: 13.1, y: 68.2 }], { house: true }),
      R('structure', 'Shed', -3.9, 93.6, 5.4, 103.4),
      R('structure', 'Outdoor shower', 27.5, 79.7, 35.1, 86.9),
      // fences
      A('fence', 'Yard fence', [{ x: 13.1, y: 50.8 }, { x: -6, y: 50.8 }, { x: -6, y: 106.4 }, { x: 67.3, y: 106.8 }, { x: 73.7, y: 1.3 }], { open: true }),
      A('fence', 'Side gate fence', [{ x: 57.1, y: 55.5 }, { x: 69.9, y: 55.5 }], { open: true }),
    );
    state.seedVersion = SEED_VERSION;
  }

  // ---------- head physics ----------
  function effectiveRadius(head) {
    const t = HEAD_TYPES[head.type] || HEAD_TYPES.spray;
    return Math.max(2, head.radius * clamp(Math.sqrt(state.supply.psi / t.ratedPsi), 0.6, 1.25));
  }
  function headGpm(head) {
    const t = HEAD_TYPES[head.type] || HEAD_TYPES.spray;
    return t.k * head.radius * head.radius * (head.arc / 360) * Math.sqrt(state.supply.psi / t.ratedPsi);
  }
  const zoneColor = (z) => ZONE_COLORS[(z - 1) % ZONE_COLORS.length];
  const headNo = (h) => state.heads.indexOf(h) + 1;

  // ---------- SVG plan view ----------
  const $ = (id) => document.getElementById(id);
  const svg = $('plan');
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  };
  const P = (p) => `${p.x.toFixed(2)},${(-p.y).toFixed(2)}`; // plan → svg (y flipped)
  const pointsAttr = (pts) => pts.map(P).join(' ');

  let parcel = null, parcelBounds = null;
  const view = { x: -20, y: -120, w: 120, h: 130 }; // svg viewBox in plan units (y already flipped)
  let pxPerFt = 6;
  const groups = {};

  function buildSvg() {
    svg.innerHTML = '';
    const defs = el('defs', {}, svg);
    defs.innerHTML = `
      <pattern id="pat-lawn" width="3" height="3" patternUnits="userSpaceOnUse"><rect width="3" height="3" fill="#4c8f57"/><circle cx="0.8" cy="0.9" r="0.28" fill="#57a064"/><circle cx="2.3" cy="2.2" r="0.28" fill="#43824e"/></pattern>
      <pattern id="pat-bed" width="2.5" height="2.5" patternUnits="userSpaceOnUse"><rect width="2.5" height="2.5" fill="#7c5f39"/><circle cx="1.25" cy="1.25" r="0.55" fill="#4f8a49" opacity="0.8"/><circle cx="0.3" cy="2.2" r="0.25" fill="#5f9a56" opacity="0.6"/></pattern>
      <pattern id="pat-paver" width="4" height="2" patternUnits="userSpaceOnUse"><rect width="4" height="2" fill="#8d8f8a"/><path d="M0,0 H4 M0,1 H4 M2,0 V1 M0,1 V2 M4,1 V2" stroke="#7a7c77" stroke-width="0.12"/></pattern>
      <pattern id="pat-asphalt" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill="#3a3d42"/><circle cx="1" cy="2" r="0.2" fill="#454850"/><circle cx="4" cy="5" r="0.2" fill="#33363b"/></pattern>
      <pattern id="pat-woods" width="5" height="5" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="#24422c"/><circle cx="1.5" cy="1.5" r="1.1" fill="#2e5a38"/><circle cx="3.8" cy="3.6" r="0.9" fill="#1c3623"/><circle cx="4.2" cy="1" r="0.5" fill="#33653f"/></pattern>
      <radialGradient id="grad-tree"><stop offset="0" stop-color="#2f8f4a" stop-opacity="0.65"/><stop offset="0.8" stop-color="#2f8f4a" stop-opacity="0.45"/><stop offset="1" stop-color="#2f8f4a" stop-opacity="0.15"/></radialGradient>
      <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0.6" dy="0.9" stdDeviation="0.6" flood-color="#000" flood-opacity="0.45"/></filter>
      <filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0.2" dy="0.3" stdDeviation="0.3" flood-color="#000" flood-opacity="0.35"/></filter>`;
    for (const g of ['ground', 'underlay', 'areas', 'coverage', 'features', 'parcel', 'sectors', 'pipes', 'source', 'heads', 'handles', 'draft', 'labels']) groups[g] = el('g', { id: `g-${g}` }, svg);
    applyView();
  }

  function applyView() {
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    const r = svg.getBoundingClientRect();
    pxPerFt = Math.min(r.width / view.w, r.height / view.h) || 6;
    updateScalebar();
  }
  function fitParcel() {
    if (!parcelBounds) return;
    const r = svg.getBoundingClientRect();
    const pad = 8;
    const w = parcelBounds.maxX - parcelBounds.minX + pad * 2, h = parcelBounds.maxY - parcelBounds.minY + pad * 2 + 8;
    const aspect = r.width / Math.max(1, r.height);
    let vw = w, vh = h;
    if (vw / vh < aspect) vw = vh * aspect; else vh = vw / aspect;
    view.w = vw; view.h = vh;
    view.x = (parcelBounds.minX + parcelBounds.maxX) / 2 - vw / 2;
    view.y = -((parcelBounds.minY + parcelBounds.maxY) / 2 - 4) - vh / 2;
    applyView(); renderAll();
  }
  function zoomAt(factor, cx, cy) {
    const nw = clamp(view.w * factor, 30, 600), nh = view.h * (nw / view.w);
    view.x = cx - (cx - view.x) * (nw / view.w); view.y = cy - (cy - view.y) * (nh / view.h);
    view.w = nw; view.h = nh; applyView(); renderAll();
  }
  function clientToSvg(cx, cy) {
    const pt = svg.createSVGPoint(); pt.x = cx; pt.y = cy;
    const m = svg.getScreenCTM(); if (!m) return { x: 0, y: 0 };
    const q = pt.matrixTransform(m.inverse()); return { x: q.x, y: q.y };
  }
  const clientToPlan = (cx, cy) => { const q = clientToSvg(cx, cy); return { x: q.x, y: -q.y }; };
  function updateScalebar() {
    let ft = 10; for (const t of [1, 2, 5, 10, 20, 50, 100]) if (t * pxPerFt <= 140) ft = t;
    $('scalebar').querySelector('.bar').style.width = `${ft * pxPerFt}px`;
    $('scale-txt').textContent = `${ft} ft`;
  }
  const px = (n) => n / pxPerFt; // screen pixels → plan feet

  async function loadSite() {
    const parcelGj = await fetch('data/parcel.geojson').then((r) => r.json());
    parcel = parcelGj.features[0].geometry.coordinates[0].map(lonLatToPlan);
    const xs = parcel.map((p) => p.x), ys = parcel.map((p) => p.y);
    parcelBounds = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
    if (!state.areas.length) { seedAreas(); save(); }
    fitParcel();
  }

  // ---------- rendering ----------
  function renderAll() {
    if (!parcel) return;
    renderGround(); renderAreas(); renderCoverage(); renderParcel(); renderSectors(); renderPipes(); renderSource(); renderHeads(); renderHandles(); renderDraft(); renderLabels(); renderPanel();
  }
  const clear = (g) => { while (g.firstChild) g.removeChild(g.firstChild); };

  function renderGround() {
    const g = groups.ground; clear(g);
    el('rect', { x: -400, y: -400, width: 800, height: 800, fill: '#1a221c' }, g);
    el('polygon', { points: pointsAttr(parcel), fill: '#2b3a2f' }, g); // bare earth inside the lot
    // street (v -36..-11), verge (-11..0) with a sidewalk slab
    el('rect', { x: -200, y: 18, width: 400, height: 30, fill: 'url(#pat-asphalt)' }, g); // Low St, v -18..-48
    el('rect', { x: -200, y: 0, width: 400, height: 18, fill: '#4f5a50' }, g); // verge
    el('rect', { x: -200, y: 14, width: 400, height: 4, fill: '#7d837e' }, g); // sidewalk
    el('rect', { x: -44, y: -140, width: 25, height: 158, fill: 'url(#pat-asphalt)' }, g); // side street on the left, u -44..-19
    el('line', { x1: -200, y1: 33, x2: 200, y2: 33, stroke: '#d9c86a', 'stroke-width': 0.35, 'stroke-dasharray': '6 5' }, g);
    const u = groups.underlay; clear(u);
    const UL = UNDERLAYS[$('sel-underlay').value];
    groups.areas.setAttribute('opacity', UL ? 0.35 : 1);
    groups.features.setAttribute('opacity', UL ? 0.55 : 1);
    if (UL) el('image', { href: UL.src, x: UL.u0, y: -UL.v1, width: UL.u1 - UL.u0, height: UL.v1 - UL.v0, preserveAspectRatio: 'none', opacity: $('aerial-opacity').value }, u);
  }

  function renderParcel() {
    const g = groups.parcel; clear(g);
    el('polygon', { points: pointsAttr(parcel), fill: 'none', stroke: '#ffe066', 'stroke-width': px(1.5), 'stroke-dasharray': `${px(7)} ${px(5)}`, 'pointer-events': 'none' }, g);
  }

  const sortedAreas = () => [...state.areas].sort((a, b) => AREA_STYLE[a.type].order - AREA_STYLE[b.type].order);

  function renderAreas() {
    clear(groups.areas); clear(groups.features);
    for (const a of sortedAreas()) {
      const st = AREA_STYLE[a.type];
      const g = st.order >= 3 ? groups.features : groups.areas; // structures, trees, fences sit above the coverage tint
      const sel = selectedShape && selectedShape.kind === 'area' && selectedShape.id === a.id;
      let node;
      if (st.open) {
        node = el('polyline', { points: pointsAttr(a.pts), fill: 'none', stroke: st.color, 'stroke-width': px(3), 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.95 }, g);
        for (const p of a.pts) el('circle', { cx: p.x, cy: -p.y, r: px(2.6), fill: st.color, 'pointer-events': 'none' }, g);
      } else if (a.type === 'structure') {
        node = el('polygon', { points: pointsAttr(a.pts), fill: st.fill, stroke: st.color, 'stroke-width': px(1.2), filter: 'url(#shadow)' }, g);
        if (a.house) renderHouseDetail(a, g);
      } else if (a.type === 'tree') {
        node = el('polygon', { points: pointsAttr(a.pts), fill: st.fill, stroke: st.color, 'stroke-width': px(1), 'stroke-dasharray': `${px(3)} ${px(3)}`, opacity: 0.95 }, g);
        const c = centroid(a.pts); el('circle', { cx: c.x, cy: -c.y, r: 1.1, fill: '#5a3d1e', stroke: '#2a1a0a', 'stroke-width': 0.2, 'pointer-events': 'none' }, g);
      } else {
        node = el('polygon', { points: pointsAttr(a.pts), fill: st.pattern || st.fill, stroke: st.color, 'stroke-width': px(1), 'stroke-opacity': 0.9 }, g);
      }
      if (sel) { node.setAttribute('stroke', '#fff'); node.setAttribute('stroke-width', px(2.5)); }
      node.dataset.kind = 'area'; node.dataset.id = a.id; node.classList.add('shape');
    }
  }
  function renderHouseDetail(a, g) {
    const xs = a.pts.map((p) => p.x), ys = a.pts.map((p) => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    el('text', { x: (minX + maxX) / 2, y: -((minY + maxY) / 2), 'font-size': px(11), fill: '#3a3a3a', 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'pointer-events': 'none', 'font-weight': 600, opacity: 0.55 }, g).textContent = '154';
  }

  function renderSectors() {
    const g = groups.sectors; clear(g);
    for (const h of state.heads) {
      const color = zoneColor(h.zone);
      el('polygon', { points: pointsAttr(sectorPoints(h, effectiveRadius(h))), fill: color, 'fill-opacity': 0.2, stroke: color, 'stroke-width': px(1), 'stroke-opacity': 0.85, 'pointer-events': 'none' }, g);
    }
  }

  function renderPipes() {
    const g = groups.pipes; clear(g);
    for (const p of state.pipes) {
      const sel = selectedShape && selectedShape.kind === 'pipe' && selectedShape.id === p.id;
      const line = el('polyline', { points: pointsAttr(p.pts), fill: 'none', stroke: '#111', 'stroke-width': px(sel ? 9 : 7), 'stroke-opacity': 0.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
      const top = el('polyline', { points: pointsAttr(p.pts), fill: 'none', stroke: zoneColor(p.zone), 'stroke-width': px(sel ? 5 : 3.5), 'stroke-dasharray': `${px(9)} ${px(6)}`, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
      for (const n of [line, top]) { n.dataset.kind = 'pipe'; n.dataset.id = p.id; n.classList.add('shape'); }
    }
  }
  const pipeLength = (p) => { let s = 0; for (let i = 1; i < p.pts.length; i++) s += dist(p.pts[i - 1], p.pts[i]); return s; };
  function syncPipesToHeads() {
    for (const p of state.pipes) for (const pt of p.pts) {
      if (pt.headId != null) { const h = state.heads.find((x) => x.id === pt.headId); if (h) { pt.x = h.x; pt.y = h.y; } }
      if (pt.sourceId) { const sr = state.sources.find((x) => x.id === pt.sourceId); if (sr) { pt.x = sr.x; pt.y = sr.y; } }
    }
  }

  function renderSource() {
    const g = groups.source; clear(g);
    const r = px(9);
    for (const sr of state.sources) {
      const sel = selectedSourceId === sr.id;
      const grp = el('g', { class: 'drag', 'data-drag': 'source', 'data-id': sr.id, transform: `translate(${sr.x},${-sr.y})`, filter: 'url(#soft)' }, g);
      el('path', { d: `M0,0 C${-r},${-r * 1.2} ${-r},${-r * 2.2} 0,${-r * 2.4} C${r},${-r * 2.2} ${r},${-r * 1.2} 0,0 Z`, fill: '#4fb2ff', stroke: '#fff', 'stroke-width': px(sel ? 3 : 1.5) }, grp);
      el('circle', { cx: 0, cy: -r * 1.45, r: r * 0.35, fill: '#fff' }, grp);
      el('title', {}, grp).textContent = `${sr.name} — drag to move, click then Delete to remove`;
    }
  }

  function renderHeads() {
    const g = groups.heads; clear(g);
    for (const h of state.heads) {
      const color = zoneColor(h.zone), sel = h.id === selectedHeadId, r = px(sel ? 8 : 6.5);
      const grp = el('g', { class: 'drag', 'data-drag': 'head', 'data-id': h.id, transform: `translate(${h.x},${-h.y})` }, g);
      el('title', {}, grp).textContent = `Head ${headNo(h)} · ${HEAD_TYPES[h.type].label} ${h.radius} ft ${h.arc}°`;
      el('circle', { r: r + px(2), fill: '#000', 'fill-opacity': 0.5 }, grp);
      el('circle', { r, fill: color, stroke: '#fff', 'stroke-width': px(sel ? 3 : 2) }, grp);
      el('text', { y: px(3.5), 'font-size': px(9), 'text-anchor': 'middle', fill: '#0b1a12', 'font-weight': 700, 'pointer-events': 'none' }, grp).textContent = headNo(h);
    }
  }

  function renderHandles() {
    const g = groups.handles; clear(g);
    if (mode !== 'select') return;
    const h = state.heads.find((x) => x.id === selectedHeadId);
    if (h) {
      const r = effectiveRadius(h), v = aimVec(h.aim), tip = { x: h.x + r * v.x, y: h.y + r * v.y };
      el('line', { x1: h.x, y1: -h.y, x2: tip.x, y2: -tip.y, stroke: '#fff', 'stroke-width': px(1.5), 'stroke-dasharray': `${px(3)} ${px(3)}`, 'pointer-events': 'none' }, g);
      const hd = el('circle', { class: 'drag', 'data-drag': 'aim', 'data-id': h.id, cx: tip.x, cy: -tip.y, r: px(6), fill: '#fff', stroke: '#111', 'stroke-width': px(1.5) }, g);
      el('title', {}, hd).textContent = 'Drag to aim and set the reach';
      return;
    }
    const obj = selectedShapeObj(); if (!obj) return;
    const closed = selectedShape.kind === 'area' && !obj.open;
    const pts = obj.pts;
    pts.forEach((pt, i) => el('circle', { class: 'drag vtx', 'data-drag': 'vtx', 'data-index': i, cx: pt.x, cy: -pt.y, r: px(5.5), fill: '#fff', stroke: '#111', 'stroke-width': px(1.5) }, g));
    const n = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      el('circle', { class: 'mid', 'data-mid': i, cx: (a.x + b.x) / 2, cy: -(a.y + b.y) / 2, r: px(4.5), fill: 'rgba(255,255,255,0.35)', stroke: '#fff', 'stroke-width': px(1.2) }, g);
    }
  }

  function renderDraft() {
    const g = groups.draft; clear(g);
    if (!draft || !draft.pts.length) return;
    const pts = [...draft.pts]; if (cursor) pts.push(cursor);
    const color = draft.kind === 'pipe' ? zoneColor(Number($('pipe-zone').value) || 1) : draft.kind === 'area' ? AREA_STYLE[$('area-type').value].color : '#fff';
    const closedish = draft.kind === 'area' && !AREA_STYLE[$('area-type').value].open && pts.length > 2;
    el(closedish ? 'polygon' : 'polyline', { points: pointsAttr(pts), fill: closedish ? color : 'none', 'fill-opacity': 0.12, stroke: color, 'stroke-width': px(2), 'stroke-dasharray': `${px(4)} ${px(4)}`, 'pointer-events': 'none' }, g);
    for (const q of draft.pts) el('circle', { cx: q.x, cy: -q.y, r: px(3.5), fill: color, stroke: '#fff', 'stroke-width': px(1), 'pointer-events': 'none' }, g);
    if (draft.kind === 'measure' || draft.kind === 'pipe') {
      let len = 0; for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
      const at = pts[pts.length - 1];
      el('text', { x: at.x + px(10), y: -at.y + px(4), 'font-size': px(12), fill: '#fff', 'font-weight': 700, 'paint-order': 'stroke', stroke: '#000', 'stroke-width': px(3), 'pointer-events': 'none' }, g).textContent = `${len.toFixed(1)} ft`;
    }
  }

  function renderLabels() {
    const g = groups.labels; clear(g);
    el('text', { x: 30, y: 38, 'font-size': px(13), fill: '#c8c8c8', 'text-anchor': 'middle', 'font-weight': 600, 'letter-spacing': px(2), 'pointer-events': 'none', opacity: 0.8 }, g).textContent = 'LOW STREET';
    if (!$('chk-labels').checked) return;
    for (const a of state.areas) {
      if (a.type === 'fence' || a.house) continue;
      const xs = a.pts.map((p) => p.x), ys = a.pts.map((p) => p.y);
      const wPx = (Math.max(...xs) - Math.min(...xs)) * pxPerFt, hPx = (Math.max(...ys) - Math.min(...ys)) * pxPerFt;
      if (wPx < a.name.length * 6 + 6 && hPx < 24) continue;
      const c = centroid(a.pts);
      el('text', { x: c.x, y: -c.y, 'font-size': px(10.5), fill: '#fff', 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'paint-order': 'stroke', stroke: 'rgba(0,0,0,0.7)', 'stroke-width': px(3), 'pointer-events': 'none' }, g).textContent = a.name;
    }
    for (const sr of state.sources) el('text', { x: sr.x, y: -sr.y - px(24), 'font-size': px(10), fill: '#9fd3ff', 'text-anchor': 'middle', 'paint-order': 'stroke', stroke: 'rgba(0,0,0,0.75)', 'stroke-width': px(3), 'pointer-events': 'none' }, g).textContent = sr.name;
    for (const p of state.pipes) {
      const mid = p.pts[Math.floor(p.pts.length / 2)];
      el('text', { x: mid.x, y: -mid.y - px(8), 'font-size': px(10), fill: zoneColor(p.zone), 'text-anchor': 'middle', 'paint-order': 'stroke', stroke: 'rgba(0,0,0,0.8)', 'stroke-width': px(3), 'pointer-events': 'none' }, g).textContent = `${pipeLength(p).toFixed(0)} ft`;
    }
  }

  // Coverage raster: canvas over the parcel bbox; counts heads reaching each lawn/bed cell.
  let coverageStats = { pct: null, pct2: null };
  function renderCoverage() {
    const g = groups.coverage; clear(g);
    if (!$('chk-coverage').checked || !state.heads.length) { coverageStats = { pct: null, pct2: null }; return; }
    const b = parcelBounds, res = 3;
    const minX = b.minX - 1, maxX = b.maxX + 1, minY = b.minY - 1, maxY = b.maxY + 1;
    const w = Math.ceil((maxX - minX) * res), hgt = Math.ceil((maxY - minY) * res);
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = hgt;
    const ctx = canvas.getContext('2d'); const img = ctx.createImageData(w, hgt);
    const target = state.areas.filter((a) => a.type === 'lawn' || a.type === 'bed');
    const skip = state.areas.filter((a) => a.type === 'hardscape' || a.type === 'structure' || a.type === 'woods');
    const heads = state.heads.map((h) => ({ h, r: effectiveRadius(h) }));
    let n = 0, c1 = 0, c2 = 0;
    for (let py = 0; py < hgt; py++) {
      const y = maxY - (py + 0.5) / res;
      for (let pxi = 0; pxi < w; pxi++) {
        const p = { x: minX + (pxi + 0.5) / res, y };
        if (!(target.length ? target.some((a) => pointInPoly(p, a.pts)) : pointInPoly(p, parcel))) continue;
        if (skip.some((a) => pointInPoly(p, a.pts))) continue;
        n++;
        let count = 0; for (const { h, r } of heads) if (inSector(h, r, p)) count++;
        const i = (py * w + pxi) * 4;
        if (count === 0) { img.data[i] = 255; img.data[i + 1] = 70; img.data[i + 2] = 60; img.data[i + 3] = 80; }
        else if (count === 1) { c1++; img.data[i] = 170; img.data[i + 1] = 255; img.data[i + 2] = 170; img.data[i + 3] = 45; }
        else { c1++; c2++; img.data[i] = 70; img.data[i + 1] = 160; img.data[i + 2] = 255; img.data[i + 3] = 110; }
      }
    }
    ctx.putImageData(img, 0, 0);
    el('image', { href: canvas.toDataURL(), x: minX, y: -maxY, width: maxX - minX, height: maxY - minY, preserveAspectRatio: 'none', 'pointer-events': 'none', style: 'image-rendering: pixelated' }, g);
    coverageStats = n ? { pct: (100 * c1) / n, pct2: (100 * c2) / n } : { pct: null, pct2: null };
  }

  // ---------- panel ----------
  function renderPanel() {
    $('psi').value = state.supply.psi; $('psi-out').value = state.supply.psi;
    $('gpm').value = state.supply.gpm; $('gpm-out').value = state.supply.gpm;
    $('def-type').value = state.defaults.type; $('def-arc').value = String(state.defaults.arc);
    $('def-radius').value = state.defaults.radius; $('def-radius-out').value = state.defaults.radius;
    const h = state.heads.find((x) => x.id === selectedHeadId);
    $('head-controls').hidden = !h; $('head-empty').hidden = !!h;
    $('head-title').textContent = h ? `#${headNo(h)}` : '';
    if (h) {
      $('h-type').value = h.type;
      const t = HEAD_TYPES[h.type];
      $('h-radius').min = t.min; $('h-radius').max = t.max; $('h-radius').value = h.radius; $('h-radius-out').value = h.radius;
      $('h-arc').value = h.arc; $('h-arc-out').value = h.arc;
      $('h-aim').value = h.aim; $('h-aim-out').value = h.aim;
      fillZoneSelect($('h-zone'), h.zone);
      $('h-gpm').textContent = `≈ ${headGpm(h).toFixed(1)} GPM · reaches ${effectiveRadius(h).toFixed(1)} ft at ${state.supply.psi} PSI`;
    }
    fillZoneSelect($('pipe-zone'), Number($('pipe-zone').value) || 1);
    const zones = {};
    for (const hd of state.heads) { zones[hd.zone] = zones[hd.zone] || { heads: 0, gpm: 0, pipe: 0 }; zones[hd.zone].heads++; zones[hd.zone].gpm += headGpm(hd); }
    for (const p of state.pipes) { zones[p.zone] = zones[p.zone] || { heads: 0, gpm: 0, pipe: 0 }; zones[p.zone].pipe += pipeLength(p); }
    const keys = Object.keys(zones).map(Number).sort((a, b) => a - b);
    let html = '<table class="zones"><tr><th>Zone</th><th>Heads</th><th>GPM</th><th>Pipe</th></tr>';
    for (const z of keys) {
      const zz = zones[z], over = zz.gpm > state.supply.gpm;
      html += `<tr><td><span class="swatch" style="background:${zoneColor(z)}"></span>Zone ${z}</td><td>${zz.heads}</td><td class="${over ? 'over' : ''}">${zz.gpm.toFixed(1)}${over ? ' ⚠' : ''}</td><td>${zz.pipe.toFixed(0)} ft</td></tr>`;
    }
    html += '</table>';
    $('zones-table').innerHTML = keys.length ? html : '<div class="empty">No zones yet. Add heads and pipe.</div>';
    const sl = $('sources-list'); sl.innerHTML = '';
    for (const sr of state.sources) {
      const row = document.createElement('div'); row.className = 'item' + (selectedSourceId === sr.id ? ' sel' : '');
      row.innerHTML = `<span class="swatch" style="background:#4fb2ff;border-radius:50% 50% 50% 0"></span><span class="name" title="Click to select on the plan">${sr.name}</span>`;
      row.querySelector('.name').onclick = () => { setMode('select'); selectedSourceId = sr.id; selectedHeadId = null; selectedShape = null; renderAll(); };
      const ren = document.createElement('button'); ren.className = 'ghost'; ren.textContent = 'Rename';
      ren.onclick = () => { const n = prompt('Water source name', sr.name); if (n) { pushHistory(); sr.name = n; save(); renderAll(); } };
      row.append(ren); sl.append(row);
    }
    $('stat-heads').textContent = state.heads.length;
    $('stat-pipe').textContent = `${state.pipes.reduce((s, p) => s + pipeLength(p), 0).toFixed(0)} ft`;
    $('stat-cov').textContent = coverageStats.pct == null ? '–' : `${coverageStats.pct.toFixed(0)}%`;
    $('stat-cov2').textContent = coverageStats.pct2 == null ? '–' : `${coverageStats.pct2.toFixed(0)}%`;
    const list = $('areas-list'); list.innerHTML = '';
    for (const a of state.areas) {
      const st = AREA_STYLE[a.type];
      const row = document.createElement('div'); row.className = 'item';
      const size = st.open ? `${pipeLength(a).toFixed(0)} ft` : `${polyArea(a.pts).toFixed(0)} sq ft`;
      row.innerHTML = `<span class="swatch" style="background:${st.color}"></span><span class="name" title="Click to select on the plan">${a.name}</span><span class="muted">${size}</span>`;
      row.querySelector('.name').onclick = () => { setMode('select'); selectShape('area', a.id); };
      if (selectedShape && selectedShape.kind === 'area' && selectedShape.id === a.id) row.classList.add('sel');
      const ren = document.createElement('button'); ren.className = 'ghost'; ren.textContent = 'Rename';
      ren.onclick = () => { const n = prompt('Area name', a.name); if (n) { pushHistory(); a.name = n; save(); renderAll(); } };
      const del = document.createElement('button'); del.className = 'danger'; del.textContent = '×';
      del.onclick = () => { pushHistory(); state.areas = state.areas.filter((x) => x.id !== a.id); if (selectedShape && selectedShape.id === a.id) selectedShape = null; save(); renderAll(); };
      row.append(ren, del); list.append(row);
    }
  }
  function fillZoneSelect(sel, value) { sel.innerHTML = ''; for (let z = 1; z <= 6; z++) { const o = document.createElement('option'); o.value = z; o.textContent = `Zone ${z}`; sel.append(o); } sel.value = value; }

  function selectHead(id) { selectedHeadId = id; selectedShape = null; selectedSourceId = null; renderAll(); }
  function selectShape(kind, id) {
    selectedShape = { kind, id }; selectedHeadId = null; selectedSourceId = null;
    $('hint').textContent = kind === 'area' ? 'Drag the corner dots to reshape. Click a hollow dot to add a corner. Right-click a dot to remove it. Delete key removes the area.' : 'Drag the dots to reroute the pipe. Click a hollow dot to add a bend. Right-click a dot to remove it. Delete key removes the pipe.';
    renderAll();
  }
  function selectedShapeObj() { if (!selectedShape) return null; return (selectedShape.kind === 'area' ? state.areas : state.pipes).find((x) => x.id === selectedShape.id) || null; }
  const confirmDelete = (msg) => window.confirm(msg);

  // ---------- modes ----------
  const HINTS = {
    select: 'Click a head to edit it. Drag heads, the water drop, or the white aim handle. Click an area or pipe to reshape it. Scroll to zoom, drag empty ground to pan.',
    head: 'Click on the plan to drop a sprinkler head. Press V or Esc when done.',
    pipe: 'Click points along the trench. Click heads or the water drop to snap. Double-click or Enter to finish.',
    area: 'Click the corners. Double-click or Enter to close. Fence lines stay open.',
    measure: 'Click two or more points to measure. Enter or Esc to finish.',
  };
  function setMode(m) {
    mode = m; finishDraft(false); selectedShape = null; if (m !== 'select') selectedSourceId = null;
    document.querySelectorAll('.tool').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
    $('map').className = `mode-${m}`;
    $('hint').textContent = HINTS[m];
    renderAll();
  }

  function guessAim(p) {
    // point half-circles away from the nearest structure wall / lot line
    let best = null;
    const polys = [parcel, ...state.areas.filter((a) => a.type === 'structure').map((a) => a.pts)];
    for (const poly of polys) for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const L2 = dist(a, b) ** 2 || 1;
      const t = clamp(((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / L2, 0, 1);
      const q = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) }, d = dist(p, q);
      if (!best || d < best.d) best = { d, q };
    }
    if (!best || best.d > 6) return 0;
    return Math.round(bearing(best.q, p));
  }

  function planClick(p, snap) {
    if (mode === 'head') {
      pushHistory();
      const t = HEAD_TYPES[state.defaults.type];
      const head = { id: newId(), x: p.x, y: p.y, type: state.defaults.type, radius: clamp(state.defaults.radius, t.min, t.max), arc: state.defaults.arc, aim: guessAim(p), zone: Number($('pipe-zone').value) || 1 };
      state.heads.push(head); selectedHeadId = head.id; save(); renderAll(); return;
    }
    if (mode === 'pipe' || mode === 'area' || mode === 'measure') {
      if (!draft) draft = { kind: mode, pts: [] };
      const pt = { x: p.x, y: p.y };
      if (mode === 'pipe') {
        const tol = px(10);
        if (snap && snap.head) { pt.x = snap.head.x; pt.y = snap.head.y; pt.headId = snap.head.id; }
        else if (snap && snap.source) { pt.x = snap.source.x; pt.y = snap.source.y; pt.sourceId = snap.source.id; }
        else {
          for (const h of state.heads) if (dist(h, p) < tol) { pt.x = h.x; pt.y = h.y; pt.headId = h.id; break; }
          if (!pt.headId) for (const sr of state.sources) if (dist(sr, p) < tol) { pt.x = sr.x; pt.y = sr.y; pt.sourceId = sr.id; break; }
        }
      }
      draft.pts.push(pt); renderDraft();
    }
  }
  function finishDraft(commit) {
    if (!draft) return;
    const d = draft; draft = null; cursor = null; renderDraft();
    if (!commit) return;
    if (d.kind === 'pipe' && d.pts.length >= 2) { pushHistory(); state.pipes.push({ id: newId(), zone: Number($('pipe-zone').value) || 1, pts: d.pts }); save(); renderAll(); }
    else if (d.kind === 'area') {
      const type = $('area-type').value, open = !!AREA_STYLE[type].open;
      if (d.pts.length < (open ? 2 : 3)) return;
      const name = prompt('Name this area', `${AREA_STYLE[type].label} ${state.areas.filter((a) => a.type === type).length + 1}`);
      if (name == null) return;
      pushHistory(); state.areas.push({ id: newId(), type, name, pts: d.pts, ...(open ? { open: true } : {}) }); save(); renderAll();
    }
  }
  function deleteSelected() {
    if (selectedSourceId) {
      if (state.sources.length <= 1) { alert('Keep at least one water source.'); return; }
      pushHistory();
      state.sources = state.sources.filter((x) => x.id !== selectedSourceId);
      for (const p of state.pipes) for (const pt of p.pts) if (pt.sourceId === selectedSourceId) delete pt.sourceId;
      selectedSourceId = null; save(); renderAll(); return;
    }
    if (selectedShape) {
      pushHistory();
      if (selectedShape.kind === 'area') state.areas = state.areas.filter((a) => a.id !== selectedShape.id);
      else state.pipes = state.pipes.filter((p) => p.id !== selectedShape.id);
      selectedShape = null; save(); renderAll(); return;
    }
    if (selectedHeadId == null) return;
    pushHistory();
    state.heads = state.heads.filter((h) => h.id !== selectedHeadId);
    for (const p of state.pipes) for (const pt of p.pts) if (pt.headId === selectedHeadId) delete pt.headId;
    selectedHeadId = null; save(); renderAll();
  }

  // ---------- pointer handling ----------
  let ptr = null;
  svg.addEventListener('pointerdown', (e) => {
    if (e.button === 2) return;
    svg.focus({ preventScroll: true });
    const dragEl = e.target.closest('.drag');
    const p = clientToPlan(e.clientX, e.clientY);
    ptr = { start: { cx: e.clientX, cy: e.clientY }, moved: false, view0: { ...view }, p0: p, target: e.target };
    if (dragEl && mode === 'select') { ptr.type = dragEl.dataset.drag; ptr.id = Number(dragEl.dataset.id); ptr.sid = dragEl.dataset.id; ptr.index = Number(dragEl.dataset.index); ptr.pushed = false; }
    else ptr.type = 'pan';
    svg.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  svg.addEventListener('pointermove', (e) => {
    const p = clientToPlan(e.clientX, e.clientY);
    if (draft) { cursor = p; renderDraft(); }
    if (!ptr) return;
    if (!ptr.moved && Math.hypot(e.clientX - ptr.start.cx, e.clientY - ptr.start.cy) < 4) return;
    ptr.moved = true;
    if (ptr.type === 'pan') {
      const r = svg.getBoundingClientRect(); const sx = view.w / r.width, sy = view.h / r.height;
      view.x = ptr.view0.x - (e.clientX - ptr.start.cx) * sx; view.y = ptr.view0.y - (e.clientY - ptr.start.cy) * sy;
      applyView(); renderAll(); return;
    }
    if (!ptr.pushed) { pushHistory(); ptr.pushed = true; }
    if (ptr.type === 'head') {
      const h = state.heads.find((x) => x.id === ptr.id); if (!h) return;
      h.x = p.x; h.y = p.y; syncPipesToHeads(); selectedHeadId = h.id; selectedShape = null;
      renderSectors(); renderPipes(); renderHeads(); renderHandles(); renderLabels();
    } else if (ptr.type === 'source') {
      const sr = state.sources.find((x) => x.id === ptr.sid); if (!sr) return;
      sr.x = p.x; sr.y = p.y; syncPipesToHeads(); renderPipes(); renderSource(); renderLabels();
    } else if (ptr.type === 'aim') {
      const h = state.heads.find((x) => x.id === ptr.id); if (!h) return;
      const t = HEAD_TYPES[h.type];
      h.aim = Math.round(bearing(h, p));
      const scale = clamp(Math.sqrt(state.supply.psi / t.ratedPsi), 0.6, 1.25);
      h.radius = Math.round(clamp(dist(h, p) / scale, t.min, t.max) * 2) / 2;
      renderSectors(); renderHandles(); renderPanel();
    } else if (ptr.type === 'vtx') {
      const obj = selectedShapeObj(); if (!obj) return;
      const pt = obj.pts[ptr.index]; pt.x = p.x; pt.y = p.y; delete pt.headId; delete pt.sourceId;
      if (selectedShape.kind === 'area') renderAreas(); else renderPipes();
      renderHandles(); renderLabels();
    }
  });
  svg.addEventListener('pointerup', (e) => {
    if (!ptr) return;
    const was = ptr; ptr = null;
    try { svg.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
    if (was.moved) { if (was.type !== 'pan') { save(); renderAll(); } return; }
    const t = was.target;
    if (mode === 'select') {
      const dragEl = t.closest('.drag');
      const mid = t.closest('.mid');
      if (mid) { const obj = selectedShapeObj(); if (obj) { const i = Number(mid.dataset.mid); const a = obj.pts[i], b = obj.pts[(i + 1) % obj.pts.length]; pushHistory(); obj.pts.splice(i + 1, 0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }); save(); renderAll(); } return; }
      if (dragEl && dragEl.dataset.drag === 'head') { selectHead(Number(dragEl.dataset.id)); return; }
      if (dragEl && dragEl.dataset.drag === 'source') { selectedSourceId = dragEl.dataset.id; selectedHeadId = null; selectedShape = null; $('hint').textContent = 'Water source selected. Drag to move. Delete key removes it. Rename it in the Zones card.'; renderAll(); return; }
      if (dragEl) return; // vtx / aim / source click without movement: nothing to do
      const shape = t.closest('.shape');
      if (shape) { selectShape(shape.dataset.kind, Number(shape.dataset.id)); return; }
      selectedHeadId = null; selectedShape = null; selectedSourceId = null; $('hint').textContent = HINTS.select; renderAll(); return;
    }
    const dragEl = t.closest('.drag');
    const snap = {};
    if (dragEl && dragEl.dataset.drag === 'head') snap.head = state.heads.find((x) => x.id === Number(dragEl.dataset.id));
    if (dragEl && dragEl.dataset.drag === 'source') snap.source = state.sources.find((x) => x.id === dragEl.dataset.id);
    planClick(was.p0, snap);
  });
  svg.addEventListener('dblclick', (e) => { e.preventDefault(); if (draft) { if (draft.pts.length > 1) draft.pts.pop(); finishDraft(true); } });
  svg.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const v = e.target.closest('.vtx'); if (!v) return;
    const obj = selectedShapeObj(); if (!obj) return;
    const min = selectedShape.kind === 'area' && !obj.open ? 3 : 2;
    if (obj.pts.length <= min) return;
    pushHistory(); obj.pts.splice(Number(v.dataset.index), 1); save(); renderAll();
  });
  svg.addEventListener('wheel', (e) => { e.preventDefault(); const q = clientToSvg(e.clientX, e.clientY); zoomAt(Math.exp(e.deltaY * 0.0015), q.x, q.y); }, { passive: false });
  window.addEventListener('resize', () => { applyView(); renderAll(); });

  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    if (e.key === 'Enter') { finishDraft(true); return; }
    if (e.key === 'Escape') { if (draft) finishDraft(false); else setMode('select'); return; }
    const k = e.key.toLowerCase();
    if (k === 'v') setMode('select'); else if (k === 'h') setMode('head'); else if (k === 'p') setMode('pipe'); else if (k === 'a') setMode('area'); else if (k === 'm') setMode('measure');
    else if (e.key === 'Delete' || e.key === 'Backspace') { if (selectedHeadId != null || selectedShape || selectedSourceId) { e.preventDefault(); deleteSelected(); } }
    else if (selectedHeadId != null && (e.key === '[' || e.key === ']')) {
      const h = state.heads.find((x) => x.id === selectedHeadId); if (!h) return;
      h.aim = (h.aim + (e.key === ']' ? 5 : -5) + 360) % 360; save(); renderAll();
    }
  });

  // ---------- panel wiring ----------
  document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('btn-undo').onclick = undo;
  $('btn-fit').onclick = fitParcel;
  $('zoom-in').onclick = () => zoomAt(0.8, view.x + view.w / 2, view.y + view.h / 2);
  $('zoom-out').onclick = () => zoomAt(1.25, view.x + view.w / 2, view.y + view.h / 2);
  $('chk-coverage').onchange = renderAll;
  $('chk-labels').onchange = renderLabels;
  $('sel-underlay').onchange = renderGround;
  $('btn-reseed').onclick = () => { if (!confirmDelete('Replace all areas with the traced layout? Heads and pipes stay.')) return; pushHistory(); seedAreas(); selectedShape = null; save(); renderAll(); };
  $('aerial-opacity').oninput = renderGround;
  $('compass-rot').setAttribute('transform', `rotate(${NORTH_DEG})`);

  const liveSlider = (id, fn) => { $(id).addEventListener('input', (e) => fn(Number(e.target.value))); $(id).addEventListener('change', save); };
  liveSlider('psi', (v) => { state.supply.psi = v; renderAll(); });
  liveSlider('gpm', (v) => { state.supply.gpm = v; renderPanel(); });
  liveSlider('def-radius', (v) => { state.defaults.radius = v; $('def-radius-out').value = v; });
  $('def-type').onchange = (e) => { state.defaults.type = e.target.value; const t = HEAD_TYPES[state.defaults.type]; state.defaults.radius = clamp(state.defaults.radius, t.min, t.max); save(); renderPanel(); };
  $('def-arc').onchange = (e) => { state.defaults.arc = Number(e.target.value); save(); };
  $('btn-bucket').onclick = () => { const s = Number($('bucket-sec').value); if (s > 0) { state.supply.gpm = Math.round((5 / s) * 60 * 2) / 2; save(); renderPanel(); } };

  const withHead = (fn) => (e) => { const h = state.heads.find((x) => x.id === selectedHeadId); if (!h) return; fn(h, e); };
  let armed = true;
  const headSlider = (id, key) => {
    $(id).addEventListener('input', withHead((h, e) => { if (armed) { pushHistory(); armed = false; } h[key] = Number(e.target.value); $(id + '-out').value = h[key]; renderSectors(); renderHandles(); renderCoverage(); renderPanel(); }));
    $(id).addEventListener('change', () => { armed = true; save(); });
  };
  headSlider('h-radius', 'radius'); headSlider('h-arc', 'arc'); headSlider('h-aim', 'aim');
  $('h-type').onchange = withHead((h, e) => { pushHistory(); h.type = e.target.value; const t = HEAD_TYPES[h.type]; h.radius = clamp(h.radius, t.min, t.max); save(); renderAll(); });
  $('h-zone').onchange = withHead((h, e) => { pushHistory(); h.zone = Number(e.target.value); save(); renderAll(); });
  $('btn-del').onclick = deleteSelected;
  $('btn-dup').onclick = withHead((h) => { pushHistory(); const c = { ...h, id: newId(), x: h.x + 3, y: h.y - 3 }; state.heads.push(c); selectedHeadId = c.id; save(); renderAll(); });
  $('btn-add-source').onclick = () => {
    pushHistory();
    const id = 's' + (state.nextId++);
    state.sources.push({ id, name: `Source ${state.sources.length + 1}`, x: 40, y: 20 });
    selectedSourceId = id; setMode('select'); save(); renderAll();
  };
  $('btn-clear-pipes').onclick = () => { if (!state.pipes.length || !confirmDelete('Remove all pipe runs?')) return; pushHistory(); state.pipes = []; save(); renderAll(); };
  $('pipe-zone').onchange = renderDraft;

  $('btn-export').onclick = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'irrigation-plan-154-low-st.json'; a.click();
  };
  $('file-import').onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    f.text().then((t) => { const s = JSON.parse(t); pushHistory(); state = s.version === 2 ? Object.assign(defaultState(), s) : migrateV1(s); if (!state.areas.length) seedAreas(); save(); renderAll(); }).catch(() => alert('Could not read that file.'));
  };
  $('btn-reset').onclick = () => { if (!confirmDelete('Reset the whole plan? Areas, heads and pipes will be cleared.')) return; pushHistory(); state = defaultState(); seedAreas(); save(); renderAll(); };

  const PHOTOS = ['IMG_8951', 'IMG_8043', 'IMG_8044', 'IMG_8536', 'IMG_6040', 'IMG_6039', 'IMG_6034', 'IMG_6035', 'IMG_6036', 'IMG_6037', 'IMG_6038', 'IMG_6033', 'IMG_6032'];
  const ph = $('photos');
  for (const p of PHOTOS) {
    const img = document.createElement('img'); img.src = `img/${p}.jpg`; img.alt = p; img.loading = 'lazy';
    img.onclick = () => { const lb = document.createElement('div'); lb.className = 'lightbox'; lb.innerHTML = `<img src="img/${p}.jpg" alt="${p}">`; lb.onclick = () => lb.remove(); document.body.append(lb); };
    ph.append(img);
  }

  buildSvg();
  setMode('select');
  loadSite();
})();
