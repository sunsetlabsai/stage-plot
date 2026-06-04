# Design: Input List / Stage Plot / Mix Linkage

**Status:** Early thinking — NOT build-ready
**Date:** 2026-06-04

---

## Problem

Three independent lists describe the same cast of people/instruments from different angles:

| List | Primary Anchor | Fields |
|------|---------------|--------|
| Stage Plot | Position (9-block grid) | name, role, pos, mix |
| Input List | Channel number | ch, inst, mic, stand, notes |
| Monitor Mixes | Mix number | mix, name, needs |

There's no shared entity linking them. "Dave — Drums" appears as a stage slot (USC, Mix 2), six input channels (kick, snare, OH L, OH R, tom 1, tom 2), and is referenced by mix number — but they're not connected. Change the name in one place, the others don't know. Add inputs, still have to manually add a stage slot. The mix number in the stage slot is a bare integer with no validation against actual mixes.

The AI copilot handles this seamlessly because it sees everything at once. Manual setup has no such advantage.

---

## Constraints

1. **Each list's primary anchor is legitimate and can't be violated.** Input list is channel-centric (6 drum channels → 1 position). Stage plot is position-centric (1 grid slot per person). Mixes are mix-centric (1 wedge, shared by whoever's near it).
2. **Cardinalities differ.** 1 position → many inputs. 1 mix → many positions. Forcing a single "performer" entity into 1:1 relationships doesn't match reality.
3. **The 9-block grid is immutable.** Positions are fixed physical reality. This is actually an advantage — stable anchor point.
4. **We tried tight coupling — too tight.** A single performer entity forced everything into artificial 1:1 relationships.
5. **Pure loose coupling = status quo.** Just autocomplete doesn't solve the authority/drift problem.

---

## Direction Under Discussion: Input-First Flow with Cross-References

Rather than mandating a starting point, allow any entry point but use **performer name as the linking key** with **cross-reference dropdowns** that propagate.

### Scenario: Building from Input List first

1. Add input channels:
   - Ch 1: Kick → performer: "Dave" → position: USC (dropdown) → mix: 4 (dropdown)
   - Ch 2: Snare → performer: "Dave" → position: USC → mix: 4
   - Ch 3: OH L → performer: "Dave" → position: USC → mix: 4
   - Ch 4: OH R → performer: "Dave" → position: USC → mix: 4
   - Ch 5: Bass DI → performer: "Mike" → position: USL → mix: 4

2. Stage plot auto-populates from input list performers:
   - USC: Dave (4 inputs) — but the grid shows clustered names, which isn't ideal
   - **Name override on stage plot:** The grid slot shows "Drums" (user-overridable label) even though the linked performer is "Dave"
   - The stage plot slot's display name and the performer name are separate: display is for the visual, performer is the link

3. Mix list reflects assignments:
   - Mix 4: Dave, Mike (auto-populated from input/stage plot assignments)
   - Mix name/label is editable: "Rhythm section" — and can be edited when new members get assigned

### Scenario: Building from Stage Plot first

1. Place performers on grid:
   - USC: "Drums" (display name), role: "Drums", mix: (none yet — dropdown shows existing mixes or "new mix")

2. When building input list later, performer dropdown shows stage plot entries
   - Selecting "Drums / USC" auto-fills position and mix from the stage plot

### Authority Model

**No single authority.** Instead: **last-write-wins with sync prompts.**

- If you change Dave's mix on the stage plot from 4 to 3, the UI prompts: "Update mix for Dave's 4 input channels too?" (Yes/No)
- If you change mix on an input channel, it doesn't auto-propagate to the stage plot — it's a per-channel override (maybe this input goes to a different mix for monitoring reasons)
- If you change the mix name/label, it's just a label change — no structural impact

This avoids the "which is authoritative" deadlock by making it explicit at the moment of change.

### The "No Mix" Problem

Currently mix 0 renders as "Mix 0" on the stage plot, which is awkward.

Fix: `null` mix = no monitor assignment. Stage plot renders no mix badge for that slot. The dropdown includes a "None" option at the top. This is a simple fix independent of the linkage redesign.

### The Mix Label Problem

Mixes get names organically as performers are assigned. Adding bass to Mix 4 (which was "Dave's mix") means the label should be editable/appendable. Mix labels are soft — just display text, not structural.

---

## Open Questions

1. **Display name vs. performer name on stage plot.** Is it confusing to have "Drums" on the grid but "Dave" as the linked performer? Or is that actually what show runners want — the instrument/role on the plot, the person's name on the input list?

2. **Auto-population direction.** If input list is built first, should stage plot auto-populate? Or just suggest? Auto-population might feel magical but also presumptuous if the user hasn't thought about positioning yet.

3. **Performer as free-text vs. entity.** If "Dave" is just a string, typos break linkage. If it's a dropdown/entity, we need to manage a performer list. The song library design (PR #59-style canonical entity) is the heavy approach; simple autocomplete from existing entries is the light approach.

4. **Multiple performers at one position.** The grid already supports this (multiple slots at USC). But the display gets cluttered. Do we need a "group" concept (e.g., "Rhythm Section" at USC = Dave + Mike)?

5. **Order of flow in the UI.** Most show runners / MDs / band leaders think stage plot or input list first — NOT mixes first. The design should support any entry point without feeling backwards.

6. **Migration.** Existing shows have no performer linkage. How do we add it without breaking existing configs? Probably: all new fields are optional, existing shows work as-is, linkage only activates when performer fields are populated.

---

## What's Buildable Now (Independent of Linkage)

These fixes don't require the full linkage redesign:

1. **"No mix" option:** `null` mix on stage slots. Dropdown includes "None." No "Mix 0" on the plot.
2. **Mix dropdown on stage plot:** Replace bare integer input with dropdown of defined mixes. Validates that the mix exists.
3. **Mix name editing:** Allow renaming/editing mix labels from the mix section.

---

## Status

Early design thinking. Not ready for build. Needs more discussion on authority model, auto-population direction, and performer identity approach.
