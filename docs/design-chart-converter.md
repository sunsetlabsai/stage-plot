# Design — Chart Converter (auto-overlay)

Status: **DRAFT for review** · Branch `opus/design-chart-converter` · Owner: Graham (sign-off gate)

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
- Manual adjustments are sacrosanct. The converter seeds the *first* draft; from then on the human (and
  the verify flow) owns that `(chart_id, source_hash)` row.

## Decisions locked (Graham)

1. **Extraction engine = vision-first** (Claude multimodal). Real charts are too messy (scanned/raster
   PDFs, chord charts, handwriting) for structural PDF parsing alone. Vision generalizes; rough coords
   are fine — precision comes from human nudge + the later on-demand edge-snap detector.
2. **Execution = async, persisted, never-regenerate, never-lose-edits** (the guarantee above).

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
- `/api/charts/convert` runs the vision call **within its own request** (a normal slow request →
  Vercel-safe), guarded for idempotency. Owner-only.
- Failure or timeout on step 2 is **non-fatal**: the chart still uploaded; the overlay is simply absent
  (manual rail). The UI reports "couldn't auto-generate — calibrate manually."

### `/api/charts/convert` (new route)
1. **Auth:** authenticated owner of `chart_id` (RLS + pre-check), else 403.
2. **Fetch bytes:** load the chart blob from Supabase Storage (the stored file).
3. **Hash:** compute `source_hash` server-side. ⚠ **Must equal** the viewer's
   `hashPdfBytes(doc.getData())` lookup key (Open Q1).
4. **Idempotency guard:** if a `chart_calibration` row exists for `(chart_id, source_hash)` → **return
   no-op** (`{ generated: false, reason: 'exists' }`). Never overwrite.
5. **Vision extract:** send the PDF to Claude (multimodal — Claude accepts PDF document blocks natively,
   so **no server-side rasterization** needed) with a structured-output prompt → JSON.
6. **Build + validate:** map JSON → `ChartCalibration` (`status: 'draft'`, normalized 0..1 coords,
   per-element confidence, schemaVersion stamped by presence of roadmap). Run `isValidCalibration`;
   on invalid/empty, write **nothing** (degrade to manual).
7. **Persist:** insert the draft row keyed `(chart_id, source_hash)`.
8. **Return:** `{ generated: true, calibration }` so the client can show it immediately.

## Vision contract

- **Input:** the chart PDF (all pages) as a Claude document block + a prompt asking for the chart's
  structure as JSON.
- **Output JSON** (a subset/shape of `ChartCalibration`):
  - `systems[]`: `{ page, yTop, yBottom, xStart, xEnd, confidence }` (full-width default xStart=0/xEnd=1,
    matching chunk-3's deliberate full-width systems).
  - `bars[]`: per system, `{ xStart, xEnd, confidence }` → server assigns `absNumber` (reading order)
    and `systemId`/`id`.
  - `sections[]`: `{ page, x, y, label, confidence }` (e.g. "Intro", "Verse", "Chorus").
  - `roadmap[]`: detected markers (`|: :|`, voltas, Segno, Coda, To Coda, Fine, D.C./D.S.) bound to
    bars/edges, each with `confidence`. Bindings (e.g. `repeatStartId`) resolved server-side from
    detected positions; anything the resolver can't bind is dropped (degrade, not error).
- The model already carries `confidence?` on roadmap markers. **Small additive model change:** add
  optional `confidence?: number` to `SectionAnchor`, `System`, `Bar` (no schema bump — additive +
  optional, like the marker field) so the review queue can flag geometry too.
- Coordinates are **rough** by design. Validation: `isValidCalibration` at the DB boundary; resolver
  validity is NOT required (drafts persist even if roadmap doesn't yet resolve — same as manual drafts,
  BLOCKER-1 rule).

## Review queue (human cleanup)

- After generation, the calibrate UI surfaces **only flagged elements** (confidence below a threshold,
  or roadmap markers the resolver couldn't bind). Everything else is accepted silently.
- The human reviews flagged items, nudges geometry, fixes/deletes markers, then **Verify** (existing
  flow). Verify still requires labeled sections + a resolving roadmap (`canVerify`).
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

1. **Model + helper seam:** add optional `confidence` to SectionAnchor/System/Bar; `lib/chart-upload.ts`
   shared `uploadChart()` + `triggerOverlayCreate` calling the convert route; refactor in-show
   `onChartUpload` to use it (no behavior change yet — convert route returns no-op until chunk 2). Tests.
2. **`/api/charts/convert` route:** auth, fetch bytes, server hash, idempotency guard, vision call
   (Claude multimodal), JSON→calibration map + validate + persist, graceful degrade. Tests for the
   guard + the map/validate (mock the vision response).
3. **Review queue UI:** flag low-confidence/unbound elements in calibrate mode; "Generating…" /
   "couldn't auto-generate" states in the upload flow.
4. **A2 backfill script.**

Gate (`npx tsc --noEmit && npm run lint && npm test && npm run build`) + commit per chunk.

## Open questions (for Codex / build)

1. **★ Hash parity (build-critical).** Viewer looks up the overlay by
   `hashPdfBytes(doc.getData())` (pdf.js bytes, page.tsx:2583). The converter hashes the stored blob
   server-side. These **must** produce the same hash or the generated overlay is never found. Need to
   confirm `doc.getData()` === uploaded bytes; if not, align by hashing the **fetched blob** on the
   viewer side too (preferred — hash the exact stored bytes everywhere). *Resolve before chunk 2 ships.*
2. **Vision coordinate quality / iteration.** How rough is acceptable? Likely an iterate-on-real-charts
   loop with the ~25 backfill set as the test corpus. Prompt + few-shot may need tuning.
3. **Cost / latency per chart.** Multimodal PDF calls cost tokens and run seconds; multi-page charts
   scale up. Acceptable at this volume; note for future high-volume.
4. **Confidence thresholds** for the review queue — start values + per-element-type tuning.
5. **Model choice** — latest capable multimodal Claude for structure extraction (cost/quality tradeoff).

## Out of scope / future

- Edge-snap raster precision detector (a later calibration chunk).
- Carry-forward of prior-hash manual anchors onto a replaced file.
- Background-worker generation infra (only if volume grows beyond client-driven sync).
