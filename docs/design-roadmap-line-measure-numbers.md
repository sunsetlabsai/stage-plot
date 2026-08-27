# Design — line-start measure numbers on generated roadmap charts

**Status.** Design, for review. Build-ready — a rendering-only addition to the builder
(generated) chart path. No schema, no calibration, no data-model change.

---

## 1. Goal

Every rendered system/line of a **generated** roadmap chart shows the absolute measure
number of its first bar, in both outputs the builder produces:

- the **PDF** (`lib/roadmap-render.ts`), and
- the **live Roadmap Builder preview** (`components/RoadmapBuilder.tsx`),

each labelling its own lines by the **same rule** — but see §3.3: the two surfaces do not
always wrap at the same bars, so "no drift" means one shared numbering rule, not an identical
set of visible numbers. Uploaded-PDF charts (the overlay world) are out of scope — this is
the from-scratch/native path only.

**What the number IS.** It labels ShowRunr's `Bar.absNumber` — the dense, global,
reading-order bar index. This is bar *labeling*, not pickup-aware printed measure numbering:
`RoadmapSpec` has no anacrusis/pickup concept today, so there is no "m.0" or skipped-pickup
convention (Codex note). Conventional pickup-aware numbering would be a `RoadmapSpec` change,
out of scope here.

Line-start measure numbers are a standard navigation anchor: they orient a performer, speed
rehearsal call-outs ("from bar 33"), and make roadmap/conductor debugging legible.

---

## 2. The data already exists

`Bar.absNumber` (`lib/types.ts:108`) is the 1-based **global** bar number in reading order,
already computed by the builder layout (`lib/roadmap-layout.ts:132,174,182`) and already
carried on every laid bar. Reading order is page → system(yTop) → bar(xStart), so the first
bar of each system is `system.bars[0]` and its `absNumber` is exactly the line-start number
we want. **Nothing new is computed; the number is only *drawn*.**

The PDF render loop already iterates exactly this structure — for each `sys` in
`layout.systems`, it draws the label, baseline, and per-bar leading barlines
(`roadmap-render.ts:239-253`). The line-start number is one more `drawText` per system.

---

## 3. Rendering

### 3.1 PDF (`lib/roadmap-render.ts`) — the left gutter, not above the barline

**Placement, corrected (Codex Medium).** The first draft put the number just above the leading
barline (`yTopPt + 3`). That collides: the section label is drawn at `denormYTop(labelYTop) − 12`
(`:242`) and `SYSTEM_LABEL_H = 16`, so `yTopPt + 3` lands ~1pt from the label baseline at the
*same* left anchor — same row, not "different rows." Reserve a real location instead.

Use the **left margin gutter**, the conventional spot for measure numbers. `MARGIN_X = 48`, and
a full-width system's leading barline sits at `denormX(0) = 48`, so there is a 48pt gutter to
its left. Draw `sys.bars[0].absNumber` there, **right-aligned just left of the leading barline,
at the top of the bar row**, measuring the glyph width so it never crosses into the staff:

```
const first = sys.bars[0];
if (first) {
  const label = String(first.absNumber);
  const w = font.widthOfTextAtSize(label, 8);
  const x = denormX(first.xStart) - w - 3;   // in the gutter, 3pt clear of the barline
  drawText(pg, font, label, x, yTopPt - 8, 8);
}
```

- Horizontally clear of the section label (which extends *rightward* from x = 48) and of chord
  content (drawn *inside* the bar row), so it collides with neither, on labelled and
  continuation systems alike.
- 8pt regular, subordinate to the 11pt bold label.
- **Multi-page is free.** `absNumber` is global, so numbering continues across page breaks with
  no special case.
- Placement/size stay tunable in implementation; the invariant is "in the gutter, right-aligned
  to the barline," not the exact offsets.

### 3.2 Preview (`components/RoadmapBuilder.tsx`)

The preview groups a section's bars into lines with `chunkIntoLines` and renders each as a CSS
grid (`:756-805`); it does not carry `absNumber` today. It must label each line by the same
reading-order index the PDF uses — render that number at the start of the line row (a small
muted cell to the left of the grid), matching the PDF's subordinate weight.

### 3.3 The one shared rule — and the wrap difference it does NOT paper over

**Anti-drift, corrected (Codex Medium).** The first draft claimed a single
`lineStartNumbers(spec)` helper makes the two surfaces show identical numbers. It does not,
because the two surfaces do not always wrap at the same bars. `resolveBarsPerLine`
(`roadmap-layout.ts`) resolves bars-per-line as **explicit `spec.barsPerLine` → responsive
override → default 4**. When `spec.barsPerLine` is unset, the **preview** passes a responsive
override from `pickBarsPerLine` (2/4/8 by width) while the **PDF** passes none and falls to 4 —
so their lines start at different bars. Their existing tests pin this on purpose
(`layoutRoadmap(spec, { barsPerLine: 2 })` ≠ `layoutRoadmap(spec)`).

So separate the two things the feature must guarantee:

1. **One numbering rule (this IS the "no drift").** A line's number is the `absNumber` of its
   first bar — full stop. Both surfaces must assign `absNumber` by the *same* reading-order
   rule the layout already uses, so a given bar has one number everywhere. The single producer
   should operate on the surface's **actual resolved lines** (`LaidSystem[]` for the PDF, the
   preview's chunked lines) — or take the resolved bars-per-line that surface used — **not on
   `spec` alone**, since `spec` alone cannot know how a surface wrapped. Reading `absNumber`
   off the first bar of each real line is what keeps the *rule* single-sourced.
2. **Identical visible line starts is a SEPARATE, bigger decision.** Making the preview show
   the exact same line-start numbers as the PDF requires the preview to render at the PDF's
   resolved bars-per-line — i.e. give up responsive wrapping and become WYSIWYG with the print
   layout. That is a product call well beyond measure numbers, and this feature should **not**
   silently force it. Recommendation: label each surface's own lines correctly; if true WYSIWYG
   is wanted, raise it as its own change.

**Decision for review:** ship (1) — correct per-surface labeling under a shared rule — and
leave (2) as an explicit, separate question. If the intent behind "preview and PDF do not
drift" was actually (2), say so and this becomes a preview-layout change, not a numbering one.

---

## 4. Determinism and `source_hash`

`renderRoadmap` is deterministic on purpose (stripped dates, `StandardFonts`, vector glyphs)
so a given spec always produces identical bytes and a stable `source_hash`
(`roadmap-render.ts:11-21,206-211`). Drawing `absNumber` preserves that: the number is a pure
function of the spec's structure, so the same spec still renders byte-identically every time.

One consequence to state plainly: adding ink **changes the bytes relative to the old render**,
so a chart *re-rendered* after this ships gets a new `source_hash` (and a fresh, structurally
identical calibration via the generate-once-per-hash model). **Existing saved charts are
unaffected** — their stored PDF bytes, `source_hash`, and calibration live in Storage/DB and
are not touched until the owner regenerates. This is a version bump, not a break, and not
non-determinism.

---

## 5. Explicitly NOT changed

- **No calibration/schema change.** `ChartCalibration`, `Bar.absNumber`, and the DB `graph`
  are untouched; `renderRoadmap`'s returned `calibration` is identical to before, same
  `absNumber` values. (§6 pins this.)
- **No overlay/uploaded-chart change.** That path renders no PDF of its own.
- **No layout geometry change.** Bar widths, wrapping, and page breaks are unchanged; the
  number sits in existing whitespace above the barline.

---

## 6. Tests

- **Calibration is byte-for-byte unchanged.** Render a spec before/after and assert the
  returned `calibration.bars` (ids, coords, `absNumber`, sectionIds) is identical — the visual
  addition must not perturb the structured output. This is the "calibration remains unchanged"
  guarantee.
- **Determinism holds.** Rendering the same spec twice yields identical `pdfBytes` (and thus
  identical `source_hash`). If an existing determinism/hash test exists, extend it; otherwise
  add one — this is the "PDF output remains deterministic" guarantee.
- **The rule is correct and single-sourced.** Unit-test the shared producer (§3.3) over
  **resolved lines**: given lines for a multi-section, multi-line, multi-page chart it returns
  the first-bar `absNumber` of each line, and both the PDF renderer and the preview consume it
  rather than hand-rolling a count. (Asserting rendered PDF glyphs directly is brittle; testing
  the shared producer is the honest, durable check.)
- **Same bar → same number across surfaces, under different wraps.** Resolve the SAME chart at
  the PDF's bars-per-line and at a responsive value (e.g. 2 and 8), and assert the producer
  labels each surface's lines correctly and that any bar appearing as a line-start carries the
  same `absNumber` in both — the actual "no drift" guarantee (§3.3 item 1). Do **not** assert
  the two line-start *sets* are equal; that is false by design (§3.3 item 2) and asserting it
  would bake in a WYSIWYG requirement nobody chose.

---

## 7. Minor decisions for review

- **Show m.1 or omit it?** Some engraving omits the number on the very first system (it is
  trivially bar 1). The task says "each rendered system/line," so the default here is **show
  all, including m.1** — simpler, unambiguous, and the most useful for debugging. Flagging in
  case the preference is to omit the first.
- **Placement** is the left gutter, right-aligned to the leading barline (§3.1); exact
  offsets/size are tunable in implementation and change no other decision.
- **Per-surface labeling vs WYSIWYG line starts** (§3.3 item 2) — ship per-surface labeling;
  confirm whether true preview/PDF WYSIWYG is wanted as a separate change.
