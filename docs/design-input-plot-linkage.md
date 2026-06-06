# Design: Input List / Stage Plot / Mix Linkage

**Status:** Proposed (v3) — ready for adversarial review (Codex R2)
**Date:** 2026-06-06 (supersedes v2 2026-06-05, which superseded the 2026-06-04 draft)
**Branch:** `opus/design-input-plot-linkage` (merged up to `main` — "Already Shipped" below is now accurate for this branch)

---

## What changed since v2 (read first if you reviewed v2)

v2 got a NOT-build-ready verdict (3 HIGH + 3 MEDIUM, all correct). v3 resolves them and folds in two show-runner decisions:

1. **Multi-mix per block is now an explicit YES, built in v1 — not deferred.** v2 wrongly claimed "the grid already supports multiple occupants" (HIGH #2 — false; the render collapses `pos → slot`). v3 *designs* multi-occupant blocks properly: data, render, DnD, delete, AI, export. The show runner confirmed the real need (two distinct mixes in one physical block — e.g. PIT strings on one wedge, brass on another) and chose the full build now.
2. **Link by stable `slotId`; display the block TLA, never the id** (show-runner call). The id is internal plumbing; the user only ever sees the three-letter zone code (USR…DSL, PIT, FOH) plus the occupant label.

Field names in this doc now match the **actual code** (`lib/types.ts`): `StageSlot { name, pos, role, mix, power?, featured? }` — *not* the `{block, label}` shorthand v2 used. (Verifying claims against code before writing them is the explicit HIGH #2 lesson.)

A static visual mockup of the multi-occupant grid was reviewed and approved (stacked occupant chips, per-occupant drag grip, per-mix color-coded badges, TLA headers; 1:N shared-mix groups shown as a single chip with an `×n inputs` badge). Approved nits: occupant lists **grow unbounded** (no cap/scroll), the **print/read-only plot shows all occupants**, and **mix badges are per-mix color-coded**.

---

## Problem

Three independent lists describe the same cast of people/instruments from different angles:

| List | Primary Anchor | Fields (current code) |
|------|---------------|--------|
| Stage Plot | Position (9-block grid) | `name, pos, role, mix, power?, featured?` |
| Input List | Channel number | `ch, inst, mic, stand, notes` (+ optional `id`) |
| Monitor Mixes | Mix number | `mix, name, needs` (+ optional `id`) |

There's no shared entity linking them. "Dave — Drums" appears as a stage slot (USC, Mix 2), six input channels (kick, snare, OH L, OH R, tom 1, tom 2), and is referenced by a mix number — but they're not connected. Change the name in one place, the others don't know. Add inputs, still have to manually add a stage slot.

The AI copilot handles this because it sees everything at once. Manual setup has no such advantage.

---

## How we got to the proposal (question trail — context for review)

This design was reached by forcing answers to three questions, recorded so a reviewer can judge the *reasoning*.

**Q1 — Display name vs. linked name on the stage plot.** Should the grid show "Drums" (instrument) while the link is "Dave" (person)?
**Q2 — Is the "name" a free-text string or a managed entity?** A string means typos break linkage; an entity (roster) means rename-safety but management overhead.
**Q3 — Which list do you start with, and should building one auto-populate the others?**

**The decisive answer (from the show runner):** naming is *genuinely over the map*. When names are known, he uses them; when not, instrumentation; for a play/variety show, a *character*. It varies by gig and within a gig.

**The insight:** the *name is not the invariant — the position is.* Every input, performer, and mix has to "go somewhere" on the stage, and the 9-block grid is fixed physical reality (Constraint #3). So we **stop making the name structural** and **anchor everything to position** — specifically, to a *slot* (a labeled occupant of a block), identified by a stable internal id.

This collapses Q1/Q2: no performer entity, no roster, no string-vs-entity debate. The name is a non-structural label, free to be person/character/instrument per show. Q3: any entry point, link by slot, *suggest* rather than auto-commit.

---

## Constraints

1. **Each list's primary anchor is legitimate.** Input list is channel-centric (6 drum channels → 1 slot). Stage plot is slot-centric. Mixes are mix-centric (1 wedge, shared by whoever's near it).
2. **Cardinalities differ.** 1 slot → many inputs. 1 mix → many slots. A single 1:1 "performer" entity doesn't match reality.
3. **The 9-block grid is immutable.** The nine named zones (USR/USC/USL · MSR/MSC/MSL · DSR/DSC/DSL) plus off-grid PIT/FOH/OTHER are fixed. This is an *advantage*: a stable anchor. **A block may hold more than one slot** (this is the multi-occupant decision).
4. **Tight coupling was tried — too tight.** A single performer entity / sole-owner mix forced artificial 1:1s (see Prior Art).
5. **Pure loose coupling = status quo.** Autocomplete alone doesn't solve drift.

---

## Prior Art — What We Already Tried (PR #53 / #55, reverted)

> Recorded so we don't re-search or relitigate.

The input list **used to have a Mix column** (commit `796d4d6`). It was removed during "Stage plot → monitor mix sync":

- `c815800` (PR #53) made `StageSlot.mix` the **single source of truth**, dropping per-channel mix (*"mix # and name are derived from stage plot"*).
- `a0aee19` — Codex finding **"drop monitor mix"** removed the mix association from console export.
- `dc8ae04` (PR #55) — **"Revert monitor lockdown — restore full monitor mix editing."** Undid the over-tight coupling but did **not** restore a per-input Mix field.

**Where it landed (current `main`):** `InputChannel` = `ch / inst / mic / stand / notes` (+ optional `id`) — **no mix field**. Monitor assignment lives **only** on `StageSlot.mix` (a validated dropdown of defined mixes + "None"/0).

**Precise reading:** the revert killed the *lockdown* (derived, non-editable monitors), **not** the loss of a per-channel mix field. Mix-on-slot-only has shipped since and been fine. The proposal keeps mix-on-slot-only — **not** a change to mix ownership, just the status quo, now *linked*.

---

## Proposal: the Stage Slot is the hub. Name is a label, never a key.

### Model

```
StageSlot    { id, name, pos, role, mix, power?, featured? }   // THE HUB / anchor
InputChannel { id?, ch, inst, mic, stand, notes, slotId? }      // links to a slot by id
MonitorMix   { id?, mix, name, needs }                          // membership DERIVED
```

The single new structural field is **`StageSlot.id`** (stable) and **`InputChannel.slotId`** (the link). `stagePlot` stays a flat `StageSlot[]` — it always was; the per-block-singleton was only a *render-time* collapse (`Object.fromEntries(stagePlot.map(s => [s.pos, s]))` at `app/[owner]/[show]/page.tsx:862` and `:956`). Allowing multiple slots per `pos` is therefore mostly a render/DnD change, not a data migration.

Cardinalities:

- **Slot `1:N` InputChannel** — USC's 6 drum channels point at one slot. (This is the "shared mix" case: many inputs, one mix. Rendered as one occupant chip with an `×n inputs` badge.)
- **Block `1:N` Slot** — one physical block may host several occupants, each its own slot/label/mix. (This is the "multi-mix" case: PIT strings = Mix 5, PIT brass = Mix 6, same block.)
- **Slot `N:1` Mix** — each slot points at one mix.
- **Mix membership** — *derived* (which slots point here), never stored.

These two `1:N` axes are distinct and must not be conflated: *many inputs → one slot/mix* (shared) vs *many slots → one block* (multi-mix). The mockup shows both side by side.

### `StageSlot.id` lifecycle (resolves HIGH #1)

`StageSlot` is currently the only list type lacking an `id` (`InputChannel`/`MonitorMix`/`SetlistSong` all have optional `id`). Add it and manage it as follows:

- **Mint:** new slot created in the UI → `id = crypto.randomUUID()` (or the existing id util used elsewhere — match `SetlistSong` id generation).
- **Legacy load — `ensureStageSlotIds(config)`:** idempotent. On show load, any slot missing `id` gets one minted; slots that already have one keep it. Must run **before** any linking UI renders, so the Position dropdown links against the persisted id. Mirror the existing `ensureSetlistIds`-style pattern if one exists.
- **Serialize:** `id` is written to the stored JSON/YAML for every slot. (Without persistence, a reload re-mints fresh ids and severs links made earlier in the session — so ensure runs on load *and* ids round-trip on save.)
- **Delete a slot:** linked inputs are **orphaned** (their `slotId` now dangles). They are not auto-deleted. The input row shows an **orphan badge** ("⚠ unlinked — block removed") and a validation warning surfaces in the config tab. The user re-points or clears the row. (No cascade delete of inputs — losing channel definitions because a stage slot was removed would be surprising.)
- **Dangling on import:** an `InputChannel.slotId` that matches no slot is treated as orphaned (same badge), never as a hard error.

### Multi-occupant blocks — render & DnD (resolves HIGH #2)

The grid stays the immutable 3×3 (+ off-grid PIT/FOH/OTHER). The change is per-cell:

- **Group, don't collapse:** replace `slotMap: pos → slot` with `pos → slot[]` (a `groupBy(pos)` over `stagePlot`). Both `StagePlotView` (read-only/print) and `DraggableStagePlotView` (config) change.
- **Cell = container:** a TLA header (the three-letter zone code) + occupant count, then a **vertical stack of occupant chips**, then an "+ add occupant" control. Each chip: drag grip, `name` (label), `role`/instrument, and a **per-mix color-coded** `MIX n` badge. `featured` styling applies to the chip, not the whole cell.
- **Shared-mix chip:** a slot with N linked inputs additionally shows an `×n inputs` badge (derived count), so "Riddim = drums+bass on one mix" reads as *one* occupant, not many.
- **Unbounded growth:** no cap, no scroll — the row grows. (Approved; rare in practice.)
- **Print/read-only:** show **all** occupants (full info is the point of printing). No collapse to "MSR · 2 mixes".
- **DnD becomes per-occupant:** drag id `drag-${slot.id}` (was `drag-${pos}`); drop target stays the block `drop-${pos}`. Dropping re-parents that one slot (`slot.pos = toPos`); its `id` rides along, so **input links survive a reposition** — the core reason we link by id, not by pos. The other occupants of the source block are untouched. (Intra-block reorder is not required for v1; order is presentation-only.)
- **`onMove` signature** changes from `(fromPos, toPos)` to `(slotId, toPos)`. The current handler at `:3238` uses `findLastIndex(s => s.pos === fromPos)` — with multiple occupants that's ambiguous; switch to `findIndex(s => s.id === slotId)`.

### The one new product surface on the input list

A **Position dropdown on each input row**, listing occupied **slots** as `TLA — name` (e.g. `USC — Drums`, `MSR — Strings`, `MSR — Brass`). That one column *is* the linkage. With multi-occupant blocks, the TLA + label disambiguates two occupants in the same block (resolves v2 OQ3). If a slot's `name` is blank, fall back to `TLA — {inst}` or `TLA — Occupant {n}`.

### Input-first / pending-slot flow (resolves MEDIUM #5)

Building inputs before placing people:

- Position dropdown also offers **"＋ New occupant at…"** → choose a block → creates a **real slot** immediately (mint id, placeholder `name` derived from the row's `inst`, or "Occupant {n}"), then sets the row's `slotId` to it. The slot is real, not a deferred promise.
- **Coalescing:** the moment that slot exists it appears in the dropdown, so the next of six drum rows simply *picks* `USC — Drums` rather than creating a second. To avoid a race when a user rapidly assigns several rows, "New occupant at {block}" with an identical intended label created earlier in the same unsaved session reuses the just-created slot. Net: 6 drum rows + empty USC → one `USC` slot, six inputs linked (the 1:N case), not six empty slots.
- Inputs that belong nowhere (playback DI, click, announce mic) take `slotId = none` and don't roll up to a wedge.

### Mix: on the slot only. No per-channel dropdown.

- Mix is set on the stage plot (the anchor), where it already lives.
- On the input list, the slot's mix is shown **read-only** — a derived `→ Mix 2` badge so the monitor engineer sees routing at a glance; **not** editable there.
- Monitor section stays freely editable (names/needs) and shows derived membership.

This is the status quo for mix *ownership* — not the reverted lockdown, and not a competing editable mix surface.

### AI copilot must not sever links (resolves HIGH #3)

Today the AI stage-plot tool does a **full replace** of `stagePlot` (`agent.ts` mandates a full-replace cascade; apply logic regenerates from scratch). Because the model can't invent our ids, a naive replace wipes every `id` → orphans every linked input on every AI edit. With multi-occupant blocks, `pos` is no longer unique, so v2's "reconcile by pos" is insufficient. Fix by **round-tripping ids through the AI**:

1. **Tool schema gains an optional `id` per slot.** When we hand the current plot to the model, include each slot's `id`.
2. **Instruction:** *preserve `id` for occupants you keep; omit `id` for brand-new occupants; to remove an occupant, omit it.*
3. **Apply / reconcile:**
   - Returned slot **with a known `id`** → update in place, **keep the id** (and thus all linked inputs).
   - Returned slot **with no `id`** → fall back to matching by `(pos, name)`; if matched, adopt that slot's id; else **mint** a new id (genuinely new occupant).
   - Returned slot **with an unknown `id`** → treat as new, mint fresh (defensive against hallucinated ids).
   - Existing slot **absent** from the returned set → drop it; its inputs are **orphaned** (badge), not deleted.
4. **Relax** the "always full-cascade replace" instruction to "reconcile against current ids" in `agent.ts`.

`(pos, name)` fallback also rescues the rename case if the model drops an id but keeps the label/position.

### Console / export (resolves MEDIUM #6)

`lib/console-export.ts` currently takes `InputChannel[]` only and can't see slots. Add a resolver that takes `(inputs, stagePlot)`:

```
mixForChannel(ch, stagePlot):
  if !ch.slotId            -> { mix: none }            // unrouted (DI/click) — no warning
  slot = stagePlot.find(s => s.id === ch.slotId)
  if !slot                 -> { mix: none, warn: "dangling slotId" }  // orphan
  return { mix: slot.mix }                              // none/0 allowed
```

- `none`/dangling → exported as no-mix, with a warning surfaced (closes the `a0aee19` "drop monitor mix" regression door — mix is now *derivable*, not dropped).
- Forward-compatible with the deferred per-channel override: `ch.mixOverride ?? slot.mix`.

### Authority / drift

Nothing is duplicated, so there's no authority conflict:

- Mix is owned by the slot; input rows *inherit and display* it read-only. Change the slot's mix → the badge reflects it. **No sync prompts** (the v1 draft's "last-write-wins + prompt" only existed because mix was duplicated onto channels; it isn't).
- The **name** is a free-text label on the slot. Renaming "Drums" → "Dave" keeps every input linked, because inputs point at the slot **id**, not the string — and the id survives DnD repositioning and (via round-trip) AI edits.

---

## Migration

Near-non-event. `StageSlot.id` is added; `InputChannel.slotId` is optional:

- Existing shows load, `ensureStageSlotIds` mints ids (persisted on next save), inputs remain unlinked (`slotId` absent) and behave exactly as today.
- Linking is **opt-in per row** via the new Position dropdown.
- Slots already carry `mix`; nothing changes there.
- JSON/YAML: `id` serializes on every slot; `slotId` on each linked input; both absent on legacy data and tolerated by the parser.
- No destructive migration, no backfill job required (ids mint lazily on load + save).

---

## Deferred (with a cheap escape hatch) — per-channel mix override

The one pro-audio case omitted from v1: a *single channel* routing to a different wedge than its slot (e.g. kick to a separate mix). This is **distinct** from multi-mix-per-block (which v1 *does* ship). It's deferred on the judgment that split-routing-per-channel is rare at this venue tier, and it bolts on cheaply later as **one optional field** `InputChannel.mixOverride`, with the resolver already shaped for it (`ch.mixOverride ?? slot.mix`). Flagged explicitly so the reviewer can challenge the YAGNI call rather than have it buried. This is **not** a one-way door.

---

## Already Shipped (independent of this redesign — landed in S31 polish)

The branch is now merged up to `main`, so these are genuinely present here (v2's stale-branch made this section wrong — MEDIUM #4):

1. **"No mix" option** — `null`/0 mix on slots; dropdown includes "None"; no "Mix 0" badge on the plot.
2. **Mix dropdown on stage plot** — bare integer replaced with a validated dropdown of defined mixes.
3. **Mix name editing** — mix labels editable from the monitor section.

(Listed so the reviewer doesn't re-propose them.)

---

## Build outline (for review — sizing, not a commitment)

1. `StageSlot.id` + `ensureStageSlotIds` (load) + serialize.
2. Group-by-pos render in both plot views; container cell (TLA header, stacked chips, add-occupant); per-mix color palette; `×n inputs` badge; print = all occupants.
3. Per-occupant DnD (`drag-${id}` / `drop-${pos}`); `onMove(slotId, toPos)`; fix `:3238` lookup to id-based.
4. Input-row Position dropdown (`TLA — name`), pending-slot creation + coalescing, read-only `→ Mix n` badge, orphan badge.
5. AI tool schema `id` + reconcile-by-id-then-`(pos,name)`; relax full-cascade in `agent.ts`.
6. `mixForChannel` resolver wired into `console-export.ts`.
7. Tests: id lifecycle (mint/legacy/round-trip/delete-orphan), reconcile (keep/rename/add/remove), export resolver (none/dangling), pending-slot coalescing.

---

## Open Questions for Review (R2)

1. **Reconcile key** — is id-round-trip + `(pos, name)` fallback robust enough, or do we need an explicit "removed" signal from the AI rather than inferring removal from absence (risk: a model that truncates output silently drops occupants → mass orphaning)?
2. **Orphan policy on slot delete** — orphan-and-badge vs. prompt ("3 inputs were linked to this block — clear or reassign?"). Is silent orphaning + badge enough, or too easy to miss before a gig?
3. **Pending-slot coalescing** — is "reuse a same-label slot created earlier this session" the right heuristic, or should rapid multi-row assignment open a small "create N occupants?" confirmation?
4. **Per-occupant drag ergonomics** — grip-per-chip in a possibly-tall cell on touch (iPad at front-of-house). Acceptable, or do we need a different reorder/move affordance on touch?
5. **YAGNI on per-channel mix override** — still acceptable to defer for the Bohemian Club pro-tester tier given the cheap escape hatch?
6. **`ensureStageSlotIds` timing** — confirm there's no render path that links inputs before ids are ensured (a stale-link footgun). Where exactly does ensure need to run relative to first paint?

---

## Status

Proposed (v3), branch merged up to `main`. **Not yet built.** Pending Codex R2; build only after a clean round.
