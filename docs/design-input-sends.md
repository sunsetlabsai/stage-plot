# Design: Input Sends (send matrix)

**Status:** Deferred future phase — captured, not yet scheduled
**Date:** 2026-06-06
**Spun out of:** `docs/design-input-plot-linkage.md` v5 (Q6 conceptual call)

---

## Why this doc exists

Linkage v1 deliberately keeps **mix off the input list**. Mix is a property of the **slot/performer** (who shares a wedge, where it sits) — *grouping*, not routing. What it intentionally does **not** model is **input sends**: which input channels feed each monitor mix, and at what level. That is the mix engineer's showtime job today.

During the v5 review the show runner floated the natural next step — and it's a good idea worth not losing:

> "We'd need N mix dropdowns on the input list (N = number of mixes) and then say where we want to send the respective input… this is NOT a bad design idea, and maybe it'd rationalize having the mix reference on the input list."

It was **excluded from v1 for clarity**: a mix reference on an input row, without a real send model behind it, implies a "flip-to-fade" aux/send relationship (input faders driving a discrete mix) that doesn't exist. Sends are the *correct* home for any input↔mix relationship — so they get their own phase rather than a half-built hint in v1.

This doc captures the shape so the idea isn't lost and the future phase has a starting point. **Not in scope for linkage v1.**

---

## The concept (when it lands)

A **send matrix**: for each input channel, which monitor mixes it is sent to (and eventually, how much).

This **supersedes and absorbs** the old "per-channel mix override" idea (a single channel routed to a different wedge than its slot) — that's just one cell of the matrix. It would also *earn* a mix/sends surface on the input list, which v1 omits on purpose.

It builds **on top of** the linkage v1 foundation unchanged:
- Slots own the *monitor grouping* (who's on each wedge).
- Inputs link to slots by `slotId` (organization/coherence).
- Sends add a **separate** input→mix relationship layer; they do not replace slot-owned mix grouping.

---

## Design elements required (sketch)

A follow-on must define all of the below; none are in linkage v1.

### 1. Data model
- A per-channel send set, e.g. `InputChannel.sends?: number[]` (mix numbers) or a richer `{ mix, level }[]` if levels are captured.
- Decide: booleans (sent / not) for v-first, vs. levels (dB / 0–100) for a true matrix.
- Relationship to `slot.mix`: is the performer's own wedge an *implicit* send (the channel is always sent to its slot's mix), with the matrix adding *additional* destinations? Likely yes — define the default.

### 2. Input-list UI
- N mix toggles/dropdowns per input row (N = defined mixes), or a compact matrix/grid view (channels × mixes) which scales better than N columns on a wide board.
- This is where a **mix reference returns to the input list** — legitimately, because now it means a real send.

### 3. Console export
- Sends are exactly what a console patch/scene export *wants*. Add a sends representation to CSV/XML (e.g. a `Sends` column listing mix numbers, or a matrix block). This is the point at which mix re-enters the export — as routing, intentionally.

### 4. AI agent
- A tool to set/adjust sends, folded into the existing reconcile contract (upsert-by-id, `removedIds`, confirm-gate) — position-agnostic, so no contract change, just a new field/tool.
- Prompt guidance on sensible default send patterns (e.g. a performer's own instrument hot in their mix; rhythm section shared).

### 5. Print / read-only
- A sends/matrix view for the engineer's printed reference.

---

## Open questions (for whenever this is scheduled)

1. **Booleans vs. levels** — does the venue tier want actual send levels, or just routing (sent / not)? Levels are a much bigger UI and data lift.
2. **Implicit own-wedge send** — is a channel always implicitly sent to its slot's mix, or must every send be explicit?
3. **Matrix vs. per-row** — channels × mixes grid (scales) vs. N dropdowns per input row (simpler, crowds fast). Likely matrix once N grows.
4. **Re-introducing mix on the input list** — confirm this is the phase where that becomes correct and non-confusing (because it now means a send).

---

## Status

Captured and parked. Not scheduled. Promote into a numbered design + build only on show-runner confirmation of need. Linkage v1 proceeds without it, intentionally mix-free on inputs.
