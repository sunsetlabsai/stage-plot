# Every chart reaches a common roadmap (design)

**Status:** design only. Nothing built. Build gated on Graham's explicit GO, one track per PR.
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

The B1 engine on the 87-chart corpus (`~/chart-spike`, `measure-expected.json`), then a
segment / operator survey of the 25 charts it cannot measure:

| Kind | Count | Signal in the PDF | Reader today |
|---|---:|---|---|
| Engraved notation (5-line staves) | 62 | staves + barlines as vectors | **Measured** (B1/B2, 464/464 systems) |
| Placeholder (title + key only) | 17 | ≤7 words, one filled box (≤4 inked segments), no images | **Not a chart** — #207 says so, offers nothing |
| Ruled chord grid | 3 | vertical barlines in boxed rows, 7–23 grid rows | VLM estimate (weak) |
| Chords over lyrics, `[Verse]`-style tags | 3 | 150+ words, section tags, no lines | VLM estimate, then gated (`not_notation`) |
| Scan | 2 | images only, no text | VLM estimate (weak) |

**Caveats, stated so they are not forgotten:**
- The corpus is one library. Its lyric-sheet share came from a friend's library and is **not**
  a market signal (Graham). Its scan share (2/87) is almost certainly **low** — Graham expects
  a decent share of real uploads to be scans. Track C below needs its own scan set.
- The three grids are one author's set (Pink Floyd). Grid detection must be tuned on more than
  one drawing style before it is trusted.

## 2. Track A — ruled chord grids: measure them like staves

**Why first:** smallest change, reuses the whole measured pipeline (systems → bars →
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
3. **Output** = the same `MeasuredSystem` shape B2 produces, with `staffCount: 0` and a new
   page classification `'grid'`, so `measuredDisposition` treats a fully-grid page like
   notation (`measured`) instead of `gated`.
4. **No printed measure numbers** on grids, so `expectedSpans` is null: the review sheet shows
   one candidate ("Yes, N bars") and the count fallback ranks the measured barlines.

**Known gap from the survey:** Shine On's last line has only 2 barlines (one held bar), so a
≥3 threshold finds 7 of 8 rows. N=2 risks pairing stray verticals; the build measures both
on the three grids and on the 62 notation charts (must stay byte-identical — grid finding
never runs when staves exist).

**Acceptance:** the three grid charts measure every row; notation corpus parity unchanged
(PARITY clean, 464/464); the 2026-10-27 Shine On drive repeated shows a working count pad.

## 3. Track C — scans: pixels for geometry, the model for meaning

**Why second:** Graham expects scans to be a real share of uploads, and they are where
calibration labour is worst today. (Track letters follow the doc's history; order is A, C, B.)

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

**The safety net is already built.** Every band where pixels and the model disagree, or
detection is weak (`MIN_COVERAGE` / `MIN_STRENGTH` misses), is flagged
`uncertain` — and the C3 review sheet takes it from there, with the detected barlines as its
candidates and the count fallback ranking them. Scans get the same "is this right? → no → how
many bars?" flow vector charts have.

**Needs before build:**
1. **A scan set.** ~10–20 real scans (phone photos and flatbed), hand-calibrated once as ground
   truth. Without it there is nothing to tune or score against. *(Graham: source them.)*
2. **Score:** share of systems confirmed with no edit; mean barline error (px at render scale);
   edits-to-Verify per chart, against today's VLM-only path on the same set.

**Not in scope:** making a bad scan look good. The overlay stays bound to the source's flaws.

## 4. Track B — chords over lyrics: structure, plus section anchors

**Why last:** lowest weight (the corpus share is not representative), and it does not reduce
calibration on bar geometry — these sheets have no barlines.

**What it can do.** Two things, both from text the PDF already carries:
1. **Section anchors for free.** The y position of each `[Verse]` / `[Chorus]` tag is real page
   geometry. Turning tags into `SectionAnchor`s gives `section-only` readiness — "tap a section
   to seek" — with zero calibration. Small, and the highest-value part of this track.
2. **A seeded roadmap draft.** Tags + chord lines feed the existing lyrics proposer
   (`docs/design-song-form-from-lyrics.md`, designed, unbuilt) to propose a `RoadmapSpec`,
   which the owner refines in the builder. This is the bridge between "hacks" reading chord
   sheets and readers reading notation: both end on one roadmap.

**Build order inside the track:** anchors first (own PR), proposer second (folds into the
lyrics design rather than a parallel one).

## 5. Later — a clean chart *from* a scan (formerly "Track B" of 2026-08-27)

A creation method, sibling of the builder's "describe it" box: "draft me a ShowRunr chart from
this PDF". Needs chords, meter and key (OMR-grade), which nothing extracts today. Gated on a
feasibility spike: can the vision model recover chords + meter well enough to *review*, as a
seeded draft? Full music OCR (Audiveris is AGPL; oemer) is heavy and server-side; not needed
for any track above.

## 6. Sequencing and PRs

1. **#207** placeholder PDFs — in review.
2. **Track A** grids — one PR. Small.
3. **Track C** scans — spike PR (scan set + scoring harness, no product change), then build PR.
4. **Track B** — anchors PR, then proposer PR.
5. **Later** — spike only.

Each PR: browser drive before Codex (canvas work is invisible to jsdom — #184's blank strip).

## 7. Open questions for Graham

1. **Scan set:** can you supply 10–20 real scans (your band's or a friend's), and is
   hand-calibrating them once as ground truth acceptable, or should the harness score against
   barlines you mark on a printout?
2. **Grid row minimum:** accept a 2-barline row (finds Shine On's held last bar, more false-pair
   risk) or require 3 (misses one-bar rows; the owner adds them)? Recommendation: 2, gated on
   the build's measurement.
3. **Track B anchors without bars:** is `section-only` (seek by section, no bar cursor) useful
   enough on stage to ship on its own?
