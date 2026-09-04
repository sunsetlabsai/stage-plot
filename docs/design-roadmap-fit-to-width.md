# Design — Roadmap chart fit-to-width + PDF render fixes

Status: Build state tracked in `docs/INDEX.md`, not here.

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

**Invariant — same algorithm, surface-appropriate width (NOT pixel-identical).**
"Normalize around Perform" (Graham's call) = preview and PDF run the **one shared
`layoutSystems`** — identical wrapping/constant-width/partial-left-align RULES — each
passing its **own** `barsPerLine` + target width. They are deliberately NOT
pixel-for-pixel the same: the PDF is a fixed 8.5×11 page that defaults to 4/line
(unless `spec.barsPerLine` is explicitly set — §6 Q1); the preview is responsive
{2,4,8} and (MVP) stacks/scrolls instead of paginating (§6 Q2). So on phone, wide
screens, or page boundaries the preview will differ in bars-per-line and page breaks —
**by design**. What CANNOT drift is the layout *algorithm*: there is exactly one code
path, so a given (barsPerLine, width) always produces the same geometry on any surface.
That is the no-drift guarantee, and it is what protects Perform's PDF/calibration.

## 4. Design

### 4.0 PDF header fix (Bug A) — draw-only

In `drawRoadmapPdf`, the whole header band (title, artist, key, future BPM) renders
at the page *bottom* — today title, artist, AND key all land there (Graham confirmed:
"it's not just title but the key... and likely if/when i add it the BPM and the
artist"). Root cause: `drawText` passes `y` straight to bottom-origin
`page.drawText`, but the header uses top-measured expressions (`MARGIN_TOP - 36` etc.)
with no flip.

**Do NOT mechanically wrap the existing `MARGIN_TOP - 36 / - 52 / - 70` expressions
in `PAGE_H - (…)`** — that inverts the ordering (it would put title lowest). Instead:
1. Add a `denormYTopPt(topOffset) = PAGE_H - topOffset` helper (mirrors `denormYTop`).
2. Define the header as clean **top-origin baseline offsets**, descending from the top
   edge: `title = 36`, `artist = 52`, `key = 70` (`BPM` slots in when added). Larger
   offset = lower on the page; title smallest = highest. All within the top 96pt margin.
3. Route every header `drawText` `y` through `denormYTopPt(offset)` so title=PAGE_H-36
   (highest), artist=PAGE_H-52, key=PAGE_H-70, and any future field is correct by
   construction.

Draw-only. No layout/geometry change, no calibration impact.

### 4.1 Shared layout + constant-width fix (Bug B) — the no-drift core

Extract `roadmap-render`'s section→systems flow (`:124-205`) into a **pure,
pdf-lib-free** layout function consumed by BOTH the PDF drawer and the React
preview.

**Module boundary (hard constraint).** `lib/roadmap-render.ts` imports `pdf-lib` at
top level; `ChartSheet` is a **client** component. The pure layout MUST live in a NEW
module (e.g. `lib/roadmap-layout.ts`) that imports NO pdf-lib — `roadmap-render.ts`
imports it, and so does the client preview, but the client never transitively pulls
pdf-lib into its bundle. Verify no pdf-lib import path reaches the client (e.g. a
bundle/`import`-graph check, not just "it builds").

```
layoutSystems(spec, { barsPerLine }) → Array<{
  sectionId, sectionLabel, page, line,
  barsThisLine,                          // grouping decision (for partial-line logic)
  xStart, xEnd,                          // system extents in PDF points (see below)
  bars: Array<{ barIndex, xStart, xEnd, chord }>
}>
```

**Coordinate space.** `layoutSystems` is parameterized by `barsPerLine` only and emits
**PDF-point** geometry (`CONTENT_W`-based `xStart/xEnd`) — that is the PDF drawer's
direct input, no extra width arg needed. The PDF passes its `barsPerLine` and draws the
points as-is. The **preview** does NOT consume those points; it consumes the
**grouping decisions** (`page`/`line`/`barsThisLine` per system + which `barIndex`es
land on each line) and the constant-width/left-aligned-partial RULE, then computes its
OWN pixel geometry from its container width (§4.3). One algorithm, two coordinate
spaces — that is the §3 "same algorithm, surface-appropriate width" seam made concrete.

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
a **musical set {2, 4, 8}** (never arbitrary) — 2 phone-portrait, 4 narrow, 8 wide.
Spike (§5) sets the breakpoints and confirms legibility. If `spec.barsPerLine` is
explicitly set, honor it and skip the responsive pick (Q1).

NOTE: the PDF is a fixed 8.5×11 page (`barsPerLine` from the spec/default 4); the
responsive {2,4,8} pick applies to the on-SCREEN preview (and any future
screen-target render). The PDF and the preview share the layout fn but pass their
own `barsPerLine` — same algorithm, surface-appropriate input.

### 4.3 Preview layout mechanics (P1)

**What the preview consumes.** The preview does NOT reuse the PDF's absolute
`xStart/xEnd` points (those are 8.5×11-page coordinates that don't transfer to a
responsive container). It consumes `layoutSystems`' **decisions**: the per-line bar
groupings (which bars on which line, given the chosen `barsPerLine`) and the
constant-width + left-aligned-partial RULE. It computes its own pixel widths from its
own container width. Same algorithm (§3 invariant), different target width.

In `ChartSheet`: remove `overflow-x-auto` (`:619`) and `min-w-[64px]` (`:667`);
render each `layoutSystems` line as its own bordered system row. Each row is a fixed
**`barsPerLine`-column grid** (`grid-template-columns: repeat(barsPerLine, 1fr)`), NOT
`flex-fill` — flex-fill would stretch a 2-bar partial line across the row, re-creating
Bug B on screen. A partial line fills its first N cells at the constant column width
and leaves the trailing cells **empty** (left-aligned), and the row's trailing border
tracks the last real bar — mirroring the PDF's partial-line system edge (§4.1).
Sections > `barsPerLine` wrap to multiple rows (vertical growth, acceptable). The
center container (`:343`) keeps `overflow-y`; **`overflow-x` must never trigger.**

### 4.4 Edit affordance preserved

Click-to-edit `Measure` is unchanged. Edit key stays `${sectionId}:${barIndex}`
(section-wide index); wrapping doesn't change indices, so `commitBar` is untouched.

## 5. Spike — 2 / 4 / 8 bars/line breakpoints (folded in)

Set the preview width breakpoints across the {2,4,8} set and confirm legibility at
each tier. Throwaway scaffolding in this worktree (**not shipped**): render the
10-bar intro at widths {360, 480, 768, 1024, 1280}px at 2/line, 4/line and 8/line;
eyeball numeral + slash legibility. Output: the px breakpoints and confirmed tiers.
Hypothesis: `< ~480px` → 2, `< ~700px` → 4, `≥ ~700px` → 8. Q3 locked the 2/line
phone tier in; the spike confirms its breakpoint rather than deciding whether to add it.

## 6. Resolved decisions (Graham, locked)

- **Q1 → YES.** Honor explicit `spec.barsPerLine` when set; skip the responsive pick.
  The responsive {2,4,8} applies only when `barsPerLine` is unset. An explicit value
  applies to **both** surfaces: the PDF uses it as bars/line, and the preview uses it
  as its grid column count (still scaling those columns to fit the container width).
  The two stay on the same algorithm with the same `barsPerLine` — only the target
  width differs.
- **Q2 → STACK + VERTICAL-SCROLL MVP.** Preview stacks systems and scrolls vertically;
  discrete page breaks matching the PDF are a later enhancement, not this PR.
- **Q3 → YES.** Add a **2/line** tier for phone portrait. Set: {2, 4, 8}; the §5 spike
  sets the breakpoints (≈ <480px → 2, <700px → 4, ≥700px → 8; spike confirms).
- **Q4 → RESPONSIVE SHEET UP TO A MAX.** Drop the hard `max-w-[560px]`; the authoring
  sheet fills available width up to a sane max so it reads like Perform on wide screens.
- **Q5 → LEAVE + BACKLOG.** Old saved PDFs keep their baked (stretched) calibration;
  geometry self-heals on the next render/save. Backlog note, not this PR.

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
  band (`y` in `[PAGE_H - MARGIN_TOP, PAGE_H]`), and ordering is correct — title
  highest, then artist, then key (`y_title > y_artist > y_key`), non-overlapping.
  Guards against the mechanical-flip ordering inversion.
- **Unit — responsive `barsPerLine` selection:** the width→{2,4,8} picker returns 2
  below the phone breakpoint, 4 in the mid band, 8 at/above the wide breakpoint
  (boundary cases at each breakpoint).
- **Unit — explicit override (Q1):** when `spec.barsPerLine` is set, the responsive
  picker is bypassed and that value is used regardless of width.
- **Unit — module boundary:** an import-graph/bundle assertion that the client preview
  path does NOT transitively import `pdf-lib`.
- **Behavior-preserving extraction:** for full-width sections (no partial line), the
  extracted layout reproduces today's systems byte-for-byte; update only the tests
  that asserted the OLD stretched partial-line geometry, and document the change.
- **Manual/visual:** generated PDF — header at top (ordered, in margin band), partial
  line left-aligned at constant width, trailing border tracking the last real bar.
  Builder preview at §5 widths — no horizontal scrollbar, all bars visible, partial
  line left-aligned (NOT stretched). Note: preview is **not** pixel-identical to the
  PDF (responsive {2,4,8} vs fixed 4, stack-scroll vs paginate, §3 invariant); verify
  the shared *algorithm* (constant width, left-aligned partial, correct wrapping for
  the chosen `barsPerLine`), not pixel parity.
