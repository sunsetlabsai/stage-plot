# Design: Numbers ⇄ Letters in the Show View

**Status:** Draft v1 — for Codex adversarial review
**Depends on:** roadmap builder (renderRoadmap, roadmap-view), chart_library
**Scope:** Let a performer see a builder roadmap chart as **letters** (real chords in
the designated key) or **Nashville numbers** on stage, as a sticky per-show setting.
Default: **Letters.** No change to the pdf.js performance viewer, the calibration
system, or the marker/darkness overlay.

---

## The Problem

The Numbers⇄Letters toggle already exists — but **only in the builder's Review
preview** (`RoadmapBuilder.tsx:747`, HTML), where you author. The performer on stage
never sees it, because:

1. The **baked PDF is Nashville-numbers only.** `lib/roadmap-render.ts:338` hardcodes
   the label as `${c.degree}${c.quality}${c.bass}` and the header (`:244`) prints
   `Nashville (authored in {key})`. It never calls `renderCell`/`degreeLetter`.
2. The **show view renders that baked PDF** via pdf.js (`loadPdfDoc`/`renderPage`) —
   it does not render `source_spec` natively. There is nothing on stage to re-spell.

Graham's call: if we pick one for the stage, pick **Letters** (actual chords in the
designated key). "Both" is the real goal, as long as the squeeze is worth it.

---

## The one fact that makes this cheap

Numbers and Letters differ **only in the text drawn inside each bar.** They share:

- the same `layoutRoadmap` output (bar/system geometry),
- the same `buildCalibration(spec, layout)` projection (marker coords),
- the same header/section/volta furniture.

Bar x-positions in `drawBarContent` are **beat-fraction based**
(`cx = x0 + 4 + frac * w`), not text-width based — the label content cannot shift a
bar. So the two PDFs are **calibration-identical**. Swapping which PDF the show loads
therefore **cannot** disturb the section-marker / seek / held-band-darkness overlay —
the expensive part of the performance view is untouched. This is the load-bearing
claim; it gets its own test (§Tests, T2).

`degreeLetter` also emits **ASCII** accidentals (`F#`, `Bb` — see `CHROM_SHARP`/
`CHROM_FLAT`, `roadmap-view.ts:385`), which Helvetica/WinAnsi encodes directly. So
the letters path in the PDF is a plain `drawText` — it does **not** need the
vector-accidental glyph machinery (`drawAccidental`/`accW`) that numbers mode needs
for `♭`/`♯`. Letters is the simpler of the two render branches.

---

## Design (Option A — bake both, lazily; default show to Letters)

### 1. Make `renderRoadmap` notation-aware

```ts
export interface RenderOptions {
  songTitle?: string;
  artist?: string;
  notation?: 'numbers' | 'letters'; // default 'numbers' — existing callers unchanged
}
```

In `drawBarContent`, branch on notation:

- **numbers** (today, byte-identical): vector accidental via `accW`/`drawAccidental`,
  label `${c.degree}${c.quality}${c.bass?'/'+c.bass:''}`.
- **letters**: `const label = renderCell(cellFromBar(c), 'letters', spec.renderKey)`
  — plain ASCII, single `drawText`, no `accW`, no `drawAccidental`. (The bar's chord
  object already carries `degree/alter/quality/bass`; `renderCell` is the one shared
  spelling seam, so numbers-in-preview and letters-in-PDF agree by construction.)

Header line (`:244`) branches too:
- numbers → `Nashville (authored in {renderKey})`
- letters → `Key of {renderKey}` — it's real chords now.

`held` diamonds, split ticks, section labels, voltas, measure numbers, the rhythm
strip: **unchanged** (mode-invariant). Only the chord glyph and the header string move.

### 2. Storage — a derivable letters sibling, rendered on demand

Today: save renders numbers, hashes the bytes, stores at
`${uid}/${songKey}/${role}/${H}.pdf` where `H = hashPdfBytes(numbersBytes)`. The
`chart_library` row keeps `storage_path` + `source_hash = H`.

A letters PDF has **different bytes → a different hash**, so it can't be addressed by
its own content hash and still be derivable. Instead we key it off the **numbers
hash** — a stable proxy for spec identity (guaranteed by the determinism tests):

```
letters sibling: ${uid}/${songKey}/${role}/${H}-letters.pdf
```

Derivable from the numbers path by string transform; no new column, no migration.

**Lazy materialization** (uniform for new and legacy charts — no backfill):

`GET /api/charts/roadmap/[chartId]/pdf?notation=letters`
1. Read the chart row (public builder chart; 422 if not a builder chart).
2. Compute the letters path from the stored `source_hash`.
3. If the object exists → 302 to its public URL.
4. If missing → render `renderRoadmap(source_spec, { notation:'letters', ... })`,
   upload to the letters path (`upsert:true`, content-addressed so races are safe),
   then 302 to the public URL.

First letters view of a chart pays one deterministic render (~fast); every later view
is a direct, cacheable public URL. Numbers is **unchanged** — still the direct public
URL, no endpoint hop in the hot path. Legacy builder charts need **no re-save** — the
endpoint materializes their letters sibling on first request.

### 3. Per-show setting — rides in the show config, no migration

The show config (`AppConfig`) is already persisted wholesale to localStorage **and**
Supabase on every change (`app/[owner]/[show]/page.tsx:604`). Add one field:

```ts
notation?: 'numbers' | 'letters'; // show-level; undefined ⇒ 'letters' (default)
```

- A toggle in the perform toolbar flips it; it persists by the existing save path —
  sticky per show, across reloads and devices.
- New shows default to Letters; existing shows (field absent) resolve to Letters.

The roadmap chart loader picks the URL by the setting:
- `notation === 'letters'` **and** `chart.is_builder` → the letters endpoint URL.
- otherwise → today's direct numbers public URL.

**Owner-only, by decision.** `notation` is a shared show setting. As a config field it
flows through `updateConfig`, which refuses writes from read-only collaborators
(`isReadOnlyRef`, `page.tsx`) — so the **owner** sets notation and view-only band
members inherit it. That is the intended behavior: the toggle is disabled (not hidden)
for read-only viewers, matching every other config control on the page.

### 4. Non-builder charts

Uploaded PDFs/images have no `source_spec` to re-spell. The toggle is a **no-op** for
them — they render identically in both modes. The endpoint returns 422 for a
non-builder chart; the loader never routes a non-builder chart to it.

### 5. Builder authoring preview — unchanged

The builder keeps its own numbers/letters preview toggle (authoring aid). Charts are
still **authored and stored canonically in numbers** (`source_spec` is degrees); the
show setting only chooses which notation the *baked stage PDF* uses. The two toggles
are independent and don't need to agree.

---

## What this intentionally does NOT touch

- The pdf.js performance viewer, page rendering, or prefetch.
- `buildCalibration`, the section/seek/marker overlay, the held-band darkness read.
- The `source_spec` contract, the save RPC signature, or any migration.
- Uploaded/converted charts.

All of the above are mode-invariant, which is the whole reason A is cheap.

---

## Tests

- **T1 — letters PDF draws letters.** `renderRoadmap(spec, {notation:'letters'})` for
  a spec in F: degree 1 → `F`, degree 4 → `Bb`, a `♭7` → `Eb`; header contains the
  key, not "Nashville". Numbers path byte-identical to today (regression pin).
- **T2 — calibration is mode-invariant (load-bearing).**
  `buildCalibration(spec, layoutNumbers)` deep-equals `buildCalibration(spec, layoutLetters)`
  for a spec exercising sections, splits, held, voltas. (Trivially true because
  notation doesn't enter layout — the test *pins* that it stays that way.)
- **T3 — letters render is deterministic.** Same spec → byte-identical letters bytes
  on repeat → stable `-letters.pdf` hash. Self-comparison, not golden bytes.
- **T4 — lazy endpoint.** Miss → renders + uploads at `{H}-letters.pdf`, 302s to the
  public URL; hit → no re-render (upload not called). 422 for a non-builder chart.
- **T5 — show setting.** Absent field resolves to Letters; toggling persists through
  the existing save; a builder chart in Letters mode loads the endpoint URL, a
  non-builder chart never does.
- **T6 — spelling agreement.** The PDF letters label for a chord equals
  `renderCell(cell,'letters',key)` for the same cell — one seam, asserted, so preview
  and PDF can't drift.

---

## Resolved decisions

- **Setting scope:** owner-only shared show setting (config field), not a per-viewer
  preference. View-only collaborators inherit; the toggle is disabled for them.
- **Letters header:** `Key of {renderKey}` (e.g. `Key of F#`).
- **Materialization:** lazy only — uniform for legacy + new, never double-renders a
  chart no one views in letters. (Rejected: bake-both-at-save, which still needs the
  lazy endpoint as a legacy fallback — two mechanisms for one job.)

## Open questions for review

1. **Toolbar placement** — one global Numbers/Letters control in the perform toolbar
   (assumed, matches "per-show setting") vs a per-chart override. Assuming global.
2. **`cellFromBar` shape.** `drawBarContent` iterates the bar's chord objects; confirm
   they carry `{degree, alter, quality, bass}` in the shape `renderCell` expects, or
   add a thin adapter. (Numbers path reads exactly these fields today, so this is a
   packaging detail, not a data gap.)
