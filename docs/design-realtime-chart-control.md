# Design: Realtime Chart Control (Perform-mode redline) + Chart Calibration

**Status:** Proposed (v1.5) — **Codex R5: no merge blockers** (R1–R4 findings resolved; two R5 nits folded). Merge-ready pending owner GO.
**Date:** 2026-06-08
**Branch:** `opus/design-realtime-chart-control`
**Target/benchmark:** ForScore — a static PDF reader (library + setlists + pedal page-turns + annotations). Everything here is the *live, band-aware* layer ForScore structurally lacks.

---

## R1 resolutions (Codex adversarial pass on `bc039c1`)

- **#3 (HIGH) gesture conflict with the inline viewer — RESOLVED.** Root cause: the canvas tap surface is *fully* allocated to page-turns (`page.tsx:1544`) and tap fires immediately on `touchend` (no double-tap window — why paging feels snappy), so seek can't be a canvas-wide tap and double-tap-to-hold would tax every tap. Fix: **redline auto-turns pages** (demotes manual paging) → **seek = tap a section marker** (object above the canvas, like the existing pill-picker) · **hold/loop = long-press** (not double-tap) · no zone grid · explicit precedence/hit-test + follow-mode scope. See "Gesture model (Perform mode)" under Concept A.
- **#1 (HIGH) build-order bootstrap — RESOLVED.** The chicken/egg: A is "step 1" but seeks into a nav graph that the converter (step 3) and editor (step 4) produce. Fix: **step 1 is a self-contained vertical slice that explicitly bundles a *minimal* editor + persistence + overlay** — (a) sections-only marker-creation UI, (b) sidecar save/load, (c) perform overlay render. It is **not** editor-free (R2 caught the earlier overreach); it is gated only on a *thin slice* of editor/persistence it owns itself, not on the full step-4 Calibration Editor. The full editor (gizmos, auto-distribute, edge-snap, hybrid nav, scrub, bar ticks) is enrichment, not a prerequisite. See revised Build order step 1.
- **#2 (HIGH) calibration persistence / invalidation — RESOLVED.** The library has no version concept (`chart_library` is `unique(owner_id, song_key, role)`, upsert replaces — design-chart-library.md:496), so the **PDF content hash becomes the de-facto version.** Content-hash-keyed sidecar; apply-only-on-match; mismatch ⇒ stale, never silent-apply; carry-forward old anchors as a low-confidence draft. See "Calibration persistence" below.
- **#4 (HIGH) temporal model for the redline — RESOLVED.** Thin temporal layer on the graph: beats-per-bar from time sig, per-bar override for pickups, **nullable tempo** (null ⇒ redline is seek-only-advance, not broken), fermata/caesura = **hold point** (park, don't clock). See "Temporal model" below.
- **#5 (MED/HIGH) reconcile with `design-storage-notation` (Markdown-first direction) — RESOLVED.** No format conflict: storage-notation owns the chart *artifact* (`.md`/`.pdf`); chart-control owns a calibration *sidecar* (not a chart-storage format — corrected an overreach below). **v1 live redline is PDF-only** — `.md` charts lack stable per-bar geometry (reflowing HTML; corpus includes prose/ABC), so they keep static markdown rendering and are out of scope for the redline. An `.md` adapter is deferred behind a DOM-ID rendering contract; nav/temporal layers are kept source-agnostic so it can slot in later. See "Reconciliation with `design-storage-notation`" below.

---

## R5 (Codex adversarial pass on `5c3ff48`) — no merge blockers

Sign-off pass. Two non-blocking nits folded:
- **PDF-only tightened.** "PDF/image" → **PDF only in v1** (raster-image render + dimension path deferred; the viewer is PDF-oriented and `page_dims` come from the PDF).
- **Drive-import wording softened.** No longer asserts a direct Drive→library import exists; reworded to "upload/import the PDF into the owner library" (reuses the existing upload path; one-tap Drive import is a nice-to-have, not assumed).

---

## R4 resolutions (Codex adversarial pass on `9369bd5`)

- **#1 (HIGH) step 1 couldn't produce a Perform-usable calibration — RESOLVED.** Perform eats only `verified`, but scrub-verify (the only promotion path) was step-4 → the step-1 rail could only ever be `draft`. Fix: **decouple the promotion *gate* (invariant: all required elements accepted/disabled) from the *affordance*.** Step 1 gets a **primitive accept** path (place section markers → accept required anchors → save `verified`); step-4 scrub-verify is the *richer* affordance for bar-level, not the definition of promotion. Step 1 is now Perform-usable on its own. See Verification rule.
- **#2 (HIGH) calibration keyed to `chart_library` but the viewer also serves Drive charts — RESOLVED.** Drive/batch charts lack `chart_library.id`/`content_hash`/`page_dims`, so they can't supply the `(chart_id, source_hash)` key. **Scoped v1 redline/calibration to owner-library PDFs only**; Drive charts render in the same viewer **without** the calibrate/redline affordance. Path in = import to the library (existing flow). Drive-native keying deferred. See "Source-scope boundary".
- **(cleanup) `(bar, pass)` overgeneralized — RESOLVED.** True position is now `(PositionRef, pass)` (sectionId | barId), so the section-only rail is covered.

---

## R3 resolutions (Codex adversarial pass on `c1b6316`)

- **#1 (HIGH) step-1 rail had no compatible data model — RESOLVED.** The graph was bar/system-only; a sections-only rail couldn't persist. Added a **coarse `SectionAnchor { id, page, x, y, label }` tier** (the step-1 floor) alongside the fine `System`/`Bar` tier (step-2 enrichment), an explicit **upgrade path** (`Bar.sectionId` subdivides a section), and a **`PositionRef`** (sectionId | (barId,pass)) that the navigation + temporal layers use so they never assume bar geometry. See Data model §1.
- **#2 (HIGH) chart-level `verified` could certify known-bad elements — RESOLVED.** Promotion now **fails closed**: `verified` is permitted only when no *required* element (traversed nav edges / section anchors) remains unresolved — each flagged element must be explicitly **accepted or disabled** first. Disable converts an un-resolvable jump into a `holdPoint`. See Verification rule.
- **#3 (MED) vertical-swipe page-turn conflicted with the viewer contract — RESOLVED by dropping it.** The inline viewer deliberately ignores vertical touch and reserves horizontal swipe for songs. Removed the new swipe ↑/↓; manual paging stays the **existing tap-half** — contract unchanged, nothing to supersede. See gesture table.

---

## R2 resolutions (Codex adversarial pass on `dfbf1b4`)

- **#1 (HIGH) bootstrap still gated on the step-4 editor — RESOLVED.** Step 1 was claimed editor-free but a hand-placed rail needs creation UI + persistence + overlay. Now **step 1 explicitly owns a *minimal* slice** (sections-only marker-creation UI + sidecar save/load + perform overlay); the full editor stays step-4 enrichment. See Build order step 1 + Graceful degradation.
- **#3 (HIGH) `mdBlock` lacks runtime geometry — RESOLVED by dropping `.md` from v1.** A logical anchor isn't a pixel rect; `.md` reflows and includes prose/ABC. **v1 redline is PDF-only**; `.md` charts keep static rendering. An `.md` adapter is deferred behind a DOM-ID rendering contract (nav/temporal layers kept source-agnostic so it slots in later). See Reconciliation.
- **#2 (HIGH) carry-forward draft could silently apply under the new hash — RESOLVED.** Added a **`status: draft | verified`** lifecycle; **Perform consumes only `verified`** (hash-match is necessary, not sufficient). `status` (human sign-off) is orthogonal to per-element `confidence` (machine score). Carry-forward seeds all-`draft`; verify-by-playback is the `draft → verified` promotion. See Calibration persistence.
- **#4 (MED) null tempo vs. auto-turn — RESOLVED.** Stated the two regimes: tempo-present ⇒ redline advances, auto-turn primary; tempo-absent ⇒ seek-only, **no auto-turn, manual paging primary**, marker-seek repositions only. Gesture table cross-linked. See Temporal model.
- **(consistency) portability claim — RESOLVED.** Dropped the "hash-keyed ⇒ portable" line; keying is `(chart_id, source_hash)`, **chart-scoped by design** (owner/chart isolation).

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
| **Change page** | redline **auto-turns** (primary *when tempo present*) · existing **tap-half** (manual) | **No new vertical-swipe gesture** (R3 #3): the inline viewer deliberately ignores vertical touch movement and reserves horizontal swipe for songs (design-inline-chart-viewer.md:105; page.tsx dominant-axis lock). We **keep that contract unchanged** — manual paging stays the existing tap-half. Auto-turn requires the redline to advance, so it's primary only in the tempo-present regime; with null tempo there's no auto-turn and the tap-half stays primary (see Temporal model). |
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

### 1. Physical anchors (geometry — where a position is *printed on the PDF*)
Anchors are PDF-relative / normalized coords (never screen pixels — survive zoom/rotation/device size). **Source charts are PDF only in v1** (the viewer is PDF-oriented and `page_dims` come from the PDF; raster-image charts would need a separate render+dimension path — deferred). There are **two granularity tiers** of anchor, and they share a `Page { index, w, h }` and per-element confidence:

- **Coarse — `SectionAnchor { id, page, x, y, label }`** (the **step-1 floor**). A single point per section head ("Intro", "Chorus", rehearsal letter "B"). Hand-droppable with zero bar geometry. Seek snaps the redline *to a section anchor*; between anchors the redline parks or advances coarsely. This is the only physical anchor the bootstrap rail needs.
- **Fine — `System` + `Bar`** (the **step-2 enrichment**). `System { id, page, yTop, yBottom, barlines: [x...] }` (a staff row; redline sweeps L→R then snaps to next) · `Bar { id, systemId, xStart, xEnd, absNumber, sectionId }`. Bars **subdivide** a section.

**Upgrade path (explicit):** a section is the unit of position in step 1; adding bars in step 2 *subdivides* its `SectionAnchor` without invalidating it (`Bar.sectionId` back-references the section). So seek-state has two forms: **step 1 seeks a `SectionAnchor`; step 2+ seeks a `(bar, pass)`** that resolves up to its section. `holdPoints` and nav targets reference a **`PositionRef`** = *either* a `sectionId` (coarse) *or* a `(barId, pass)` (fine) — the navigation + temporal layers never assume bar-level geometry exists.

The navigation + temporal layers are **source-agnostic** — kept separable so a future `.md` adapter (behind a DOM-ID rendering contract) could slot in without touching them.

### 2. Navigation (logic — what *order* positions are played)
A **directed graph over the physical anchors**. This is where a single printed position can be **visited multiple times**.
- Nodes = `PositionRef`s (a `SectionAnchor` in step 1; a `Bar` once subdivided). Edges = "what comes next," including **back-jumps** (repeats, D.S., D.C.) and conditional edges (1st/2nd endings keyed on pass). In the step-1 floor the graph is typically a coarse section chain; bar-level edges are step-2 enrichment.
- Markers: `repeatStart/End`, `ending{n}`, `D.S.`, `D.C.`, `Coda`, `Fine`.

### The timeline is non-linear: position = `(PositionRef, pass)`
The redline's true position is **not a place but a place-on-a-pass** — e.g. *"bar 37, pass 2"* in a bar-level calibration, or *"Chorus, pass 2"* in the step-1 section rail. The `PositionRef` (sectionId | (barId)) carries the *where*; `pass` carries the *which time through*. The road-map graph models passes. This ripples into B (broadcast `(PositionRef, pass)`) and C (detect pass). The **physical** layer edits one anchor per printed position; the **navigation** layer says it's visited twice — these stay distinct.

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
- **`tempoBpm` is nullable — and it defines two regimes (R2 #4).** From a marking at import; absent/handwritten ⇒ no clock. **A needs no tempo at all** (the player drives the seek). But tempo is what makes the redline *advance*, and advance is what powers auto-page-turn — so the gesture model's "redline auto-turns pages (primary)" claim only holds **when tempo is present.** State both regimes explicitly:
  - **Tempo present:** redline auto-advances ⇒ **auto-turn is primary**, manual paging is backup, marker-seek repositions.
  - **Tempo absent (null):** redline is **seek-only** (does not advance) ⇒ **no auto-turn; the existing manual page gestures remain primary**, and marker-seek only repositions. Not a broken feature — just the manual regime the gesture model already supports as fallback.
  - This also scopes B: a follower whose chart has null tempo is seek-only too (it can't auto-advance off a leader's clock it doesn't have). (Dovetails with C-tier-1 tempo-awareness being deferred — when it lands it *fills in* this nullable field and flips a chart from the seek-only regime into the auto-advance one.)
- **Fermata / caesura / rit. = `holdPoint`, not a duration.** These are genuinely un-clockable live; don't pretend to model their length. The redline **parks at a hold point and waits for the next seek** (manual A, or leader broadcast B). This is exactly where A/B earn their keep — we mark the un-clockable spots instead of guessing them.

Shape: `temporal: { beatsPerBar, perBarBeatsOverride?, tempoBpm?: null, holdPoints: [PositionRef...] }`, stored *inside* the calibration graph JSON (so it versions and invalidates with the rest of the calibration). `PositionRef` = a `sectionId` (coarse) or `(barId, pass)` (fine) — in the step-1 rail hold points sit on section anchors.

### Calibration persistence (where the graph lives, and when it goes stale)
The calibration *is* the navigation-graph JSON. It must survive ordinary re-uploads but never be silently mis-applied to a *different* PDF. The trap: the library has **no version concept** — `chart_library` is `unique(owner_id, song_key, role)` and **upsert replaces** (design-chart-library.md:496, "No version history"). So there is nothing to "attach a version to." Resolution: **the PDF content hash becomes the de-facto version.**

- **`chart_library` row gains:** `content_hash` (sha256 of PDF bytes), `page_count`, `page_dims` (for normalized-coord validation).
- **New sidecar `chart_calibration`, keyed `(chart_id, source_hash)`:** `schema_version` + `status` (`draft` | `verified`) + the full navigation-graph JSON (physical anchors, systems, nav edges, per-element confidence, temporal model). Sidecar (not a column) because it's large and edited on a different cadence than the library row. `chart_id` is already owner-scoped ⇒ calibration is **owner-scoped** for free; no cross-owner leakage.
- **Invalidation rule (hash boundary):** apply calibration only where `source_hash == the current file's hash`. A hash mismatch ⇒ **stale ⇒ chart flagged "needs recalibration."** *Never* silent-apply across a hash change — confidently-wrong anchors (old graph over new ink) are the worst failure mode.
- **Verification rule (the *second* boundary — R2 #2):** a matching hash is necessary but **not sufficient.** Perform mode consumes a calibration **only when `status == verified`.** A `draft` row that happens to match the current hash is **not** used to drive the live redline — it only seeds the editor. This closes the gap where a carry-forward draft, once saved under the current hash, would otherwise "match and apply."
  - **`status` is orthogonal to per-element `confidence`.** `confidence` is the *machine's* score (auto-routes the review queue); `status` is the *human's* sign-off. An element can be high-confidence-but-unverified (freshly auto-imported, not yet playback-checked). **Perform gates on `verified`, not on confidence.**
  - **The gate is an invariant, not a specific gesture (R4 #1).** `draft → verified` is permitted **only when no *required* element remains unresolved** — every required element is **explicitly accepted or disabled.** Promotion **fails closed**: a chart with clean barlines but a still-uncertain D.S./Coda edge **cannot** go `verified` (and thus cannot drive Perform) until that jump is accepted, or disabled (degrading that spot to a manual-seek `holdPoint`).
    - *Required* elements = the nav edges and anchors the redline actually traverses. *Non-required* = cosmetic/low-stakes. Only required-element resolution gates promotion.
    - **Disable = a real escape hatch:** an un-resolvable jump can be turned off, becoming a `holdPoint` (redline parks; player seeks manually past it). Verified-with-a-known-hole is allowed *only* as an explicit disable, never as an ignored flag.
  - **Two promotion *affordances*, same gate — and step 1 owns the primitive one (R4 #1).** The gate above is satisfiable without the step-4 editor:
    - **Step 1 — primitive accept:** *place section markers → accept the required section anchors → save as `verified`.* For a pure section-chain rail the only required elements are the section anchors themselves, so a confirm-and-save satisfies the invariant. This is what makes the step-1 slice **Perform-usable on its own** (otherwise it would save only `draft` and Perform would ignore it — the contradiction R4 #1 caught).
    - **Step 4 — scrub-verify:** scrubbing the redline over the actual PDF and accepting is the *richer* review affordance for bar-level calibrations, not a different gate. It's the preferred tool once bars/nav exist, but it is **not** the definition of promotion.
- **Identical re-upload survives:** same bytes → same hash → calibration still matches *and* keeps its `verified` status. The common "I re-saved the same file" case does not nuke prior work.
- **Carry-forward (honors "correction never exceeds creation"):** on a hash mismatch we do **not** discard the old graph. We seed the editor with the previous hash's anchors as a **`draft`** (every imported element flagged low-confidence) to verify-by-playback against — a minor re-export becomes a ~20-second re-confirm, not a re-chart. It stays `draft` (Perform won't use it) until the human verifies.
- **History: retain across hashes.** Keep every `(chart_id, source_hash)` row (cheap JSON). This gives a revert path *and* makes the carry-forward draft trivially "the prior hash's row." Accepted tradeoff: a little storage cruft per re-upload.
- **Scope note (not portable across charts):** the key `(chart_id, source_hash)` is **chart-scoped by design** — calibration belongs to one chart, enforcing owner/chart isolation. (Cross-chart reuse would require keying on `source_hash` alone; deliberately not done.)

### Graceful degradation
- **Handwritten / low-confidence / un-convertible charts:** vision confidence tanks → fall back to the **manual marker-rail** (the step-1 minimal creation UI with zero pre-filled anchors). Convert-it and hand-tag-it share the **same creation surface** — the step-1 slice is the floor, and the step-4 Calibration Editor is the same surface *enriched* (gizmos/auto-distribute/snap), not a separate tool. So A is both the floor feature and the conversion safety net.

---

## Integration with existing designs (reconcile during review)

This touches several shipped/spec'd areas; flagged as reconciliation points (not yet cross-read in depth — **Codex: please check for conflict/overlap**):
- `design-perform-tab.md` — the redline lives here; A's gestures attach to the Perform view.
- `design-chart-library.md` + `design-batch-chart-resolution.md` — the converter + Calibration Editor are an extension of the library add/CRUD/confidence flow. **Source-scope boundary below — v1 calibrates owner-library PDFs only, not Drive-resolved charts.**
- `design-inline-chart-viewer.md` — the overlay renders atop this viewer **for library-PDF charts**; Drive-resolved charts render in the same viewer but **without** the calibration/redline affordance.
- `design-storage-notation.md` — **reconciled (see below):** it owns the chart *artifact* (`.md`/`.pdf`); this doc owns a calibration *sidecar*. No format conflict.
- `design-console-export.md` — **untouched** by this phase (export stays input-only; out of scope).

### Source-scope boundary: v1 = owner-library PDFs only (R4 #2)
The viewer currently renders **two** chart sources: **owner-library uploads** (`chart_library` rows: `id`, and — new in this design — `content_hash`, `page_count`, `page_dims`) and **Drive-resolved / batch charts** (`fileId`, `modifiedTime`, `url` — *no* `chart_library.id`, no content hash, no page dims). The calibration sidecar is keyed `(chart_id, source_hash)`, which **only library uploads can supply.** So:
- **v1 redline + calibration are scoped to owner-library PDF charts.** Drive-resolved charts render in the same inline viewer **without** the calibration/redline affordance (the "calibrate" entry point and the Perform redline are simply not offered for them). No half-keyed sidecar, no ambiguous source boundary.
- **Path to bring a Drive chart in:** upload/import the PDF into the owner library (it gains a `chart_library.id` + `content_hash`), then it's calibratable like any upload. (This reuses the existing library *upload* path; a one-tap *Drive-to-library* import is a nice-to-have, not assumed to exist today.)
- **Drive-native calibration is explicitly deferred.** It would need a second keying path (e.g. `(fileId, content_hash)` after proxy-download) — out of scope for v1, consistent with keeping one clean source model (mirrors the `.md` deferral).

### Reconciliation with `design-storage-notation`
Its Phase 3 converts charts PDF→Markdown (`.md`-first, PDF demoted to `original.pdf` fallback). Read naively that fights this doc's "keep the PDF as canvas + overlay." It doesn't — they are **different layers**, once an earlier overreach here is corrected:
- **Artifact vs sidecar.** storage-notation owns the chart *artifact* ("what the chart says," portable/diffable text or the PDF). This doc owns a *calibration sidecar* ("where bar N sits + how the redline moves"). The sidecar **travels alongside** the artifact and is **not** a chart-storage format. (v1 wrongly called the nav-graph the chart's "native format" — corrected.)
- **v1 redline is PDF-only.** The live redline requires a fixed-geometry canvas. A `.md` chart renders as reflowing HTML — no stable per-bar pixel rects after responsive layout / font loading / wrapping / table overflow, and the `.md` corpus includes prose lyrics and ABC blocks, not just `| bar |` tables. So **`.md`-stored charts simply do not get the live redline in v1**; they keep storage-notation's existing static markdown rendering. No conflict — the two features are orthogonal for `.md` charts (one stores, the other is a PDF-chart capability).
- **Why not an `mdBlock` adapter now (considered, deferred).** A logical anchor (`{ sectionHeading, rowIndex, cellIndex }`) is *not* geometry — a visual redline still needs a runtime DOM rect. Doing it right needs a **rendering contract**: inject stable element IDs per section/bar into the rendered markdown and measure live `getBoundingClientRect()`, plus a decision on prose/ABC (likely section-granular only). That's a real adapter, not free — deferred. The nav/temporal layers are kept source-agnostic so it can slot in later without rework.
- **Fingerprint keys.** v1 calibration keys on the **PDF** content fingerprint (sha256 of bytes). (A future `.md` adapter would reuse storage-notation's existing git blob `sha` — already used there for cache invalidation — but that's deferred with the adapter.)
- **BYOS placement.** In the GitHub provider the sidecar lives beside the PDF artifact, e.g. `charts/valerie/guitar.calibration.json`, versioned by the same repo/SHA machinery.

---

## Open questions for adversarial review

1. **B transport (blocking only B):** local-WiFi-without-backhaul acceptable to players, or is true BT-mesh-with-MD-node a hard requirement (⇒ native shell)? Pending team input.
2. **Band prominence:** on-demand (hidden until hover/select) vs always-on-but-quieter (fainter + "System N" label). Lean: on-demand (matches effort reality). Needs chart-reader eyes.
3. **Non-linear timeline edge cases:** nested repeats; multiple passes with different endings (1st/2nd/3rd); D.S. al Coda *al Fine* interactions; how `(bar,pass)` resolves and how the graph rejects contradictory road maps.
4. **Confidence thresholds:** what auto-routes an element into the review queue; how scrub-preview correctness interacts with element confidence.
5. **Tempo source for the redline** — *resolved in "Temporal model"* (nullable tempo ⇒ seek-only-advance; fermata = hold point). Left here only for Codex to stress-test the hold-point call and the null-tempo degrade.
6. **`design-storage-notation.md` reconciliation** — *resolved in "Reconciliation with design-storage-notation"* (artifact vs sidecar; **v1 redline is PDF-only**, `.md` adapter deferred behind a DOM-ID rendering contract). Left for Codex to stress-test the sidecar-not-format split.
7. **Author caveats:** UX bets are from a non-chart-reader/non-ForScore-user; explicitly want adversarial scrutiny on chart-reader ergonomics.

---

## Build divergence — step 1 hashing (client-side, not denormalized)

The doc-literal plan added `content_hash` / `page_count` / `page_dims` columns to
`chart_library`. **Step 1 instead hashes client-side** (Opus + Codex agreed):

- The `source_hash` (sha256 of PDF bytes) is computed in the viewer, which already
  downloads the PDF to render markers/redline — no extra conceptual work — and is
  stored **only** in the `chart_calibration` sidecar.
- **Stronger invariant:** "apply calibration only to the bytes actually being
  rendered." A live re-hash beats a DB column if storage/CDN/cache ever serves
  stale bytes. Perform fetches the matching `(chart_id, source_hash)` row, then
  requires `status === 'verified'` *and* the local invariant (`canVerify`). **If
  hashing fails ⇒ no redline** (not best-effort).
- `page_count` / `page_dims` come from PDF.js at render/editor time; not needed
  denormalized for the section rail.
- Keying is unchanged: `(chart_id, source_hash)`. Save/load APIs validate
  `chart_id` ownership (PUT: owner-only; GET: public read like the chart's own
  public storage URL).
- **Add `chart_library.content_hash` later** only when library-wide
  stale/calibrated status is needed *without opening PDFs* (server-side
  conversion/import, admin audit/backfill, cross-device preflight). Premature for
  the minimal vertical slice.

## Build order (revised — coherent units, not the original 1-6 split)

**Revision (build-time, Graham's call):** the original split scattered the editing
experience across steps 2–4, but **the overlay + auto-adjust is one coherent
function** — fragmenting it would put a half-built editor in front of testers. So
steps 2–4 collapse into **one Calibration Editor unit, built on a branch in
gated/Codex-reviewed chunks but merged to main once (when coherent).** B and C stay
separate later units. The converter rides as a **fast-follow merge** right behind the
editor (highest-uncertainty piece; the manual auto-distributed editor is fully usable
without it — "correction never exceeds creation" already makes calibration ~20s).

1. **✅ SHIPPED — A: manual seek over a sections-only rail** (the bootstrap). Self-
   contained vertical slice: tap-to-drop section markers, sidecar save/load (hash-keyed),
   Perform overlay (markers + redline, seek/hold). On main (`beadf8b`).
2. **Calibration Editor (coherent unit — one merge).** Built in internal chunks, each
   gated + Codex-reviewed:
   1. **Geometry model + persistence** — pure `System`/`Bar`/`PositionRef` + auto-
      distribute + tap→bar helpers (tested); extend the graph JSON, `schema_version → 2`,
      back-compat read of v1 section-only rows.
   2. **Bar-level Perform renderer** — redline sweeps L→R within a system, snaps to next,
      crosses pages (read-only consume of bars).
   3. **System-band gizmo + auto-distribute UI** + per-tick nudge for irregulars +
      snap-to-printed-line (detector #2) + copy-system layout.
   4. **Nav graph** — repeats / 1st-2nd endings / D.S. / D.C. / Coda / Fine + the
      non-linear `(bar, pass)` timeline. **Needs a focused mini-spec first** (OQ #3:
      nested repeats, multiple endings, *D.S. al Coda al Fine*, contradictory-roadmap
      rejection) — not built blind.
   5. **Verify-by-playback (scrub/play)** as the primary review affordance + hybrid nav
      badges + Edit/Perform weighting.
3. **Converter (fast-follow merge, right behind the editor)** — structural import pass →
   graph + per-element confidence + review queue. Makes creation cheap; not a gate.
4. **B — leader/follower** over WebRTC discrete events (after the transport OQ resolves).
5. **C — deferred** (follow-leader audio; tempo-awareness first).

Console export untouched throughout.

---

## Mockup

Interactive editor mockup (calibration view) demonstrating: scrub/play verify-by-playback with the repeat back-jump and `(bar,pass)` readout; barline-tick drag + snap-to-printed-line; system bands + auto-distribute; confidence-gated review queue; **Hybrid vs Classic-toggle** nav A/B; **Edit vs Perform** weighting A/B. Served locally during design (not committed). Treat as illustrative of the *interaction model*, not pixel-final.
