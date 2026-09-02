# Charting backlog — the loose ends

**Why this file exists.** These items were living only in session memory as fragments:
small verified defects, deferred design questions, and two tune-ups that kept getting
buried under louder bugs. They are written down here so nobody trips over them twice.

**This is a holding pen, not a plan.** Nothing here is sequenced or committed to. Items
graduate out of this file into their own design doc or PR when they get picked up, and
get DELETED from here when they do — a tombstone here is worse than nothing.

**Provenance is marked per item**, because it matters when you pick one up:
- **[verified]** — measured against the code or a real artifact, on the date given.
- **[carried]** — recorded from an earlier session and NOT re-checked. Line references
  may be stale; confirm before acting.

---

## Active queue — tracked elsewhere, listed here only so this file is a complete index

Do not duplicate detail for these. The live detail lives in session state.

1. **Share from the library song row.** `SongRow` (`app/library/page.tsx:283-340`) renders
   `Build chart` / `Edit` / `Duplicate` / `Delete` and **no Share**, while the chart-level
   Share already exists one level down in `ManageChartsModal` (`:256` rows, `:346`
   preview) and in the builder's Review step (`RoadmapBuilder.tsx:645`). So the capability
   ships; the row is the surface that never got it. While in there: rename `Build chart`
   → `Build`. **[verified 2026-08-31]**
   - **Open design question, answer before building:** a song row can carry several charts
     (`song.chart_count`), so row-level Share is ambiguous about *which* chart. Options:
     share only when `count === 1`, share the lead/primary role, or open a picker. The
     modal does not have this problem because it shares a specific chart.
   - The action column is a fixed `210px` track in a
     `grid-cols-[1fr_80px_120px_60px_60px_210px]`; a fifth button needs that width
     revisited, not just appended.
2. **NNS⇄Letters toggle in the SHOW view.** The builder half shipped (migration `017`,
   `source_notation`, baked into the stored PDF on save). What remains is the show-view
   surface, and Graham's stated preference is a **per-show** setting. Note the tension
   with the shipped model: notation is baked into the one stored PDF at save time, so a
   per-show toggle cannot re-render an existing PDF without either a re-bake or a second
   artifact — and the two-artifact approach was **killed by Codex R1** (the retrieval
   stack keys on fetched-bytes hash, not spec id). Do not restart there. **[verified
   2026-08-31]**

---

## Ruled 2026-09-02 — lazy conversion + overlay-create gates (Graham, agreed)

### Conversion is on-demand, not an upload side-effect **[ruling 2026-09-02]**
An uploaded chart's overlay only earns its cost when the chart participates in conductor
mode or a uniform band roadmap — so conversion becomes a capability, not a reflex:
- **Upload stores bytes and stops.** No auto `triggerOverlayCreate`, no "Generating
  overlay…" transient for ordinary uploads.
- **Conversion fires on first need**: the first time the chart is opened in a
  conductor/roadmap context, or an explicit "Build overlay" action.
- **Known-never gates, checked before the call ever fires** (the point is to SAVE the
  call, not clean up after it): `role = 'lyrics'` (measured 2026-09-02: 342/342 lyrics
  PDFs in the live library have zero detectable staves), `source_spec IS NOT NULL`
  (builder-generated charts — the spec already is ground truth), and a zero-staves
  classifier as automatic backstop for mislabeled uploads.
- Eager conversion also creates **review debt** — uncertain-badges on charts nobody will
  conduct — which is the second reason to gate, independent of cost.
- `design-chart-review-step.md`'s entry point is amended in the same PR (offer follows
  *conversion*, whenever it runs). `design-chart-converter.md`'s chunk-3 upload-flow
  states move to the on-demand trigger at build time; that doc is not rewritten here.

### Measurement-first geometry — validated, needs a productization decision **[verified 2026-09-02]**
The vector-measurement pipeline behind the review-step verdicts is no longer speculative:
**464/464 scored systems pass self-validation across 62 real charts** (multi-page,
multiple engravers, mostly out-of-sample), with lyrics/chord-sheets/stubs cleanly
classified no-staves and duplicates caught by hash. Reference implementation: `probe8.mjs`
in the dev spike folder (`~/chart-spike/` on the mini), with the earned rules inline
(staff candidates by merged rule length; printed-delta = visible spans + Σ(multirest−1);
multirest = digit **paired with** an H-bar; modal barline stroke width; begin-repeat
subtract gated on gap < median bar width and ≥3 clusters; unnumbered-first-system =
measure 1 on page 1 only).
- ⚠ **Open before build:** probe8 leans on poppler's `pdftocairo` (native binary — not
  available on Vercel). Candidate paths: a recording-canvas shim over pdf.js rendering
  (pure JS; correct transforms by construction — hand-rolled CTM walking is a proven
  trap), WASM pdfium/poppler, or a small conversion service. This is the first decision
  of the measurement-engine design doc.

---

## Tune-ups nobody has claimed

### Advance-on-listen — the mic is shadow-only **[verified 2026-09-01]**
The clock already self-drives. `lib/use-conductor-session.ts:890` dispatches exactly one
clock-driven advance per tick, stamped `rung: 'static-bpm'`. What it drives on is the
**stated** tempo (`song.bpm`), never a detected one.

The mic detector is fully built and fully wired — `useTempoDetector` runs at `:347` and
its telemetry reaches `ingestTelemetry` with confidence and octave-folding — but every
consumer is a *readout*: the synchronous `telemetryRef`, the `shadow` display state, and a
capped `validationLog`. Nothing routes a detected tempo into the clock's tempo input.

So this is not a hook-up of missing plumbing. The plumbing exists and deliberately
terminates in observation.

The rung ladder is **already fully typed** —
`ClockRung = 'live' | 'coasting' | 'static-bpm' | 'manual'` (`lib/conductor-clock.ts:126`).
Nothing needs adding to the contract. What is missing is that the top two rungs are
**unreachable**: `computeStaticRung` (`:135-143`) returns only `'manual'` or
`'static-bpm'`, and the driver hardcodes `rung: 'static-bpm'` at
`lib/use-conductor-session.ts:891`. No code path anywhere **produces** `'live'` or
`'coasting'`. Both literals do occur in the repo — in the type, in `clockConfidenceOk`'s
switch, and as test arguments — but only ever as values *consumed*, never as a rung any
function returns or stamps onto an advance.

This was designed, not overlooked. `conductor-clock.ts:120-124` says so in-source: *"with
NO telemetry input chunk 2 can only PRODUCE the bottom two rungs; live/coasting are added
by **item 4** when a tempo-telemetry input exists."* The telemetry input now exists and is
observed-only, so item 4 is the named, waiting piece of work: route detected tempo into
the effective-tempo/rung resolution so `live` and `coasting` become reachable.

The real design question inside item 4 is the policy, not the wiring: how confident must a
detected tempo be before it takes over from the stated one, and how does it hand back when
confidence drops. Note the confidence gate is *already* exhaustive over all four rungs
(`clockConfidenceOk`, `lib/conductor-clock.ts:155-168`), and `'coasting'` is already ruled
— `false`, deliberately: motion yes, auto-commit no. The single open branch is `'live'`, a
standing `return false` annotated *"needs a sustained-HIGH telemetry input — extends here
in item 4"* (`:161-162`). Defining that sustained-HIGH bound is the work; the DSP and the
gate's shape are done.

⚠ Do not confuse this with `shouldAutoFire` (`lib/conductor-session.ts:166`). That gate is
implemented and tested, and it answers a different question — whether an *already-armed*
change commits when the playhead arrives at its fire bar. It does not move the playhead.

### Graceful empty / non-chart upload **[verified 2026-09-01]**
An empty or non-chart PDF degrades to `'Chart uploaded — overlay could not be generated.'`
(`components/ManageChartsModal.tsx:120`), which reads as a system failure rather than
"this isn't a chart". It cost a real diagnostic detour on 2026-08-26. Validate the upload
and say something true instead of falling through to the generic degrade path.

### Overlay-accuracy knob — `AGENT_MODEL_VISION=claude-opus-4-8` **[carried]**
Not code. Chart AI is model-agnostic; the default (sonnet) works on real charts but opus
is sharper on spatial coordinates, which is exactly the VLM's weak axis. **Graham's to
set in Vercel.** Watch `VISION_TIMEOUT_MS` if it goes on — higher effort has hit the
50s abort before.

---

## Small defects and legibility

### `7sus2` is not in the quality vocabulary **[verified 2026-08-29]**
`QUALITY_WHITELIST` (`lib/roadmap-spec.ts`) contains `sus`, `sus2`, `sus4` but no
`7sus2`, so `A7sus2` degrades to `Asus2` — a real chord silently becoming a different
one. The model-facing prompt in `lib/roadmap-parse.ts` enumerates the same list, so both
sides agree and both are wrong together. Adding it means touching the whitelist, the
prompt, and the letter parser in step.

*(An earlier note filed this at `roadmap-parse.ts:58`. The whitelist is actually in
`roadmap-spec.ts` — the parse file only mirrors it in prose. Cited correctly here.)*

### A dominant 7 prints as `57` **[verified 2026-08-28]**
Degree and quality are concatenated at uniform size, so `5⁷` renders as `57` and reads as
"fifty-seven" as easily as a five-seven chord. Raised with Graham 2026-08-28; he has not
ruled on it. A musician's call, not an engineering one.

### No BPM control in the chart-authoring flows **[verified 2026-09-01]**
`TapTempo` reaches exactly two surfaces: the Library song form (`app/library/page.tsx:430`)
and the show's setlist row (`app/[owner]/[show]/page.tsx:4839`, behind the `showBpm`
toggle, writing globally through `onBpmChange` — "sets this song's tempo everywhere").

What has no BPM control is the **chart-authoring** path: `RoadmapBuilder` and
`ManageChartsModal` contain zero references to `bpm`. So building a chart never surfaces
tempo; you have to leave and set it from the setlist row or the library. That is a flow
gap, not an unreachable value.

### Artist display gaps **[verified 2026-09-01]**
`ManageChartsModal.tsx` and `RoadmapBuilder.tsx` each contain **zero** occurrences of
`artist`. For the modal the setlist RPCs build their config blob from
title/key/lead/notes and never include artist, so it needs blob threading; the builder
preview simply never renders the field.

### Nav-shrink edge **[verified 2026-09-01]**
Shrinking a section below a navigation reference's bar leaves the reference dangling
until save, where server validation rejects it. Not silent corruption, and **not reachable
today**: the builder's only navigation surface is `navMarkers`
(`components/RoadmapBuilder.tsx:673-683`), documented in-source as a "Read-only summary of
the global roadmap navigation as marker chips". There is no nav-editing UI, so this is
latent until one is built — at which point it becomes reachable immediately.

### `tallyDraft` is op-blind **[verified 2026-09-01]**
`tallyDraft` (`lib/roadmap-authoring.ts:407`) sums `sec.spans` directly, and the function's
own header comment says it renders "FROM the SpanList (pre-op spans)". So the L4 read-back
echo can disagree with the folded spec — an intro `3x` repeat is not reflected. The
read-back exists precisely to catch a dropped span on sight, so a fidelity hole in it is
worth more than it looks.

---

## Deferred design questions

### Mid-song key change is inexpressible **[verified 2026-09-01]**
`renderKey` is a single `string` field on the spec (`lib/roadmap-spec.ts:22`), global to
the artifact, so a song that modulates cannot be described. If this is ever built, **the
key change MUST be stored RELATIVE** — the new tonic as an interval off the primary key —
or it breaks transpose-invariance. That constraint is the whole reason this note exists;
do not design it as an absolute key per section.

### Old saved PDFs carry baked pre-fit-to-width calibration **[carried]**
Self-heals on the next save. No backfill was written, deliberately.

### Blank-key honesty flag **[verified 2026-09-01]**
`song.key || authored_key` shows the authored key even when a show has *intentionally*
blanked it. The mechanism is sharper than previously recorded, and the sharpness is the
fix: `resolveOverride` (`lib/overrides.ts:41`) is genuinely three-state — `''` returns its
`emptyAs` parameter, `null`/`undefined` falls back to the library value. **Key is the one
caller that omits `emptyAs`**, while its siblings pass `''`:

```ts
// app/api/shows/[owner]/[show]/route.ts:39-41  (same shape at shows/update/route.ts:190-192)
key:   resolveOverride(row.key_override,   song?.key),            // ← no emptyAs → '' becomes undefined
lead:  resolveOverride(row.lead_override,  song?.lead,  '') ?? '', // ← blankness preserved
notes: resolveOverride(row.notes_override, song?.notes, '') ?? '',
```

So blanked-key collapses to `undefined` and becomes indistinguishable from never-set at
the `||` downstream, purely because of that one missing argument. A proper fix means
carrying a resolved-key source flag on the show payload, which touches override semantics
with existing tests pinning blank-as-intentional — so it is not a one-character change,
but the asymmetry is where to start looking. Thin edge case; its own small chunk if it
ever matters.

---

## Not defects — recorded so they stop being re-raised

- **Line-start measure numbers count WRITTEN measures, not played ones.** A section marked
  `×2` does not advance the numbering. This is the notation standard, and it is what the
  architecture requires: repeats are a nav-graph over physical bars, and `absNumber` is
  bar identity for the conductor. Ruled by Graham 2026-08-28. **[verified 2026-08-28]**
- **A plain repeat prints no `×2`.** `roadmap-render.ts` prints `×N` only when `times > 2`,
  because `:|` already means play twice. **[verified 2026-08-28]**
- **Keyboard nav is correct**: left/right = song, up/down = page within a chart.
  **[verified 2026-08-28]**
- **The converter's weak bar geometry is the VLM's coordinate estimate, not the overlay
  draw math.** The draw mirrors the canvas's painted rect and accounts for letterboxing.
  Garbage in, garbage bars. Ruled a known boundary, not a bug. **[carried]**
