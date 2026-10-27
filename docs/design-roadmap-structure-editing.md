# ShowRunr — Roadmap Builder: Repeats, Markers and Bar Editing DESIGN

**§8 ruled by Graham 2026-10-26.** Build state lives in `docs/INDEX.md`. Companion to `design-roadmap-builder.md`
(the spec model) and `design-roadmap-edit-loop.md` (the editor this extends).

## 1. What UAT found (2026-10-26, Graham)

1. **"2x chorus" is written out longhand.** A prompt with `2x chorus, 2x verse` produced
   two Chorus sections and two Verse sections, each printed in full, instead of one
   section under a `|: :|` repeat. The chart is much longer than it needs to be.
2. **No way to add or remove a repeat in the editor.** The right-panel repeat badge is
   read-only (`RoadmapBuilder.tsx` `SortableSectionRow`); `updateSection` only patches
   `label | bars`. Navigation markers are read-only chips (`navMarkers`, "Read-only
   summary"). The only door to a repeat is the prompt + Regenerate, which discards
   manual edits.
3. **No bar-level structure edits.** A bar the parser misread as `D E` (split) instead
   of `D | E` (two bars) can be retyped, but there is no split / insert / delete. The
   bar-count field only adds or removes bars **at the end** of the section (`fitBars`,
   `lib/roadmap-view.ts:275`). Graham worked around it (add a bar at the end, retype
   every bar after the split) — workable for one bar, not for a long section.

## 2. Why the spec already supports this — and what doesn't exist

Already built and rendered: `SectionRepeat` (`plain{times}` | `volta{endings}`) and
`RoadmapNavigation` (segno / coda / toCoda / fine / D.S.–D.C. jump) in
`lib/roadmap-spec.ts`, validated by `validateRoadmapSpec`, rendered to repeat / volta /
nav glyphs (`lib/roadmap-render.ts:122`), resolved by the conductor's nav graph. **No
model or render change is needed.** Everything below is (a) one deterministic step in
the parse pipeline and (b) editor operations on the existing `ViewModel`.

Why "2x chorus" comes out longhand: the L2 prompt tells the model to **transcribe, not
compress** (`lib/roadmap-parse.ts:40`, the anti-collapse rules), and to emit a `repeat`
op only when the author says "repeat" / "x2" / "played twice" (`:71`). "2x chorus" as a
song-form line reads naturally as *two Chorus sections*, which is what the model emits.
The L1 grammar has no repeat syntax at all, so these prompts always reach L2. Fixing it
in the prompt is the wrong layer — the pipeline's own rule is "we compress
deterministically afterward" (`foldDraft`, "the ONLY place compression happens").

## 3. The invariant every operation must keep

Four things in a section point at bar **positions**, and every structure edit must
keep them pointing at the same *musical* bar:

| Reference | Where | Today when bars move |
|---|---|---|
| `chords[]` | `ViewSection.chords`, length === `bars` | `fitBars` pads/truncates at the end only |
| Nav refs | `ViewNavigation.*: { sectionId, bar }` | not remapped — a shrink leaves a ref past the end; save then fails server validation (`backlog-charting.md` §Nav-shrink edge, latent because nav is read-only today) |
| Volta endings | `repeat.endings[].bars: { start, count }` | not remapped — same failure |
| Plain repeat | needs `bars >= 2` (`validateRepeat`) | not checked until save |

Plus one existing silent loss: **removing a section that a nav ref points into drops
the whole navigation block on save** (`lowerNavigation` → `orphaned ? null`,
`roadmap-view.ts`). Fine while nav is uneditable; once it is editable, deleting a
section must not silently delete markers elsewhere.

**Rule: all structure edits go through one set of pure `ViewModel → ViewModel`
operations in `lib/roadmap-view.ts`** that remap every reference above in the same
step, or refuse with a reason. The UI never edits `bars`, `chords`, `repeat` or
`navigation` directly. The existing bar-count field becomes "insert/delete at the end"
through the same operations, which closes the nav-shrink edge.

**Second rule: no edit may silently disable a marker.** Moving references with their
bars keeps a marker on the right bar, but cannot guarantee it still *takes effect*: a
repeat or ending built around it changes how the VM reaches it. (Codex R4: a Verse ×2
with D.C. on bar 2; making bar 2 the 1st ending keeps the D.C. on that bar, both specs
validate, but the ending's exit wins on pass 1 and pass 2 skips the bar — the D.C. never
fires, and the song silently loses its second tour.) So every op is followed by a
**navigation-liveness check**, `navLive(spec)`:

- walk the VM step by step with the **same loop and cap as `resolveRoadmap`**
  (`lib/chart-calibration.ts:974`; a small sibling that also exposes each step's
  `VMState`) and watch for the step where each redirect **fires** — `fired[jumpId]`
  flips to true (D.S./D.C.), `flags.toCodaFired` flips to true (al Coda);
- **live** when the walk terminates and every redirect **lands**: the bar played
  immediately after the firing step is its target — the chart's first bar (D.C.), the
  Segno bar (D.S.), the Coda bar (al Coda); and for al Fine the walk's last bar is the
  Fine bar. If a redirect never fires, the chart is not-live.

  Anchoring on the *firing step* matters twice over. A flag alone says a redirect was
  attempted, not that its target was played (Codex R5: Coda on a bar that
  `addEndings` turned into a 1st ending — `toCodaFired` true, Coda never entered,
  `roadmap-vm.ts:431`). And a bare "jump bar followed by first bar" pair in the
  traversal can be produced by an ordinary repeat back-jump (a D.C. on the last bar of
  a repeated first section), which would read a dead D.C. as live.

An op that turns a live chart not-live is **refused**, naming the marker ("this would
stop the D.C. from being played — move it first"). A chart that was already not-live
does not block edits (so the author can fix it). The check is generic — it does not
enumerate which op/marker/repeat combinations are dangerous, so new combinations are
covered without a new rule.

## 4. Merge repeated sections on parse (fixes §1.1)

A new pure step, `mergeRepeatedSections(spec)`, runs in `foldAndValidateDraft`
(`lib/roadmap-parse.ts`) after `foldDraft` and before `validateRoadmapSpec`, so the L1
and L2 paths both get it.

A **run** of 2+ *adjacent* sections merges into the first, with
`repeat: { kind: 'plain', times: runLength }`, when all of these hold:

- same base label (case-insensitive, trailing number stripped: `Verse 1` = `Verse 2` = `verse`);
- identical `bars` and identical `changes` (exact equality of the folded spec — no fuzzy match);
- none carries a `repeat` already;
- `bars >= 2` (the plain-repeat precondition — a 1-bar run stays longhand);
- no nav ref points into any section of the run except the first;
- **the merged chart plays the same as the longhand one** — the **playback-equivalence
  check**, defined once here and reused by §5.1. For each spec: `layoutRoadmap` →
  `buildCalibration` → `resolveRoadmap` (`lib/chart-calibration.ts:974`), which walks
  the VM to completion **under the resolver's existing termination cap**; a capped or
  failed walk counts as *not equivalent*. Each `TraversalStep.barId` is looked up in
  the layout to its `(section, bar)`, and that bar's **written content** is taken
  as-is — its own chords, or *blank*. Blank bars are never resolved to a chord (§8.5).
  The two sequences of written content must be identical, step for step. This is the test that matters
  when a jump is present: the VM keeps a repeat's pass count when a D.C./D.S. fires
  (`roadmap-vm.ts:497,506`), so a repeat replayed by a jump is played **once** — two
  identical Verses before a D.C. play 4 times longhand but 3 times merged, and that run
  must stay longhand. Without a jump the walk is a cheap confirmation.

Merged section keeps the first section's `id` and the base label. Nav refs are
remapped through an old-index → new-index map built after all merges (a run of N
removes N − 1 sections, and several runs accumulate). A run that fails any test stays
longhand — the step never guesses.

**Read-back.** The tally was built from the pre-fold SpanList, so it was blind to
repeat ops, and after this change it would also disagree with the chart (two Chorus
lines vs one `×2`). Fix in the same PR: build the tally from the **final spec**, one
line per section with `×N` / `N endings` appended (`tallySpec`).

## 5. Editor operations

All are pure functions on `ViewModel`, each returning `{ ok: true, view } | { ok: false,
reason }`. "Confirm" = the UI asks before applying, naming what goes.

### 5.1 Section repeat (fixes §1.2)

The right-panel repeat badge becomes a control: **— / ×2 / ×3 / ×4 / Endings…**.

| Op | Behaviour |
|---|---|
| `setPlainRepeat(sec, times \| null)` | `bars < 2` → refused ("a 1-bar section can't repeat"). From volta → confirm ("removes the 1st/2nd endings"). |
| `unrollRepeat(sec)` | Plain ×N → N adjacent copies, no repeat. Copy 1 keeps the `id` and any nav refs; copies get fresh ids. For a chart that should be written out. **Gated by the §4 playback-equivalence check:** refused when unrolling would change what is played — e.g. a Verse ×2 replayed by a D.C. plays 3 passes as a repeat but 4 written out ("this repeat is replayed by the D.C.; writing it out would add a pass"). |

### 5.2 1st / 2nd endings

`addEndings(sec, lastN)`: "make the last N bars the 1st ending". Appends N new bars as
the 2nd ending (chords copied from ending 1, then editable), sets
`volta{ endings: [{start: bars-N+1, count: N, passes:[1]}, {start: bars+1, count: N, passes:[2]}] }`.
Requires an integer `1 <= lastN < bars` (so ending 1 starts at bar ≥ 2 and neither
ending is empty), else refused. `removeEndings(sec)` deletes the 2nd-ending
bars and drops the repeat (confirm). Three-plus endings and pass lists other than
`[1],[2]` stay prompt-only.

### 5.3 Bar operations (fixes §1.3)

Tapping a bar already opens the chord input (`BarEditor`). Add an action row under it,
so it works on touch (no hover — `uat-plan-v1.md` S16 / issue #173):

**Split into bars · Insert before · Insert after · Delete · Marker ▾**

| Op | Behaviour |
|---|---|
| `splitBar(sec, bar)` | A bar with k ≥ 2 chords becomes k bars, one chord each, whole bar. Disabled for k = 1. Exactly Graham's `D E` → `D \| E`. |
| `insertBar(sec, at)` | New bar is blank. |
| `deleteBar(sec, bar)` | Refused on the section's only bar. Refused on the last body bar of a volta section ("the repeat needs a bar before its endings — remove the endings first"). Bar carries a marker → confirm, removes the marker (and its dependents, §5.4). Only bar of an ending → confirm, removes the endings. Leaves a plain repeat at 1 bar → confirm, drops the repeat. |

**Remap rule — references follow BARS, not positions.** Each op is defined as a map
from every old bar to its new bar(s); every reference then follows its bar:

- **Unchanged bars** keep their refs, wherever they move. `insertBefore(p)` puts the
  new bar at p and old bar p becomes p+1 — its markers go with it; `insertAfter(p)`
  leaves p and its markers in place.
- **Split** maps bar p to k bars. A **start-edge** marker (segno, coda —
  `roadmap-render.ts` emits `edge:'start'`) goes to the **first** new bar; an
  **end-edge** marker (To Coda, Fine, D.S./D.C. departure — `edge:'end'`,
  `roadmap-render.ts:185`) goes to the **last**, so the musical bar still ends where it
  did.
- **Deleted bar:** its refs are removed under the confirm above; never shifted onto a
  neighbour.
- **Blank bars stay blank.** No op ever writes a chord into a blank bar or reads one
  out of a neighbour (§8.5). A blank's meaning is left to common practice and to the
  chart's author, who can type a chord in. So deleting the G from `C, G, blank` leaves
  `C, blank` — by design.
- **Volta groups.** Each bar belongs to one group: the **body** (every bar before the
  **earliest** ending's `start` — `endings[]` order is not position order: the
  validator and VM sort ranges, `roadmap-spec.ts:425`, `roadmap-vm.ts:250`), one of the
  endings, or none. Refusals that name "the last body bar" use this definition. A new bar joins the group of the bar it was inserted relative to; split
  bars stay in their bar's group. Each ending's `{start, count}` is recomputed from its
  group's bars after the op. A group emptied by a delete is handled by the refusals /
  confirms above, so `start > 1` and `count >= 1` always hold.

### 5.4 Navigation markers

From the bar's **Marker ▾**: Segno · Coda · To Coda · Fine · D.S. / D.C. (al Fine / al
Coda / to end). The menu offers only what the validator would accept
(`validateNavigation`'s preconditions: To Coda needs Coda, D.S. needs Segno, al Coda
needs Coda + To Coda, al Fine needs Fine). Each marker type exists once; placing it
again moves it. Removing a marker that another depends on (Segno under a D.S.) →
confirm, removes both. `removeSection` on a section holding a marker → confirm,
naming it — replaces today's silent drop of the whole navigation block.

## 6. Tests

- **Merge (§4):** fixtures per condition — merges, and the near-miss that must not
  (differs by one chord; 1-bar run; nav ref into copy 2; non-adjacent; existing repeat;
  `Verse` vs `Chorus` with identical chords; **two identical Verses before a D.C.** —
  Codex R1's counterexample, and its mirror for §5.1 (Unroll of a Verse ×2 before a D.C.
  is refused); **three identical Verses then an Outro with a ref** — the
  index remap). Tally lines match the merged spec.
- **Ops (§5):** each op's refusal cases, plus one **property test**: random sequences
  of ops over the existing builder fixtures, asserting after every step that
  (a) `viewToSpec` → `validateRoadmapSpec` is ok, (b) every nav ref and ending still
  lands on the same musical bar — tracked by a **synthetic stable id** the harness
  attaches to each bar and carries through the op's bar map (rendered bar ids are
  positional, `roadmap-layout.ts:182`, so they can't prove this),
  (c) `chords.length === bars`, (d) no op writes into or
  reads from a blank bar (the `C, G, blank` delete is a fixed fixture), (e) volta fixtures include endings
  listed out of position order.
- **Liveness:** Codex R4's fixture (Verse ×2, D.C. on bar 2, addEndings(1)) and R5's
  (To Coda in Intro, Coda on Verse ×2 bar 2, D.C. al Coda in Outro, addEndings(Verse, 1))
  are refused;
  the same op with the D.C. on a bar outside the section is allowed; the property test
  asserts no step turns a live chart not-live.
- **UI:** bar action row reachable by tap; repeat control disabled at 1 bar;
  confirms name what is removed.

## 7. Build order — each its own PR

| PR | Scope | Size |
|---|---|---|
| **A** | §4 merge-on-parse + tally from the final spec | S — server-only, pure |
| **B** | §3 op layer + §5.3 bar ops; bar-count field routed through it | M |
| **C** | §5.1 repeat control + unroll | S (on B) |
| **D** | §5.2 endings + §5.4 markers | M (on B) |

A fixes the reported "2x" problem on its own and needs no UI. B is the foundation;
C and D are thin on it.

## 8. Rulings (Graham, 2026-10-26)

1. **Merge always** — adjacent identical sections fold into a repeat whatever the
   prompt's phrasing. Every target display is a phone; vertical space is the scarce
   resource. §5.1 Unroll is the escape hatch.
2. **`Verse 1` + `Verse 2` with identical chords merge** (§4 base label).
3. **No automatic D.S. / Coda for non-adjacent repeats** in this work, provided markers
   are placeable by hand (§5.4). Graham likes the idea as a later feature — it would be
   an explicit "compress to a roadmap" action the owner invokes, never a parse default.
4. **No automatic 1st/2nd endings** for near-identical runs; built by hand (§5.2).
5. **Blank bars are never interpreted.** The system does not compute what chord a
   blank bar "inherits" — not in merge, unroll, or any edit. A blank stays blank; the
   musician plays it by common practice, and the author types a chord in where they
   want to direct it. Why: any computed rule is wrong somewhere — a 2nd ending is
   entered from the body, not from the 1st ending printed before it; a repeated
   section's first bar follows different chords on different passes — and neither the
   PDF nor the conductor resolves blanks.
