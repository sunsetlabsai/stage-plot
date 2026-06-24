# Design — Add / Remove a Barline (local cardinality edit)

Status: DESIGN — awaiting Graham sign-off, then Codex. Build-on-GO only.
Scope: ONE focused gap surfaced in #94 UAT — locally **add** or **remove** a
single barline without re-distributing the whole system. Completes the manual
barline edit set; pairs with CV snap (`docs/design-cv-barline-snap.md`) as its
count-mismatch reconciliation. Does NOT touch the converter VLM or the Roadmap
Builder.

## Why this exists

PR #94 made barline **positions** editable (drag a tick). But **cardinality**
— how many bars — is still owned solely by the count stepper
(`autoDistributeBars`), which is **all-or-nothing**: changing the count throws
away every bar for the system and re-spaces them **evenly**
(`chart-calibration.ts:358-376`), wiping every manual nudge and CV snap.

Graham's UAT verdict: if the count is off — wrong VLM extraction, a missed or
phantom barline, a pickup/partial measure — you're stuck. Too many or too few
markers, and the only "fix" (the stepper) nukes all the alignment work you just
did. The result is "messy, near-unusable." The same bites CV snap: when detected
lines ≠ bar count, there's no non-destructive way to reconcile.

The missing primitive is a **local, non-destructive cardinality edit**:
- **Remove** a barline → merge the two measures it divides into one (N → N−1).
- **Add** a barline → split one measure into two at a chosen x (N → N+1).

Every other bar's position is preserved. This completes the edit set and demotes
the stepper to a one-time **rough-in**:

```
count stepper        rough-in: set ~N, even spacing (destructive reset)
   ├─ move  (#94)    drag a barline to the printed line
   ├─ add   (this)   split a measure  → N+1, neighbors untouched
   └─ remove(this)   merge two measures → N-1, neighbors untouched
```

## The model

Same boundary model as #94 (N bars in reading order → N+1 boundaries; tick `0` =
`bars[0].xStart`, tick `k` = `bars[k].xStart`, tick `N` = `bars[N-1].xEnd`).

- A **barline** that can be *removed* is an **interior** boundary `1..N-1` — the
  shared edge between two measures. Boundary `0`/`N` are the system's leading and
  trailing **extent**, not dividers; "removing" them is a band resize, not a
  cardinality op, so they're out of range here.
- A barline is *added* by **splitting** the measure that contains the target x.

### Pure helpers (new, in `lib/chart-calibration.ts`, beside `moveBarBoundary`)

```ts
// Remove an interior barline: merge bars[k-1] and bars[k] into one measure.
removeBarline(cal: ChartCalibration, systemId: string, boundaryIndex: number): ChartCalibration

// Add a barline: split the measure containing page-x `x` into two at `x`.
addBarline(cal: ChartCalibration, systemId: string, x: number): ChartCalibration
```

Both pure, immutable, node-unit-testable (no DOM). Both reuse the existing
`renumberBars(...)` + `pruneRoadmap(...)` machinery so the bar-cardinality
cascade behaves **identically** to `autoDistributeBars`/`removeSystem`
(`chart-calibration.ts:378-387`, `384-386`) — there is one renumber path and one
roadmap-integrity path.

#### `removeBarline(cal, systemId, boundaryIndex)`

1. Resolve the system's bars in reading order. **No-op** (return input identity)
   if: system missing, `N < 2`, `boundaryIndex` not an integer in `1..N-1`.
2. Merge: `merged = { ...bars[k-1], xEnd: bars[k].xEnd }` — keep the **left**
   bar's id, `sectionId`, and absNumber slot; extend its right edge to the right
   bar's. Drop `bars[k]`. (Contiguous result by construction; if the input had a
   gap/overlap at that boundary the merge closes it, consistent with #94.)
3. `withoutConfidence(merged)` (manual structural edit → self-clears review
   flag), `status: 'draft'`.
4. `renumberBars([...otherBars, ...nextSysBars], systems)`.
5. **Roadmap cascade (the crux):** the right bar's id vanishes, so
   `pruneRoadmap(cal.roadmap, liveIds)` drops any marker that referenced it —
   **identical** to today's bar-deletion cascade. A removed barline that carried
   repeat/volta/nav markers therefore clears those markers. That is correct
   behavior (the structure those markers described no longer exists), but it is
   **destructive of roadmap work**, so the UI must **warn before** a remove that
   would drop markers (below). v1 = prune, not remap.
   - *Considered and deferred:* remapping the dropped bar's markers onto the
     merged bar. Rejected for v1 — edge semantics are ambiguous (a `repeatEnd`
     at the removed line vs at the far edge mean different things) and remap can
     manufacture duplicate markers. Prune + warn is safe and honest; revisit if
     real use shows the loss is painful.

#### `addBarline(cal, systemId, x)`

1. Resolve the system's bars. **No-op identity** if: system missing, or `x`
   (page-normalized) lies in **no** bar's `[xStart, xEnd]` span — a tap in the
   clef margin, trailing blank, or a gap has no measure to split (matches the
   span-aware `tapToBar` philosophy from #94; "extend a bar into blank" is a
   different op, out of scope).
2. Let `bar` be the containing measure. **No-op** if the split would leave either
   half below `MIN_BAR_W` (`x − bar.xStart < MIN_BAR_W` or
   `bar.xEnd − x < MIN_BAR_W`) — a split needs room for two real measures.
3. Split: `left = { ...bar, xEnd: x }`, `right = { id: crypto.randomUUID(),
   systemId, xStart: x, xEnd: bar.xEnd, sectionId: bar.sectionId, absNumber: 0 }`.
   Both halves inherit the parent's `sectionId`. `withoutConfidence` on both;
   `status: 'draft'`.
4. `renumberBars(...)` assigns absNumbers by position (the new bar slots in).
5. **Roadmap cascade:** the parent id survives on the **left** half, so
   `pruneRoadmap` drops nothing — add is **non-destructive** to the roadmap. Any
   marker on the parent stays bound to the left half. *Known limitation:* an
   end-anchored marker (e.g. `repeatEnd`) that conceptually belonged at the
   measure's far edge now renders at the new split line (the left half's end),
   one measure early. v1 leaves it on the left for the user to re-place; the
   per-kind edge-aware remap (end-anchored → right half) is a noted deferral.
   Flagged for Codex.

## Interaction (`app/[owner]/[show]/page.tsx`, Bars tool, system selected)

The Bars tool gains a small mode model; **drag (move) stays the default**:
- **Remove:** tapping a barline tick (a discrete tap, distinct from the #94
  drag) **selects** it and reveals a small "✕ Remove barline" affordance (mirror
  the section-marker delete UX). If that boundary's two bars carry roadmap
  markers, the control warns first ("Removing this barline clears N navigation
  marker(s)") and removes on confirm. Calls `removeBarline(systemId, index)`.
- **Add:** an **"＋ Add barline"** toggle; while active, a tap inside the band
  drops a new barline at the tap x by splitting that measure
  (`addBarline(systemId, x)`). The new tick is immediately #94-draggable and
  CV-snappable for fine alignment. Tap in a blank/margin = no-op (nothing to
  split), with the same inline hint pattern as snap.
- These compose cleanly with #94 (drag the new/merged edges) and CV snap
  (reconcile a flagged count delta, then re-snap). Interaction-layer UI is
  React/DOM (no jsdom here) → covered by manual UAT + the pure helper tests,
  same posture as the #94 gizmo.

## Relationship to the count stepper and CV snap

- **Stepper = rough-in only.** Set an approximate N once; thereafter use
  add/remove to adjust **without** re-distributing. Re-running the stepper still
  wipes the system (intentional "reset this system" escape hatch, unchanged from
  #94 §"Relationship to auto-distribute").
- **CV snap reconciliation.** When snap flags "M detected lines vs N bars"
  (`design-cv-barline-snap.md`, Count mismatch), the user **adds** a barline
  where a real line went unmatched, or **removes** a phantom one, then re-snaps —
  the non-destructive path snap relies on.

## Decisions to confirm (Graham)

1. **Remove range = interior boundaries only** (`1..N-1`); leading/trailing are
   band-extent, not dividers. Recommend **yes**.
2. **Merge keeps the LEFT bar's id/section**, extends its `xEnd`. Recommend
   **yes** (arbitrary-but-stable; the left measure "absorbs" the right).
3. **Roadmap on remove = prune + warn (v1)**, remap deferred. Recommend **yes**
   (safe, honest, matches existing cascade). The warn-before-destroy is the
   important UX guard.
4. **Add splits only inside an existing measure**; tap in blank/margin = no-op
   (not "create a bar in empty space"). Recommend **yes**.
5. **Add is non-destructive to roadmap** (markers stay on the left half);
   end-anchored remap deferred with a known-limitation note. Recommend **yes**.
6. **`MIN_BAR_W` floor reused** for the minimum split half. Recommend **yes**.
7. **Both clear confidence + set draft** (structural manual edit), consistent
   with `moveBarBoundary`. Recommend **yes**.

## Test plan (builder writes tests — pure helpers)

`tests/chart-calibration.test.ts` (extend):

`addBarline`
- split a measure at interior x → two bars, exact widths, neighbors untouched,
  count N→N+1, `absNumber` renumbered in reading order
- both halves inherit parent `sectionId`; confidence cleared on both; draft
- x in the clef margin / trailing blank / a gap → no-op **identity** (`toBe`)
- split leaving a sub-`MIN_BAR_W` half (either side) → no-op identity
- unknown systemId → identity
- roadmap: a marker on the parent stays bound to the (left) survivor; pruned set
  unchanged

`removeBarline`
- merge interior boundary k → one measure `[bars[k-1].xStart, bars[k].xEnd]`,
  count N→N−1, neighbors untouched, renumbered
- merge closes a pre-existing gap/overlap at that boundary (converter input)
- boundary `0` or `N` → no-op identity; `N < 2` → no-op identity
- non-integer / out-of-range index, unknown systemId → identity
- **roadmap cascade:** a marker on the dropped (right) bar is pruned; a marker on
  a surviving bar is kept (parity with `autoDistributeBars`/`removeSystem`)
- merged bar: confidence cleared, status draft

Report test-count delta on the PR.

## Out of scope (explicit)

- Detecting where to add/remove from the image — that's CV snap's count flag +
  the human; this is the manual primitive it routes to.
- Remapping roadmap markers across a merge/split (per-kind edge semantics) —
  deferred (decisions 3, 5).
- Moving a barline (that's #94 `moveBarBoundary`).
- Changing the system band extent (that's `resizeSystemBand`).
- Cross-system / multi-page barline operations.
