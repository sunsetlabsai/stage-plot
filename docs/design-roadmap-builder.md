# Design — Roadmap Builder (AI-copiloted chart authoring)

Status: **DRAFT for review** · Branch `opus/design-roadmap-builder` · Owner: Graham (sign-off gate)
· Awaiting Codex R1

## Why now

The converter (raster PDF → structure) is fighting the hard direction: a vision model estimates bar
coordinates and gets them roughly right at best (see `design-chart-converter.md`; the live "About Damn
Time" overlay looked "almost random" until we bumped vision effort). That accuracy ceiling is inherent —
VLMs are weak at pinpointing fine, repetitive glyphs like barlines, and many real charts (chord/lyric
sheets) have no barlines to detect at all.

The **Roadmap Builder inverts the problem.** Instead of reading geometry off someone else's chart, the
author *describes the song's structure* in plain English ("4/4, 4-bar intro, 8-bar verse, 4-bar pre,
8-bar chorus, …") and **we generate the chart**. When we own the layout, the geometry is **exact by
construction** — no vision, no coordinate guessing, no review-to-fix-placement loop. This is the
high-confidence authoring path; the converter remains the path for charts that already exist as PDFs.

> Graham: *"an ADDITIONAL path, not replacement … treat our charts as the substrate just as we would the
> PDF imports, over which we create the overlay roadmap."*

## The core insight (load-bearing)

A builder chart is a **deterministic converter whose input we control**:

1. **Author → structured spec.** The AI copilot parses natural language into a structured `RoadmapSpec`
   (time signature, ordered sections with bar counts, optional Nashville changes, repeats/endings). The
   LLM does parsing **only**.
2. **Spec → substrate (PDF).** A deterministic renderer lays the spec out on a fixed grid (N bars per
   line) and produces a **PDF** — the same kind of artifact an import produces. This makes builder charts
   flow through the **entire existing pipeline unchanged**: PDF-canvas viewer, offline cache, Perform,
   calibrate/verify (per `design-chart-converter.md` §3, the calibration path is PDF-canvas end-to-end).
3. **Spec → calibration (verified).** Because the renderer placed every system/bar, it emits a
   `ChartCalibration` (`lib/types.ts`) with **exact** `systems`/`bars`/`sections`/`roadmap` coordinates.
   Geometry is correct by construction, so this calibration is born `status: 'verified'` — it never goes
   through the converter's draft/review queue.

The result: the overlay is **never "off"**, because the same code drew the page and placed the overlay.

## Decisions to lock (proposed — Graham to confirm)

1. **Substrate = rendered PDF, not a bespoke "native chart" view.** Honors "treat our charts as the
   substrate just as the PDF imports." Reusing the PDF-canvas pipeline (viewer/cache/Perform/calibrate)
   beats forking a second render path everywhere. Cost: a server-or-client PDF generator dep (see Open
   Q1).
2. **Source of truth = the `RoadmapSpec`; PDF + calibration are DERIVED.** We persist the spec so the
   chart is re-editable and re-renderable (and **transposable** — see #4). Edit = change spec → re-render
   → replace file + rewrite verified calibration.
3. **AI is copilot, not author.** The LLM proposes a spec; a **deterministic validator** gates it (bar
   math reconciles, section counts sum, repeats/endings balance, degrees are valid) — same posture as the
   converter's `isValidCalibration` boundary. The human reviews/edits the spec, not pixel coordinates.
4. **Nashville Number System is key-agnostic → transposition is free.** Changes are stored as scale
   **degrees + quality** (`1`, `4`, `5`, `6m`, `2m7`, `5/7` …), not absolute chords. The same spec renders
   in **any key** by applying the song's key at render time. This **collapses the deferred
   "duplicate-per-key" problem** (`Song X (G)` vs `(Bb)`) into one transposable source — a strategic win
   on its own.
5. **Born `verified`.** Geometry is exact; the only thing the author owns is whether they described the
   song correctly — the same responsibility they'd have hand-drawing a chart. No draft/queue.

## Goals

- A **Build Chart** authoring surface: type/paste a natural-language description → AI parses → preview a
  clean house-style NNS chart → save it as a normal library chart (role-assigned, like any upload).
- The saved chart is a **PDF substrate + verified calibration**, indistinguishable downstream from an
  import (viewer, offline, Perform, conductor broadcast all "just work").
- **Re-editable**: re-open the spec, tweak (sections, counts, changes, key), re-render.
- **Transposable**: render the same spec in any key.
- Works for **rock/pop and jazz** (NNS with 7ths/extensions/minor/diminished covers jazz changes).

## Non-goals (this design)

- **Melodies / full music notation.** If you need notes, beaming, or complex rhythmic engraving, use a
  real notation/charting tool and **import the PDF** — the converter path. The builder produces the
  *roadmap + changes* substrate, not engraving. (Graham: *"People who want/need melodies or complex bits
  can/should use a charting tool and write the notation."*)
- Audio analysis / auto-detecting structure from a recording.
- Advanced NNS rhythmic micro-notation in v1 (marcato `^`, staccato, multi-dot beat spacing). Diamonds
  (held) and basic split bars are in; the rest is v2.
- Replacing the converter. Both paths coexist; builder is the high-confidence one for songs without an
  existing chart.

## Data model (proposed)

A new persisted artifact — the editable source — keyed to the existing chart row:

```ts
// The authored source of a builder chart. Persisted (see Open Q2) so the chart
// is re-editable, re-renderable, and transposable. PDF + ChartCalibration are
// DERIVED from this; this is the source of truth.
interface RoadmapSpec {
  version: number;
  timeSig: { beats: number; unit: number };   // e.g. { beats: 4, unit: 4 }
  defaultKey: string;                          // render key when none chosen, e.g. "G"
  barsPerLine?: number;                        // layout hint (default 4)
  sections: RoadmapSection[];                  // ordered; the song form
}

interface RoadmapSection {
  id: string;
  label: string;                               // "Intro", "Verse", "Chorus", "Solo"
  bars: number;                                // count (the form math the validator checks)
  changes?: BarChange[];                       // optional NNS changes, one entry per bar (or sparse)
  repeat?: { times: number; endings?: number[][] }; // maps to RoadmapMarker repeat/ending on render
}

interface BarChange {
  bar: number;                                 // 1-based within the section
  // split bar = >1 chord sharing the measure; beats sum to timeSig.beats
  chords: { degree: number; quality?: string; bass?: number; beats?: number; held?: boolean }[];
}
```

- `degree` 1–7 (Nashville). `quality` ∈ `{'', 'm', '7', 'maj7', 'm7', 'dim', 'sus', …}` (v1 subset).
  `bass` = slash-chord degree. `held` = diamond (whole-note hold). `beats` enables split bars.
- **Rendering** maps `RoadmapSection` → `SectionAnchor`, expands bar counts → `System`/`Bar` geometry on
  the grid, and `repeat`/`endings` → existing `RoadmapMarker`s (`lib/types.ts`) — so the **nav-graph
  resolver (`resolveRoadmap`) and conductor mode consume builder charts with zero new plumbing**.
- **Storage**: builder charts are normal `chart_library` rows; the `RoadmapSpec` rides alongside (Open
  Q2). Imports leave it null. This also dovetails with BYOS/git storage — a spec is far more diff-friendly
  than a PDF (cf. `design-storage-notation.md` Phase 3 .md-first direction).

## Architecture / flow

```
NL text ──▶ [AI parse route]  ──▶ RoadmapSpec ──▶ [validator] ──┬─(invalid)─▶ surface issues, author fixes
 (copilot)   model proposes        (untrusted)    deterministic │
                                                                └─(valid)─▶ [renderer] ──▶ PDF (substrate)
                                                                                       └─▶ ChartCalibration(verified)
                                                                                            │
                              upload PDF to storage + persist spec + write calibration ◀────┘
                                                                                            │
                                          normal chart_library row ──▶ viewer / offline / Perform / conductor
```

- **Parse route** (`/api/charts/roadmap/parse`, proposed): NL → `RoadmapSpec` via the Anthropic SDK
  (reuse the converter's key sourcing — platform key now, BYOA later). Returns the spec; **never writes**.
- **Validator** (`lib/roadmap-spec.ts`, pure): bar math, section sums, time-sig consistency, degree/
  quality whitelist, split-bar beat sums, repeat/ending balance. The DB-boundary gate (mirrors
  `isValidCalibration`).
- **Renderer** (`lib/roadmap-render.ts`, pure-ish): `RoadmapSpec` + key → `{ pdfBytes, calibration }`.
  Deterministic grid layout; exact coords.
- **Save**: render → upload PDF as a chart (reuse the upload route's upsert; preserves `chart_library.id`
  on edit) → persist spec → write `verified` calibration for the new `source_hash`.

## NNS scope (v1 → v2)

| Convention | v1 | Notes |
|---|---|---|
| Degrees 1–7, minor (`6m`/`2m`) | ✅ | core |
| 7ths / maj7 / m7 / dim / sus | ✅ | covers most jazz changes |
| Slash / bass degree (`5/7`) | ✅ | |
| Split bars (`(1 4)`, beat-weighted) | ✅ | `beats` per chord, must sum to time sig |
| Diamond / held (whole-note ring) | ✅ | `held: true` → render diamond + tie |
| Repeats `|: :|`, 1st/2nd endings | ✅ | maps to existing `RoadmapMarker` |
| Pushes `>`, marcato `^`, staccato | ⏳ v2 | rhythmic micro-notation |
| Multi-dot uneven beat spacing | ⏳ v2 | |
| Segno/Coda/D.S./D.C./Fine | ✅* | already in `RoadmapMarker`; expose in spec if asked |

Prior art for the *output* is mature (JotChord, 1Chart, Nashville Numbers App, iReal Pro's number view).
None pair it with an **AI copilot that parses free-form English into the structure** — that's the
differentiator (and, per Graham, likely a current market gap).

## Chunking (build sequence — for a later build PR, not this doc)

0. **Spec model + validator + tests** (pure; no UI/AI/render). The contract everything else binds to.
1. **Renderer**: `RoadmapSpec`+key → `{ pdfBytes, ChartCalibration }`, golden-fixture tests (exact
   coords). Resolves Open Q1 (PDF gen).
2. **AI parse route**: NL → `RoadmapSpec`; validator-gated; deterministic-fixture tests with a mocked
   model (per the repo's node-env vitest posture).
3. **Builder UI**: NL input + structured editor + live preview + save into the library (role pick).
4. **Transposition**: key selector → re-render; verify degree→chord mapping across keys.
5. **Edit loop**: re-open spec from a saved builder chart → re-render → replace file + rewrite verified
   calibration.

## UX flow (no dead ends)

- **Entry**: a "Build chart" action alongside "Choose file" in `ManageChartsModal` (library row + in-show
  chip). Same role model (guitar/keys/lyrics/…).
- **Create → Preview → Save**: preview renders the actual substrate before commit.
- **Edit**: a builder chart opens the spec builder (not a file picker); imports open file replace as today.
  The chart row needs a way to tell the two apart (Open Q2's stored spec is the signal).
- **Delete / Duplicate**: normal chart CRUD (delete via existing route; Duplicate could clone the spec —
  e.g. a key variant — superseding the metadata-only duplicate for builder charts).
- **Transpose**: key control in the builder; saving a different key is just a re-render (one spec, many
  keys), so we generally do **not** create per-key duplicate charts anymore.

## Conductor-mode synergy (strategic)

A builder chart is **verified-by-construction**, so it is immediately followable and broadcastable. An MD
can author a roadmap in plain English in seconds and have it drive conductor mode with no scan, no review,
no calibration nudging. This may be a **better primary input for the conductor-authority epic**
(`design-realtime-chart-control.md` / conductor authority) than PDF upload — clean structure in, exact
overlay out. Worth weighing when sequencing that epic.

## Open questions

1. **PDF generation dependency.** Server-side (e.g. `pdf-lib`) vs client-render-then-upload. Either adds a
   dep (flagging per repo policy: no undeclared deps). Server-side keeps it deterministic and testable in
   the route; client-side reuses the browser we already have. **Recommendation:** server-side `pdf-lib` in
   the renderer so chunk 1 is unit-testable end-to-end without a browser. Needs Graham/Codex call.
2. **Where the `RoadmapSpec` lives.** (A) nullable `source_spec jsonb` on `chart_library` (travels with
   the chart, null for imports) vs (B) a `chart_source` table. **Recommendation:** (A) — simplest, 1:1
   with the chart, and the presence of the column is the import-vs-builder signal the edit UX needs.
3. **Auto-verify stance.** Confirm builder calibrations are born `verified` (proposed) — geometry is
   exact, so the only error class is "author described it wrong," which review wouldn't catch any better
   than the author's own preview. (Converter charts stay `draft`; the distinction is provenance.)
4. **Quality vocabulary breadth for jazz.** Lock the v1 `quality` whitelist (triads + common 7ths +
   dim/sus). Full reharm/altered-dominant taxonomy is a rabbit hole — defer.

## Cross-references

- `design-chart-converter.md` — sibling path (raster→structure); shares the calibration target,
  PDF-canvas pipeline, and "model proposes, math gates" posture.
- `design-nav-graph.md` — the `ChartCalibration` model, `RoadmapMarker`s, and `resolveRoadmap` the
  renderer emits into.
- `design-realtime-chart-control.md` / conductor authority — the consumer that benefits most.
- `design-chart-library.md` / `design-library-chart-management.md` — where builder charts live and are
  managed.
- `design-storage-notation.md` — BYOS/.md-first storage; the diff-friendly `RoadmapSpec` aligns with it.
