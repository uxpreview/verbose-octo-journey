/* The site model: what a yard is, how one gets created, and how it persists.
 *
 * The original version of this tool modelled exactly one property. Its lot line
 * came from a county parcel file, its aerial came from a state GIS server, and
 * its areas were traced by hand from a sketch of that specific yard — so the
 * app was, structurally, a drawing of a house rather than a program about
 * yards. Everything below exists to remove that assumption: a site is a lot
 * polygon plus a list of areas, created three ways (sample, blank rectangle,
 * traced over your own image), and nothing in the app may reach past it for a
 * coordinate. There is no geocoding here and no network call anywhere in the
 * repository. */

import { rect, circlePoints, curvedStrip, bounds, polyArea } from './geometry.js';

export const STORAGE_KEY = 'irrigation-lab-plan-v1';
export const SCHEMA = 3;

export const AREA_KINDS = {
  lawn: { label: 'Lawn', irrigable: true },
  bed: { label: 'Garden bed', irrigable: true },
  hardscape: { label: 'Paving (drive, walk, patio)', irrigable: false },
  structure: { label: 'Building (house, shed, deck)', irrigable: false },
  tree: { label: 'Tree canopy', irrigable: false },
  rough: { label: 'Woods / rough ground', irrigable: false },
  fence: { label: 'Fence line', irrigable: false, open: true },
};

export const isIrrigable = (a) => !!AREA_KINDS[a.type]?.irrigable;
/** Ground a sprinkler should not be asked to water, and that coverage skips. */
export const isObstacle = (a) => a.type === 'hardscape' || a.type === 'structure' || a.type === 'rough';

let idSeq = 1;
export const resetIds = (n = 1) => { idSeq = n; };
export const newId = () => idSeq++;
export const peekId = () => idSeq;

export function defaultState() {
  return {
    schema: SCHEMA,
    units: 'us',
    site: { name: 'My yard', origin: 'blank', lot: rect(0, 0, 70, 120), northDeg: 0, streetName: '' },
    supply: { psi: 50, gpm: 10 },
    schedule: { inchesPerWeek: 1, daysPerWeek: 3 },
    defaults: { type: 'mp', arc: 180, radius: 15 },
    sources: [],
    heads: [], pipes: [], drip: [], areas: [],
    underlay: null, // {src, u0, u1, v0, v1, opacity} — a user's own image, placed by scale
    activeLayout: 'mine',
    shelved: null,
    nextId: 1,
  };
}

/* --- Starting points ---------------------------------------------------- */

/** A rectangle of bare ground and one hose bib. Everything else is drawn by
 *  the person whose yard it is. */
export function blankSite(widthFt, depthFt, name = 'My yard') {
  const s = defaultState();
  const w = Math.max(15, widthFt), d = Math.max(15, depthFt);
  s.site = { name, origin: 'blank', lot: rect(0, 0, w, d), northDeg: 0, streetName: '' };
  s.areas = [
    { id: newId(), type: 'lawn', name: 'Lawn', pts: rect(3, 3, w - 3, d - 3) },
  ];
  s.sources = [{ id: `s${newId()}`, name: 'Hose bib', x: w / 2, y: d * 0.25 }];
  s.nextId = peekId();
  return s;
}

/** A site traced over the user's own image. The lot starts as the image's own
 *  footprint in feet — whatever the two-point scale said it was — so the first
 *  thing they see is the picture at the right size with nothing drawn on it. */
export function tracedSite(image, name = 'My yard') {
  const s = defaultState();
  const w = image.u1 - image.u0, d = image.v1 - image.v0;
  s.site = { name, origin: 'traced', lot: rect(image.u0, image.v0, image.u1, image.v1), northDeg: 0, streetName: '' };
  s.underlay = { ...image, opacity: 0.85 };
  s.areas = [];
  s.sources = [{ id: `s${newId()}`, name: 'Hose bib', x: image.u0 + w / 2, y: image.v0 + d * 0.3 }];
  s.nextId = peekId();
  return s;
}

/** The demonstration yard.
 *
 * Invented, not surveyed: a 70 x 120 ft rectangle with the things almost every
 * suburban lot has — a house set back from the street, a drive down one side,
 * a walk to the door, foundation beds, a patio and a shed out back, one shade
 * tree, a fence around the back yard. It exists so the tool has something to
 * open with and so the auto-layout has a non-trivial problem to solve on the
 * first click. It is deliberately generic; no real address is modelled here. */
export function sampleSite() {
  const s = defaultState();
  const W = 70, D = 120;
  s.site = { name: 'Example yard', origin: 'sample', lot: rect(0, 0, W, D), northDeg: 15, streetName: 'Street' };

  const A = (type, name, pts, extra) => ({ id: newId(), type, name, pts, ...(extra || {}) });
  const R = (type, name, x0, y0, x1, y1, extra) => A(type, name, rect(x0, y0, x1, y1), extra);

  const HOUSE = { x0: 14, y0: 48, x1: 52, y1: 84 };

  s.areas = [
    // Lawns: the front, the back, and the two side strips beside the house.
    A('lawn', 'Front lawn', [
      { x: 0, y: 0 }, { x: 46, y: 0 }, { x: 46, y: 44 }, { x: 52, y: 44 },
      { x: 52, y: 48 }, { x: 0, y: 48 },
    ]),
    R('lawn', 'Left side yard', 0, 48, 14, 88),
    R('lawn', 'Right side yard', 52, 48, 70, 88),
    A('lawn', 'Back lawn', [
      { x: 0, y: 88 }, { x: 70, y: 88 }, { x: 70, y: 116 }, { x: 0, y: 116 },
    ]),

    // Paving.
    R('hardscape', 'Driveway', 46, 0, 66, 44),
    A('hardscape', 'Front walk', curvedStrip({ x: 46, y: 40 }, { x: 38, y: 44 }, { x: 33, y: 48 }, 3.5)),
    R('hardscape', 'Front stoop', 30, 44, 36, 48),
    R('hardscape', 'Patio', 20, 84, 40, 96),

    // Beds.
    R('bed', 'Foundation bed, left', 14, 44, 30, 48),
    R('bed', 'Foundation bed, right', 36, 44, 52, 48),
    R('bed', 'Back fence bed', 4, 110, 66, 116),
    R('bed', 'Bed by the shed', 48, 100, 56, 104),
    R('bed', 'Raised beds', 6, 92, 16, 102),

    // Structures and planting.
    A('structure', 'House', rect(HOUSE.x0, HOUSE.y0, HOUSE.x1, HOUSE.y1), { house: true }),
    R('structure', 'Shed', 56, 104, 66, 112),
    A('tree', 'Shade tree', circlePoints({ x: 22, y: 22 }, 11, 28)),

    // Fence around the back, open-ended at the house corners.
    A('fence', 'Back fence', [
      { x: 14, y: 88 }, { x: 0, y: 88 }, { x: 0, y: 118 }, { x: 70, y: 118 }, { x: 70, y: 88 }, { x: 52, y: 88 },
    ], { open: true }),
  ];

  // Two hose bibs, the usual pair: one on the back wall, one near the front
  // corner by the drive.
  s.sources = [
    { id: `s${newId()}`, name: 'Back hose bib', x: 42, y: 84 },
    { id: `s${newId()}`, name: 'Front hose bib', x: 52, y: 50 },
  ];
  s.nextId = peekId();
  return s;
}

/* --- Derived --------------------------------------------------------- */

export const lotBounds = (state) => bounds(state.site.lot);
export const irrigableAreas = (state) => state.areas.filter(isIrrigable);
export const obstacleAreas = (state) => state.areas.filter(isObstacle);

/** Total ground the system is responsible for. Overlapping polygons are
 *  counted twice; the app's own areas never overlap unless the user draws them
 *  that way, and if they do, the honest fix is to say so rather than to guess. */
export const irrigableArea = (state) => irrigableAreas(state).reduce((s, a) => s + polyArea(a.pts), 0);

/* --- Persistence ------------------------------------------------------- */

export function normalise(raw) {
  const base = defaultState();
  // Anything that is not a plan is treated as no plan at all, and then falls
  // through the same repair path as a partial one — so a corrupt file and an
  // empty one both end up as something you can draw on.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
  const s = { ...base, ...raw };
  s.site = { ...base.site, ...(raw.site || {}) };
  s.supply = { ...base.supply, ...(raw.supply || {}) };
  s.schedule = { ...base.schedule, ...(raw.schedule || {}) };
  s.defaults = { ...base.defaults, ...(raw.defaults || {}) };
  for (const k of ['areas', 'heads', 'pipes', 'drip', 'sources']) if (!Array.isArray(s[k])) s[k] = [];
  if (!Array.isArray(s.site.lot) || s.site.lot.length < 3) s.site.lot = base.site.lot;
  if (!s.sources.length) {
    const b = bounds(s.site.lot);
    s.sources = [{ id: 's1', name: 'Hose bib', x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }];
  }
  // Ids must never collide with anything already loaded.
  const maxId = Math.max(0, ...[...s.areas, ...s.heads, ...s.pipes, ...s.drip].map((o) => Number(o.id) || 0));
  s.nextId = Math.max(Number(s.nextId) || 1, maxId + 1);
  resetIds(s.nextId);
  s.schema = SCHEMA;
  return s;
}

export function load(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    return normalise(JSON.parse(raw));
  } catch (_) {
    return null; // A corrupt or half-written plan is not worth an error screen.
  }
}

export function save(state, storage = globalThis.localStorage) {
  try {
    state.nextId = peekId();
    storage?.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (_) {
    // Quota, most likely a large traced image. The plan stays live in memory;
    // the export button is the honest escape hatch.
    return false;
  }
}
