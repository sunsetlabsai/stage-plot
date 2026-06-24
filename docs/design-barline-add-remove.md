# Design — Add / Remove a Barline (local cardinality edit)

Status: DESIGN — REVISED for Codex R1 (3 blocking folded). Build-on-GO only.
**Decisions 2/3/5 changed** (union merge edge + deterministic edge-aware roadmap
remap, replacing the original prune-only). Decisions 3/5 were signed off earlier
under the prune-only model → **Graham re-confirm needed** before build.
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
`renumberBars(...)` for the absNumber cascade (identical to
`autoDistributeBars`/`removeSystem`, `chart-calibration.ts:378-387`). For the
roadmap they add **one** small edge-aware remap step **before** the existing
`pruneRoadmap(...)`, so prune only ever drops genuinely-orphaned markers (below).

### Roadmap marker model — why remap is deterministic (REVISED, supersedes prune-only)

Every bar-referencing marker carries an explicit **edge** (`lib/types.ts:110-132`):

- **start-edge** (`edge: 'start'`): `repeatStart`, `segno`, `coda` — anchored at
  `bar.xStart`.
- **end-edge** (`edge: 'end'`): `repeatEnd`, `toCoda`, `fine`, `jump` — anchored
  at `bar.xEnd`.
- **`ending`**: a volta bracket over a contiguous `barIds[]` set (no single edge).
- Cross-references (`repeatEnd.repeatStartId`, `ending.repeatStartId`) point at a
  **marker id**, not a bar id, so they are untouched by bar remap and survive as
  long as their `repeatStart` survives.

Because each marker's anchor (`barId` + `edge`) maps to a concrete x-position, a
cardinality edit can compute **deterministically** whether that x-position still
exists after the edit, and on which surviving bar:

- A position that **survives** → rewrite the marker's `barId` to the survivor
  (keep the marker, identical x).
- A position that **vanishes** (it sat exactly on a removed barline) → drop it
  (`pruneRoadmap`, with dependent cascade) — and **warn first**.

This is strictly better than blanket prune-by-bar-id (the original v1): it loses
**only** the markers whose anchor line literally disappears, never a marker whose
anchor x is preserved on a neighbour. A tiny pure helper
`remapRoadmapForBarEdit(roadmap, edits)` does the rewrite; `pruneRoadmap` then
cascades anything still orphaned. (Original prune-only v1 is recorded under
Decisions 3/5 as the rejected alternative.)

#### `removeBarline(cal, systemId, boundaryIndex)`

Let `L = bars[k-1]`, `R = bars[k]`. The removed barline is the **shared edge**
between them (`L.xEnd ≈ R.xStart`).

1. Resolve the system's bars in reading order. **No-op** (return input identity)
   if: system missing, `N < 2`, `boundaryIndex` not an integer in `1..N-1`.
2. Merge into one measure that keeps `L`'s id/`sectionId`/absNumber slot and
   spans the **union** of both bars:
   `merged = { ...L, xEnd: Math.max(L.xEnd, R.xEnd) }`. Drop `R`.
   - The **union edge** (`max`, not `R.xEnd`) is required: with an overlapping
     converter input like `L=[0, .9]`, `R=[.4, .5]`, plain `R.xEnd` would
     **shrink** the merged bar to `[0, .5]` and silently delete real width.
     `max` → `[0, .9]`, no geometry lost. (Contiguous input: `max == R.xEnd`,
     unchanged.) [Codex R1 blocking #3]
3. `withoutConfidence(merged)` (manual structural edit → self-clears review
   flag), `status: 'draft'`.
4. `renumberBars([...otherBars, ...nextSysBars], systems)`.
5. **Roadmap (the crux) — edge-aware remap, then prune.** Classify every marker
   bound to `L` or `R` by its anchor x:
   - **`L` start-edge** (anchor `L.xStart = merged.xStart`) → **keep** (stays on
     `L`'s id; position unchanged).
   - **`R` end-edge** (anchor `R.xEnd` → now `merged.xEnd` after union) →
     **remap** `barId: R.id → L.id` (position preserved). [Codex R1 blocking #2's
     mirror: end-anchored work on the right bar is preserved, not lost.]
   - **`L` end-edge** and **`R` start-edge** (both anchor the **removed** barline)
     → **drop** (their line no longer exists) → these are the only losses, and
     the **warn** below enumerates exactly them. [Codex R1 blocking #2: the
     original missed `L`'s end-edge markers entirely.]
   - **`ending` whose `barIds` contains `R.id`** → rewrite `R.id → L.id` and
     **dedupe** (if the bracket spanned both halves it collapses to one entry);
     the bracket's bar set is otherwise unchanged.
   - Apply via `remapRoadmapForBarEdit`, then `pruneRoadmap(roadmap, liveIds)` to
     **cascade** dependents (e.g. a `repeatEnd`/`ending` whose `repeatStart` was
     dropped). `liveIds` excludes `R.id`.
   - **Warn-before-destroy:** the UI computes the drop set as a **dry-run of the
     full cascade** (remap → prune) and, if non-empty, warns
     "Removing this barline clears N navigation marker(s)" before applying. Only
     markers anchored *on the removed line* (plus their cascade) are ever lost.
   - *Rejected alternative (original v1): prune every marker on both `L` and `R`.*
     That needlessly destroyed end-edge work on `R` (whose x survives) and — per
     Codex — silently mis-anchored `L`'s end-edge markers to the merged far edge.
     The `edge` field makes the precise remap above deterministic, so prune-only
     is strictly worse and is dropped.

#### `addBarline(cal, systemId, x)`

1. Resolve the system's bars. **No-op identity** if: system missing, or `x`
   (page-normalized) lies in **no** bar's `[xStart, xEnd]` span — a tap in the
   clef margin, trailing blank, or a gap has no measure to split (matches the
   span-aware `tapToBar` philosophy from #94; "extend a bar into blank" is a
   different op, out of scope).
2. Let `bar` be the containing measure. **No-op** if the split would leave either
   half below `MIN_BAR_W` (`x − bar.xStart < MIN_BAR_W` or
   `bar.xEnd − x < MIN_BAR_W`) — a split needs room for two real measures.
3. Split: `left = { ...bar, xEnd: x }` (keeps the parent id, `left.xStart =
   bar.xStart`), `right = { id: crypto.randomUUID(), systemId, xStart: x,
   xEnd: bar.xEnd, sectionId: bar.sectionId, absNumber: 0 }`. Both halves inherit
   the parent's `sectionId`. `withoutConfidence` on both; `status: 'draft'`.
4. `renumberBars(...)` assigns absNumbers by position (the new bar slots in).
5. **Roadmap — edge-aware remap (fully non-destructive, deterministic).** The
   parent measure `bar` becomes `left ∪ right`; `left.xStart == bar.xStart` and
   `right.xEnd == bar.xEnd`, so **both** original anchor positions survive. For
   each marker on `bar.id`:
   - **start-edge** (anchor `bar.xStart = left.xStart`) → **keep** on the parent
     id (now `left`). Position unchanged.
   - **end-edge** (anchor `bar.xEnd = right.xEnd`) → **remap** `barId →
     right.id`. Position unchanged. [Codex R1 blocking #1: the original left the
     end-edge marker on `left`, rendering it one measure early — the false
     "non-destructive" claim. Remap fixes it exactly.]
   - **`ending` whose `barIds` contains `bar.id`** → insert `right.id` adjacent to
     `bar.id` so the bracket still spans the (now two) measures it covered.
   - `pruneRoadmap` after remap drops **nothing** (every id still live: `bar.id`
     on `left`, `right.id` on `right`). Add is genuinely non-destructive — no warn
     needed. Same `remapRoadmapForBarEdit` helper as remove.

## Interaction (`app/[owner]/[show]/page.tsx`, Bars tool, system selected)

The Bars tool gains a small mode model; **drag (move) stays the default**:
- **Remove:** tapping a barline tick (a discrete tap, distinct from the #94
  drag) **selects** it and reveals a small "✕ Remove barline" affordance (mirror
  the section-marker delete UX). The control computes the drop set as a
  **dry-run of the full remap→prune cascade** (only markers anchored *on the
  removed line*, plus dependents); if non-empty it warns first ("Removing this
  barline clears N navigation marker(s)") and removes on confirm. Markers anchored
  on a surviving edge (e.g. an end-edge marker on the right bar) are silently
  remapped, **not** counted in the warn. Calls `removeBarline(systemId, index)`.
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
2. **Merge keeps the LEFT bar's id/section**, extends its `xEnd` to the
   **union** `max(L.xEnd, R.xEnd)` (not `R.xEnd`). Recommend **yes** — union is
   required so an overlapping converter input doesn't lose width. [was: plain
   `R.xEnd`; changed per Codex R1 blocking #3.]
3. **CHANGED (supersedes prior "prune + warn, remap deferred").** Roadmap on
   remove = **edge-aware remap, then prune + warn.** The `edge` field makes the
   remap deterministic, so we keep `R`'s end-edge markers (x survives) and drop
   **only** markers anchored *on the removed line* (`L`-end + `R`-start), with a
   dry-run warn. Recommend **yes** — strictly better than prune-only (loses less,
   no ambiguity). Original prune-only kept as the rejected alternative.
   **→ This changes the decision Graham signed off; needs his re-confirm.**
4. **Add splits only inside an existing measure**; tap in blank/margin = no-op
   (not "create a bar in empty space"). Recommend **yes**.
5. **CHANGED (supersedes prior "non-destructive, end-anchor remap deferred").**
   Add = **fully non-destructive via edge-aware remap**: start-edge markers stay
   on the left half, end-edge markers remap to the right half (both anchor
   positions survive the split), `ending` brackets extend to include the new bar.
   Nothing is dropped; no known-limitation, no warn. Recommend **yes** — this is
   what "non-destructive" should have meant. [Codex R1 blocking #1.]
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
- **roadmap remap (the fix):**
  - a **start-edge** marker (`repeatStart`/`segno`/`coda`) on the parent stays on
    the parent id (left half), `barId` unchanged
  - an **end-edge** marker (`repeatEnd`/`toCoda`/`fine`/`jump`) on the parent is
    **remapped** to the right half's new id (NOT left); its anchor x equals
    `bar.xEnd == right.xEnd`
  - an `ending` whose `barIds` contained the parent now contains BOTH halves'
    ids; bracket still contiguous
  - **nothing pruned** — pruned set unchanged, no markers lost (regression guard
    against the old "stays on left, one bar early")

`removeBarline`
- merge interior boundary k → one measure `[L.xStart, max(L.xEnd, R.xEnd)]`,
  count N→N−1, neighbors untouched, renumbered
- **union edge:** overlapping input `L=[0,.9]`, `R=[.4,.5]` → merged `[0,.9]`
  (NOT `[0,.5]`); plain-`R.xEnd` regression guard [Codex blocking #3]
- merge closes a pre-existing gap at that boundary (contiguous result)
- boundary `0` or `N` → no-op identity; `N < 2` → no-op identity
- non-integer / out-of-range index, unknown systemId → identity
- **roadmap remap + prune (the crux):**
  - an **end-edge** marker on `R` (anchor `R.xEnd`) is **remapped** to `L`'s id
    and KEPT (its x survives as `merged.xEnd`) — NOT pruned [Codex blocking #2's
    win: right-bar end work preserved]
  - a **start-edge** marker on `L` (anchor `L.xStart`) is KEPT on `L` unchanged
  - an **end-edge** marker on `L` AND a **start-edge** marker on `R` (both anchor
    the **removed** line) are **pruned** — and counted by the dry-run warn
    [Codex blocking #2: left-bar end markers must be handled, not missed]
  - an `ending` with `R.id` in `barIds` → `R.id` rewritten to `L.id`, deduped
  - **cascade:** pruning a `repeatStart` (anchored on the removed line) also
    prunes its dependent `repeatEnd`/`ending` (parity with
    `autoDistributeBars`/`removeSystem`)
  - dry-run drop set = exactly the on-the-line markers + cascade; markers on
    surviving edges are absent from it
- merged bar: confidence cleared, status draft

Report test-count delta on the PR.

## Out of scope (explicit)

- Detecting where to add/remove from the image — that's CV snap's count flag +
  the human; this is the manual primitive it routes to.
- Moving a barline (that's #94 `moveBarBoundary`).
- Changing the system band extent (that's `resizeSystemBand`).
- Cross-system / multi-page barline operations.
