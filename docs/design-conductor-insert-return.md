# Conductor Authority — Live Override: Insert-and-Return

**Design-only.** This spec defines the DEFAULT semantics of a live conductor
section jump. Review the spec; do NOT build until Graham's explicit GO. Codex
review first.

Parent: `design-conductor-authority.md` §3.3 / §3.4 (the redirect / override
model). This doc **amends** the parent's line — *"Jump to a non-adjacent
section: continue forward from the target, never the origin"* — which, on
review, was settled very early and then over-generalized: it is correct for a
**forward** cut but wrong for the far more common **backward / insert** call.
This is the lost thread Graham flagged. The fix below restores it.

Prerequisite for: `design-conductor-chunk5.md` (gated auto-fire). Chunk 5's
commit produces the very `jumpTo` directive this doc reshapes, and the **return**
leg is a `stepVM` mechanic that fires on the band's natural advance — so the
directive shape and the VM rule here must settle before chunk 5 builds. Idea 1(a)
(fire-point auto-align to the next bar/section boundary) is folded into chunk 5's
D6 in that doc, not here.

---

## 0. The gesture, in the room

A music director does not usually say *"take it from the top of the bridge and
play to the end of the chart."* They say **"give me another chorus,"** **"run
the solo again,"** **"back to the top of C"** — meaning: *insert that section
here, then carry on where we were headed.* The band plays the called section
**once** and returns to the natural flow.

Today the live VM has exactly one shape for *"go to bar X"* — `jumpTo`, which
**continues forward from the target** (`roadmap-vm.ts:553`, *"leave counters
as-is"*). That is the right model for a **forward** cut ("skip to the coda") but
the **wrong default** for a backward call: jumping back to C and continuing
forward replays C → D → E → F → … — i.e. *"repeat the whole song from the
jump-in point,"* which is **not** what *"one more chorus"* means.

We already have **one** correct instance of insert-and-return: `anotherRound`
(`roadmap-vm.ts:514`) re-enters a **marked repeat** and exits naturally via the
repeat's own structure. The problem is it only works when the section happens to
be bracketed by repeat markers. This doc **generalizes** that return-semantic to
an **arbitrary section** that has no repeat brackets.

### 0.1 IS / IS NOT

**IS:**
- A reshaping of the **live** section-jump default: backward / insert jumps
  **return** to the natural successor after playing the target once.
- A small, **position-only** addition to the VM (`pendingReturn`) plus a
  section-aware **resolver** in the chart layer that fills it in.
- Pre-emptable: any subsequent live override supersedes a pending return.

**IS NOT:**
- A change to **notated** navigation. Printed D.S. / D.C. / repeats / endings
  keep their page semantics exactly (Rules 1–5 in `stepVM` unchanged). Only the
  **live conductor cue** gets the return default (§5, D7).
- A change to **forward** jumps. A forward call stays continue-from-target —
  skip semantics, no return (D1).
- A clock / auto-fire concern. The return fires on the band's **natural
  advance** through the section boundary; no tempo, no §8.2-1 fence.
- A multi-device concern. `pendingReturn` is plain serializable state and rides
  the existing wire snapshot; the local↔canonical translation is still 3b's job
  (parent §0).

---

## 1. Direction decides the default (D1, Graham-locked)

At override time, compare the **target bar's position** to the band's **current
position** (`compiled.barPos`):

| Call | Direction | Default |
| --- | --- | --- |
| Target **before** current | backward / insert | **insert-and-return** |
| Target **at-or-after** current | forward | **continue-from-target** (today's `jumpTo`) |

Rationale (Graham): *"forward jumps likely have different meaning — skip vs
repeat."* A backward call is "do that bit again"; a forward call is "cut ahead."
Same gesture, opposite intent, so direction is the right discriminator.

Position here is **cursor position in `compiled.bars`** (bar order), not a
section index — the VM's only native coordinate. A backward call is
`targetPos < currentPos`. (Edge: equal position can't be reached by a real
jump-elsewhere; treated as forward / no-op-leaning. §6.)

---

## 2. The return target — anchor's successor (D2, Graham-locked)

When a backward call inserts a section, the band returns to **the section that
was next after the one we were in when the cue was given.**

- **anchor** = the section containing the **currently-playing bar** at override
  time (`bar.sectionId` of the last emitted bar).
- **successor** = the next `SectionAnchor` after the anchor in traversal order
  (the first section whose head bar sits after the anchor's head).
- **return target** = the successor's **head bar**.

> *"If we're at section E and the conductor jumps us back to C, after C, go to
> F."* — anchor = E, successor = F, return target = F.head.

The successor is computed exactly like `armableTargets`' section heads
(`conductor-targets.ts:108-117`): each section's first bar in traversal order
(`barsInOrder`). No new section model.

**No-successor fallback (D8):** if the anchor is the **last** section (no
successor exists), there is nothing to return to — fall back to
continue-from-target (a plain `jumpTo`, no return). Honest: the band plays the
called section and runs out the natural tail.

**Section-less fallback (D8):** if the current bar has no `sectionId` (a linear /
un-calibrated chart), there is no anchor — fall back to continue-from-target.
Insert-and-return is a **section** feature; section-less charts simply don't
offer it.

---

## 3. Where it's resolved — section-aware layer, NOT the VM (D3)

`roadmap-vm.ts` is deliberately **canonical-agnostic**: it walks an ordered list
of `{ id }` bars + markers and knows **nothing** about sections (header comment,
lines 12-16). We do not break that. Instead:

- The **section-aware resolver** lives in `conductor-targets.ts` (which already
  imports `SectionAnchor` and computes section heads). It maps the
  human/section call into **bare bar positions** the VM understands.
- The **VM** gains only a `pendingReturn` register expressed in **positions**,
  and one rule to fire it. It never learns what a section is.

New resolver (sketch, `conductor-targets.ts`):

```ts
// Resolve the return leg for a backward section call. Returns the positions the
// VM needs, or null when the call is forward / has no anchor / has no successor
// (in all of which cases the caller emits a plain continue-from-target jumpTo).
export function resolveInsertReturn(
  compiled: CompiledRoadmap,
  cal: ChartCalibration,
  vm: VMState,
  targetBarId: string,
): { afterPos: number; returnBarId: string } | null {
  const targetPos = compiled.barPos.get(targetBarId);
  const curPos = vm.cursor === 0 ? 0 : vm.cursor - 1; // last EMITTED bar's pos (see note)
  if (targetPos === undefined) return null;
  if (targetPos >= curPos) return null;               // forward → no return (D1)

  const ordered = barsInOrder(cal);
  const curBar = ordered[curPos];
  const anchorSectionId = curBar?.sectionId;
  if (!anchorSectionId) return null;                  // section-less (D8)

  // successor section head, in traversal order
  const successor = nextSectionHeadAfter(ordered, cal, anchorSectionId);
  if (!successor) return null;                         // anchor is last (D8)

  // afterPos = last contiguous bar of the TARGET section in bar order
  const afterPos = lastBarPosOfSection(compiled, ordered, targetBarId);
  return { afterPos, returnBarId: successor.id };
}
```

> **`vm.cursor` vs last-emitted note.** `vm.cursor` is the *next candidate*
> index, so the band's current bar is at `cursor - 1` after an emission. The
> resolver runs against the **live** vm at override time; the session layer
> already holds `state.current` (the last `TraversalStep`), so the build can
> pass `current.barId` directly rather than re-deriving — cleaner and exact.
> (Spec keeps the position form for clarity; build picks the tidier source.)

`afterPos` is **the target section's last bar in bar order** — the natural
forward exit of the inserted section. Computed by the section-aware layer so the
VM stays section-blind.

---

## 4. The directive — one optional field on `jumpTo` (D4)

Rather than a new directive kind (which would fork every switch and the chunk-3
wire enum), add an **optional** return leg to the existing `jumpTo`:

```ts
// roadmap-vm.ts
| { kind: 'jumpTo'; barId: string; exit?: ExitPolicy;
    // Insert-and-return (live backward/insert call). Absent ⇒ continue-from-
    // target (forward cut + notated jumps), today's behavior, unchanged.
    return?: { afterPos: number; returnBarId: string } }
```

- **Absent** `return` ⇒ identical to today (forward cuts, notated jumps).
- **Present** `return` ⇒ insert-and-return.

`Armed.directive` is already `Extract<Directive, { kind: 'jumpTo' }>`
(`conductor-state.ts`), so the armed envelope carries the return leg for free —
**no chunk-3/4 wire change** beyond the new optional field on the one directive.

---

## 5. The VM rule (`applyOverride` + `stepVM`)

### 5.1 `VMState` gains one serializable field

```ts
// roadmap-vm.ts VMState
// Live insert-and-return: after the inserted section's last bar exits FORWARD,
// jump here once, then clear. null = no pending return. Plain record → wire-safe.
pendingReturn: { afterPos: number; returnPos: number } | null;
```

(`returnPos` = `barPos(returnBarId)`, resolved in `applyOverride` so `stepVM`
stays position-only.)

### 5.2 `applyOverride` — set on this directive, CLEAR on any other (D5)

Every override first **clears** `pendingReturn` (a new live cue supersedes the
old plan — Graham: *"in lieu of a subsequent manual override"*), then the
`jumpTo` case sets it iff a return leg is present:

```ts
// every case begins by clearing the old plan:
s.pendingReturn = null;
// ... existing per-directive logic ...
case 'jumpTo': {
  const pos = compiled.barPos.get(directive.barId);
  if (pos === undefined) return s;
  s.cursor = pos;
  s.done = false;
  if (directive.return) {
    const returnPos = compiled.barPos.get(directive.return.returnBarId);
    if (returnPos !== undefined) {
      s.pendingReturn = { afterPos: directive.return.afterPos, returnPos };
    }
  }
  // ... exit-arming unchanged ...
  return s;
}
```

### 5.3 `stepVM` — fire on the natural FORWARD exit (D6)

The return must fire **only** when the inserted section completes and the VM
would advance **forward** past it — never when an internal repeat back-jumps
inside the section (so a section containing its own repeats loops correctly
first, then returns). Concretely, after `stepVM` computes its next cursor by the
normal rules, add a final interception:

```ts
// After the normal end-edge rules + advance have set s.cursor for the NEXT step,
// and we have just emitted the bar at `transition.barId`:
if (s.pendingReturn && barPos(transition.barId) === s.pendingReturn.afterPos
    && s.cursor > s.pendingReturn.afterPos) {     // advanced FORWARD, not back-jumped
  s.cursor = s.pendingReturn.returnPos;
  s.pendingReturn = null;
  s.done = false;
}
```

- Guard `s.cursor > afterPos` distinguishes a **forward exit** (return now) from
  a **back-jump** caused by an internal repeat (let it loop; the register
  survives until the section's final forward pass).
- One-shot: cleared on fire.
- The return is **automatic** — it rides the band's natural advance to the
  section boundary. No MD tap, no clock. This is why it's a `stepVM` mechanic,
  not a second commit.

### 5.4 `anotherRound` stays the primitive for real repeats (D7)

When the called target **is** a real marked repeat, `anotherRound`
(`roadmap-vm.ts:514`) already does insert-and-return via the repeat's own
structure and remains the **preferred** redirect (`availableRedirects` already
offers it for `times > 1` / ending groups, `conductor-targets.ts:173`).
Insert-and-return via `jumpTo.return` is for an **arbitrary** section with **no**
repeat brackets. The two never both apply to one call: the target picker offers
`anotherRound` for real repeats, the section-jump-with-return for plain sections.
No double-handling.

---

## 6. Edge cases

| Case | Behavior |
| --- | --- |
| Forward target (`targetPos >= curPos`) | continue-from-target (no return). D1. |
| Anchor is the last section | no successor → plain `jumpTo`, no return. D8. |
| Section-less / linear chart | no anchor → plain `jumpTo`, no return. D8. |
| Target section contains internal repeats | repeats loop first; return fires on the **final forward** exit (§5.3 guard). |
| MD jumps **again** while a return is pending | new override clears the old `pendingReturn` and (if itself backward) computes a **fresh** anchor = the section we're in **now** → its own successor. Each cue inserts relative to where we are. (D5; OQ1.) |
| Return target equals the inserted section (degenerate) | `returnPos === afterPos+...`; harmless one-shot. |
| Inserted section never reached (`done` first, or another jump) | `pendingReturn` simply never fires; cleared by the next override or song end. |
| Stale `afterPos` after a hand-edited chart | unknown/never-matched position ⇒ never fires (safe no-op), mirrors `applyOverride`'s unknown-target tolerance. |

---

## 7. Reconciliation with the parent doc

`design-conductor-authority.md` line ~112 currently reads:

> *Jump to a non-adjacent section: continue forward from the target, never the
> origin.*

**Amend to:**

> *Live section jump — **backward / insert** (the common "another chorus / run
> the solo again" call): insert the target once, then **return to the section
> that was next after the one we were in** (anchor's successor), unless a
> subsequent override pre-empts it. **Forward** cuts continue forward from the
> target (skip semantics). Notated D.S./D.C./repeats are unchanged.*

This is a doc-text amendment only (no code in the parent). Make it part of the
build PR so the canonical spec stays honest.

---

## 8. Decisions

- **D1** — Direction discriminates: backward/insert ⇒ return, forward ⇒
  continue-from-target. **Graham-locked.**
- **D2** — Return target = anchor's successor section head; anchor = section of
  the currently-playing bar at override time. **Graham-locked.**
- **D3** — Resolve into **bar positions** in the section-aware layer
  (`conductor-targets.ts`); the VM stays section-blind. **Recommend YES.**
- **D4** — Carry the return leg as an **optional field on `jumpTo`**, not a new
  directive kind. **Recommend YES.**
- **D5** — Any subsequent override clears the pending return (manual supersedes).
  **Graham-locked** (follows from "in lieu of a subsequent override").
- **D6** — Return fires only on the **natural forward** section-exit (post-step
  cursor advanced past `afterPos`); internal repeats loop first. **Recommend
  YES** (correctness).
- **D7** — Notated jumps & marked repeats unchanged; `anotherRound` stays the
  primitive for real repeats, `jumpTo.return` is for arbitrary sections.
  **Graham-locked.**
- **D8** — No successor / section-less ⇒ fall back to continue-from-target.
  **Recommend YES.**

---

## 9. Open questions

- **OQ1** — Re-cue while a return is pending: spec assumes each new backward cue
  recomputes its anchor from the **current** section (so jumping C→A while
  pending-return-to-F yields a new return to D, not F). Confirm this "insert
  relative to where we are now" model vs. "preserve the original return."
- **OQ2** — MD readout / telegraph: should the change-marker badge show the
  return target ("**C** ↩ then **F**") and, on the inserted section's last bar,
  telegraph the imminent return? Pure UI; lands in chunk 5's telegraph work, but
  worth confirming the copy intent here.
- **OQ3** — Should the MD ever be offered an **explicit "skip (no return)"** on a
  backward target, overriding the default? Graham's model says backward = return
  by default; no toggle was asked for. Defaulting only; flag if a future "cut
  back and stay" call appears.

---

## 10. Test plan (pure lib — `lib/roadmap-vm.ts` + `lib/conductor-targets.ts`)

vitest node env (these are pure modules; no jsdom). New cases:

- `resolveInsertReturn`:
  - backward call inside section E → returns `{ afterPos = last bar of C,
    returnBarId = F.head }`.
  - forward call → `null`.
  - anchor is last section → `null`.
  - section-less / null `sectionId` → `null`.
- `applyOverride`:
  - `jumpTo` with `return` sets `pendingReturn`; without, leaves it null.
  - any other directive issued afterward clears `pendingReturn`.
  - unknown `returnBarId` ⇒ `pendingReturn` stays null (safe).
- `stepVM`:
  - plays the inserted section once, then lands on the return target on the
    natural forward exit; `pendingReturn` cleared.
  - inserted section with an internal repeat: loops the repeat first, returns on
    the final forward exit (the §5.3 guard).
  - a second override before the boundary pre-empts the return.
  - notated repeats/jumps elsewhere unaffected (regression: existing roadmap
    fixtures still resolve identically).

Report the test-count delta on the build PR.

---

## 11. Build outline (DESIGN-ONLY — do not build until GO)

1. `roadmap-vm.ts`: add `pendingReturn` to `VMState` (+ `initVM` null);
   `jumpTo.return` optional field; `applyOverride` clear-then-set; `stepVM`
   §5.3 interception. + tests.
2. `conductor-targets.ts`: `resolveInsertReturn` + the two helpers
   (`nextSectionHeadAfter`, `lastBarPosOfSection`). + tests.
3. Wire the resolver into the arm/commit path (`use-conductor-session.ts` /
   `conductor-session.ts`): a backward `jumpTo` target carries the resolved
   return leg; forward stays plain. (This is the chunk-4/5 seam; coordinate with
   chunk 5's arming.)
4. Amend `design-conductor-authority.md` §3.3/§3.4 line per §7.
5. MD readout/telegraph copy (OQ2) — only if confirmed; else defer to chunk 5.

Full local gate (`npm test` + lint + type-check) before any push; ShowRunr
commits direct to main per process.
