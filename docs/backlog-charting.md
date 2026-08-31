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

## Tune-ups nobody has claimed

### Wire up advance-on-listen **[carried]**
The plumbing is reported to exist already; this is a hook-up, not a build. Confirm what
"exists" means before scoping it — the conductor's `shouldAutoFire` has been stubbed
`false` since chunk 4, so check whether this is the same seam or a different one.

### Graceful empty / non-chart upload **[carried]**
An empty or non-chart PDF currently degrades to "overlay could not be generated", which
reads as a system failure rather than "this isn't a chart". It cost a real diagnostic
detour on 2026-08-26. Validate the upload and say something true instead of falling
through to the generic degrade path.

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

### No BPM control in the in-show chart flows **[carried]**
`song.bpm` is editable only in the Library song form (TapTempo). Add-to-show,
create-chart and edit-chart have no BPM control, and the show page only *reads* `song.bpm`
to feed the conductor. So a chart authored entirely in-show has an unreachable tempo
source. Either surface TapTempo in those flows, or confirm add-to-show always inherits a
library song that already carries BPM. Needs a small design pass.

### Artist display gaps **[carried]**
Two places an artist never shows: the in-show ManageChartsModal (the setlist RPCs build
their config blob from title/key/lead/notes and never include artist, so it needs blob
threading) and the builder preview.

### Nav-shrink edge **[carried]**
Shrinking a section below a navigation reference's bar leaves the reference dangling
until save, where server validation rejects it. Not silent corruption — but the
nav-editing UI does not exist yet, so this is latent rather than reachable.

### `tallyDraft` is op-blind **[carried]**
`tallyDraft` reads the pre-op SpanList, so the L4 read-back echo can disagree with the
folded spec — an intro `3x` repeat is not reflected. The read-back exists precisely to
catch a dropped span on sight, so a fidelity hole in it is worth more than it looks.

---

## Deferred design questions

### Mid-song key change is inexpressible **[carried]**
`renderKey` is global to a spec, so a song that modulates cannot be described. If this is
ever built, **the key change MUST be stored RELATIVE** — the new tonic as an interval off
the primary key — or it breaks transpose-invariance. That constraint is the whole reason
this note exists; do not design it as an absolute key per section.

### Old saved PDFs carry baked pre-fit-to-width calibration **[carried]**
Self-heals on the next save. No backfill was written, deliberately.

### Blank-key honesty flag **[carried]**
`song.key || authored_key` shows the authored key even when a show has *intentionally*
blanked it, because `resolveOverride` collapses blank `''` to `undefined` —
indistinguishable from "never set". A proper fix means carrying a resolved-key source
flag on the show payload, which touches override semantics with existing tests pinning
blank-as-intentional. Thin edge case; its own small chunk if it ever matters.

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
