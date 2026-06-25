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

## 3. Four concepts to keep separate

Conflating these is what made the problem feel hard — and it hides a real
non-equivalence (§3.1) an earlier draft got wrong. They are distinct:

| Concept | What it is | Where it lives |
|---|---|---|
| **Library default key** (`songs.key`) | The song's default key in the owner's library | `songs.key` |
| **Chart authored key** (`renderKey`) | The key a builder chart's header was authored in | `source_spec.renderKey`, baked at build |
| **Show key intent** (`key_override`) | "Play it in X tonight" | `setlist_entries.key_override` per show-instance |
| **Display mode** (numbers vs letters) | Whether the *body* shows degrees or spelled chords | view-time choice (see §8) |

### 3.1 The resolution chain (corrected — do NOT collapse `songs.key` into `renderKey`)

The **resolved key for a song instance** is the EXISTING three-state rule,
unchanged, and it falls back to the **library default**, not the chart's authored
key (`app/api/shows/[owner]/[show]/route.ts:39`):

```
songKey = resolveOverride(setlist.key_override, songs.key)
```

`null` → library default · `''` → blank/unspecified · `'Bb'` → override.

A builder chart **relabels to `songKey`** — the song-instance's resolved key —
**regardless of its own authored `renderKey`.** The authored key is a SEPARATE,
informational value: it records what the body's degree spelling was authored
against, and is used only to (a) label a STANDALONE chart view where there is no
song/show context, and (b) DETECT disagreement (authored G, playing Bb) to
surface honestly instead of silently.

`songs.key` and `source_spec.renderKey` are NOT guaranteed equal today — builder
save does not write `songs.key` from `renderKey`. Treating them as one (as the
first draft did) would silently change what a `null` override means: it currently
means "use the library song key," not "use this chart's authored key." They stay
independent; see §3.2.

### 3.2 Invariant / migration decision (OPEN — Q1)

Two coherent stances; pick one before build:

- **(i) Keep independent (lean).** `songs.key` is the library default the setlist
  resolves against; `renderKey` is the chart's authored spelling. The live key is
  always `songKey`; a builder chart shows it and, if `renderKey ≠ songKey`, notes
  "authored in {renderKey}". No migration, no coupling.
- **(ii) Couple on save.** Builder save sets `songs.key = renderKey` **only when
  the song has no key yet** (never overwrites an existing library key). Reduces the
  common divergence, but needs a one-time backfill stance for existing builder
  charts and an explicit rule for the overwrite conflict. Additive, more moving
  parts.

Either way the resolution chain above is the contract; (ii) only changes how often
the fallback and the authored key coincide.

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
consistent value (the resolved `songKey`); per-chart fidelity varies by type.
A converter chart whose printed key ≠ `songKey` should arguably carry a small
"charted in G" note so the disagreement is explicit rather than confusing
(open Q4).

## 5. The fork: where the key LABEL resolves

For builder charts the body is settled (numbers, baked once). The only open
question is **where the `Key:` label comes from at view time**. Three candidates:

### Option A — view-time chrome overlay (recommended for live/screen)
The chart body stays NNS, baked once at the authored key's hash-addressed PDF.
The **key label is resolved at view time** from `songKey` and rendered in the
**app chrome** (the viewer header / Perform pill), *not* read off the PDF.

- **Pro:** zero re-render, zero new hash, instant re-key, trivially offline-safe
  (the cached PDF is key-stable; the label is data resolved from the cached
  setlist).
- **Con:** the PDF's own baked `Key:` header would now be a *second* label. Fix by
  **dropping the baked key from the builder PDF header** (or restyling it as
  "Nashville" / authored-key-in-parens) so chrome is the single source of the
  live key. A downloaded/printed raw PDF would then lack the show key (see B).

### Option B — re-render-on-demand, baked label (for print/download)
When `songKey` differs from the authored key, **re-render** the PDF with the
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
  label is a **view-time overlay** from `songKey`. Re-key is free, offline-safe.
  Drop the baked `Key:` from the builder PDF so chrome owns the live label.
- **Print / download "in key X":** an explicit user action triggers Option B — an
  on-demand re-render that **stamps** the resolved key into a self-contained PDF.
  This is a derived export, not a new library version (authored chart unchanged).

This gives the cheap, drift-free live path Graham wants **and** a correct
standalone artifact when someone actually prints, without baking a key into the
canonical chart.

## 6. Data contract — surface the metadata the model needs

The build sketch above assumes chart payloads carry builder-vs-converter origin
and an authored key. **They do not today.** Chart payloads select only file
metadata: show resolution at `app/api/shows/[owner]/[show]/route.ts:101`
(id/role/file_name/mime/size/url) and the library list at
`app/api/songs/route.ts:58` do the same, and the builder save response / local
`Chart` shape (`components/RoadmapBuilder.tsx:300`) carries neither `is_builder`
nor an authored key. Chunk 4 must **first extend the public chart contract**:

| Field | Type | Source | Meaning |
|---|---|---|---|
| `is_builder` | `boolean` | `source_spec IS NOT NULL` (already the Codex-R2 signal) | builder (NNS) vs imported |
| `authored_key` | `string \| null` | `source_spec.renderKey`; `null` for imports | builder chart's authored spelling (§3, informational) |
| `charted_key` | `string \| null` | `null` for now (no import metadata exists) | converter chart's printed key, when we can know it (Q3) |

Notes:
- `is_builder` is already defined as a safe boolean elsewhere (builder spec Codex
  R2 LOW). This formalizes it on the **show** and **library** chart payloads, not
  just the edit route.
- `authored_key` is read straight off the stored `source_spec` (owner-readable;
  the full spec already round-trips for builder edit). It is **informational** —
  the live label is `songKey` (§3.1), never `authored_key`.
- `charted_key` is `null` until import-time key capture exists; the converter
  "charted in G" note (§4, Q3) is **blocked on this field** and stays deferred
  until it does. Shipping `charted_key: null` now reserves the shape without
  promising data we don't have.

These three fields are the **only** new public surface chunk 4 needs for the live
(Option A) path. Option B adds an export contract (§6.1).

### 6.1 Derived-export contract for Option B (only if chunk 4 ships print/download)

If the on-demand keyed export lands in chunk 4 (Q2), it needs a concrete contract,
not hand-waving:

- **Route:** `POST /api/charts/roadmap/export` — authed **owner only** (re-uses the
  ownership boundary; never trusts a client spec, re-loads `source_spec` by
  chart id + owner like the save route).
- **Input:** `{ chart_id, render_key }`. Server re-validates `render_key`, loads the
  owner's stored `source_spec`, re-renders with `renderKey := render_key`.
- **Storage:** derived, hash-addressed, **namespaced apart from canonical charts**
  — e.g. `${owner}/${song_key}/${role}/export/${render_key}-${source_hash}.pdf`.
  NOT a `chart_library` row; this is an export artifact, not a library version.
- **Cache key:** `(chart_id, render_key, source_hash)` → the hash-addressed
  object, where `source_hash` is the canonical chart's current `source_spec` hash.
  Including `source_hash` is **load-bearing** (Codex GO caveat): keyed only by
  `(chart_id, render_key)`, an edit to the builder chart would silently reuse a
  **stale** keyed export. With the source hash in the key, an edited `source_spec`
  produces a new export object and the old one falls to GC; equivalently, the
  export cache is **invalidated whenever `source_spec` changes**. Idempotent
  upsert; a repeat export of the same chart+key against the unchanged source
  reuses the object.
- **Calibration:** **ephemeral** — re-rendered for the parity guard
  (`assertSpecCalibrationParity`, label is header-only and proven non-perturbing,
  `tests/roadmap-render.test.ts:76`) but **not persisted**. The canonical chart's
  calibration is the source of truth; an export carries none.
- **GC:** export objects are unreferenced by any DB row → swept by the same
  orphan-GC stance the save route already relies on (content-addressed, safe to
  leave, reclaimed later). No live-state risk.

If Option B is deferred (Q2 lean = defer), this whole subsection is the spec for
that follow-on chunk and chunk 4 ships Option A only.

## 7. Offline / Perform / conductor implications

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

## 8. Letters display mode — explicitly DEFERRED

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

## 9. Build sketch (chunk 4 — when GREEN to build)

1. **Extend the chart contract (§6)** — add `is_builder` + `authored_key`
   (+ `charted_key: null`) to the show and library chart payloads. Nothing
   downstream can be honest about origin/authored-key until these exist.
2. **Drop the baked `Key:` from the builder PDF header** (or demote to a neutral
   "Nashville" tag, Q4) — make chrome the single live-key source (Option A).
3. **Resolve `songKey` into the viewer/Perform chrome** from the already-resolved
   `SetlistSong.key` — pure UI wiring; the data is already on the wire
   (`route.ts:39`). For a STANDALONE (non-show) chart view there is no `songKey`,
   so fall back to the chart's `authored_key`.
4. **(Q3, optional) Disagreement note** — when `authored_key` (or, later,
   `charted_key`) ≠ `songKey`, surface "authored in {key}" so the divergence is
   explicit, not silent.
5. **(Q2, optional) "Print / download in key X"** → on-demand re-render via the
   §6.1 export contract; derived export, not a library write; reuses
   `renderRoadmap` + the calibration-parity guard.
6. Tests: relabel is body-invariant (numbers unchanged across keys); contract
   exposes `is_builder`/`authored_key`; chrome shows `songKey`, falls back to
   `authored_key` standalone; converter chart shows advisory not transpose;
   on-demand export stamps the right key and preserves calibration.

## 10. Open questions (for Graham / Codex)

1. **Invariant / migration (§3.2).** Keep `songs.key` and `source_spec.renderKey`
   **independent** (i — lean), or **couple on save** (ii — builder save sets
   `songs.key = renderKey` only when the song has no key)? This is the load-bearing
   call; it decides what a `null` override means and whether a backfill is needed.
2. **Print path now or later.** Ship chunk 4 as Option-A-only (live relabel) and
   defer the on-demand keyed export (Option B / §6.1) to its own chunk? Or do both
   together? (Lean: A first — it closes the mismatch; B is additive.)
3. **Converter-chart honesty.** Show a "charted in {key}" note when a converter
   chart's key ≠ `songKey`? **Blocked on `charted_key`** — imports carry no key
   metadata today (§6), so this stays deferred until that capture exists. (Lean:
   show it once we can; silent disagreement is the confusion we're removing.)
4. **Drop vs demote the baked key.** Remove `Key:` from the builder PDF entirely
   (chrome owns it), or keep a small neutral "Nashville / authored: {key}" tag for
   standalone legibility? (Lean: demote so a raw PDF isn't keyless.)
5. **Authored-key edit.** Should re-keying the *authored* default (not a show
   override) be an editor action on the chart itself, separate from the per-show
   override? (Probably yes, but that's a builder-editor concern — flag for chunk 5
   / edit loop, not here.)

## 11. Why this is the right shape

The mismatch was never a transposition problem — it was a **layering** problem:
the key was baked into a static artifact while the intent lived on the show. NNS
lets us **separate the invariant body (baked once) from the key label (resolved at
view time)**, so the override becomes a cheap relabel for the one chart type that
can honor it, and an honest advisory for the one that can't. No per-key
duplicates, no live re-render, no calibration churn — and a self-contained keyed
PDF only when a human actually asks to print one.
