# Design — Chart review step v2 (measured geometry + pick-a-split)

Status: **design only — no build until this doc is merged** (standing process).
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

## Non-goals

- No change to `verify`/`canVerify` — the queue remains guidance, never a wall.
- No show-view or conductor changes; overlay only.
- Does not ship the measurement heuristic itself (prerequisite, tracked separately).
- No notation-literate editing surface beyond what already exists.

## Open questions (Codex)

1. **Exclusive precedence residual** — verdict now shadows the numeric child-bar
   roll-up entirely for verdict-bearing systems; any real case where that hides a flag
   worth surfacing, or an edit path (undo/history, replace) that bypasses the authoring
   helpers and leaves a stale non-`edited` verdict?
2. **Plausibility floor** — the N-span re-run's scoring floor is build-time work; flag
   any real layout where *visible-span counting itself* is ambiguous to a non-reader
   (the case that would defeat the count fallback entirely).
3. **Strip rendering** — per-system raster crops on mobile: acceptable cost, or
   pre-render at conversion time?
