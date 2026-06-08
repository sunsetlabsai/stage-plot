# Design: Realtime Chart Control (Perform-mode redline) + Chart Calibration

**Status:** Proposed (v1) — ready for adversarial review (Codex R1)
**Date:** 2026-06-08
**Branch:** `opus/design-realtime-chart-control`
**Target/benchmark:** ForScore — a static PDF reader (library + setlists + pedal page-turns + annotations). Everything here is the *live, band-aware* layer ForScore structurally lacks.

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
| **A — Manual seek** | A performer taps/double-taps a section to re-orient their own redline | the primitive |
| **B — Networked seek** | MD/conductor is leader; their seek broadcasts to followers | A, broadcast |
| **C — Automated seek** | Audio listener decides where the redline should be | A, triggered by a listener |

**They layer, and A is the foundation.** B is literally A's action broadcast; C is A's action triggered by audio. A is also the **manual override** B and C will *always* need (audio mis-fires; you'll want to grab the wheel). **Build order: A first** — it ships standalone value, and de-risks + underpins B and C.

### Scope insight that resizes effort
The headline use case — *intentional MD changes* — is **human-initiated** and is solved completely by **A + B**. It does **not** need C. Audio detection (C) only buys two things A+B don't: (1) hands-free, and (2) catching *unintended* drift. The hardest piece is therefore **not on the critical path** for the use case that motivated the feature.

---

## Concepts — feasibility & decisions

### A — Tap / double-tap to re-orient (manual seek)
- **Feasibility: high.** Fully local; no network, no ML.
- **Gesture semantics:** single tap = *seek here*; **double-tap = hold/loop this section** (vamp until released) — a near-perfect fit for "stay on the solo another round."
- **Anti-mis-seek:** requires a deliberate gesture so a sleeve-brush on stage doesn't re-seek. (Tap a section marker / double-tap, not a bare single tap anywhere.)
- **Decision:** A is v1's foundation and the universal manual fallback.

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

**Consequence:** the "native format" is **not a notation document** — it is a thin **navigation/timeline graph**. This is the format that A taps to seek into, B broadcasts positions in, and C tries to detect.

---

## Data model (the navigation graph)

Two **distinct layers** — keep them separate; conflating them is a trap.

### 1. Physical anchors (geometry — where a bar is *printed*)
1:1 with the PDF ink. A bar has exactly **one** bounding box.
- `Page { index, w, h }` (coords stored **PDF-relative / normalized**, never screen pixels — survive zoom/rotation/device size).
- `System { id, page, yTop, yBottom, barlines: [x...] }` — a staff row; the redline sweeps L→R within it then snaps to the next.
- `Bar { id, systemId, xStart, xEnd, absNumber }`.
- Each anchor carries **per-element confidence** (see review queue).

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

### Graceful degradation
- **Handwritten / low-confidence / un-convertible charts:** vision confidence tanks → fall back to **manual marker-rail = the Calibration Editor with zero pre-filled anchors.** Convert-it and hand-tag-it are **one tool, not two.** Concept A's manual rail *is* this editor, so A is both the floor feature and the conversion safety net.

---

## Integration with existing designs (reconcile during review)

This touches several shipped/spec'd areas; flagged as reconciliation points (not yet cross-read in depth — **Codex: please check for conflict/overlap**):
- `design-perform-tab.md` — the redline lives here; A's gestures attach to the Perform view.
- `design-chart-library.md` + `design-batch-chart-resolution.md` — the converter + Calibration Editor are an extension of the library add/CRUD/confidence flow.
- `design-inline-chart-viewer.md` — the overlay renders atop this viewer.
- `design-storage-notation.md` — **potential overlap:** confirm whether a chart storage/notation format already exists and whether the navigation-graph sidecar extends or conflicts with it.
- `design-console-export.md` — **untouched** by this phase (export stays input-only; out of scope).

---

## Open questions for adversarial review

1. **B transport (blocking only B):** local-WiFi-without-backhaul acceptable to players, or is true BT-mesh-with-MD-node a hard requirement (⇒ native shell)? Pending team input.
2. **Band prominence:** on-demand (hidden until hover/select) vs always-on-but-quieter (fainter + "System N" label). Lean: on-demand (matches effort reality). Needs chart-reader eyes.
3. **Non-linear timeline edge cases:** nested repeats; multiple passes with different endings (1st/2nd/3rd); D.S. al Coda *al Fine* interactions; how `(bar,pass)` resolves and how the graph rejects contradictory road maps.
4. **Confidence thresholds:** what auto-routes an element into the review queue; how scrub-preview correctness interacts with element confidence.
5. **Tempo source for the redline:** time-sig + tempo marking at import; behavior when tempo is absent/handwritten; relationship to deferred tempo-awareness (C tier 1).
6. **`design-storage-notation.md` reconciliation** (see Integration) — does a format already exist?
7. **Author caveats:** UX bets are from a non-chart-reader/non-ForScore-user; explicitly want adversarial scrutiny on chart-reader ergonomics.

---

## Build order (when approved — separate build PR, not this doc)

1. **A — manual seek** (foundation + universal fallback; double-tap = hold/loop).
2. **Navigation-graph data model + overlay renderer** atop the existing chart viewer.
3. **Converter** (structural import pass → graph + per-element confidence).
4. **Calibration Editor** (gizmos, auto-distribute, snap-to-printed-line / detector #2, hybrid nav, Edit/Perform weighting, scrub-preview, chart-scoped).
5. **B — leader/follower** over WebRTC discrete events (after the transport OQ resolves).
6. **C — deferred** (follow-leader audio; tempo-awareness first).

Console export untouched throughout.

---

## Mockup

Interactive editor mockup (calibration view) demonstrating: scrub/play verify-by-playback with the repeat back-jump and `(bar,pass)` readout; barline-tick drag + snap-to-printed-line; system bands + auto-distribute; confidence-gated review queue; **Hybrid vs Classic-toggle** nav A/B; **Edit vs Perform** weighting A/B. Served locally during design (not committed). Treat as illustrative of the *interaction model*, not pixel-final.
