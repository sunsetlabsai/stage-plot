# Design — Chart review step v2 (measured geometry + pick-a-split)

Status: **design only — no build until this doc is merged** (standing process).
Extends `design-chart-converter.md` (its "Review queue" section and open-Q1 "vision
coordinate quality"); complements `design-barline-calibration.md` (the manual drag editor
stays as the deep fallback). Nothing here changes verify/`canVerify` or the show view.

## Why

The 2026-09-01 spike proved uploaded-chart bar geometry is **measurable, not guessable**:
barlines are vector primitives recoverable from pdf.js path ops, and the result
**self-validates** against the chart's own printed measure numbers in the text layer
(current probe: 35/49 systems across 6 of 8 real charts; 1 of 8 is a raster scan).

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

Heuristic generalization (e.g. the Long Train Runnin' staff-detection under-count) is
prerequisite engineering with its own loop — the self-validation score is the objective
function. It is **not in this doc's build scope**, and nothing here may assume the current
35/49 rate; the review step must work at any accuracy level.

## Confidence verdicts (the new flag signal)

Per system, replacing VLM self-confidence as the review-queue driver:

| Verdict | Meaning | Review behavior |
|---|---|---|
| `validated` | measured count matches the printed measure-number delta | silent |
| `corroborated` | no printed numbers on this chart; measured and VLM independently agree | silent |
| `uncertain` | validation failed, or the two sources disagree | flagged — the ask |
| `estimated` | raster scan / no vector data; VLM-only | chart-level badge, soft flag |
| `confirmed` | a human answered | pinned; never flagged, never machine-overwritten |

Chart-level confidence is the aggregate, surfaced in plain words ("9 of 12 lines
verified"). Scans surface as "scanned chart — overlay is estimated."

Plumbing: a new optional per-`System` `verdict` field (optional-field forward-compat, no
schema bump — same pattern as `confidence`). `chart-review.ts` flags on `verdict` when
present and falls back to the numeric `confidence` threshold otherwise, so VLM-only and
legacy calibrations keep working unchanged. Sections and roadmap markers keep the
existing numeric-confidence flow — verdicts apply to system/bar geometry only, because
only geometry has printed ground truth to validate against.

Lifecycle (the edit-owns-it move, extended): `verdict` lives on the `System` only. Any
manual geometry edit to a system **or any of its bars** (move/resize/barline drag/
auto-distribute) **clears the system's `verdict` in the same authoring helpers that
already clear `confidence`** — one move, not two. The system becomes human-owned, drops
out of the queue, and a stale machine verdict can never re-flag it or mis-mark it
machine-owned. Pick-a-split and the count fallback are the **only** writers of
`verdict: 'confirmed'`. The flag rule stays monotone with the shipped seam: absent
verdict + absent confidence is never flagged.

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

- **Upload tail — offered, skippable.** Chunk 3's silent-on-success rule gains one case:
  when conversion succeeds but uncertain systems exist, the transient status becomes
  *"Looks good — 3 lines need a look. Review · Later."* "Later" (or ignoring it) saves
  everything as-is. Fully-confident conversions stay silent, exactly as today.
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

1. **Verdict lifecycle residual** — verdict now clears in the same helpers as
   confidence; any remaining edge (replace, legacy rows, undo/history paths) where a
   stale verdict survives an edit?
2. **Plausibility floor** — the N-span re-run's scoring floor is build-time work; flag
   any real layout where *visible-span counting itself* is ambiguous to a non-reader
   (the case that would defeat the count fallback entirely).
3. **Strip rendering** — per-system raster crops on mobile: acceptable cost, or
   pre-render at conversion time?
