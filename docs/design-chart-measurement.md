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
  `/api/charts/convert` (`route.ts:149`); the generic client write
  (`/api/charts/calibration` PUT, `route.ts:201`) is an overwrite-capable upsert
  reserved for the human editing flow. A browser engine must NOT gain overwrite power
  by riding that PUT.
- The VLM key is resolved server-side (`convert/route.ts:118`) and never reaches the
  browser.

**Contract:** the client engine extracts geometry + text and computes provisional
verdicts — it writes nothing and holds no keys. It POSTs the measured payload
(segments summarized as the draft calibration + per-system verdicts + per-system
raster/uncertain flags, **plus `source_hash` computed from the exact bytes it
measured** — hash the fetched ArrayBuffer, the same canonical-bytes-by-construction
rule as `design-chart-converter.md` §Hash rule) to the **convert route, extended to
accept a measured payload** (owner-authenticated, same scope as today).

The server then runs the sequence defined **once**, in §Payload and route extension below.
That list is canonical; this section does not restate it. (An earlier draft spelled the
steps out in both places and the two drifted — this one still had validate-before-VLM
and no roadmap-presence branch after the other was corrected. Codex R3, #172.)

The one detail that belongs *here* rather than there is what the hash step is defending
against: the client may have measured a **stale Cache-API copy** (`lib/pdf-viewer.ts`
reads cache-first). On rejection the client evicts the chart's Cache API entry and
fetches network-direct — `fetchChartBytes` prefers the cache before any URL, so a
versioned URL alone would loop on the same stale bytes — then re-measures and
re-submits. Stale geometry can never be inserted under the current hash, preserving
"an overlay applies only to the bytes it was built for". See §Cache eviction — two
helpers, not one.

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
   hit either. §The geometry-completeness precondition below is what they feed — note
   that `fillRect` is handled there by a **bound**, not an exclusion, because every page
   carries exactly one structural `fillRect` (§`fillRect` is bounded, not excluded).
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
`systems` + `bars`; the server's existing vision call supplies `sections`; the two are
merged before the insert. Measurement replaces VLM *geometry*, not VLM *semantics*. The
honest cost story is "the same one VLM call, with exact geometry instead of estimated
geometry" — and geometry was the broken half
(`project_showbible_converter_bar_quality`: bar overlay near-random under VLM
coordinate estimation).

Deterministic section detection from the text layer is plausible — section labels are
text, and the engine already reads the text layer for measure numbers — but it is a new
sub-pipeline with its own corpus gate, and it is **not** in B2. Backlog it.

### ⚠ The roadmap is NOT separable semantics (Codex, #172)

An earlier draft of this section said the vision call supplies "`sections` (and
`roadmap`)", merged before the insert. That is wrong, and the reason is that **roadmap
markers are bound through VLM BAR INDICES, not through geometry-free semantics.** The
vision prompt defines every roadmap ref as `barIndex` / `barIndices` /
`repeatStartBarIndex` into the model's own `bars[]` (`lib/chart-vision.ts:20`), and
`buildCalibrationFromVision` resolves them through a `barIdByModelIndex` map built from
those same VLM bars (`lib/chart-converter.ts:286`, markers at `:322`). Install measured
bars and that map describes nothing. Copying the roadmap across would either fail
`resolveRoadmap` or — worse — bind a repeat to the wrong bar and pass validation.

**Ruling for B2: route by roadmap presence.** The server runs the VLM anyway for
sections. Afterward:

| VLM roadmap | bars installed | path |
|---|---|---|
| empty | **measured** | B2's deterministic path |
| non-empty | VLM | today's path, byte-for-byte unchanged |

This is a **scope predicate on B2, not a second implementation.** Nothing regresses
against today, no rebinding heuristic ships untested, and it is the same reasoning that
deferred the `uncertain` and `corroborated` legs: don't ship code the corpus cannot
exercise. The ordering works under the split contract — the client measures *before* the
server calls the VLM, so a discarded measurement costs client CPU, never AI spend.

Measured on the live library (2026-09-02, n=7 charts — one owner, curated, **not** a
population estimate): 4 charts carry a non-empty roadmap, but only **2 of 7** are
VLM-produced. The discriminator is `confidence`: `buildCalibrationFromVision` wraps
model-derived markers in `withConfidence`, so a marker without the field was hand-added
in Calibrate. Every marker in the library — VLM and hand-added alike — is
`repeatStart`/`repeatEnd`; no segno, coda, D.S. or ending has ever been produced or
entered.

⚠ **The cost, stated plainly:** charts with printed repeats keep the estimated geometry
until rebinding is built, and by that sample they are the ~2-in-7 whose geometry is
hardest and most worth measuring. **Rebinding is on the generate-once clock** (see
§Multirests): every chart converted before it lands keeps VLM bars permanently, short of
new bytes or a hand edit. Backlog it as a named item with that consequence attached — not
as a quiet TODO. The likely shape is ordinal rebinding gated on VLM and measured bar
counts agreeing, which becomes measurable once converted charts accumulate.

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

**"Geometry incomplete" is a two-clause predicate over what the shim already returns.**
An earlier draft said the test was "did we observe everything we painted, which the shim
already tracks" (Codex, #172: overclaimed). `PageGeometry` returns `warnings: string[]`
plus `opaque: Record<string, number>` — op *counts*, no bounds — so an unqualified
"any opaque paint means incomplete" reading is both wrong and useless. Measured against
the corpus, `Σ opaque === 0` holds for **0 of 87 files**: `fillText` is the text layer
(every vector chart has one) and `wash` is the page-covering fill the shim
**deliberately drops** (B1's fourth measured fact). Neither is unobserved paint. Gating
on the aggregate would disable the never-gate entirely and quietly spend AI on all 342
lyrics PDFs.

The record is categorized precisely so the categories can be told apart:

```
complete  ⟺  no OBSERVABILITY warning                                  (per page)
             ∧ drawImage + putImageData + createPattern + strokeRect == 0
             ∧ fillRect <= 1
```

- **Observability warnings** — `stroke-without-path` (`lib/chart-measure-canvas.ts:343`),
  `fill-without-path` (`:358`), `no-2d-context` (`:436`). Paint happened and the shim did
  not see it. These mean incomplete.
- **`anisotropic-ctm`** (`:348`) is a **precision** caveat, not an observability failure:
  the geometry *was* observed, under a non-uniform scale. It must **not** open the gate.
  B1's blanket comment on `warnings` ("any warning means INCOMPLETE") is too strong and
  is corrected here — measured, 4 corpus files carry `anisotropic-ctm` and validate
  **53/53** systems between them.
- **Raster/pattern ops** carry pixels, not geometry — the two bypass classes from
  §Answered by chunk B1. `strokeRect` joins them: it is in `OPAQUE_OPS` (`:286`), is
  rect-shaped paint the shim never converts to segments, and is **0 across all 87 corpus
  files**, so excluding it is free.
- **`fillText` / `strokeText` / `clip`** are text and clipping. They cannot hide a staff
  and are not consulted.

### ⚠ `fillRect` is bounded, not excluded (Codex R2, #172 — and the reason is measured)

An earlier draft listed `fillRect` beside `fillText` and `wash` as "accounted-for paint,
not consulted." **That was unjustified, and the mechanism is worse than the wording.**
The wash test — white-ink or page-covering, diverting to `opaque.wash` — lives *inside
the `fill(path)` handler* (`lib/chart-measure-canvas.ts:356-370`). `fillRect` is
installed by the generic `OPAQUE_OPS` loop at `:384`, which only increments a counter and
forwards. **`fillRect` never reaches the wash test at all**, produces no segments, and is
therefore genuinely unobserved paint. pdf.js also uses `fillRect` for shading fills and
image masks, either of which could cover a staff.

But excluding it outright is not the fix, and measurement is what says so: **`fillRect` is
present in 87 of 87 corpus files and in 23 of 23 gate candidates.** A
`fillRect == 0` clause would disable the never-gate exactly as `Σ opaque == 0` would have
— the same failure this section already exists to correct, one category further in.

The distinguisher is the **count**, and it is sharp:

| | measured, 87 files |
|---|---|
| `fillRect` per page | **exactly 1.00 for every file** — the pdf.js `beginDrawing` page-background fill, one per page, structural rather than content |
| `strokeRect` | 0 |
| `drawImage` | 2 files — both already classify `raster` |
| `putImageData` / `createPattern` | 0 |

So `fillRect <= 1` **per page** admits precisely the one structural background fill every
page has and nothing else. A second `fillRect` on a page is a fill pdf.js did not need to
draw the background — a shading fill or an image mask — and it opens the gate, routing
that page to the whole-page VLM. That answers the real objection: the predicate does not
have to tell a harmless background `fillRect` from a hiding one by its bounds, because
the harmless one is *countable* and the corpus fixes its count at one.

⚠ This is the one clause carrying an **empirical** rather than structural justification,
and it is **not symmetrically safe** (Codex R3, #172). An earlier draft claimed it fails
closed if pdf.js changes. That is true in only one direction:

| pdf.js drift | effect | safe? |
|---|---|---|
| emits **more** background `fillRect`s | pages exceed the bound → routed to the VLM | ✅ fails closed |
| emits **zero** background `fillRect`s | a hiding `fillRect` becomes the *first* on its page and is **admitted** by the bound | ❌ **fails open** — a staff could be hidden under a gated page |

No count-based clause can close that second case, because the count is the only thing
distinguishing the background fill from a content fill. So the assumption must be
**pinned and asserted**, not reasoned about:

- **B2 acceptance requirement (not a note):** `scripts/chart-measure-acceptance.ts` must
  report and assert `fillRect === pageCount` across the corpus. It does not expose that
  counter today — the 1.00/page figure came from a temporary probe, which is exactly the
  fragility being fixed. A silent drift to zero is the failure mode, and only a standing
  assertion catches it.
- B2 must **pin the `pdfjs-dist` version** this rests on (vendored 5.7.284) and treat a
  bump as a re-measure, alongside the existing `Path2D`/`addPath` interception surface
  that is already version-sensitive.

**Measured on the corpus (2026-09-02, 87 files, harness at `PARITY: clean`):**

| | result |
|---|---|
| `not-notation` candidates still gating under the predicate | **23 / 23** |
| files anywhere with raster/pattern paint | **2** — and both classify `raster`, so they route to whole-page VLM and were never gate candidates |
| files with `fillRect` exceeding one per page | **0** |
| files with any warning | 4, all `anisotropic-ctm`, all validating cleanly |
| observability warnings across the whole corpus | **0** |

The separation is exact: every file the gate wants to catch is complete, and every file
with hiding-class paint is already on the VLM path for an unrelated reason.

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
it **by machine** — not on retry, not from a better engine later, short of new bytes. So
"backlog" here does not mean "later", it means "never, for every chart converted in the
meantime." The count must be persisted by the conversion that first measures it.

⚠ *Precision (Codex, #172): "never" is a claim about machine re-runs only.*
`/api/charts/calibration` PUT is an owner **overwrite** path for the same
`(chart_id, source_hash)` — an upsert without `ignoreDuplicates`
(`app/api/charts/calibration/route.ts`). A human can therefore repair a calibration by
hand. That does not weaken the argument here, because `measures` has **no editing
surface at all** — the Calibrate tools expose sections, bars and roadmap, not musical
measure counts — so for multirests specifically there is no human path either. (Contrast
the roadmap in §The roadmap is NOT separable semantics, which *is* hand-repairable and
is deferred partly for that reason.)

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

### ⚠ The invariant, corrected — and it is weaker than it looks (Codex, #172)

An earlier draft said "`Σ measures` over a system must equal that system's
`expectedSpans` when `validated`". **That is backwards.** `expectedSpans` is defined as
the expected count of **visible** spans, *after* subtracting the multirest extras
(`lib/chart-measure.ts:463`):

```
delta         = next.printedNumber − this.printedNumber      // printed, MUSICAL
expectedSpans = delta − Σ(multirest − 1)                     // VISIBLE
Σ measures    = visible spans + Σ(multirest − 1) = delta     // MUSICAL
```

So the draft's equation is wrong by exactly `Σ(multirest − 1)` — it holds only when the
system contains no multirest, which is precisely the case it was written to check. The
corrected pair:

- `bars.length === expectedSpans` — the existing `validated` check, restated over bars.
- `Σ bars[].measures === delta` — the new one.

⚠ **Both are evaluable on SCORED systems only (Codex R2, #172).** `delta` and
`expectedSpans` are computed in one guarded branch (`lib/chart-measure.ts:460-462`) that
requires `from !== null` — the system's own printed number, or 1 for the first system on
page 1 — **and** a `next` system **and** `next.printedNumber !== null`. So the invariant
is undefined, not violated, for: the last system on any page, the first system on a
continuation page with no printed number, and every `unscored` system (86/550, 15.6%).
Validation must skip those rather than treat a null `expectedSpans` as a failure — a
check that fires on absent evidence is the same mistake the never-gate's safety rule
exists to prevent.

**And it is a consistency guard, not a correctness proof.** A sum is invariant under
mis-assignment: attach `measures: 4` to the wrong bar in the system and the total is
still right. It catches a dropped or duplicated count, nothing more. `measures` is an
integer ≥ 1 when present, checked in `isValidBar`.

### ★ B1's public shape cannot assign the count (Codex, #172 — blocking for the build)

`MeasuredSystem.multirests` is `number[]` — **counts only, no position**
(`lib/chart-measure.ts:145`). The H-bar's x-range exists inside the engine
(`s.multirestBars`, paired with its digit at `:403-412`) and is discarded at the public
boundary. So B2 as drafted cannot know *which* `Bar` gets `measures: 4`, and the sum
check above would happily accept it on the wrong one.

**B2 therefore includes an additive change to the pure module:**

```ts
multirests: { count: number; xStart: number; xEnd: number }[]   // was: number[]
```

Stage-4 arithmetic changes only by summing `.count`. This shifts the harness's failure
line format (`mr=[...]`) but must not move the score: **464/464, `PARITY: clean`** stays
the gate.

Conductor follow-along is then arithmetic over `measures`, and is **not** B2's to build —
but B2 is what makes it possible, which is the whole point of doing it now.

## Payload and route extension

`/api/charts/convert` keeps its shape and gains two optional fields:

```
POST { chart_id, source_hash?, measured? }
```

⚠ **The two optional fields are not independently optional (Codex, #172):
`measured` present ⟹ `source_hash` REQUIRED.** A measured payload with no hash cannot
clear the hash boundary in step 1, so the server must reject the pair as a 400 rather
than silently commit unverified client geometry. Both stay optional only for the legacy
no-measurement request, which is what `triggerOverlayCreate` sends today — it posts
`{ chart_id }` alone (`lib/chart-upload.ts:86`) and must keep working untouched.

`measured` carries the systems/bars the client measured plus per-system verdicts. The
server then, in this order:

1. re-hashes the **authoritative storage bytes** it already downloads, and **rejects on
   mismatch** with the payload's `source_hash`;
2. runs its existing vision call — **unconditionally, and before any path decision.**
   It supplies `sections` either way (§Ruling for B2: the VLM section pass stays), and
   its `roadmap` is the discriminator step 3 branches on;
3. **branches on VLM roadmap presence** (§The roadmap is NOT separable semantics):
   roadmap empty → install the measured `systems`/`bars` + per-system verdicts beside
   the VLM sections; roadmap non-empty → **discard the measurement** and take today's
   `buildCalibrationFromVision` path byte-for-byte unchanged;
4. validates the resulting calibration with `isValidCalibration` plus the verdict enum
   check — client geometry is *data*, never trusted computation;
5. performs the same insert-only, conflict-as-no-op write it performs today.

⚠ **The order matters and an earlier draft had it backwards (Codex R2, #172):** it
validated a "merged" calibration at step 2 and ran the VLM at step 3. Nothing can be
merged before the vision call returns, and the roadmap-presence branch cannot be decided
before it either — so the draft was unimplementable as written, and a builder following
it would have validated an intermediate shape that the branch then discards. The order
above is also the order the route already runs in: key resolve (`convert/route.ts:118`)
→ vision (`:126`) → map + validate (`:141`) → insert-only persist (`:149`).

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

## Decided while building B2b (not re-litigation — the spec did not say)

Three questions the sections above leave open, answered here so the next reader finds
them beside the rules they qualify rather than in a PR description.

1. **Where the never-gate sits in the route's numbered sequence.** After the
   already-exists pre-check, before the key resolve and the vision call. "Runs the vision
   call **unconditionally**" (§Payload and route extension step 2) means *not conditional
   on the roadmap branch* — a never-gate that fired after the call it exists to save
   would be pointless. An existing row still wins over the gate: a row is a fact the
   client can use, the gate is a policy about future spend.
2. **The roadmap discriminator is the BUILT calibration's roadmap, not the model's.**
   `buildCalibrationFromVision` drops structurally-unbindable markers before anything is
   persisted, so a chart whose only markers were dropped has no roadmap to protect and
   takes the measured path. The rule the branch enforces is "never install measured bars
   under markers that will be STORED".
3. **Disposition is whole-CHART, not per page** — every page notation ∧ complete to
   measure, every page not-notation ∧ complete to gate, anything else falls back. The
   per-page predicates are evaluated per page and folded once, at the end.
   **★ Measured 2026-09-03, 87-file corpus: ZERO files mix classifications** (62 notation
   throughout, 23 not-notation, 2 raster). So whole-chart granularity costs nothing
   today, and it avoids shipping a half-measured overlay whose unmeasured pages would
   read as a bug rather than as a fallback.

`System.verdict` is the persisted form of §Verdicts the engine emits — five values,
runtime-enum-checked at the same boundary that range-checks `confidence`. The engine's
`ProvisionalVerdict` is a separate declaration (that module imports nothing, by design)
and a test pins it as a subset so the two cannot drift.

The measured never-gate is DISCLOSED, not silent: it arrives as `ConvertState = 'gated'`
on the readiness strip with a line naming what was found and the hand-calibrate CTA — the
same shape as the two row-level gates, and still with no override (that remains its own
unstarted design, because `chart_library.role` is identity, so correcting it is a MOVE
between slots rather than a patch).
