# Every chart reaches a common roadmap (design)

**Status:** Track B anchors (§4.1) built — `lib/chart-section-headers.ts`, `POST /api/charts/sections`, the strip's Mark sections. Everything else is design only; build gated on Graham's explicit GO, one track per PR.
**Tracks:** backlog #204 ("chord charts get a usable count / structure path"), widened on
2026-10-27 to cover every kind of uploaded chart.

---

## 0. The goal, in Graham's weighting

A band's charts arrive in every form — engraved notation, ruled chord grids, chords over
lyrics, phone scans. Today only engraved notation gets a measured overlay; everything else
falls back to the vision model guessing coordinates, or to the owner calibrating by hand.

**Primary win: less calibration work on charts people already have.** Measured as: how many
edits an owner makes between "Build overlay" and "Verify" (systems moved, bars added or
removed, barlines dragged). **Secondary win: conductor out of the box** — a chart reaching
`bar-ready` with zero edits. Secondary because where there is a conductor, someone is usually
willing to calibrate (Graham, 2026-10-27).

The thesis that ties the tracks together: **whatever the chart looks like, it should land on
the same `ChartCalibration` + `RoadmapSpec` shapes the rest of ShowRunr already consumes**
(Perform, the review sheet, Conduct). Each track is a new *reader* feeding existing shapes,
never a new downstream model.

## 1. What the library actually contains (measured 2026-10-27)

The B1 engine on the 70-chart corpus (`~/chart-spike`, `measure-expected.json`), then a
segment / operator survey of the 8 charts it cannot measure:

| Kind | Count | Signal in the PDF | Reader today |
|---|---:|---|---|
| Engraved notation (5-line staves) | 62 | staves + barlines as vectors | **Measured** (B1/B2, 464/464 systems) |
| Ruled chord grid | 3 | vertical barlines in boxed rows, 7–23 grid rows | VLM estimate (weak) |
| Chords over lyrics, `[Verse]`-style tags | 3 | 150+ words, section tags, no lines | Gated (`not_notation`) **before** any VLM call (`route.ts:167`); filed as `lyrics`, never offered at all |
| Scan | 2 | images only, no text | VLM estimate (weak) |

**The live library is a different population (prod, measured 2026-10-27):** 349 charts, of
which **342 are filed `lyrics`. 321 of those carry section headers** (bare-line form —
`INTRO 4X`, `VERSE 1 8X`, `CHORUS x2`, `PRE-CHORUS` — the grammar of
`design-song-form-from-lyrics.md` §2; **none** use `[Verse]` brackets). 21 carry none. All 342
have a text layer. This is what makes Track B's anchors worth building first. *(The 321 is
the count under one rule: a text line that is exactly a section word — intro, verse,
pre-chorus, chorus, bridge, solo, outro, out, tag, ending, interlude, break, breakdown, vamp,
refrain, hook, instrumental, coda, turnaround — with an optional number, `Nx`/`xN`, and
colon; ≥ 2 such lines per PDF. A broader matcher finds more (Codex: 330).)* **Re-measured by
the anchors build (2026-10-27), with the shipped rule in `lib/chart-section-headers.ts`: 330 of
342** — see §4.1 step 2.

**Caveats, stated so they are not forgotten:**
- The corpus is one library. Its lyric-sheet share came from a friend's library and is **not**
  a market signal (Graham). Its scan share (2/70) is almost certainly **low** — Graham expects
  a decent share of real uploads to be scans. Track C below needs its own scan set.
- The three grids are one author's set (Pink Floyd). Grid detection must be tuned on more than
  one drawing style before it is trusted.

## 2. Track A — ruled chord grids: measure them like staves

**Why (third in order):** smallest change, reuses the whole measured pipeline (systems → bars →
calibration → review sheet), and it makes the C3 count fallback work on exactly the chart the
2026-10-27 drive used (Shine On).

**Where it plugs in.** `measurePage` (`lib/chart-measure.ts`) finds systems by grouping
horizontal rules into 4–6-line staves (`groupStaves`). When that finds none it classifies the
page `not-notation` and stops. Grids fail only that first step: the barlines are there.

**Design.** A second system finder, tried only when `groupStaves` returns nothing:

1. **Grid rows.** Vertical segments (same filter the engine already uses) bucketed by their
   top and bottom y. A bucket with ≥ N distinct x positions sharing one span is one row's
   barlines. Survey numbers: Shine On 66 verticals → 7 rows (max 10 barlines/row); Money 23
   rows; Brain Damage 22.
2. **System band** = the row's span (top/bottom of its barlines), x-extent = first to last
   barline. Bars = consecutive barline pairs.
3. **Output** = the same `MeasuredSystem` shape B2 produces, on a page whose
   `PageMeasurement` carries `staffCount: 0` (the count lives on the page, not the system) and
   a new `PageClass` value `'grid'`. That is a **boundary change, in the same PR**, at three
   sites: the `PageClass` type; `isValidMeasuredPayload` (`lib/chart-measured.ts:290`), which
   today accepts only `notation | not-notation | raster` and would 400 a grid payload in the
   convert route (`route.ts:86`) before disposition ever runs; and `measuredDisposition`, so a
   fully-grid page is `measured` instead of `gated`.
   The review sheet's re-measure (`openReviewSheet` → `measureOnePage` → `measurePage`) picks
   grids up with no further change, because the finder lives inside `measurePage`.
4. **No printed measure numbers** on grids, so `expectedSpans` is null: the review sheet shows
   one candidate ("Yes, N bars") and the count fallback ranks the measured barlines.

**Known gap from the survey:** Shine On's last line has only 2 barlines (one held bar), so a
≥3 threshold finds 7 of 8 rows. N=2 risks pairing stray verticals; the build measures both
on the three grids and on the 62 notation charts (must stay byte-identical — grid finding
never runs when staves exist).

**Acceptance:** the three grid charts measure every row; notation corpus parity unchanged
(PARITY clean, 464/464); the 2026-10-27 Shine On drive repeated shows a working count pad.

## 3. Track C — scans: pixels for geometry, the model for meaning

**Demoted (2026-10-27):** nothing here starts until Graham has better real scan examples.
Scans are still expected to be a real share of uploads and are where calibration labour is
worst, so the design stays; only its place in line moves. (Track letters follow the doc's
history; order is B, A, C — §6.)

**The lever.** For vector charts, overlays got good when measurement took GEOMETRY away from
the vision model and left it SEMANTICS (section names, roadmap marks). Scans get the same
split, with pixels standing in for vectors:

| Job | Owner |
|---|---|
| Section labels, bars-per-line counts, repeats/codas | vision model (unchanged prompt role) |
| Page deskew | pixels — projection-profile angle search |
| System bands | pixels — horizontal ink-density profile (staff-line clusters, or grid rules) |
| Barline x positions per band | pixels — the existing column-darkness detector, `lib/chart-snap.ts` `detectBarlines` |
| Fusion | per band: model's bar count + detected barlines → `resegment`-style pick of real barlines, or refuse |

`lib/chart-snap.ts` already detects printed barlines from a band's pixel profile, but only as
a manual calibration assist after the fact. This track runs it at **overlay-build time**, on a
deskewed raster, so the draft calibration is born close to right.

**The review sheet is NOT ready for scans — this track must build that half too.** Every
band where pixels and the model disagree, or detection is weak (`MIN_COVERAGE` /
`MIN_STRENGTH` misses), is flagged `uncertain`. But the C3 sheet cannot use pixel evidence
today: `openReviewSheet` (`page.tsx:3495`) re-measures the PDF's **vector** geometry, finds no
system on a scan, and `countReadiness` (`lib/chart-review-sheet.ts:258`) returns
`unreadable` — the count fallback refuses. So the track includes a scan-aware candidate
source: on open, a raster page re-runs the pixel detector for that band (re-derive, never
persist — same rule as the vector re-measure). Its output is NOT the ranker's input, and is
not adapted into it: `detectBarlines` (`lib/chart-snap.ts:35`) returns band-relative `x` (0 =
band start, 1 = band end) plus a `strength`, while `proposeFromCount`
(`lib/chart-review-sheet.ts:277`) takes page-space `MeasuredCluster`s and its ranker
(`lib/chart-resegment.ts:77`) chooses on endpoint error and stroke width — evidence a scan does
not have. So scans get their own count rule:

- **Coordinates:** page-normalized `x = system.x0 + x_band × (system.x1 − system.x0)`.
- **Exact match only.** N bars need N − 1 interior lines. Detected interior lines (after the
  `MIN_STRENGTH` prefilter) == N − 1 → propose them. Any surplus or deficit → **refuse** with
  the existing refusal path, and the owner drags barlines by hand. No drop-the-weakest rule:
  whether `strength` separates real lines from stray ones is a question for the scan set's
  measurement, not this design.

Only then do scans get the "is this right? → no → how many bars?" flow vector charts have —
answered when the evidence is unambiguous, refused when it is not.

**Needs before build:**
1. **A scan set.** ~10–20 real scans (phone photos and flatbed), hand-calibrated once as ground
   truth. Without it there is nothing to tune or score against. *(Graham: source them.)*
2. **Score:** share of systems confirmed with no edit; mean barline error (px at render scale);
   edits-to-Verify per chart, against today's VLM-only path on the same set.

**Not in scope:** making a bad scan look good. The overlay stays bound to the source's flaws.

## 4. Track B — chords over lyrics: structure, plus section anchors

**Why first (revised 2026-10-27):** the data exists, and it is the format Graham reads and can
judge — the feedback loop on a proposed roadmap is his own. It does not reduce bar-geometry
calibration (these sheets have no barlines); it removes the need for it on these charts by
seeking on sections instead.

**What it can do.** Two things, both from text the PDF already carries:
1. **Section anchors, one tap from Verify.** The position of each section header (`VERSE 8X`,
   `[Chorus]`) is real page geometry. Turning headers into `SectionAnchor`s gives
   `section-only` readiness — "tap a section to seek" — with no geometry calibration. Small,
   and the highest-value part of this track: 321 of 342 live lyric sheets qualify (§1).
2. **A seeded roadmap draft.** Tags + chord lines feed the existing lyrics proposer
   (`docs/design-song-form-from-lyrics.md`, designed, unbuilt) to propose a `RoadmapSpec`,
   which the owner refines in the builder. This is the bridge between "hacks" reading chord
   sheets and readers reading notation: both end on one roadmap.

### 4.1 Anchors: the write path and who verifies

Anchors alone do not reach `section-only`: `performReadiness` (`lib/chart-calibration.ts:193`)
needs a **persisted, verified** calibration, and today a lyric sheet never gets one — role
`lyrics` is refused before measurement, and a mislabeled one is refused at the `not_notation`
gate (`route.ts:167`) before any row is written. So:

1. **The gates block the AI call, not the tag read** (Graham, 2026-10-27; amends
   `backlog-charting.md` §Ruled 2026-09-02 in this PR). Both never-gates exist to save VLM
   spend and review debt. A header read spends nothing and produces no uncertain badges, so
   neither gate applies to it. `overlaySkipReason` keeps its meaning — "never send to the
   converter" — unchanged.
2. **Reader (client, pure).** A shared header recognizer in `lib/` — bare-line form per
   `design-song-form-from-lyrics.md` §2, plus `[Label]` brackets — over the pdf.js text
   layer, grouped into lines by baseline. Each header → `{page, x, y, label}`, normalized to
   0..1 from the text item's transform and the page size, `y` at the glyph top. `label` is the
   header with its `Nx` / `xN` count stripped, as printed ("Verse 1"). The proposer (step 3)
   reuses the same recognizer and adds the counts — one grammar, two consumers.
   **Acceptance:** run on the 342 cached live lyric sheets — finds headers on ≥ 321, and a
   hand-checked sample shows no lyric line misread as a header.
   **Result (2026-10-27, `scripts/chart-section-headers-acceptance.ts`): 330/342, 2,407
   headers, all 56 distinct labels section names.** The run forced three rules: (a) split a
   line at column gutters (two-column sheets put a left header on a right lyric's baseline;
   without this it was 142/342); (b) a bare header starts with a capital (all 3 lowercase hits
   were a lyric's last word wrapped onto its own line, "…shake it / out"); (c) skip text at
   ≥ 1.5× the page's median size (the song "Breakdown" read its own title as a section).
   The 12 misses: 6 medley index sheets with no headers, and 6 whose headers carry notes the
   strict grammar refuses — mashup prefixes (`JUICE VERSE 8X`), unknown counts (`INTRO ?X`,
   `VERSE 1 X`), annotations (`VERSE 2 9X (8THS)`, `CHORUS 24X ?`). Those 6 still get the
   plain Calibrate line.
3. **Entry point.** The Perform strip's `none` state, for a chart that will not get an
   overlay (`overlaySkipReason === 'lyrics'`, or a client-side `measuredDisposition` of
   `gated`) and whose text layer has ≥ 2 headers: "N sections found" + **Mark sections**.
   Builder charts (`authored`) are excluded; they are born verified already.
4. **Route — new, `POST /api/charts/sections`**, not a branch of `/api/charts/convert`. The
   convert route's gate order is reasoned entirely around spend; threading a no-spend
   exception through it is how a gate drifts. The new route reuses its boundaries:
   owner-scoped (403), `source_hash` checked against the stored bytes (409), each anchor through
   `isValidSectionAnchor`, and generate-once on `(chart_id, source_hash)` (`ON CONFLICT DO
   NOTHING`). It writes a **draft** calibration: `sections` only, no systems or bars, no
   roadmap. No key resolve, no VLM.
5. **Who verifies: the owner, with the button that exists.** A sections-only draft with
   labeled sections is `canVerify` → `verifiable`, and the strip already says "Draft — Verify
   to perform" → Calibrate (sections tool) → Verify → `section-only`. Not born-verified: that
   is reserved for charts whose structure the owner *authored*; this is a machine read of
   their PDF, and the owner signs off on machine reads.

### 4.2 Open-ended directions

**Requirement — open-ended directions stay in place (Graham, 2026-10-27).** Charts carry
lines like "A7sus4 vamp until signaled change" or "free-form solo over chorus until done",
the same family as a `—— 8 bars ——` shorthand note. The proposer keeps them **verbatim,
in place, inside their section**: not suppressed, not ignored, and not translated into a bar
count.

Today this **cannot be represented**: `RoadmapSection` (`lib/roadmap-spec.ts:28`) has no note
field and requires a positive finite `bars`, and `design-song-form-from-lyrics.md` §8 decision 1
discards all text except headers. So the proposer is **not** one build PR. It needs a design
amendment first, to that doc, which (a) splits "lyrics" (discarded — §3's reasoning holds)
from "performance directions" (kept, verbatim), and (b) picks the `RoadmapSpec`
representation — a section note, an open-length section, or both — with its
`validateRoadmapSpec` and renderer consequences. Only then a build PR.

**Build order inside the track:** anchors (own PR) → proposer design amendment (docs PR) →
proposer build (own PR).

## 5. Later — a clean chart *from* a scan (formerly "Track B" of 2026-08-27)

A creation method, sibling of the builder's "describe it" box: "draft me a ShowRunr chart from
this PDF". Needs chords, meter and key (OMR-grade), which nothing extracts today. Gated on a
feasibility spike: can the vision model recover chords + meter well enough to *review*, as a
seeded draft? Full music OCR (Audiveris is AGPL; oemer) is heavy and server-side; not needed
for any track above.

## 6. Sequencing and PRs

**Revised by Graham after reading the spec (2026-10-27):** lyrics → roadmap first. We have the
data, and it is the track Graham can judge with an informed opinion; notation is the one he
reads least. Scans drop to the end until better examples exist.

1. **Remove the #207/#208 placeholder advisory** — one PR. The setlist is the placeholder:
   a song with a title and key and no chart is already fully represented there (Graham,
   2026-10-27). Prod held exactly one placeholder PDF; it was deleted 2026-10-27, and the 17
   in the corpus were a bandmate's local swipe set, never uploaded.
2. **Track B anchors** — one PR, §4.1: section headers → draft sections-only calibration →
   owner Verify → section-only seek.
3. **Track B proposer** — design amendment (docs PR), then build (own PR), §4.2.
4. **Track A** grids — one PR, including the `'grid'` boundary change (§2).
5. **Track C** scans — **demoted**: nothing starts until Graham has better real examples; then
   a spike PR (scan set + scoring harness), then build, including the scan-aware review path
   (§3).
6. **Later** — spike only.

Each PR: browser drive before Codex (canvas work is invisible to jsdom — #184's blank strip).

## 7. Graham's answers (2026-10-27)

1. **Scan set:** Graham will ask friends to share real scans. Track C is demoted to last and
   waits on better examples.
2. **Grid row minimum:** accept a 2-barline row, confirmed by the build's measurement on the
   three grids and the notation corpus.
3. **Section anchors without bars:** yes, worth shipping on their own. "It certainly is for
   me — a non-reader." Seeking by section is the non-reader's way around a chart.
4. **Anchors on charts filed `lyrics`:** yes. The never-gates block the AI call, not a
   spend-free header read (§4.1).
5. **Placeholder PDFs:** not a chart concept at all — the setlist already carries title and
   key. Delete them, and remove the #207/#208 advisory (§6 step 1).
