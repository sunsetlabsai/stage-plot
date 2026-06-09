# Nav graph — repeats, endings, D.S./D.C./Coda/Fine (chunk 4 mini-spec)

**Status:** DESIGN — awaiting Codex cross-check + Graham sign-off **before any build.**
**Parent:** `design-realtime-chart-control.md` (resolves its OQ #3 + the "Navigation
(logic)" layer at §162-168). **Builds on:** the *merged* calibration editor
(chunks 1-3, main `162e65d`) — `System`/`Bar`/`PositionRef`, hash-keyed sidecar,
fail-closed GET (load-bearing here — see §Schema bump).

---

## 1. The problem this solves

Today (chunks 1-3) the Perform redline walks `barsInOrder` **linearly** — bar 1, 2,
3 … n, once each. Real charts are non-linear: repeats, 1st/2nd endings, D.S., D.C.,
Coda, Fine. The redline must follow the **played** order, e.g. *"1-8, 1-8, 9-16,
back to Segno, 5-8, jump to Coda."* This is the "jump back to repeat" capability —
the meat. It is **orthogonal to who authors it** (human now, converter later both
write the *same* model — see `design-realtime-chart-control.md` §Conversion).

## 2. Core modeling decision: **markers + a resolver**, not a hand-built edge graph

Three options were weighed:

| | Store | Pro | Con |
|---|---|---|---|
| **A. Roadmap markers** (chosen) | the printed symbols (`|: :|`, voltas, 𝄋, ⊕, D.S., Fine) attached to bars | matches the page 1:1; converter detects glyphs → markers; musician edits symbols they know | needs a resolver for jump semantics |
| B. Explicit edge graph | nodes=bars, conditional "next" edges | fully general | unintuitive to author; can build contradictory/cyclic graphs; converter must synthesize edges |
| C. Pre-linearized timeline | the fully expanded `(barId,pass)` list | trivial to consume | loses structure (can't re-edit a repeat *as* a repeat); brittle to bar edits; huge |

**Decision: store A (markers); derive C (the linear traversal) via a pure resolver.**
The "directed graph" framing in the parent doc is the *conceptual* model the resolver
realizes — we persist the markers, not the graph.

```
resolveRoadmap(bars, markers) → { traversal: Array<{ barId, pass }> }
                              |  { error: RoadmapError }   // markerId(s) + reason
```

- **The redline consumes `traversal`** (an ordered list of `(barId, pass)` = exactly
  `PositionRef` fine-form). `pass` = 1-based count of entries into that bar.
- **`resolveRoadmap` IS the validator.** Any contradictory roadmap returns a
  `RoadmapError` → that element can't promote to `verified` → Perform never drives a
  broken roadmap. This *reuses the existing promotion invariant* (parent §249-251):
  a traversed roadmap element is "required"; unresolvable ⇒ blocks `verified` unless
  the human **disables** the offending jump (→ becomes a `holdPoint`, redline parks
  for manual seek). No new gate concept — the resolver feeds it.

This unifies consume + validate in one pure function. Empty markers ⇒ traversal =
linear `barsInOrder` (identity) ⇒ **today's behavior is the degenerate case** (clean
back-compat).

## 3. Marker set

Markers attach to a **bar edge** (`start` | `end` of a referenced bar). One list on
the calibration: `roadmap?: RoadmapMarker[]`.

```ts
type RoadmapMarker =
  | { id; kind: 'repeatStart'; barId; edge: 'start' }
  | { id; kind: 'repeatEnd';   barId; edge: 'end'; times?: number }   // default 2 (play 2×); 3 = play 3×
  | { id; kind: 'ending';      barIds: string[]; numbers: number[] }  // volta over a bar range; e.g. [1] or [2,3]
  | { id; kind: 'segno';       barId; edge: 'start' }                 // 𝄋 target
  | { id; kind: 'coda';        barId; edge: 'start' }                 // ⊕ jump-to target
  | { id; kind: 'toCoda';      barId; edge: 'end' }                   // "To Coda" departure
  | { id; kind: 'fine';        barId; edge: 'end' }                   // end point for al Fine
  | { id; kind: 'jump';        barId; edge: 'end';
      from: 'capo' | 'segno';                                         // D.C. vs D.S.
      until: 'end' | 'fine' | 'coda' };                              // plain | al Fine | al Coda
// every marker also carries optional `confidence?: number` (converter populates later — forward-compat, no future bump)
```

Notes:
- **D.C. = `{jump, from:'capo'}`**, **D.S. = `{jump, from:'segno'}`**. `until`
  encodes *al Fine* / *al Coda* / plain in one field — no combinatorial kinds.
- **Voltas reference a bar *range*** (`barIds`), not a single edge — a 1st ending is
  usually several bars.
- At most **one** `segno`, **one** `coda`, **one** `fine` in v1 (labeled multiples
  = OQ-A below).

## 4. Resolver semantics (the VM walk)

Walk bars in `absNumber` order; markers perturb the cursor. State:
- per-`repeatEnd`: a pass counter (entries through that end).
- per-`jump` marker: a **fired** flag (each D.C./D.S. fires **at most once**).
- `alFineActive`, `alCodaArmed` flags.
- per-bar `pass` = entries into that bar (what the traversal records).

Rules, in priority order at each bar edge:
1. **Volta (ending) selection.** On entering a bar inside a volta group: let *k* =
   the pass of the **innermost enclosing repeat**. Take the ending whose `numbers`
   include *k*; **skip** the others (cursor jumps past skipped voltas to the next
   ending or past the group). Endings must **partition** the repeat's passes (no gap,
   no overlap — see rejection §5).
2. **`repeatEnd`.** If its counter < `times` and not currently exiting via a volta
   that ends the repeat: increment counter, **jump back** to the matching
   `repeatStart` (most-recent unclosed; or piece start if none). Else fall through.
3. **`jump` (D.C./D.S.), bar `end`, not yet fired:** set `fired`; set
   `alFineActive` if `until==='fine'`, arm `alCodaArmed` if `until==='coda'`; jump to
   piece start (`from==='capo'`) or `segno` (`from==='segno'`). On the **return pass**
   the marker is fired ⇒ ignored (the classic "second time, don't repeat" behavior).
4. **`toCoda`, bar `end`, `alCodaArmed`:** jump to the `coda` target. (Before any al
   Coda jump fires, `toCoda` is inert — passed straight through.)
5. **`fine`, bar `end`, `alFineActive`:** **stop** (traversal ends here).
6. Otherwise advance to the next bar in `absNumber` order. **Stop** at end of bars.

**Termination guard (backstop):** cap traversal length at `Σ repeatEnd.times × bars
+ K` (K small). Exceeding the cap ⇒ `RoadmapError('does not terminate')`. Catches any
pathological cycle the per-marker `fired`/counter logic missed.

### Worked examples (must be in the resolver test suite)
- **Simple repeat:** `|: 1-8 :|` (times 2) → `1..8, 1..8`.
- **1st/2nd/3rd endings:** `|: 1-4 [1]5-6 [2]7-8 [3]9-10 :|` (times 3) →
  `1-4,5-6(p1), 1-4,7-8(p2), 1-4,9-10(p3)`.
- **D.S. al Coda al Fine interaction** (the OQ#3 nasty): `𝄋` at bar 5, `To Coda` at
  bar 12 end, `⊕` Coda at bar 20, `Fine` at bar 16 end, `D.S. al Coda` at bar 16 end.
  → play 1..16, jump to bar 5 (arm Coda), 5..12, jump to Coda (bar 20), 20..end.
  (`Fine` is *not* taken because this is *al Coda*, not *al Fine* — `alFineActive`
  stays false; the resolver's flag separation makes this unambiguous.)
- **Nested repeats:** outer `|: 1-16 :|` containing inner `|: 5-8 :|` → inner pass
  counter is independent of outer; verifies rule-1 "innermost enclosing repeat."

## 5. Contradictory-roadmap rejection (the resolver's error set)

`RoadmapError { markerIds: string[]; reason }` for:
1. **`jump from:'segno'` with no `segno`** / **`until:'coda'` with no `coda` target or
   no `toCoda` departure** / **`toCoda` with no `coda`** / **`until:'fine'` with no
   `fine`** — the jump can't resolve.
2. **Multiple `segno` / `coda` / `fine`** — ambiguous target (v1; see OQ-A).
3. **Volta passes don't partition** — two endings claim the same pass (overlap), or a
   repeat pass has no ending (gap) ⇒ redline would have nowhere to go.
4. **Non-termination** — exceeds the length cap (§4 backstop).
5. **Dangling FK** — `barId`/`barIds` references a non-existent bar (also caught
   structurally — §7).

Lone `repeatStart` (no matching end) = **non-required warning** (no-op, cosmetic).
Lone `repeatEnd` = **legal** (repeats to piece start — valid notation).

## 6. Consumption change (Perform / chunk 2 renderer)

Additive, small:
- When a **verified** calibration has a resolvable `roadmap`, Perform walks the
  **traversal** instead of raw `barsInOrder`. `firstBar/nextBar/prevBar` become
  first/next/prev **traversal step** (`{barId,pass}`); page auto-turn follows the
  target bar's `system.page` exactly as today.
- Transport readout shows the pass when `pass>1`: **"Bar 12 · 2nd."**
- No roadmap (or empty) ⇒ identical to today (linear). This is the back-compat floor.
- A **draft** roadmap is never consumed (existing gate). An *unresolvable* roadmap
  can't reach `verified` (§2). So Perform only ever walks a verified, resolvable
  traversal — **never a broken roadmap.**

## 7. Validator + mutation impacts (fail-closed at the DB boundary)

- **`isValidCalibration`** gains, inside the bars/roadmap block: (a) every
  `marker.barId`/`barIds` FK-checks to an existing bar; (b) roadmap only valid when
  `bars` is non-empty; (c) **run `resolveRoadmap`; if it errors, the calibration is
  invalid.** This mirrors the absNumber-contiguity check we just added — a hand-edited
  DB row with a broken roadmap is rejected at GET, so Perform can't be driven off it.
- **Cascade pruning:** `removeSystem` / bar deletion must prune `roadmap` markers
  whose bars vanish (same pattern as `Bar.sectionId` cascade today). Renumbering bars
  (`resizeSystemBand` etc.) leaves markers intact (they key on `barId`, not
  `absNumber`) but the *resolved order* recomputes — fine, the resolver is pure.

## 8. Schema bump → **schemaVersion 3** (and why finding-1's gate makes it safe)

`roadmap` is additive like `systems`/`bars`, **but** a v2-only reader that *ignores*
`roadmap` would drive the **wrong (linear)** redline over a chart that has a roadmap
— "confidently wrong," the worst failure mode (parent §246). So **roadmap presence
forces `CALIBRATION_SCHEMA_VERSION → 3`:**
- `rowToCalibration` upgrades v1/v2 → 3 trivially (`roadmap` undefined = linear).
- A roadmap-bearing **v3** served to an **old v2 build** → that build's GET gate
  (the HIGH fix we just shipped: `schemaVersion !== CALIBRATION_SCHEMA_VERSION` ⇒ 404)
  **rejects it** rather than mis-driving it. The fail-closed gate is *load-bearing*
  here — this is exactly the case it was built for.
- **Deploy order:** ship+deploy the chunk-4 build (v3-aware) **before** any v3
  calibration is authored. Drafts are safe regardless (Perform ignores drafts).

## 9. Authoring UI (build, but design-locked now)

Third calibrate tool: **Sections | Bars | Roadmap.** In Roadmap tool, tap a bar edge
→ marker palette (repeat barlines, volta bracket w/ number entry, 𝄋, ⊕, To Coda,
D.S./D.C. w/ al-Fine/al-Coda choice, Fine). **Live resolve:** as markers change, run
`resolveRoadmap` and show inline either the play order ("plays: 1-8, 1-8, 9-16") or
the error ("✕ D.S. has no Segno"). Verify-by-playback (chunk 5) scrubs this traversal.
Manual now; converter pre-fills with confidence later (review queue surfaces
low-confidence jumps) — **same markers, same resolver.**

## 10. Build outline (after sign-off)
1. Types + `resolveRoadmap` + `RoadmapError` (pure, exhaustively tested — §4/§5
   examples are the suite). Schema → 3, `rowToCalibration` upgrade, validator +
   cascade. *(Foundational piece-parts — unit-tested; gated commit.)*
2. Perform consumption swap (traversal walk + pass readout). *(Gated commit.)*
3. Roadmap authoring tool + live-resolve UI. *(Gated commit.)*
4. Merge as one coherent unit (per the branch convention). UAT after chunk 5 (or 4 —
   Graham's open call), since real testing needs the converter's auto-overlay anyway.

## 11. Open questions for Codex / Graham
- **OQ-A (labeled multiples):** v1 allows one `segno`/`coda`/`fine`; multiple = error.
  Real charts occasionally have *Coda I / Coda II* or two segnos. Accept the v1 limit
  (labeled-target extension later, no bump — markers already carry `id`)?
- **OQ-B (nested-volta binding):** voltas bind to the **innermost** enclosing repeat's
  pass counter. Confirm this matches musician expectation (it's the rare case OQ#3
  flagged).
- **OQ-C (cache vs recompute):** persist **markers only**, recompute `traversal` on
  load (pure, cheap, never stale) — *not* denormalizing the expanded list. Confirm.
- **OQ-D (schema bump):** `→ 3` + deploy-order story (§8). Confirm acceptable (vs.
  keeping 2 and risking a linear mis-drive on old builds — rejected).
- **OQ-E (temporal entanglement):** chunk 4 is **order only**; the temporal layer
  (parent §228, nullable tempo / hold points) still clocks *motion*. Confirm we keep
  them separate — a `holdPoint` can sit on any traversal step, and `pass` doesn't
  change beats-per-bar.
