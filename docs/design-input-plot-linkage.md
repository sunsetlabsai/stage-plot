# Design: Input List / Stage Plot / Mix Linkage

**Status:** Proposed (v9) — ready for adversarial review (Codex R6)
**Date:** 2026-06-06 (supersedes v8 same-day; v8←v7←v6←v5 same-day; v5←v4←v3←v2 2026-06-05←v1 2026-06-04)
**Branch:** `opus/design-input-plot-linkage` (merged up to `main`)

---

## What changed since v8 (read first if you reviewed v8) — R5 fixes + one self-found gap

v8's op-based reframe was accepted as the right shape. v9 closes the four R5 findings, one gap I found while resolving them, plus two product decisions:

- **R5-HIGH (print)** — *not a spec change.* PR #66 was one commit behind `main` and so its diff read as reverting the `main` print fix (`ef70fd9`, route global print through `MixTab`). Resolved by merging `main` into the branch (no force-push; same play as R2-MED#4). No linkage code touches print.
- **R5-HIGH (`removeMonitor` vs forward integrity)** — the contradiction is real. v8-self#2 over-reached: making forward integrity a **plan-rejecting hard fail** made it impossible to ever `removeMonitor` a referenced mix, contradicting the long-standing "delete monitor → orphan slots" behavior. **Root cause:** the two reference edges were treated asymmetrically. **Fix (systemic):** unify them — *orphaned-mix is a representable, allowed needs-attention state* (exactly like an input orphaned by `removeSlot`), surfaced via badge, **not** rejected. The **confirm-gate** (removal → orphaned-slot delta) guards `removeMonitor`. Only `validateMonitors` (dup/non-positive mix# on monitor *rows*) hard-fails.
- **R5-MEDIUM (channel-order control)** — op-based AI lost the ability to set/reorder `ch` (the input list's primary anchor). Added `moveInput { id, ch }`, optional explicit `ch` on `addInput` (insert-and-shift), and a `validateInputs` (unique positive `ch`) invariant. Because **nothing internal keys off `ch`** (links are by `slotId`), a `ch` renumber is a pure reorder — no remap, *safer* than a mix# renumber.
- **R5-LOW (cross-PR doc refs)** — references to `design-input-sends.md` / `design-offgrid-zones.md` are now annotated as deferred follow-ons tracked in **PR #77** (they leave PR #66's diff but remain valid once #77 lands).
- **Self-found gap (manual renumber orphans links).** v8 specified "explicit renumber remaps `slot.mix`" only for the *AI plan*; the **user's manual mix# field edit** (`page.tsx:3404`) merely validated uniqueness — a hand renumber would silently orphan every referencing slot. **Fix:** a single `renumberMix(from, to)` path that *both* the field-edit and AI `updateMonitor.mix` route through (remap all referencing `slot.mix` atomically).
- **Decision — AI may upsert, including in-place mix# renumber** (closes v8 OQ4). A renumber means the *aux still exists* (relabelled), so remapping `slot.mix` preserves routing; forbidding it would be a special-case fighting the v8 thesis. *Removal* (aux gone) orphans instead — the two are different operations, correctly different.
- **Decision — "Quick AI-audit"** (design-only / post-v1): a read-only twin of `edit_show` that reports cross-list misalignments with one-tap suggested fixes. New section below.
- **Delta-gate sharpened.** A change to a mix *number* or channel *number* that **implicitly re-routes/re-patches other rows** (mix# renumber dragging its occupants; `ch` insert/move shifting other channels) is confirm-worthy and **names who moves**. A *single, directly-requested* reassignment (`updateSlot.mix`: "put the singer on Mix 2") stays silent — it is the requested edit, not a surprise.

---

## What changed since v7 (the root-cause reframe — context for v8/v9)

R1→R4 each found HIGHs, **all in the same place: the AI apply/reconcile path**, and the HIGH count stayed flat (3/4/4/3). That is structural, not bad luck: the three AI tools are shaped as **"replace the entire list"** (`agent.ts`), and v2→v7 kept **bolting identity + intent onto a replace-shaped contract** (`id`, `clientRef`, `slotRef`, `removedIds`, omit-preserves, de-dupe, atomic-cascade, delta-gate). Each bolt-on spawned the next edge case. v8 fixes the **shape**, not another instance — and a self-driven adversarial sweep folds in seven issues Codex had not yet named (so R5 aims to be the clean round, not R7).

**Architectural change — the AI edits via explicit operations, not full-list replacement.** One `edit_show` tool takes an ordered **op list** (`addSlot`/`updateSlot`/`removeSlot`, `addInput`/`updateInput`/`linkInput`/`removeInput`, `addMonitor`/`updateMonitor`/`removeMonitor`). Consequences — most of R2–R4 **cannot exist** under this shape:
- **Absence never deletes** — *structural*: only an explicit `removeX` op deletes. No `removedIds` list needed.
- **Preserve-on-omit** — *structural*: `updateX` touches only the fields it carries; an untouched item gets no op.
- **Atomic, ordered apply** — *structural*: the op list is planned then committed all-or-nothing.
- **`clientRef`/`slotRef`** become the ordinary handle for new items, with defined precedence (existing `id` → same-cascade `clientRef` → error) and a `clientRef` namespace disjoint from `id`.
- **Two-phase apply** — plan/validate (resolve refs, check invariants, compute deltas) → confirm-gate → commit. Accurate deltas, no half-applied cascade.
- **Delta-gate** reads directly off the destructive ops + computed orphans.
- The v7 "remove `update_stage_plot` self-cascade regeneration" is **moot** — there is no full-replace path to regenerate from.

**Seven issues found by self-review (folded in, not waited-for):**
1. **(HIGH) Lazy-mint persistence race.** v7 persisted ids "on next save" — but if load mints/de-dupes and the user makes no edit, autosave may not fire → reload re-mints fresh ids → in-session links severed. v8: `ensureStageSlotIds` **marks the config dirty and forces a save** whenever it mints or de-dupes (alt: eager-persist on load). See id lifecycle.
2. **(HIGH) `slot.mix` → monitor referential integrity.** v7 handled only the reverse (delete monitor orphans slots). A slot can carry `mix: 7` with no MonitorMix #7 (AI/import). v8 adds the **forward** orphaned-mix check + badge, and the plan validator flags it.
3. **(MED) `needsReview` lifecycle.** v8: cleared by **any** valid `slotId` assignment (user dropdown *or* AI `linkInput`); the AI context **surfaces** needs-attention inputs so the model can repair them.
4. **(MED) Badge-state explosion → unify.** v7 had 4 input states. v8 collapses "orphaned" (slot deleted) and "needs-review" (de-dupe ambiguity) into **one "needs attention — relink" state** (with a sub-reason), leaving: linked / intentionally-unlinked / needs-attention. (Plus slot-level orphaned-mix.) Clarity-is-king.
5. **(MED) Two-phase apply** — now explicit (above).
6. **(LOW) `slotRef` precedence + namespace** — now specified (above).
7. **(LOW) Intra-block occupant order** — print/render order pinned to **stable insertion order** (array index) so print diffs aren't flaky.

Everything else from v7 (slot-id hub, multi-occupant render/DnD, mix slot-only + off-inputs + off-export, immutable mix numbers, `validateMonitors`, descopes) is unchanged.

---

## What changed since v6 (read if you reviewed v6)

Codex R4 returned 3 HIGH + 3 MEDIUM, all correct against code. v7 resolves each — the cluster is the apply/reconcile/persistence layer, so the fixes harden the data model and the cascade contract:

- **Dup-slot-id repair state is now representable + persistent (R4-HIGH#1).** v6's `ambiguousInputs` was an in-memory return value only — `InputChannel` (`lib/types.ts:18`) had nowhere to store "this link became ambiguous," so the needs-review state evaporated on reload (and the cleared-or-not `slotId` was undefined behavior). v7 adds **`InputChannel.needsReview?: boolean`**: on de-dupe ambiguity the input's `slotId` is **cleared** *and* `needsReview` is set, both persisted. The repair prompt/badge key off the stored flag; reassigning a slot clears it. (Hard-block-on-load kept as the documented alternative for Q3.)
- **Monitor `mix` numbers carry a uniqueness + positivity invariant (R4-HIGH#2).** Roster derivation assumes one row per positive `mix` number; v6 never said so, and `onAdd` used `length+1` (`page.tsx:3415`) which collides after a manual edit, while `onUpdate` (`:3404`) accepted any number including duplicates/≤0. v7 defines `validateMonitors`: **unique positive integers**, enforced on manual edit (revert + inline error), on add (`max(existing.mix)+1`, not `length+1`), and in AI reconcile (cascade rejected pre-mutation if it would produce a dup/non-positive).
- **Reject is now whole-cascade, not per-tool (R4-HIGH#3).** v6's "atomic apply but per-tool reject" was self-contradictory: rejecting the slots tool while keeping the inputs tool leaves `clientRef`s unresolvable. v7 makes the **message cascade the unit**: one **Apply cascade** / **Reject cascade** pair (replacing the per-tool buttons at `page.tsx:2768–2787`). Finer control = re-prompt. This removes the dependency hazard entirely (answers v6-OQ1).
- **`clientRef` must be unique within a cascade (R4-MEDIUM#4).** Duplicate `clientRef`s would make the resolution map ambiguous. v7 validates uniqueness **before any mutation**; a duplicate fails the whole atomic apply with an explanatory error.
- **Confirm-gate is now delta-based, not linkage-count-based (R4-MEDIUM#5 + #6).** v6 gated on "show has ≥1 input linkage," which (a) missed a monitor removal that orphans slots in a zero-input-linkage show, and (b) let a "fresh replace" silently wipe a non-empty zero-linkage show. v7 computes the **actual deltas** (slots removed, inputs orphaned, monitors removed, slots orphaned-by-monitor-removal) and the rule becomes: **additive/upsert-only cascades apply silently; any cascade that removes an existing item or creates an orphan shows a confirm summarizing the exact deltas — regardless of linkage count or modify-vs-replace.** "Fresh replace" is therefore just a large `removedIds` delta the gate always surfaces; no silent wipe is possible.

Everything else from v6 (self-cascade removal, atomic ordered apply, `clientRef`/`slotRef`-omit-preserves/`null`-unlinks, immutable mix numbers, unique-`(pos,name)` fallback) is unchanged.

---

## What changed since v5 (read if you reviewed v5)

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
- The old "per-channel mix override" is re-scoped: it's not a cheap one-field add, it's part of a future **Input Sends** phase (a send-matrix / N-mix-per-input model). Captured in `docs/design-input-sends.md` *(deferred follow-on — lands via PR #77, not this PR)*.
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
StageSlot    { id, name, pos, role, mix, power?, featured? }              // THE HUB / anchor
InputChannel { id?, ch, inst, mic, stand, notes, slotId?, needsReview? }  // links to a slot by id
MonitorMix   { id?, mix, name, needs }                                    // name/needs = labels; roster DERIVED
```

New structural fields: **`StageSlot.id`** (stable), **`InputChannel.slotId`** (the link), and **`InputChannel.needsReview?`** (persistent flag backing the unified **"needs attention — relink"** state; cleared by any valid `slotId` assignment — see "Input link states" below). `stagePlot` stays a flat `StageSlot[]` — the per-block singleton was only a render-time collapse (`Object.fromEntries(...)` at `app/[owner]/[show]/page.tsx:862` and `:956`). Allowing multiple slots per `pos` is mostly a render/DnD change, not a data migration.

**Input link states (unified, resolves v8-self#4).** An input is exactly one of:
- **linked** — `slotId` resolves to a live slot.
- **intentionally unlinked** — no `slotId` (playback DI, click, announce mic); never flagged.
- **needs attention — relink** — `needsReview: true`; covers *both* prior states ("orphaned": its `slotId` no longer resolves because the slot was deleted, and "ambiguous": a dup-slot-id de-dupe cleared the link). One badge, with a sub-reason in the tooltip. Cleared the moment a valid `slotId` is set (user dropdown or AI `linkInput`).

Cardinalities — two distinct `1:N` axes that must **not** be conflated:

- **Slot `1:N` InputChannel** — *many inputs → one slot/mix* (shared-mix; rendered as one chip + `×n inputs` badge). USC's 6 drum channels → one slot.
- **Block `1:N` Slot** — *many slots → one block* (multi-mix; e.g. MSR strings = Mix 5, MSR brass = Mix 6). Each its own slot/label/mix.
- **Slot `N:1` Mix**; **Mix membership derived** (which slots point here), never stored.

### `StageSlot.id` lifecycle (resolves R1-HIGH#1, R2-HIGH#4)

- **Mint:** new slot → `id = crypto.randomUUID()` (match the existing id util used for `SetlistSong`).
- **Legacy load — `ensureStageSlotIds(config)`:** idempotent; runs on load **before** any linking UI paints. Slots missing `id` get one. **De-dupe (resolves R3-HIGH#3, R4-HIGH#1):** if two slots share an `id` (import, copy-paste, hand-edited JSON, AI dup), keep the first occurrence's id and re-mint the collision(s). Then check inputs: any `InputChannel.slotId` equal to a de-duped id is **ambiguous** — it could have meant the original *or* the re-minted copy. Such inputs are **not** silently bound to the survivor; the function **clears their `slotId` and sets `needsReview: true`** (the unified needs-attention state). It returns `{ config, dirty: boolean, ambiguousInputs: InputChannel[] }` — `ambiguousInputs` drives the immediate session prompt ("Imported data had duplicate occupant ids; N channels can't be confidently linked — review and reassign").
- **Persistence (resolves v8-self#1 — the lazy-mint race).** `ensureStageSlotIds` returns **`dirty: true`** whenever it minted an id or de-duped. The load path **must force a save when `dirty`** — *not* rely on the user making an edit. Otherwise: load mints fresh ids in memory → user links inputs against them in-session → reload re-runs `ensureStageSlotIds`, which (no persisted ids) **mints different ids** → every in-session `slotId` dangles. Forcing the save on `dirty` (or, equivalently, eager-persisting on first load) closes this. Saving `needsReview` likewise persists the needs-attention state across reload.
- **Serialize:** `id` on every slot, `slotId` + `needsReview` on inputs that carry them; all round-trip on save. (`needsReview` absent ⇒ `false`.)
- **Delete a slot:** **prompt at delete time** if any inputs are linked — "3 inputs are linked to this block — clear their link, or keep them?" (No cascade-delete of channel definitions.) Inputs kept show the **needs-attention badge** (sub-reason: "block removed") plus a config-tab validation warning; deleting the slot sets `needsReview: true` on each. The prompt is the primary guard (a silent badge is too easy to miss before a gig); the badge is the backstop.
- **Dangling on import:** an `InputChannel.slotId` matching no slot ⇒ needs-attention (sub-reason: "linked block missing"); `ensureStageSlotIds` sets `needsReview: true` for these too. Never a hard error.
- *(Alternative for Q3: hard-block the config UI behind a repair modal on load until all needs-attention inputs are resolved — stricter, but blocks viewing; not chosen because the persistent badge keeps the non-blocking flow. Show-runner call.)*

### Multi-occupant blocks — render & DnD (resolves R1-HIGH#2)

- **Group, don't collapse:** `slotMap: pos → slot` becomes `pos → slot[]` (a `groupBy(pos)`). Both `StagePlotView` (read-only/print) and `DraggableStagePlotView` (config) change.
- **Cell = container:** TLA header (three-letter zone code) + occupant count, a **vertical stack of occupant chips**, then "+ add occupant". Each chip: drag grip, `name`, `role`, per-mix color-coded `MIX n` badge. `featured` styles the chip, not the cell.
- **Shared-mix chip:** a slot with N linked inputs also shows an `×n inputs` badge (derived count).
- **Occupant order is stable insertion order (resolves v8-self#7):** within a block, occupants render (on screen and in print) in their `stagePlot` array order — the order they were added. No re-sort by name/mix; print output is therefore deterministic.
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

- **Mix-number invariant (resolves R4-HIGH#2).** Roster derivation (which slots route to mix *n*) assumes **exactly one monitor row per positive integer `mix`**. v7 makes that an enforced invariant via `validateMonitors`: `mix` values must be **unique positive integers** (no duplicates, no `0`/negatives). Enforcement points:
  - **Manual edit** (`page.tsx:3404` `onUpdate`): a value that collides with another row or is ≤0 is **rejected** — revert the field and show an inline error ("Mix N already exists" / "Mix must be a positive number"). No silent merge.
  - **Add** (`page.tsx:3415` `onAdd`): seed `mix = max(existing.mix) + 1` (was `length+1`, which collides after any manual edit).
  - **AI reconcile** (step 3 below): a cascade that would produce a duplicate or non-positive `mix` is **rejected pre-mutation** with an explanatory error (atomic — nothing applies).
- `MonitorMix.name` and `.needs` are **user-owned free text** (e.g. name "Riddim", needs "drums + bass, vocal lite"). They are **never** auto-derived or overwritten.
- What's **derived** is the **roster** — the set of slots whose `mix` points at this mix number. It is computed on the fly (never stored) and shown read-only beside the row ("→ Strings, Brass").
- **Lifecycle / preservation:** a `MonitorMix` row carries its own stable `id` (already minted by `ensureMonitorIds`, `setlist.ts:43`), and its `mix` **number is an immutable routing identity** (an aux/wedge number — "Mix 3" *is* aux 3, like a console). Changing a slot's mix assignment only recomputes rosters — it **never** creates, deletes, or edits a monitor row. An empty-roster row is **kept** ("(no one assigned)"), not auto-removed.
- **Mix numbers do not renumber on reorder (resolves R3-HIGH#4).** Today `moveMonitor` (`setlist.ts:49`) renumbers `mon.mix = i+1` on drag, but `StageSlot.mix` references *by number* and is **not** remapped — so reordering silently breaks every slot→mix link once rosters are derived. Fix: **remove drag-renumber.** Monitor rows render sorted by their (immutable) `mix` number; "reorder" by renumber is dropped (it never made domain sense — you don't renumber auxes by dragging). Add/edit/delete remain.
- **Deleting a monitor** removes that mix number; slots whose `mix` pointed at it become **orphaned-mix** (a slot-level badge: "mix removed", treated as no-mix until reassigned) — the exact parallel of slot-delete orphaning inputs. A delete-time prompt mirrors the slot case if any slots reference it. (The aux is *gone*; there is no destination to remap to, so we orphan, we don't cascade.)
- **Forward referential integrity — orphaned-mix is an allowed, flagged state, NOT a hard error (resolves R5-HIGH, supersedes v8-self#2).** A slot can carry a positive `mix` with **no** matching `MonitorMix` row — after a `removeMonitor`, or from a hand-edited/imported file, or an AI op that sets `mix: 7` with no monitor 7. v8 wrongly made the plan validator **reject** any such result, which directly contradicted "delete monitor orphans slots" (you could never delete a referenced mix). **Rule (symmetric with input orphaning):** a slot whose `mix > 0` references no monitor row is **orphaned-mix** — a slot-level needs-attention badge, treated as no-mix until reassigned — exactly as an input orphaned by `removeSlot` is flagged, not rejected. The plan validator **surfaces** orphaned-mix in the delta set (so the confirm-gate catches the `removeMonitor`/assignment that created it); it does **not** fail the plan. Load surfaces pre-existing cases via the same badge. *(Only `validateMonitors` — unique positive mix# on monitor **rows** — remains a hard plan failure.)*
  - **Dropdown surfacing:** the stage-plot mix dropdown lists defined mixes + "None"; an orphaned-mix slot additionally shows its dangling value as a flagged, disabled entry ("Mix 7 — removed") so the user can see and re-route it, rather than the value being silently coerced to "None" (which would lose the information that they *were* on Mix 7).
- **Renumber is one path — `renumberMix(from, to)` — used by both the user and the AI (resolves the self-found manual-renumber gap; closes v8 OQ4).** A renumber means the *aux still exists, relabelled* (Mix 3 becomes Mix 5), so it **remaps every referencing `slot.mix` `from → to` in the same transaction** — routing is preserved. Both entry points route through it: the **manual mix# field edit** (`page.tsx:3404` `onUpdate`) and the **AI `updateMonitor.mix`**. Rejects if `to` collides with another live monitor (`validateMonitors`); otherwise updates the monitor row's number and remaps slots atomically. It is **never** a side effect of reordering (drag-renumber is removed). Because it implicitly moves a group of performers, it is **confirm-worthy and names who moves** (see delta-gate).

### AI copilot edit contract — operation-based (resolves the recurring apply-path HIGH class)

The recurring R2–R4 HIGHs all came from **replace-shaped tools** (`update_stage_plot`/`update_inputs`/`update_monitors`, each "replace the entire list" — `agent.ts:29`, plus the `update_stage_plot` apply self-regenerating inputs+monitors at `page.tsx:2617–2647`). v8 replaces that shape: the AI edits the show through **explicit operations**, so identity and intent are first-class instead of inferred.

**One tool — `edit_show({ ops: Op[] })`** (replaces the three replace tools). Ops, with their fields:

| Op | Fields | Notes |
|----|--------|-------|
| `addSlot` | `clientRef`, `pos`, `name`, `role`, `mix`, `power?`, `featured?` | `clientRef` = in-cascade handle; mints a real `id`. |
| `updateSlot` | `id`, + any subset of `pos`/`name`/`role`/`mix`/`power`/`featured` | only provided fields change. |
| `removeSlot` | `id` | orphans linked inputs → needs-attention. |
| `addInput` | `clientRef?`, `inst`, `mic`, `stand`, `notes?`, `slotRef?`, `ch?` | `ch` omitted ⇒ append (`max+1`); explicit `ch` ⇒ insert-and-shift (channels `≥ ch` bump up one). `slotRef` per resolution rules. |
| `updateInput` | `id`, + any subset of `inst`/`mic`/`stand`/`notes` | attributes only; does **not** touch the link **or** `ch` (use `linkInput` / `moveInput`). One-row blast radius. |
| `moveInput` | `id`, `ch` | renumber/reorder a channel; other rows shift to keep `ch` unique positive. The **only** way to change `ch` on an existing input. |
| `linkInput` | `id`, `slotRef` | the **only** way to change a link: `slotRef` = id \| clientRef \| `null` (unlink). Setting a valid slot clears `needsReview`. |
| `removeInput` | `id` | remaining channels close the gap (re-densify) is a UI nicety, not required; gaps are tolerated (`validateInputs` only requires unique positive). |
| `addMonitor` | `clientRef?`, `mix`, `name`, `needs` | `mix` must be unique positive. |
| `updateMonitor` | `id`, + any subset of `name`/`needs`/`mix` | `name`/`needs` are free in-place edits. A `mix` change is a **renumber** → routes through `renumberMix(from,to)`: preserves `validateMonitors` + remaps every referencing `slot.mix` atomically. |
| `removeMonitor` | `id` | orphans referencing slots → orphaned-mix (allowed, flagged; confirm-gated). |

**Why this dissolves the prior HIGHs (each is now structural, not a rule we must remember):**
- **Absence never deletes** — only `removeSlot/removeInput/removeMonitor` delete. No `removedIds` envelope, no "infer deletion from a shorter list."
- **Preserve-on-omit** — an item with no op is untouched; `updateX` carries only changed fields. (v7's "omit `slotRef` to preserve" special case is gone — links change *only* via `linkInput`.)
- **No self-cascade** — there is no full-replace path, so nothing regenerates inputs/monitors as a side effect. `expandSlotToInputs`-style regeneration is deleted; a fresh build is just many `addSlot`/`addInput`/`addMonitor` ops.

**Reference resolution (resolves v8-self#6).** `clientRef` lives in a **namespace disjoint from `id`** (a planning handle, never persisted). A `slotRef` resolves in fixed precedence: **(1)** matches an existing slot `id` → that slot; **(2)** else matches a `clientRef` introduced by an `addSlot` in this same `ops` list → that new slot; **(3)** else → **error** (whole apply fails). Forward references are allowed: a pre-pass registers every `addSlot` clientRef before resolving any `slotRef`, so op order within the list is forgiving.

**Two-phase atomic apply (resolves R3-HIGH#1, R4-HIGH#3, v8-self#5).** A message's `edit_show` call is **planned, then committed** as one unit — replacing both per-tool apply (`applyToolCall`) and per-tool reject (`page.tsx:2768–2787`):

1. **Plan / validate (no mutation).** Register `clientRef`s (must be **unique** — duplicate ⇒ fail); resolve every `slotRef` (unresolved ⇒ fail); apply ops to a *working copy* (insert/`moveInput`/`renumberMix` shifts resolve in op order). **Hard-fail** invariants — `validateMonitors` (unique positive `mix` on monitor rows) and `validateInputs` (unique positive `ch`); a violation aborts the whole plan. **Non-fatal, surfaced** condition — orphaned-mix (`slot.mix` with no monitor row) and orphaned/needs-attention inputs: these are *allowed states*, recorded into the delta set, not rejected (resolves R5-HIGH). Compute the **delta set** (below).
2. **Confirm-gate (delta-based, sharpened).** Classify the deltas:
   - **Silent (additive / single-requested):** `addX`; `updateX` of non-identity attributes (name/role/inst/mic/stand/needs); `linkInput` that only *adds* a link; a single, directly-requested `updateSlot.mix` reassignment ("put the singer on Mix 2"). These are the requested edit, visible in the result — no nag.
   - **Confirm + name affected rows:** any **removal** (`removeX`) or **new orphan** (input needs-attention, slot orphaned-mix); any **identity-number renumber that implicitly re-routes/re-patches *other* rows** — a `renumberMix(from,to)` dragging its occupants ("Mix 3→5 moves Strings, Brass"), or a `ch` insert/`moveInput` shifting other channels ("inserting at ch 3 shifts ch 3–8 down one"). The confirm summarizes exact deltas before commit — **regardless of linkage count or modify-vs-replace.** (A "start over" = many `removeX` → large delta → always surfaced; no silent wipe. A `removeMonitor` orphaning slots in a zero-input show still confirms, because the orphaned-slot delta is non-empty.)
3. **Commit.** The planned working copy replaces the live config in one transaction. The whole message's ops succeed or none do; **Reject** discards the plan. (Finer than whole-message control = re-prompt.)

**Context we send to the model:** the current config **with** every slot `id`, input `id` + `ch` + `slotId` + `needsReview`, monitor `id` + `mix`. Instruction: *edit via ops — `updateX`/`linkInput`/`moveInput`/`removeX` by `id`; new items via `addX` with a **unique** `clientRef`; link inputs only with `linkInput` (existing `id` or a same-list `clientRef`, or `null` to unlink); **don't emit ops for things you aren't changing** (no op = unchanged); to remove something, emit `removeX` (never just drop it); **`ch` (channel) and monitor `mix` are physical patch identities — a channel is a console input, a mix is an aux/wedge — do not renumber them unless explicitly asked** (append new channels with `addInput` and no `ch`; reference an existing wedge by its `mix`; to add a wedge use `addMonitor`); monitor `mix` numbers and channel `ch` stay unique positive integers; **relink any input I flag as needs-attention.*** Surfacing `needsReview` lets the model repair ambiguous/orphaned links (resolves v8-self#3).

### Authority / drift

Nothing is duplicated → no authority conflict. Mix is owned by the slot and surfaced only on the stage plot + monitor section — **never on inputs** (inputs carry `slotId` for grouping but expose no mix; see "Mix: on the slot only"). The name is a label on the slot; renaming keeps links because inputs point at the **id**, which survives DnD and (via clientRef round-trip) AI edits.

### Quick AI-audit — read-only twin of `edit_show` (design-only / post-v1)

A one-tap "audit my show" action that surfaces cross-list misalignments the hard validators can't (they enforce structure; an audit catches *semantic* drift). **It reuses the v8 engine** — it is `edit_show` in dry-run: run the planner over the *current* config with **no incoming ops**, then a heuristic semantic pass, and emit a findings list. No second codepath; this falls out of "edits are operations, validation is a pure phase."

- **What it flags** (beyond the always-enforced `validateMonitors`/`validateInputs`, which it just reports if somehow violated): a slot staged with **no input channel** ("Bass is staged but has no input"); an input whose linked slot's **name has drifted** from what the channel suggests ("ch4 'Synth' links to slot 'Keys'"); a **monitor with a wedge but no slot routed to it** (a paid-for aux doing nothing); **orphaned-mix** slots (now a real state); `featured`/`power`/role gaps; channel/mix **numbering gaps** (1, 2, 4 — is 3 intentional?).
- **Output = report + one-tap suggested fixes.** Each finding carries a **suggested op** (`linkInput`, `removeMonitor`, `renumberMix`, …). One tap applies that single suggestion; **"fix all"** bundles the suggested ops into **one `edit_show({ ops })` call** — a single plan/validate/confirm cycle, atomic.
- **Never auto-applies.** Every suggestion — single or batch — routes through the **same confirm-gate** as a normal edit. The audit *reads*; the user *decides*. (Read-only is structural: the audit phase computes deltas but never commits on its own.)

---

## Console / export — unchanged this phase (closes R1-MEDIUM#6, R2-MEDIUM#5)

**No change to `lib/console-export.ts`.** The patch/console export stays the input-only channel list it is today (`Channel, Name, Mic, Stand, Notes`; XML `<channel>` with the same attrs). No `Mix` column, no `mix` attribute, no `mixForChannel` resolver, no warning UI.

This is the **deliberate consequence** of "mix is not an input-channel property." A mix column on the patch sheet would imply an input *send* we don't model. Monitor/wedge information is exported/printed from the **monitor section** (its own print block — `printSections.monitorMixes`), where it belongs as performer-grouping, not joined onto the channel list.

> **For the reviewer:** this is **not** a re-introduction of the `a0aee19` "drop monitor mix" regression. That was an *accidental* loss during the lockdown work. Here it is an *intentional* product decision (clarity), with the monitor information still fully present in its own section. The export simply has no business asserting input→mix routing.

---

## Migration

Near-non-event. `StageSlot.id` added; `InputChannel.slotId` + `needsReview` optional. Existing shows load, `ensureStageSlotIds` mints + de-dupes and (when it changes anything) **forces a save** so ids persist immediately — not "whenever the user next edits" (the v8-self#1 race). Inputs stay unlinked and behave as today. Linking is opt-in per row. Slots already carry `mix`. JSON/YAML: `id` on every slot, `slotId`/`needsReview` on inputs that carry them, all absent on legacy data and tolerated. No destructive migration, no backfill job (mint-on-load + forced save).

---

## Deferred — Input Sends (separate future phase)

Modeling **where each input is sent** (a send matrix / N-mix-per-input) — and the "per-channel mix override" special case within it — is a **distinct future phase**, not part of linkage v1. It is the proper (and only) place an input↔mix relationship belongs, and it would *earn* a mix surface on the input list at that time. Captured in `docs/design-input-sends.md` *(deferred follow-on — PR #77)*. Linkage v1 deliberately leaves inputs mix-free to avoid implying a send model we don't yet build.

---

## Already Shipped (independent of this redesign — S31 polish; branch now merged up to main)

1. **"No mix"** — `0` mix on slots; dropdown includes "None"; no "Mix 0" badge on the plot. (`StageSlot.mix` is `number`; `0` = no mix. No `null`, no type migration — R2-LOW#8.)
2. **Mix dropdown on stage plot** — validated dropdown of defined mixes.
3. **Mix name editing** — labels editable from the monitor section.

---

## Build outline (sizing, not a commitment)

1. `StageSlot.id` + `InputChannel.needsReview?` + `ensureStageSlotIds` (mint + **de-dupe; ambiguous/dangling inputs get `slotId` cleared + `needsReview: true`**; returns `{config, dirty, ambiguousInputs}`) + serialize + **force-save on `dirty`** (v8-self#1 race).
2. Group-by-pos render in both plot views; container cell (TLA header, stacked chips, add-occupant); per-mix color palette; `×n inputs` badge; print = all occupants in **stable insertion order**.
3. Per-occupant DnD (`drag-${id}`/`drop-${pos}`); `onMove(slotId, toPos)`; fix `:3238` lookup to id-based.
4. Input-row Position dropdown (`TLA — name`, slot-owned fallback), pending-slot + coalescing, **unified needs-attention badge** (sub-reasons: block removed / link missing / ambiguous; clears on valid assign), delete-time prompt. **No mix on the input row.**
5. Monitor: roster derivation (read-only); **`validateMonitors` (unique positive `mix`)** hard-enforced on edit (revert+error), add (`max+1`), and plan-validate; **orphaned-mix as an allowed, flagged state** (badge + flagged dropdown entry; **not** a plan rejection); **remove `moveMonitor` renumber** (sort by immutable number); delete-orphans-slots badge + prompt; **`renumberMix(from,to)`** as the single renumber path shared by the manual field edit (`:3404`) and AI `updateMonitor.mix` — remaps referencing `slot.mix` atomically.
6. AI (op-based): **replace the three `update_*` tools with one `edit_show({ops})`**; op handlers (`addSlot`/`updateSlot`/`removeSlot`/`addInput`/`updateInput`/**`moveInput`**/`linkInput`/`removeInput`/`addMonitor`/`updateMonitor`/`removeMonitor`); `addInput` append-or-insert(`ch`) + `moveInput` reorder; **two-phase apply** (plan→validate→confirm→commit) replacing per-tool apply *and* per-tool reject; ref resolution (id→same-list clientRef→error, forward-ref pre-pass, clientRef namespace disjoint from id); plan validation (unique clientRef, resolvable slotRef, **hard:** `validateMonitors` + **`validateInputs`** (unique positive `ch`); **non-fatal/surfaced:** orphaned-mix + needs-attention inputs); **sharpened delta-gate** (single requested edit = silent; removal/new-orphan/implicit-renumber-of-other-rows = confirm + name); context surfaces ids + `ch` + `needsReview`; prompt rewritten to ops + "don't renumber `ch`/`mix` unless asked." **Delete `expandSlotToInputs` self-cascade** (`:2617–2647`).
7. *(No console-export work — unchanged this phase.)*
8. *(Quick AI-audit — design-only / post-v1, not in the v1 build.)*
9. Tests: id lifecycle (mint/legacy/round-trip/**dup de-dupe → `slotId` cleared + `needsReview` set + persisted**/**`dirty` forces save**/needs-attention clears on reassign/delete-prompt+orphan/**dangling import → needs-attention**); ops (`addSlot`+`linkInput` by clientRef links correctly; **forward-ref order-independent**; `updateInput` doesn't touch link **or `ch`**; `linkInput null` unlinks + nothing else does; **no op = unchanged**; `removeX` is the only delete path → **no-delete-on-absence**); channel order (`addInput` append=`max+1`; explicit-`ch` inserts-and-shifts; `moveInput` reorders keeping `ch` unique; `validateInputs` dup/non-positive **hard-fails**); ref resolution (**duplicate clientRef fails whole apply**, **unresolvable slotRef fails**, id-before-clientRef precedence); **two-phase atomic** (plan failure mutates nothing; commit all-or-nothing; reject discards); plan validation (`validateMonitors`/`validateInputs` dup/non-positive **hard-fail**; **orphaned-mix is surfaced in the delta, NOT rejected** — `removeMonitor` of a referenced mix succeeds with a flagged slot); **`renumberMix`** remaps every referencing `slot.mix` (via field-edit *and* AI) and rejects on collision; **sharpened delta-gate** (single `updateSlot.mix` reassignment = silent; `renumberMix`/`ch`-insert/`moveInput`-shift naming affected rows = confirm; `removeMonitor`-orphans-slots on a zero-input-linkage show = confirm; remove-everything start-over = confirm); monitor add seeds `max+1`, reorder-does-not-renumber; pending-slot coalescing; occupant insertion order stable in print. (No export tests — export untouched.)

---

## Resolved (no longer open)

- **Confirm-gate** — delta-based and **independent of linkage count**: any removal/orphan/implicit-renumber confirms even on a zero-linkage show; single requested edits stay silent. (See "Delta-gate (sharpened)" below — this supersedes the earlier "silent until ≥1 linkage" model.)
- **Slot-delete** — prompt at delete; orphan badge backstop. **Monitor-delete** — same pattern (orphans referencing slots).
- **Touch drag** — grip-per-chip for v1; revisit in UAT.
- **PIT/FOH/OTHER** — descoped (`docs/design-offgrid-zones.md` *— deferred follow-on, PR #77*); multi-mix on the 9 on-grid blocks.
- **Mix on inputs / per-channel override** — removed; deferred to Input Sends (`docs/design-input-sends.md` *— PR #77*).
- **Same-cascade new-slot refs** — `clientRef`, not `"POS:Name"`; names are never identifiers (R3-rec).
- **slotRef omission** — preserves existing link; explicit `null` unlinks (R3-HIGH#2).
- **Dup slot-id** — ambiguous inputs flagged for review, never silently rebound (R3-HIGH#3).
- **Mix-number identity** — immutable; no renumber-on-reorder (R3-HIGH#4).
- **Cross-tool apply** — now the two-phase atomic op apply (plan→commit); no self-cascade regeneration (R3-HIGH#1; mechanism superseded by the v8 op contract).
- **Dup-slot-id repair state** — persisted via `InputChannel.needsReview` (`slotId` cleared); badge survives reload, clears on reassign (R4-HIGH#1).
- **Monitor mix-number invariant** — unique positive integers, enforced on edit/add/reconcile via `validateMonitors` (R4-HIGH#2).
- **Apply/reject granularity** — whole-cascade unit; per-tool reject removed (R4-HIGH#3, v6-OQ1).
- **`clientRef` uniqueness** — required within a cascade; duplicate fails whole apply pre-mutation (R4-MEDIUM#4).
- **Confirm-gate** — delta-based (additive=silent; any removal/orphan=confirm), independent of linkage count and modify-vs-replace; no silent fresh-wipe (R4-MEDIUM#5 + #6).
- **AI contract shape** — **operation-based** `edit_show({ops})` replaces the three replace-shaped tools; absence-never-deletes / preserve-on-omit / no-self-cascade are now *structural*, not remembered rules (v8 reframe).
- **Lazy-mint persistence race** — `ensureStageSlotIds` returns `dirty` and the load path force-saves; ids persist immediately (v8-self#1).
- **Forward `slot.mix` integrity** — orphaned-mix (a `slot.mix` with no monitor row) is an **allowed, flagged needs-attention state** (badge + flagged dropdown entry), **surfaced in the delta / confirm-gated, not plan-rejected** — symmetric with input orphaning. Only `validateMonitors`/`validateInputs` hard-fail (R5-HIGH; supersedes v8-self#2's reject).
- **Channel-order control** — `addInput` appends (`max+1`) or inserts (explicit `ch`, shifts others); `moveInput { id, ch }` reorders; `validateInputs` (unique positive `ch`) hard-enforced; `ch` is not a referential target (links are by `slotId`) so renumber needs no remap (R5-MEDIUM).
- **Renumber path** — single `renumberMix(from,to)` shared by the manual mix# field edit and AI `updateMonitor.mix`; remaps every referencing `slot.mix` atomically; rejects on collision; never a reorder side effect (R5 self-found gap; closes v8 OQ4 — AI upsert incl. in-place renumber is allowed).
- **Delta-gate (sharpened)** — single directly-requested edits (incl. one `updateSlot.mix` reassignment) are silent; removals, new orphans, and **identity-number renumbers that implicitly re-route/re-patch other rows** (`renumberMix`; `ch` insert/`moveInput` shift) confirm and **name the affected rows**.
- **Cross-PR doc refs** — `design-input-sends.md` / `design-offgrid-zones.md` annotated as deferred follow-ons in PR #77 (R5-LOW).
- **Print regression** — *not a linkage change*; branch was 1 commit behind `main`, fixed by merging `main` (print fix `ef70fd9`) into the branch (R5-HIGH).
- **`needsReview` lifecycle** — cleared by any valid `slotId` assignment (user or AI `linkInput`); AI context surfaces needs-attention inputs to repair (v8-self#3).
- **Input badge states unified** — linked / intentionally-unlinked / needs-attention (orphaned + ambiguous merged) (v8-self#4).
- **Two-phase atomic apply** — plan→validate→confirm→commit; accurate deltas, no partial apply (v8-self#5).
- **`slotRef` precedence + namespace** — id → same-list clientRef → error; clientRef disjoint from id; forward-ref pre-pass (v8-self#6).
- **Intra-block occupant order** — stable insertion order, deterministic print (v8-self#7).

## Open Questions for Review (R6)

1. **Repair-flag UX (Q3, show-runner call)** — persistent needs-attention badge (non-blocking, chosen) vs. hard-block-on-load repair modal for dup-id/dangling imports. Confirm or escalate.
2. **Delta-gate nag tolerance** — the sharpened gate confirms on removal / new-orphan / implicit-renumber-of-other-rows. The most likely over-chatty case is a `ch` **insert-and-shift** (routine while building a patch, yet it does re-patch every channel below). Correct until UAT tunes a threshold, or should mid-list insert be silent?
3. **Monitor reorder removal** — is dropping drag-reorder acceptable (rows sort by immutable number), or is a display order independent of routing number actually needed?
4. Open to any further adversarial findings — especially the op planner/validator, the two-phase commit, and the new `moveInput`/`renumberMix`/orphaned-mix surfaces.

---

## Status

Proposed (v9), branch merged up to `main`. **Not yet built.** Pending Codex R6; build only after a clean round.
