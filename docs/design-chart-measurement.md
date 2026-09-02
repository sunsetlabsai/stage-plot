# Design — Chart measurement engine (productizing the geometry spike)

Status: **design only — no build until merged** (standing process).
Companion to `design-chart-review-step.md` (frozen): this engine *supplies* the
per-system verdicts that doc consumes. Invoked per `backlog-charting.md` §Ruled
2026-09-02 (owner-demand trigger; never-gates checked before anything runs). Nothing
here changes generate-once, the hash rule, or verify/`canVerify`.

## What it is

A deterministic geometry pass that replaces VLM-first conversion for vector charts:
measure staves and barlines from the PDF's own vector data, read printed measure
numbers / time signatures / multirest counts from the text layer, validate measured
against printed, and emit verdicts. The VLM is demoted to a per-system fallback for
`uncertain` systems and the whole-chart path for raster scans (`estimated`).

Validation status (2026-09-02): the reference implementation scores **464/464 scored
systems across 62 real charts** (multi-page, multiple engraving toolchains, mostly
out-of-sample). This doc is about porting that into the product without losing it.

## The coordinate-source decision (the reason this doc exists)

The reference implementation leans on poppler's `pdftocairo` — a native binary,
unavailable on Vercel. And the one approach that looks free is **disproven**:
hand-rolling transform composition over pdf.js's operator list produced
content-dependent coordinate drift of 23–28pt varying *by graphics context* — wrong in
ways that self-validation partially masked. Do not walk operator lists by hand.

**Decision: a recording-canvas shim over pdf.js rendering, client-side.**

- Hand `page.render()` a real 2D context wrapped in a recording proxy. The proxy
  forwards every call (rendering stays correct) and records path geometry with the
  **transform pdf.js itself has set** — read via `ctx.getTransform()` at paint time.
  Correct coordinates *by construction*, because the same code path that puts ink on
  screen produces the measurements.
- Runs in the browser, where pdf.js already renders every chart — matching the shipped
  client-driven conversion model (`design-chart-converter.md` §Execution model). Zero
  new external dependencies or infra services; the one new surface is the server commit
  contract below.
- ⚠ Known interception detail: modern pdf.js builds paths via **`Path2D`** rather than
  ctx verbs when available. The shim must intercept the full `Path2D` surface: patch
  the constructor (a subclass that records verbs and remains a real `Path2D`), **record
  and replay `Path2D.addPath(source, matrix)`** — the vendored pdfjs-dist 5.7.284 uses
  `addPath` to copy/transform paths before stroke/fill, including stroke rescaling and
  pattern/text/group paths (pdf.mjs:11433, :11476, :11553, :11659, :12663), so a shim
  that misses it silently drops transformed strokes from the measurement stream — and
  capture the CTM at `stroke(path)` / `fill(path)` time, when the transform actually
  applies. Chunk B opens with a feasibility spike on exactly this; the acceptance
  harness below is its exit gate.
- Rejected: WASM poppler/pdfium (heavyweight new dependency for one function), a
  sidecar conversion service (new infra for a pure function), server-side node-canvas
  (native dep back on Vercel — the original problem).

Captured per segment: endpoints (page space), stroke width, stroked-vs-filled, and
flat-curve chords (control points on the chord → emit as line; real slurs/ties stay
curves and are ignored). Text via `getTextContent()` as today.

## Pipeline (per page)

1. **Staves**: bucket horizontal segments by y, merge contiguous x-ranges (some
   engravers break each staff line at every barline); staff candidates by merged
   length ≥ 60% of the longest rule; group candidates by spacing. Interleaved ink
   (voltas, rehearsal boxes, multirests, hairpins) cannot split a staff.
2. **Barlines**: verticals whose endpoints land on the outer staff lines
   (tol = max(0.04·staffHeight, 1.2pt)); keep modal-stroke-width strokes (barline
   width is engraver-specific but modal per chart; staff-spanning note stems are
   thinner) plus thick (>1.5pt) strokes; cluster within 6pt (repeat thick+thin pairs
   run 3–4.5pt). A thick leftmost cluster with ≥3 clusters total and a gap from staff
   start under 1.0× the median bar width is a line-start begin-repeat: a span *start*,
   not a divider.
3. **Text**: printed measure numbers at the staff's left edge; time signatures excluded
   as stacked same-x digit pairs; a multirest is the *pair* of a digit and an H-bar
   under it (chord-extension superscripts have no bar; beams have no digit).
4. **Arithmetic**: printed delta = visible spans + Σ(multirest − 1). An unnumbered
   first system is measure 1 on **page 1 only**; continuation pages abstain.
5. **Verdicts** per the frozen spec: `validated` (measured = printed delta) ·
   `corroborated` (no printed numbers; measured = VLM) · `uncertain` (mismatch /
   disagreement → per-system VLM fallback, still `uncertain` until a human answers) ·
   `estimated` (raster page: no vectors, no text → whole-page VLM). Zero staves on a
   vector page with real text = **not notation** (lyrics/chord-sheet class): no VLM
   call, no overlay, record the classification — this is the automatic backstop gate
   from §Ruled 2026-09-02.

All thresholds above are corpus-calibrated constants, named in one place in the
implementation — not scattered magic numbers — because the acceptance harness is how
they are ever retuned.

## Acceptance harness (load-bearing)

The port must reproduce the reference results on the reference corpus: **464/464
scored systems, and identical no-staves classifications**. The corpus (real charts,
`~/chart-spike/` on the dev machine) is copyrighted material and stays out of the
repo; the harness is a local dev script that runs the engine (headless browser for the
shim) against the stored expected-results JSON. Regressions in any rule change must be
caught by score movement — the self-validation signal is the objective function, the
same way it was during the spike.

Open question below: whether extracted geometry fixtures (segment/verdict JSON, no
renderable content) may live in-repo so CI can cover the pure pipeline stages
(2–5) without the corpus. The pipeline is pure functions over segments + text items,
so stages 2–5 are unit-testable with synthetic fixtures regardless.

## The split contract (client measures; server commits and pays)

Two shipped facts force an explicit split, and the design owns it rather than implying
it away:

- The only insert-only calibration writer lives inside server-side
  `/api/charts/convert` (`route.ts:130`); the generic client write
  (`/api/charts/calibration` PUT, `route.ts:201`) is an overwrite-capable upsert
  reserved for the human editing flow. A browser engine must NOT gain overwrite power
  by riding that PUT.
- The VLM key is resolved server-side (`convert/route.ts:99`) and never reaches the
  browser.

**Contract:** the client engine extracts geometry + text and computes provisional
verdicts — it writes nothing and holds no keys. It POSTs the measured payload
(segments summarized as the draft calibration + per-system verdicts + per-system
raster/uncertain flags, **plus `source_hash` computed from the exact bytes it
measured** — hash the fetched ArrayBuffer, the same canonical-bytes-by-construction
rule as `design-chart-converter.md` §Hash rule) to the **convert route, extended to
accept a measured payload** (owner-authenticated, same scope as today). The server
then:

1. hashes the **authoritative storage bytes** and **rejects on mismatch** with the
   payload's `source_hash` — the client may have measured a stale Cache-API copy
   (`lib/pdf-viewer.ts` reads cache-first); on rejection the client re-fetches
   cache-busted, re-measures, and re-submits. Stale geometry can never be inserted
   under the current hash, preserving "an overlay applies only to the bytes it was
   built for";
2. validates the payload (`isValidCalibration`, runtime verdict-enum check per the
   frozen spec, sanity bounds) — client geometry is *data*, not trusted computation;
3. runs the VLM work **server-side** with the server-resolved key, exactly where the
   key already lives (scope in §Integration);
4. performs the same **insert-only, conflict-as-no-op** write the converter performs
   today (generate-once untouched).

Trust note: the payload writer is the chart's owner writing their own *draft*
calibration — the same trust level as today's client-driven conversion trigger; a
hostile owner can only corrupt their own overlay, and the human calibrate/verify flow
remains the authority afterward.

## Integration

- Invoked by the owner-demand trigger (lazy-conversion chunk; placement decided
  there). Pre-gates run first: `role = 'lyrics'` and `source_spec IS NOT NULL` never
  reach the engine.
- Cost profile: measurement is local JS — paid VLM calls happen only where evidence
  is missing, server-side per the split contract: `uncertain` systems, raster pages,
  and **number-less vector charts needing corroboration** (a `corroborated` verdict
  requires an independent VLM opinion *by definition* — frozen spec §Confidence
  verdicts). Fully-numbered charts that validate cleanly cost nothing.

## Non-goals

- The review sheet UI (chunk C, frozen spec) and the trigger UX (chunk A).
- Re-measuring existing calibrations (generate-once stands; improved engines benefit
  new conversions and replaces only).
- Cross-page measure-number chaining (scores page-tail systems; future accuracy
  tune-up, not required for verdicts to work).

## Open questions (Codex)

1. **Shim coverage risk**: besides `Path2D`, does the shipped pdf.js version paint any
   chart-relevant geometry through paths the proxy can't observe (e.g., `putImageData`
   compositing, worker-side rasterization)? Name any op class that bypasses both
   interception points.
2. **Fixture strategy**: geometry-JSON fixtures in-repo for CI — acceptable, or keep
   all corpus-derived data local and rely on synthetic unit fixtures?
3. **Perf**: one extra render pass per page at conversion time (recording proxy), on
   mobile Safari — acceptable, or does the shim need to piggyback the viewer's
   existing render?
