# Design — Chart measurement engine (productizing the geometry spike)

Status: **chunk B1 SHIPPED (PR #170); chunk B2 designed below, not yet built.**
Companion to `design-chart-review-step.md` (frozen): this engine *supplies* the
per-system verdicts that doc consumes. Invoked per `backlog-charting.md` §Ruled
2026-09-02 (owner-demand trigger; never-gates checked before anything runs). Nothing
here changes generate-once, the hash rule, or verify/`canVerify`.

## What it is

A deterministic geometry pass that replaces VLM-first conversion for vector charts:
measure staves and barlines from the PDF's own vector data, read printed measure
numbers / time signatures / multirest counts from the text layer, validate measured
against printed, and emit verdicts. The VLM is demoted to targeted work where evidence is missing: the
per-system fallback for `uncertain` systems, the corroborating opinion on number-less
vector charts (per the frozen `corroborated` definition), and the whole-chart path for
raster scans (`estimated`).

Validation status (2026-09-02): the poppler reference implementation scores **464/464
scored systems across 62 real charts** (multi-page, multiple engraving toolchains,
mostly out-of-sample). **Chunk B1 reproduced that in-product exactly** — same 464/464,
550 staves, 3044 spans, identical 25-file zero-staff set, zero per-file field diffs
across 87 unique charts, with no native binary. Poppler is no longer needed.

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
  pattern/text/group paths, so a shim that misses it silently drops transformed strokes
  from the measurement stream — and capture the CTM at `stroke(path)` / `fill(path)`
  time, when the transform actually applies. **Confirmed and shipped in B1**: seven
  `addPath` call sites, not the five originally cited here (those were the `new Path2D()`
  lines). The matrix must be COPIED into the destination's recorded verbs — pdf.js's
  rescale matrix is a mutated module singleton, and pairing the paint-time CTM with the
  *original* path is off by the rescale factor precisely for hairlines.
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
   `unscored` (measured, but no printed delta existed to check it — 15.6% of systems,
   see `design-chart-review-step.md` §Amendment 2026-09-02) · `corroborated` (no printed
   numbers; measured = VLM) · `uncertain` (mismatch / disagreement → per-system VLM
   fallback, still `uncertain` until a human answers) · `estimated` (raster page: no
   vectors, no text → whole-page VLM). Zero staves on a vector page with real text =
   **not notation** (lyrics/chord-sheet class): no VLM call, no overlay, record the
   classification — the automatic backstop gate from §Ruled 2026-09-02, subject to the
   completeness precondition in §Chunk B2.

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

Settled in B1: stages 2–5 are pure functions over segments + text items, so synthetic
fixtures cover them in CI (`tests/chart-measure.test.ts`) and no corpus-derived fixture
needs to enter the repo.

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
   (`lib/pdf-viewer.ts` reads cache-first); on rejection the client **evicts the
   chart's Cache API entry and fetches network-direct** — `fetchChartBytes` prefers
   the cache before any URL, so a versioned URL alone would loop on the same stale
   bytes — then re-measures and re-submits. Stale geometry can never be inserted
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
  verdicts).
  > ⚠ **CORRECTED 2026-09-02.** This section originally ended "Fully-numbered charts
  > that validate cleanly cost nothing." That is **false**, and the error is this
  > doc's: the pipeline above produces staves, barlines and measure numbers, and
  > **never mentions sections** — but `canVerify` requires at least one *labeled*
  > section, so a measurement-only calibration leaves the owner at
  > `unverifiable / no-sections`, unable to Perform. Measurement replaces the VLM's
  > **geometry**, not its **semantics**. See §The section gap below.

## Non-goals

- The review sheet UI (chunk C, frozen spec) and the trigger UX (chunk A).
- Re-measuring existing calibrations (generate-once stands; improved engines benefit
  new conversions and replaces only).
- Cross-page measure-number chaining (scores page-tail systems; future accuracy
  tune-up, not required for verdicts to work).

## Answered by chunk B1 — measured, not reasoned (PR #170)

The three open questions are closed. Answers came from running the engine against the
corpus, not from argument; the numbers are reproducible with
`npx tsx scripts/chart-measure-acceptance.ts`.

1. **Shim coverage.** `Path2D` interception plus a context Proxy plus `canvas: null`
   captures 100% of *observable* paint: 464/464, and zero segment-stream diffs against
   poppler on 101 of 115 corpus pages, with all 14 remaining diffs individually
   explained and inert. Two bypass classes survive, both **detectable at runtime**:
   pdf.js reassigns `gfx.ctx` for SMasks / transparency groups / own-canvas
   annotations, and tiling/shading patterns can render vector content into a scratch
   canvas that arrives via `createPattern` / `drawImage` / `fillRect`. Zero corpus pages
   hit either. §The geometry-completeness precondition below is what they feed.
2. **Fixture strategy — settled by construction.** Synthetic fixtures in-repo (22 unit
   tests over stages 1-5, no corpus needed); the corpus and its expected-results file
   stay out of the repo. Extracted geometry fixtures were not needed and are not
   proposed.
3. **Perf.** A 1×1 canvas — the obvious free version — **does not work**: pdf.js culls
   paths against the canvas clip box and three charts silently lose geometry. So this
   is a real render pass and the only lever is scale. Scale is itself load-bearing,
   because pdf.js clamps strokes to ≥1 device pixel and the modal-barline filter
   discriminates at ~0.1pt: scale 1 scores **439/464**, scales 2/3/4/8 all score
   464/464. Shipping 3 (floor 0.33pt, 4.4M px for US Letter). **Not yet measured on a
   real phone** — if device profiling forces it down, 2 still scores 464/464 but leaves
   only ~0.07pt of headroom.

---

# Chunk B2 — the commit path

B1 shipped the engine (`lib/chart-measure.ts`, `lib/chart-measure-canvas.ts`) and its
acceptance harness. Nothing imports them. B2 is what makes measurement reach the
database. Scope below is **ruled**, not proposed.

## Scope ruling: the deterministic path only

The targeted VLM legs this doc specifies — the per-system `uncertain` fallback and the
`corroborated` opinion — are **deferred**, because the corpus says they have no work to
do yet. Across the 62 charts with staves:

| population | corpus count |
|---|---|
| `uncertain` systems (needing the per-system VLM fallback) | **0** |
| charts with staves but no printed numbers (needing `corroborated`) | **0** |
| raster charts (`estimated`, whole-page VLM) | 2 |
| `unscored` systems | 86 of 550 (15.6%) |

Building either leg now means shipping code that has never run against a real input.
They land when a chart demands them. B2 therefore = measure → validate → commit, and
anything the engine cannot measure cleanly falls back to **today's whole-chart VLM path,
unchanged**. That is a complete win on its own — exact geometry replacing the VLM's
coordinate guesswork, which is the known-bad part — with no new VLM code and no
regression surface.

## The section gap (★ read before building)

The pipeline in this doc measures geometry. It does not, and cannot, read section
labels — those are semantic. But `canVerify` (`lib/chart-calibration.ts:136`) requires
`sections.length > 0` and every section labeled, and the readiness strip decomposes the
failure into `no-sections` → *"Add a section to verify this chart."*

So a measurement-only calibration is **not performable**, and shipping one in place of
today's VLM calibration would be a regression: the owner would lose section detection
they have today and have to hand-add every section.

**Ruling for B2: the VLM section pass stays.** The measured payload supplies
`systems` + `bars`; the server's existing vision call supplies `sections` (and
`roadmap`); the two are merged before the insert. Measurement replaces VLM *geometry*,
not VLM *semantics*. The honest cost story is "the same one VLM call, with exact
geometry instead of estimated geometry" — and geometry was the broken half
(`project_showbible_converter_bar_quality`: bar overlay near-random under VLM
coordinate estimation).

Deterministic section detection from the text layer is plausible — section labels are
text, and the engine already reads the text layer for measure numbers — but it is a new
sub-pipeline with its own corpus gate, and it is **not** in B2. Backlog it.

## The geometry-completeness precondition (★ the never-gate's safety rule)

`backlog-charting.md` §Ruled 2026-09-02 makes the zero-staves classifier the third
never-gate. A never-gate is unappealable: it refuses conversion permanently, with no
VLM fallback. So it must fire only on evidence of **absence**, never on absence of
**evidence**.

**Rule: zero staves gates the chart ONLY when the geometry was complete.**

| observed | classification | outcome |
|---|---|---|
| zero staves, real text, geometry complete | `not-notation` | gate — no VLM, no overlay |
| zero staves, real text, geometry **incomplete** | `estimated` | **no gate** — whole-page VLM |
| zero staves, no text | `estimated` | whole-page VLM |

"Geometry incomplete" means the adapter observed paint it could not account for: a
`gfx.ctx` swap, or pattern/opaque paint covering enough of the page to hide a staff.
This dissolves the threshold problem — the test is "did we observe everything we
painted", which the shim already tracks, not "is this image big enough to be hiding
something".

Confidence that the gate itself is sound comes from measurement, not assumption: 342/342
lyrics PDFs in the live library have zero detectable staves, and 25/25 zero-staff corpus
files are genuinely lyrics sheets, chord charts or scans.

⚠ **Prerequisite, ruled separately:** never-gates are currently *silent and
unappealable* — the reason is collapsed to a boolean at `app/[owner]/[show]/page.tsx`,
nothing tells the owner a decision was made, there is no role editor, and the same
predicate blocks the client CTA, a hand-crafted POST and the admin backfill. A small PR
lands **before** B2 to thread the reason through, say why, and give the owner a "build
anyway" override. Gates protect the owner's AI budget; the owner is the budget holder,
so an explicit owner override is consistent with the ruling that created them.

## Verdicts the engine emits

Per `design-chart-review-step.md` (amended 2026-09-02): `validated`, `unscored`,
`uncertain`. The engine cannot emit `corroborated` or `estimated` — both require a VLM
opinion, which the split contract puts server-side with a key the browser never sees.
Those two are assigned by the server, after its vision step. Verdict gets runtime enum
validation at the same DB boundary that range-checks `confidence`; an unknown value is
invalid, not ignored.

## Spans → bars

`isValidCalibration` needs `Bar` rectangles in normalized [0,1] page coordinates with a
dense global `absNumber`, each fitted inside its parent system's x-bounds. The engine
produces cluster positions, and a cluster is the **right edge** of a measure (verified
against a real chart: staff x 67-570, clusters at 119/190/265/342/418/493/569, six
measures). So bar *k* runs from the previous cluster to cluster *k*, with the staff's
left edge standing in for the first — **except** when the line-start begin-repeat rule
fired, where the leftmost cluster is a span *start* and bars run between clusters.

That derivation belongs next to the rule that produced it, so `measurePage` gains a
per-system `bars: { xStart, xEnd }[]` rather than making each caller re-derive it from
`barlines` + `spans` + a flag. `PageMeasurement` also gains page dimensions, since
normalization needs them. Both are unit-testable additions to the pure module.

`absNumber` is assigned client-side across the whole chart in reading order
(page → yTop → xStart), matching what `barsInOrder` re-derives during validation.

## Multirests — IN B2, at creation (★ Graham's ruling 2026-09-02)

A multirest is **one visible bar but N musical measures**. Today `absNumber` counts
visible bars, so the conductor advances one where the band plays four.

This was briefly backlogged as "pre-existing." That was wrong, and the reason is
**generate-once**: the write is insert-only, conflict-as-no-op, with no same-hash
machine re-run of any kind. A chart converted without the multirest count never acquires
it — not on retry, not from a better engine later, not ever, short of new bytes. So
"backlog" here does not mean "later", it means "never, for every chart converted in the
meantime." The count must be persisted by the conversion that first measures it.

It is also free. The engine already reads multirest counts to compute
`printed delta = visible spans + Σ(multirest − 1)` — the arithmetic that produces the
`validated` verdict at all. Discarding a number we deliberately went and got, at the
write boundary, is the loss.

**Design: a new optional `Bar.measures?: number` (default 1)** — how many musical
measures this one visible bar represents. Optional-field forward-compat, no schema bump,
the same pattern as `confidence` and `verdict`.

Why this and not "make `absNumber` the musical measure number": `absNumber` is bar
IDENTITY — it keys the conductor, the chrome, and bar selection — and
`isValidCalibration` enforces dense 1..n over reading order. Making it musical would
relax that invariant and ripple through every consumer. Keeping `absNumber` dense over
*visible* bars changes nothing downstream, and the musical measure number stays
derivable: `1 + Σ(measures of preceding bars)`.

Validation additions: `measures` is an integer ≥ 1 when present, checked in `isValidBar`
alongside the existing rules. `Σ measures` over a system must equal that system's
`expectedSpans` when the system is `validated` — the page's own printed numbers are
already the check, so this costs nothing new and catches a mis-assigned count.

Conductor follow-along is then arithmetic over `measures`, and is **not** B2's to build —
but B2 is what makes it possible, which is the whole point of doing it now.

## Payload and route extension

`/api/charts/convert` keeps its shape and gains two optional fields:

```
POST { chart_id, source_hash?, measured? }
```

`measured` carries the systems/bars the client measured plus per-system verdicts. The
server then, in this order:

1. re-hashes the **authoritative storage bytes** it already downloads, and **rejects on
   mismatch** with the payload's `source_hash`;
2. validates the merged calibration with `isValidCalibration` plus the verdict enum
   check — client geometry is *data*, never trusted computation;
3. runs its existing vision call for sections/roadmap;
4. performs the same insert-only, conflict-as-no-op write it performs today.

A request with no `measured` behaves exactly as it does now, so the route degrades to
current behaviour for any client that cannot measure.

Trust: the payload writer is the chart's owner writing their own *draft* calibration —
the same trust level as today's conversion trigger. A hostile owner can only corrupt
their own overlay, and the calibrate/verify flow remains the authority afterwards. The
engine must not ride `/api/charts/calibration` PUT, which is overwrite-capable and
reserved for human editing.

## Cache eviction — two helpers, not one

On hash mismatch the client must re-measure the real bytes. This doc previously said
"evict the chart's Cache API entry and fetch network-direct". Neither helper exists, and
eviction alone is **not sufficient**: `loadPdfDoc` memoizes by `fileId:modifiedTime` in
a module-level `docCache` and would hand back the same stale document *and its stale
hash*. B2 needs:

- `evictChartCache(chart)` in `lib/chart-cache.ts` (`CACHE_NAME` is module-private, so
  this cannot live anywhere else);
- a per-chart in-memory eviction in `lib/pdf-viewer.ts` — today only `destroyAllDocs()`
  exists — plus a cache-bypassing fetch path, since `fetchChartBytes` returns a cache
  hit before it considers any URL.

One retry, then surface the failure. A mismatch loop means storage changed under us, and
retrying forever hides that.

## Acceptance

The B1 harness is the gate and must stay at **464/464 with `PARITY: clean`** — the
`measurePage` additions above are additive and must not move it. New unit tests cover
spans → bars, normalization, `absNumber` density, the completeness precondition, and
hash-mismatch rejection. The split contract's server half is testable without a browser.
