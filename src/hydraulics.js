/* Nozzle behaviour, flow, precipitation rate and run time.
 *
 * These are catalogue approximations, not a hydraulic design. Every model here
 * is the simplest one that still moves in the right direction when you change
 * an input, and the numbers are close enough to size zones and argue with a
 * parts list. They are not close enough to skip a pressure gauge.
 *
 * The one physical law doing real work is the orifice equation: flow through a
 * fixed opening goes as the square root of pressure. Radius follows the same
 * curve, clamped, because a nozzle that loses pressure throws short before it
 * stops throwing at all. */

export const HEAD_TYPES = {
  spray: { label: 'Fixed spray', ratedPsi: 30, k: 0.0165, min: 4, max: 15, note: 'High precipitation rate, short throw. Small or awkward areas.' },
  rotor: { label: 'Gear rotor', ratedPsi: 45, k: 0.0033, min: 15, max: 35, note: 'Long throw, low precipitation rate. Big open lawns.' },
  mp: { label: 'Rotary nozzle', ratedPsi: 40, k: 0.0028, min: 8, max: 30, note: 'Low precipitation rate, wind-tolerant, slow. The all-rounder.' },
};

/** Emitter assumptions for drip zones: 0.6 GPH emitters on a 12 in grid, i.e.
 *  one emitter per square foot of bed. */
export const DRIP = { gphPerEmitter: 0.6, emitterSpacingFt: 1, tubingSpacingFt: 1.5 };

const PSI_SCALE_MIN = 0.6, PSI_SCALE_MAX = 1.25;

/** How pressure scales throw and flow. Clamped at both ends: below the low
 *  clamp a nozzle fogs rather than throws, above the high one it mists. */
export function psiScale(psi, ratedPsi) {
  return Math.min(PSI_SCALE_MAX, Math.max(PSI_SCALE_MIN, Math.sqrt(psi / ratedPsi)));
}

export function effectiveRadius(head, psi) {
  const t = HEAD_TYPES[head.type] || HEAD_TYPES.spray;
  return Math.max(2, head.radius * psiScale(psi, t.ratedPsi));
}

export function headGpm(head, psi) {
  const t = HEAD_TYPES[head.type] || HEAD_TYPES.spray;
  return t.k * head.radius * head.radius * (head.arc / 360) * psiScale(psi, t.ratedPsi);
}

/** Drip flow for a bed, from its area. */
export function dripGpm(areaSqFt) {
  const emitters = areaSqFt / (DRIP.emitterSpacingFt * DRIP.tubingSpacingFt);
  return (emitters * DRIP.gphPerEmitter) / 60;
}

/** Tubing needed to cover a bed at the assumed row spacing. */
export const dripTubingFt = (areaSqFt) => areaSqFt / DRIP.tubingSpacingFt;

/* --- Precipitation rate ------------------------------------------------ */
/* PR (in/hr) = 96.25 x GPM / area, the standard conversion: one GPM spread
 * over one square foot for one hour is 96.25 inches deep. Sprinklers overlap
 * head-to-head, so the honest denominator is the area the zone is responsible
 * for, not the sum of the wetted sectors. */

export const PR_CONSTANT = 96.25;

export function precipRate(zoneGpm, zoneAreaSqFt) {
  if (!(zoneAreaSqFt > 0) || !(zoneGpm > 0)) return null;
  return (PR_CONSTANT * zoneGpm) / zoneAreaSqFt;
}

/** Minutes per week to apply `inchesPerWeek`, and how to split it across
 *  `daysPerWeek` starts. Returns null when the zone has no measurable rate. */
export function runTime(zoneGpm, zoneAreaSqFt, inchesPerWeek = 1, daysPerWeek = 3) {
  const pr = precipRate(zoneGpm, zoneAreaSqFt);
  if (!pr) return null;
  const weeklyMin = (inchesPerWeek / pr) * 60;
  return { pr, weeklyMin, perStartMin: weeklyMin / Math.max(1, daysPerWeek) };
}

/* --- Units -------------------------------------------------------------- */
/* Stored state is always feet and GPM. Display converts. Anyone outside the US
 * plans in metres and litres, and a tool that claims to work for any yard has
 * to survive that without a second coordinate system. */

export const UNITS = {
  us: { id: 'us', len: 'ft', area: 'sq ft', flow: 'GPM', depth: 'in', lenFactor: 1, areaFactor: 1, flowFactor: 1, depthFactor: 1 },
  metric: { id: 'metric', len: 'm', area: 'm²', flow: 'L/min', depth: 'mm', lenFactor: 0.3048, areaFactor: 0.092903, flowFactor: 3.78541, depthFactor: 25.4 },
};

export const toLen = (ft, u) => ft * UNITS[u].lenFactor;
export const fromLen = (v, u) => v / UNITS[u].lenFactor;
export const toArea = (sqft, u) => sqft * UNITS[u].areaFactor;
export const toFlow = (gpm, u) => gpm * UNITS[u].flowFactor;
export const fromFlow = (v, u) => v / UNITS[u].flowFactor;
export const toDepth = (inches, u) => inches * UNITS[u].depthFactor;

export function fmtLen(ft, u, digits = 0) { return `${toLen(ft, u).toFixed(digits)} ${UNITS[u].len}`; }
export function fmtArea(sqft, u) { return `${Math.round(toArea(sqft, u)).toLocaleString()} ${UNITS[u].area}`; }
export function fmtFlow(gpm, u, digits = 1) { return `${toFlow(gpm, u).toFixed(digits)} ${UNITS[u].flow}`; }

/** Bucket test: how many gallons per minute a spigot delivers, from the time
 *  it takes to fill a bucket of known size. The single most useful number in
 *  the whole tool, and the only one a homeowner can measure without buying
 *  anything. */
export function bucketGpm(volume, seconds, unit) {
  if (!(seconds > 0) || !(volume > 0)) return null;
  const gallons = unit === 'metric' ? volume / 3.78541 : volume;
  return Math.round((gallons / seconds) * 60 * 2) / 2;
}
