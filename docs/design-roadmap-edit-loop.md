# ShowRunr — Roadmap Builder Edit Loop (chunk 5 / "5c regenerate") DESIGN

**Status:** DESIGN-ONLY. No build until Graham GO + Codex review.
Companion to `docs/design-roadmap-builder.md` (chunks 0–4 shipped; re-key chunk 4
merged main `8404b81`). This is chunk 5 of that doc's build sequence ("Edit loop:
re-open spec from a saved builder chart → re-render → replace").

---

## 1. The problem (a saved builder chart is a dead end)

The builder authors **new** charts: `ManageChartsModal` shows "Build a chart with
AI" only when a role is **free** (`free.length > 0`), and it opens an empty
Compose screen. Once a builder chart is saved into a role, there is **no way back
into its spec**. The only owner actions on a filled role are **Preview**,
**Replace** (file upload — converts it to a static import), and **Delete**.

So the moment you want to *revise* a builder chart — fix a wrong bar count, add a
section, change a chord, or re-derive the whole thing from a better description —
your only option is to delete it and start over, re-typing the entire song from
scratch. The authored `source_spec` we carefully persist is **write-once**.

This is the gap chunk 5 closes: make a builder chart **re-editable** — the
property the builder design doc promised (§"Re-editable: re-open the spec, tweak,
re-render").

## 2. Two mechanisms — scalpel and hammer (Graham's framing)

A revision is either a **local fix** or a **broad redo**, and forcing both
through one tool makes both worse:

- **Manual edit (scalpel).** Re-open the saved spec into the Review editor and
  hand-tweak — a section's bars, a single bar's chords, the key, structure CRUD.
  For incremental fixes. *This is the existing Review editor, pointed at a saved
  chart instead of a freshly-parsed one.*
- **Regenerate (hammer) — DUMP-AND-REPLACE.** Re-derive the **entire** spec from
  a fresh natural-language description via the L1/L2 parse pipeline, replacing the
  spec wholesale. For broad changes where editing bar-by-bar is the wrong tool.
  *This is the existing in-session Regenerate, made reachable for a saved chart.*

**5c is the regenerate path** (Graham's named deliverable). But the two share one
prerequisite — *re-opening a saved chart into Review* — and once that exists, the
manual scalpel comes **for free** (the Review editor already edits the `ViewModel`
and saves through the same route). So this chunk delivers the whole edit loop;
regenerate is the headline because it's the mechanism that was missing a home.

## 3. What already exists (do NOT rebuild)

The edit loop is mostly assembled — three load-bearing pieces are already live:

1. **In-session Regenerate.** `RoadmapBuilder.generate(true)`
   (`components/RoadmapBuilder.tsx:63`) already re-runs the parse route and
   `setView(specToView(spec))` — a whole-spec replace — behind a confirm
   ("Regenerate will replace your manual edits. Continue?"). The Review pane's
   left "refine" rail already hosts the description box + Regenerate button.
2. **Save is already replace-by-role.** `POST /api/charts/roadmap/save` →
   `save_builder_chart` RPC upserts on `(owner, song_key, role)` and returns
   `old_storage_path` so the previous hash-addressed PDF is reclaimed
   (`route.ts:152–158`). Saving an edited chart to the **same role** overwrites
   file + calibration + `source_spec` atomically. The replace-by-role mechanism
   is unchanged — but the **edit path** adds one thing the create path never
   needed: an optimistic-concurrency precondition, so a stale edit can't clobber a
   slot that changed underneath it (§4.4). This is the one save-side change 5c
   makes; the create path is untouched.
3. **Round-trip bridge.** `specToView` / `viewToSpec` (`lib/roadmap-view.ts`)
   round-trip the full structure — sections, repeat/volta, and navigation keyed by
   **stable section id** (so reorder/remove is safe; nav drops only when its target
   section is deleted). `renderKey` and `barsPerLine` carry through.

The renderer is deterministic, so **re-opening and saving an unedited chart with
unchanged render metadata re-derives byte-identical PDF/calibration → same hash →
an idempotent no-op overwrite.** The narrowing matters: *render metadata* = song
title + artist, read from the `songs` row at save time (`route.ts:76–85`), not from
the spec. If the title/artist changed since the chart was built, the music-body
geometry/calibration stays stable but the header re-renders to a **new hash** —
still correct, just not byte-identical. So the precise claim is *same spec + same
render metadata = idempotent*; spec-level geometry is always stable. That
determinism is the safety net under the whole loop.

## 4. The four gaps 5c fills

### 4.1 Re-open entry point (`ManageChartsModal`)
A builder chart row needs an **Edit** action (owner-only) that opens the spec
builder seeded with the saved spec. Gate it on the re-key contract already on the
wire: **`is_builder === true`** (`chart.is_builder`, surfaced chunk 4). For a
builder chart, the row reads **Preview · Edit · Replace with file · Delete**:
- **Edit** → opens `RoadmapBuilder` in Review with the loaded spec (this chunk).
- **Replace with file** → file upload as today (converts to a static import; the
  chunk-4 fix already clears `source_spec` on that path, so it cleanly stops being a
  builder chart). Reworded from plain "Replace" on builder rows to make the
  spec-vs-file distinction obvious next to **Edit** (§11 Q1).
- A non-builder (uploaded/converter) chart shows **no Edit** — it has no spec.

### 4.2 Source-spec read door (new GET)
The full `source_spec` is **server-only** today — the show/songs list routes
expose only `is_builder` + `authored_key` (deliberately; the whole spec would bloat
every list payload). Editing needs the spec on the client, fetched **lazily on
Edit click**:

```
GET /api/charts/roadmap/[chartId]   (authed owner only)
→ 200 { chart_id, role, song_title, song_key, updated_at, source_spec }  // source_spec = RoadmapSpec
→ 404 if not found / not owned
→ 422 if the row has no source_spec (not a builder chart) OR source_spec
       fails validateRoadmapSpec (corrupt / hand-edited DB state)
```

Owner-gated: resolve `auth.getUser()`, then admin-read the `chart_library` row and
assert `owner_id === user.id` before returning the spec. (Read door only — the
write boundary stays the save route + service-role RPC.) Two extras the door
carries for 5c's correctness:
- **`updated_at`** — the optimistic-lock token the edit save replays as a
  precondition (§4.4). The client never interprets it; it only round-trips it.
- **Validate before returning.** Run `source_spec` through `validateRoadmapSpec`
  (the same gate the save route uses server-side) and **422** on a missing or
  malformed spec, rather than handing a bad shape to the client. Corrupt DB state
  fails clean at the read door instead of crashing `specToView` downstream.

### 4.3 Builder seeding (open in Review, fixed role)
`RoadmapBuilder` gains an optional **edit mode**:

```ts
// new optional prop; absent = today's "author a new chart" flow
editChart?: { chartId: string; role: string; spec: RoadmapSpec; updatedAt: string };
```

When present, the builder:
- mounts **directly in Review** with `view = specToView(editChart.spec)` (skips
  Compose),
- **locks the role** to `editChart.role` (an edit is an overwrite of one chart,
  not a free-role pick — the save-time role selector is fixed/hidden),
- saves through the save route with that role → in-place replace, **threading
  `chartId` + `updatedAt` as the stale-edit precondition** (§4.4).

`onSaved` folds the returned chart back into `ManageChartsModal`'s list exactly as
the create path does (carrying the chunk-4 `is_builder`/`authored_key` contract).

### 4.4 Stale-edit guard (the one save-side change)
Today's save commits by `(owner, song_key, role)` with **no precondition on which
chart currently holds that slot** (`save_builder_chart`, `route.ts:121`). For the
**create** flow that's correct — a free role has nothing to clobber. But an **edit**
loads chart X from a slot, then saves it back, and the save has no idea the slot may
have changed in between. The dangerous interleave:

1. Owner opens **Edit** on a builder chart (loads its spec + `updated_at`).
2. In another tab (or by another session) **Replace with file** lands on the same
   slot — chunk 4 correctly clears `source_spec`, de-buildering it.
3. The first tab hits **Save**. With no precondition, the stale edit re-upserts
   `source_spec` into the slot — **silently re-buildering the chart the user just
   converted to a file.** This violates §4.1's "Replace cleanly de-builders" promise.

**Fix — optimistic concurrency on the edit path only:**
- The save body gains two **optional** fields, sent only by the edit flow:
  `expected_chart_id` and `expected_updated_at` (the values the GET door returned).
- `save_builder_chart` gains matching optional params. When present, it asserts —
  inside the same atomic commit, before the upsert — that the current row at
  `(owner, song_key, role)` still has `id = expected_chart_id` **and**
  `updated_at = expected_updated_at`. On mismatch it raises a conflict the route
  maps to **409 Conflict** ("this chart changed since you opened it — reload").
- When absent (the create flow), behaviour is **exactly today's** — no precondition.

Why `updated_at` and not `chart_id` alone: Replace-with-file upserts **in place**,
keeping the same row `id` while nulling `source_spec`. So `chart_id` would still
match — only the `updated_at` bump (any write touches it) catches the change. The
pair together is the precise guard: same row, untouched since load.

## 5. The regenerate flow (5c, the hammer)

Inside Review (whether opened fresh or via Edit), the left refine rail is the
dump-and-replace surface:

1. Type a fresh description of the song (the refine box).
2. Hit **Regenerate** → `generate(true)`: parse route (L1/L2) → validate →
   `setView(specToView(newSpec))`. The **entire** view is replaced (the confirm
   guards manual edits, exactly as today).
3. Review the result; Save → in-place replace of the same role.

**Re-open + regenerate interaction (v1):** when you Edit a saved chart, the refine
box opens **empty** — we persist the *spec*, not the *prompt* that produced it
(§7). So on a re-opened chart, the **manual editor is the default** and Regenerate
is opt-in: it stays a no-op until you type a description, then it dump-replaces.
This is the honest v1 — "dump-and-replace" literally means "describe it again."

## 6. Round-trip fidelity (the risk to verify)

The load-bearing correctness claim: **`specToView` → `viewToSpec` is identity** for
any spec the builder can produce, so opening a chart and saving it without edits
never silently mutates it. Two known, accepted edges to pin (not regressions):

- **`held` chords.** Carried through `spec → view` but **not expressible in the
  per-beat text grammar**, so manually *re-typing* a held bar loses `held`. Opening
  and saving *without touching that bar* preserves it (the cell survives untouched).
  Regenerate is unaffected (held comes fresh from L2). Document; don't fix here.
- **Navigation drop-on-removed-section.** `viewToSpec` intentionally drops the nav
  block if a referenced section was deleted (id stops resolving) — correct, not a
  fidelity bug.

**Test requirement:** a golden round-trip test over representative specs (linear,
plain repeat, volta, full navigation, split bars, alters, **held chords, and a
non-default `barsPerLine`**) asserting `viewToSpec(specToView(spec))` deep-equals
`spec`. `held` and `barsPerLine` both ride the ViewModel and are part of the no-op
reopen claim, so they belong in the golden set explicitly — `held` to pin the
spec→view→spec survival (distinct from the manual-retype loss in the first bullet),
`barsPerLine` because it carries through and a regression would silently re-flow the
chart on save. This is the guard that makes "open + save = no-op" true.

## 7. v1 vs deferred — persist the last-used prompt

**v1:** no stored prompt. The refine box is empty on re-open; a regenerate means
re-describing the song. The spec is the source of truth; the manual editor covers
"I just want to nudge it."

**Deferred follow-on (Graham's idea):** persist the **last-used description**
alongside the chart (`chart_library.source_prompt text`, written by the save route
from a new `prompt` field on the save body) so a re-opened chart **pre-fills the
refine box** with the prompt that built it. Then regenerate becomes *"edit the
prompt, not the spec"* — change a clause and re-derive. This is additive (nullable
column, empty for existing charts) and explicitly **out of scope for 5c** — it's
the natural next increment once the loop exists.

## 8. Re-key interplay (clean by construction)

Editing re-runs the render with the spec's current `renderKey`, so `source_spec`
(and thus the chunk-4 `authored_key = source_spec.renderKey` the chrome reads) stays
correct automatically. Changing the **authored key** inside the editor (the
Numbers⇄Letters key toggle) is a legitimate edit that updates `renderKey` and
re-renders — distinct from the per-show live override (chunk 4), which never
touches the artifact. Both coexist: the chart carries an authored key; a show may
relabel it live. (Chunk-4 open Q5 — an authored-key editor — is partly satisfied
here: editing a chart *can* change its authored key. Flag for Graham whether 5c
should surface that explicitly or leave it to the existing key toggle.)

## 9. UX flow (no dead ends)

- **Entry:** Edit on any builder-chart row (owner). Non-builder rows have no Edit.
- **Edit → Review:** lands on the chart, ready to manually edit OR regenerate.
- **Regenerate:** warns before replacing manual edits; result is reviewable before
  Save; Cancel/close returns to ManageChartsModal with nothing changed.
- **Save:** in-place replace of the same role; list refreshes; preview re-renders.
- **Escape hatches:** close without saving = no change; Delete still available on
  the row; Replace-with-file still available (and now cleanly de-builders the slot).

## 10. Build sketch (when GREEN to build)

1. **GET route** `app/api/charts/roadmap/[chartId]/route.ts` — owner-gated read of
   `source_spec` + role + song_title + `updated_at`; `validateRoadmapSpec` →
   **422** on missing/corrupt spec (§4.2).
2. **Save-path precondition** — save body gains optional `expected_chart_id` +
   `expected_updated_at`; `save_builder_chart` RPC asserts the current slot row
   still matches before the upsert, raising a conflict the route maps to **409**
   (§4.4). Create path passes them null → behaviour unchanged. (Migration: the RPC
   signature changes — add the two nullable params with a no-op default so existing
   create callers are untouched.)
3. **Builder edit mode** — `RoadmapBuilder` optional `editChart` prop
   `{chartId, role, spec, updatedAt}`: mount in Review, seed `specToView`, lock
   role, thread the precondition into save (§4.3). `onSaved` as today.
4. **ManageChartsModal Edit affordance** — `is_builder`-gated row button that GETs
   the spec then opens the builder in edit mode (§4.1). Loading/error states,
   including a 409-on-save "reload, this chart changed" path.
5. **Round-trip golden test** (§6) — the fidelity guard, incl. `held` +
   `barsPerLine`.
6. **(Deferred, NOT 5c)** `source_prompt` column + save-body `prompt` + refine
   pre-fill (§7).

## 11. Resolved decisions (Graham + Codex R1)

1. **Edit vs Replace labeling — RESOLVED.** Keep both actions; **reword "Replace" →
   "Replace with file"** on builder rows so Edit (= spec) vs Replace-with-file
   (= static import) reads unambiguously (§4.1).
2. **Empty refine box on re-open — RESOLVED: ship v1.** Manual-editor default,
   regenerate opt-in, empty refine box. Prompt persistence (`source_prompt`, §7) is
   the clean separate follow-on, not pulled into 5c.
3. **Authored-key edit surface (§8) — RESOLVED.** The existing Numbers⇄Letters key
   toggle (which already sets `renderKey`) suffices; no separate "change authored
   key" affordance in 5c.
4. **GET status for non-builder/corrupt id — RESOLVED: 422.** The row exists, it's
   just not editable-as-spec (or its spec is corrupt). 404 would lie about
   existence; 409 implies a state conflict that isn't happening (§4.2).

(Codex R1 blocking gap — the stale-edit guard — is folded as **§4.4**; the
idempotency claim narrowed in §3/§6; the golden set widened to `held` +
`barsPerLine` in §6; the read door now validates `source_spec` before returning, §4.2.)

## 12. Why this is the right shape

The artifact was always derivable from the spec — we just never built the door back
to the spec. Re-open turns the write-once `source_spec` into the editable source it
was designed to be, and because the save route is already a deterministic,
replace-by-role, born-verified re-render, the loop is mostly *wiring existing parts*
rather than new machinery. Scalpel and hammer share one door; the deterministic
render makes "open and save changed nothing" literally true; and prompt-persistence
waits in the wings as the next clean increment.
