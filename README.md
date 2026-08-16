# 154 Low St — Irrigation Planner

A browser-based model of the house and yard at 154 Low St, Newburyport MA, for planning a DIY sprinkler system: where the heads go, what each one sprays, where the trenches run, and whether each zone fits the water supply.

No build step. Open `index.html` from any static server (or deploy the folder as-is to Vercel / GitHub Pages).

```
python3 -m http.server 8765   # then open http://localhost:8765
```

## What it does

- **Real lot** — parcel line from MassGIS (Level 3 parcels, `LOC_ID M_249480_951578`, 8,603 sq ft), house footprint from OpenStreetMap, aerial photos from MassGIS (spring 2025, 15 cm) with 2023 / 2021 / Esri as alternates.
- **Areas** — lawn, garden beds, hardscape, structures, tree canopy. Seeded from the reference photos; every polygon can be reshaped (drag corners, click a hollow dot to add one, right-click to remove) or deleted.
- **Sprinkler heads** — click to drop, drag to move. Type (spray / rotor / MP rotator), radius, arc and aim per head. Coverage overlay shows uncovered lawn in red, single coverage green, head-to-head overlap blue.
- **Pipe / trench** — click-to-draw runs that snap to heads and the water source; total feet per zone.
- **Zones** — GPM per zone vs. flow available, flagged when a zone is over budget.
- **Supply sliders** — PSI (scales spray radius) and GPM (bucket-test helper included).
- **Plan file** — auto-saved in the browser, plus Export / Import JSON.

## Files

| Path | What |
|---|---|
| `index.html`, `styles.css`, `app.js` | the app |
| `data/parcel.geojson` | MassGIS parcel polygon (WGS84) |
| `data/house.geojson` | OSM building footprint, way 196723669 |
| `img/` | web-size reference photos shown inside the app |
| `Photos/` | original photos (the `.mov` is git-ignored) |

## Assumptions to check on site

- Water source pin starts at the rear-left corner of the house (the hose bib by the wooden enclosure). Drag it if the real tap / manifold is elsewhere.
- Default supply is 50 PSI / 10 GPM until a real gauge + bucket test replaces it.
- Head GPM and radius are estimates from typical Rain Bird / Hunter nozzle charts, not a hydraulic design.

## Roadmap

1. ~~Map, parcel, house, areas~~ (done)
2. ~~Heads with spray arcs + coverage raster~~ (done)
3. ~~Trench drawing + pipe totals~~ (done)
4. ~~Zones + GPM budget~~ (done)
5. Printable "dig plan" sheet (PDF) with head list, pipe lengths and a parts count
6. Precipitation-rate / run-time estimate per zone
7. Optional: georeference the drone photos as an extra base layer
