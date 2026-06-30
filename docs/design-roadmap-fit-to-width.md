# Design — Roadmap chart fit-to-width + PDF render fixes

Status: DRAFT (pre-Codex). Design-only. No build until approved.

## 1. Problem

Two related defects in how an AI-authored roadmap chart is laid out and displayed.
The chord DATA is correct throughout (parse/fold/spec preserve every bar); these
are all **geometry/layout** bugs.

**(P1) Builder preview clips to ~8 bars behind a horizontal scrollbar.**
`ChartSheet` renders a section's whole bar array into one non-wrapping flex row:
- `app/mockup/roadmap-builder/page.tsx:619` — `flex … overflow-x-auto`
- `app/mockup/roadmap-builder/page.tsx:667` — each `Measure` is `flex-1 min-w-[64px]`
- sheet is `max-w-[560px] p-7` (`page.tsx:592`) → ~504px inner ÷ 64 ≈ 7.9 bars fit;
  the rest overflow horizontally. The "8" is incidental, not chosen.

**(P2) The generated PDF itself is mangled** (so Perform, which displays the PDF,
shows it mangled too). Two bugs in `lib/roadmap-render.ts`:
- **Bug A — header at the bottom.** `drawText` (`:637`) passes `y` straight to
  pdf-lib's bottom-origin `page.drawText`. The body systems flip top→bottom via
  `denormYTop = PAGE_H*(1-yNorm)` (`:633`), but the header does NOT: title
  `y = MARGIN_TOP - 36 = 60` (`:365`), artist `MARGIN_TOP - 52` (`:368`), key
  `MARGIN_TOP - 58/70` (`:370`) are *top-measured* point values used as
  bottom-origin → the whole header renders ~40-60pt **from the bottom**.
- **Bug B — partial last line stretches full width.** `:154`
  `cellW = CONTENT_W / barsThisLine`. A 2-bar last line gets `CONTENT_W/2` per bar
  (double width; a 1-bar line → quadruple). The code comment ("equal-width within
  a system", `:120`) confirms it was deliberate-but-wrong. Bars should be a
  CONSTANT `CONTENT_W / barsPerLine`, with a partial line left-aligned.

## 2. Requirement (from Graham)

**Fit-to-WIDTH, not fit-to-page.**
- A page/line must fit the screen width — **never** horizontal scroll within a page.
- Multi-page is fine; **vertical** scroll / paging to subsequent pages is acceptable.
- Bars are a **constant width**; a short last line does not stretch to fill.
- Hard constraint for **Perform** (reading on stage).

## 3. Scope

| Surface | Today | Change |
| --- | --- | --- |
| **PDF renderer** (`lib/roadmap-render.ts`) | Header lands at page bottom (Bug A); partial lines stretch (Bug B). | **FIX A + B.** B lives in the shared layout (§4.1); A is PDF-draw-only (§4.0). |
| **Perform** (`PerformTab`, `[owner]/[show]/page.tsx:815`) | Displays the rendered PDF file in a container-filling, paginated viewer (`:2020`, `:2957`) with the calibration redline. Mechanically fit-to-width; its CONTENT was mangled only because the PDF was. | **None** — fixing the PDF fixes Perform. |
| **Builder preview** (`ChartSheet`, `roadmap-builder/page.tsx:566`) | Single non-wrapping `overflow-x` row per section (P1). | **Fix** — consume the shared layout (§4.1, §4.3). |

"Normalize around Perform" (Graham's call) = make the builder preview lay bars out
the **same way the (now-fixed) PDF does**, so **preview === print === Perform**.

## 4. Design

### 4.0 PDF header fix (Bug A) — draw-only

In `drawRoadmapPdf`, flip **every** header baseline to bottom-origin so the whole
header band sits in the top `MARGIN_TOP` strip — today title, artist, AND key all
land at the bottom (Graham confirmed: "it's not just title but the key... and
likely if/when i add it the BPM and the artist"). Either convert each
(`y = PAGE_H - topOffset`) or add a `denormYTopPt(pt) = PAGE_H - pt` helper
mirroring `denormYTop`, then route ALL header text through it so any future field
(BPM, etc.) is correct by construction rather than per-line. Order title → artist →
key (→ BPM), title highest. Exact offsets are a layout nicety; constraint: all
inside the top 96pt margin, descending, non-overlapping. No layout/geometry
change, no calibration impact.

### 4.1 Shared layout + constant-width fix (Bug B) — the no-drift core

Extract `roadmap-render`'s section→systems flow (`:124-205`) into a **pure,
pdf-lib-free** layout function consumed by BOTH the PDF drawer and the React
preview:

```
layoutSystems(spec, { barsPerLine }) → Array<{
  sectionId, sectionLabel, page, line,
  xStart, xEnd,                          // system extents (see below)
  bars: Array<{ barIndex, xStart, xEnd, chord }>
}>
```

Fix B inside it:
- `cellW = CONTENT_W / barsPerLine` — **constant**, independent of `barsThisLine`.
- A partial line's bars are left-aligned at constant width; the **system's right
  edge / trailing barline** is the last real bar's `xEnd`
  (`MARGIN_X + barsThisLine * cellW`), NOT `PAGE_W - MARGIN_X`. (Today `:380`
  bottom rule and `:386` trailing barline both run to the page edge — they must
  track the partial line.)

`roadmap-render` already computes systems before drawing, so the seam is clean.
The PDF drawer keeps its pdf-lib draw; the preview maps each line to a system row.

### 4.2 `barsPerLine` — responsive within the musical standard

There IS a standard: **4 bars/line** (Nashville / lead-sheet; `DEFAULT_BARS_PER_LINE
= 4`, `:46`). 4-bar lines align to 4-bar phrases — players track the *form*. Pure
"cram N to width" breaks phrasing.

Rule: bars fill the width at **constant** `cellW`, but `barsPerLine` is chosen from
a **musical set {4, 8}** (never arbitrary) — 4 narrow, 8 wide. Spike (§5) sets the
breakpoint and confirms 8 is legible. If `spec.barsPerLine` is explicitly set,
honor it and skip the responsive pick (Q1).

NOTE: the PDF is a fixed 8.5×11 page (`barsPerLine` from the spec/default 4); the
responsive {4,8} pick applies to the on-SCREEN preview (and any future
screen-target render). The PDF and the preview share the layout fn but pass their
own `barsPerLine` — same algorithm, surface-appropriate input.

### 4.3 Preview layout mechanics (P1)

In `ChartSheet`: remove `overflow-x-auto` (`:619`) and `min-w-[64px]` (`:667`);
render each `layoutSystems` line as its own bordered system row, bars flex-fill at
constant width. Sections > `barsPerLine` wrap to multiple rows (vertical growth,
acceptable). The center container (`:343`) keeps `overflow-y`; **`overflow-x` must
never trigger.**

### 4.4 Edit affordance preserved

Click-to-edit `Measure` is unchanged. Edit key stays `${sectionId}:${barIndex}`
(section-wide index); wrapping doesn't change indices, so `commitBar` is untouched.

## 5. Spike — 4 vs 8 bars/line (folded in)

Set the preview width breakpoint for 4→8 and confirm 8-wide legibility. Throwaway
scaffolding in this worktree (**not shipped**): render the 10-bar intro at widths
{360, 768, 1024, 1280}px at 4/line and 8/line; eyeball numeral + slash legibility.
Output: the px breakpoint(s) and confirmed set. Hypothesis: `< ~700px` → 4,
`≥ ~700px` → 8. Add a 2/line tier only if 4 is unreadable on phone portrait (Q3).

## 6. Open questions

- **Q1** — Honor explicit `spec.barsPerLine` over the responsive preview pick? (lean: yes.)
- **Q2** — Preview pagination: discrete pages matching the PDF now, or stack systems +
  vertical-scroll now and add page breaks later? (lean: stack/scroll MVP.)
- **Q3** — Phone portrait: add a 2/line tier if 4 is too wide?
- **Q4** — Keep the `max-w-[560px]` paper sheet for authoring, or fill the screen like
  Perform? (lean: responsive sheet up to a max.)
- **Q5 (new)** — Old saved roadmap PDFs carry baked calibration from the OLD (stretched)
  geometry. Re-render on next open, or leave until next manual save? (lean: leave;
  geometry self-heals on the next render — note for backlog, not this PR.)

## 7. Non-goals / separate backlog

- No change to parse/fold or the spec schema.
- **Separate issues from diagnosis (backlog, not this spec):**
  - `A7sus2` → `Asus2`: quality enum (`roadmap-parse.ts:58`) has `sus2`, no `7sus2`.
  - The intro "3x" repeat wasn't captured, and `tallyDraft` is op-blind
    (`roadmap-authoring.ts:340`) so the read-back can disagree with the folded spec —
    a latent fidelity hole.

## 8. Test plan

- **Unit — `layoutSystems`:** N bars at `barsPerLine` B → `ceil(N/B)` lines; the last
  line has `N mod B || B` bars; **every** bar across all lines has identical width
  `CONTENT_W / B` (the Bug-B regression guard); the partial line's system `xEnd`
  equals its last bar's `xEnd`.
- **Unit — header (Bug A):** title/artist/key baselines resolve to the top margin
  band (`y` in `[PAGE_H - MARGIN_TOP, PAGE_H]`), descending, non-overlapping.
- **Behavior-preserving extraction:** for full-width sections (no partial line), the
  extracted layout reproduces today's systems byte-for-byte; update only the tests
  that asserted the OLD stretched partial-line geometry, and document the change.
- **Manual/visual:** generated PDF — header at top, partial line left-aligned at
  constant width; builder preview at §5 widths — no horizontal scrollbar, all bars
  visible, preview matches the PDF.
