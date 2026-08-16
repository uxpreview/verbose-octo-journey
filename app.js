/* 154 Low St irrigation planner — single-file app, no build step.
   Coordinates: everything user-drawn is stored in local feet (x east, y north)
   relative to the parcel centroid so geometry math stays simple. */

(function () {
  'use strict';

  // ---------- constants ----------
  const STORAGE_KEY = 'irrigation-plan-v1';
  const ORIGIN = { lat: 42.81322278494484, lon: -70.89522501499822 };
  const FT_PER_M = 3.28084;
  const rad = (d) => (d * Math.PI) / 180;
  const M_PER_DEG_LAT = 111132.954 - 559.822 * Math.cos(2 * rad(ORIGIN.lat)) + 1.175 * Math.cos(4 * rad(ORIGIN.lat));
  const M_PER_DEG_LON = 111412.84 * Math.cos(rad(ORIGIN.lat)) - 93.5 * Math.cos(3 * rad(ORIGIN.lat));

  const ZONE_COLORS = ['#6fd39b', '#4fb2ff', '#ffb648', '#ff6b9d', '#c48bff', '#4fe0d8'];
  const AREA_STYLE = {
    lawn: { color: '#8ce99a', fill: 'rgba(140,233,154,0.10)' },
    bed: { color: '#e9c46a', fill: 'rgba(233,196,106,0.18)' },
    hardscape: { color: '#c9c9c9', fill: 'rgba(200,200,200,0.28)' },
    structure: { color: '#ffffff', fill: 'rgba(255,255,255,0.35)' },
    tree: { color: '#3fa34d', fill: 'rgba(63,163,77,0.22)' },
  };
  // Nozzle chart approximations. radius = nominal radius at rated PSI. gpm ≈ k * r^2 * arc/360.
  const HEAD_TYPES = {
    spray: { label: 'Spray', ratedPsi: 30, k: 0.0165, min: 4, max: 15 },
    rotor: { label: 'Rotor', ratedPsi: 45, k: 0.0033, min: 15, max: 35 },
    mp: { label: 'MP rotator', ratedPsi: 40, k: 0.0028, min: 8, max: 30 },
  };

  // ---------- geometry helpers ----------
  const toLocal = (latlng) => ({
    x: (latlng.lng - ORIGIN.lon) * M_PER_DEG_LON * FT_PER_M,
    y: (latlng.lat - ORIGIN.lat) * M_PER_DEG_LAT * FT_PER_M,
  });
  const toLatLng = (p) => L.latLng(ORIGIN.lat + p.y / FT_PER_M / M_PER_DEG_LAT, ORIGIN.lon + p.x / FT_PER_M / M_PER_DEG_LON);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const ringToLocal = (ring) => ring.map(([lon, lat]) => toLocal({ lat, lng: lon }));

  function pointInPoly(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
      const hit = yi > pt.y !== yj > pt.y && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi;
      if (hit) inside = !inside;
    }
    return inside;
  }
  function polyArea(poly) {
    let a = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
    return Math.abs(a / 2);
  }
  // compass aim (0 = north, clockwise) → math angle
  const compassToMath = (deg) => rad(90 - deg);
  function sectorPoints(head, radiusFt) {
    const pts = [{ x: head.x, y: head.y }];
    const arc = head.arc;
    const start = compassToMath(head.aim - arc / 2);
    const steps = Math.max(8, Math.round(arc / 6));
    for (let i = 0; i <= steps; i++) {
      const a = start - rad(arc) * (i / steps);
      pts.push({ x: head.x + radiusFt * Math.cos(a), y: head.y + radiusFt * Math.sin(a) });
    }
    if (arc >= 360) pts.shift();
    return pts;
  }
  function inSector(head, radiusFt, p) {
    const dx = p.x - head.x, dy = p.y - head.y;
    const d = Math.hypot(dx, dy);
    if (d > radiusFt || d < 0.01) return d < 0.01;
    if (head.arc >= 360) return true;
    let bearing = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360; // compass bearing of point
    let diff = Math.abs((((bearing - head.aim) % 360) + 540) % 360 - 180);
    return diff <= head.arc / 2 + 0.01;
  }
  function circlePoints(c, r, n = 36) {
    const pts = [];
    for (let i = 0; i < n; i++) pts.push({ x: c.x + r * Math.cos((2 * Math.PI * i) / n), y: c.y + r * Math.sin((2 * Math.PI * i) / n) });
    return pts;
  }

  // ---------- state ----------
  const defaultState = () => ({
    version: 1,
    supply: { psi: 50, gpm: 10 },
    defaults: { type: 'spray', arc: 180, radius: 12 },
    source: { x: 30.4, y: 24.3 }, // rear-left corner of the house, by the hose bib. Drag it.
    heads: [], // {id, x, y, type, radius, arc, aim, zone}
    pipes: [], // {id, zone, pts:[{x,y,headId?}]}
    areas: [], // {id, type, name, pts:[{x,y}]} (tree: {center, r})
    nextId: 1,
  });

  let state = loadState();
  let history = [];
  let selectedHeadId = null;
  let selectedShape = null; // {kind:'area'|'pipe', id}
  let mode = 'select';
  let draft = null; // in-progress pipe/area/measure

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return Object.assign(defaultState(), JSON.parse(raw));
    } catch (e) { console.warn('bad saved state', e); }
    return defaultState();
  }
  function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  function pushHistory() { history.push(JSON.stringify(state)); if (history.length > 60) history.shift(); }
  function undo() {
    if (!history.length) return;
    state = Object.assign(defaultState(), JSON.parse(history.pop()));
    if (!state.heads.find((h) => h.id === selectedHeadId)) selectedHeadId = null;
    selectedShape = null;
    renderAll(); save();
  }
  const newId = () => state.nextId++;

  // ---------- head physics ----------
  function effectiveRadius(head) {
    const t = HEAD_TYPES[head.type] || HEAD_TYPES.spray;
    const scale = Math.sqrt(state.supply.psi / t.ratedPsi);
    return Math.max(2, head.radius * Math.min(1.25, Math.max(0.6, scale)));
  }
  function headGpm(head) {
    const t = HEAD_TYPES[head.type] || HEAD_TYPES.spray;
    const scale = Math.sqrt(state.supply.psi / t.ratedPsi);
    return t.k * head.radius * head.radius * (head.arc / 360) * scale;
  }
  const zoneColor = (z) => ZONE_COLORS[(z - 1) % ZONE_COLORS.length];

  // ---------- map ----------
  const map = L.map('map', { zoomControl: true, maxZoom: 22, doubleClickZoom: false, attributionControl: true });
  L.control.scale({ imperial: true, metric: false }).addTo(map);

  const massgis = (name, attr) => L.tileLayer(`https://tiles.arcgis.com/tiles/hGdibHYSPO59RG1h/arcgis/rest/services/${name}/MapServer/tile/{z}/{y}/{x}`, { maxNativeZoom: 20, maxZoom: 22, attribution: attr });
  const basemaps = {
    ma2025: massgis('Massachusetts_Aerial_Imagery_2025', 'MassGIS aerial, spring 2025 (15 cm)'),
    ma2023: massgis('orthos2023', 'MassGIS aerial 2023'),
    ma2021: massgis('orthos2021', 'MassGIS aerial 2021'),
    esri: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 19, maxZoom: 22, attribution: 'Esri World Imagery' }),
  };
  let currentBase = basemaps.ma2025.addTo(map);

  const layers = {
    parcel: L.layerGroup().addTo(map),
    areas: L.layerGroup().addTo(map),
    coverage: L.layerGroup().addTo(map),
    sectors: L.layerGroup().addTo(map),
    pipes: L.layerGroup().addTo(map),
    heads: L.layerGroup().addTo(map),
    handles: L.layerGroup().addTo(map),
    draft: L.layerGroup().addTo(map),
    labels: L.layerGroup().addTo(map),
  };

  let parcelLocal = null, houseLocal = null, parcelBounds = null;

  async function loadSite() {
    const [parcel, house] = await Promise.all([
      fetch('data/parcel.geojson').then((r) => r.json()),
      fetch('data/house.geojson').then((r) => r.json()),
    ]);
    const pring = parcel.features[0].geometry.coordinates[0];
    const hring = house.features[0].geometry.coordinates[0];
    parcelLocal = ringToLocal(pring);
    houseLocal = ringToLocal(hring);
    const pl = L.polygon(pring.map(([lon, lat]) => [lat, lon]), { color: '#ffe066', weight: 2, dashArray: '6 4', fill: false, interactive: false }).addTo(layers.parcel);
    L.polygon(hring.map(([lon, lat]) => [lat, lon]), { color: '#fff', weight: 1.5, fillColor: '#111', fillOpacity: 0.55, interactive: false }).addTo(layers.parcel);
    parcelBounds = pl.getBounds();
    map.fitBounds(parcelBounds.pad(0.08));
    if (!state.areas.length) seedAreas();
    renderAll();
  }

  // Seed rough areas from the aerials so the coverage view is useful on first load.
  // Every one of these can be deleted or redrawn from the Areas card.
  // Areas are sketched in a "street frame": u = feet along the street (left→right as seen
  // from Low St), v = feet from the street into the lot. uv() converts to local feet.
  const uv = (u, v) => ({ x: -35 + 0.524 * u + 0.852 * v, y: -3 - 0.852 * u + 0.524 * v });
  function seedAreas() {
    const A = (type, name, pts) => ({ id: newId(), type, name, pts: pts.map((p) => (Array.isArray(p) ? uv(p[0], p[1]) : p)) });
    state.areas.push(
      A('hardscape', 'Driveway', [[-1, 0], [13, 0], [13, 40], [-10, 40], [-8, 6]]),
      A('lawn', 'Front lawn (left of walk)', [[13, 0], [42.5, 0], [31.5, 35], [13, 35]]),
      A('hardscape', 'Front walk', [[42.5, 0], [45.5, 0], [34.5, 35], [31.5, 35]]),
      A('lawn', 'Front lawn', [[45.5, 0], [72.4, 0], [69.8, 35], [34.5, 35]]),
      A('bed', 'Front bed (left)', [[13, 35], [31.5, 35], [31.5, 38.5], [13, 39.8]]),
      A('bed', 'Front bed (right)', [[34.5, 35], [58, 35], [58, 48], [45, 48], [45.2, 38.3]]),
      A('lawn', 'Right side yard', [[58, 48], [69, 48], [67, 76], [55, 76]]),
      A('bed', 'Raised beds', [[60, 66], [66, 66], [66, 74], [60, 74]]),
      A('lawn', 'Left side yard', [[-10, 40], [12, 40], [12.9, 72], [-12, 72]]),
      A('hardscape', 'Patio', [[8, 76], [30, 76], [30, 88], [8, 88]]),
      A('lawn', 'Back yard', [[-12, 76], [8, 76], [8, 88], [30, 88], [30, 76], [66, 77], [64, 108], [-13, 102]]),
      A('bed', 'Back fence bed', [[-13, 99], [64, 105], [64, 108], [-13, 102]]),
      A('bed', 'Right fence bed', [[63, 76], [66, 77], [64.5, 105], [61.5, 105]]),
      A('structure', 'Shed', [[-6, 100], [4, 100], [4, 108], [-6, 108]]),
      A('tree', 'Big tree', circlePoints(uv(-6, 86), 16, 24)),
    );
    state.source = uv(11, 70);
  }

  // ---------- rendering ----------
  function renderAll() {
    renderAreas();
    renderHeads();
    renderPipes();
    renderSource();
    renderCoverage();
    renderHandles();
    renderPanel();
  }

  function renderAreas() {
    layers.areas.clearLayers();
    for (const a of state.areas) {
      const st = AREA_STYLE[a.type] || AREA_STYLE.lawn;
      const poly = L.polygon(a.pts.map(toLatLng), { color: st.color, weight: 1.5, fillColor: st.fill, fillOpacity: 1, opacity: 0.9, interactive: mode === 'select' });
      poly.on('click', (e) => { L.DomEvent.stop(e); if (mode === 'select') selectShape('area', a.id); });
      if (selectedShape && selectedShape.kind === 'area' && selectedShape.id === a.id) poly.setStyle({ weight: 3, dashArray: '6 3' });
      poly.bindTooltip(a.name, { permanent: true, direction: 'center', className: 'lbl' });
      poly.addTo(layers.areas);
    }
    applyLabelVisibility();
  }

  const headMarkers = new Map();
  function renderHeads() {
    layers.heads.clearLayers(); layers.sectors.clearLayers(); headMarkers.clear();
    for (const h of state.heads) {
      const r = effectiveRadius(h);
      const color = zoneColor(h.zone);
      L.polygon(sectorPoints(h, r).map(toLatLng), { color, weight: 1, fillColor: color, fillOpacity: 0.22, opacity: 0.8, interactive: false }).addTo(layers.sectors);
      const icon = L.divIcon({ className: '', html: `<div class="head-icon ${h.id === selectedHeadId ? 'selected' : ''}" style="background:${color}"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] });
      const m = L.marker(toLatLng(h), { icon, draggable: true, title: `Head ${h.id}` }).addTo(layers.heads);
      m.on('click', (e) => { L.DomEvent.stop(e); if (mode === 'pipe' || mode === 'measure') { onMapClick({ latlng: e.latlng, snapHead: h }); return; } selectHead(h.id); });
      m.on('dragstart', () => { pushHistory(); selectHead(h.id, true); });
      m.on('drag', (e) => { const p = toLocal(e.target.getLatLng()); h.x = p.x; h.y = p.y; syncPipesToHeads(); renderPipes(); renderSectorsOnly(); });
      m.on('dragend', () => { save(); renderAll(); });
      headMarkers.set(h.id, m);
    }
  }
  function renderSectorsOnly() {
    layers.sectors.clearLayers();
    for (const h of state.heads) {
      const color = zoneColor(h.zone);
      L.polygon(sectorPoints(h, effectiveRadius(h)).map(toLatLng), { color, weight: 1, fillColor: color, fillOpacity: 0.22, opacity: 0.8, interactive: false }).addTo(layers.sectors);
    }
  }

  function renderPipes() {
    layers.pipes.clearLayers();
    for (const p of state.pipes) {
      const line = L.polyline(p.pts.map(toLatLng), { color: zoneColor(p.zone), weight: 4, opacity: 0.95, dashArray: '10 6' });
      line.bindTooltip(`${pipeLength(p).toFixed(0)} ft`, { className: 'lbl', sticky: true });
      line.on('click', (e) => { L.DomEvent.stop(e); if (mode === 'select') selectShape('pipe', p.id); });
      if (selectedShape && selectedShape.kind === 'pipe' && selectedShape.id === p.id) line.setStyle({ weight: 7, opacity: 1 });
      line.addTo(layers.pipes);
    }
  }
  function pipeLength(p) { let s = 0; for (let i = 1; i < p.pts.length; i++) s += dist(p.pts[i - 1], p.pts[i]); return s; }
  function syncPipesToHeads() {
    for (const p of state.pipes) for (const pt of p.pts) {
      if (pt.headId != null) { const h = state.heads.find((x) => x.id === pt.headId); if (h) { pt.x = h.x; pt.y = h.y; } }
      if (pt.source) { pt.x = state.source.x; pt.y = state.source.y; }
    }
  }

  let sourceMarker = null;
  function renderSource() {
    if (sourceMarker) map.removeLayer(sourceMarker);
    const icon = L.divIcon({ className: '', html: '<div class="source-icon" title="Water source"></div>', iconSize: [18, 18], iconAnchor: [9, 18] });
    sourceMarker = L.marker(toLatLng(state.source), { icon, draggable: true, title: 'Water source — drag to spigot' }).addTo(map);
    sourceMarker.bindTooltip('Water source', { className: 'lbl', direction: 'top', offset: [0, -14] });
    sourceMarker.on('click', (e) => { L.DomEvent.stop(e); if (mode === 'pipe' || mode === 'measure') onMapClick({ latlng: e.latlng, snapSource: true }); });
    sourceMarker.on('dragstart', pushHistory);
    sourceMarker.on('drag', (e) => { const p = toLocal(e.target.getLatLng()); state.source = p; syncPipesToHeads(); renderPipes(); });
    sourceMarker.on('dragend', () => { save(); renderPanel(); });
  }

  // Coverage raster: one image overlay over the parcel bbox. Counts heads reaching each cell of lawn/bed.
  let coverageStats = { pct: null, pct2: null };
  function renderCoverage() {
    layers.coverage.clearLayers();
    if (!parcelLocal || !document.getElementById('chk-coverage').checked) { coverageStats = { pct: null, pct2: null }; return; }
    const xs = parcelLocal.map((p) => p.x), ys = parcelLocal.map((p) => p.y);
    const minX = Math.min(...xs) - 2, maxX = Math.max(...xs) + 2, minY = Math.min(...ys) - 2, maxY = Math.max(...ys) + 2;
    const res = 2; // px per ft
    const w = Math.ceil((maxX - minX) * res), hgt = Math.ceil((maxY - minY) * res);
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = hgt;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, hgt);
    const target = state.areas.filter((a) => a.type === 'lawn' || a.type === 'bed');
    const skip = state.areas.filter((a) => a.type === 'hardscape' || a.type === 'structure');
    const heads = state.heads.map((h) => ({ h, r: effectiveRadius(h) }));
    let n = 0, c1 = 0, c2 = 0;
    for (let py = 0; py < hgt; py++) {
      const y = maxY - (py + 0.5) / res;
      for (let px = 0; px < w; px++) {
        const x = minX + (px + 0.5) / res;
        const p = { x, y };
        let inTarget = target.length ? target.some((a) => pointInPoly(p, a.pts)) : pointInPoly(p, parcelLocal);
        if (!inTarget) continue;
        if (pointInPoly(p, houseLocal) || skip.some((a) => pointInPoly(p, a.pts))) continue;
        n++;
        let count = 0;
        for (const { h, r } of heads) if (inSector(h, r, p)) count++;
        const i = (py * w + px) * 4;
        if (count === 0) { img.data[i] = 255; img.data[i + 1] = 60; img.data[i + 2] = 60; img.data[i + 3] = 90; }
        else if (count === 1) { c1++; img.data[i] = 120; img.data[i + 1] = 230; img.data[i + 2] = 140; img.data[i + 3] = 70; }
        else { c1++; c2++; img.data[i] = 60; img.data[i + 1] = 150; img.data[i + 2] = 255; img.data[i + 3] = 95; }
      }
    }
    ctx.putImageData(img, 0, 0);
    const bounds = L.latLngBounds(toLatLng({ x: minX, y: minY }), toLatLng({ x: maxX, y: maxY }));
    L.imageOverlay(canvas.toDataURL(), bounds, { opacity: 1, interactive: false }).addTo(layers.coverage);
    coverageStats = n ? { pct: (100 * c1) / n, pct2: (100 * c2) / n } : { pct: null, pct2: null };
  }

  function applyLabelVisibility() {
    const on = document.getElementById('chk-labels').checked;
    document.getElementById('map').classList.toggle('hide-labels', !on);
    layers.areas.eachLayer((l) => { const t = l.getTooltip && l.getTooltip(); if (t) { on ? l.openTooltip() : l.closeTooltip(); } });
  }

  // ---------- panel ----------
  const $ = (id) => document.getElementById(id);
  function renderPanel() {
    $('psi').value = state.supply.psi; $('psi-out').value = state.supply.psi;
    $('gpm').value = state.supply.gpm; $('gpm-out').value = state.supply.gpm;
    $('def-type').value = state.defaults.type; $('def-arc').value = String(state.defaults.arc);
    $('def-radius').value = state.defaults.radius; $('def-radius-out').value = state.defaults.radius;

    // selected head
    const h = state.heads.find((x) => x.id === selectedHeadId);
    $('head-controls').hidden = !h; $('head-empty').hidden = !!h;
    $('head-title').textContent = h ? `#${h.id}` : '';
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

    // zones table
    const zones = {};
    for (const hd of state.heads) { zones[hd.zone] = zones[hd.zone] || { heads: 0, gpm: 0, pipe: 0 }; zones[hd.zone].heads++; zones[hd.zone].gpm += headGpm(hd); }
    for (const p of state.pipes) { zones[p.zone] = zones[p.zone] || { heads: 0, gpm: 0, pipe: 0 }; zones[p.zone].pipe += pipeLength(p); }
    const keys = Object.keys(zones).map(Number).sort((a, b) => a - b);
    let html = '<table class="zones"><tr><th>Zone</th><th>Heads</th><th>GPM</th><th>Pipe</th></tr>';
    for (const z of keys) {
      const zz = zones[z];
      const over = zz.gpm > state.supply.gpm;
      html += `<tr><td><span class="swatch" style="background:${zoneColor(z)}"></span>Zone ${z}</td><td>${zz.heads}</td><td class="${over ? 'over' : ''}">${zz.gpm.toFixed(1)}${over ? ' ⚠' : ''}</td><td>${zz.pipe.toFixed(0)} ft</td></tr>`;
    }
    html += '</table>';
    if (!keys.length) html = '<div class="empty">No zones yet. Add heads and pipe.</div>';
    $('zones-table').innerHTML = html;

    $('stat-heads').textContent = state.heads.length;
    $('stat-pipe').textContent = `${state.pipes.reduce((s, p) => s + pipeLength(p), 0).toFixed(0)} ft`;
    $('stat-cov').textContent = coverageStats.pct == null ? '–' : `${coverageStats.pct.toFixed(0)}%`;
    $('stat-cov2').textContent = coverageStats.pct2 == null ? '–' : `${coverageStats.pct2.toFixed(0)}%`;

    // areas list
    const list = $('areas-list'); list.innerHTML = '';
    for (const a of state.areas) {
      const st = AREA_STYLE[a.type];
      const row = document.createElement('div'); row.className = 'item';
      row.innerHTML = `<span class="swatch" style="background:${st.color}"></span><span class="name" title="Click to select on map">${a.name}</span><span class="muted">${(polyArea(a.pts)).toFixed(0)} sq ft</span>`;
      row.querySelector('.name').onclick = () => { setMode('select'); selectShape('area', a.id); };
      if (selectedShape && selectedShape.kind === 'area' && selectedShape.id === a.id) row.classList.add('sel');
      const ren = document.createElement('button'); ren.className = 'ghost'; ren.textContent = 'Rename';
      ren.onclick = () => { const n = prompt('Area name', a.name); if (n) { pushHistory(); a.name = n; save(); renderAll(); } };
      const del = document.createElement('button'); del.className = 'danger'; del.textContent = '×';
      del.onclick = () => { pushHistory(); state.areas = state.areas.filter((x) => x.id !== a.id); save(); renderAll(); };
      row.append(ren, del); list.append(row);
    }
  }
  function fillZoneSelect(sel, value) {
    sel.innerHTML = '';
    for (let z = 1; z <= 6; z++) { const o = document.createElement('option'); o.value = z; o.textContent = `Zone ${z}`; sel.append(o); }
    sel.value = value;
  }

  function selectHead(id, quiet) {
    selectedHeadId = id; selectedShape = null; layers.handles.clearLayers();
    if (!quiet) { renderHeads(); }
    renderPanel();
  }
  function confirmDelete(msg) { return window.confirm(msg); }
  function selectShape(kind, id) {
    selectedShape = { kind, id }; selectedHeadId = null;
    $('hint').textContent = kind === 'area' ? 'Drag the corner dots to reshape. Click a hollow dot to add a corner. Right-click a dot to remove it. Delete key removes the area.' : 'Drag the dots to reroute the pipe. Click a hollow dot to add a bend. Right-click a dot to remove it. Delete key removes the pipe.';
    renderAreas(); renderPipes(); renderHeads(); renderHandles(); renderPanel();
  }
  function selectedShapeObj() {
    if (!selectedShape) return null;
    const list = selectedShape.kind === 'area' ? state.areas : state.pipes;
    return list.find((x) => x.id === selectedShape.id) || null;
  }
  // Vertex handles for the selected area or pipe.
  function renderHandles() {
    layers.handles.clearLayers();
    const obj = selectedShapeObj();
    if (!obj || mode !== 'select') return;
    const closed = selectedShape.kind === 'area';
    const pts = obj.pts;
    const refresh = () => { if (closed) renderAreas(); else renderPipes(); };
    const vicon = L.divIcon({ className: '', html: '<div class="vtx"></div>', iconSize: [12, 12], iconAnchor: [6, 6] });
    const micon = L.divIcon({ className: '', html: '<div class="vtx mid"></div>', iconSize: [10, 10], iconAnchor: [5, 5] });
    pts.forEach((pt, i) => {
      const m = L.marker(toLatLng(pt), { icon: vicon, draggable: true }).addTo(layers.handles);
      m.on('dragstart', pushHistory);
      m.on('drag', (e) => { const p = toLocal(e.target.getLatLng()); pt.x = p.x; pt.y = p.y; delete pt.headId; delete pt.source; refresh(); });
      m.on('dragend', () => { save(); renderAll(); });
      m.on('contextmenu', (e) => { L.DomEvent.stop(e); const min = closed ? 3 : 2; if (pts.length <= min) return; pushHistory(); pts.splice(i, 1); save(); renderAll(); });
      m.on('click', (e) => L.DomEvent.stop(e));
    });
    const n = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const m = L.marker(toLatLng(mid), { icon: micon }).addTo(layers.handles);
      m.on('click', (e) => { L.DomEvent.stop(e); pushHistory(); pts.splice(i + 1, 0, mid); save(); renderAll(); });
    }
  }

  // ---------- modes & drawing ----------
  function setMode(m) {
    mode = m; finishDraft(false); selectedShape = null; layers.handles.clearLayers();
    document.querySelectorAll('.tool').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
    const el = map.getContainer(); el.className = el.className.replace(/\bmode-\w+/g, '').trim(); el.classList.add(`mode-${m}`);
    const hints = {
      select: 'Click a head to edit it. Drag heads or the water source. Click a pipe or area to reshape it (Delete key removes it).',
      head: 'Click on the map to drop a sprinkler head. Press V or Esc when done.',
      pipe: 'Click points along the trench. Click heads or the water source to snap. Double-click or Enter to finish.',
      area: 'Click corners of the area. Double-click or Enter to close it.',
      measure: 'Click two or more points to measure. Enter to finish.',
    };
    $('hint').textContent = hints[m];
    renderAreas();
  }

  function onMapClick(e) {
    const p = e.snapHead ? { x: e.snapHead.x, y: e.snapHead.y, headId: e.snapHead.id } : e.snapSource ? { ...state.source, source: true } : toLocal(e.latlng);
    if (mode === 'head') {
      pushHistory();
      const t = HEAD_TYPES[state.defaults.type];
      const radius = Math.min(t.max, Math.max(t.min, state.defaults.radius));
      const head = { id: newId(), x: p.x, y: p.y, type: state.defaults.type, radius, arc: state.defaults.arc, aim: guessAim(p), zone: Number($('pipe-zone').value) || 1 };
      state.heads.push(head); selectedHeadId = head.id; save(); renderAll();
      return;
    }
    if (mode === 'pipe' || mode === 'area' || mode === 'measure') {
      if (!draft) draft = { kind: mode, pts: [] };
      // snap to nearby head/source when drawing pipe
      if (mode === 'pipe' && !p.headId && !p.source) {
        for (const h of state.heads) if (dist(h, p) < 2.5) { p.x = h.x; p.y = h.y; p.headId = h.id; break; }
        if (dist(state.source, p) < 2.5) { p.x = state.source.x; p.y = state.source.y; p.source = true; }
      }
      draft.pts.push(p);
      renderDraft(e.latlng);
    }
  }
  // Point half-circle heads away from the nearest house wall / parcel edge by default.
  function guessAim(p) {
    if (!houseLocal) return 0;
    let best = null;
    for (const poly of [houseLocal, parcelLocal]) {
      for (let i = 0; i < poly.length - 1; i++) {
        const a = poly[i], b = poly[i + 1];
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (dist(a, b) ** 2 || 1)));
        const q = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
        const d = dist(p, q);
        if (!best || d < best.d) best = { d, q };
      }
    }
    if (!best || best.d > 6) return 0;
    const dx = p.x - best.q.x, dy = p.y - best.q.y;
    return Math.round((((Math.atan2(dx, dy) * 180) / Math.PI) + 360) % 360);
  }

  function renderDraft(cursorLatLng) {
    layers.draft.clearLayers();
    if (!draft || !draft.pts.length) return;
    const pts = draft.pts.map(toLatLng);
    if (cursorLatLng) pts.push(cursorLatLng);
    const color = draft.kind === 'pipe' ? zoneColor(Number($('pipe-zone').value) || 1) : draft.kind === 'area' ? AREA_STYLE[$('area-type').value].color : '#fff';
    if (draft.kind === 'area' && pts.length > 2) L.polygon(pts, { color, weight: 2, dashArray: '4 4', fillOpacity: 0.1, interactive: false }).addTo(layers.draft);
    else L.polyline(pts, { color, weight: 3, dashArray: '4 4', interactive: false }).addTo(layers.draft);
    for (const q of draft.pts) L.circleMarker(toLatLng(q), { radius: 4, color: '#fff', fillColor: color, fillOpacity: 1, weight: 1, interactive: false }).addTo(layers.draft);
    if (draft.kind === 'measure' || draft.kind === 'pipe') {
      let len = 0; const all = [...draft.pts, cursorLatLng ? toLocal(cursorLatLng) : null].filter(Boolean);
      for (let i = 1; i < all.length; i++) len += dist(all[i - 1], all[i]);
      const at = all[all.length - 1];
      L.marker(toLatLng(at), { icon: L.divIcon({ className: '', html: '' }), interactive: false }).bindTooltip(`${len.toFixed(1)} ft`, { permanent: true, className: 'lbl measure', direction: 'right', offset: [10, 0] }).addTo(layers.draft).openTooltip();
    }
  }

  function finishDraft(commit) {
    if (!draft) return;
    const d = draft; draft = null; layers.draft.clearLayers();
    if (!commit) return;
    if (d.kind === 'pipe' && d.pts.length >= 2) {
      pushHistory();
      state.pipes.push({ id: newId(), zone: Number($('pipe-zone').value) || 1, pts: d.pts });
      save(); renderAll();
    } else if (d.kind === 'area' && d.pts.length >= 3) {
      const type = $('area-type').value;
      const name = prompt('Name this area', `${type[0].toUpperCase()}${type.slice(1)} ${state.areas.filter((a) => a.type === type).length + 1}`);
      if (name == null) return;
      pushHistory();
      state.areas.push({ id: newId(), type, name, pts: d.pts.map(({ x, y }) => ({ x, y })) });
      save(); renderAll();
    }
  }

  map.on('click', (e) => { if (mode !== 'select') onMapClick(e); else { selectedHeadId = null; selectedShape = null; renderAreas(); renderPipes(); renderHeads(); renderHandles(); renderPanel(); } });
  map.on('dblclick', (e) => { if (draft) { finishDraft(true); } });
  map.on('mousemove', (e) => { if (draft) renderDraft(e.latlng); });
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    if (e.key === 'Enter') { finishDraft(true); return; }
    if (e.key === 'Escape') { if (draft) finishDraft(false); else setMode('select'); return; }
    const k = e.key.toLowerCase();
    if (k === 'v') setMode('select'); else if (k === 'h') setMode('head'); else if (k === 'p') setMode('pipe'); else if (k === 'a') setMode('area'); else if (k === 'm') setMode('measure');
    else if (e.key === 'Delete' || e.key === 'Backspace') { if (selectedHeadId != null || selectedShape) { e.preventDefault(); deleteSelected(); } }
    else if (selectedHeadId != null && (e.key === '[' || e.key === ']')) {
      const h = state.heads.find((x) => x.id === selectedHeadId); if (!h) return;
      h.aim = (h.aim + (e.key === ']' ? 5 : -5) + 360) % 360; save(); renderAll();
    }
  });

  function deleteSelected() {
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

  // ---------- panel wiring ----------
  document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('btn-undo').onclick = undo;
  $('btn-fit').onclick = () => parcelBounds && map.fitBounds(parcelBounds.pad(0.08));
  $('chk-coverage').onchange = () => { renderCoverage(); renderPanel(); };
  $('chk-labels').onchange = applyLabelVisibility;
  $('sel-basemap').onchange = (e) => {
    map.removeLayer(currentBase);
    const b = basemaps[e.target.value];
    if (b) { currentBase = b.addTo(map); currentBase.bringToBack(); } else currentBase = L.layerGroup().addTo(map);
  };

  const liveSlider = (id, fn) => { $(id).addEventListener('input', (e) => fn(Number(e.target.value))); $(id).addEventListener('change', () => save()); };
  liveSlider('psi', (v) => { state.supply.psi = v; renderAll(); });
  liveSlider('gpm', (v) => { state.supply.gpm = v; renderPanel(); });
  liveSlider('def-radius', (v) => { state.defaults.radius = v; $('def-radius-out').value = v; });
  $('def-type').onchange = (e) => { state.defaults.type = e.target.value; const t = HEAD_TYPES[state.defaults.type]; state.defaults.radius = Math.min(t.max, Math.max(t.min, state.defaults.radius)); save(); renderPanel(); };
  $('def-arc').onchange = (e) => { state.defaults.arc = Number(e.target.value); save(); };
  $('btn-bucket').onclick = () => { const s = Number($('bucket-sec').value); if (s > 0) { state.supply.gpm = Math.round((5 / s) * 60 * 2) / 2; save(); renderPanel(); } };

  const withHead = (fn) => (e) => { const h = state.heads.find((x) => x.id === selectedHeadId); if (!h) return; fn(h, e); };
  let headHistoryArmed = true;
  const headSlider = (id, key) => {
    $(id).addEventListener('input', withHead((h, e) => { if (headHistoryArmed) { pushHistory(); headHistoryArmed = false; } h[key] = Number(e.target.value); $(id + '-out').value = h[key]; renderHeads(); renderCoverage(); renderPanel(); }));
    $(id).addEventListener('change', () => { headHistoryArmed = true; save(); });
  };
  headSlider('h-radius', 'radius'); headSlider('h-arc', 'arc'); headSlider('h-aim', 'aim');
  $('h-type').onchange = withHead((h, e) => { pushHistory(); h.type = e.target.value; const t = HEAD_TYPES[h.type]; h.radius = Math.min(t.max, Math.max(t.min, h.radius)); save(); renderAll(); });
  $('h-zone').onchange = withHead((h, e) => { pushHistory(); h.zone = Number(e.target.value); save(); renderAll(); });
  $('btn-del').onclick = deleteSelected;
  $('btn-dup').onclick = withHead((h) => { pushHistory(); const c = { ...h, id: newId(), x: h.x + 3, y: h.y - 3 }; state.heads.push(c); selectedHeadId = c.id; save(); renderAll(); });
  $('btn-clear-pipes').onclick = () => { if (!state.pipes.length || !confirmDelete('Remove all pipe runs?')) return; pushHistory(); state.pipes = []; save(); renderAll(); };
  $('pipe-zone').onchange = () => renderDraft();

  $('btn-export').onclick = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'irrigation-plan-154-low-st.json'; a.click();
  };
  $('file-import').onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    f.text().then((t) => { pushHistory(); state = Object.assign(defaultState(), JSON.parse(t)); save(); renderAll(); }).catch(() => alert('Could not read that file.'));
  };
  $('btn-reset').onclick = () => { if (!confirmDelete('Reset the whole plan? Areas, heads and pipes will be cleared.')) return; pushHistory(); state = defaultState(); seedAreas(); save(); renderAll(); };

  // reference photos
  const PHOTOS = ['IMG_8951', 'IMG_8043', 'IMG_8044', 'IMG_8536', 'IMG_6040', 'IMG_6039', 'IMG_6034', 'IMG_6035', 'IMG_6036', 'IMG_6037', 'IMG_6038', 'IMG_6033', 'IMG_6032'];
  const ph = $('photos');
  for (const p of PHOTOS) {
    const img = document.createElement('img'); img.src = `img/${p}.jpg`; img.alt = p; img.loading = 'lazy';
    img.onclick = () => { const lb = document.createElement('div'); lb.className = 'lightbox'; lb.innerHTML = `<img src="img/${p}.jpg" alt="${p}">`; lb.onclick = () => lb.remove(); document.body.append(lb); };
    ph.append(img);
  }

  setMode('select');
  loadSite();
})();
