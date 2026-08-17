# 154 Low St — Irrigation Planner

A browser-based model of the house and yard at 154 Low St, Newburyport MA, for planning a DIY sprinkler system: where the heads go, what each one sprays, where the trenches run, and whether each zone fits the water supply.

Live: https://irrigation-planner-theta.vercel.app (deploys from `main`).

No build step. Open `index.html` from any static server (or deploy the folder as-is to Vercel / GitHub Pages).

```
python3 -m http.server 8765   # then open http://localhost:8765
```

## What it does

- **2D plan view** — a drawn model of the lot, not a map: street at the bottom, house, driveway, walk, lawns, beds, patio, shed, big tree, fences. Rendered as SVG in "plan feet" (x along Low St, y into the yard). Scroll to zoom, drag to pan, compass and scale bar in the corners.
- **Real geometry underneath** — parcel line from MassGIS (Level 3 parcels, `LOC_ID M_249480_951578`, 8,603 sq ft) rotated into the plan frame; optional underlays (Ryan's layout sketch, or the MassGIS spring-2025 aerial pre-rotated to the same frame) fade the drawing so you can trace corrections. `Reset areas to sketch` re-traces the layout without touching heads or pipes.
- **Areas** — lawn, garden beds, hardscape, structures (incl. the house, shed, outdoor shower), tree canopy, fence lines. Traced from Ryan's layout sketch (`Photos/layout.heic`, also available as the **Layout sketch** underlay) with the aerial as a cross-check; every polygon can be reshaped (drag corners, click a hollow dot to add one, right-click to remove) or deleted.
- **Sprinkler heads** — click to drop, drag to move. Type (spray / rotor / MP rotator), radius, arc and aim per head; drag the white handle to aim and set reach. Coverage overlay shows uncovered lawn in red, single coverage faint green, head-to-head overlap blue.
- **Pipe / trench** — click-to-draw runs that snap to heads and the water source; total feet per zone.
- **Zones** — GPM per zone vs. flow available, flagged when a zone is over budget.
- **Supply sliders** — PSI (scales spray radius) and GPM (bucket-test helper included).
- **Plan file** — auto-saved in the browser, plus Export / Import JSON.

## Files

| Path | What |
|---|---|
| `index.html`, `styles.css`, `app.js` | the app (vanilla JS + SVG, no dependencies) |
| `data/parcel.geojson` | MassGIS parcel polygon (WGS84), converted to plan feet at load |
| `data/house.geojson` | OSM building footprint, way 196723669 (reference only; the drawn house is traced from the 2025 aerial) |
| `img/aerial-2025.jpg` | MassGIS 2025 aerial, rotated + cropped to the plan frame (u −30..90 ft, v −25..125 ft, 4 px/ft) |
| `img/layout-sketch.jpg` | Ryan's layout sketch, placed at u −31.4..77 ft, v −25..110.6 ft (≈11.8 px/ft) |
| `img/` | web-size reference photos shown inside the app |
| `Photos/` | original photos (the `.mov` is git-ignored) |

## Recommended setup (v1 — before the bucket test)

Top bar → **Recommended layout** shows it (your own heads and pipes stay parked under **My layout**; `Use as my layout` copies it over so you can edit). Assumes 50 PSI / 10 GPM; every zone stays under ~5.5 GPM so a hose-bib supply can run it.

| Zone | Where | Heads | GPM | Fed from |
|---|---|---|---|---|
| 1 | Front lawn, street half | 6 × MP3000 (22 ft) | ≈4.5 | Front bib |
| 2 | Front lawn, house half | 6 × MP3000 (20–22 ft) | ≈4.3 | Front bib |
| 3 | Left front lawn (past the driveway) | 6 × MP1000 (12 ft) | ≈0.9 | Back bib, around the patio and through the gate |
| 4 | Back yard | 8 × MP3000 (24 ft) | ≈5.4 | Back bib |
| 5 | Left + right side yards | 8 × MP1000 (12 ft) | ≈1.4 | Back bib |
| 6–7 | Beds: front beds, back fence bed, raised beds, gate/left beds | ½" drip line, 0.6 GPH @ 12" | ≈2 each | One drip zone per bib, with filter + 25 PSI regulator |

Head-to-head spacing (each head reaches the next), corners quarter-circle, edges half, middles full. About 34 heads, ~780 ft of ¾" poly lateral (buy 1000 ft), 1" main from each bib to a 3–4 valve manifold, backflow preventer on each bib, one Wi-Fi controller (6–8 zones). Coverage of lawn + beds ≈ 93 %, head-to-head overlap ≈ 80 %.

If the bucket test shows less than 7 GPM: keep the zones as they are (none exceeds 5.5). If it shows 12+ GPM: merge zones 1+2 and 4+5 to save two valves.

## Assumptions to check on site

- Two water sources (hose bibs) as confirmed by Ryan: back wall right of the outdoor shower, and front wall near the right corner. Drag to fine-tune; `+ Water source` adds more; pipes snap to any of them.
- Front walk is the short path from the driveway steps to the front-door steps (per the photos); there is no walk to the street.
- Default supply is 50 PSI / 10 GPM until a real gauge + bucket test replaces it.
- Head GPM and radius are estimates from typical Rain Bird / Hunter nozzle charts, not a hydraulic design.

## Roadmap

1. ~~Map, parcel, house, areas~~ (done)
2. ~~Heads with spray arcs + coverage raster~~ (done)
3. ~~Trench drawing + pipe totals~~ (done)
4. ~~Zones + GPM budget~~ (done)
5. Printable "dig plan" sheet (PDF) with head list, pipe lengths and a parts count
6. Precipitation-rate / run-time estimate per zone
7. Optional: georeference the drone photos as an extra underlay
