# Design: Input List / Stage Plot / Mix Linkage

**Status:** Proposed — ready for adversarial review (Codex)
**Date:** 2026-06-05 (supersedes 2026-06-04 early-thinking draft)

---

## Problem

Three independent lists describe the same cast of people/instruments from different angles:

| List | Primary Anchor | Fields |
|------|---------------|--------|
| Stage Plot | Position (9-block grid) | name, role, pos, mix |
| Input List | Channel number | ch, inst, mic, stand, notes |
| Monitor Mixes | Mix number | mix, name, needs |

There's no shared entity linking them. "Dave — Drums" appears as a stage slot (USC, Mix 2), six input channels (kick, snare, OH L, OH R, tom 1, tom 2), and is referenced by a mix number — but they're not connected. Change the name in one place, the others don't know. Add inputs, still have to manually add a stage slot. The mix number on the stage slot used to be a bare integer with no validation (since fixed — see "Already Shipped").

The AI copilot handles this seamlessly because it sees everything at once. Manual setup has no such advantage.

---

## How we got to the proposal (question trail — context for review)

This design was reached by forcing answers to three questions. They're recorded here so a reviewer can judge the *reasoning*, not just the result.

**Q1 — Display name vs. linked name on the stage plot.** Should the grid show "Drums" (instrument) while the link is "Dave" (person)?

**Q2 — Is the "name" a free-text string or a managed entity?** A string means typos break linkage; an entity (roster) means rename-safety but management overhead.

**Q3 — Which list do you start with, and should building one auto-populate the others?**

**The decisive answer (from the show runner):** naming is *genuinely over the map*. When names are known, he uses them. When they aren't, he uses instrumentation. For a play or variety show he may use a *character* name. It varies by gig and even within a gig.

**The insight that fell out of that:** the *name is not the invariant — the position is.* Every input, every performer, every mix ultimately has to "go somewhere" on the stage, and the 9-block grid is fixed physical reality (immutable by Constraint #3 below). So the right move is to **stop making the name structural** and **anchor everything to position instead.**

This collapses Q1 and Q2 entirely: there is no performer entity, no roster, no string-vs-entity debate. The name becomes a non-structural label painted on the slot, free to be a person, character, or instrument on any given show. Q3 is answered by "any entry point, but link by position, and *suggest* rather than auto-commit" (see below).

---

## Constraints

1. **Each list's primary anchor is legitimate.** Input list is channel-centric (6 drum channels → 1 position). Stage plot is position-centric (1 grid slot per occupant). Mixes are mix-centric (1 wedge, shared by whoever's near it).
2. **Cardinalities differ.** 1 position → many inputs. 1 mix → many positions. Forcing a single "performer" entity into 1:1 relationships doesn't match reality.
3. **The 9-block grid is immutable.** Positions are fixed physical reality — this is an *advantage*: a stable anchor.
4. **Tight coupling was tried — too tight.** A single performer entity / sole-owner mix forced artificial 1:1 relationships (see Prior Art).
5. **Pure loose coupling = status quo.** Autocomplete alone doesn't solve the drift problem.

---

## Prior Art — What We Already Tried (PR #53 / #55, reverted)

> Recorded so we don't re-search or relitigate this.

The input list **used to have a Mix column** (original Setup UI, commit `796d4d6`). It was removed during the "Stage plot → monitor mix sync" work:

- `c815800` (PR #53) made `StageSlot.mix` the **single source of truth** and dropped the per-channel mix, with the comment *"mix # and name are derived from stage plot."*
- `a0aee19` — Codex finding **"drop monitor mix"** (removed the mix association from console export).
- `dc8ae04` (PR #55) — **"Revert monitor lockdown — restore full monitor mix editing."** Undid the over-tight coupling but did **not** restore a per-input Mix field.

**Where it landed (current `main`):** `InputChannel` = `ch / inst / mic / stand / notes` — **no mix field**. Monitor assignment lives **only** on `StageSlot.mix`. (Mix on the stage plot is now a validated dropdown of defined mixes + "None"/0.)

**Precise reading of what was reverted:** the revert killed the *lockdown* (derived, non-editable monitors), **not** the loss of a per-channel mix field. Mix-on-slot-only has been the shipping reality since, and has been fine. This matters: the proposal below keeps mix-on-slot-only, which is **not** a change to mix ownership — it's the status quo, now *linked*.

---

## Proposal: Position is the hub. Name is a label, never a key.

### Model

```
StageSlot   { id, block (USC…), label, role?, mix? }    // THE HUB / anchor
InputChannel{ ch, inst, mic, stand, notes, slotId? }     // links to a slot
Mix         { number, name, needs }                      // membership DERIVED
```

Cardinalities (the framing that clarified the whole problem):

- **Slot `1:N` InputChannel** — USC's 6 drum channels point at one slot.
- **Slot `N:1` Mix** — USC → Mix 2.
- **Mix membership** — *derived* (which slots point here), never stored.

The hub is the **stage slot** (a labeled occupant of a position-block), not the raw 9-block — a block may hold multiple slots (the grid already supports multiple occupants at one position), so two performers sharing USL each get a distinct slot with its own label and mix. Inputs link to a *slot*, not a bare block.

### The only new thing in the product

A **Position dropdown on each input row** — lists occupied stage slots (e.g. "USC — Drums"). That one column *is* the linkage. Everything else is derived.

### Mix: on the slot only. No per-channel dropdown.

- Mix is set on the stage plot (the anchor), where it already lives today.
- On the input list, the slot's mix is shown **read-only** — a derived badge ("→ Mix 2") so the monitor engineer sees routing at a glance, but it is **not** editable there.
- Monitor section stays freely editable (names/needs) and shows derived membership.

This is deliberately the status quo for mix *ownership* — we are not re-introducing the reverted lockdown, and not adding a competing editable mix surface.

### Authority / drift

There is no authority conflict to resolve, because nothing is duplicated:

- Mix is owned by the slot; input rows *inherit and display* it. Change the slot's mix → the input list's read-only badge reflects it automatically. **No sync prompts.** (The earlier draft's "last-write-wins + prompt" only existed because mix was duplicated onto channels. It isn't, so the prompt machinery is deleted from this design.)
- The **name** is a free-text label on the slot. Renaming "Drums" → "Dave" keeps every input linked, because inputs point at the **slot id**, not the string. This buys the rename-safety a performer-entity would have provided — with zero entity machinery.

### Entry point (Q3)

Any list can be started first; linkage is always *by position*:

- Build the **stage plot first** → input rows' Position dropdown lists those slots.
- Build the **input list first** → assign each row a position; if a position has no slot yet, offer to **create a pending slot** (suggest, don't silently auto-commit — respects "haven't placed people yet").
- **Mixes-first is not a real workflow** and isn't optimized for.

Inputs that belong nowhere on stage (playback DI, click, announce mic) take `slotId = none` and simply don't roll up to a wedge.

---

## Why "simple" is the right call now — and forecloses nothing

The deciding argument: **this simple design is a strict subset of the complex one.** Choosing it costs no future optionality:

- **Rename-safety:** already obtained (link by slot id), without a roster.
- **Per-channel mix override (the one pro-audio case this omits — e.g. kick to a separate wedge):** drops in later as **one optional field**, `InputChannel.mixOverride`, with the resolver becoming `channel.mixOverride ?? slot.mix`. No restructuring, no migration, no re-litigation of #53/#55.

So this is **not a one-way door.** We ship the ~95% case in a shape the 5% case bolts onto cleanly. That is the explicit permission to keep it simple now.

### On Constraint/Prior-Art "must preserve per-input override"

The earlier draft asserted any design *must* preserve a per-input mix override. This proposal **consciously defers** that, on the judgment that split-routing-per-channel is rare at this venue tier (variety/club), AND because the deferral is cheap to reverse (one field, as above). Flagging explicitly so the reviewer can challenge the YAGNI call rather than have it buried.

---

## Migration

A non-event. `slotId` on `InputChannel` and any new field are **optional**:

- Existing shows load with inputs unlinked (`slotId` absent) and behave exactly as today.
- Linking is **opt-in per row** via the new Position dropdown.
- Stage slots already carry mix; nothing changes there.
- YAML: `slotId` serializes per input row; absent on legacy rows, ignored by the parser.

---

## Already Shipped (was "buildable now" in the v1 draft — now done)

These were independent of the linkage redesign and landed in the S31 polish pass:

1. **"No mix" option** — `null`/0 mix on stage slots; dropdown includes "None"; no "Mix 0" badge on the plot.
2. **Mix dropdown on stage plot** — bare integer replaced with a validated dropdown of defined mixes.
3. **Mix name editing** — mix labels editable from the monitor section.

(Listed so the reviewer doesn't re-propose them.)

---

## Open Questions for Review

1. **YAGNI on per-channel mix override** — is deferring it (with the cheap-to-add escape hatch) acceptable for the Bohemian Club pro-tester tier, or do they split-route often enough that it should ship in v1?
2. **Pending-slot creation from input-first flow** — is "offer to create a slot" the right UX, or should input rows be allowed to reference a position-block with no slot (looser)?
3. **Multiple slots per block display** — does the input list's Position dropdown need to disambiguate two occupants at the same block (e.g. "USL — Dave" vs "USL — Mike"), and is `label` always populated enough to do so?
4. **Read-only mix on input list** — confirm a derived badge (not an editable control) is the right call; any monitor-engineer workflow that needs to edit mix *from* the input list?
5. **Console/export impact** — does deriving mix membership from slots cleanly feed the existing console export (CSV/XML) without reintroducing the `a0aee19` "drop monitor mix" problem?

---

## Status

Proposed and internally reasoned (see question trail). **Not yet built.** Pending Codex adversarial review; build only after sign-off.
