/* Plane geometry in "plan feet".
 *
 * The whole app works in one flat coordinate system: x runs left→right across
 * the lot as you face it from the street, y runs away from the street into the
 * yard. Nothing here knows about latitude, a map projection or a real address —
 * that is the point. A plan is a set of polygons on graph paper, and graph
 * paper is the same everywhere.
 *
 * Screen y is flipped once, at the render boundary (see `P` in render.js), so
 * every number below reads the way a person standing in the yard would read it:
 * bigger y is further back. */

export const rad = (d) => (d * Math.PI) / 180;
export const deg = (r) => (r * 180) / Math.PI;
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Ray casting. Points exactly on an edge are undefined-but-consistent, which
 *  is fine: every caller is sampling a grid, not testing a boundary case. */
export function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (yi > pt.y !== yj > pt.y && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Shoelace, absolute — orientation is never guaranteed here because polygons
 *  are drawn by hand in whatever direction the user happened to click. */
export function polyArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
  return Math.abs(a / 2);
}

export function polyPerimeter(poly, closed = true) {
  let s = 0;
  const n = closed ? poly.length : poly.length - 1;
  for (let i = 0; i < n; i++) s += dist(poly[i], poly[(i + 1) % poly.length]);
  return s;
}

export function centroid(poly) {
  let x = 0, y = 0;
  for (const p of poly) { x += p.x; y += p.y; }
  return { x: x / poly.length, y: y / poly.length };
}

export function bounds(pts) {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/** Nearest point on segment a→b, and how far pt is from it. */
export function nearestOnSegment(pt, a, b) {
  const L2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  if (L2 < 1e-9) return { q: { x: a.x, y: a.y }, d: dist(pt, a), t: 0 };
  const t = clamp(((pt.x - a.x) * (b.x - a.x) + (pt.y - a.y) * (b.y - a.y)) / L2, 0, 1);
  const q = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
  return { q, d: dist(pt, q), t };
}

/** Distance from a point to a polygon's boundary, ignoring inside/outside. */
export function distToBoundary(pt, poly, closed = true) {
  let best = Infinity;
  const n = closed ? poly.length : poly.length - 1;
  for (let i = 0; i < n; i++) {
    const { d } = nearestOnSegment(pt, poly[i], poly[(i + 1) % poly.length]);
    if (d < best) best = d;
  }
  return best;
}

export function segmentsIntersect(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  return o1 !== o2 && o3 !== o4;
}

/** Does the segment a→b cut through this polygon? Used to make pipe runs
 *  prefer going around the house rather than under it. */
export function segmentCrossesPoly(a, b, poly) {
  for (let i = 0; i < poly.length; i++) {
    if (segmentsIntersect(a, b, poly[i], poly[(i + 1) % poly.length])) return true;
  }
  return pointInPoly({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, poly);
}

/* --- Sprinkler arcs ---------------------------------------------------- */
/* `aim` is degrees clockwise from "away from the street" (+y), which is how a
 * person describes a head standing behind it: 0 is straight back, 90 is right. */

export const aimVec = (degrees) => ({ x: Math.sin(rad(degrees)), y: Math.cos(rad(degrees)) });
export const bearing = (from, to) => ((deg(Math.atan2(to.x - from.x, to.y - from.y)) + 360) % 360);

/** Smallest signed difference between two bearings, in (-180, 180]. */
export const angleDiff = (a, b) => (((a - b) % 360) + 540) % 360 - 180;

export function sectorPoints(head, r) {
  const pts = head.arc >= 360 ? [] : [{ x: head.x, y: head.y }];
  const steps = Math.max(12, Math.round(head.arc / 2));
  for (let i = 0; i <= steps; i++) {
    const a = head.aim - head.arc / 2 + (head.arc * i) / steps;
    const v = aimVec(a);
    pts.push({ x: head.x + r * v.x, y: head.y + r * v.y });
  }
  return pts;
}

export function inSector(head, r, p) {
  const d = dist(head, p);
  if (d > r) return false;
  if (head.arc >= 360 || d < 0.01) return true;
  return Math.abs(angleDiff(bearing(head, p), head.aim)) <= head.arc / 2 + 0.01;
}

/* --- Shape helpers used by the sample site and the lot setup ------------ */

export const rect = (x0, y0, x1, y1) => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];

export function circlePoints(c, r, n = 40) {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push({ x: c.x + r * Math.cos((2 * Math.PI * i) / n), y: c.y + r * Math.sin((2 * Math.PI * i) / n) });
  return pts;
}

/** A constant-width band along the quadratic curve a→(control c)→b, returned as
 *  a closed polygon. Paths and walks are rarely straight. */
export function curvedStrip(a, c, b, w, n = 14) {
  const left = [], right = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, mt = 1 - t;
    const p = { x: mt * mt * a.x + 2 * mt * t * c.x + t * t * b.x, y: mt * mt * a.y + 2 * mt * t * c.y + t * t * b.y };
    const d = { x: 2 * mt * (c.x - a.x) + 2 * t * (b.x - c.x), y: 2 * mt * (c.y - a.y) + 2 * t * (b.y - c.y) };
    const L = Math.hypot(d.x, d.y) || 1, nx = -d.y / L, ny = d.x / L;
    left.push({ x: p.x + (nx * w) / 2, y: p.y + (ny * w) / 2 });
    right.push({ x: p.x - (nx * w) / 2, y: p.y - (ny * w) / 2 });
  }
  return [...left, ...right.reverse()];
}
