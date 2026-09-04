# Design: Numbers ⇄ Letters — bake the toggle into the saved chart

**Status:** v3 — Codex R2 folded (key badge, de-builder clear, migration constraints). Build state tracked in `docs/INDEX.md`, not here.
**Depends on:** roadmap builder (renderRoadmap, roadmap-view, save route), chart_library
**Scope:** The builder's existing Numbers⇄Letters preview toggle becomes the chart's
notation of record: **save renders the PDF in the selected notation, and the show
renders that one PDF.** No per-show setting, no second artifact. Change notation by
re-opening and re-saving (it re-renders — that's already how the builder works).

---

## The Problem

The toggle already exists in the builder's Review preview
(`RoadmapBuilder.tsx:747`, `mode: 'numbers' | 'letters'`), but it only re-spells the
**HTML preview**. Two things ignore it:

1. **Save always bakes Nashville numbers.** `renderRoadmap` → `drawBarContent`
   (`roadmap-render.ts:338`) hardcodes `${c.degree}${c.quality}${c.bass}`, and the
   header (`:244`) prints `Nashville (authored in {key})`. So previewing in Letters and
   saving produces a **numbers** PDF — a silent mismatch between what you saw and what
   you stored.
2. **The show renders the stored PDF** via pdf.js. Because that PDF is numbers-only,
   the stage is numbers-only.

Graham's call: one PDF per chart, baked in the toggle's notation, rendered as-is on
stage. Flexible *per edit*, not per show.

---

## Design (one artifact, bake-on-save)

### 1. Make `renderRoadmap` notation-aware

```ts
export interface RenderOptions {
  songTitle?: string;
  artist?: string;
  notation?: 'numbers' | 'letters'; // default 'numbers' — existing callers unchanged
}
```

In `drawBarContent`, branch on notation:

- **numbers** (today, byte-identical when notation omitted/`'numbers'`): vector
  accidental via `accW`/`drawAccidental`, label `${c.degree}${c.quality}${c.bass?…}`.
- **letters**: `const label = renderCell(cellFromBar(c), 'letters', spec.renderKey)`
  — plain ASCII (`degreeLetter` emits `F#`/`Bb`, WinAnsi-encodable; see `CHROM_*`
  `roadmap-view.ts:385`), a single `drawText`, no `accW`/`drawAccidental`. `renderCell`
  (`roadmap-view.ts:489`) is the one shared spelling seam, so the preview and the PDF
  agree by construction.

Header (`:244`) branches: numbers → `Nashville (authored in {key})`; letters →
`Key of {renderKey}` (e.g. `Key of F#`) — it's real chords now.

`held` diamonds, split ticks, section labels, voltas, measure numbers, the rhythm
strip: **unchanged in logic.** (The held diamond's x trails the chord label via
`widthOfTextAtSize`, `:340`, so it re-places per-mode — correct, and in-PDF only: it
is never a calibration coordinate.)

### 2. The toggle drives save

The builder already holds `mode`. On save, send it:

- `RoadmapBuilder` save POST body gains `notation: mode`.
- `app/api/charts/roadmap/save/route.ts` reads it (validate `'numbers'|'letters'`,
  default `'numbers'`) and passes it to `renderRoadmap(spec, { songTitle, artist, notation })`.

Everything downstream is **unchanged**: the notation-specific bytes hash to a
`source_hash`, store at `…/${role}/${source_hash}.pdf`, and `save_builder_chart`
writes the projected `buildCalibration` keyed by that hash (migration 009). Because
there is exactly **one live PDF artifact** per chart (`chart_library.storage_path`,
old storage best-effort removed after commit), its calibration is keyed by its own
bytes as today — no mismatch, no derivation. (Old `chart_calibration` rows are
retained by `(chart_id, source_hash)` history and stay individually fetchable to a
holder of the old hash, but no live show selects them — show load follows the current
`storage_path`. That is existing behavior, unchanged here.)

### 3. Persist the notation so re-open is honest (the one correctness add)

`mode` defaults to `'numbers'`. Without persistence, re-opening a **letters** chart
shows the toggle on Numbers; a save-without-toggling silently re-bakes it to numbers.
So the chart must remember its notation and seed the toggle on re-open — mirroring
`source_prompt` (migration 016):

- **Migration 017:** `alter table chart_library add column source_notation text
  check (source_notation is null or source_notation in ('numbers','letters'))` —
  nullable, no default; `null` ⇒ legacy ⇒ `'numbers'` (today's reality).
- `save_builder_chart` RPC gains `p_source_notation text default null`, appended after
  `p_source_prompt`, following migration 016 exactly: drop the precise old signature,
  recreate with `set search_path`, `revoke` from public/authenticated/anon, `grant` to
  `service_role` only. The `default null` keeps any not-yet-updated caller valid.
- The read door (`app/api/charts/roadmap/[chartId]/route.ts`) returns `source_notation`.
- `RoadmapBuilder` seeds `mode` from it on edit (`null`/absent → `'numbers'`).

This closes the silent-flip footgun and keeps "flexible per edit" truthful: you always
re-open in the notation you last saved.

### 4. The show view — PDF unchanged, but the key badge must branch

The show renders the stored PDF as-is (`loadPdfDoc`/`renderPage`); calibration, seek,
markers, held-band darkness are **untouched** — the retrieval stack still sees one
artifact per chart keyed by its own bytes.

The one exception is the **key badge**. Today (`page.tsx:3756`) a builder chart shows
`song.key || authored_key` — correct for a **numbers** PDF, whose degrees are
key-invariant and *are* live-rekeyed by the setlist. A **letters** PDF is the opposite:
its chords are baked concrete in `spec.renderKey`, so a live re-key (`song.key ≠
authored_key`) would print `G` on the badge over an F-baked chart. The badge must tell
the truth per notation:

- **numbers** → `song.key || authored_key` (live key), as today.
- **letters** → `authored_key` (the baked/printed key), **ignoring** the live override —
  a letters chart cannot be re-keyed without re-rendering.

For the viewer to distinguish them, the show/song chart payload must expose notation:

- `app/api/shows/[owner]/[show]/route.ts` (`:117`) adds `notation: c.source_notation`
  to each chart object (alongside `is_builder`/`authored_key`).
- `lib/types.ts` `Chart` gains `notation?: 'numbers' | 'letters'` (null/absent ⇒
  `'numbers'`, matching the legacy default).
- The badge (and the standalone `ManageChartsModal` preview, which already uses
  `authored_key`) branch on it.

This is the only client change; the PDF load path stays byte-hash-keyed and untouched.

### 5. Non-builder charts

Unaffected: uploaded PDFs/images have no `source_spec` and no toggle.

### 6. Replace-with-file clears notation too

Replacing a builder chart with an uploaded file de-builders the row. The upload route
already nulls `source_spec` and `source_prompt` (`upload/route.ts:89`); migration 017
adds a third builder-only field, so the **same de-builder path must null
`source_notation`** — otherwise the row keeps stale notation after becoming a file
chart. Same class of stale-metadata bug `source_prompt` already fixed.

---

## Why the two-artifact / per-show design was dropped (Codex R1)

v1 proposed a per-show setting that swapped the show between a numbers PDF and a
lazily-rendered letters sibling. Codex R1 showed the whole retrieval stack keys on the
**fetched PDF's byte-hash** (or `fileId+modifiedTime`), not on spec identity:

- calibration is fetched by `hashPdfBytes(fetchedBytes)` (`page.tsx:3601`) — a letters
  PDF hashes differently and 404s its calibration → loses redline/markers/seek;
- `fetchChartBytes` direct-fetches only storage URLs, else the Drive proxy
  (`pdf-viewer.ts:75`); the load effect keys on `[chartFileId, chartModifiedTime,
  accessToken]` — a URL-only change wouldn't reload;
- the doc/offline caches key on `fileId+modifiedTime` — numbers/letters would collide.

Every one of those failures *came from introducing a second artifact.* This design has
one artifact per chart, so none of them arise. The trade — accepted — is that a chart
is baked in a single notation: different shows can't display the same chart
differently. You change notation by re-saving.

---

## Tests

- **T1 — letters PDF draws letters.** `renderRoadmap(spec,{notation:'letters'})` for a
  spec in F: degree 1 → `F`, degree 4 → `Bb`, a `♭7` → `Eb`; header `Key of F`. With
  `notation` omitted or `'numbers'`, byte-identical to today (regression pin).
- **T2 — spelling agreement.** The PDF letters label for a chord equals
  `renderCell(cell,'letters',key)` — one seam, so preview and PDF can't drift.
- **T3 — determinism per notation.** Same spec+notation → byte-identical bytes on
  repeat → stable `source_hash` (self-comparison, not golden bytes).
- **T4 — save honors the toggle.** Save with `notation:'letters'` renders letters and
  stores `source_notation:'letters'`; default/absent stores numbers.
- **T5 — re-open round-trips.** Read door returns `source_notation`; the builder seeds
  `mode` from it; a legacy row (`null`) opens on Numbers. (Guards the silent flip.)
- **T6 — calibration follows the one PDF.** buildCalibration is stored keyed by the
  rendered bytes' hash regardless of notation (mechanism unchanged; pin that letters
  saves still land a readable calibration row).
- **T7 — key badge branches on notation.** A **numbers** chart with a setlist
  `song.key` override renders the override on the badge; a **letters** chart renders
  its `authored_key` and ignores the override. (Drives the real chrome; the reported
  contradiction.)
- **T8 — de-builder clears notation.** Replacing a builder chart with a file nulls
  `source_notation` alongside `source_spec` and `source_prompt` (extends the existing
  `charts-upload-route.test.ts` "de-builders the slot" case).

---

## Known limitation (accepted)

`degreeLetter` spells by pitch class into fixed sharp/flat chromatic arrays, so an
off-menu enharmonic renderKey prints its enharmonic equivalent in letters (e.g.
`Cb` → tonic `B`, `B#` → `C`). This is **pre-existing** — the builder's HTML letters
preview already spells this way; baking it into the PDF does not change it. The key
pickers offer only the 24 standard majors/minors, so this can only arise from a
hand-crafted or AI-authored spec (the validator's `KEY_PATTERN` is permissive).
Proper enharmonic-aware spelling is a separate feature, out of this PR's scope.

## Open questions for review

1. **`cellFromBar` shape.** `drawBarContent` iterates the bar's chord objects; confirm
   they carry `{degree, alter, quality, bass}` as `renderCell` expects, or add a thin
   adapter. (Numbers path reads exactly these fields today — a packaging detail, not a
   data gap.)
2. **Migration 017 vs reuse.** A dedicated `source_notation` column is the clean shape.
   Any reason to fold notation into an existing column instead? (Prefer the column.)
