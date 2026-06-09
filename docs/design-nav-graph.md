# Nav graph — repeats, endings, D.S./D.C./Coda/Fine (chunk 4 mini-spec)

**Status:** DESIGN **SIGNED OFF & BUILD-READY** — Codex R1/R2/R3 clear (R3 "green for
build"); Graham OQ-A..E resolved (§11). Build per §10 (3 gated commits, feature-branch
PR). Earlier Codex rounds landed on `main` (`beadf8b..bcc98c8`); sign-off via PR #80.
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
- **Two distinct validity gates — do NOT conflate them** (the trap Codex caught):
  - **Structural validity (`isValidCalibration`)** = shape + FK + `absNumber`
    contiguity + marker FK + "roadmap only with bars." **Does NOT run the resolver.**
    A *draft* mid-edit (e.g. D.S. dropped before its Segno) is **structurally valid →
    persists and reloads fine.** Authoring is never blocked by a temporary
    contradiction. Used by **PUT (draft save)** and the owner branch of **GET**.
  - **Promotion / performability validity (`resolveRoadmap` succeeds)** = the
    *additional* gate for `draft → verified` (`canVerify`) **and** for serving a
    calibration to Perform (`isPerformable`). A roadmap that doesn't resolve **cannot
    be verified** and is **never served to a non-owner** — so Perform never drives a
    broken roadmap — but the owner still gets the draft back to fix it.
  - This is exactly the existing **promotion invariant** (parent §249-251): a
    traversed roadmap element is "required"; `verified` is permitted only when every
    required element resolves. **No new gate concept — and crucially no
    authoring-time lockout.**
- **Escape hatch in chunk 4 = delete the offending marker** (or fix it). The richer
  "**disable** a jump → it becomes a `holdPoint` where the redline parks for manual
  seek" affordance needs the temporal layer's `holdPoint` representation, which chunk
  4 deliberately leaves separate (§11 OQ-E) — so **disable-as-holdPoint is deferred to
  chunk 5.** For chunk 4, an un-resolvable required jump must be **resolved or
  removed** to verify. (Same invariant, simpler escape hatch for this chunk.)

Empty markers ⇒ traversal = linear `barsInOrder` (identity) ⇒ **today's behavior is
the degenerate case** (clean back-compat).

## 3. Marker set

Markers attach to a **bar edge** (`start` | `end` of a referenced bar). One list on
the calibration: `roadmap?: RoadmapMarker[]`.

```ts
type RoadmapMarker =
  | { id; kind: 'repeatStart'; barId; edge: 'start' }                 // |:  — return target for repeats AND voltas
  | { id; kind: 'repeatEnd';   barId; edge: 'end'; repeatStartId; times?: number }
                                                  // :|  for a PLAIN repeat (no voltas). times = total passes (default 2)
  | { id; kind: 'ending';      repeatStartId; barIds: string[]; numbers: number[] }
                                                  // volta bound to its |: ; barIds = the bracket's bars; e.g. [1] or [2,3]
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
- **Both `repeatEnd` and `ending` bind to a `repeatStart` by id** (`repeatStartId`).
  That binding — not "most-recent-unclosed" guessing — is what makes the back-jump
  target and nesting **explicit and buildable** (Codex BLOCKER 3). The authoring UI
  sets it when you drop the `:|`/volta inside a `|: … :|` span.
- **A repeat is expressed EITHER as a plain `repeatEnd` (with `times`) OR as a volta
  group (`ending` markers) — never both on the same `repeatStart`** (mixing = error,
  §5). With voltas, total passes = `max(union of all numbers)`; no `repeatEnd` needed.
- **D.C. = `{jump, from:'capo'}`**, **D.S. = `{jump, from:'segno'}`**. `until` encodes
  *al Fine* / *al Coda* / plain in one field — no combinatorial kinds.
- **Voltas reference a bar *range*** (`barIds`) — a 1st ending is usually several bars.
  An ending's `barIds` must be **contiguous in `barsInOrder`** (a real bracket spans
  adjacent bars), and within a repeat the endings must be **sorted, non-overlapping,
  with no bar shared across endings** — enforced by the resolver (§5), so the
  "first bar / skip past / past the whole group" walk (§4 rule 1) is deterministic.
- **Span ordering (resolver-checked, §5):** a `repeatStart` must precede its bound
  `repeatEnd` and all its bound `ending` bars in reading order. These are
  performability invariants (not structural), so a half-placed draft still saves.
- At most **one** `segno`, **one** `coda`, **one** `fine` in v1 (labeled multiples
  = OQ-A below).

## 4. Resolver semantics (the VM walk)

Walk bars in `absNumber` order; markers perturb the cursor. State:
- per-`repeatStart`: **`completedPasses`** = number of times its back-jump point has
  been reached (`repeatEnd` or a non-final volta), **starts at 0**.
- per-`jump` marker: a **fired** flag (each D.C./D.S. fires **at most once**).
- `alFineActive`, `alCodaArmed` flags.
- per-bar `pass` = entries into that bar (what the traversal records).

**Exact repeat-counter semantics (Codex BLOCKER 2).** A `repeatStart` is on its
`completedPasses + 1`-th pass. On reaching the back-jump point, **increment
`completedPasses` first, then decide:** jump back **while `completedPasses < times`**;
otherwise fall through. With `times = 2`, `completedPasses` starts 0 → reach end →
becomes 1 → `1 < 2` → jump (now on pass 2) → reach end → becomes 2 → `2 < 2` false →
fall through. **Exactly 2 passes.** (For voltas, `times = max(union of numbers)`.)

**Nested-reset rule (correctness for nested repeats — caught in self-review).** When a
back-jump to `repeatStart` *R* fires, **reset `completedPasses = 0` for every repeat
*nested inside R*** (its `repeatStart` bar lies strictly after *R*'s and at/before *R*'s
back-jump bar). Without this, an inner repeat that completed on outer pass 1 would not
replay on outer pass 2. *R*'s own counter is **not** reset (it is counting *R*'s
passes). `jump` (D.C./D.S.) `fired` flags are **not** reset (a D.S. fires once for the
whole piece).

Rules, in priority order at each bar edge:
1. **Volta (ending) entry-select.** On entering the first bar of a volta group bound
   to repeat *R*: let *k* = `R.completedPasses + 1` (the current pass of *R*). Play
   the `ending` whose `numbers` include *k*; if the cursor is at an ending whose
   numbers **exclude** *k*, **skip forward** past it to the next ending in the group
   (or past the whole group if none remain). Endings must **partition** `1..times`
   (no gap, no overlap — §5).
2. **Volta exit / `repeatEnd`** (the back-jump point):
   - At the **end of a taken volta**: increment `R.completedPasses`; if
     `completedPasses < times` (i.e. higher-numbered endings remain) **jump back** to
     `R`'s `repeatStart`; else this was the final ending → fall through (continue past
     the group).
   - At a plain **`repeatEnd`** (no voltas): increment `repeatStartId`'s
     `completedPasses`; jump back to its `repeatStart` while `< times`, else fall
     through.
3. **`jump` (D.C./D.S.), bar `end`, not yet fired:** set `fired`; set `alFineActive`
   if `until==='fine'`, arm `alCodaArmed` if `until==='coda'`; jump to piece start
   (`from==='capo'`) or the `segno` (`from==='segno'`). On the **return pass** the
   marker is fired ⇒ ignored ("second time, don't repeat").
4. **`toCoda`, bar `end`, `alCodaArmed`:** jump to the `coda` target. (Before any al
   Coda jump fires, `toCoda` is inert — passed straight through.)
5. **`fine`, bar `end`, `alFineActive`:** **stop** (traversal ends here).
6. Otherwise advance to the next bar in `absNumber` order. **Stop** at end of bars.

**Termination guard (backstop — Codex HIGH 4).** The traversal is finite *by
construction* (every repeat completes a finite `times`; every jump fires once), so the
cap only catches **resolver bugs**, never legal length — it must therefore exceed the
**maximal legal** traversal. Two forces inflate length: jumps add ≤ one extra full
pass each (additive), but **nested repeats multiply** (an inner `times` runs in full on
*every* outer pass). A sum-based cap undercounts deep nesting and would false-positive a
legal roadmap, so use a **multiplicative** bound:

```
cap = bars.length
    * Π over all repeats of (times)          // empty product = 1; multiplicative for nesting
    * (jumpMarkers.length + 1)               // each jump can add ≤ one extra traversal
    + K                                      // K small, e.g. 8
```

- Plain D.C./D.S., **no repeats:** `Π = 1`, `(jumps+1) = 2` ⇒ cap `≈ 2 × bars + K`
  (covers the legal out-and-back — the HIGH-4 case).
- Nested `2 × 2`: `Π = 4` ⇒ cap `≈ 4 × bars + K`, safely above the real ~`2.5 × bars`.

Generous on purpose; exceeding ⇒ `RoadmapError('does not terminate')`.

### Worked examples (must be in the resolver test suite)
- **Simple repeat:** `repeatStart@1`, `repeatEnd@8 {repeatStartId, times:2}` →
  `1..8, 1..8`.
- **1st/2nd/3rd endings:** `repeatStart@1`; endings all bound to it —
  `[1] bars 5-6`, `[2] bars 7-8`, `[3] bars 9-10`; `times = max = 3`. The back-jump
  point is the **end of each non-final taken ending**:
  - pass 1: play `1-4`, enter volta group, take `[1]` → `5-6`, exit (completed=1<3) →
    jump to bar 1.
  - pass 2: `1-4`, skip `[1]`, take `[2]` → `7-8`, exit (completed=2<3) → jump to 1.
  - pass 3: `1-4`, skip `[1][2]`, take `[3]` → `9-10`, exit (completed=3, not<3) →
    fall through past the group. → `1-4,5-6, 1-4,7-8, 1-4,9-10`.
- **D.S. al Coda al Fine interaction** (the OQ#3 nasty): `𝄋` at bar 5, `To Coda` at
  bar 12 end, `⊕` Coda at bar 20, `Fine` at bar 16 end, `D.S. al Coda` at bar 16 end.
  → play 1..16, jump to bar 5 (arm Coda), 5..12, jump to Coda (bar 20), 20..end.
  (`Fine` is *not* taken because this is *al Coda*, not *al Fine* — `alFineActive`
  stays false; the resolver's flag separation makes this unambiguous.)
- **Plain D.C. (no repeats):** `D.C.@end-of-bar-16` (`from:'capo', until:'end'`),
  bars 1..16 → `1..16, 1..16` then stop. (Confirms the termination cap must allow
  ~`2 × bars` even with zero `repeatEnd` markers — HIGH 4.)
- **Nested repeats:** outer `repeatStart@1` + `repeatEnd@16 {times:2}` containing inner
  `repeatStart@5` + `repeatEnd@8 {times:2}`. Each repeat's `completedPasses` is keyed
  by its own `repeatStartId` (independent) → the inner repeat fully expands on *every*
  outer pass: `1-4, 5-8,5-8, 9-16,  1-4, 5-8,5-8, 9-16`.

## 5. Contradictory-roadmap rejection (the resolver's error set)

`RoadmapError { markerIds: string[]; reason }` for:
1. **`jump from:'segno'` with no `segno`** / **`until:'coda'` with no `coda` target or
   no `toCoda` departure** / **`toCoda` with no `coda`** / **`until:'fine'` with no
   `fine`** — the jump can't resolve.
2. **Multiple `segno` / `coda` / `fine`** — ambiguous target (v1; see OQ-A).
3. **Volta passes don't partition** — for a repeat with voltas, `⋃ numbers` must equal
   `1..max(numbers)` with no overlap; a gap (a pass with no ending) or overlap (two
   endings claim a pass) ⇒ redline has nowhere to go.
4. **Mixed repeat expression** — a `repeatStart` that has **both** a plain `repeatEnd`
   **and** `ending` markers bound to it (two ways to say the same thing — §3).
5. **Invalid span ordering (Codex R2 HIGH 1)** — a bound `repeatEnd` whose bar does NOT
   come after its `repeatStart` (reading order), or an `ending` any of whose bars come
   at/before the bound `repeatStart`. A musically-impossible inverted span that could
   still "terminate."
6. **Invalid ending ranges (Codex R2 HIGH 2)** — an `ending` whose `barIds` are **not
   contiguous** in `barsInOrder`; or, within one repeat, endings that **overlap**,
   **share a bar**, or are **not sorted** in reading order. Required so the volta walk
   (§4 rule 1) is deterministic.
7. **Dangling binding/FK** — `repeatStartId` references a non-`repeatStart` marker (or
   none), or `barId`/`barIds` references a non-existent bar (FK also caught
   structurally — §7).
8. **Non-termination** — exceeds the length cap (§4 backstop; bug catcher only).

Lone `repeatStart` (no `repeatEnd`/volta bound to it) = **non-required warning**
(no-op, cosmetic — does not block verify). Lone `repeatEnd` with no resolvable
`repeatStartId` = error (#5).

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

## 7. Validator + mutation impacts (two layers, fail-closed at the right boundary)

- **`isValidCalibration` (STRUCTURAL only — never runs the resolver):** inside the
  bars/roadmap block: (a) every `marker.barId`/`barIds`/`repeatStartId` FK-checks
  (bars exist; `repeatStartId` points at a real `repeatStart`); (b) roadmap only
  present when `bars` is non-empty; (c) shape/enum checks per marker kind. **A
  structurally-valid-but-unresolvable draft persists and reloads** — authoring is never
  blocked (BLOCKER 1).
- **`resolveRoadmap` runs on the PROMOTION/PERFORM boundary, not on structural
  validity:**
  - `canVerify` (draft → verified) requires `resolveRoadmap` success (alongside the
    existing labeled-sections requirement).
  - **GET fail-closed:** the existing dual-audience check stands — owner gets the draft
    regardless; a **non-owner / Perform consumer** is served the row only if it is
    `verified` **and** `resolveRoadmap` succeeds. So a hand-edited `verified` DB row
    whose roadmap is broken is **not served to Perform** (it falls back to no
    calibration), while the owner can still load and repair it. This keeps the
    fail-closed guarantee without the authoring lockout.
- **Cascade pruning:** `removeSystem` / bar deletion must prune `roadmap` markers whose
  bars vanish, **and** drop an `ending`/`repeatEnd` whose `repeatStartId` was removed
  (same pattern as `Bar.sectionId` cascade today). Renumbering bars (`resizeSystemBand`
  etc.) leaves markers intact (keyed on `barId`, not `absNumber`); the resolved order
  recomputes — fine, the resolver is pure.

## 8. Schema: **persist v3 ONLY when a roadmap is present** (per-payload, not global)

`roadmap` is additive like `systems`/`bars`, **but** a v2-only reader that *ignores*
`roadmap` would drive the **wrong (linear)** redline over a chart that has a roadmap
— "confidently wrong," the worst failure mode (parent §246). So a roadmap-bearing row
must be fenced from old readers.

**The persisted `schema_version` is computed per payload, not stamped globally
(Codex MED 6):**
```
schema_version_to_persist = (calibration.roadmap?.length ?? 0) > 0 ? 3 : 2
```
- **Linear / no-roadmap saves stay v2** ⇒ an **old v2 build still serves them**
  (rollback-safe). Only roadmap-bearing rows become **v3** and are fenced.
- The running constant `CALIBRATION_SCHEMA_VERSION = 3` governs *upgrade-on-read*, not
  *what we stamp on write*: `rowToCalibration` still normalizes any v1/v2 row up to the
  in-memory v3 shape (`roadmap` undefined = linear), so the new build reads old rows
  fine; the **GET version gate** (`post-upgrade schemaVersion !== CALIBRATION_SCHEMA_VERSION ⇒ 404`)
  still rejects genuinely-future rows.
- **Fencing in action:** a **v3** roadmap row served to an **old v2 build** → its gate
  (`!== 2`) **404s** it (can't downgrade a 3) rather than mis-driving it linearly — the
  HIGH fail-closed gate we shipped is *load-bearing* here. A **v2** linear row on that
  same old build serves normally. **Only roadmap rows are gated; linear rows roll back
  cleanly.**
- **Deploy order:** ship+deploy the chunk-4 build (v3-aware) **before** any v3
  (roadmap) row is authored. Drafts are safe regardless (Perform ignores drafts).
- **PUT must accept incoming `schemaVersion` ∈ {1, 2, 3} (Codex R2 MED 3 — footgun).**
  Today's PUT gate is `!== 1 && !== CALIBRATION_SCHEMA_VERSION`; naively bumping the
  constant to 3 would accept only {1, 3} and **reject v2 payloads from old tabs /
  no-roadmap clients.** The chunk-4 PUT gate must explicitly accept `1 | 2 | 3`
  (`rowToCalibration` normalizes on read regardless). This is a compatibility fix, not
  a model change.

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
   examples are the suite, incl. exact `completedPasses` counter, explicit
   `repeatStartId` binding, plain-D.C. cap, nested repeats, §5 span-ordering +
   ending-range invariants #5/#6). **`isValidCalibration` gains STRUCTURAL marker checks only (no
   resolver)**; `canVerify`/performability gain the resolver gate; per-payload v2/v3
   stamping (§8); **PUT gate widened to accept `schemaVersion ∈ {1,2,3}`** (§8 footgun);
   `rowToCalibration` upgrade + cascade pruning. *(Foundational piece-parts —
   unit-tested; gated commit.)*
2. Perform consumption swap (traversal walk + pass readout) + GET performability gate
   runs `resolveRoadmap` on the non-owner/verified branch. *(Gated commit.)*
3. Roadmap authoring tool + live-resolve UI (delete-to-resolve escape hatch).
   *(Gated commit.)*
4. Merge as one coherent unit (per the branch convention). UAT after chunk 5 (or 4 —
   Graham's open call), since real testing needs the converter's auto-overlay anyway.

## 11. Open questions — **RESOLVED (Graham sign-off)**
- **OQ-A (labeled multiples): ✅ SKIP for v1.** One `segno`/`coda`/`fine`; multiple =
  error. *Coda I/II* etc. is a later labeled-target extension (no bump — markers carry
  `id`).
- **OQ-B (repeat binding model): ✅ EXPLICIT `repeatStartId`** (set by authoring UI /
  converter), not geometry-inferred. Nested repeats each track their own
  `completedPasses`. Buildable + unambiguous (the BLOCKER-3 fix), cost = UI sets the
  link.
- **OQ-C (cache vs recompute): ✅ RECOMPUTE** — persist markers only, recompute
  `traversal` on load (pure, cheap, never stale). *Revisit at expert UAT if it ever
  needs to be cached (Graham: "until I don't, which we'll surface in UAT").*
- **OQ-D (schema stamping): ✅ PER-PAYLOAD** — v3 only when `roadmap` present, v2
  otherwise (§8); linear rows stay rollback-safe, only roadmap rows fenced. (Global v3
  stamp rejected.)
- **OQ-E (temporal entanglement + disable): ✅ KEEP SEPARATE, DEFER disable→holdPoint
  to chunk 5.** Chunk 4 is **order only**; temporal layer clocks motion. Chunk-4 escape
  hatch = **delete/fix the marker**; disable-to-park lands in chunk 5 (anchored in
  `design-realtime-chart-control.md` build-order item 5 so it isn't lost).
