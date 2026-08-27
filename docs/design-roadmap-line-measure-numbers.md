# Design — line-start measure numbers on generated roadmap charts

**Status.** Design, for review. Build-ready — a rendering-only addition to the builder
(generated) chart path. No schema, no calibration, no data-model change.

---

## 1. Goal

Every rendered system/line of a **generated** roadmap chart shows the absolute measure
number of its first bar, in both outputs the builder produces:

- the **PDF** (`lib/roadmap-render.ts`), and
- the **live Roadmap Builder preview** (`components/RoadmapBuilder.tsx`),

so the two never disagree. Uploaded-PDF charts (the overlay world) are out of scope — this
is the from-scratch/native path only.

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

### 3.1 PDF (`lib/roadmap-render.ts`)

In the per-system loop (`:239`), draw `sys.bars[0].absNumber` once per system, at the top-left
of the system just above the leading barline — the conventional engraving position. Reuse the
existing `drawText(page, font, text, x, y, size)` helper:

```
const first = sys.bars[0];
if (first) {
  drawText(pg, font, String(first.absNumber), denormX(first.xStart) + 1, yTopPt + 3, 8);
}
```

- Small (8pt) and in the regular font, visually subordinate to the 11pt bold section label
  that may sit just above it (`:242`). Placement is tuned so the two do not collide; the
  section label is left-anchored at `sys.xStart` and sits `~12pt` above `labelYTop`, while the
  number sits at the barline just above `yTop` — different rows.
- **Multi-page is free.** `absNumber` is global, so numbering continues correctly across page
  breaks with no special case.

### 3.2 Preview (`components/RoadmapBuilder.tsx`)

The preview groups bars into lines with the shared `chunkIntoLines`/`pickBarsPerLine`
(`roadmap-layout.ts`), then renders each line as a CSS grid (`:756-805`). It does not carry
`absNumber` today, so it must compute the line-start number the same way the layout does — a
running count in reading order:

- Walk sections in order; maintain a running bar count; the first bar of each rendered line
  carries `runningCount + 1`.
- Render that number at the start of the line row (a small muted cell/label to the left of the
  grid, or the first `<Measure>`'s corner), matching the PDF's subordinate weight.

**Anti-drift requirement.** The number must be derived from the *same* section→bar reading
order both paths already agree on (that agreement is why wrap points can't drift today). The
safest implementation exposes one helper — e.g. `lineStartNumbers(spec | laidLines): number[]`
in `roadmap-layout.ts` — that both the PDF renderer and the preview call, so there is a single
producer of the sequence rather than two hand-rolled running counts. Prefer this over
duplicating the count in the component.

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
- **The sequence is correct and single-sourced.** Unit-test `lineStartNumbers` (§3.2): for a
  multi-section, multi-line, multi-page spec it returns the first-bar `absNumber` of each line
  in order (1, then 1 + bars-in-line-1, …), and the PDF renderer and preview both consume it —
  so a test on the helper covers both surfaces. (Asserting rendered PDF glyphs directly is
  brittle; testing the shared producer is the honest, durable check, consistent with how the
  builder's other render logic is tested.)
- **Preview/PDF agreement.** Assert the preview's line-start numbers equal `lineStartNumbers`
  for the same spec — the anti-drift check §1 promises.

---

## 7. Minor decisions for review

- **Show m.1 or omit it?** Some engraving omits the number on the very first system (it is
  trivially bar 1). The task says "each rendered system/line," so the default here is **show
  all, including m.1** — simpler, unambiguous, and the most useful for debugging. Flagging in
  case the preference is to omit the first.
- **Placement/size** (8pt, above the leading barline) is a starting point to tune against the
  section label during implementation; it changes no other decision.
