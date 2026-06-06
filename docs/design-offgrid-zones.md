# Design: Off-Grid Zones (PIT / FOH / OTHER)

**Status:** Deferred follow-on — captured, not yet scheduled
**Date:** 2026-06-06
**Spun out of:** `docs/design-input-plot-linkage.md` v4 "Scope decision" (descoped from linkage v1)

---

## Why this doc exists

`StagePosition` already includes three positions that live **outside** the 3×3 on-grid layout:

```
PIT     // orchestra pit
FOH     // front of house (engineer position)
OTHER   // catch-all for non-standard positions
```

(`lib/types.ts:1`.) They are **type-valid but un-rendered**: the stage-plot grid only paints the nine on-grid zones (`app/[owner]/[show]/page.tsx:872`+), and the AI agent is **explicitly told never to use them** (`lib/agent.ts:12`).

Linkage v4 deliberately **descoped** off-grid rendering so the multi-mix-per-block work could ship on the nine on-grid blocks (where the approved mockup already placed the strings/brass example — on **MSR**, not a literal pit). This doc captures what off-grid support would require so the decision isn't lost and the follow-on has a starting point.

This is **not** in scope for linkage v1. Build only if/when the show runner confirms a real need (e.g. a literally-rendered orchestra pit for a Bohemian Club show).

---

## The need (when it lands)

- **PIT** — orchestra pit: often a *real* multi-mix zone (strings on one wedge, brass on another). The genuine driver if it appears.
- **FOH** — the engineer position; not a performer zone. Useful to show talkback / playback / measurement sources and the engineer's own wedge.
- **OTHER** — non-standard placements (lobby, balcony, off-stage choir) that don't map to the 3×3.

All three must compose with the linkage model already built: each is still a **block that can host multiple slots**, each slot has a stable `id`, inputs link by `slotId`, mix is owned by the slot. Off-grid is purely a **rendering / addressing** extension — the data model from linkage v4 already supports it unchanged.

---

## Design elements required

A follow-on must define all of the below; none are addressed by linkage v1.

### 1. Render surface
- An **off-grid region** rendered *below* the 3×3 grid (and below the AUDIENCE/FOH footer), e.g. a labeled strip per occupied off-grid zone: `PIT`, `FOH`, `OTHER`.
- Each off-grid zone reuses the **container cell** pattern from linkage v4 (TLA header + stacked occupant chips + per-mix color badge + `×n inputs` + "+ add occupant"), so multi-occupant behavior is identical to on-grid blocks.
- Off-grid zones render **only when occupied** (mirrors the conditional mid-stage row), to avoid clutter for the common no-pit show.

### 2. DnD targets
- Off-grid zones become valid **drop targets** (`drop-PIT`, `drop-FOH`, `drop-OTHER`) so a slot can be dragged on/off grid; per-occupant drag (`drag-${slot.id}`) is unchanged.
- Decide whether dragging *between* on-grid and off-grid is allowed (likely yes — re-parenting a slot's `pos` already rides the id and preserves links).

### 3. Input-list Position dropdown
- Dropdown options extend to off-grid occupied slots: `PIT — Strings`, `PIT — Brass`, `FOH — Talkback`, etc. (same `TLA — name` format, same slot-owned fallback labels).
- "+ New occupant at…" gains `PIT`/`FOH`/`OTHER` as block choices.

### 4. Print / read-only plot
- Off-grid zones print **all occupants** (same rule as on-grid). Decide placement on the printed page — likely a dedicated "Off-stage / Pit" block beneath the stage diagram.

### 5. AI agent changes
- Extend `POS_ENUM` (`lib/agent.ts:49`) to include `PIT`/`FOH`/`OTHER`.
- Remove the prohibition at `agent.ts:12` and replace with **guidance** on when to use them ("use PIT for an orchestra pit, FOH for engineer/talkback/playback sources, OTHER for non-standard placements; prefer the 3×3 for the band").
- The reconcile contract (upsert-by-id, `clientRef`, `slotRef`, `removedIds`, confirm-gate, atomic cascade apply) needs **no change** — it's position-agnostic.

### 6. Console export
- No change required: linkage v1 keeps mix off the export entirely (see linkage doc "Console / export — unchanged this phase"). Off-grid slots are just more slots; nothing about them touches the export. (If the future Input Sends phase adds sends to the export, off-grid slots flow through it unchanged — but that's that phase's concern, not this one.)

---

## Open questions (for whenever this is scheduled)

1. **OTHER labeling** — is a single `OTHER` block enough, or does the show runner need multiple named custom zones (lobby, balcony, choir loft)? If multiple, `OTHER` needs a user-supplied zone label, which is a bigger model change than PIT/FOH.
2. **FOH semantics** — is FOH a true monitor zone (the engineer's wedge / IEM) or just a labeling bucket for non-stage sources? Affects whether FOH slots carry a `mix`.
3. **Print layout** — where do off-grid zones sit on the printed stage plot without crowding the diagram?

---

## Status

Captured and parked. Not scheduled. Promote into a numbered design + build only on show-runner confirmation of need. Linkage v1 proceeds without it.
