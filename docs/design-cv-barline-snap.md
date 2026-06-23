# Design — CV Barline Snap (auto-align bars to the printed lines)

Status: DESIGN — awaiting Graham sign-off, then Codex. Build-on-GO only.
Scope: the **automated** refinement that sits between `autoDistributeBars`
(even floor) and the manual barline-tick drag (`moveBarBoundary`, shipped in
PR #94). Does NOT touch the converter VLM, the Roadmap Builder, or conductor
authority.

## Why this exists

`autoDistributeBars` spaces N bars **evenly** across a system band. The VLM
converter (`lib/chart-vision.ts`, `claude-opus-4-6` effort `'high'`) gives
coarse, often-wrong bar geometry — that's the documented "bar overlay almost
random" issue. PR #94 added the manual **fix-when-wrong** primitive: drag each
barline to the real printed line. That works, but on a 12-bar line it's 11
manual drags per system, every system, every chart.

The printed barlines are **right there in the rasterized page** — vertical dark
strokes spanning the staff. We already render the page to a canvas client-side
(`lib/pdf-viewer.ts:renderPage`). CV snap reads those pixels, finds the actual
vertical barlines, and snaps the auto-distributed boundaries to them in one tap.
Manual drag (#94) remains the fallback for whatever snap misses.

**The pipeline, three layers, each the fallback for the one above:**

```
autoDistributeBars   even floor (always works, never aligned)
        ↓  "Snap to lines"  (this design — auto, no-op-safe degrade)
CV barline snap      aligns to real lines on engraved/clean scans
        ↓  drag a tick      (PR #94 — manual fix-when-wrong)
moveBarBoundary      the floor every other mechanism falls back to
```

Snap must **never make things worse than auto-distribute**: a chart it can't
read (handwritten, low-contrast, heavy scan noise) yields few/no detections and
snap is a partial or full no-op. It is purely additive.

## Architecture — pure core + thin DOM adapter

Mirrors the project's testability posture (`vitest` is `environment: 'node'`):
all geometry/decision logic is pure and unit-tested; only pixel acquisition
touches the DOM and is covered by manual UAT.

### DOM adapter (in `app/[owner]/[show]/page.tsx`)

One function: turn a selected system's band into a 1-D darkness profile.

1. Render the **current page** to an offscreen `<canvas>` from the cached
   `pdf.js` doc (`docRef.current`) at a fixed detection scale (proposed
   `SNAP_RENDER_SCALE` so the band is ≥ ~1000px wide regardless of on-screen
   fit — the on-screen canvas may be letterboxed/downscaled and is unreliable
   for thin-line detection). Reuse `renderPage`'s viewport math; render once,
   reuse for every system on the page.
2. `getImageData` over the band's pixel rect: x ∈ `[xStart, xEnd]`,
   y ∈ `[yTop, yBottom]` (system-normalized → pixel via the offscreen
   viewport). No cross-origin taint — the PDF is same-origin (Supabase public
   URL or the Drive proxy), so the canvas is readable.
3. Collapse to a **column darkness profile**: for each column, the fraction of
   band-height rows whose luminance < `DARK_LUMA`. Output `BandProfile`
   (below). This is the only DOM-dependent step; everything downstream is pure.

### Pure core (new file `lib/chart-snap.ts`)

```ts
export interface BandProfile {
  cols: number;            // sampled columns across the band width (≈ band px width)
  dark: Float32Array;      // length cols; per-column fraction 0..1 of band rows that are dark
}

export interface DetectedLine {
  x: number;               // normalized 0..1 WITHIN the band (0 = xStart, 1 = xEnd)
  strength: number;        // 0..1 detection confidence (height coverage × peak sharpness)
}

export function detectBarlines(profile: BandProfile, opts?: SnapOptions): DetectedLine[];

export function snapBarsToLines(
  cal: ChartCalibration,
  systemId: string,
  lines: DetectedLine[],     // band-space, from detectBarlines
  opts?: SnapOptions,
): ChartCalibration;
```

#### `detectBarlines` — vertical-line finder

A printed barline is a **tall, thin, dark vertical run**. The discriminators
that separate it from note stems, text, clefs, and slurs:

1. **Height coverage** — `dark[col] ≥ MIN_COVERAGE` (proposed `0.6`): a barline
   spans most of the staff height; a note stem/letter covers far less. This is
   the primary filter (computed in the DOM adapter as the per-column fraction).
2. **Peak / NMS** — a real line is a local maximum a few px wide. Cluster
   adjacent above-threshold columns within `NMS_PX`; collapse each cluster to
   its dark-weighted **centroid x**; that's one candidate.
3. **Thinness** — reject clusters wider than `MAX_LINE_FRAC` of band width
   (rejects shaded boxes / rehearsal-mark fills / thick final-barline pairs
   collapse to one).
4. **Strength** = coverage × (cluster peak ÷ local neighborhood mean), clamped
   0..1. Drop candidates below `MIN_STRENGTH`.

Returns candidates **sorted by x**, band-normalized. Pure: input is the profile
array, output is numbers. Fully unit-testable with synthetic `dark` arrays
(spike columns = lines; broad humps = stems/text to reject).

#### `snapBarsToLines` — assign + apply

Given the system's N bars → N+1 boundaries (same model as #94: tick `0` =
`bars[0].xStart`, tick `k` = `bars[k].xStart`, tick `N` = `bars[N-1].xEnd`):

1. Map each band-space line to **page space**:
   `pageX = system.xStart + line.x × (system.xEnd − system.xStart)`.
2. **Match** boundaries → lines, left-to-right, **monotonic** (a line already
   consumed by an earlier boundary can't be reused; assignment order is
   preserved so reading order can't invert):
   - For each boundary in order, take the nearest unconsumed line within
     `SNAP_TOL` (normalized page units, proposed `0.02`) that also lies inside
     the boundary's legal window (the same neighbor-tick + own-edge clamp #94
     enforces). No line in tolerance → boundary **unchanged**.
3. **Apply** each match through the existing `moveBarBoundary(cal, systemId,
   boundaryIndex, pageX)` — so all the #94 invariants (no sibling crossing, no
   bar inversion, MIN_BAR_W floor, renumber) are inherited for free and there is
   **one** mutation path. Fold sequentially (each call returns a new cal).

**Count mismatch is expected and handled:** detections rarely equal N+1.
- More lines than boundaries → the unmatched lines are ignored (auto-distribute
  owns cardinality; snap only *positions*, never adds/removes bars — that's the
  count stepper's job, consistent with #94's "out of scope: adding/removing
  bars by drag").
- Fewer lines → only the matched boundaries move; the rest keep their even
  spacing. Strictly an improvement, never a regression.

## Confidence semantics (decision — see below)

`moveBarBoundary` clears confidence (`withoutConfidence`) — correct for a
**manual** edit (a human asserted the position). Snap is **automated**, so a
snapped boundary's bars arguably deserve a confidence = `line.strength` so the
review tint (design-realtime-chart-control.md mentioned tick confidence
coloring) surfaces weak snaps for human glance. Two options, Graham picks:

- **(A) Treat snap as manual** — reuse `moveBarBoundary` as-is, confidence
  cleared, status → draft. Simplest, one path, no new param. Snap is "the
  machine did the human's drag for you." **Recommended for v1.**
- **(B) Carry strength** — add an internal apply path that sets each snapped
  bar's `confidence = strength` instead of clearing. Enables review-tinting of
  weak snaps, but forks the mutation path and defers cleanly to whenever
  tick-confidence coloring actually ships. **Defer.**

## UX (in `app/[owner]/[show]/page.tsx`)

- **Where:** the Bars tool, when a system is selected — a **"Snap to lines"**
  button beside the existing count stepper (`setSystemBars`, page.tsx:2455).
  One tap snaps that system's boundaries.
- **Order of operations stays the user's:** set/confirm count (even floor) →
  Snap (auto-align) → drag any tick snap missed (#94). Re-running the count
  stepper re-distributes and wipes snaps — already today's "reset this system"
  escape hatch (#94 §"Relationship to auto-distribute"); unchanged.
- **Degrade/feedback:** if `detectBarlines` returns nothing usable, the button
  is a no-op; show a brief inline "No clear barlines found — drag to align"
  hint rather than silently doing nothing. (Copy TBD.)
- **Optional later: "Snap all systems"** on the page — same core per system in a
  loop. Out of scope for v1; per-selected-system matches the manual model.

## Decisions to confirm (Graham)

1. **Pixel source = offscreen re-render at fixed scale** (not the on-screen
   canvas), so detection quality is independent of viewport size. Recommend
   **yes** (thin lines need resolution). Confirm `SNAP_RENDER_SCALE` target
   (~1000px band width).
2. **Snap positions only, never changes bar count** — count stays the stepper's
   job. Recommend **yes** (keeps cardinality in one place; #94-consistent).
3. **Confidence: option (A) treat-as-manual for v1** (reuse `moveBarBoundary`,
   clears confidence). Recommend **yes**, defer (B) to tick-coloring work.
4. **`SNAP_TOL = 0.02`** (≈2% page width max pull). Confirm or tune.
5. **`MIN_COVERAGE = 0.6`, `DARK_LUMA`, `MIN_STRENGTH`, `MAX_LINE_FRAC`,
   `NMS_PX`** — accept the named-constant set (tunable post-UAT) vs. you want
   specific starting values pinned now.
6. **Per-selected-system v1** ("Snap all" deferred). Recommend **yes**.
7. **Pure JS projection, no OpenCV/wasm dep.** Column-darkness projection is
   enough for engraved/clean scans and adds **zero dependencies**
   (no-undeclared-deps). Real CV (opencv.js, ~8MB wasm) is rejected as
   over-engineering for v1 — revisit only if projection proves insufficient on
   real charts. Recommend **yes**.
8. **Leading/trailing edge (boundary 0 / N) participate in snap** — the first
   printed barline (after clef/key-sig) and the final barline are detectable
   lines like any other. Risk: a clef/time-sig is dark but should be rejected by
   the thinness + coverage filters. Recommend **yes, with the filter as the
   guard**; flag for Codex scrutiny.

## Test plan (builder writes tests — pure core only)

`tests/chart-snap.test.ts` (new):

`detectBarlines`
- synthetic profile with 3 sharp full-coverage spikes → 3 lines at the spike x's
- broad low-coverage hump (note stem / text) → rejected (below MIN_COVERAGE)
- two spikes within NMS_PX → collapse to one centroid
- a cluster wider than MAX_LINE_FRAC → rejected (thick fill, not a line)
- everything below MIN_STRENGTH → empty array (handwritten/low-contrast degrade)
- strengths are 0..1 and monotone with coverage; output sorted by x

`snapBarsToLines`
- 4 even bars + 3 interior lines slightly off the even grid → each interior
  boundary snaps to its nearest line; leading/trailing unchanged if no edge line
- a line outside SNAP_TOL of every boundary → that boundary unchanged
- more lines than boundaries → extras ignored, no bar added
- fewer lines than boundaries → only matched boundaries move
- monotonic assignment: two boundaries can't both grab the same line; reading
  order / absNumber preserved (inherits #94's clamp)
- band→page x mapping correct for an indented system (xStart ≠ 0)
- option (A): snapped bars' confidence cleared, status → draft (delegates to
  moveBarBoundary); unknown systemId / empty lines → input unchanged
- degenerate: empty `lines` → returns input identity

DOM adapter (offscreen render + getImageData + column projection) has no jsdom
in this repo → validated by manual UAT on real charts, same posture as the #94
drag gizmo and the band-resize handles. Report test-count delta on the PR.

## Out of scope (explicit)

- Detecting **bar count** from the image (adding/removing bars) — the count
  stepper owns cardinality; snap only positions existing boundaries.
- System (staff) detection / y-band fitting — separate concern; snap operates
  within an already-placed system band.
- Roadmap-marker / repeat / volta detection from pixels — that's the VLM's job.
- OpenCV / wasm CV, ML line detection — rejected for v1 (see decision 7).
- Converter VLM prompt/effort changes — orthogonal; snap is the post-processor.
- "Snap all systems on the page" — deferred (decision 6).
