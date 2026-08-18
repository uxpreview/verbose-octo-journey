# Irrigation Lab — session handoff

> Working notes for whoever picks this up next, human or agent. Disposable —
> delete it once the next steps in §7 are done or have moved somewhere better.

| | |
|---|---|
| **Repo** | `uxpreview/verbose-octo-journey` |
| **Base** | `main` @ `d2dccac` — contains the full rebuild |
| **Landed** | [PR #6](https://github.com/uxpreview/verbose-octo-journey/pull/6) — **merged** |
| **Deploys from** | `main` → `irrigation-planner-theta.vercel.app` |
| **Intended host** | `irrigation.ryankm.com` — **assumed, not confirmed** (see §7.1) |
| **Tests** | `npm test` — 34 on `main`; each feature branch adds its own (see §7) |
| **Handoff written** | 2026-08-18 |

---

## 1. What this project is

**Irrigation Lab** — a browser tool for planning a DIY sprinkler system on any
property. Draw the lot, enter what your spigot actually delivers, and it sizes
nozzles, places heads, packs zones under the flow budget, routes trenches and
prints a dig plan.

It is presented as **EXP-039** in the Lab on ryankm.com, and is a sibling of
`uxpreview/attention-lab` (EXP-038), which is the visual and structural
reference — same site chrome, same vendored design tokens, same "record voice →
claim → lede → experiment → bench notes" page shape.

**Vanilla JavaScript and SVG. No framework, no build step, no runtime or dev
dependencies, no server, no analytics, and no network call anywhere in the
repository.**

### What just landed

The repo previously modelled one specific property — the lot line came from a
county parcel file keyed to a single address, the underlay from a state GIS
aerial pre-rotated to that lot, the areas were traced by hand from a photo of a
sketch of that yard, and the "recommended layout" was a literal list of 34 typed
coordinates. It was structurally a drawing of a house rather than a program
about yards.

PR #6 replaced the property with a model and the typed answer with a solver.
Deleted: the address, the photographs, `data/parcel.geojson`,
`data/house.geojson`, the hard-coded plan frame and north offset, and the old
874-line `app.js`.

---

## 2. Start here

```bash
git clone https://github.com/uxpreview/verbose-octo-journey.git
cd verbose-octo-journey
git checkout -b <new-branch> origin/main
```

`main` already contains everything described in this document — there is no
outstanding branch to build on and nothing to rebase around. Branch from `main`,
target the new PR at `main`.

### Running it

```bash
npm run dev      # static server on http://localhost:8765
npm test         # 34 tests, plain node, no install needed
```

There is nothing to `npm install`. `package.json` has no `dependencies` and no
`devDependencies` — Node is used only to serve files and run the test file.

The one exception: `scripts/make-figures.mjs` regenerates the README figures and
the Open Graph card by driving the app headlessly, and needs Playwright
installed ad hoc (`npm i -D playwright`). It is deliberately not in
`package.json`, because it is a tool for the repo rather than a dependency of
the app. Run it only if you change the renderer or the sample yard, with the dev
server already running.

---

## 3. Architecture

Everything is ES modules loaded directly by the browser — no bundler, so
`index.html` points at `/src/main.js` and imports resolve as real paths.

| File | Lines | Responsibility | Watch out for |
|---|---:|---|---|
| `index.html` | 455 | Three screens: start, planner, printable sheet | Screens are toggled with `[hidden]`; `styles.css` has `[hidden]{display:none!important}` because `.screen-plan` is `display:flex` and would otherwise win |
| `styles.css` | 507 | The whole design system application | Zone palette lives here as `--zone-1..5` |
| `tokens.css` | 109 | **Vendored** from ryankm.com's `app/globals.css` | One-directional copy — never edit a value here; replace the whole file when the site's tokens change |
| `src/geometry.js` | 143 | Plane geometry in "plan feet"; polygons, sectors, bisectors | Pure, no DOM — safe to import in tests |
| `src/hydraulics.js` | 101 | Nozzle flow/throw, precipitation rate, run time, units | Every constant is documented with where it came from |
| `src/site.js` | 206 | What a yard *is*; the three starting points; persistence | `normalise()` is the repair path for any loaded plan — all input goes through it |
| `src/coverage.js` | 113 | The coverage grid | **One implementation, shared by the map, the solver and the tests.** Do not fork it |
| `src/autolayout.js` | 376 | The solver (see §4) | The interesting file |
| `src/render.js` | 388 | The plan drawing, plus a standalone SVG for print | Screen `y` is flipped exactly once, in `P()` |
| `src/sheet.js` | 205 | Dig plan, head schedule, shopping list | `summarise()` is shared with the panel so print and screen cannot disagree |
| `src/main.js` | 922 | Screens, tools, pointer/keyboard handling, the panel | Biggest file; the obvious split is panel-rendering out of event wiring |
| `tests/run.mjs` | 282 | No-dependency test runner | |
| `scripts/serve.mjs` | 31 | Static server for `npm run dev` | |
| `scripts/make-figures.mjs` | 88 | Regenerates README figures + OG card | Needs Playwright ad hoc |

### Coordinates

One flat system, **"plan feet"**: `x` runs left→right across the lot as you face
it from the street, `y` runs away from the street into the yard. Screen `y` is
flipped once, at the render boundary. Metric display converts on the way out —
**stored state is always feet and GPM**. There is no projection, no geocoding and
no latitude anywhere in the repo, and that is deliberate.

### State

One plain object, saved to `localStorage` under `irrigation-lab-plan-v1` on
every change, exportable as JSON. Shape is defined by `defaultState()` in
`src/site.js`.

---

## 4. The solver

`src/autolayout.js`, five stages. This is the heart of the project — the thing
that makes it a lab rather than a drawing program.

1. **Size the nozzle to the shape** (`pickNozzle`) — measures the largest circle
   that fits inside each area, sampled, rather than its area. A 2,000 sq ft lawn
   and a 2,000 sq ft side strip want completely different heads and area alone
   cannot tell them apart. Wide open ground → gear rotors; ordinary lawns →
   rotary nozzles; narrow strips → fixed sprays.
2. **Ring the edge, fill the middle** (`placeHeads`) — corners take the interior
   angle as their arc and the inward bisector as their aim, computed by
   construction and then verified against the polygon so reflex corners on an
   L-shaped lawn come out right. Edges get half circles facing in. The interior
   gets a triangular lattice wherever the perimeter ring cannot reach.
3. **Prune what earns nothing** (`pruneHeads`) — greedy, cheapest-first, keeping
   a removal only if coverage holds **and** head-to-head overlap barely moves.
4. **Pack zones under the flow budget** (`chainByProximity`, `packZones`,
   `balanceZones`, `zoneHeads`) — heads walked in a nearest-neighbour chain from
   each source; the greedy pack fixes the valve count at 85 % of measured flow,
   then a linear-partition DP re-cuts the chain into that many contiguous runs
   with the lowest peak flow. Chain from whichever source needs fewest valves.
5. **Trench as a spanning tree** (`TrenchRouter`, `trenchTree`) — Prim's MST per
   zone over *routed* edges: straight when clear of every building, else the
   shortest path round the offset corners; paving priced ×1.8, never a wall.

Beds run on drip rather than throw, with flow from bed area.

**On head-to-head spacing:** every head throws far enough to reach its
neighbour. On paper that looks like absurd overlap and it is the entire trick — a
single head puts down most of its water close in, so a layout with 100 % single
coverage and no overlap browns out in rings at the edge of every arc. The pruner
is scored on both numbers for this reason; an earlier version scored only single
coverage and produced visibly worse plans (59 % overlap vs 87 %).

---

## 5. Load-bearing decisions

Things that look arbitrary and are not. Changing any of these is fine — changing
them *by accident* is the failure mode.

- **`tokens.css` is vendored, one-directional.** Never edit a value on this
  side. Two editable copies of a design system is how a system stops being one.
- **Five zone colours, never cycled.** The palette was validated on the cream
  ground for lightness band, chroma floor, all-pairs colour-vision separation
  and contrast. One pair sits at deuteranopia ΔE 6.6 — inside the band that is
  legal *only* with secondary encoding. So **the zone number on every head and
  the per-zone dash patterns are load-bearing, not decoration.** Six all-pairs-safe
  categorical hues do not exist at usable contrast. A plan with more than five
  zones drops the extras to neutral ink and asks you to focus one at a time.
- **One coverage implementation** shared by map, solver and tests. A solver that
  optimises against a different measure than the one on screen will confidently
  produce a plan that looks wrong.
- **The plan is drawn as paper, not as an imitation aerial.** Everything on it is
  a measured polygon someone typed or traced; the old dark-satellite styling
  promised a fidelity the geometry never had. This is the most subjective call
  in the rebuild and the easiest to revert — see §8.
- **Arcs and the coverage wash are clipped to the lot.** A boundary head really
  does spray over the fence, but what the plan measures is water landing on
  *this* ground.
- **No network calls.** Images are read with `FileReader` and never uploaded.
  Keep it that way — it is a stated claim on the page and in the README.

---

## 6. What the tests guarantee

`npm test` — 34 tests asserting the invariants a plan needs in order to be
*diggable*, rather than that functions return numbers:

- no zone exceeds the flow budget, at any supply
- no zone exceeds the practical head count for one valve
- no head lands inside the house, the patio or the drive; every head is on the lot
- every head is reachable from a water source along the drawn trenches
- coverage and head-to-head overlap are actually achieved (≥ 88 % / ≥ 45 %)
- a lower supply produces *more zones*, not an over-budget plan
- the sample site carries no address, name or coordinate (regression guard)
- garbage input to `normalise()` still yields a usable plan
- ids never collide across heads, pipes and drip

**Browser checks are not automated.** The following were driven manually in
Chromium and are worth repeating after UI changes: blank metric lot →
auto-layout, area drawing, undo, the image-trace scale dialog, JSON export,
resume-after-reload, and a 390 px viewport (no horizontal overflow, no console
errors). See §7.8 — automating these is a listed next step.

---

## 7. Next steps

Ranked. Items 1–3 are decisions and deploy; 4–7 are the substance of a good next
PR; 8–11 are polish.

### Blocking on a decision from Ryan

**1. Confirm the experiment number and the host — this is now live, not
pending.** `EXP-039` and `irrigation.ryankm.com` were assumptions I made, and
PR #6 is merged, so **whatever Vercel serves from `main` now carries them** in
its title, canonical link, Open Graph tags and JSON-LD. If either is wrong, fix
it before search engines settle on it. Hard-coded in five places:

- `index.html` — `<title>`, description, `rel=canonical`, `og:*`, JSON-LD `url` / `alternateName`
- `README.md` — the "Try it" line and the badge text
- `sitemap.xml` — the single `<loc>`
- `robots.txt` — the `Sitemap:` line
- `package.json` — `homepage`

*Not verified:* I could not reach `irrigation-planner-theta.vercel.app` from the
build sandbox (network policy), so I cannot confirm the deploy has actually
picked up the merge. Check it first.

**2. Finish the deploy.** `main` has changed, so the existing Vercel project now
serves the rebuild at the old URL. Remaining: add `irrigation.ryankm.com` to the
project, point DNS, and decide whether the old `vercel.app` URL should redirect.
`.vercelignore` already excludes `docs/`, `scripts/` and `tests/`.

**3. Add the Lab index entry** on ryankm.com. Different repo
(`uxpreview/portfolio`) and not in this repo's scope — needs an EXP-039 entry at
`/lab` pointing off-site, the same way EXP-038 does.

### Substance for the next PR

**4. ~~The solver has a performance wall.~~ Done** (`feat/solver-perf`).
`pruneHeads` now measures against a `CoverageSampler` — the polygon is sampled
once and each trial removal touches only that head's footprint — and
`trenchTree` is textbook O(n²) Prim instead of re-scoring every pair per step.
`buildCoverageGrid` (the map wash) likewise loops per head over its own throw
rather than per cell over every head. Output is byte-identical to before on the
sample yard and on blank lots; two tests guard it (sampler ≡ `polygonCoverage`,
and a 300 × 400 ft lot must solve in < 3 s).

| Lot | Heads | Before | After |
|---|---:|---:|---:|
| 70 × 120 ft | 10 | 162 ms | 52 ms |
| 200 × 260 ft | 42 | 8.7 s | 78 ms |
| 300 × 400 ft | 94 | > 90 s | 180 ms |
| 500 × 600 ft | 215 | — | 0.45 s |

Still synchronous on the button; a Web Worker is no longer needed for any lot a
homeowner has.

**5. ~~Zone packing leaves an orphan.~~ Done** (`feat/zone-balance`).
`balanceZones` keeps the greedy zone count (for a fixed chain, greedy is
already optimal for the *number* of contiguous zones) and re-cuts the chain by
DP to minimise the busiest zone; `zoneHeads` tries a chain from every source
and keeps the one with fewest valves. Sample yard at 10 GPM: 14 / 14 / 11 / 1
→ 14 / 12 / 14 in three valves instead of four. At 6 GPM: 14 / 12 / 8 / 5 / 1
→ 14 / 5 / 5 / 7 / 9. Zone 1 stays at 14 tiny sprays because
`MAX_HEADS_PER_ZONE` binds before flow does — that is the cap, not a bug.
Tests: balancing never adds a valve, never leaves an orphan, respects the head
cap; no spray zone on the sample yard has fewer than 3 heads.

**5b. Nozzle sizing ignores the flow budget.** Found while doing 5. On a blank
120 × 160 ft lot at 10 GPM the solver picks 42 ft rotors at 4.3 GPM each, and
two of them exceed the 8.5 GPM budget — so it packs *one rotor per zone* and a
200 × 260 ft lawn comes out as 27 zones. `pickNozzle` sizes to shape only.
*Fix:* pass the budget in and step the radius (or the family, rotor → MP) down
until at least two or three heads fit a zone; a designer with a small meter
would run rotary nozzles at a shorter throw, not one rotor at a time. Add a
test that a big blank lot at 10 GPM needs no more than heads/2 zones.

**6. ~~Trenches penalise crossing buildings but do not route around them.~~
Done** (`feat/trench-routing`, stacked on `feat/solver-perf`). Two things:

- `segmentCrossesPoly` counted a *touch* as a crossing. Both sample bibs sit
  on the house wall, so every run out of a bib carried the ×8 penalty and the
  tree learned nothing from it (4 of the 5 "crossings" on the sample yard were
  this). It now means "enters the interior": proper edge crossings, else three
  interior sample points, boundary read as outside.
- `TrenchRouter` (`src/autolayout.js`): a visibility graph over every
  building's offset corners (`offsetCorners` in `geometry.js`, margin 1.5 ft,
  reflex-safe), Dijkstra per query, corner-to-corner visibility computed once.
  `trenchTree` weights each edge by its routed cost and returns polylines with
  the turns in; `autoLayout` writes them straight into `pipes[].pts` — the
  renderer, the sheet's pipe totals and the reachability test already took
  polylines. Paving stays a ×1.8 price, not a wall. Boxed-in pairs fall back
  to a straight run at ×8, drawn honestly.

Sample yard: 0 runs under a building (was 1 real + 4 false), 610 ft of trench
(was 586). Six new tests, including "no auto-laid trench goes under a
building" on the sample plan.

**7. ~~Traced images are stored at full resolution.~~ Done**
(`feat/image-downscale`). `shrinkImage` in `src/main.js` runs between the
`FileReader` and the scale dialog: anything over 2000 px on the long edge, or
over ~1.5 MB as a data URL, is redrawn through a canvas and re-encoded as JPEG
at 0.85 on a white ground (a transparent sketch would otherwise come out
black). Small images pass through untouched so a crisp little plan drawing
keeps its pixels. Checked in Chromium: a 4000 × 3000 PNG lands in state as a
2000 × 1500 JPEG of ~450 KB and the plan keeps saving; an 800 × 600 PNG is
stored as the PNG it was. Still no network call — the canvas never leaves the
page.

### Polish

**8. There is no CI.** No `.github/` at all, so `npm test` runs only locally. A
GitHub Action running `npm test` on PRs is about ten lines and the tests are
fast and dependency-free.

**9. The map is pointer-only.** The SVG has `tabindex="0"` but there is no
keyboard path to select a head, nudge one, or reshape an area — only `[`/`]` for
aim once a head is already selected by mouse. For a portfolio piece whose author
is a UX designer this is the most conspicuous gap. Arrow-key nudging and
tab-through-heads would cover most of it.

**10. Add a `CLAUDE.md`** so future sessions get the commands and the
load-bearing decisions in §5 without being told. Consider the
`session-start-hook` skill so web sessions can run tests immediately.

**11. Friction loss is not modelled.** Documented as out of scope on the page
and in the README, and it is the largest remaining fidelity gap: a long run to
the far end of a zone arrives with less pressure than the slider says. Adding
Hazen-Williams over the drawn pipe lengths would make the GPM figures honest,
and the pipe lengths are already computed.

---

## 8. Open questions for Ryan

1. **`EXP-039`** — is that number free in the Lab's numbering?
2. **`irrigation.ryankm.com`** — right subdomain?
3. **Paper vs aerial styling.** The plan is now drawn as a drafting document
   rather than the old dark satellite look. Deliberate, defensible, and the
   easiest thing in the rebuild to revert if it reads wrong next to the rest of
   the portfolio.
4. **Should the sample yard stay an invented lot**, or would a real-but-anonymous
   one (a traced public parcel, unattributed) be more convincing? Current answer
   is invented, on the grounds that no real address should be modelled.

---

## 9. Domain glossary

Irrigation vocabulary used throughout the code and the UI.

| Term | Meaning |
|---|---|
| **Head** | A sprinkler. Pops up, sprays an arc, retracts. |
| **Arc** | How much of a circle a head covers — 90° in a corner, 180° along an edge, 360° in the middle. |
| **Throw / radius** | How far a head sprays. Falls with pressure. |
| **Head-to-head** | The design rule: every head throws far enough to reach its neighbours. Produces ~100 % double coverage, which is correct, not wasteful. |
| **Zone** | A group of heads on one valve, run together. Sized by flow. |
| **Valve** | The solenoid the controller opens to run a zone. One per zone. |
| **GPM / PSI** | Flow (gallons per minute) and pressure. Flow decides how many heads per zone; pressure decides how far each throws. |
| **Bucket test** | Timing how long a bucket takes to fill at the spigot — the only way a homeowner can measure real flow without buying anything. |
| **Precipitation rate** | Inches per hour a zone applies. `96.25 × GPM ÷ area`. Decides run time. |
| **Drip** | Emitter tubing for beds instead of spray. Needs its own filter and pressure regulator. |
| **Hose bib / spigot** | The outdoor tap. In this tool, a "water source" — where trenches start. |
| **Backflow preventer** | Stops irrigation water siphoning back into drinking water. Required by code nearly everywhere. |
| **Spray / rotor / rotary nozzle** | The three head families. Short throw and high rate; long throw and low rate; low rate and wind-tolerant. |

---

## 10. Notes for the new PR

- Branch from `main` (§2) and target `main`.
- Keep it to one theme. Items 4–7 in §7 are independent; four small PRs will
  review far better than one large one, and item 4 (performance) touches the
  most sensitive code.
- Run `npm test` before pushing. If you change `src/render.js` or the sample
  yard, regenerate the figures (§2) or the README pictures will drift.
- If you change the zone palette, re-validate it — the constraint in §5 is not
  a preference.
- Do not add dependencies without a reason worth writing down. "No build step,
  no dependencies" is a claim the README makes.
- Update or delete this file as part of the work it describes. A handoff doc
  that outlives its accuracy is worse than none.
