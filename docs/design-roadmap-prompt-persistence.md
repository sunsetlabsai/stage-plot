# ShowRunr — Roadmap Builder: Persist the Prompt (PR B) DESIGN

**Status:** DESIGN-ONLY. No build until Graham GO + Codex review.
Promotes `docs/design-roadmap-edit-loop.md` **§7 ("v1 vs deferred — persist the
last-used prompt")** from deferred to a build. Companion to
`docs/design-roadmap-builder.md`.

---

## 1. The problem (Regenerate is dead on every saved chart)

We persist the **spec**, not the **prompt** that produced it. So when you Edit a
saved builder chart, the refine box opens **empty** (`RoadmapBuilder.tsx:136` —
`description` seeds to `''`) and Regenerate is disabled (`:474`, `:149` — guarded
on `!description.trim()`). You can only refine in the *session that created the
chart*; re-open it tomorrow and the AI refine surface is a no-op. The manual bar
editor is the only way back in.

`EditChart` carries `{ chartId, role, spec, updatedAt }` (`:114`) — no prompt. The
GET read door (`app/api/charts/roadmap/[chartId]/route.ts`) returns the spec and
slot identity, nothing about how it was authored.

## 2. The decision (the shape Graham ruled, 2026-08-29)

**Persist the last-used prompt; refine stays FULL-REPLACE.** Not refine-in-place.

- The stored prompt is a **re-prompt SEED**, not a live mirror of the spec. On
  re-open it **pre-fills** the refine box so Regenerate works again.
- Regenerate stays **dump-and-replace** (`generate(true)`, `:147`) behind the
  existing confirm — *"Regenerate will replace your manual edits. Continue?"*
  (`:150`). The prompt drives a whole-spec re-parse; hand-edits are discarded (and
  the user is warned).
- Divergence between the stored prompt and a hand-edited spec is **acknowledged,
  not auto-reconciled** (§5). The prompt answers *"what did I originally ask
  for,"* the spec is *"what the chart currently is."*
- **Refine-in-place** (targeted prompt-delta → spec diff, preserving hand-edits —
  the unbuilt `planChanges`, `[[project_showrunr_ai_edit_vs_create]]` §13) is the
  *next* increment. This PR is its **foundation**, not a detour (§10).

## 3. Storage — one nullable column + an RPC param

Follows the additive shape §7 named (`chart_library.source_prompt text`).

**Migration 016** (`supabase/migrations/016_builder_source_prompt.sql`):

1. `alter table chart_library add column source_prompt text;` — nullable, **null
   for every existing row** (no backfill, §6).
2. Redefine `save_builder_chart` to persist it. The current live signature is the
   **15-arg** form from migration 011 (13 base + the two stale-guard params). Adding
   an arg means CREATE OR REPLACE would make a second overload, so — **exactly as
   011 did** — `drop function if exists save_builder_chart(<15 types>)` first, then
   `create function …` with **`p_source_prompt text default null` appended last**
   (after `p_expected_updated_at`, preserving the defaulted-tail so any positional
   caller is safe; our route calls by name anyway).
   - `set search_path = public, extensions` (unchanged).
   - INSERT column list gains `source_prompt`; `on conflict … do update set
     source_prompt = excluded.source_prompt` (so an edit-save overwrites it).
   - **Grants (do NOT skip — `[[feedback_pg_function_grants]]`):** `revoke all …
     from public` and `from authenticated, anon`, then `grant execute … to
     service_role` on the **exact new 16-arg signature**. A revoke without the
     matching grant leaves the RPC unexecutable and every save fails closed.

**Why a column, not a field inside `source_spec`:** the prompt is **not** part of
`RoadmapSpec`. `validateRoadmapSpec` runs on both the save and read doors
(`save/route.ts:60`, `[chartId]/route.ts:49`) and the spec is re-rendered
server-side; smuggling a non-spec field into that JSON is a schema smell and would
have to be stripped before render/validate. A sibling nullable column mirrors how
`source_spec` itself was added (migration 009) and keeps the spec pure.

## 4. Data flow — five small touch points

1. **Save route** (`app/api/charts/roadmap/save/route.ts`): add
   `source_prompt?: unknown` to `PostBody`; read `body.source_prompt`, trim, pass
   `p_source_prompt: prompt || null` into the `save_builder_chart` rpc call
   (`:131`). Empty/absent → `null`.
2. **RPC** `save_builder_chart` — persists it (§3).
3. **Read door** (`app/api/charts/roadmap/[chartId]/route.ts`): add
   `source_prompt` to the `.select(...)` (`:32`) and return it in the JSON body
   (`:57`) as `source_prompt` (may be null).
4. **Builder** (`components/RoadmapBuilder.tsx`):
   - `EditChart` gains `sourcePrompt?: string` (`:114`).
   - Seed: `useState(editChart?.sourcePrompt ?? '')` (`:130`) — the refine box now
     opens **pre-filled** on a re-opened chart that has a stored prompt.
   - Review's Save body (`:405`) gains `source_prompt: description.trim() ||
     undefined`, so the current refine-box text is what persists.
   - **EditChart caller** (`components/ManageChartsModal.tsx:118`): thread
     `sourcePrompt: data.source_prompt` from the read-door response into the
     `EditChart` it builds.
5. **Upload/Replace path** (`app/api/charts/upload/route.ts:105`) — **the
   de-buildering writer, and the one Codex R1 caught this design missing.**
   Replacing a builder chart with an uploaded file already upserts
   `source_spec: null` to convert the row to an ordinary file chart; once
   `source_prompt` exists it must set `source_prompt: null` in that SAME upsert.
   Otherwise a non-builder file row **retains the old builder prompt**, violating
   the §5(d)/§6 "de-buildered row has a null prompt" invariant. A full-tree sweep
   for `source_spec` writes confirms this is the ONLY de-buildering writer — the
   save RPC (touch point 1) and this upsert are the only two writers of
   `source_spec`; `[chartId]:63` is the read-door response, not a write.

That is the whole surface: 1 migration, 5 edits. No new endpoint, no new component.

## 5. The divergence model (the core of the design)

Four states; each is ruled, not left implicit:

- **(a) Fresh build.** Prompt = what you composed → Generate → (maybe hand-edit) →
  Save. Stored prompt = the compose text. Consistent by construction.
- **(b) Re-open → hand-edit the spec → Save (no Regenerate).** The stored prompt is
  written back **unchanged** (still the original); the spec now differs from it.
  **By design.** The refine box shows the original prompt; hitting Regenerate
  re-derives from it and discards the hand-edits (confirm warns, `:150`). The
  prompt is provenance, not a mirror.
- **(c) Re-open → edit the prompt text → Save WITHOUT Regenerate.** **Ruled
  (Graham, 2026-08-29): persist the box VERBATIM.** The prompt is a seed for *next*
  time — a jotted *"make the bridge 8 bars"* saved for a later regenerate is a
  feature, not a bug. The stricter alternative (store only the prompt that *last
  generated* the spec) was considered and rejected: it throws away a deliberate
  edit and needs extra tracked state. So Save always writes the current refine-box
  text (`description.trim() || null`), full stop.
- **(d) Legacy / non-builder-authored (`source_prompt` null).** Box seeds empty;
  Regenerate stays opt-in and dead until you type — **identical to today's v1**.
  No backfill (§6). This state is REACHED, not just initial: a Replace-with-file
  de-builders the row and MUST null the prompt with the spec (§4 touch point 5),
  or a file row keeps a stale prompt.

**Honesty requirement:** no copy may imply the prompt reflects hand-edits. The
current refine-rail copy (`:463`, *"Adjust the description and regenerate, or tweak
the structure … "*) and the regenerate confirm together already say the right
thing. Keep both; add nothing that claims the prompt tracks the chart.

## 6. No backfill

Existing rows get `source_prompt = null`; their refine box opens empty on re-open —
**bit-for-bit today's behavior**. A prompt is written only when a future save
carries one. Same posture as the rest of the builder (hash-addressed re-render on
next save; nothing rewritten in place).

## 7. Determinism / parity — untouched

`source_prompt` is metadata: never rendered, never hashed, **not part of the
spec**. It does not enter `renderRoadmap`, the PDF bytes, the `source_hash`, or the
calibration. The spec↔calibration parity gate (`save/route.ts:100`) and the
`specToView → viewToSpec` round-trip invariant (edit-loop §6) are entirely
unaffected. This PR cannot change any existing chart's rendered output.

## 8. Security / RBAC — the read boundary, stated precisely (Codex R1)

- **The API EDIT door is owner-only** (`[chartId]/route.ts:37` asserts
  `owner_id === user.id` via the admin client, NOT via RLS, precisely because an
  edit door is the owner's alone). But that is the door, not the table.
- **The TABLE is NOT owner-only.** `chart_library` carries a `"Collaborator read
  charts"` RLS policy (migration `003:47-56`) that grants a collaborator SELECT on
  the owner's **entire library** — every row, and RLS grants **all columns** — for
  any owner whose show they collaborate on. So a collaborator with a Supabase
  session can already directly read **`source_spec`** for the whole library today.
  (The `014` comment calling `chart_library` "owner-only from the start" is
  **wrong** — the collaborator SELECT policy has been there since `003`. Worth a
  one-line doc fix in `[chartId]/route.ts`/`014` but out of scope here.)
- **`source_prompt` inherits that exact exposure — and that is ACCEPTABLE.** It is
  strictly LESS information than the `source_spec` a collaborator can already read
  (the prompt is the input that produced the spec), and under Graham's ruled
  security scope *"the only thing I care about is protecting people's BYOA agent
  key; the rest is not sensitive"* a song-structure prompt is not sensitive. So we
  put it on `chart_library` beside `source_spec` — **NOT** a separate owner-only
  table or column privilege. **This design deliberately accepts collaborator-
  readable prompt text.**
- The prompt is **arbitrary user text**: stored as `text`, passed as a **bind
  param** to the RPC, never concatenated into SQL, never executed. It already flows
  to `/api/charts/roadmap/parse` (which consumes `description`), so no new trust
  surface.
- RPC ownership boundary preserved: `save_builder_chart` stays `service_role`-only,
  called by the route which is the ownership boundary (§3 grants).

## 9. Testing (Claude authors)

- **Read door:** returns `source_prompt` when present, and `null`/absent for a
  legacy row.
- **Save route:** mock `admin.rpc`; assert `p_source_prompt` receives the trimmed
  prompt, and `null` when the body omits it or sends whitespace.
- **Builder (jsdom):** `EditChart.sourcePrompt` set → refine box pre-filled →
  Regenerate **enabled**; `EditChart` without it → box empty → Regenerate
  **disabled** (the preserved legacy path). Review Save sends
  `source_prompt = <current box text>`.
- **Upload/Replace clears the prompt:** replacing a builder chart (that has a
  stored `source_prompt`) with a file leaves the row with `source_prompt = null`
  alongside `source_spec = null` — the de-buildering invariant (§4 touch point 5).
- **Migration:** verify via psql (show Graham the DDL first — `[[feedback_never_push_main]]`
  DDL discipline) that the column exists and the **new 16-arg signature is
  `service_role`-executable** (`has_function_privilege`, per the STATE verify
  recipe), plus a round-trip: save with a prompt → read door returns it.
- Existing suite unaffected (no behavior change for charts without a stored prompt).

## 10. Why this is the refine-in-place foundation, not a detour

`planChanges` (refine-in-place) needs the **prompt that generated the current
spec** to compute a prompt-delta and apply a *targeted* spec diff that preserves
hand-edits. Persisting `source_prompt` now **is** that substrate — when
refine-in-place lands it reads `source_prompt` + `source_spec`, plans, and edits in
place, with **no schema change**. If we later adopt decision (c-ii) (store only the
prompt that last generated the spec), that is a semantics refinement on the same
column, still no migration.

## 11. Out of scope

- **Refine-in-place / `planChanges`** — the LLM edit-planning step (future PR).
- **Preview held-diamond parity** — a separate follow-up from the rhythm-slashes
  PR, not this one.
- **Backfilling prompts** for legacy charts — there is no source to recover.

## 12. Build size

1 migration (016) + 5 edits (save route, RPC, read door, builder + its
`ManageChartsModal` caller, and the upload/Replace null-out) + tests. Additive and
low-risk; mirrors the edit-loop's own shape.
