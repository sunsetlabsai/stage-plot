# ShowRunr — Roadmap Key Resolution (chunk 4: re-key) DESIGN

**Status:** DESIGN-ONLY. No build until Graham GO + Codex review.
Companion to `docs/design-roadmap-builder.md` (chunks 0–3 shipped to main `9902d08`).

---

## 1. The problem (the mismatch Graham hit)

A show can carry a **setlist-level key override** — "we're playing *About Damn Time*
in Bb tonight, not the library default G." Today that override lives on
`setlist_entries.key_override` and resolves through
`resolveOverride(key_override, song.key)` into `SetlistSong.key`
(`app/api/shows/[owner]/[show]/route.ts:39`). It is **displayed** next to the song.

But the **chart that gets served is a static artifact**. Show resolution fetches
charts by `(owner_id, song_key, role)` and hands back the stored PDF URL
(`route.ts:94–121`) — it **never reads `SetlistSong.key`**. So a builder chart
baked with `Key: G` in its header is served unchanged even when the setlist says
"Bb tonight." The displayed key and the chart's printed key **disagree** → a
mismatch gap, with no mechanism to reconcile them.

This is the gap Graham flagged: *"nice to have the setlist-level override, but
it's challenging if it doesn't in turn affect the displayed / cached-for-show
chart, which would leave a gap for mismatch."*

## 2. The NNS insight (why this dissolves, for builder charts)

A builder chart's **body is pure Nashville degree numbers** — key-invariant by
construction. `drawBarContent` prints `degree + quality + /bass` (e.g. `1`, `5`,
`6m`, `4/6`); `spec.renderKey` is printed **only** as a `Key:` header label
(`lib/roadmap-render.ts:365`). The chart body encodes **no key**.

Therefore, for a builder chart, **a key override is a relabel, not a transpose.**
The numbers don't move. There is no cached-chart drift to reconcile, because the
cached *body* never committed to a key in the first place. Only the printed `Key:`
label needs to follow the override.

This is exactly Graham's resolution: *"if left in NNS format for display, then
easy to overwrite show-level key as the chart itself would reference numbers."*

## 3. Three concepts to keep separate

Conflating these is what made the problem feel hard. They are distinct:

| Concept | What it is | Where it lives |
|---|---|---|
| **Authored key** (`renderKey`) | The chart's intrinsic/default key label | `RoadmapSpec.renderKey`, baked at build |
| **Show key intent** (`key_override`) | "Play it in X tonight" | `setlist_entries.key_override` per show-instance |
| **Display mode** (numbers vs letters) | Whether the *body* shows degrees or spelled chords | view-time choice (see §7) |

The **resolved display key** for a song instance is the existing three-state rule,
unchanged:

```
displayKey = resolveOverride(setlist.key_override, chart.authoredKey)
```

`null` → authored key · `''` → blank/unspecified · `'Bb'` → override.

## 4. Chart-type matrix — DO NOT over-promise

A song may have several role-charts, of mixed origin. Key-override fidelity is
**not uniform** across them, and the design must be honest about this:

| Chart type | Body | Key override is… |
|---|---|---|
| **Builder (NNS)** | degree numbers, key-invariant | **Honored** — relabel only, body unchanged |
| **Converter (PDF import, letter chords)** | pixels in a fixed key | **Advisory only** — the bytes cannot transpose |

For a converter chart, the override **informs the band** (the song header says
"Bb") but the imported chart still shows whatever key it was charted in. We MUST
NOT imply converter charts re-key. The NNS builder chart is the **only** type
where the override is faithfully reflected in the chart itself.

→ Consequence for UX: the **song-level** key (shown in the setlist) is one
consistent value (the resolved `displayKey`); per-chart fidelity varies by type.
A converter chart whose printed key ≠ `displayKey` should arguably carry a small
"charted in G" note so the disagreement is explicit rather than confusing
(open Q4).

## 5. The fork: where the key LABEL resolves

For builder charts the body is settled (numbers, baked once). The only open
question is **where the `Key:` label comes from at view time**. Three candidates:

### Option A — view-time chrome overlay (recommended for live/screen)
The chart body stays NNS, baked once at the authored key's hash-addressed PDF.
The **key label is resolved at view time** from `displayKey` and rendered in the
**app chrome** (the viewer header / Perform pill), *not* read off the PDF.

- **Pro:** zero re-render, zero new hash, instant re-key, trivially offline-safe
  (the cached PDF is key-stable; the label is data resolved from the cached
  setlist).
- **Con:** the PDF's own baked `Key:` header would now be a *second* label. Fix by
  **dropping the baked key from the builder PDF header** (or restyling it as
  "Nashville" / authored-key-in-parens) so chrome is the single source of the
  live key. A downloaded/printed raw PDF would then lack the show key (see B).

### Option B — re-render-on-demand, baked label (for print/download)
When `displayKey` differs from the authored key, **re-render** the PDF with the
new `renderKey` → new `source_hash` → stage a derived artifact, cached by
`(chart_id, render_key)`.

- **Pro:** the PDF is **self-contained** — correct key when printed, downloaded,
  or opened outside the app. Exactly one label, always in the bytes.
- **Con:** render + re-hash + stage per distinct key; a derived-cache lifecycle to
  manage; offline must fetch the *right* keyed artifact (distinct URL per key).

### Option C (rejected) — per-key duplicate charts in the library
Storing `Song in G` and `Song in Bb` as separate `chart_library` rows. Rejected in
the builder spec already (Codex R1) — it re-introduces the duplication NNS exists
to kill. Listed only to close it.

### Recommended: hybrid (A for live, B on demand)
- **Live / screen / Perform / conductor:** Option A. NNS body baked once; the key
  label is a **view-time overlay** from `displayKey`. Re-key is free, offline-safe.
  Drop the baked `Key:` from the builder PDF so chrome owns the live label.
- **Print / download "in key X":** an explicit user action triggers Option B — an
  on-demand re-render that **stamps** the resolved key into a self-contained PDF.
  This is a derived export, not a new library version (authored chart unchanged).

This gives the cheap, drift-free live path Graham wants **and** a correct
standalone artifact when someone actually prints, without baking a key into the
canonical chart.

## 6. Offline / Perform / conductor implications

- **Offline PWA cache** keys artifacts by storage URL. Option A keeps **one**
  key-stable URL per chart → the existing cache "just works"; the label rides on
  the already-cached setlist data. Option B would multiply URLs per key — a real
  cost the hybrid confines to the explicit-print path only.
- **Conductor authority** (live MD broadcast) consumes the *calibration* (bars /
  markers), which is **key-independent** — unaffected either way. Good: re-key
  never perturbs the geometry the conductor overlay rides on.
- **Calibration parity** (the save-route invariant): in Option A the calibration is
  untouched by re-key (label is chrome, not PDF) — no new parity surface. In
  Option B the re-render must preserve calibration exactly (the label is header-
  only, already proven non-perturbing by the artist-credit render test
  `tests/roadmap-render.test.ts:76`); the same guard covers it.

## 7. Letters display mode — explicitly DEFERRED

The mockup carried a **Numbers⇄Letters** toggle (`degreeLetter()`), where the body
re-spells degrees into actual chord letters for a chosen key. The **shipped
renderer draws numbers only.** That is deliberate and load-bearing here:

- In **Numbers** mode, key override is a pure relabel (§2) — the whole reason this
  problem dissolves.
- In **Letters** mode, the body *is* key-specific, so an override would re-spell
  every chord → reintroducing the transpose/re-render cost this design avoids.

So **Letters mode is the thing that brings back the hard version of the problem.**
It is a legitimate later enhancement, but it is **out of scope for chunk 4** and
should be designed on top of Option B (re-render-on-demand) when wanted, never as
a live-overlay. Keeping chunk 4 Numbers-native is what keeps re-key free.

## 8. Build sketch (chunk 4 — when GREEN to build)

1. **Drop the baked `Key:` from the builder PDF header** (or demote to a neutral
   "Nashville" tag) — make chrome the single live-key source (Option A).
2. **Resolve `displayKey` into the viewer/Perform chrome** from the already-
   resolved `SetlistSong.key` — pure UI wiring; the data is already on the wire
   (`route.ts:39`). For standalone (non-show) chart views, fall back to the
   chart's authored key.
3. **"Print / download in key X" action** → on-demand re-render (Option B) that
   stamps the resolved key; derived export, not a library write; reuses the
   existing `renderRoadmap` + calibration-parity guard.
4. Tests: relabel is body-invariant (numbers unchanged across keys); chrome shows
   `displayKey`; converter chart shows advisory not transpose; on-demand export
   stamps the right key and preserves calibration.

## 9. Open questions (for Graham / Codex)

1. **Drop vs demote the baked key.** Remove `Key:` from the builder PDF entirely
   (chrome owns it), or keep a small "Nashville / authored: G" tag for standalone
   legibility? (Lean: demote to a neutral tag so a raw PDF isn't keyless.)
2. **Print path now or later.** Ship chunk 4 as Option-A-only (live relabel) and
   defer the on-demand keyed export (Option B) to its own chunk? Or do both
   together? (Lean: A first — it closes the mismatch; B is additive.)
3. **Converter-chart honesty.** When `displayKey` ≠ a converter chart's charted
   key, show a "charted in G" note on that chart, or leave silent? (Lean: show it —
   silent disagreement is the very confusion we're removing for NNS.)
4. **Authored-key edit.** Should re-keying the *authored* default (not a show
   override) be an editor action on the chart itself, separate from the per-show
   override? (Probably yes, but it's a builder-editor concern, not show-resolution
   — flag for chunk 5 / edit loop, not here.)

## 10. Why this is the right shape

The mismatch was never a transposition problem — it was a **layering** problem:
the key was baked into a static artifact while the intent lived on the show. NNS
lets us **separate the invariant body (baked once) from the key label (resolved at
view time)**, so the override becomes a cheap relabel for the one chart type that
can honor it, and an honest advisory for the one that can't. No per-key
duplicates, no live re-render, no calibration churn — and a self-contained keyed
PDF only when a human actually asks to print one.
