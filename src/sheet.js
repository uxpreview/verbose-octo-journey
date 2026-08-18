/* The dig plan: everything you need on paper, standing in the yard with a
 * spade, or in the aisle deciding how much pipe to buy.
 *
 * A planning tool that cannot be printed is a toy. This is the part that makes
 * the rest of it worth doing, so it is deliberately blunt: what each zone
 * waters, how long to run it, every head in a numbered schedule, a parts list
 * with the waste factor already added, and the list of things the tool does not
 * know about you. */

import { polyArea, dist, bounds } from './geometry.js';
import { HEAD_TYPES, headGpm, precipRate, runTime, fmtLen, fmtArea, fmtFlow, toLen, UNITS } from './hydraulics.js';
import { isIrrigable, AREA_KINDS } from './site.js';
import { zoneColor, planFigureSvg } from './render.js';

const pipeLength = (p) => {
  let s = 0;
  for (let i = 1; i < p.pts.length; i++) s += dist(p.pts[i - 1], p.pts[i]);
  return s;
};

/** Everything the sheet and the panel both need to say about a plan.
 *  One derivation, so the printed numbers cannot disagree with the screen. */
export function summarise(state) {
  const psi = state.supply.psi;
  const zones = new Map();
  const zone = (z) => {
    if (!zones.has(z)) zones.set(z, { zone: z, heads: [], drip: [], gpm: 0, pipeFt: 0, areaSqFt: 0, kind: 'spray' });
    return zones.get(z);
  };
  for (const h of state.heads) {
    const z = zone(h.zone);
    z.heads.push(h);
    z.gpm += headGpm(h, psi);
  }
  for (const d of state.drip) {
    const z = zone(d.zone);
    z.drip.push(d);
    z.gpm += d.gpm;
    z.areaSqFt += d.sqft;
    z.kind = z.heads.length ? 'mixed' : 'drip';
  }
  for (const p of state.pipes) zone(p.zone).pipeFt += pipeLength(p);

  // A spray zone's area is the ground it is responsible for: the irrigable
  // polygons its heads were placed on. Falling back to the sum of the wetted
  // sectors would flatter the precipitation rate.
  const byArea = new Map(state.areas.map((a) => [a.id, a]));
  for (const z of zones.values()) {
    if (z.heads.length) {
      const ids = new Set(z.heads.map((h) => h.areaId).filter(Boolean));
      let sq = 0;
      for (const id of ids) {
        const a = byArea.get(id);
        if (!a) continue;
        // Share an area between the zones that cover it, by head count.
        const total = state.heads.filter((h) => h.areaId === id).length || 1;
        const mine = z.heads.filter((h) => h.areaId === id).length;
        sq += polyArea(a.pts) * (mine / total);
      }
      z.areaSqFt += sq;
    }
    z.names = [
      ...new Set([...z.heads.map((h) => h.areaName).filter(Boolean), ...z.drip.map((d) => d.name)]),
    ];
    z.pr = precipRate(z.gpm, z.areaSqFt);
    z.run = runTime(z.gpm, z.areaSqFt, state.schedule.inchesPerWeek, state.schedule.daysPerWeek);
    z.over = z.gpm > state.supply.gpm;
  }

  const list = [...zones.values()].sort((a, b) => a.zone - b.zone);
  const totalPipe = state.pipes.reduce((s, p) => s + pipeLength(p), 0);
  const irrigable = state.areas.filter(isIrrigable).reduce((s, a) => s + polyArea(a.pts), 0);
  return {
    zones: list,
    totalPipe,
    totalGpm: list.reduce((s, z) => s + z.gpm, 0),
    peakGpm: list.reduce((m, z) => Math.max(m, z.gpm), 0),
    lotSqFt: polyArea(state.site.lot),
    irrigableSqFt: irrigable,
    headCount: state.heads.length,
    dripSqFt: state.drip.reduce((s, d) => s + d.sqft, 0),
    dripTubingFt: state.drip.reduce((s, d) => s + d.tubingFt, 0),
  };
}

/** Round up to something you can actually buy. */
const roll = (ft, step = 100) => Math.ceil(ft / step) * step;

export function partsList(state, sum) {
  const parts = [];
  const byType = new Map();
  for (const h of state.heads) {
    const key = `${h.type}|${h.radius}`;
    byType.set(key, (byType.get(key) || 0) + 1);
  }
  for (const [key, n] of [...byType.entries()].sort()) {
    const [type, radius] = key.split('|');
    parts.push({ n, item: `${HEAD_TYPES[type].label} head, ${radius} ft throw`, note: 'plus the riser or swing joint for each' });
  }
  const sprayZones = sum.zones.filter((z) => z.heads.length).length;
  const dripZones = sum.zones.filter((z) => z.drip.length && !z.heads.length).length;
  if (sum.zones.length) {
    parts.push({ n: sum.zones.length, item: 'Zone valve', note: 'in one or two manifold boxes near the source' });
    parts.push({ n: 1, item: `Controller, at least ${sum.zones.length} station${sum.zones.length > 1 ? 's' : ''}`, note: 'buy the next size up — you will add a zone' });
  }
  if (state.sources.length) parts.push({ n: state.sources.length, item: 'Backflow preventer', note: 'one per source; check what your local code requires' });
  if (sum.totalPipe > 0) {
    parts.push({ n: `${roll(sum.totalPipe * 1.15).toLocaleString()} ft`, item: 'Lateral pipe (¾ in poly or the local equivalent)', note: '15 % over the drawn run for slack, depth and mistakes' });
    parts.push({ n: Math.ceil(state.heads.length * 1.4) + 10, item: 'Barbed fittings and clamps', note: 'tees, elbows, couplers — buy more than the count' });
  }
  if (dripZones) {
    parts.push({ n: `${roll(sum.dripTubingFt * 1.15, 50).toLocaleString()} ft`, item: 'Emitter tubing for the beds', note: '0.6 GPH emitters at 12 in, rows 18 in apart' });
    parts.push({ n: dripZones, item: 'Drip filter and 25 PSI regulator', note: 'one set per drip zone — drip will not survive mains pressure' });
  }
  if (sprayZones) parts.push({ n: sum.zones.length, item: 'Valve box', note: 'or one big box for a shared manifold' });
  parts.push({ n: 1, item: 'Rain sensor or a controller that reads the forecast', note: 'the cheapest thing on this list that saves the most water' });
  return parts;
}

export function renderSheet(state, mount) {
  const u = state.units;
  const sum = summarise(state);
  const parts = partsList(state, sum);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const mins = (m) => (m == null ? '—' : m < 90 ? `${Math.round(m)} min` : `${(m / 60).toFixed(1)} hr`);
  const depth = u === 'metric' ? `${(state.schedule.inchesPerWeek * 25.4).toFixed(0)} mm` : `${state.schedule.inchesPerWeek.toFixed(2)} in`;
  const prUnit = u === 'metric' ? 'mm/hr' : 'in/hr';
  const pr = (v) => (v == null ? '—' : (u === 'metric' ? v * 25.4 : v).toFixed(u === 'metric' ? 1 : 2));

  const zoneRows = sum.zones.map((z) => `
    <tr>
      <td><span class="swatch" style="background:${zoneColor(z.zone)}"></span>Zone ${z.zone}</td>
      <td>${esc(z.names.join(', ') || '—')}</td>
      <td>${z.heads.length ? `${z.heads.length} head${z.heads.length > 1 ? 's' : ''}` : `${z.drip.length} bed${z.drip.length > 1 ? 's' : ''}, drip`}</td>
      <td${z.over ? ' class="over"' : ''}>${fmtFlow(z.gpm, u)}${z.over ? ' — over supply' : ''}</td>
      <td>${fmtArea(z.areaSqFt, u)}</td>
      <td>${pr(z.pr)} ${prUnit}</td>
      <td>${mins(z.run?.perStartMin)}</td>
      <td>${fmtLen(z.pipeFt, u)}</td>
    </tr>`).join('');

  const headRows = state.heads.map((h, i) => `
    <tr>
      <td><span class="swatch" style="background:${zoneColor(h.zone)}"></span>${i + 1}</td>
      <td>${h.zone}</td>
      <td>${esc(h.areaName || '—')}</td>
      <td>${HEAD_TYPES[h.type].label}</td>
      <td>${fmtLen(h.radius, u, 1)}</td>
      <td>${h.arc}°</td>
      <td>${fmtFlow(headGpm(h, state.supply.psi), u, 2)}</td>
      <td>${toLen(h.x, u).toFixed(1)}, ${toLen(h.y, u).toFixed(1)}</td>
    </tr>`).join('');

  const partRows = parts.map((p) => `<tr><td>${esc(p.n)}</td><td>${esc(p.item)}</td><td class="muted">${esc(p.note)}</td></tr>`).join('');

  mount.innerHTML = `
    <h1>${esc(state.site.name || 'Irrigation plan')}</h1>
    <p class="sheet-lede">
      ${sum.headCount} head${sum.headCount === 1 ? '' : 's'} and ${sum.zones.length} zone${sum.zones.length === 1 ? '' : 's'}
      over ${fmtArea(sum.irrigableSqFt, u)} of lawn and beds, on a supply measured at
      ${state.supply.psi} PSI and ${fmtFlow(state.supply.gpm, u)}.
      Run times assume ${depth} of water per week over ${state.schedule.daysPerWeek} start${state.schedule.daysPerWeek === 1 ? '' : 's'}.
    </p>

    <h2>The plan</h2>
    <div class="sheet-figure" id="sheet-figure"></div>

    <h2>Zones</h2>
    <table>
      <thead><tr><th>Zone</th><th>Waters</th><th>Outlets</th><th>Flow</th><th>Area</th><th>Rate</th><th>Per start</th><th>Trench</th></tr></thead>
      <tbody>${zoneRows || '<tr><td colspan="8" class="muted">No zones yet.</td></tr>'}</tbody>
    </table>

    <h2>Head schedule</h2>
    <table>
      <thead><tr><th>#</th><th>Zone</th><th>Where</th><th>Type</th><th>Throw</th><th>Arc</th><th>Flow</th><th>x, y from the front-left corner</th></tr></thead>
      <tbody>${headRows || '<tr><td colspan="8" class="muted">No heads yet.</td></tr>'}</tbody>
    </table>

    <h2>Shopping list</h2>
    <table>
      <thead><tr><th>Qty</th><th>Item</th><th>Note</th></tr></thead>
      <tbody>${partRows}</tbody>
    </table>

    <h2>Before you dig</h2>
    <div class="caveat">
      <p><strong>Call before you dig.</strong> In the US that is 811, free, a few
      working days ahead. Nothing in this plan knows where your gas, power,
      water or fibre is buried.</p>
      <p>These flows and throws are catalogue approximations, and friction loss
      along the pipe is not modelled — a long run to the far end of a zone will
      arrive with less pressure than the slider says. Check the static pressure
      with a gauge on the spigot and the flow with a bucket before you buy
      anything. Backflow prevention, permits and what you may connect to the
      supply are set by local code, not by this tool.</p>
      <p>Coverage and precipitation rates assume every head is set to the arc
      and throw in the schedule above. Nozzles come out of the box wrong; set
      each one after it is in the ground, then run each zone and watch it.</p>
    </div>`;

  const fig = mount.querySelector('#sheet-figure');
  if (fig && state.site.lot.length >= 3) fig.appendChild(planFigureSvg(state, { width: 1000 }));
  return sum;
}
