# Design: Realtime Chart Control (Perform-mode redline) + Chart Calibration

**Status:** Proposed (v1.2) — all five Codex R1 findings resolved (see "R1 resolutions" below); ready for R2
**Date:** 2026-06-08
**Branch:** `opus/design-realtime-chart-control`
**Target/benchmark:** ForScore — a static PDF reader (library + setlists + pedal page-turns + annotations). Everything here is the *live, band-aware* layer ForScore structurally lacks.

---

## R1 resolutions (Codex adversarial pass on `bc039c1`)

- **#3 (HIGH) gesture conflict with the inline viewer — RESOLVED.** Root cause: the canvas tap surface is *fully* allocated to page-turns (`page.tsx:1544`) and tap fires immediately on `touchend` (no double-tap window — why paging feels snappy), so seek can't be a canvas-wide tap and double-tap-to-hold would tax every tap. Fix: **redline auto-turns pages** (demotes manual paging) → **seek = tap a section marker** (object above the canvas, like the existing pill-picker) · **hold/loop = long-press** (not double-tap) · no zone grid · explicit precedence/hit-test + follow-mode scope. See "Gesture model (Perform mode)" under Concept A.
- **#1 (HIGH) build-order bootstrap — RESOLVED.** The chicken/egg: A is "step 1" but seeks into a nav graph that the converter (step 3) and editor (step 4) produce. Fix: the **graceful-degradation manual marker-rail *is* the bootstrap** — A's first shippable unit is *A over a hand-placed, sections-only rail* (tap to drop section markers; zero converter, zero vision, no bar-level geometry required). Seek snaps to section heads; redline parks/advances coarsely; the converter + auto-distribute + bar ticks are **enrichment that makes creation cheap, not prerequisites.** This is the same "convert-it and hand-tag-it are one tool" insight, applied to sequencing. See revised Build order step 1.
- **#2 (HIGH) calibration persistence / invalidation — RESOLVED.** The library has no version concept (`chart_library` is `unique(owner_id, song_key, role)`, upsert replaces — design-chart-library.md:496), so the **PDF content hash becomes the de-facto version.** Content-hash-keyed sidecar; apply-only-on-match; mismatch ⇒ stale, never silent-apply; carry-forward old anchors as a low-confidence draft. See "Calibration persistence" below.
- **#4 (HIGH) temporal model for the redline — RESOLVED.** Thin temporal layer on the graph: beats-per-bar from time sig, per-bar override for pickups, **nullable tempo** (null ⇒ redline is seek-only-advance, not broken), fermata/caesura = **hold point** (park, don't clock). See "Temporal model" below.
- **#5 (MED/HIGH) reconcile with `design-storage-notation` (Markdown-first direction) — RESOLVED.** No format conflict: storage-notation owns the chart *artifact* (`.md`/`.pdf`); chart-control owns a calibration *sidecar* (not a chart-storage format — corrected an overreach below). The nav+temporal layer is **source-agnostic**; only the physical-anchor layer forks into `pdfBox` vs `mdBlock` adapters. `.md` charts get near-free structural extraction (their `##`/`| bar |` syntax *is* the nav skeleton). Fingerprint keys align (PDF sha256 / `.md` git blob sha). See "Reconciliation with `design-storage-notation`" below.

---

## Problem

In live performance, the position in a chart deviates from any pre-computed assumption:

- A player **takes a left turn** (unintended).
- The **MD makes an intentional realtime change** — "take another round of the solo," "back to the top," "jump to the third chorus."

A redline/cursor that advances on assumed BPM drifts out of sync with reality the moment any of this happens. We need ways to **re-orient the redline live**, robust to a venue with no reliable network.

**Target user:** working *acts* where essentially everyone reads charts — not casual bands. (Authoring caveat: spec author is a musician + software designer but not a chart-reader nor a ForScore user; UX bets below are explicitly flagged for chart-reader validation.)

---

## The reframe — one primitive, three automation levels

The atom under every idea here is a **seek**: *re-anchor the redline to position X.* The three concepts are the same primitive automated to different degrees:

| Concept | What it is | = |
|---|---|---|
| **A — Manual seek** | A performer taps a section marker (long-press to hold/loop) to re-orient their own redline | the primitive |
| **B — Networked seek** | MD/conductor is leader; their seek broadcasts to followers | A, broadcast |
| **C — Automated seek** | Audio listener decides where the redline should be | A, triggered by a listener |

**They layer, and A is the foundation.** B is literally A's action broadcast; C is A's action triggered by audio. A is also the **manual override** B and C will *always* need (audio mis-fires; you'll want to grab the wheel). **Build order: A first** — it ships standalone value, and de-risks + underpins B and C.

### Scope insight that resizes effort
The headline use case — *intentional MD changes* — is **human-initiated** and is solved completely by **A + B**. It does **not** need C. Audio detection (C) only buys two things A+B don't: (1) hands-free, and (2) catching *unintended* drift. The hardest piece is therefore **not on the critical path** for the use case that motivated the feature.

---

## Concepts — feasibility & decisions

### A — Tap a marker to re-orient (manual seek)
- **Feasibility: high.** Fully local; no network, no ML.
- **Decision:** A is v1's foundation and the universal manual fallback. Gesture model below (resolved against Codex #3).

#### Gesture model (Perform mode)
The conflict (Codex #3): the inline viewer already spends the *entire* canvas tap surface on page-turns (`page.tsx:1544`, tap fires immediately on `touchend`, no double-tap window — that's why paging is snappy). A canvas-wide "tap to seek" or "double-tap to hold" would collide head-on with paging and tax every page-turn. Resolution = **make seek an object, not a surface; make paging automatic; never overload the bare canvas tap.**

| Action | Gesture | Notes |
|---|---|---|
| **Change song** | swipe L↔R · arrow ←/→ | unchanged from inline viewer (existing dominant-axis lock, 60px trigger) |
| **Change page** (manual) | redline **auto-turns** (primary) · swipe ↑/↓ · existing tap-half (secondary) | auto-turn demotes manual paging to backup; the existing tap-half stays as a harmless fallback |
| **Seek** (re-anchor redline) | **tap a section/bar marker** — a discrete object rendered *above* the canvas | like the pill-picker: the marker captures the tap and `stopPropagation()`s so it never reaches the page-turn handler. Section-granular by default (markers = section heads + rehearsal letters), not every bar — fewer, fat targets on stage. |
| **Hold / loop** (vamp a section) | **long-press a marker** (~450ms) | replaces double-tap (double-tap would tax every page-turn tap). Enters a visible **`◌ LOOPING — Chorus`** state; tap anywhere / next marker to release. |
| **Fine nudge** | drag the redline | rare live; mostly an Edit-mode affordance |
| **Back / Edit / app nav** | header buttons | chrome, not canvas gestures — no hidden zones |

- **No zone grid.** Center-tap surfaces the transport/controls overlay; everything else is an object tap or an existing swipe. (Considered a tap-zone scheme — rejected: invisible quadrants are unlearnable on stage and fight the existing tap-half paging.)
- **Hit-test precedence (z-order):** markers + redline handle → center controls → page-turn tap-halves → swipe. First hit wins; markers `stopPropagation`.
- **Long-press guards:** `touch-callout: none` + `contextmenu` `preventDefault` (kill iOS magnifier/context menu) + a haptic tick on entering loop so the player *feels* the mode change without looking.
- **Anti-mis-seek:** seek is a deliberate marker hit, not a bare canvas tap — a sleeve-brush on the page body pages (harmless) rather than re-seeking.
- **Follow-mode scope:** in B, only the **leader's** seek/hold broadcasts; a follower tapping their own marker is a *local* override (grab-the-wheel), it does not broadcast.

### B — Leader/follower sync (networked seek)
- **Logic is easy** (reuses A; leader's seek + hold events broadcast). **The transport is the real architectural fork:**
  - **Bluetooth mesh in a PWA — not viable.** Web Bluetooth is GATT-to-a-peripheral, not phone-to-phone, and **iOS/Safari does not support it at all.** True zero-infra BT mesh ⇒ a **native shell** (Capacitor/RN over MultipeerConnectivity on iOS / Nearby Connections on Android) — a platform shift, not a feature.
  - **Stay-PWA ⇒ WebRTC data channels** (peer-to-peer; low-latency on a local LAN/hotspot) or a tiny WebSocket relay. Cheap and sub-200ms on local WiFi — but depends on *some* network (even if not backhauled to the internet).
- **The honest tradeoff:** zero-infra (BT) costs a native rewrite; staying-PWA (WebRTC) costs a dependence on a local WiFi/hotspot.
- **Decision (provisional):** **stay PWA** — eases App Store process; the primary native problem (offline use) is already solved (in-app notifications excepted). **OPEN — pending team input:** is local-WiFi-without-backhaul acceptable to the players, vs. a true peer-to-peer mesh with a designatable MD node? This decision **blocks nothing else** — the chart format, converter, and concept A are transport-agnostic and proceed regardless.
- **Simplifier:** broadcast **discrete seek/hold events**, not a streamed clock. Each device runs the redline locally and just receives "jump to bar N / hold section S **now**." No NTP-style clock sync needed; plenty tight for humans.

### C — Audio auto-sensor (automated seek)
Two very different difficulty tiers, currently conflated under "audio aware":
- **Tempo-awareness** (adjust redline *speed* to live tempo vs assumed BPM) — *tractable* (Web Audio onset/beat tracking; noisy in a loud live mix). A plausible v-future.
- **Score-following / jump-detection** (know you took another solo round / jumped to chorus 3) — **research-grade** on a live, improvising, polyphonic band; intended-vs-unintended is genuinely ambiguous.
- **Reframe that rescues it:** ride C **on top of B** and follow **one source — the MD's audio/click** — not the ensemble. "Whose deviation wins" collapses to "the leader's." Key detection is dropped: a cool signal but it doesn't tell you *position*, so it isn't load-bearing for a redline.
- **Decision:** C is **deferred**, and when revisited is rescoped to *follow-the-leader audio only*. Not in the first build.

---

## The chart model — you don't need OMR, you need a road-map

The load-bearing realization: **the redline doesn't care about a single note.** It cares about *position on a timeline* — bars, sections, repeats, the road map. So the genuinely hard parts of music recognition — pitch, articulation, and **rhythmic subdivision (¼ vs ⅛ vs 1/16)** — are **irrelevant.** We are not transcribing music; we are extracting a **navigation skeleton.** ~80% of classic OMR difficulty is discarded.

### What the redline actually needs from a page
- **Barlines / measure count** — lay out the timeline
- **System (line) breaks + coordinates** — place the redline spatially
- **Section markers** (rehearsal letters, "Chorus," "Solo")
- **Navigation / road map** — repeats, 1st/2nd endings, D.S., Coda, Fine
- **Time signature** — beats-per-bar → redline *speed*
- **Tempo & key** — nice-to-haves (key is low-value here)

### Overlay, don't re-render
Two strategies for a "native format":
- **(i) Full conversion** → re-render in our engine. Max control, but must nail engraving *and* loses the chart's exact look (which pro players are attached to).
- **(ii) Overlay/anchor** → **keep the original PDF as the visual canvas**; extract only a *sidecar timeline map* (bar N → page + bounding box). The redline is an overlay layer on the PDF we already render.

**Decision: (ii).** Sidesteps re-engraving, preserves the chart's look, and shrinks the agent's job from "transcribe music" to "find barlines, systems, section labels, and road-map jumps → coordinates + confidence." It works for **both** chord/rhythm charts and full staff parts because it only hunts barlines/sections/coords. It degrades gracefully (see handwritten charts).

**Consequence:** what we extract is **not a chart-storage format** — it is a thin **navigation/timeline graph that rides alongside the chart artifact as a calibration sidecar.** (Correction vs v1: an earlier draft called this the chart's "native format" — overreach. The chart artifact stays whatever `design-storage-notation` says it is — `.pdf` or `.md`; the nav-graph is a *companion*, not a replacement. See Reconciliation below.) This sidecar is what A taps to seek into, B broadcasts positions in, and C tries to detect.

---

## Data model (the navigation graph)

Two **distinct layers** — keep them separate; conflating them is a trap.

### 1. Physical anchors (geometry — where a bar is *positioned on the rendered canvas*)
1:1 with the chart's visual rendering. A bar has exactly **one** positioning handle. This layer is the **only** part that knows about the source artifact; it has two concrete adapter flavors (see Reconciliation):
- **`pdfBox` adapter** (PDF/image source): `Page { index, w, h }` (coords **PDF-relative / normalized**, never screen pixels — survive zoom/rotation/device size) · `System { id, page, yTop, yBottom, barlines: [x...] }` (a staff row; redline sweeps L→R then snaps to next) · `Bar { id, systemId, xStart, xEnd, absNumber }`.
- **`mdBlock` adapter** (`.md` source): a bar references a rendered-markdown location instead of a pixel rect — `{ sectionHeading, rowIndex, cellIndex }` against the `##`/`| bar |` structure. No vision needed; the markdown *is* the skeleton.
- Either way, each anchor carries **per-element confidence** (see review queue), and the navigation + temporal layers above are **identical regardless of adapter.**

### 2. Navigation (logic — what *order* bars are played)
A **directed graph over the physical anchors**. This is where a single printed bar can be **visited multiple times**.
- Nodes = physical bars. Edges = "what comes next," including **back-jumps** (repeats, D.S., D.C.) and conditional edges (1st/2nd endings keyed on pass).
- Markers: `repeatStart/End`, `ending{n}`, `D.S.`, `D.C.`, `Coda`, `Fine`.

### The timeline is non-linear: position = `(bar, pass)`
The redline's true position is **not "bar 37" but "bar 37, pass 2."** The road-map graph models passes. This ripples into B (broadcast `(bar,pass)`) and C (detect pass). The **physical** editor edits one box per printed bar; the **navigation** layer says it's visited twice — these stay distinct.

### The two-detector model (resolves "Snap to printed line")
A correction critique surfaced this: re-running the *same* detector on the *same* chart can't improve a position. So there are **two different detectors, different precision/scope:**
1. **Structural pass — import-time, vision/agent.** Coarse but *semantic* ("4 bars here, this is the Chorus, there's a D.S."). Run **once over the whole page**; deliberately not pixel-precise (a full page has many false vertical strokes — note stems, slashes).
2. **Local edge-snap — correction-time, on demand.** A precise raster-gradient scan in a *small window* around the touched tick: exact x of the nearest strong printed vertical line. Never run page-wide (too noisy/costly); invoked on the one bar being fixed.

"Snap to printed line" = run detector #2 locally. It can legitimately differ from the import position because it's a *more precise, locally-scoped* detector — not the same one re-run.

---

## Conversion + confidence

The agent's job = road-map extraction, not OMR. Plays **to** vision-LLM strengths (structure, labels, layout) and **away** from its weakness (precise sub-beat rhythm — which we don't need).

- **Difficulty tiers:** easy-ish (time sig, key, section labels, tempo — explicit text/glyphs); moderate, quality-dependent (barline + system-layout coordinates — the real anchoring work); **the meat** (repeats / D.S. / Coda / endings — detecting the glyph vs. *resolving the jump target* semantics; what makes following accurate on "back to chorus 3").
- **Confidence is per-element, not one global score** — bar count may be 100% while a D.S. jump is 25%. A global number buries the one thing a human must fix.
- **Review queue** in the add/CRUD flow surfaces only the *flagged* elements ("4 barlines uncertain, 1 navigation jump needs confirm") with one-tap fixes. (Same confidence-gated-correction pattern as the AI co-designer; reuse the mental model.)
- **Guiding principle (author):** *correction must never exceed creation.* Below a quality floor, editing the conversion should cost less than re-charting from scratch; if it doesn't, prefer hand-authoring. Auto-distribute (below) is the lever that keeps correction cheap.

---

## The Chart Calibration Editor (CRUD / library)

Where a human nudges the overlay to match the underlying PDF. **Lives at the chart-library (per-chart) level — calibrated once, reused by every show "book" that references the chart.** The book-assembly view *surfaces* a "not calibrated yet" flag and deep-links into the chart editor, but the edit is **chart-scoped, never show-scoped** (avoids forked/duplicated corrections).

A live clickable mockup of this editor is referenced below.

### Gizmos
"Slide the lines" is several distinct primitives — name them so it isn't one undifferentiated drag:
- **System bands** — the y-region each staff row occupies (drag/resize vertically; resize grips). Carries the `± bars` stepper and **auto-distribute**.
- **Barline ticks** — x-positions within a system (drag horizontally to the real barline). Color-coded by confidence.
- **Section boundaries** — where a labeled section starts.
- **Navigation markers** — repeat / D.S. / Coda endpoints (reposition *and* re-target).

Mental model: the redline is a **1-D path embedded in 2-D page space** (L→R across a system, snap down to next, cross pages). The human adjusts where that path and its bar-ticks sit.

### The effort floor: auto-distribute
Do **not** hand-place every barline. The realistic unit of work = **anchor system boundaries + set bars-per-system → auto-distribute the ticks evenly**, with per-tick nudge *only* for irregulars (pickup bars, a stretched measure). Most charts are visually even, so this handles ~90% of bars for free — the difference between a ~20-second calibration and a tedious one. Assists: **snap to printed line** (detector #2), **copy-system layout**, **confidence-gated** (only flagged anchors surface by default; drop-into-full-edit for power users).

### Primary review affordance: verify-by-playback (scrub/play)
Static line positions are hard to eyeball. The **scrub/play preview** sweeps the redline over the *actual PDF* — you instantly see if it tracks, including the back-jump on a repeat (the only on-screen proof of the non-linear `(bar,pass)` timeline). *Actions > words.* Manual scrub is also **faster than play-at-tempo** for verification, so it stays efficient. Treat scrub-preview as the **primary** review affordance; the drag-gizmos are the fix-when-wrong tool.

### Hybrid navigation layer (decided)
Three options were prototyped/considered:
- (a) **Two-mode toggle** (Anchors ↔ Road map): clean canvas, but you lose road-map context while dragging and pay a mode switch.
- (b) **Always-on full overlay**: full context, but repeat arcs over a dense chart fight the very barlines you're aligning.
- (c) **Hybrid:** anchors always editable; navigation shown as **lightweight always-on badges** at boundaries (⟲ repeat / D.S. / Coda); **heavy graphics (arcs, re-pointing) render only on hover/focus.**

**Decision: (c) Hybrid.** Driven by the **asymmetry** — per chart there are *dozens* of barlines but only a *handful* of navigation events, so editing is overwhelmingly spatial and navigation is a light occasional confirm. A co-equal toggle over-taxes the rare part. (Also serves "correction must never exceed creation.")

### Edit vs Perform weighting (decided — a separate axis)
The overlay carries **more visual weight in Edit, recedes in Perform.** In **Perform**, bands hide, confidence ticks fade to faint hairlines (caps gone), the legend/review panel dim, nav badges shrink to **dim glyph-only**, and the **redline brightens/thickens as the one thing that pops** — the chart is the meat. Same overlay, two personalities.
- **Decision:** keep the **dim nav glyphs in Perform** (novice finds the quiet "a repeat lives here" reminder helpful as *emphasis*; an expert may read them as distracting duplicates). Reverting to no-emphasis later is a trivial styling/config flag (`.page.perform .navmark`), and can become a per-user "show road-map cues in Perform" toggle. Zero structural cost — default stays novice-friendly.
- This axis is **orthogonal** to the nav-layer model (it would apply even under the classic toggle); treat it as its own design dimension.

### Two more clean-design rules
- **Physical anchors vs navigation are separate edit surfaces** (drag "where bar 37 sits" ≠ graph-edit "the road map hits it twice").
- **Page turns mid-song** — the timeline crosses pages; anchors carry a page index (falls out of the overlay approach).

### Temporal model (how the redline *moves* between seeks)
A (manual seek) only re-anchors; something still has to move the redline forward. Bars aren't uniform in time, so the graph carries a **thin temporal layer** — deliberately minimal, and honest about what we can't read off a page.

- **Beats-per-bar** — from time signature (already in the extract list). Sets the per-bar duration unit.
- **Per-bar `beats` override** — pickups/partial bars (a 2-beat pickup in 4/4 isn't a full sweep). Geometry stays one box per printed bar; the temporal layer overrides duration.
- **`tempoBpm` is nullable.** From a marking at import; absent/handwritten ⇒ no clock — and that's fine: **A needs no tempo at all** (the player drives the seek). Tempo only powers *auto-advance between seeks*, so null degrades to **"redline only moves on seek / page-turn,"** not a broken feature. (Dovetails with C-tier-1 tempo-awareness being deferred — when it lands it *fills in* this nullable field live.)
- **Fermata / caesura / rit. = `holdPoint`, not a duration.** These are genuinely un-clockable live; don't pretend to model their length. The redline **parks at a hold point and waits for the next seek** (manual A, or leader broadcast B). This is exactly where A/B earn their keep — we mark the un-clockable spots instead of guessing them.

Shape: `temporal: { beatsPerBar, perBarBeatsOverride?, tempoBpm?: null, holdPoints: [barId...] }`, stored *inside* the calibration graph JSON (so it versions and invalidates with the rest of the calibration).

### Calibration persistence (where the graph lives, and when it goes stale)
The calibration *is* the navigation-graph JSON. It must survive ordinary re-uploads but never be silently mis-applied to a *different* PDF. The trap: the library has **no version concept** — `chart_library` is `unique(owner_id, song_key, role)` and **upsert replaces** (design-chart-library.md:496, "No version history"). So there is nothing to "attach a version to." Resolution: **the PDF content hash becomes the de-facto version.**

- **`chart_library` row gains:** `content_hash` (sha256 of PDF bytes), `page_count`, `page_dims` (for normalized-coord validation).
- **New sidecar `chart_calibration`, keyed `(chart_id, source_hash)`:** `schema_version` + the full navigation-graph JSON (physical anchors, systems, nav edges, per-element confidence, temporal model). Sidecar (not a column) because it's large and edited on a different cadence than the library row. `chart_id` is already owner-scoped ⇒ calibration is **owner-scoped** for free; no cross-owner leakage.
- **Invalidation rule:** apply calibration only where `source_hash == the current file's hash`. A hash mismatch ⇒ **stale ⇒ chart flagged "needs recalibration."** *Never* silent-apply across a hash change — confidently-wrong anchors (old graph over new ink) are the worst failure mode.
- **Identical re-upload survives:** same bytes → same hash → calibration still matches. The common "I re-saved the same file" case does not nuke prior work.
- **Carry-forward (honors "correction never exceeds creation"):** on a hash mismatch we do **not** discard the old graph. We seed the editor with the previous hash's anchors as a **low-confidence draft** to verify-by-playback against — a minor re-export becomes a ~20-second re-confirm, not a re-chart.
- **History: retain across hashes.** Keep every `(chart_id, source_hash)` row (cheap JSON). This gives a revert path *and* makes the carry-forward draft trivially "the prior hash's row." Accepted tradeoff: a little storage cruft per re-upload.
- **Portability (free optionality):** hash-keyed rather than row-id-keyed means calibration could travel if charts are ever shared (currently out of scope — design-chart-library.md:495).

### Graceful degradation
- **Handwritten / low-confidence / un-convertible charts:** vision confidence tanks → fall back to **manual marker-rail = the Calibration Editor with zero pre-filled anchors.** Convert-it and hand-tag-it are **one tool, not two.** Concept A's manual rail *is* this editor, so A is both the floor feature and the conversion safety net.

---

## Integration with existing designs (reconcile during review)

This touches several shipped/spec'd areas; flagged as reconciliation points (not yet cross-read in depth — **Codex: please check for conflict/overlap**):
- `design-perform-tab.md` — the redline lives here; A's gestures attach to the Perform view.
- `design-chart-library.md` + `design-batch-chart-resolution.md` — the converter + Calibration Editor are an extension of the library add/CRUD/confidence flow.
- `design-inline-chart-viewer.md` — the overlay renders atop this viewer.
- `design-storage-notation.md` — **reconciled (see below):** it owns the chart *artifact* (`.md`/`.pdf`); this doc owns a calibration *sidecar*. No format conflict.
- `design-console-export.md` — **untouched** by this phase (export stays input-only; out of scope).

### Reconciliation with `design-storage-notation`
Its Phase 3 converts charts PDF→Markdown (`.md`-first, PDF demoted to `original.pdf` fallback). Read naively that fights this doc's "keep the PDF as canvas + overlay." It doesn't — they are **different layers**, once an earlier overreach here is corrected:
- **Artifact vs sidecar.** storage-notation owns the chart *artifact* ("what the chart says," portable/diffable text or the PDF). This doc owns a *calibration sidecar* ("where bar N sits + how the redline moves"). The sidecar **travels alongside** the artifact and is **not** a chart-storage format. (v1 wrongly called the nav-graph the chart's "native format" — corrected.)
- **Source-agnostic nav/temporal layer.** The navigation graph + temporal model are identical whether the chart is `.pdf` or `.md`. Only the **physical-anchor layer** forks — `pdfBox` (normalized rect, vision + edge-snap path) vs `mdBlock` (a reference into rendered markdown). Same redline, same graph, two positioning adapters.
- **`.md` is *cheaper* to calibrate, not harder.** Phase-3 markdown is already explicit structure (`## Chorus`, `| E | Abm |` bar tables) — that **is** the nav skeleton, parseable with zero vision. PDFs take the vision + two-detector path; `.md` charts get near-free structural extraction. The two-detector model (structural pass / local edge-snap) applies to the PDF adapter only.
- **Fingerprint keys align.** Calibration invalidation keys on the artifact's content fingerprint: PDF → sha256-of-bytes (this doc); `.md` → its existing git blob `sha` (storage-notation already uses it for cache invalidation). `source_hash` generalizes to "the artifact fingerprint, whichever model produced it."
- **BYOS placement.** In the GitHub provider the sidecar lives beside the artifact, e.g. `charts/valerie/guitar.calibration.json`, versioned by the same repo/SHA machinery.

---

## Open questions for adversarial review

1. **B transport (blocking only B):** local-WiFi-without-backhaul acceptable to players, or is true BT-mesh-with-MD-node a hard requirement (⇒ native shell)? Pending team input.
2. **Band prominence:** on-demand (hidden until hover/select) vs always-on-but-quieter (fainter + "System N" label). Lean: on-demand (matches effort reality). Needs chart-reader eyes.
3. **Non-linear timeline edge cases:** nested repeats; multiple passes with different endings (1st/2nd/3rd); D.S. al Coda *al Fine* interactions; how `(bar,pass)` resolves and how the graph rejects contradictory road maps.
4. **Confidence thresholds:** what auto-routes an element into the review queue; how scrub-preview correctness interacts with element confidence.
5. **Tempo source for the redline** — *resolved in "Temporal model"* (nullable tempo ⇒ seek-only-advance; fermata = hold point). Left here only for Codex to stress-test the hold-point call and the null-tempo degrade.
6. **`design-storage-notation.md` reconciliation** — *resolved in "Reconciliation with design-storage-notation"* (artifact vs sidecar; `pdfBox`/`mdBlock` adapters; aligned fingerprint keys). Left for Codex to stress-test the `mdBlock` redline-positioning claim and the sidecar-not-format split.
7. **Author caveats:** UX bets are from a non-chart-reader/non-ForScore-user; explicitly want adversarial scrutiny on chart-reader ergonomics.

---

## Build order (when approved — separate build PR, not this doc)

1. **A — manual seek over a minimal hand-placed rail** (the bootstrap, resolves #1): tap-to-drop **sections-only** markers, zero converter/vision, no bar-level geometry. Seek snaps to section heads; redline parks/advances coarsely. Ships standalone value and is the universal fallback (tap marker = seek, long-press = hold/loop).
2. **Navigation-graph data model + overlay renderer** atop the existing chart viewer (adds bar-level anchors + `pdfBox`/`mdBlock` adapters; enriches step 1's coarse rail).
3. **Converter** (structural import pass → graph + per-element confidence) — makes creation cheap; *not* a gate for step 1.
4. **Calibration Editor** (gizmos, auto-distribute, snap-to-printed-line / detector #2, hybrid nav, Edit/Perform weighting, scrub-preview, chart-scoped).
5. **B — leader/follower** over WebRTC discrete events (after the transport OQ resolves).
6. **C — deferred** (follow-leader audio; tempo-awareness first).

Console export untouched throughout.

---

## Mockup

Interactive editor mockup (calibration view) demonstrating: scrub/play verify-by-playback with the repeat back-jump and `(bar,pass)` readout; barline-tick drag + snap-to-printed-line; system bands + auto-distribute; confidence-gated review queue; **Hybrid vs Classic-toggle** nav A/B; **Edit vs Perform** weighting A/B. Served locally during design (not committed). Treat as illustrative of the *interaction model*, not pixel-final.
