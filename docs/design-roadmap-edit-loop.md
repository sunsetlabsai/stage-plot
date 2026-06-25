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
   file + calibration + `source_spec` atomically. **No save-route change needed.**
3. **Round-trip bridge.** `specToView` / `viewToSpec` (`lib/roadmap-view.ts`)
   round-trip the full structure — sections, repeat/volta, and navigation keyed by
   **stable section id** (so reorder/remove is safe; nav drops only when its target
   section is deleted). `renderKey` and `barsPerLine` carry through.

The renderer is deterministic, so **re-opening and saving an unedited chart
re-derives byte-identical PDF/calibration → same hash → an idempotent no-op
overwrite.** That property is the safety net under the whole loop.

## 4. The three gaps 5c fills

### 4.1 Re-open entry point (`ManageChartsModal`)
A builder chart row needs an **Edit** action (owner-only) that opens the spec
builder seeded with the saved spec. Gate it on the re-key contract already on the
wire: **`is_builder === true`** (`chart.is_builder`, surfaced chunk 4). For a
builder chart, the row reads **Preview · Edit · Replace · Delete**:
- **Edit** → opens `RoadmapBuilder` in Review with the loaded spec (this chunk).
- **Replace** → file upload as today (converts to a static import; the chunk-4 fix
  already clears `source_spec` on that path, so it cleanly stops being a builder
  chart).
- A non-builder (uploaded/converter) chart shows **no Edit** — it has no spec.

### 4.2 Source-spec read door (new GET)
The full `source_spec` is **server-only** today — the show/songs list routes
expose only `is_builder` + `authored_key` (deliberately; the whole spec would bloat
every list payload). Editing needs the spec on the client, fetched **lazily on
Edit click**:

```
GET /api/charts/roadmap/[chartId]   (authed owner only)
→ 200 { chart_id, role, song_title, song_key, source_spec }   // source_spec = RoadmapSpec
→ 404 if not found / not owned
→ 409 (or 422) if the row has no source_spec (not a builder chart)
```

Owner-gated: resolve `auth.getUser()`, then admin-read the `chart_library` row and
assert `owner_id === user.id` before returning the spec. (Read door only — the
write boundary stays the save route + service-role RPC.)

### 4.3 Builder seeding (open in Review, fixed role)
`RoadmapBuilder` gains an optional **edit mode**:

```ts
// new optional prop; absent = today's "author a new chart" flow
editChart?: { chartId: string; role: string; spec: RoadmapSpec };
```

When present, the builder:
- mounts **directly in Review** with `view = specToView(editChart.spec)` (skips
  Compose),
- **locks the role** to `editChart.role` (an edit is an overwrite of one chart,
  not a free-role pick — the save-time role selector is fixed/hidden),
- saves through the unchanged save route with that role → in-place replace.

`onSaved` folds the returned chart back into `ManageChartsModal`'s list exactly as
the create path does (carrying the chunk-4 `is_builder`/`authored_key` contract).

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
plain repeat, volta, full navigation, split bars, alters) asserting
`viewToSpec(specToView(spec))` deep-equals `spec`. This is the guard that makes
"open + save = no-op" true.

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
   `source_spec` + role + song_title (§4.2).
2. **Builder edit mode** — `RoadmapBuilder` optional `editChart` prop: mount in
   Review, seed `specToView`, lock role (§4.3). Thread `onSaved` as today.
3. **ManageChartsModal Edit affordance** — `is_builder`-gated row button that GETs
   the spec then opens the builder in edit mode (§4.1). Loading/error states.
4. **Round-trip golden test** (§6) — the fidelity guard.
5. **(Deferred, NOT 5c)** `source_prompt` column + save-body `prompt` + refine
   pre-fill (§7).

## 11. Open questions (for Graham / Codex)

1. **Edit vs Replace labeling.** For a builder chart, is the row **Preview · Edit ·
   Replace · Delete** (Edit = spec, Replace = file), or should "Replace" be reworded
   for builder charts (e.g. "Replace with file") to make the spec-vs-file distinction
   obvious? (Lean: keep Replace, add Edit; reword only if it tests confusingly.)
2. **Empty refine box on re-open.** Accept the v1 empty box (manual-default,
   regenerate opt-in), or is pre-filling the prompt important enough to pull the
   `source_prompt` follow-on (§7) into 5c? (Lean: ship v1; prompt persistence is a
   clean separate increment.)
3. **Authored-key edit surface (§8).** Does 5c need an explicit "change authored
   key" affordance, or does the existing Numbers⇄Letters key toggle (which already
   sets `renderKey`) suffice for now? (Lean: toggle suffices; revisit with chunk-4 Q5.)
4. **GET response status for non-builder id.** 409 vs 422 vs 404 when a chartId
   exists but carries no `source_spec`. (Minor; lean 422 — the row exists, it's just
   not editable-as-spec.)

## 12. Why this is the right shape

The artifact was always derivable from the spec — we just never built the door back
to the spec. Re-open turns the write-once `source_spec` into the editable source it
was designed to be, and because the save route is already a deterministic,
replace-by-role, born-verified re-render, the loop is mostly *wiring existing parts*
rather than new machinery. Scalpel and hammer share one door; the deterministic
render makes "open and save changed nothing" literally true; and prompt-persistence
waits in the wings as the next clean increment.
