# Design — Roadmap chart fit-to-width (builder preview)

Status: DRAFT (pre-Codex). Design-only. No build until approved.

## 1. Problem

The Roadmap Builder's on-screen chart preview clips a section to ~8 bars and
hides the rest behind a non-obvious **horizontal** scrollbar. Reported against a
10-bar intro: the chart appeared to drop the trailing `G×2`.

Root cause (verified, read-only): the data is intact — the parse/fold and the
saved spec preserve all 10 bars, and the PDF renderer lays them out correctly.
The defect is purely in the React preview component `ChartSheet`:

- `app/mockup/roadmap-builder/page.tsx:619` — each section's *entire* bar array
  renders into **one non-wrapping flex row** wrapped in `overflow-x-auto`.
- `app/mockup/roadmap-builder/page.tsx:667` — each `Measure` is
  `flex-1 min-w-[64px]`.
- The sheet is `max-w-[560px]` with `p-7` (`page.tsx:592`) → ~504px inner.
  504 ÷ 64 ≈ **7.9 bars** fit before the row exceeds the container; the rest
  overflow horizontally as a scrollbar. The "8" is incidental, not chosen.

## 2. Requirement (from Graham)

**Fit-to-WIDTH, not fit-to-page.**
- A page/line must fit the screen width — **never** horizontal scroll within a page.
- Multi-page is fine; **vertical** scroll / paging to subsequent pages is acceptable.
- Hard constraint for **Perform** (reading on stage): no horizontal scroll, ever.

## 3. Scope — this is a ONE-surface fix

| Surface | Today | Change |
| --- | --- | --- |
| **Perform** (`PerformTab`, `page.tsx:815`) | Displays the chart as a rendered **file** (PDF/PNG) in a viewer that fills the container and paginates (`page.tsx:2020`, `performDisplayPage` `page.tsx:2957`), with the calibration redline overlaid. Already fit-to-width. | **None** |
| **PDF renderer** (`lib/roadmap-render.ts:119-207`) | Flows sections → systems of `barsPerLine` across `PAGE_W` minus margins, wraps systems, paginates. Fit-to-width by construction. This is "the standard." | **None to output** (see §4.1 — extract layout for reuse) |
| **Builder preview** (`ChartSheet`, `page.tsx:566`) | Single non-wrapping `overflow-x-auto` row per section. **Broken.** | **Fix here** |

"Normalize around Perform" (Graham's call) therefore means: make the builder
preview lay bars out the **same way `roadmap-render` does** — so
**preview === print === Perform** (true WYSIWYG, no drift).

## 4. Design

### 4.1 Shared layout (no-drift guarantee)

Extract `roadmap-render`'s section→systems flow (`roadmap-render.ts:124-207`)
into a **pure, pdf-lib-free layout function**:

```
layoutSystems(spec, { barsPerLine }) → Array<{
  sectionId, sectionLabel, page, line,
  bars: Array<{ barIndex, chord }>      // barIndex is within the section
}>
```

It returns *which bars sit on which line/page* — pure geometry, no drawing.
Both consumers use it:
- the existing PDF drawer wraps it and draws with pdf-lib (behavior-preserving);
- the React preview maps each returned line to a bordered system row.

`roadmap-render.ts` already computes systems *before* drawing
(`lineCount = ceil(section.bars / barsPerLine)`, `barsThisLine = min(...)`), so
the layout is largely separable already. Build step confirms the seam.

### 4.2 `barsPerLine` — responsive within the musical standard

There **is** a standard: **4 bars/line** (Nashville / lead-sheet convention;
`DEFAULT_BARS_PER_LINE = 4` in `roadmap-render.ts:46`). It matters because
4-bar lines align to 4-bar phrases — players track the *form*, not just bars.
Pure "cram N to width" breaks phrasing (a 7-bar line is hard to read on stage).

Rule: **scale bars to fill the width, but pick `barsPerLine` from a musical set,
never an arbitrary count.**
- Default set: **{4, 8}** — 4 on narrow, 8 on wide. (Spike §5 sets the breakpoint
  and confirms 8 is legible.)
- Bars **flex-fill** the line so the chosen count spans the full width — no dead
  space, no overflow. (Replaces the `min-w-[64px]` + `overflow-x` that caused the
  bug: drop both.)
- **Author override:** if `spec.barsPerLine` is explicitly set, honor it (don't
  auto-responsive). Unset → responsive {4,8}. (Q1.)

### 4.3 Preview layout mechanics

In `ChartSheet`:
- Remove `overflow-x-auto` (`page.tsx:619`) and `min-w-[64px]` (`page.tsx:667`).
- For each section, consume `layoutSystems` → render each line as its own
  bordered system row (left/right barlines), bars `flex-fill` the row.
- A section longer than `barsPerLine` wraps to multiple rows (vertical growth) —
  acceptable per §2.
- The center container (`page.tsx:343`) keeps `overflow-y` for vertical scroll;
  **`overflow-x` must never trigger.**

### 4.4 Edit affordance preserved

Click-to-edit `Measure` is unchanged. Bars now live in wrapped rows, but the edit
key stays `${sectionId}:${barIndex}` where `barIndex` is the section-wide index —
wrapping does not change indices, so `commitBar` and editing are untouched.

## 5. Spike — 4 vs 8 bars/line (folded in)

Goal: set the width breakpoint for 4→8 and confirm 8-wide is legible across
devices.

Method (throwaway scaffolding in this worktree, **not shipped**): render the
representative 10-bar intro at container widths {360, 768, 1024, 1280}px, at both
4/line and 8/line; eyeball numeral + rhythm-slash legibility.

Output: the px breakpoint(s) and a confirmed set. Default hypothesis: `< ~700px`
→ 4/line, `≥ ~700px` → 8/line, set = {4, 8}. The spike confirms or adjusts;
adds a 2/line tier only if 4 is unreadable on phone portrait (Q3).

## 6. Open questions

- **Q1** — Honor explicit `spec.barsPerLine` over responsive? (lean: yes — author intent wins.)
- **Q2** — Preview pagination: render discrete pages matching the PDF now, or stack
  systems with vertical scroll now and add page-break visualization later? (lean:
  stack + vertical-scroll for MVP; page breaks are a follow-on. Graham OK'd multi-page scroll.)
- **Q3** — Phone portrait: is 4/line still too wide → add a 2/line tier?
- **Q4** — Keep the `max-w-[560px]` paper-sheet metaphor for the authoring preview
  (bars fill within it), or let the sheet fill the screen like Perform? (lean: keep
  a responsive sheet up to a max; the preview is an editor, not the stage view.)

## 7. Non-goals / separate backlog

- No change to parse/fold, the spec schema, Perform, or PDF *output*.
- **Separate issues observed during diagnosis (log as backlog, not this spec):**
  - `A7sus2` → `Asus2`: the quality enum (`roadmap-parse.ts:58`) has `sus2` but no
    `7sus2`, so the 7 is dropped.
  - The intro's "3x" repeat was not captured as a repeat op, and `tallyDraft` is
    op-blind (`roadmap-authoring.ts:340`) so the read-back can silently disagree
    with the folded spec when an op changes the bar count — a latent fidelity hole
    worth its own fix.

## 8. Test plan

- **Unit** — `layoutSystems`: a section of N bars at `barsPerLine` B yields
  `ceil(N/B)` lines, last line `N mod B || B` bars; output matches the systems
  `roadmap-render` produces today (port/extend the existing render tests so the
  extraction is provably behavior-preserving).
- **Manual/visual** — builder preview at the §5 widths: no horizontal scrollbar
  ever; all bars visible; preview matches the generated PDF.
- **Regression** — existing `roadmap-render` tests unchanged (layout extraction
  must not alter PDF output).
