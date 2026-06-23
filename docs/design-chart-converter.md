# Design — Chart Converter (auto-overlay)

Status: **DRAFT for review** · Branch `opus/design-chart-converter` · Owner: Graham (sign-off gate)
· Codex R1 addressed (hash rule decided; insert-on-conflict guard; route limits; dropped-vs-surfaced
reconciled; confidence validation+lifecycle) · Codex R2 addressed (v1 PDF-only end-to-end, typed
image no-op; magic-byte MIME classify; insert-result via RETURNING) · **Codex R3 = UNBLOCKED for
spec/design, no block/high remain** (R3 cleanup folded: per-reason UI copy; open-Q numbering)

## Why now

Calibration chunks 1–4 are shipped (section rail → bar geometry → nav graph), but every overlay today
is placed **by hand**. Per the design principle *"correction must never exceed creation"* and Graham's
standing note — *"no real testing of calibrate without the auto-overlay"* — the converter is what makes
calibrate actually usable: it auto-generates a **draft** overlay on chart add so the human reviews and
nudges instead of building from scratch.

## The core guarantee (load-bearing)

> Graham: *"so long as we store the overlays and aren't generating them each and every time and losing
> the manual adjustments."*

The converter is **generate-once and edit-safe**:

- Overlays are **persisted** in the existing `chart_calibration` table (PK `(chart_id, source_hash)`),
  not regenerated per view. Perform/calibrate already read this stored row.
- The converter is **idempotent + guarded**: it writes a draft overlay **only when no calibration row
  exists** for that `(chart_id, source_hash)`. If a row already exists — a draft a human has edited, or
  a `verified` one — the converter is a **no-op**. It never clobbers manual work.
- **The guard is the WRITE, not a pre-check.** Vision runs for seconds; a human could save a manual
  draft for the same `(chart_id, source_hash)` *during* that window. A pre-vision existence check alone
  loses that race (check → [human saves] → overwrite). So the authoritative guard is an **insert-only,
  conflict-as-no-op** write: `INSERT … ON CONFLICT (chart_id, source_hash) DO NOTHING`. If anything
  landed in the interim, the converter's insert no-ops and its result is **discarded**. The pre-vision
  existence check stays as a *cost optimization* (skip the expensive vision call when a row already
  exists), but correctness never depends on it. The converter NEVER issues an UPDATE/upsert.
- Manual adjustments are sacrosanct. The converter seeds the *first* draft; from then on the human (and
  the verify flow) owns that `(chart_id, source_hash)` row.

## Decisions locked (Graham)

1. **Extraction engine = vision-first** (Claude multimodal). Real charts are too messy (scanned/raster
   PDFs, chord charts, handwriting) for structural PDF parsing alone. Vision generalizes; rough coords
   are fine — precision comes from human nudge + the later on-demand edge-snap detector.
2. **Execution = async, persisted, never-regenerate, never-lose-edits** (the guarantee above).
3. **Source types = PDF only for v1; PNG/JPG = typed no-op (not error).** Upload accepts images too, but
   the calibration path is **PDF-canvas end-to-end** — the in-show viewer renders PDF pages, the hash
   rule hashes PDF bytes handed to pdf.js, and the overlay coords are placed over that canvas. Generating
   an overlay for a PNG/JPG would produce something that **cannot be viewed, calibrated, verified, or
   used** — a generate-but-unusable trap. So the converter **classifies the stored object and, for any
   non-PDF (PNG/JPG/unknown), no-ops cleanly** (`{ generated: false, reason: 'unsupported_type' }`,
   manual rail), never an error. **End-to-end image support is a future feature** — it needs its own
   chunk adding viewer image-render + image-hash + overlay-on-image to the calibrate/verify path, not a
   converter-only half-measure. (This reverses R1's converter-only image block, which Codex R2 correctly
   flagged as asymmetric.)

## Goals

- On chart **add**, auto-produce a `draft` `ChartCalibration` (sections + systems + bars + roadmap, each
  with a confidence score) and persist it under the chart's content hash.
- Surface a **review queue** that shows only low-confidence / flagged elements for human cleanup.
- A **one-time backfill** (A2) over the ~25 existing library charts.
- Graceful degrade: vision failure / empty result → **no overlay written**, fall back to the manual rail
  (today's behavior). The converter never blocks or breaks upload.

## Non-goals (this build)

- Precise coordinate extraction (the edge-snap raster detector is a later chunk).
- Carry-forward of a prior hash's manual anchors onto a replaced file (see Replace semantics).
- Real-time / multi-user generation infra (no queue/worker — see Execution model).
- Auto-**verify**. The converter only ever writes `status: 'draft'`; promotion to `verified` stays human.

## Execution model (Vercel-safe, client-driven)

Vision extraction takes seconds, so it can't block the upload response — and Vercel serverless **freezes
after the response is sent**, so a fire-and-forget background task on the upload route is unreliable.
Instead the **client chains a second request** it awaits:

```
uploadChart(file, songTitle, role):           // shared helper (lib/chart-upload.ts)
  1. POST /api/charts/upload  (existing)       → { chart_id, url, ... }
  2. POST /api/charts/convert { chart_id }     → runs vision synchronously, writes draft overlay
     (UI shows "Generating overlay…"; on done, refresh calibration state)
  3. return new Chart
```

- **Both** ADD paths — the new library Manage-Charts modal **and** the in-show `ChartNavigator`
  `onChartUpload` — call this one helper, so no ADD path can skip overlay creation. (This is the
  `triggerOverlayCreate` seam named in `design-library-chart-management.md`, now concrete.)
- `/api/charts/convert` runs the vision call **within its own request**, guarded for idempotency.
  Owner-only. This is a *bounded* slow request, not an unbounded one — see **Limits & timeout** below.
- Failure or timeout on step 2 is **non-fatal**: the chart still uploaded; the overlay is simply absent
  (manual rail). UI copy distinguishes the cause by `reason`:
  - `failed` (vision error/timeout) → *"Couldn't auto-generate — calibrate manually."* (a hiccup; a
    retry might work).
  - `too_large` → *"Chart too large to auto-generate — calibrate manually."*
  - `unsupported_type` (non-PDF source) → *"Auto-overlay supports PDF charts only — calibrate
    manually."* (expected, not a failure; never framed as an error).
  - `exists` is silent (a draft/verified overlay is already present — nothing to report).

### `/api/charts/convert` (new route)
1. **Auth:** authenticated owner of `chart_id` (RLS + pre-check), else 403.
2. **Fetch bytes:** download the chart blob from Supabase Storage via the **authoritative storage API**
   (not the CDN/public URL — see Hash rule).
3. **Classify type (don't trust the label):** determine the source type by **sniffing the leading
   magic bytes** of the fetched object (PDF = `%PDF-` header), NOT the upload's claimed MIME/extension
   (which can be wrong or spoofed). Non-PDF (PNG `\x89PNG`, JPG `\xFF\xD8`, or anything else) →
   **typed no-op** `{ generated: false, reason: 'unsupported_type' }`, no vision spend. PDF-only v1.
4. **Hash:** compute `source_hash` from the **fetched object bytes** (see Hash rule — decided).
5. **Pre-check (cost optimization only):** if a `chart_calibration` row already exists for
   `(chart_id, source_hash)` → short-circuit `{ generated: false, reason: 'exists' }` to skip the
   vision spend. This is an optimization; correctness rests on step 8's insert-on-conflict.
6. **Vision extract:** send the PDF to Claude as a **document** block (all pages, no server-side
   rasterization) with a structured-output prompt → JSON.
7. **Build + validate:** map JSON → `ChartCalibration` (`status: 'draft'`, normalized 0..1 coords,
   per-element confidence, schemaVersion stamped by presence of roadmap). Drop structurally-unbindable
   roadmap markers (no FK target), then run `isValidCalibration`; on invalid/empty, write **nothing**
   (degrade to manual).
8. **Persist (the real guard):** `INSERT … ON CONFLICT (chart_id, source_hash) DO NOTHING **RETURNING ***`.
   The `RETURNING` row is present **iff this statement actually inserted**; on conflict (a manual
   draft/verified row landed during steps 6–7) it returns **no row** → the converter's result is
   discarded (manual work wins). So `generated` is derived from *whether RETURNING yielded a row*, not a
   separate re-read/compare. (A re-read could observe a *different* concurrent row and misattribute it.)
9. **Return:** `{ generated, calibration }` — `generated: true` with the just-inserted draft when
   RETURNING yielded a row; otherwise `{ generated: false, reason: 'exists' }`.

### Limits & timeout (bounding the "slow request")
The convert request is slow but must be **bounded** so it stays within Vercel's function ceiling and
fails predictably:
- **`maxDuration`** set explicitly on the route (within the deployment plan's function limit); the
  Anthropic call uses an **abort timeout** comfortably under it so the route always returns a clean
  degrade rather than a platform 504.
- **File-size cap** and **page cap** (PDFs): oversized files / very long charts → skip vision, degrade
  to manual (`reason: 'too_large'`). Caps are constants (config), tuned against the backfill corpus.
- Any vision timeout/abort/error → **no overlay written**, `{ generated: false, reason: 'failed' }`,
  UI shows "couldn't auto-generate." Upload itself is already committed and unaffected.

## Vision contract

- **Input:** the chart PDF (all pages) as a Claude **document** block + a prompt asking for the chart's
  structure as JSON. (v1 is PDF-only; non-PDF sources are typed no-ops — see Decisions #3.)
- **Output JSON** (a subset/shape of `ChartCalibration`):
  - `systems[]`: `{ page, yTop, yBottom, xStart, xEnd, confidence }` (full-width default xStart=0/xEnd=1,
    matching chunk-3's deliberate full-width systems).
  - `bars[]`: per system, `{ xStart, xEnd, confidence }` → server assigns `absNumber` (reading order)
    and `systemId`/`id`.
  - `sections[]`: `{ page, x, y, label, confidence }` (e.g. "Intro", "Verse", "Chorus").
  - `roadmap[]`: detected markers (`|: :|`, voltas, Segno, Coda, To Coda, Fine, D.C./D.S.) bound to
    bars/edges, each with `confidence`. Bindings (e.g. `repeatStartId`) resolved server-side from
    detected positions.
- The model already carries `confidence?` on roadmap markers. **Small additive model change:** add
  optional `confidence?: number` to `SectionAnchor`, `System`, `Bar` (no schema bump — additive +
  optional, like the marker field) so the review queue can flag geometry too.
- Coordinates are **rough** by design. Validation: `isValidCalibration` at the DB boundary; resolver
  validity is NOT required (drafts persist even if roadmap doesn't yet resolve — same as manual drafts,
  BLOCKER-1 rule).

### Two distinct "can't bind" cases (no contradiction)
A marker that "can't bind" means one of two different things; the converter treats them differently:
1. **Structurally unbindable** — the marker references a target that does not exist (e.g. a `:|` with
   no `|:` anywhere, a volta with no enclosing repeat). It would fail `isValidCalibration`'s FK checks,
   so it **cannot be persisted**. These are **dropped at build time** (step 6), silently — degrade, not
   error. They are NOT in the saved draft, so they cannot appear in the review queue.
2. **Structurally bound but the roadmap doesn't *resolve*** — all FKs exist (valid draft, persists fine
   per BLOCKER-1) but `resolveRoadmap` returns an error (e.g. contradictory jumps). These markers
   **are persisted** and **are surfaced** in the review queue for the human to fix/delete. (Same state
   a hand-authored unresolvable draft can be in today.)

So: *dropped* = couldn't even be stored (no FK target); *surfaced* = stored but flagged (resolve error
or low confidence). The two never describe the same marker.

### Confidence — validation & lifecycle
- **Validation:** `confidence`, where present, must be a finite number in `[0,1]` — enforced in
  `isValidSectionAnchor`/`isValidSystem`/`isValidBar` (and the existing marker check) at the DB
  boundary. Absent is always valid (the field is optional; manual elements carry none).
- **Lifecycle:** `confidence` is **converter-seeded metadata**, not a verify gate. When a human edits an
  element (move/resize/relabel/re-bind), that element's `confidence` is **cleared** (the existing
  authoring helpers already reset `status → draft`; clearing confidence is the same edit-owns-it move),
  so it drops out of the review queue — it's now human-owned. `verify`/`canVerify` never read
  `confidence`. Promotion to `verified` does not require confidences to be high, only that the human has
  signed off (labeled sections + resolving roadmap, unchanged).

## Review queue (human cleanup)

- After generation, the calibrate UI surfaces **only flagged elements** — those with `confidence` below
  a threshold, **plus** any roadmap markers implicated in a `resolveRoadmap` error (the *surfaced* case
  above). Structurally-unbindable markers were dropped pre-persist, so they never appear here.
  Everything else is accepted silently.
- The human reviews flagged items, nudges geometry, fixes/deletes markers (each edit clears that
  element's `confidence` and resets `status → draft`), then **Verify** (existing flow). Verify still
  requires labeled sections + a resolving roadmap (`canVerify`) — never a confidence threshold.
- Threshold value(s) = tunable; start conservative (flag generously) and tighten with real charts.

## Replace semantics (no lost edits)

A **replace** (re-upload for the same role) produces **new file bytes → a new `source_hash`** → a new
calibration target. The converter runs for the new hash (no existing row → generates). The human's work
on the **old** hash is **retained in history** (the table keys by hash and we keep history across
hashes) — it's not "lost," it simply doesn't auto-apply to different bytes (a replaced file may have a
different layout). Auto carry-forward of old anchors onto the new bytes is **out of scope** (future
enhancement; would seed the new draft from the old as low-confidence).

## A2 — one-time backfill (~25 charts)

A standalone node script (run once, locally / against prod Supabase + Anthropic):

- Iterate `chart_library` rows; for each, compute the current bytes' `source_hash`; **skip** any that
  already have a calibration row for that hash (idempotent — safe to re-run).
- For the rest, run the same convert logic → write draft overlays.
- Log per-chart result (generated / skipped / failed). No clobbering, ever.

## Build outline (gated chunks → one PR per the standing process)

1. **Model + helper seam + hash refactor:** add optional `confidence` to SectionAnchor/System/Bar with
   `[0,1]` validation in the `isValid*` helpers + clear-on-edit in the authoring helpers; the **hash-rule
   refactor** (viewer/`loadPdfDoc` → fetch bytes → hash ArrayBuffer → pass `{ data }` to pdf.js;
   cache-bust on `updated_at`); `lib/chart-upload.ts` shared `uploadChart()` + `triggerOverlayCreate`
   calling the convert route; refactor in-show `onChartUpload` to use it (no behavior change yet —
   convert route returns no-op until chunk 2). Tests (validation, clear-on-edit, hash parity).
2. **`/api/charts/convert` route:** auth, fetch authoritative bytes, **magic-byte type classify**
   (non-PDF → typed no-op), server hash, pre-check, vision call (PDF document block), JSON→calibration
   map (drop unbindable markers) + validate + **insert-on-conflict-do-nothing RETURNING** persist
   (`generated` from RETURNING), limits/timeout/degrade. Tests for the type-classify no-op, the
   map/validate, the unbindable-drop, the conflict no-op, and the degrade paths (mock the vision response).
3. **Review queue UI:** flag low-confidence + resolve-error markers in calibrate mode; "Generating…" /
   "couldn't auto-generate" / "too large" states in the upload flow.
4. **A2 backfill script** (idempotent; same convert logic + insert-on-conflict; per-chart log).

Gate (`npx tsc --noEmit && npm run lint && npm test && npm run build`) + commit per chunk.

## Chunk 3 — Review queue UI (build spec)

Chunks 1–2 already shipped everything the queue needs: `confidence?` on every element
(`types.ts` SectionAnchor/System/Bar/marker), `[0,1]` validation in the `isValid*` helpers,
clear-on-edit (`withoutConfidence` on relabel/move/resize in `chart-calibration.ts`), and
resolve-error markers already render with a **red ring** in `RoadmapOverlayLayer`
(`page.tsx:1812/1830`, fed by `resolveErrorIds` = `resolveRoadmap(...).error.markerIds`,
`page.tsx:2403`). So chunk 3 adds **no model/DB change** — it is a pure flagging helper + its
in-canvas surfacing + the upload-flow states. The chunk-1 confidence lifecycle means a flag
**self-clears the instant the human touches the element** (edit → confidence cleared → drops out
of the queue), so the queue can never strand a "reviewed but still flagged" item.

### What gets flagged (the pure seam — `lib/chart-review.ts`)

A new pure module (testable under vitest `env=node`; the UI itself is not unit-testable here):

```
REVIEW_CONFIDENCE_THRESHOLD = 0.8        // start conservative — flag generously; one-line tune
reviewFlags(calibration): {
  sectionIds: Set<string>;
  systemIds:  Set<string>;               // a band is flagged if it OR any of its bars is low-confidence
  markerIds:  Set<string>;               // low-confidence  ∪  resolveRoadmap error markerIds
  count: number;                         // total distinct flagged elements
  ordered: FlaggedRef[];                 // page→top→left walk order for the stepper
}
```

- **Low confidence** = `confidence !== undefined && confidence < REVIEW_CONFIDENCE_THRESHOLD`.
  Absent confidence is **never** flagged (manual elements carry none — already human-owned).
- **Bars roll up to their system band.** Bars are authored by count (the band's +/- stepper rebuilds
  all of them — `page.tsx:2895`), not placed individually, so a per-tick flag isn't actionable. A band
  is flagged if the system *or any child bar* is low-confidence; the human fixes it by nudging the band
  / adjusting the count, which clears it.
- **Markers** = low-confidence **∪** the existing resolve-error set. Resolve-error keeps its red
  treatment (higher priority); low-confidence-only markers get the review treatment below.
- Threshold is a single named constant (per-element-type split deferred — answers **open-Q3**; becomes a
  `Record<kind, number>` one-liner once we have real charts). No magic numbers in the UI.

### In-canvas treatment (unified "needs review")

One visual idiom across all three element types, so the human reads it the same everywhere:
a **dashed amber outline** (`outline-dashed outline-2 outline-amber-400`) + a small **⚑** corner glyph.
Dashed-outline is deliberately distinct from the existing solid **rings** and **fills** so it never
collides with what those already mean:

| element | normal (today) | selected | resolve-error | **+ review flag (new)** |
|---|---|---|---|---|
| section pill (`SectionMarker` `page.tsx:1588`) | sky fill / amber if unlabeled | — | — | dashed amber outline + ⚑ |
| system band (`SystemBand` `page.tsx:1676`) | zinc ring | sky ring | — | dashed amber outline + ⚑ |
| roadmap badge (`RoadmapOverlayLayer` `page.tsx:1817/1835`) | amber border | sky ring | **red ring (kept)** | dashed amber outline + ⚑ |

Precedence: **resolve-error (red) > selected (sky) > review-flag (dashed amber)**. The flag still counts
toward the queue total even while an element is selected/in-error; it only leaves the count when *edited*.
Flags show only in **calibrate** mode and only in the **tool that owns that element type** (sections →
pills, bars → bands, roadmap → badges), matching the existing per-tool visibility (`page.tsx:1893-1897`).

### Review stepper (makes the count actionable — no dead end)

A chip in the calibrate toolbar's right (status) cluster, beside the save-state indicators:

- **`⚑ N to review`** with **‹ ›** steppers. Stepping selects the next/prev `ordered` flagged element,
  **switching `calTool`** to the one that shows it and **paging** to its page, then selecting it (reusing
  the existing select state — `selectedSystemId` / `editingId` / `selectedMarkerId`). So every flagged
  item is reachable in one tap regardless of which page/tool it lives on.
- At **N = 0** the chip reads **`✓ Reviewed`** — a clear terminal state, shown only once the draft has
  *had* flags and they were all cleared (a monotonic `everReviewed` latch, set when a flagged calibration
  loads and reset when the chart changes). A hand-built calibration that never had flags shows nothing.
- This does **not** gate Verify. `canVerify` is unchanged (labeled sections + resolving roadmap only);
  the queue is guidance, never a wall (design §"Confidence — validation & lifecycle").

### Upload-flow states (the convert result surfaced)

`uploadChart()` already returns `{ chart, overlay }` (`chart-upload.ts:68`); the in-show add handler
currently destructures only `chart` and ignores `overlay` (`page.tsx:5040`). Chunk 3 consumes it:

- A lightweight per-song transient status (`Map<songTitle, 'generating' | { reason }>`) rendered inline
  under that song's chart chips — **no native `alert()`/`prompt()`** for the overlay step (upload errors
  keep their existing handling).
- While `triggerOverlayCreate` is in flight: **"Generating overlay…"** (with the existing spinner idiom).
- On result, by `reason` (exact copy from the Execution-model section):
  - `failed` → *"Couldn't auto-generate — calibrate manually."*
  - `too_large` → *"Chart too large to auto-generate — calibrate manually."*
  - `unsupported_type` → *"Auto-overlay supports PDF charts only — calibrate manually."*
  - `generated: true`, `exists`, or `null` → **silent** (clear the status; the draft loads on next
    viewer open via the existing hash-keyed load effect `page.tsx:2583`).
- Messages auto-dismiss (~5 s) or on the next chart action. Single integration point: the page's one
  `onChartUpload` (`page.tsx:5024`). The library Manage-Charts modal inherits this for free when it
  ships (it routes through the same `uploadChart`).

### Tests (builder-written; vitest env=node)

`tests/chart-review.test.ts` covers the pure seam only (UI is out of jsdom reach):
threshold boundary (0.8 in/out, absent-confidence never flagged), bar→band roll-up, marker union with
resolve-error ids, `ordered` page→top→left walk, count of distinct elements. Report the test-count delta.

### Out of scope (chunk 3)

- Per-element-type threshold tuning (deferred; one-line once real charts exist — open-Q3).
- Any change to `canVerify` / the verify flow, the model, or the DB.
- The library Manage-Charts modal surface (separate library chunk; it reuses `uploadChart` so upload
  states come along automatically).

## Hash rule (DECIDED — was Open Q1)

Build-critical: the viewer looks up the overlay by hash, the converter writes it by hash; they **must**
agree or the generated overlay is never found. Today the viewer hashes `doc.getData()` (pdf.js's
internal bytes, page.tsx:2583), which is **not guaranteed** to byte-equal the stored object (pdf.js may
re-serialize). Rather than gamble on that equality, we make both sides hash the **same canonical bytes
by construction**:

1. **Hash the fetched object bytes, not `doc.getData()`.** Refactor the viewer/`loadPdfDoc` path to
   `fetch` the chart blob, hash that **ArrayBuffer**, then hand the *same* bytes to pdf.js as `{ data }`.
   The converter hashes the bytes it downloads from the **authoritative Supabase storage API** (not the
   CDN/public URL). Both sides now hash identical bytes — pdf.js internals are out of the equation.
2. **Keep client-side hashing** (do NOT switch to a server-stored hash column). This preserves the
   load-bearing safety property: an overlay applies **only** if the bytes you are viewing match the
   bytes it was built for. A stored-hash shortcut would re-introduce silent-apply-under-mismatch.
3. **Handle replace + caching (the sneaky edge).** Upsert reuses the storage path → the URL is stable
   but the bytes change on replace → a CDN/browser/offline cache can serve **stale** bytes, so the
   viewer would hash the old file and miss the new overlay. Mitigations: the converter hashes the
   authoritative storage object (download API, not CDN); the viewer **cache-busts on `updated_at`** /
   `modifiedTime` (already on `Chart`) and the offline cache invalidates on it.

Open for Codex confirmation only: any pdf.js/Supabase-transport byte-mutation wrinkle (content-encoding
gzip, range-request reassembly) that could still mutate bytes after fetch — hashing the fetched
ArrayBuffer neutralizes most, but flag any residual.

## Open questions (for Codex / build)

1. **Vision coordinate quality / iteration.** How rough is acceptable? Likely an iterate-on-real-charts
   loop with the ~25 backfill set as the test corpus. Prompt + few-shot may need tuning.
2. **Cost / latency per chart.** Multimodal PDF calls cost tokens and run seconds; multi-page charts
   scale up. Acceptable at this volume; note for future high-volume.
3. **Confidence thresholds** for the review queue — start values + per-element-type tuning.
4. **Model choice** — latest capable multimodal Claude for structure extraction (cost/quality tradeoff).

## Out of scope / future

- **End-to-end image (PNG/JPG) charts** — needs its own chunk adding viewer image-render + image-hash +
  overlay-on-image to the calibrate/verify path. v1 converter typed-no-ops non-PDF sources.
- Edge-snap raster precision detector (a later calibration chunk).
- Carry-forward of prior-hash manual anchors onto a replaced file.
- Background-worker generation infra (only if volume grows beyond client-driven sync).
