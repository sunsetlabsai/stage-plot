# Design — Roadmap Builder (AI-copiloted chart authoring)

Status: **DRAFT for review** · Branch `opus/design-roadmap-builder` · Owner: Graham (sign-off gate)
· Codex R1 addressed (HIGH transposition/storage overclaim → honest key-dimension phasing; MED
source_spec lifecycle + server-owned save route; LOW born-verified-still-gated)
· Codex R2: no BLOCK/HIGH — addressed MED (non-atomic storage↔DB save ordering: stage-new-hash → DB
commit → cleanup) + LOW (list APIs return `is_builder` flag; full spec via owner-only edit route).
· Codex R3 (3 BLOCKING + 2 NB) ALL folded: (B1) DB commit pinned to a single `save_builder_chart`
Postgres RPC (chart_library + calibration in ONE transaction; atomic rollback = no torn state at the
table level); (B2) volta shape was inexpressive `number[][]` → `SectionRepeat` discriminated union
(`plain{times}` | `volta{endings:VoltaEnding[]}`, `bars:{start,count}` + `passes[]`) mapping 1:1 to
resolveRoadmap's EITHER-plain-OR-volta rule; (B3) no spec field for global jumps → pinned
`RoadmapNavigation` block (segno/coda/toCoda/fine/jump via `BarRef`), validator mirrors resolver
preconditions; (NB) spec↔calibration parity assertion in the save route; (NB) renderer embeds a fixed
bundled font for metric determinism.
**Directionally ready; awaiting Graham sign-off.**

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
4. **Nashville Number System is key-agnostic → cheap re-key now, true multi-key later.** Changes are
   stored as scale **degrees + quality** (`1`, `4`, `5`, `6m`, `2m7`, `5/7` …), not absolute chords, so a
   spec can render in *any* key. **But the current pipeline is key-blind** (see §"Transposition & the key
   dimension"): shows resolve **one** static chart per `(owner, normalized title, role)` with no key
   dimension (`app/api/shows/[owner]/[show]/route.ts:94` ignores `SetlistSong.key`). So v1 delivers
   **cheap re-key of the single artifact** (the spec carries a `renderKey`; transpose = re-render +
   replace), **not** concurrent G-and-Bb served to different shows from one spec. Truly collapsing the
   per-key-duplicate problem requires key-aware resolution + per-key derived renders — a clearly-scoped
   **future** enhancement, not a v1 claim. (Corrects the original "transposition is free / one spec many
   keys" overclaim — Codex R1 HIGH.)
5. **Born `verified` — but still gated by the server boundary.** Geometry is exact, so no draft/queue; the
   only thing the author owns is whether they described the song correctly (same responsibility as
   hand-drawing). The emitted calibration is **still run through `isValidCalibration` and must satisfy
   `canVerify`/`resolveRoadmap`** before it is persisted as `verified` — identical to the existing
   server-side verify boundary. The renderer can never emit a calibration the manual path couldn't.

## Goals

- A **Build Chart** authoring surface: type/paste a natural-language description → AI parses → preview a
  clean house-style NNS chart → save it as a normal library chart (role-assigned, like any upload).
- The saved chart is a **PDF substrate + verified calibration**, indistinguishable downstream from an
  import (viewer, offline, Perform, conductor broadcast all "just work").
- **Re-editable**: re-open the spec, tweak (sections, counts, changes, key), re-render.
- **Cheap re-key (v1)**: change the spec's `renderKey` → re-render → replace the single artifact. (True
  concurrent multi-key per show is a future enhancement — see §"Transposition & the key dimension".)
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
- **Concurrent multi-key serving** (one spec rendering G to show A and Bb to show B simultaneously). v1 is
  a single static artifact per `(owner, title, role)`; key-aware resolution is deferred (see below).

## Data model (proposed)

A new persisted artifact — the editable source — keyed to the existing chart row:

```ts
// The authored source of a builder chart. Persisted (see Open Q2) so the chart
// is re-editable, re-renderable, and transposable. PDF + ChartCalibration are
// DERIVED from this; this is the source of truth.
interface RoadmapSpec {
  version: number;
  timeSig: { beats: number; unit: number };   // e.g. { beats: 4, unit: 4 }
  renderKey: string;                           // the key THIS artifact is rendered in, e.g. "G"
                                               // (v1: re-key = change this + re-render + replace)
  barsPerLine?: number;                        // layout hint (default 4)
  sections: RoadmapSection[];                  // ordered; the song form
  navigation?: RoadmapNavigation;              // OPTIONAL global jumps/targets (D.S./D.C./Coda/Fine/Segno)
}

interface RoadmapSection {
  id: string;
  label: string;                               // "Intro", "Verse", "Chorus", "Solo"
  bars: number;                                // count (the form math the validator checks)
  changes?: BarChange[];                       // optional NNS changes, one entry per bar (or sparse)
  repeat?: SectionRepeat;                      // section-scoped repeat; maps to RoadmapMarkers on render
}

interface BarChange {
  bar: number;                                 // 1-based within the section
  // split bar = >1 chord sharing the measure; beats sum to timeSig.beats
  chords: { degree: number; quality?: string; bass?: number; beats?: number; held?: boolean }[];
}

// A repeat is EITHER a plain |: … :|×times OR a volta repeat (1st/2nd… endings) —
// NEVER both. This discriminated union encodes that at the type level, matching
// resolveRoadmap §5#4 exactly (a repeatStart binds EITHER a repeatEnd OR endings,
// never both) so the renderer can't emit an unresolvable marker set. The repeat is
// section-scoped: the repeatStart anchors the section's FIRST bar (start edge).
type SectionRepeat =
  | { kind: 'plain'; times: number }           // |: … :|×times  → repeatStart + repeatEnd(times)
  | { kind: 'volta'; endings: VoltaEnding[] };  // |: …[1.][2.]   → repeatStart + ending markers; times = max(passes)

// One volta bracket. `bars` is a CONTIGUOUS range within the section (contiguity is
// guaranteed by {start,count}, which the loose number[][] could not express — Codex R3
// BLOCKING). `passes` = which repeat passes take this ending (e.g. [1] or [2,3]).
interface VoltaEnding {
  bars: { start: number; count: number };      // 1-based bar range within the section; start MUST be > 1
                                               //   (after the section-anchored repeatStart) and count ≥ 1
  passes: number[];                            // pass numbers; ⋃passes across endings must partition 1..max
}

// Global roadmap jumps/targets — segno/coda/D.S./D.C./Fine. The proposed spec
// previously had no field for these even though NNS scope marks them v1 (Codex R3
// BLOCKING). Each is a reference to a (section, bar) position the renderer resolves to
// a barId and emits as the matching RoadmapMarker (`lib/types.ts`). All optional;
// present only when the song uses them. The validator mirrors resolveRoadmap's
// preconditions (below) so a born-verified chart can never carry a dangling jump.
interface RoadmapNavigation {
  segno?: BarRef;                              // 𝄋 target            → { kind:'segno',  edge:'start' }
  coda?: BarRef;                               // ⊕ coda target       → { kind:'coda',   edge:'start' }
  toCoda?: BarRef;                             // "To Coda" departure → { kind:'toCoda', edge:'end' }
  fine?: BarRef;                               // Fine end point      → { kind:'fine',   edge:'end' }
  jump?: {                                     // D.C. (from:'capo') / D.S. (from:'segno')
    at: BarRef;                                //   departure bar     → { kind:'jump', edge:'end', from, until }
    from: 'capo' | 'segno';
    until: 'end' | 'fine' | 'coda';
  };
}

// A position within the expanded form: section index (0-based, into spec.sections)
// + 1-based bar within that section. The renderer maps this to the concrete barId
// once bar geometry is expanded.
interface BarRef { section: number; bar: number; }
```

- `degree` 1–7 (Nashville). `quality` ∈ `{'', 'm', '7', 'maj7', 'm7', 'dim', 'sus', …}` (v1 subset).
  `bass` = slash-chord degree. `held` = diamond (whole-note hold). `beats` enables split bars.
- **Rendering** maps `RoadmapSection` → `SectionAnchor`, expands bar counts → `System`/`Bar` geometry on
  the grid, and `repeat`/`navigation` → existing `RoadmapMarker`s (`lib/types.ts`) — so the **nav-graph
  resolver (`resolveRoadmap`) and conductor mode consume builder charts with zero new plumbing**:
  - `repeat.kind:'plain'` → `repeatStart` (section's first bar, `edge:'start'`) + `repeatEnd`
    (`repeatStartId`, `times`, last bar `edge:'end'`).
  - `repeat.kind:'volta'` → one `repeatStart` + one `ending` per `VoltaEnding` (`repeatStartId`,
    `barIds` = the section bars in `[start, start+count)`, `numbers` = `passes`).
  - `navigation.{segno,coda,toCoda,fine,jump}` → the matching marker kinds, each `barId` resolved from its
    `BarRef`.
- **Storage**: builder charts are normal `chart_library` rows; the `RoadmapSpec` rides alongside in a
  nullable `source_spec jsonb` column (Open Q2). Imports leave it null. This also dovetails with BYOS/git
  storage — a spec is far more diff-friendly than a PDF (cf. `design-storage-notation.md` Phase 3 .md-first
  direction).
- **`source_spec` lifecycle (explicit — Codex R1 MED).** The upload upsert preserves unspecified columns
  (`app/api/charts/upload/route.ts:70`), so the column must be written on **every** path that can change a
  chart's provenance, or a builder spec would orphan onto an imported file:
  - **Builder save / re-render** → `source_spec = <spec>` (and a builder chart's PDF is regenerated, never
    user-uploaded).
  - **Import upload / replace** (the normal `uploadChart` path) → **must explicitly set `source_spec =
    NULL`**, because replacing a builder chart with a PDF makes it an import; a stale spec would
    mis-classify it (the edit UX uses spec-presence as the builder-vs-import signal) and let a later
    re-render clobber the imported file. This requires adding an explicit `source_spec: null` to the
    import upsert's column list.
  - **Delete** → row removed; spec goes with it.
- **Provenance exposure to the client (Codex R2 LOW).** Current chart-list payloads expose neither
  `source_spec` nor an `is_builder` flag, so the edit UX can't yet tell builder from import. Don't ship the
  raw spec in list responses (heavier, and an owner-only concern). Instead the list APIs return a small,
  safe boolean — `is_builder` (derived server-side as `source_spec IS NOT NULL`) — that drives the
  Edit-roadmap-vs-Replace-PDF affordance; the **full spec is fetched lazily, owner-only, by the builder
  edit route** (`GET /api/charts/roadmap/[id]`, proposed) when the author actually opens the builder. Keeps
  list payloads lean and the spec behind the same ownership gate as the save route.

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
  quality whitelist, split-bar beat sums. It **mirrors every `resolveRoadmap` precondition the spec can
  violate**, so a valid spec always renders a resolvable (born-verified) calibration:
  - **Repeats/voltas** (`SectionRepeat`): `plain.times ≥ 2` **and `section.bars ≥ 2`** — a plain repeat
    emits `repeatStart` on the section's first bar and `repeatEnd` on its last, and `resolveRoadmap` rejects a
    `repeatEnd` whose position is `≤` the `repeatStart` (`lib/chart-calibration.ts:951`), so a 1-bar section
    would land both markers on the same bar and fail `canVerify`. (1-bar plain repeats are out of v1 scope
    unless the resolver model changes.) For `volta`, each `VoltaEnding.bars` is in
    range (`start > 1`, `count ≥ 1`, `start+count-1 ≤ section.bars`), ending ranges are **non-overlapping**,
    and `⋃ passes` **partitions `1..max` with no gap/overlap** (resolveRoadmap §5#3/#6 — contiguity is free
    from `{start,count}`).
  - **Navigation** (`RoadmapNavigation`): every `BarRef` resolves to a real `(section, bar)`; **`toCoda`
    implies `coda`** — `resolveRoadmap` rejects a standalone `toCoda` whenever no `coda` exists
    (`lib/chart-calibration.ts:889`), independent of any jump; `jump.from:'segno'` requires
    `navigation.segno`; `jump.until:'coda'` requires both `coda` and `toCoda`; `jump.until:'fine'` requires
    `fine` (mirrors resolveRoadmap's walk preconditions). At most one of each global target (the model is
    single-segno/single-coda).
  This is the DB-boundary gate (mirrors `isValidCalibration`); the save route additionally runs the
  rendered output through the real `isValidCalibration`/`canVerify` + the spec↔calibration parity assertion.
- **Renderer** (`lib/roadmap-render.ts`, pure-ish): `RoadmapSpec` + key → `{ pdfBytes, calibration }`.
  Deterministic grid layout; exact coords.
- **Save = one server-owned route** (`/api/charts/roadmap/save`, proposed) — NOT loose client steps
  (Codex R1 MED). The client posts `{ chart_id?, role, songTitle, spec }`; the route owns the whole
  transaction:
  1. **Validate** the spec (reject 4xx on invalid — never persist an unvalidated spec).
  2. **Render** `spec → { pdfBytes, calibration }` (deterministic).
  3. **Spec↔calibration parity assertion (Codex R3 NB).** `isValidCalibration`/`canVerify` prove the
     calibration is *shape-valid and resolver-consistent*, but **not** that the renderer actually emitted what
     the spec described — a renderer bug could pass the gate while drawing the wrong song. So before hashing,
     assert builder-specific parity: emitted `bars.length` == Σ section bar counts; every emitted bar is
     assigned to exactly one section; each section's bar span matches its spec count; every spec
     `repeat`/`ending`/`navigation` marker is present in `roadmap` with the span/passes the spec named; and the
     PDF + calibration were laid out with the **same** grid/layout constants (one shared module, asserted by a
     golden-fixture test in chunk 1). Parity failure = renderer bug → 5xx, persist nothing.
  4. **Compute `source_hash`** from `pdfBytes` (same hashing the viewer/calibration path uses).
  5. **Gate** the rendered calibration through `isValidCalibration` / `canVerify` (born-verified but still
     gated — Decision #5). Gate failure → 5xx, persist nothing (see Failure behavior).
  6. **Stage** `pdfBytes` at the new hash-addressed object path, then **commit via the
     `save_builder_chart` RPC** (one transaction): `chart_library` upsert on `(owner_id, song_key, role)` —
     preserving `id` on edit, setting `storage_path` + `source_spec = spec` — **and** the `(chart_id,
     source_hash)` calibration upsert as `verified`, atomically. Then best-effort cleanup of the old object.
  - **Do NOT call the `uploadChart()` helper** — it fires the converter (`triggerOverlayCreate`), which
    would race a `draft` overlay against our `verified` one for the same `(chart_id, source_hash)`. The
    builder writes its calibration directly and never invokes the converter.
  - **Ordering for the non-atomic storage↔DB boundary (Codex R2 MED).** Storage write and DB upsert are
    not one transaction, and the dangerous case is *storage succeeds, then the `chart_library`/`source_spec`/
    calibration DB write fails* — especially on **replace**, where overwriting the live path in place would
    change the served bytes while DB metadata + calibration still describe the prior artifact (broken overlay
    until the next successful save). Avoid in-place overwrite. The renderer is deterministic, so a re-render
    yields a **new `source_hash`** → stage the new PDF at a **new, hash-addressed object path** (never the
    old live path), *then* run the DB writes that flip the `chart_library` row to point at the new path and
    upsert the new-hash `verified` calibration. Commit order: **(1)** stage new object → **(2)** the single
    atomic DB commit (below) → **(3)** best-effort cleanup of the now-orphaned old object.
  - **The DB commit MUST be one Postgres transaction, not two sequential upserts (Codex R3 BLOCKING).**
    `chart_library` (row pointer + `storage_path` + `source_spec`) and `chart_calibration` (the verified
    overlay) are **separate rows in separate tables**; writing them as two client calls means a crash between
    them can flip the live row onto the new PDF while the matching `verified` calibration is missing — the
    "torn state" the staging order was meant to prevent, just moved one layer in. Pin a **single
    `SECURITY DEFINER` Postgres RPC** — `save_builder_chart(p_owner, p_song_key, p_role, p_chart_id,
    p_storage_path, p_source_hash, p_source_spec jsonb, p_calibration jsonb)` — that performs the
    `chart_library` upsert (preserving `id` on edit) **and** the `(chart_id, source_hash)` calibration upsert
    **inside one transaction**, with an `owner_id` ownership guard (RBAC scope) on the target row. Either both
    rows land or neither does. (Supabase/Postgres function = real transaction; note `feedback_neon_migrations`
    — no advisory locks needed here, this is a plain BEGIN/COMMIT body, not a lock.) The route calls
    `supabase.rpc('save_builder_chart', …)`; it does **not** issue the two upserts itself.
  - **Failure behavior** at each step:
    - Stage (storage) fails → abort, surface error, **no DB writes**, nothing changed (old artifact still
      live).
    - The RPC fails (validation inside the txn, calibration constraint, or crash) → the transaction **rolls
      back atomically**: the live row still points at the **old** object with its **old** `source_spec` and
      the **old** `verified` calibration intact, so the chart keeps serving the prior valid artifact; surface
      error; the just-staged new object is orphaned and swept by the cleanup pass (a periodic GC of
      hash-addressed objects with no referencing row). **No partial/torn state is ever served** — now true at
      the table level, not just the storage level.
    - Calibration gate fails (should be impossible for renderer output, but defend the boundary) → this is
      checked **before** entering the RPC (route step 5 runs `isValidCalibration`/`canVerify` on the rendered
      calibration); a failure means the RPC is never called, the prior artifact stays live, and we log. The
      builder never persists a chart whose overlay didn't pass the gate.

## Transposition & the key dimension (Codex R1 HIGH)

The headline "one spec, many keys" must be reconciled with the **key-blind** chart pipeline. Today a show
resolves exactly **one** static chart artifact per `(owner, normalized title, role)`
(`app/api/shows/[owner]/[show]/route.ts:94`); `SetlistSong.key` exists but **chart resolution ignores
it**. So re-rendering a spec in Bb would *replace the single artifact for every show that uses that title*,
not serve G to one show and Bb to another. The design must pick a rung:

| Option | Behavior | Pipeline change | Verdict |
|---|---|---|---|
| **(a) Single static artifact, cheap re-key** | Spec carries `renderKey`; transpose = re-render + replace the one artifact. Author re-keys in a click instead of redrawing. | **None** — fits today's resolution. | **v1 (recommended).** |
| (b) Retain per-key duplicate charts | Keep `Song X (Bb)` as separate library charts (today's workaround). | None | Rejected — defeats the point. |
| (c) Key-aware multi-render | Derived render cache keyed `(chart_id, render_key)`, each with its own PDF/`source_hash`/`verified` calibration; **chart resolution becomes key-aware**, picking the render that matches `SetlistSong.key`. | **Significant** — new derived-render table/cache + resolution change at the cited route. | **Future enhancement.** Delivers true concurrent multi-key and finally collapses per-key dupes. |

**Recommendation:** ship **(a)** in v1 (real workflow win: author once in NNS, retune the printed key on
demand, pipeline-compatible), and design `RoadmapSpec` so it is forward-compatible with **(c)** — the spec
is key-agnostic; only the *render+resolution* layer needs the later table/cache. v1 explicitly does **not**
claim concurrent multi-key. Display-time transposition in the viewer is rejected: the substrate is a static
PDF by Decision #1, and a live-transposing viewer would require a native NNS renderer, forking the pipeline.

## NNS scope (v1 → v2)

| Convention | v1 | Notes |
|---|---|---|
| Degrees 1–7, minor (`6m`/`2m`) | ✅ | core |
| 7ths / maj7 / m7 / dim / sus | ✅ | covers most jazz changes |
| Slash / bass degree (`5/7`) | ✅ | |
| Split bars (`(1 4)`, beat-weighted) | ✅ | `beats` per chord, must sum to time sig |
| Diamond / held (whole-note ring) | ✅ | `held: true` → render diamond + tie |
| Repeats `|: :|`, 1st/2nd endings | ✅ | `SectionRepeat` union → existing `RoadmapMarker` repeat/ending |
| Pushes `>`, marcato `^`, staccato | ⏳ v2 | rhythmic micro-notation |
| Multi-dot uneven beat spacing | ⏳ v2 | |
| Segno/Coda/D.S./D.C./Fine | ✅ | `RoadmapNavigation` block → existing marker kinds; validator mirrors resolver preconditions (Codex R3) |

Prior art for the *output* is mature (JotChord, 1Chart, Nashville Numbers App, iReal Pro's number view).
None pair it with an **AI copilot that parses free-form English into the structure** — that's the
differentiator (and, per Graham, likely a current market gap).

## Chunking (build sequence — for a later build PR, not this doc)

0. **Spec model + validator + tests** (pure; no UI/AI/render). The contract everything else binds to —
   incl. the `SectionRepeat` union, `VoltaEnding`, and `RoadmapNavigation`/`BarRef` shapes, with validator
   tests for the repeat/volta partition + navigation precondition rules (Codex R3).
1. **Renderer**: `RoadmapSpec`+key → `{ pdfBytes, ChartCalibration }`, golden-fixture tests (exact
   coords). Resolves Open Q1 (PDF gen).
2. **AI parse route**: NL → `RoadmapSpec`; validator-gated; deterministic-fixture tests with a mocked
   model (per the repo's node-env vitest posture).
3. **Builder UI + save route**: NL input + structured editor + live preview + save into the library (role
   pick). Includes the `save_builder_chart` Postgres RPC migration (atomic chart_library + calibration
   commit) and the spec↔calibration parity assertion (Codex R3).
4. **Re-key (v1 transposition)**: key selector → re-render → replace the single artifact; verify
   degree→chord mapping across keys. (Concurrent multi-key = deferred option (c).)
5. **Edit loop**: re-open spec from a saved builder chart → re-render → replace file + rewrite verified
   calibration (via the save route; sets `source_spec`).

## UX flow (no dead ends)

- **Entry**: a "Build chart" action alongside "Choose file" in `ManageChartsModal` (library row + in-show
  chip). Same role model (guitar/keys/lyrics/…).
- **Create → Preview → Save**: preview renders the actual substrate before commit.
- **Edit**: a builder chart opens the spec builder (not a file picker); imports open file replace as today.
  The chart row needs a way to tell the two apart (Open Q2's stored spec is the signal).
- **Delete / Duplicate**: normal chart CRUD (delete via existing route; Duplicate could clone the spec —
  e.g. a key variant — superseding the metadata-only duplicate for builder charts).
- **Transpose (v1 = re-key)**: a key control in the builder re-renders and **replaces the single
  artifact** for that title/role. This re-keys the chart everywhere it's used; it does not yet serve
  different keys to different shows (that's the deferred option (c) — see §Transposition).

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
   - **Font determinism (Codex R3 NB).** Geometry is "exact by construction" **only if glyph metrics are
     fixed**. A fallback/system font whose metrics differ by environment would drift text from the
     coordinates the calibration asserts. So the renderer must **embed a single bundled font** (e.g. a
     committed `.ttf`/`.otf` for the chord/degree text) and measure with it — never rely on pdf-lib's
     StandardFonts resolution or any host font. The bundled font is part of the shared layout-constants
     module the parity check pins, and the golden-fixture coords are computed against it.
2. **Where the `RoadmapSpec` lives.** (A) nullable `source_spec jsonb` on `chart_library` (travels with
   the chart, null for imports) vs (B) a `chart_source` table. **Recommendation:** (A) — simplest, 1:1
   with the chart, and the presence of the column is the import-vs-builder signal the edit UX needs.
3. **Auto-verify stance.** Confirm builder calibrations are born `verified` (proposed) — geometry is
   exact, so the only error class is "author described it wrong," which review wouldn't catch any better
   than the author's own preview. (Converter charts stay `draft`; the distinction is provenance.)
   Note (per Decision #5 / Codex R1 LOW): born-`verified` does **not** bypass the server boundary — the
   save route still runs `isValidCalibration` / `canVerify` and the calibration must round-trip
   `resolveRoadmap` before it is persisted as `verified`. Construction makes verification trivially pass,
   it does not skip it.
4. **Transposition rung for v1.** Ship option (a) — single static rendered artifact + cheap re-render to
   re-key (forward-compatible with (c)) — and defer concurrent multi-key serving? Or pull (c) (derived
   render cache keyed `(chart_id, render_key)` + key-aware resolution) forward into v1? **Recommendation:**
   (a) for v1; (c) is a clean additive follow-up once a real multi-key need lands. See "Transposition & the
   key dimension."
5. **Quality vocabulary breadth for jazz.** Lock the v1 `quality` whitelist (triads + common 7ths +
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
