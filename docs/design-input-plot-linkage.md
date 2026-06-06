# Design: Input List / Stage Plot / Mix Linkage

**Status:** Proposed (v6) — ready for adversarial review (Codex R4)
**Date:** 2026-06-06 (supersedes v5 same-day; v5←v4←v3←v2 2026-06-05←v1 2026-06-04)
**Branch:** `opus/design-input-plot-linkage` (merged up to `main`)

---

## What changed since v5 (read first if you reviewed v5)

Codex R3 returned 4 HIGH + 2 MEDIUM + 1 LOW, all correct — and a code read surfaced one issue *worse* than reported. v6 resolves each, mostly by hardening the AI apply path:

- **The `update_stage_plot` apply already self-destructs links (worse than R3-HIGH#1).** `page.tsx:2617–2647` shows the stage-plot apply **regenerates the entire input list** (`expandSlotToInputs`, re-numbered `ch`) **and** monitors on its own — so a stage edit nukes every `slotId` link and input edit *before* any cross-tool ordering matters. v6 **removes that client-side regeneration**; each tool reconciles only its own list.
- **Cross-tool apply must be atomic (R3-HIGH#1).** The current per-tool Apply button (`applyToolCall(msgIdx, toolIdx)`) can apply `update_inputs` before `update_stage_plot`, leaving new-slot refs unresolvable. v6 replaces per-tool apply with an **atomic per-message cascade apply** in fixed dependency order (slots → inputs → monitors → rest).
- **New-slot references use a model-supplied `clientRef`, not `"POS:Name"` (R3 recommended direction; fixes HIGH#1 resolution + MEDIUM#5).** Names are never identifiers.
- **`slotRef` omission now preserves the existing link (R3-HIGH#2).** Unlinking requires an explicit `slotRef: null`. Default = preserve.
- **Duplicate `StageSlot.id` de-dupe no longer silently rebinds inputs (R3-HIGH#3).** Inputs pointing at a de-duped id are flagged for **user review** (repair prompt), not bound to the surviving slot.
- **Mix numbers are immutable routing identities (R3-HIGH#4).** `moveMonitor`'s renumber-on-reorder is removed; deleting a monitor orphans referencing slots with a badge (parallel to slot delete). `MonitorMix.id` (already exists via `ensureMonitorIds`) carries row identity.
- **`(pos, name)` fallback only fires when unique (R3-MEDIUM#5).**
- **Stale "inputs inherit/display mix read-only" text removed (R3-MEDIUM#6).**
- **Off-grid doc's reference to the removed `mixForChannel`/v4 export fixed (R3-LOW#7).**

Everything else from v5 (mix slot-only, no mix on inputs/export, multi-occupant render/DnD, descopes) is unchanged.

---

## What changed since v4 (read if you reviewed v4)

A show-runner conceptual call closes the remaining open questions and **simplifies** the design:

- **Mix is a slot/performer property only — never an input-channel property, anywhere this phase.** The v4 read-only `→ Mix n` badge on the input row is **removed**, and so is the v4 **console-export Mix column** (and its resolver / warning UI). Rationale: a mix reference on an input row implies an input *send* ("flip-to-fade" — input faders driving a discrete aux/send mix), which **we are not modeling**. What this tool captures is monitor *grouping* (which performers/sections share a wedge, and where it sits). Actual input→mix sends are the engineer's showtime job. **Clarity > envelope-pushing here.**
- The input row's **only** new element is the **Position (slot) dropdown** (pure grouping by performer/zone). Inputs still link to slots by `slotId` — for organization, rename-safety, and AI coherence — they just don't surface or derive a mix.
- **Console/patch export is untouched** (stays the input-only channel list it is today). Dropping mix from export is now a **deliberate clarity decision**, not the `a0aee19` regression — monitor/wedge info lives in the **monitor section** (its own print block), not joined onto the channel list.
- The old "per-channel mix override" is re-scoped: it's not a cheap one-field add, it's part of a future **Input Sends** phase (a send-matrix / N-mix-per-input model). Captured in `docs/design-input-sends.md`.
- Resolved open questions: **confirm-gate** = silent for zero-linkage shows, confirm on **any** removal once a show has ≥1 linkage. **Slot delete** = prompt at delete time. **Touch drag** = grip-drag stands (revisit in UAT).

Everything else from v4 (slot-id lifecycle + de-dupe, multi-occupant render/DnD, unified AI upsert-by-id + explicit-remove contract, monitor row lifecycle, PIT/FOH/OTHER descope) is unchanged.

---

## What changed since v3

Codex R2 returned 4 HIGH + 3 MEDIUM + 1 LOW, all correct against code. v4 resolves each:

1. **AI link-destruction via `update_inputs` (HIGH).** v3 only id-protected `update_stage_plot`. But the cascade (agent.ts:29) also forces `update_inputs`, a full replace with **no `id`/`slotId`** in its schema (agent.ts:78–99) — so every input link was wiped regardless. v4 defines a **unified reconcile contract across `update_stage_plot`, `update_inputs`, `update_monitors`**.
2. **Inferring deletion from absence (HIGH).** v3 left this an open question. v4 makes the apply layer **merge-by-default (upsert by id); removal is explicit only** (a `removedIds` list), with a **confirm-gate** when a call would drop/orphan more than a threshold of linked items. Absence never deletes.
3. **PIT/FOH/OTHER had no UI/AI design (HIGH).** They're enum values the agent is explicitly told never to use (agent.ts:12) and the grid never renders. v4 **descopes literal PIT/FOH/OTHER rendering** and runs multi-mix on the **nine on-grid blocks** — which is what the approved mockup already showed (multi-mix example on **MSR**). The off-grid example in v3 was the drift. *(Product flag — see "Scope decision" below; show-runner to confirm he doesn't need a literal rendered orchestra pit for v1.)*
4. **`StageSlot.id` uniqueness unprotected (HIGH).** `ensureStageSlotIds` now also **de-dupes** (import / copy-paste / bad JSON / AI returning a dup) by re-minting collisions; tests cover it.
5. **Console export underspecified (MEDIUM).** v4 defines the exact CSV column / XML attribute and the dangling-slot warning surface.
6. **Monitor "derived membership" vs editable names (MEDIUM).** v4 defines the `MonitorMix` row lifecycle: `name`/`needs` stay **user-owned labels**; only the **roster of slots routing to a mix** is derived (computed, never stored). Rows are preserved when assignments change.
7. **Blank-slot dropdown fallback was row-dependent (MEDIUM).** Fallback is now **slot-owned**; instrument-derived naming happens only at slot *creation*.
8. **null vs 0 (LOW).** `StageSlot.mix` is `number`; "no mix" is **`0`** only. No type migration. Wording corrected.

Field names match the **actual code** (`lib/types.ts`): `StageSlot { name, pos, role, mix, power?, featured? }` — verifying against code before writing is the HIGH#2 lesson from R1.

A static visual mockup of the multi-occupant grid was reviewed and approved (stacked occupant chips, per-occupant drag grip, per-mix color-coded badges, TLA headers; 1:N shared-mix groups shown as a single chip with an `×n inputs` badge). Approved nits: occupant lists **grow unbounded**, the **print/read-only plot shows all occupants**, **mix badges are per-mix color-coded**.

---

## Scope decision (needs show-runner confirm)

**Multi-mix-per-block ships on the nine on-grid zones** (USR/USC/USL · MSR/MSC/MSL · DSR/DSC/DSL). The motivating "two mixes in one block" case (e.g. strings on one wedge, brass on another) is modeled on an **on-grid block (MSR in the mockup)**, not the literal `PIT`.

**`PIT`/`FOH`/`OTHER` stay out of scope for v1** — they remain enum values with no renderer, and the agent continues to avoid them. Rendering off-grid zones (a separate area below the grid, their own DnD targets, dropdown entries, print rows, and agent enum/prompt changes) is a **follow-on feature**, not part of linkage v1. *If the show runner needs a literally-rendered orchestra pit for Bohemian Club shows, that promotes off-grid rendering into scope and this section changes.*

---

## Problem

Three independent lists describe the same cast from different angles:

| List | Primary Anchor | Fields (current code) |
|------|---------------|--------|
| Stage Plot | Position (9-block grid) | `name, pos, role, mix, power?, featured?` |
| Input List | Channel number | `ch, inst, mic, stand, notes` (+ optional `id`) |
| Monitor Mixes | Mix number | `mix, name, needs` (+ optional `id`) |

No shared entity links them. "Dave — Drums" is a stage slot (USC, Mix 2), six input channels, and a mix number — disconnected. Rename in one place, the others don't know. The AI copilot handles this because it sees everything at once; manual setup doesn't.

---

## How we got here (question trail — context for review)

**Q1** display name vs linked name; **Q2** free-text string vs managed entity; **Q3** entry point / auto-populate.

**Decisive answer (show runner):** naming is *genuinely over the map* — person, instrument, or character, varying by gig and within a gig.

**Insight:** the name is not the invariant — the *position* is. Everything has to "go somewhere" on the fixed grid. So we anchor to a **slot** (a labeled occupant of a block) identified by a **stable internal id**, and treat the name as a non-structural label. This collapses Q1/Q2 (no roster, no string-vs-entity debate); Q3 = any entry point, link by slot, suggest don't auto-commit.

---

## Constraints

1. Each list's anchor is legitimate (channel-centric inputs, slot-centric plot, mix-centric monitors).
2. Cardinalities differ: 1 slot → many inputs; 1 mix → many slots. No forced 1:1.
3. The grid is immutable (nine on-grid zones; PIT/FOH/OTHER off-grid, out of scope per above). **A block may hold multiple slots.**
4. Tight coupling (single performer entity / sole-owner mix) was tried — too tight (Prior Art).
5. Pure loose coupling (autocomplete only) = status quo, doesn't fix drift.

---

## Prior Art — already tried (PR #53 / #55, reverted)

> Recorded so we don't relitigate.

Input list **used to have a Mix column** (`796d4d6`). `c815800` (PR #53) made `StageSlot.mix` the single source of truth, dropping per-channel mix; `a0aee19` removed mix from console export ("drop monitor mix"); `dc8ae04` (PR #55) reverted the **lockdown** (derived non-editable monitors) but did **not** restore a per-input Mix field. **Current `main`:** `InputChannel` has no mix field; assignment lives only on `StageSlot.mix` (validated dropdown of defined mixes + "None"/0). The proposal keeps mix-on-slot-only — status quo, now *linked* — not a re-introduction of the lockdown.

---

## Proposal: the Stage Slot is the hub. Name is a label, never a key.

### Model

```
StageSlot    { id, name, pos, role, mix, power?, featured? }   // THE HUB / anchor
InputChannel { id?, ch, inst, mic, stand, notes, slotId? }      // links to a slot by id
MonitorMix   { id?, mix, name, needs }                          // name/needs = labels; roster DERIVED
```

New structural fields: **`StageSlot.id`** (stable) and **`InputChannel.slotId`** (the link). `stagePlot` stays a flat `StageSlot[]` — the per-block singleton was only a render-time collapse (`Object.fromEntries(...)` at `app/[owner]/[show]/page.tsx:862` and `:956`). Allowing multiple slots per `pos` is mostly a render/DnD change, not a data migration.

Cardinalities — two distinct `1:N` axes that must **not** be conflated:

- **Slot `1:N` InputChannel** — *many inputs → one slot/mix* (shared-mix; rendered as one chip + `×n inputs` badge). USC's 6 drum channels → one slot.
- **Block `1:N` Slot** — *many slots → one block* (multi-mix; e.g. MSR strings = Mix 5, MSR brass = Mix 6). Each its own slot/label/mix.
- **Slot `N:1` Mix**; **Mix membership derived** (which slots point here), never stored.

### `StageSlot.id` lifecycle (resolves R1-HIGH#1, R2-HIGH#4)

- **Mint:** new slot → `id = crypto.randomUUID()` (match the existing id util used for `SetlistSong`).
- **Legacy load — `ensureStageSlotIds(config)`:** idempotent; runs on load **before** any linking UI paints. Slots missing `id` get one. **De-dupe with ambiguity handling (resolves R3-HIGH#3):** if two slots share an `id` (import, copy-paste, hand-edited JSON, AI dup), keep the first occurrence's id and re-mint the collision(s). Then check inputs: any `InputChannel.slotId` equal to a de-duped id is **ambiguous** — it could have meant the original *or* the re-minted copy, and we must not guess. Such inputs are **not** silently bound to the survivor; they are flagged **needs-review** (a distinct badge) and collected into a **repair prompt** ("Imported data had duplicate occupant ids; N channels can't be confidently linked — review and reassign"). The function returns `{ config, ambiguousInputs: InputChannel[] }` so the UI can surface the prompt. (Silent rebinding to the first slot is the corruption R3 flagged.)
- **Serialize:** `id` written to stored JSON/YAML for every slot, and round-trips on save (without persistence a reload re-mints and severs links).
- **Delete a slot:** **prompt at delete time** if any inputs are linked — "3 inputs are linked to this block — clear their link, or keep them as unlinked?" (No cascade-delete of channel definitions.) Inputs kept-as-unlinked (and any dangle from a non-prompted path or import) show an **orphan badge** ("⚠ unlinked — block removed") plus a config-tab validation warning. The prompt is the primary guard (a silent badge is too easy to miss before a gig); the badge is the backstop.
- **Dangling on import:** an `InputChannel.slotId` matching no slot = orphaned (same badge), never a hard error.

### Multi-occupant blocks — render & DnD (resolves R1-HIGH#2)

- **Group, don't collapse:** `slotMap: pos → slot` becomes `pos → slot[]` (a `groupBy(pos)`). Both `StagePlotView` (read-only/print) and `DraggableStagePlotView` (config) change.
- **Cell = container:** TLA header (three-letter zone code) + occupant count, a **vertical stack of occupant chips**, then "+ add occupant". Each chip: drag grip, `name`, `role`, per-mix color-coded `MIX n` badge. `featured` styles the chip, not the cell.
- **Shared-mix chip:** a slot with N linked inputs also shows an `×n inputs` badge (derived count).
- **Unbounded growth** (no cap/scroll); **print shows all occupants** (no "MSR · 2 mixes" collapse).
- **Per-occupant DnD:** drag id `drag-${slot.id}` (was `drag-${pos}`); drop target stays `drop-${pos}`. Dropping re-parents that slot (`slot.pos = toPos`); its `id` rides along so **input links survive a reposition**. Other occupants of the source block are untouched. Intra-block reorder not required for v1 (order is presentation-only).
- **`onMove` signature:** `(fromPos, toPos)` → `(slotId, toPos)`. The handler at `:3238` uses `findLastIndex(s => s.pos === fromPos)` — ambiguous with multiple occupants; switch to `findIndex(s => s.id === slotId)`.

### Input list — the one new surface

A **Position dropdown per input row**, listing occupied **slots** as `TLA — name` (`USC — Drums`, `MSR — Strings`, `MSR — Brass`). That column *is* the linkage; TLA + label disambiguates two occupants in one block (resolves v2 OQ3).

**Slot label fallback (resolves R2-MEDIUM#7):** the displayed label is **slot-owned**. If a slot's `name` is blank, show `TLA — Occupant {n}` (n = its index among that block's occupants) — a property of the *slot*, identical on every row. Instrument-derived naming (`{inst}`) happens **only at slot creation** (baked into `slot.name`), never as a per-row display fallback, so the same slot never reads as "USC — Kick" on one row and "USC — Snare" on another.

### Input-first / pending-slot flow (resolves R1-MEDIUM#5)

- Dropdown also offers **"＋ New occupant at…"** → choose a block → creates a **real slot** (mint id, `name` derived from the row's `inst`, else "Occupant {n}"), then sets the row's `slotId`. The slot is real, not deferred.
- **Coalescing:** once the slot exists it's in the dropdown, so subsequent drum rows *pick* `USC — Drums`. For rapid multi-row assignment in one unsaved session, "New occupant at {block}" with the same intended label reuses the just-created slot. Net: 6 drum rows + empty USC → one `USC` slot, six inputs linked.
- Inputs that belong nowhere (playback DI, click, announce mic) take `slotId = none` and don't roll up.

### Mix: on the slot only — and nowhere on the input list

- Mix is set on the **stage plot** (the slot/performer anchor) and surfaced in the **monitor section** (the derived roster of who's on each wedge). That is the *only* place mix appears.
- The input list shows **no mix** — not editable, not read-only, not derived. The input row's only new element is the **Position (slot) dropdown**. A mix reference on a channel row would imply an input *send* (input fader → discrete aux/send mix), which this phase does **not** model; suppressing it is a deliberate clarity choice.
- Inputs still carry `slotId` (grouping/rename-safety/AI coherence); they simply never expose the slot's mix.

### Monitor row lifecycle (resolves R2-MEDIUM#6)

Disambiguating "derived membership" from "editable names":

- `MonitorMix.name` and `.needs` are **user-owned free text** (e.g. name "Riddim", needs "drums + bass, vocal lite"). They are **never** auto-derived or overwritten.
- What's **derived** is the **roster** — the set of slots whose `mix` points at this mix number. It is computed on the fly (never stored) and shown read-only beside the row ("→ Strings, Brass").
- **Lifecycle / preservation:** a `MonitorMix` row carries its own stable `id` (already minted by `ensureMonitorIds`, `setlist.ts:43`), and its `mix` **number is an immutable routing identity** (an aux/wedge number — "Mix 3" *is* aux 3, like a console). Changing a slot's mix assignment only recomputes rosters — it **never** creates, deletes, or edits a monitor row. An empty-roster row is **kept** ("(no one assigned)"), not auto-removed.
- **Mix numbers do not renumber on reorder (resolves R3-HIGH#4).** Today `moveMonitor` (`setlist.ts:49`) renumbers `mon.mix = i+1` on drag, but `StageSlot.mix` references *by number* and is **not** remapped — so reordering silently breaks every slot→mix link once rosters are derived. Fix: **remove drag-renumber.** Monitor rows render sorted by their (immutable) `mix` number; "reorder" by renumber is dropped (it never made domain sense — you don't renumber auxes by dragging). Add/edit/delete remain.
- **Deleting a monitor** removes that mix number; slots whose `mix` pointed at it become **orphaned-mix** (a badge: "mix removed", treated as no-mix until reassigned) — the exact parallel of slot-delete orphaning inputs. A delete-time prompt mirrors the slot case if any slots reference it.
- **Explicit renumber** (if ever needed) is a deliberate action that **remaps every referencing `slot.mix`** in the same transaction — never a side effect of reordering.

### AI copilot reconcile contract (resolves R2-HIGH#1/#2, R3-HIGH#1/#2, R3-MEDIUM#5)

The agent is prompted to **cascade** `update_stage_plot` + `update_inputs` + `update_monitors` together (agent.ts:29). Two problems must be fixed together: each tool does a **full replace** with no ids, **and** the `update_stage_plot` apply *itself* regenerates inputs+monitors from scratch (`page.tsx:2617–2647`).

**Step 0 — remove the self-cascade in `update_stage_plot` apply (R3-HIGH#1, worse-than-reported).** Delete the `expandSlotToInputs` input regeneration and the monitor regeneration from the `update_stage_plot` case. Each tool reconciles **only its own list**. (Fresh builds still get inputs/monitors because the model is prompted to call all three tools with real data — the client-side expansion was a redundant link-destroyer.)

**Identity model — names are never identifiers.** New items are referenced by a **model-supplied `clientRef`** (R3 recommended direction), not by name or `"POS:Name"`.

**Schema changes (`lib/agent.ts` TOOLS):**
- `update_stage_plot` items: add optional `id` (existing slot) **or** optional `clientRef` (new slot, e.g. `"slot-strings-1"`).
- `update_inputs` items: add optional `id`; add `slotRef` which is **either** an existing slot `id`, **or** a `clientRef` of a slot in the same cascade, **or** explicit `null` to unlink. **Omitting `slotRef` preserves the input's current `slotId`** (R3-HIGH#2).
- `update_monitors` items: add optional `id`.
- All three tools: add optional `removedIds: string[]`.

**Context we send to the model:** the current config **including** every slot `id`, input `id` + `slotId`, monitor `id`. Instruction: *preserve `id` for items you keep; give new items a `clientRef`; link an input via `slotRef` (an existing slot `id` or a same-cascade `clientRef`); omit `slotRef` to keep an input's current link; set `slotRef: null` to unlink; remove items only via `removedIds` — never drop items you intend to keep.*

**Atomic per-message apply (R3-HIGH#1).** Replace per-tool `applyToolCall(msgIdx, toolIdx)` with **`applyMessageCascade(msgIdx)`** that applies all of a message's tool calls **in one transaction, in fixed dependency order**: slots → inputs → monitors → setlist/notes/info. (Reject is still per-tool, but apply is all-or-nothing for the message, so same-cascade refs always resolve.)

**Reconcile, in order:**
1. **Slots.** Upsert: known `id` → update in place (keep id); `clientRef` (no id) → mint id, record `clientRef → newId`; no id and no clientRef → fall back to `(pos, normalizedName)` **only if that pair is unique** in the current slot set, else mint (R3-MEDIUM#5 — never adopt an id on an ambiguous name); unknown `id` → mint fresh.
2. **Inputs.** Upsert by `id`. Resolve `slotRef`: existing slot `id` → use; `clientRef` → resolve via the map from step 1; `null` → clear (`slotId` none); **omitted → keep the input's current `slotId`** (preserve).
3. **Monitors.** Upsert by `id` (then `mix` number); preserve `name`/`needs`; numbers immutable per Monitor lifecycle.
4. **Removals explicit:** only `removedIds` delete. **Absence never deletes.** Deleting a slot orphans its inputs (badge); deleting a monitor orphans referencing slots (badge).
5. **Confirm-gate:** a **zero-linkage show builds silently**. Once a show has **≥1 linkage**, **any** apply that would remove or orphan a linked item shows a confirm summarizing deltas before mutating (truncation / fresh-build-over-linked-show safety net). Tune nag-tolerance later.

**Prompt change:** relax agent.ts:29 from "replace the entire …" to "**reconcile** against the current config; preserve ids; new items get a `clientRef`; build on what exists; remove only via `removedIds`."

### Authority / drift

Nothing is duplicated → no authority conflict. Mix is owned by the slot and surfaced only on the stage plot + monitor section — **never on inputs** (inputs carry `slotId` for grouping but expose no mix; see "Mix: on the slot only"). The name is a label on the slot; renaming keeps links because inputs point at the **id**, which survives DnD and (via clientRef round-trip) AI edits.

---

## Console / export — unchanged this phase (closes R1-MEDIUM#6, R2-MEDIUM#5)

**No change to `lib/console-export.ts`.** The patch/console export stays the input-only channel list it is today (`Channel, Name, Mic, Stand, Notes`; XML `<channel>` with the same attrs). No `Mix` column, no `mix` attribute, no `mixForChannel` resolver, no warning UI.

This is the **deliberate consequence** of "mix is not an input-channel property." A mix column on the patch sheet would imply an input *send* we don't model. Monitor/wedge information is exported/printed from the **monitor section** (its own print block — `printSections.monitorMixes`), where it belongs as performer-grouping, not joined onto the channel list.

> **For the reviewer:** this is **not** a re-introduction of the `a0aee19` "drop monitor mix" regression. That was an *accidental* loss during the lockdown work. Here it is an *intentional* product decision (clarity), with the monitor information still fully present in its own section. The export simply has no business asserting input→mix routing.

---

## Migration

Near-non-event. `StageSlot.id` added; `InputChannel.slotId` optional. Existing shows load, `ensureStageSlotIds` mints + de-dupes (persisted next save), inputs stay unlinked and behave as today. Linking is opt-in per row. Slots already carry `mix`. JSON/YAML: `id` on every slot, `slotId` on linked inputs, both absent on legacy data and tolerated. No destructive migration, no backfill job (lazy mint on load + save).

---

## Deferred — Input Sends (separate future phase)

Modeling **where each input is sent** (a send matrix / N-mix-per-input) — and the "per-channel mix override" special case within it — is a **distinct future phase**, not part of linkage v1. It is the proper (and only) place an input↔mix relationship belongs, and it would *earn* a mix surface on the input list at that time. Captured in `docs/design-input-sends.md`. Linkage v1 deliberately leaves inputs mix-free to avoid implying a send model we don't yet build.

---

## Already Shipped (independent of this redesign — S31 polish; branch now merged up to main)

1. **"No mix"** — `0` mix on slots; dropdown includes "None"; no "Mix 0" badge on the plot. (`StageSlot.mix` is `number`; `0` = no mix. No `null`, no type migration — R2-LOW#8.)
2. **Mix dropdown on stage plot** — validated dropdown of defined mixes.
3. **Mix name editing** — labels editable from the monitor section.

---

## Build outline (sizing, not a commitment)

1. `StageSlot.id` + `ensureStageSlotIds` (mint + **de-dupe with ambiguous-input repair**, returns `{config, ambiguousInputs}`) + serialize.
2. Group-by-pos render in both plot views; container cell (TLA header, stacked chips, add-occupant); per-mix color palette; `×n inputs` badge; print = all occupants.
3. Per-occupant DnD (`drag-${id}`/`drop-${pos}`); `onMove(slotId, toPos)`; fix `:3238` lookup to id-based.
4. Input-row Position dropdown (`TLA — name`, slot-owned fallback), pending-slot + coalescing, orphan badge + needs-review badge, delete-time prompt. **No mix on the input row.**
5. Monitor: roster derivation (read-only); **remove `moveMonitor` renumber** (sort by immutable number); delete-orphans-slots badge + prompt; explicit-renumber remaps `slot.mix`.
6. AI: **remove `update_stage_plot` self-cascade regeneration** (`:2617–2647`); schema (`id`/`clientRef`/`slotRef`-or-`null`/`removedIds`); context with ids; **`applyMessageCascade` atomic ordered apply** replacing per-tool apply; upsert-by-id reconcile with clientRef map + preserve-on-omit + unique-`(pos,name)` fallback; confirm-gate; prompt relax.
7. *(No console-export work — unchanged this phase.)*
8. Tests: id lifecycle (mint/legacy/round-trip/**dup de-dupe + ambiguous-input repair**/delete-prompt+orphan); reconcile (keep/rename/add/explicit-remove/**no-delete-on-absence**/**slotRef omit=preserve**/**null=unlink**/confirm-gate); `clientRef` resolution + **non-unique `(pos,name)` mints not adopts**; **atomic cascade applies all-or-nothing in order**; **`update_stage_plot` apply no longer regenerates inputs/monitors**; monitor reorder-does-not-renumber + delete-orphans-slots; pending-slot coalescing. (No export tests — export untouched.)

---

## Resolved (no longer open)

- **Confirm-gate** — silent for zero-linkage shows; confirm on **any** removal/orphan once ≥1 linkage.
- **Slot-delete** — prompt at delete; orphan badge backstop. **Monitor-delete** — same pattern (orphans referencing slots).
- **Touch drag** — grip-per-chip for v1; revisit in UAT.
- **PIT/FOH/OTHER** — descoped (`docs/design-offgrid-zones.md`); multi-mix on the 9 on-grid blocks.
- **Mix on inputs / per-channel override** — removed; deferred to Input Sends (`docs/design-input-sends.md`).
- **Same-cascade new-slot refs** — `clientRef`, not `"POS:Name"`; names are never identifiers (R3-rec).
- **slotRef omission** — preserves existing link; explicit `null` unlinks (R3-HIGH#2).
- **Dup slot-id** — ambiguous inputs flagged for review, never silently rebound (R3-HIGH#3).
- **Mix-number identity** — immutable; no renumber-on-reorder (R3-HIGH#4).
- **Cross-tool apply** — atomic ordered `applyMessageCascade`; `update_stage_plot` no longer self-regenerates (R3-HIGH#1).

## Open Questions for Review (R4)

1. **Atomic apply UX** — does all-or-nothing per-message apply (vs. today's per-tool) need a partial-apply or per-tool-preview affordance, or is whole-cascade accept/reject sufficient for the copilot flow?
2. **Monitor reorder removal** — is dropping drag-reorder acceptable (rows sort by immutable number), or is there a real need for a display order independent of the routing number?
3. **Ambiguous-input repair UX** — is a review badge + repair prompt the right surface, or should dup-id imports hard-block load until resolved?
4. Open to any further adversarial findings on the reconcile/apply path.

---

## Status

Proposed (v6), branch merged up to `main`. **Not yet built.** Pending Codex R4; build only after a clean round.
