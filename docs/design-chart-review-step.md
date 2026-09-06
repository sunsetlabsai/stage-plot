# Design — Chart review step v2 (measured geometry + pick-a-split)

Status: **build state in `docs/INDEX.md`, not here.** The review sheet it specifies is
chunk C, and §Chunk C — build spec is what that chunk builds against. Frozen 2026-09-02
apart from dated amendments carrying a ruling of Graham's; the live ones are §Amendment
2026-09-06 (the sheet gains an owner-initiated entry point) and the `unscored` amendment
under §Confidence verdicts.
Extends `design-chart-converter.md` (its "Review queue" section and open-Q1 "vision
coordinate quality"); complements `design-barline-calibration.md` (the manual drag editor
stays as the deep fallback). Nothing here changes verify/`canVerify` or the show view.

## Why

The 2026-09-01 spike proved uploaded-chart bar geometry is **measurable, not guessable**:
barlines are vector primitives recoverable from the PDF's vector data, and the result
**self-validates** against the chart's own printed measure numbers in the text layer
(validated 2026-09-02: **464/464 scored systems across 62 real charts**, multi-page,
multiple engravers, mostly out-of-sample; raster scans remain VLM-only —
see `backlog-charting.md` §Ruled 2026-09-02).

That changes what "confidence" means. Today's review queue flags on the VLM's
self-reported confidence — the model's opinion of its own guess. Validation gives us
**evidence** instead: we know *exactly which systems* are wrong or unverifiable, per
system, with no human. This doc designs the human step that resolves only those.

## Principles (ruled by Graham, 2026-09-01)

- **The uploader is not a notation reader.** No notation vocabulary anywhere; every ask
  is "pick the picture that looks right" or "count the bars in this line."
- **Ask only about systems that failed. Silent when confident.**
- **Never mandatory.** Skipping always saves the chart with the best-effort overlay.
- **Always take the first pass, and surface a confidence level.** The chart is usable
  immediately; uncertainty is a badge, not a gate.
- **Fallback granularity is per-system**, not per-chart. (Graham flagged low confidence
  in this ruling — revisit if the mixed-source overlay proves hard to debug.)

## Geometry pipeline (context — this decides who gets asked)

Per system, in order:

1. **Measure**: staves from merged horizontal rules (bucket by y, merge contiguous
   x-ranges — some engravers break each staff line at every barline, and those break
   points are themselves a second barline signal); verticals accepted as barlines only
   when both endpoints land on the outer staff lines within tight tolerance.
2. **Read ground truth**: printed measure numbers, time signature, multirest counts from
   the text layer (coordinates included). Multirest counts feed the validation arithmetic
   only (a 24-bar multirest explains a measure-number delta of 24 across one visible
   span) — they are **never** used to split geometry.
3. **Validate**: measured bars-per-system vs the printed number delta.
4. **VLM fallback** only for systems that fail validation. Raster pages (no vectors, no
   text layer): VLM for everything, chart marked *estimated*.

Heuristic generalization is done (the validation above); **productizing** the
measurement engine is prerequisite engineering with its own loop — the self-validation
score is the objective function. It is **not in this doc's build scope**, and nothing
here may assume any particular accuracy rate; the review step must work at any level.

## Confidence verdicts (the new flag signal)

Per system, replacing VLM self-confidence as the review-queue driver:

| Verdict | Meaning | Review behavior |
|---|---|---|
| `validated` | measured count matches the printed measure-number delta | silent |
| `unscored` | geometry measured, but no printed delta existed to check it against — the page-tail system, or the first system of a continuation page | silent |
| `corroborated` | no printed numbers on this chart; measured and VLM independently agree | silent |
| `uncertain` | validation failed, or the two sources disagree | flagged — the ask |
| `estimated` | raster scan / no vector data; VLM-only | chart-level badge, soft flag |
| `confirmed` | a human answered via pick-a-split / count | pinned; never flagged, never machine-overwritten |
| `edited` | a human manually edited the system or its bars | pinned; never flagged |

Chart-level confidence is the aggregate, surfaced in plain words ("9 of 12 lines
verified"). Scans surface as "scanned chart — overlay is estimated." `unscored` systems
are measured, not unverified-in-the-worrying-sense, so they count as verified in that
tally; only `uncertain` subtracts.

**Amendment 2026-09-02 (Graham's ruling), `unscored`:** the original four verdicts had
no slot for a system the geometry measured cleanly but arithmetic could not check,
because no printed delta was available. Measured on the corpus, that is **86 of 550
systems — 15.6%**, distributed as almost exactly one per page: the page-tail system, and
the first system of a continuation page (cross-page measure-number chaining is a
§Non-goal of `design-chart-measurement.md`). Folding these into `uncertain` would flag a
sixth of all systems for human review with nothing wrong with them — precisely the
"review debt" `backlog-charting.md` §Ruled 2026-09-02 warns against — and leaving the
verdict absent is taken, since an absent verdict means "legacy / VLM-only calibration".
Hence a fifth machine verdict, silent in review.

Plumbing: a new optional per-`System` `verdict` field (optional-field forward-compat, no
schema bump — same pattern as `confidence`). Because exclusivity makes any *present*
value significant, `verdict` must get runtime enum validation at the same DB boundary
where `confidence` is range-checked (`isValidSystem`); an unknown value is invalid, not
ignored. **A present verdict is the EXCLUSIVE flag
signal for that system** — the numeric roll-up in `chart-review.ts` (band low-confidence
OR any child bar low-confidence) applies only to verdict-less systems. v2 conversion
writes a verdict on **every** system, so an absent verdict means exactly one thing: a
legacy / VLM-only calibration, which keeps the unchanged numeric path. Absent is never
the result of an edit. Sections and roadmap markers keep the existing numeric-confidence
flow — verdicts apply to system geometry only, because only geometry has printed ground
truth to validate against.

Exclusivity is safe because of how verdicts are assigned: `validated` systems carry
vector-measured geometry (no VLM-seeded child confidences exist to ignore);
`corroborated` means two independent sources agree, which outranks the VLM's
self-reported doubt about its own bars; and every system whose geometry actually came
from the VLM is `uncertain` or `estimated` — already flagged.

Lifecycle (the edit-owns-it move, extended): `verdict` lives on the `System` only. Any
manual geometry edit to a system **or any of its bars** (move/resize/barline drag/
auto-distribute) **writes `verdict: 'edited'` on the parent system, in the same
authoring-helper move that already clears the touched element's `confidence`** (those
helpers keep their shipped per-element scope — `moveBarBoundary` clears the moved bars,
`resizeSystemBand` the band). `edited` is human-owned and never flagged, and because
verdicts are exclusive, leftover numeric confidence on untouched sibling bars is inert —
there is no numeric-fallback path that can re-flag a human-owned system. This is the
shipped self-clearing philosophy at system granularity: the queue never strands a
touched item. Pick-a-split and the count fallback are the **only** writers of
`verdict: 'confirmed'`.

## The interaction — pick a split, count as fallback (decided)

For each flagged system, a focused one-line-at-a-time sheet (not the calibrate canvas):

```
Line 7 of 12 — this line didn't check out
┌──────────────────────────────────┐
│  [rendered system strip]         │
└──────────────────────────────────┘
Which split looks right?
  (•) ┃····┃····┃····┃····┃   4 bars
  ( ) ┃···┃···┃···┃···┃···┃  5 bars
  ( ) None of these
```

- The strip is a pdf.js raster crop of the system's band (geometry already known from
  staff detection). Candidates: **measured**, **VLM**, and **printed-number-implied**
  splits, deduplicated — two agreeing sources show as one option. Never more than three.
- Tap one → that split is applied and the system becomes `confirmed`.
- "None of these" → **"How many bars do you count in this line?"** N is defined as
  **visible barline-delimited spans** — exactly what a non-reader counts by eye — and
  never played or written measures: a multirest is one span, a pickup bar changes
  numbering but not span count, a meter change changes neither. So N is sufficient
  ground truth for *geometry*: the detector re-runs seeking the best-scoring N-span
  segmentation from the candidate verticals. **If no segmentation clears a plausibility
  floor, the count is not forced into fake geometry — the sheet routes to "Open
  calibration" instead.** On raster charts, the count re-prompts the VLM with N pinned;
  even division of the band into N is the last resort. Result applies as `confirmed`.
- Anything pick-a-split can't express (wrong band, merged systems) → "Open calibration"
  hands off to the existing calibrate editor + barline drag. The editor is the deep
  fallback, not the front line.

## Entry points (decided)

- **Conversion tail — offered, skippable.** *(Amended 2026-09-02, ruled by Graham:
  conversion itself is now LAZY — an upload never auto-converts; conversion runs on
  OWNER demand, and known-never classes — lyrics, builder charts — are gated before the
  call fires. The trigger ruling and its open placement decision live in
  `backlog-charting.md` §Ruled 2026-09-02; this doc does not restate them. The offer
  below follows CONVERSION, whenever that happens.)* When conversion
  succeeds but uncertain systems exist, the transient status becomes *"Looks good — 3
  lines need a look. Review · Later."* "Later" (or ignoring it) saves everything as-is.
  Fully-confident conversions stay silent.
- **Persistent badge.** A chart with uncertain systems shows an "N lines uncertain" chip
  wherever its chip renders; tapping opens the same sheet. It never re-prompts on its
  own — the badge just sits there until resolved or ignored forever.
- **Raster charts** get the chart-level "estimated" badge and the same opt-in flow.
- **Owner-initiated, any system.** *(Added 2026-09-06 — see the amendment below.)* In
  calibrate mode's bars tool, a selected system offers **"Check this line"**, which opens
  the same sheet. The machine flag decides whether we *proactively ask*; it does not
  decide whether the sheet is *reachable*.

## Amendment 2026-09-06 (Graham's ruling) — the flag is not the only door

**The measurement.** `buildMeasuredPayload` was run over the whole 87-file / 550-system
corpus (the shipped acceptance harness cannot do this — it scores `measurePage`'s
`ProvisionalVerdict` and never calls the payload builder, which is why 464/464 never
covered it). Result: **`validated` 464, `unscored` 86, `uncertain` 0.** Both machine
outcomes are *silent* in the table above, so **the sheet as originally specified has no
input on any chart we hold.**

That answers the question §Multirests deferred here — **multirest over-demotion is 0 of
550 systems**, and it is not marginal: 12 systems carry multirests (18 in total), every
H-bar is contained with a minimum margin of **4.75pt** against a 0.75pt tolerance (6.3×),
and **zero of the 18 spend any tolerance at all** — containment alone decides every case,
so `MULTIREST_CONTAINMENT_TOL` is currently earning nothing and its ⚠ "must never grow
into a search radius" has ample headroom. Verified with a positive control: forcing the
tolerance negative demotes exactly those 12 and the rig reports them, so the zero is a
real zero and not a blind harness.

**The ruling.** A verdict decides whether the app *volunteers* the sheet. It does not
decide whether the sheet exists. Principles §"Ask only about systems that failed. Silent
when confident." governs *prompting* — it was never a statement that a confident line is
unopenable. So the sheet gains the owner-initiated entry point above and is built whole.

**Why this is the non-punting shape.** The failure mode that actually reaches a band is
not the engine flagging itself — it is the engine being **confident and wrong**, which the
owner discovers at rehearsal. Today their only recourse is calibrate mode plus per-barline
dragging, which this doc itself calls the deep fallback. "Which split looks right? / none
of these → how many bars do you count?" is strictly better for a non-reader, and routing
the owner to it makes every path here exercisable on all 87 charts today rather than on a
case we have never seen.

**Consequence for candidates.** On an owner-opened confident system there is one candidate
— the stored measured split (a measured chart stores no competing VLM geometry). The sheet
degenerates to "is this right? → no → how many bars?", and **the count fallback carries
that path.** It is therefore the part that must be scored, not the picker; see §Chunk C
acceptance.

## Persistence and re-runs

- **Generate-once stands, unqualified** (`design-chart-converter.md`: the converter
  writes only when no `(chart_id, source_hash)` row exists, insert-only,
  conflict-as-no-op, never updates; the A2 backfill skips existing rows). **There is no
  same-hash machine re-run of any kind.** An improved detector benefits new conversions
  and replaces only; it never retroactively touches an existing calibration. Human
  answers are therefore pinned *structurally* — no merge/ownership policy exists because
  no machine writer exists after generation.
- The review step's writes — pick-a-split, the count fallback, and the calibrate
  hand-off — are part of the **human/verify flow that owns the row after generation**,
  the same standing as any manual calibrate edit.
- Replace semantics unchanged: new bytes → new hash → new calibration target, converted
  from scratch by the then-current pipeline.

## Chunk C — build spec

Five parts. C1–C2 are the plumbing the sheet needs and are independently correct without
it; C3–C4 are the sheet; C5 is what says it works.

### C1 — verdict actually drives review

`reviewFlags` (`lib/chart-review.ts:43`) reads **only `confidence`** today, and
`installMeasured` deliberately writes **no** `confidence` on measured systems — its own
comment calls inventing one "a lie the review sheet then ranks by"
(`lib/chart-measured.ts:293-295`). Net effect today: **a measured chart flags zero systems
and the toolbar reads "✓ Reviewed" no matter what its verdicts say.** The v2 signal is
persisted and nothing reads it.

Implement §Confidence verdicts' exclusivity rule as written: per system, a **present**
verdict is the sole flag signal (`uncertain` flags, everything else is silent); an
**absent** verdict keeps today's numeric roll-up untouched. Sections and markers are
unchanged. `count`/`ordered` keep their existing shape so the stepper needs no change.

⚠ On the current corpus this still yields zero flags — that is the correct outcome, not a
regression, and it is why C5 does not score itself on flag volume.

### C2 — the verdict lifecycle, and two live defects

`'confirmed'` and `'edited'` exist only in this document. They are absent from
`ChartVerdict` (`lib/types.ts:111`) and from `CHART_VERDICTS` (`lib/chart-calibration.ts:1009`),
so `isValidVerdict` would **reject** either today. Add both to the type and the runtime
enum, then close the two paths that are wrong right now:

- **Stale verdict survives a band drag.** `resizeSystemBand` does
  `withoutConfidence({ ...s, yTop, yBottom })` (`lib/chart-calibration.ts:405`) — the
  spread **preserves `verdict`**, so a system dragged anywhere still claims `validated`.
  This is open-Q1's "stale non-`edited` verdict", and it is reachable today.
- Per §Lifecycle, every authoring helper that changes a system's geometry **or any of its
  bars** writes `verdict: 'edited'` on the parent system, in the same move that already
  clears the touched element's `confidence`: `resizeSystemBand`, `moveBarBoundary`,
  `addBarline`, `removeBarline`, `autoDistributeBars`. `addSystem` is excluded — a new
  system has no verdict to stale, and absent is already the right value.

⚠ **Decide at review:** CV barline snap routes through `moveBarBoundary`
(`lib/chart-snap.ts:8`) and so inherits `'edited'`. That reads right — snap is
owner-initiated and owner-owned — but it is a *machine* placement being stamped with a
human-owned verdict, so it is called out rather than absorbed.

**Open-Q1 is otherwise narrower than it reads, measured:** there is no calibration
undo/history stack (the only undo in the app is the one-level setlist-import undo,
`page.tsx:626-688`), and `/api/charts/calibration` PUT has exactly one caller
(`page.tsx:3550`). So the helper set above is the complete edit surface.

### C3 — the sheet

New component `components/ChartReviewSheet.tsx` (presentational, jsdom-testable, the
`PerformReadinessStrip` pattern) over a new pure module `lib/chart-resegment.ts`. One
system at a time, per §The interaction.

- **The strip** is a `renderPageOffscreen` crop (`lib/pdf-viewer.ts:283`) of the system's
  band — the same call the CV snap path already makes at `page.tsx:3170`. Two known traps
  to carry: pdf.js paints on a **transparent** canvas (check alpha before luma, as
  `buildBandProfile` does at `page.tsx:1877`), and the stored band is the staff's own
  extent with **no padding** (`chart-measured.ts:180-185`), so a crop at exactly
  `yTop`/`yBottom` clips ledger lines and chord symbols. The strip needs vertical padding
  outward — the opposite of what snap does when it crops inward.
- **Candidates**, deduplicated, never more than three: the stored split; the
  printed-number-implied split where `expectedSpans` exists and disagrees; the VLM split
  where the chart took the VLM path. Identical splits collapse to one option.
- **"None of these" → "How many bars do you count in this line?"** N is visible
  barline-delimited spans, per §The interaction.

### C4 — what an answer writes

The sheet re-runs the measurement engine on that one page to recover the candidate
verticals, which were never persisted (only the resulting bars were). This is legitimate
under §Persistence: generate-once forbids **machine** re-runs that overwrite, and this is
a human-initiated edit inside "the human/verify flow that owns the row after generation".

- **Segmentation from N.** Choose the N-span segmentation whose N−1 interior boundaries
  are **all observed verticals**. This *is* the plausibility floor (open-Q2), and it is
  stated as a presence test on purpose: nothing may be invented to reach N, so a system
  with fewer than N−1 detected verticals fails immediately rather than being fitted. Same
  discipline as the never-gate's "evidence of absence, never absence of evidence".
- **Floor not cleared → "Open calibration"**, deep-linked to that page with the system
  selected and the count pre-set to N. That hand-off is the existing count-stepper plus
  barline-drag flow, so the raster case needs no new machinery.
- ⚠ **Amends §The interaction**, which specified "on raster charts, the count re-prompts
  the VLM with N pinned". Dropped: with N already known, a VLM re-prompt buys nothing over
  count-plus-drag and costs a server leg and the owner's AI budget. Even division into N is
  reached only through the existing stepper, where it is already the shipped behaviour.
- **`measures` is re-derived, not carried.** A re-split invalidates the old multirest
  attribution by definition — the counts were attached to bars that just moved — so the
  sheet re-attributes from the fresh engine output using the shipped containment rule. This
  also gives `measures` its **first recovery path**: today `autoDistributeBars`
  (`lib/chart-calibration.ts:487-494`) builds fresh bars with no `measures` at all, which
  under generate-once is **permanent, silent loss** on exactly the 12 corpus systems that
  carry multirests. The rule becomes: *geometry re-derived from evidence re-derives
  `measures`; geometry authored by hand drops it.* The stepper keeps dropping (correctly —
  it has no evidence to attribute from); the sheet is how you get them back.
- Picking a candidate or answering the count writes `verdict: 'confirmed'`; these remain
  its only writers.

⚠ This changes a claim with **three homes** that must move in the same PR: `lib/types.ts:152-159`
("no editing surface … never acquires it, by machine or by hand, short of new bytes"),
`docs/design-chart-measurement.md:468-476`, and the ★ note at `lib/chart-measured.ts:74-79`
that defers the demotion question to chunk C — now answered, above.

### C5 — acceptance: the count fallback is scored on the corpus

The picker cannot be scored (no disagreeing candidates exist on our charts), but the count
fallback can be, and it is the path that does the real work:

**For each of the 464 `validated` systems, pin N to its known span count and re-segment.
The result must reproduce that system's measured split exactly — 464/464.** A validated
system's span count is agreed by measurement *and* by the engraver's printed numbers, so
this is a real objective function on real charts, not a synthetic fixture. Report the
plausibility floor's false-reject rate on the same run.

This is added to the existing acceptance harness, which must also hold its current
baseline unmoved: **464/464, 550 staves, 3044 spans, PARITY clean, `fillRect === 1` on
every one of 115 pages.**

## Non-goals

- No change to `verify`/`canVerify` — the queue remains guidance, never a wall.
- No show-view or conductor changes; overlay only.
- Does not ship the measurement heuristic itself (prerequisite, tracked separately).
- No notation-literate editing surface beyond what already exists.
- **No per-system VLM fallback leg** (deferred by `design-chart-measurement.md` §Scope
  ruling and still unearned: 0 `uncertain` systems on the corpus). The sheet's VLM
  candidate is read from geometry a chart already has, never newly requested.

## Open questions (Codex)

1. **Exclusive precedence residual** — verdict now shadows the numeric child-bar roll-up
   entirely for verdict-bearing systems. The edit-path half of this question is answered
   in C2 (no undo stack, single PUT caller, helper set enumerated). What remains: is there
   a real case where shadowing the child-bar roll-up hides a flag worth surfacing?
2. ~~**Plausibility floor**~~ — answered in C4: all N−1 interior boundaries must be
   observed verticals, nothing invented. Still worth flagging any real layout where
   *visible-span counting itself* is ambiguous to a non-reader, since that would defeat the
   count fallback regardless of the floor.
3. ~~**Strip rendering**~~ — answered by the amendment: the sheet is opened one system at a
   time, on demand, so it renders one crop per view. Pre-rendering at conversion time would
   pay for every system of every chart to serve the few ever opened.
4. **New.** C4 re-runs the engine client-side at review time, so a system's candidate
   verticals are recovered from the PDF rather than from the stored calibration. Does that
   inherit the stale-bytes hazard `design-chart-measurement.md` §Cache eviction describes,
   and should the sheet re-hash before trusting what it measured?
