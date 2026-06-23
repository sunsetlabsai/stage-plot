# Design — CV Barline Snap (auto-align bars to the printed lines)

Status: DESIGN — decisions 1-8 LOCKED by Graham (all yes; #3 = option A).
Revised after Codex round-1 (order-aware matching contract, honest no-regression
claim, dedicated offscreen render helper). Build-on-GO only, after Codex re-review.
Scope: the **automated** refinement that sits between `autoDistributeBars`
(even floor) and the manual barline-tick drag (`moveBarBoundary`, shipped in
PR #94). Cardinality reconciliation (add/remove a barline) is its companion —
see `docs/design-barline-add-remove.md`. Does NOT touch the converter VLM, the
Roadmap Builder, or conductor authority.

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

**Honest guarantee (Codex R1 #2):** snap is **geometry-safe**, not infallible.
Because it applies only through `moveBarBoundary`, it can never produce an
*invalid* calibration — no crossings, inversions, or sub-`MIN_BAR_W` bars,
reading order/`absNumber` preserved. It can still *mis-position* a boundary onto
the wrong vertical stroke (a false-positive line), since geometry can't know
which stroke is semantically a barline. So snap is **gated** (strength floor +
unambiguous ordinal match, below) to make that rare, and every result stays
human-correctable via the #94 drag or a stepper re-distribute. On a chart it
can't read it degrades to a partial/full no-op. The claim is "never an invalid
calibration," **not** "never mis-positioned."

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
   for thin-line detection). **Do NOT call `renderPage` (Codex R1):** it sizes
   the viewport from `canvas.parentElement` (`pdf-viewer.ts:153`) and shares a
   module-global `activeRenderTask` (`pdf-viewer.ts:135`), so reusing it would
   cancel the visible render or fail on a detached offscreen canvas. Add a
   dedicated, self-contained helper `renderPageOffscreen(doc, pageNum, scale):
   Promise<HTMLCanvasElement>` that takes an explicit scale, owns a local render
   task (no module global), needs no DOM parent, and is independent of the
   on-screen render path. Render once per page, reuse for every system on it.
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
2. **Match — order-aware, NOT nearest-within-tolerance (Codex R1 #1).**
   The naive "snap each boundary to the nearest line within `SNAP_TOL`" fails the
   main workflow: a full-width system from `autoDistributeBars` puts boundary 0 at
   `system.xStart` (the page edge) and boundary N at `system.xEnd`, but the first
   printed barline sits *after* the clef/key-sig — often far more than 2% in — so
   a tiny tolerance leaves the very margins #94 introduced unsnapped. The match
   must therefore be **ordinal** (position-in-sequence), not proximity:
   - Let `B` = the N+1 boundary positions (page-space, ascending) and `L` = the
     detected line positions (page-space, ascending).
   - **Counts equal (`|L| == N+1`):** assign by ordinal — `L[i] → boundary i`.
     Edges anchor by their place in the sequence, so boundary 0 → the first line
     and boundary N → the last line **however far** they are from the band edge.
   - **Counts differ:** run a **monotone alignment** (order-preserving) of `B` to
     `L` and apply only **gated** matches:
     - **Mutual-nearest:** apply `L[j] → boundary i` only when `L[j]` is the
       nearest line to boundary `i` *and* boundary `i` is the nearest boundary to
       `L[j]` — so two boundaries can't fight over one line and a boundary can't
       reach across a bar.
     - **Strength floor:** `L[j].strength ≥ MIN_STRENGTH`.
     - **Displacement guard `MAX_PULL`:** cap the pull at a fraction of the
       *local bar width* (proposed `0.5 × min(adjacent bar widths)`), **not** a
       fixed page-fraction. Bar-width-relative is what lets boundary 0 reclaim a
       wide clef margin while still refusing a cross-bar yank. (This replaces the
       old fixed `SNAP_TOL = 0.02` — see decision 4.)
     - Unmatched boundaries stay put; surplus lines are reported, never forced
       (Count mismatch, below).
3. **Apply** each accepted match through the existing `moveBarBoundary(cal,
   systemId, boundaryIndex, pageX)` — so all the #94 invariants (no sibling
   crossing, no inversion, MIN_BAR_W floor, renumber) are inherited and there is
   **one** mutation path. Fold left-to-right; `moveBarBoundary`'s own clamp keeps
   the sequence monotone even if two accepted targets are close.

**Count mismatch — surfaced, never silently forced (decision 2 = positions
only):** detections rarely equal N+1. Snap never adds or removes a bar.
- More lines than boundaries → extra lines ignored by the matcher.
- Fewer lines → only gated boundaries move; the rest keep even spacing.
- When `|L| ≠ N+1`, snap returns its best positions **and the UI flags the
  delta** ("detected M lines vs N bars — Add/Remove to reconcile"), routing the
  user to the cardinality primitive in `docs/design-barline-add-remove.md`.
  That companion is what makes a wrong count locally fixable without a
  destructive stepper re-distribute (the gap Graham hit in #94 UAT).

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

## Decisions — LOCKED by Graham (all yes; #3 = A)

1. **Pixel source = offscreen re-render at fixed scale** (not the on-screen
   canvas). ✅ via the dedicated `renderPageOffscreen` helper above.
   `SNAP_RENDER_SCALE` targets ~1000px band width.
2. **Snap positions only, never changes bar count.** ✅ Cardinality is the
   stepper's (rough-in) and the new add/remove primitive's (local fix). Snap
   flags count deltas, never forces them.
3. **Confidence: option (A) treat-as-manual** (reuse `moveBarBoundary`, clears
   confidence, status → draft). ✅ (B) carry-strength deferred to tick-coloring.
4. **Displacement guard = `MAX_PULL` scaled to local bar width** (proposed
   `0.5 × min(adjacent bar widths)`). ✅ Replaces the rejected fixed
   `SNAP_TOL = 0.02`, which couldn't reclaim a wide clef margin (Codex R1 #1).
5. **Named-constant set** (`MIN_COVERAGE = 0.6`, `DARK_LUMA`, `MIN_STRENGTH`,
   `MAX_LINE_FRAC`, `NMS_PX`, `MAX_PULL`, `SNAP_RENDER_SCALE`) — accepted,
   tunable post-UAT. ✅
6. **Per-selected-system v1** ("Snap all" deferred). ✅
7. **Pure JS projection, no OpenCV/wasm dep.** ✅ Zero deps; real CV rejected as
   over-engineering for v1, revisit only if projection underperforms on real
   charts.
8. **Leading/trailing edge participate via ordinal anchoring.** ✅ The first
   printed barline (after clef/key-sig) and final barline anchor to boundary 0/N
   by sequence position (not proximity), so wide margins snap. The thinness +
   coverage filters keep the clef/time-sig from registering as a line — flagged
   for Codex scrutiny on real charts.

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
- **equal counts:** 4 even bars (5 boundaries) + 5 lines → ordinal `L[i]→bnd i`;
  boundary 0 pulls to the **first** line even when it sits well right of the band
  edge (the clef-margin case — the Codex R1 #1 regression test)
- boundary N anchors to the **last** line, however far from `system.xEnd`
- **unequal counts:** more lines than boundaries → extras ignored, no bar added;
  fewer lines → only gated boundaries move, the rest keep even spacing
- mutual-nearest gate: two boundaries can't both grab one line; a line nearer to
  a different boundary is not stolen
- `MAX_PULL` guard: a line beyond `0.5 × local bar width` from its ordinal
  boundary is refused (no cross-bar yank); one within it is applied
- `MIN_STRENGTH` gate: a weak line is not applied
- monotone result: reading order / `absNumber` preserved (inherits #94's clamp)
- band→page x mapping correct for an indented system (`xStart ≠ 0`)
- option (A): snapped bars' confidence cleared, status → draft (delegates to
  moveBarBoundary); unknown systemId → input unchanged
- degenerate: empty `lines` → returns input **identity** (`toBe`)

DOM adapter (offscreen render + getImageData + column projection) has no jsdom
in this repo → validated by manual UAT on real charts, same posture as the #94
drag gizmo and the band-resize handles. Report test-count delta on the PR.

## Out of scope (explicit)

- Detecting **bar count** from the image (adding/removing bars) — snap only
  positions existing boundaries. Local cardinality fixes (add/remove a barline)
  are the companion primitive in `docs/design-barline-add-remove.md`; the count
  stepper remains the rough-in.
- System (staff) detection / y-band fitting — separate concern; snap operates
  within an already-placed system band.
- Roadmap-marker / repeat / volta detection from pixels — that's the VLM's job.
- OpenCV / wasm CV, ML line detection — rejected for v1 (see decision 7).
- Converter VLM prompt/effort changes — orthogonal; snap is the post-processor.
- "Snap all systems on the page" — deferred (decision 6).
