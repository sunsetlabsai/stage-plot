# Design — Barline-Tick Drag (manual per-barline nudge)

Status: Build state tracked in `docs/INDEX.md`, not here.
Scope: ONE focused gap. Does not touch CV snap (separate doc) or the Roadmap Builder.

## Why this exists

`docs/design-realtime-chart-control.md:199` specified "Barline ticks —
x-positions within a system (drag horizontally to the real barline)." That
gizmo was never built. Today the calibrate flow only does the "effort floor":
drop a full-width system band, set a bar **count**, and `autoDistributeBars`
spaces the bars **evenly** across the band. Evenly-spaced ≠ where the printed
barlines actually are, so the overlay rarely lines up — and there is currently
**no way to fix it** (`app/[owner]/[show]/page.tsx:1660-1661`: "Ticks are
visual only here — per-tick nudge is a later refinement").

Graham's verdict: a mathematically-even-but-unaligned overlay is "worse than
none at all," and Perform / conductor mode depend on real alignment. This is the
missing **fix-when-wrong** primitive. It must work on **any** chart (scanned,
handwritten, engraved, converter-produced) because it is the floor that every
other alignment mechanism (CV snap next) falls back to.

## The model

Bars store `xStart`/`xEnd` (normalized 0..1, page-relative). For a system's
bars in reading order, the draggable **boundaries** are:

```
boundary 0      = bars[0].xStart        (leading edge — after clef/margin)
boundary k      = bars[k].xStart        (1..N-1: shared edge w/ bars[k-1].xEnd)
boundary N      = bars[N-1].xEnd        (trailing edge — end of last bar)
```

N bars → N+1 boundaries. `autoDistributeBars` produces contiguous bars
(`bars[k-1].xEnd === bars[k].xStart`), so an interior boundary is one printed
line shared by two bars. Dragging it must move **both** adjacent edges together.

For **non-contiguous** input (converter bars may have a gap or overlap where
`bars[k-1].xEnd !== bars[k].xStart`), the visible interior tick is drawn at the
**right bar's `xStart`** (`bars[k].xStart`) — matching today's render
(page.tsx:1699-1705, which ticks each bar's `xStart`). The first drag of that
tick snaps **both** edges to the dragged `x`, normalizing the pair to
contiguity. (Implementations must not silently pick the previous `xEnd` or an
average — the tick is `bars[k].xStart`, and drag unifies.)

### Pure helper (new, in `lib/chart-calibration.ts`)

```ts
moveBarBoundary(
  cal: ChartCalibration,
  systemId: string,
  boundaryIndex: number,   // 0..N
  x: number,               // normalized target, page-relative
): ChartCalibration
```

Behavior (mirrors `resizeSystemBand` precedent at chart-calibration.ts:274):

1. Resolve the system's bars in reading order (sorted by `xStart`). No-op if the
   system or `boundaryIndex` is out of range.
2. Clamp `x` to `[system.xStart, system.xEnd]`, then to the neighbor window so a
   boundary can't cross its siblings:
   `[prevBoundary + MIN_BAR_W, nextBoundary - MIN_BAR_W]`.
   For boundary 0 the lower bound is `system.xStart`; for boundary N the upper
   bound is `system.xEnd`. If the clamped window is degenerate, no-op (ignore the
   drag) — same fail-safe posture as `resizeSystemBand`'s `top >= bot` guard.
3. Apply:
   - boundary 0 → `bars[0].xStart = x`
   - boundary k (1..N-1) → `bars[k-1].xEnd = x` **and** `bars[k].xStart = x`
     (snaps both edges together; closes any pre-existing gap/overlap →
     normalizes toward contiguity, which is what we want)
   - boundary N → `bars[N-1].xEnd = x`
4. `withoutConfidence(...)` on each mutated bar (self-clears its review flag,
   consistent with every other manual edit), `status: 'draft'`, renumber via the
   existing path (order can't change because we clamp inside the neighbor
   window, so `absNumber` is preserved in practice — but renumber anyway for
   one code path).

`MIN_BAR_W` = small absolute floor in normalized units (proposed `0.01` ≈ 1% of
page width) to prevent zero/negative-width bars. Pure, immutable, no DOM — fully
unit-testable (the project's vitest is `environment: 'node'`, logic-only).

### Tap contract — `tapToBar` must become span-aware (Codex MED)

Once boundary 0 / boundary N are draggable, the leading edge (clef/key-sig/
margin) and trailing edge open **intentional empty space** with no bar in it.
But `tapToBar` (chart-calibration.ts:390) currently ignores bar spans — once it
has a system it always returns the **nearest bar midpoint**. So a tap in the
clef margin would still select bar 1, and a tap in trailing blank would select
the last bar, corrupting roadmap placement (page.tsx:1973) and Perform seek
(page.tsx:2569).

Fix the contract now (it's the same data this feature produces):

- After choosing the nearest system by `y` (unchanged), resolve the bar in `x`
  by **span**: return the bar whose `[xStart, xEnd]` contains `x`.
- If `x` falls in no bar's span (clef margin, trailing blank, or a
  not-yet-normalized gap between non-contiguous bars), return **`null`** —
  except within a small tolerance `TAP_TOL` of the nearest bar edge, snap to
  that bar (so a tap that just grazes the edge still lands).
- Proposed `TAP_TOL = 0.01` (same scale as `MIN_BAR_W`).

This preserves today's behavior everywhere a tap lands inside a bar (the common
case, since `autoDistributeBars` is contiguous), and only changes the
intentionally-blank margins/gaps from "snap to edge bar" to "no selection."
Callers already handle a `null` bar (page.tsx:1976-1978 returns early).

## The interaction (`app/[owner]/[show]/page.tsx`)

- **When:** ticks become grabbable only when the system is **selected** (mirrors
  the top/bottom resize handles, page.tsx:1713-1728). Unselected = visual only,
  no clutter, no accidental drags during count/section work.
- **Hit target:** a 1px line is un-grabbable, esp. on touch. Render an invisible
  ~14px-wide hit-strip centered on each tick (`cursor: ew-resize`,
  `touchAction: 'none'`, `pointerEvents: 'auto'`), with the visible 1px line on
  top. Same translucent-handle treatment as the band edges.
- **Drag loop:** extend the existing once-subscribed window listener
  (page.tsx:1936-1956). Today `dragRef` is `{id, edge:'top'|'bottom', other}`
  and computes `ny`. Generalize to a discriminated union:
  `{ kind:'band', id, edge, other } | { kind:'boundary', systemId, index }`.
  The `boundary` branch computes `nx = (clientX - r.left - box.left)/box.width`,
  clamps 0..1, and calls `moveBarBoundary`. `setPointerCapture` so a finger that
  slides off the thin strip keeps driving (same rationale as `beginResize`,
  page.tsx:1958-1964).
- **SystemBand:** when selected, render the N+1 hit-strips and wire
  `onBoundaryResizeStart(index, e)`. Boundary x-positions come straight from the
  sorted bars already computed there (`ordered`, page.tsx:1677).

## Relationship to auto-distribute

`autoDistributeBars` stays the **starting floor**: set/confirm a bar count → even
spacing → then drag the few barlines that are off. Re-running the count stepper
**re-distributes** (wipes that system's manual nudges) — that's already today's
behavior; we keep it as the intentional "reset this system" escape hatch. No
change to the count UI.

## Decisions to confirm (Graham)

1. **Shared-boundary semantics** — interior drag moves both adjacent edges
   together (keeps bars contiguous, closes gaps). Recommend **yes** (one printed
   line = one boundary). Alt: independent xStart/xEnd per bar (allows gaps);
   rejected as confusing and not what a barline is.
2. **`MIN_BAR_W` = 0.01** (≈1% page width). Confirm or set another floor.
3. **Confidence clears on drag** (self-clears review flag, → draft). Recommend
   **yes** for consistency with `resizeSystemBand` / `withoutConfidence`.
4. **Grabbable only when selected.** Recommend **yes** (mirrors band handles).
5. **Leading-edge (boundary 0) is draggable** so bar 1 can start after the
   clef/key-sig/margin. Recommend **yes** — this is a common real case. Paired
   with the span-aware `tapToBar` contract above (Codex MED) so the blank space
   it opens doesn't mis-select bar 1 / the last bar.
6. **Defer confidence color-coding of ticks** (design-realtime-chart-control.md
   mentioned it). Manual drag clears confidence anyway; converter-confidence
   tinting can ride along with the CV-snap work (#2). Recommend **defer**.
7. **`tapToBar` becomes span-aware, returns `null` outside bar spans** (Codex
   MED, paired with #5). `TAP_TOL = 0.01`. Recommend **yes**.

## Test plan (builder writes tests)

`tests/chart-calibration.test.ts` (extend) — pure helper:
- interior drag moves both adjacent edges to `x`; neighbors untouched; absNumber
  preserved
- leading-edge / trailing-edge drag move only the one edge
- clamp to system bounds; clamp to neighbor window (can't cross siblings)
- `MIN_BAR_W` floor enforced (no zero/negative bars)
- degenerate target → no-op (returns input)
- out-of-range `systemId` / `boundaryIndex` → no-op
- confidence cleared on mutated bars only; `status` → `'draft'`
- closing a pre-existing gap (non-contiguous bars from converter) snaps both
  edges together; the interior tick is read at the right bar's `xStart`

`tapToBar` span-aware contract:
- tap inside a bar span → that bar (unchanged behavior)
- tap in leading clef/margin (before `bars[0].xStart`) beyond `TAP_TOL` → `null`
- tap in trailing blank (after `bars[last].xEnd`) beyond `TAP_TOL` → `null`
- tap within `TAP_TOL` of nearest bar edge → snaps to that bar
- tap in a non-contiguous gap beyond tolerance → `null`
- no bars in the chosen system → `null` (unchanged)

Report test-count delta on the PR. Interaction layer is React/DOM (no jsdom in
this repo) so the gizmo wiring is validated by the helper tests + manual UAT,
consistent with how the band-resize gizmo was covered.

## Out of scope (explicit)

- CV snap-to-printed-line (#2) — separate doc; this is its manual fallback.
- Adding/removing individual bars by drag (count stepper owns cardinality).
- Cross-system / multi-page boundary drags.
- Roadmap Builder (#3).
