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
// Resolve the return leg for a backward SECTION call. Returns the positions the
// VM needs, or null when the call is not a section / forward / has no anchor /
// has no successor (in all of which cases the caller emits a plain
// continue-from-target jumpTo).
export function resolveInsertReturn(
  compiled: CompiledRoadmap,
  cal: ChartCalibration,
  target: JumpTarget,        // pass the whole target, NOT just the bar id — see D9
  currentBarId: string | undefined,  // the LAST-EMITTED bar — see HIGH-1 note
): { afterPos: number; returnBarId: string } | null {
  // D9 (Codex R1 MEDIUM-2): insert-and-return is a LIVE SECTION-JUMP default ONLY.
  // armableTargets also yields coda/segno/fine landmarks, repeat starts, and plain
  // bars — a backward jump to any of those stays continue-from-target. Gate on kind.
  if (target.kind !== 'section') return null;

  const targetPos = compiled.barPos.get(target.barId);
  const curPos = currentBarId ? compiled.barPos.get(currentBarId) : undefined;
  if (targetPos === undefined || curPos === undefined) return null;
  if (targetPos >= curPos) return null;               // forward → no return (D1)

  const ordered = barsInOrder(cal);
  const anchorSectionId = ordered[curPos]?.sectionId;
  if (!anchorSectionId) return null;                  // section-less (D8)

  // successor section head, in traversal order
  const successor = nextSectionHeadAfter(ordered, cal, anchorSectionId);
  if (!successor) return null;                         // anchor is last (D8)

  // afterPos = last contiguous bar of the TARGET section in bar order
  const afterPos = lastBarPosOfSection(compiled, ordered, target.barId);
  return { afterPos, returnBarId: successor.id };
}
```

> **HIGH-1 (Codex R2) — current bar is NOT `vm.cursor - 1`.** `vm.cursor` is the
> *next candidate* index, and after a repeat back-jump (`roadmap-vm.ts:433`) or a
> D.S./D.C. jump (`:470`) `stepVM` emits a bar and then repositions the cursor
> **elsewhere**, so `cursor - 1` is not the bar the band just played. Deriving
> direction/anchor from it would compute "forward vs backward" against the wrong
> bar and pick the wrong return target. The resolver therefore takes the
> **last-emitted bar id explicitly** — the session layer already holds it as
> `state.current.barId` (the last `TraversalStep`). `barPos(currentBarId)` is the
> position used for the direction test and the anchor lookup.

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

### 4.1 WHEN the return leg is resolved — at ISSUE time, never at fire time (HIGH, Codex R3)

**This is load-bearing.** `commit` applies `state.armed.directive` **verbatim** —
it does **not** re-run any resolver (`conductor-state.ts:233-244`,
`applyOverride(compiled, state.vm, state.armed.directive)`). So the resolved
`return` leg **must already be baked into `Armed.directive` when the jump is
armed.** Likewise the immediate `redirect` path applies the directive as issued
(`:221-223`). In both cases `resolveInsertReturn` runs at the moment the MD
**issues the gesture** (arm or redirect-now), using the **last-emitted bar at
that instant** (`state.current.barId`) as `currentBarId`, and the result is
stored in the directive.

Why it cannot be deferred to fire/commit: the anchor is *"the section of the
currently-playing bar **at override time**"* (D2). Between arm and auto-fire the
band keeps advancing — the playhead may move from E to F. If the return leg were
resolved at fire time, an `E → C` call would compute its return against F and
yield `F → C → G` instead of the intended `E → C → F`. Resolving at issue time
freezes the anchor correctly.

Concretely the arm seam is `arm(target, exit, fireAt, currentBarId)`, but the
resolution happens **inside `resolveArm` against a freshly re-derived target** — not
in the hook against the passed object (§4.3). The hook only forwards a **stable
identity** + the `currentBarId`; `resolveArm` re-derives, bakes the return leg, and
mints `Armed.directive`; `commit` later applies it unchanged.

### 4.3 `resolveArm` reshape — re-derive identity, then bake (HIGH, Codex R5)

`resolveArm` (`conductor-targets.ts:225`) carries a standing safety rule: **the
controller must NOT trust the passed target object** — a stale/spoofed envelope can
carry a bad `barId` *and* a spoofed `exitOptions`, so it re-derives from a fresh
`armableTargets(compiled, cal)`. Two things change now that `kind` decides whether a
return is baked:

1. **Re-derive by a stable identity, not `barId` alone.** `armableTargets` legally
   emits **several targets for one bar** (Coda + a section head + Repeat-all can all
   sit on bar 1 — `ConductorCluster.tsx:129-132`, composite key `kind:barId:label`).
   `find(t => t.barId === barId)` would pick an arbitrary one, and `kind` now controls
   return-baking. So match on `{ barId, kind, label }` and **reject (null) on no-match
   OR ambiguity** — never guess.
2. **The default return is suppressed by a REQUESTED exit (the `exit` ARG), not the
   kept/validated one (D10, Codex R5 MEDIUM).** `JumpTarget` does not carry the chosen
   exit; the `exit` argument does. If a requested exit is *dropped* during validation
   (out of the recomputed `exitOptions`), the code must **still not** bake a return —
   else *"back to C, al Coda"* with a stale exit would silently become *"back to C,
   return to F."* So gate on `exit === undefined` (nothing requested), independent of
   whether the exit survives validation.

```ts
export function resolveArm(
  compiled: CompiledRoadmap,
  cal: ChartCalibration,
  id: { barId: string; kind: JumpTarget['kind']; label: string },  // stable identity, NOT the raw object
  exit: ExitPolicy['kind'] | undefined,
  fireAt: string,
  currentBarId: string | undefined,
): Armed | null {
  if (!compiled.barPos.has(fireAt)) return null;
  const matches = armableTargets(compiled, cal).filter(
    (t) => t.barId === id.barId && t.kind === id.kind && t.label === id.label);
  if (matches.length !== 1) return null;            // no match OR ambiguous → reject (stale/spoofed)
  const target = matches[0];                         // FRESH, authoritative target

  const keepExit = exit !== undefined && target.exitOptions.includes(exit) ? exit : undefined;
  // exit XOR return (D10): a REQUESTED exit suppresses the default return — even a
  // stale exit that fails validation (keepExit === undefined). Gate on `exit`, not keepExit.
  const ret = (exit === undefined && target.kind === 'section')
    ? resolveInsertReturn(compiled, cal, target, currentBarId)   // against the FRESH target
    : null;

  const directive = {
    kind: 'jumpTo',
    barId: id.barId,
    ...(keepExit && { exit: { kind: keepExit } }),
    ...(ret && { return: ret }),
  } as const;
  return { fireAt, directive };
}
```

`resolveInsertReturn` runs against the **re-derived** target, so its `kind` gate (D9)
is judged on the authoritative entry, never the passed object. (`commit` then applies
`Armed.directive` verbatim — §4.1.)

### 4.2 `exit` and `return` are mutually exclusive (D10, HIGH — Codex R3)

A `jumpTo` may carry an MD-specified `exit` (`alCoda`/`alFine`) **or** an
insert-`return`, **never both**. *"Back to C, al Coda"* is an explicit instruction
about **how to leave** the inserted material — the MD has named the departure, so
the default *"play it once and come back"* return does **not** apply. This matches
the parent model (*MD-specified exit wins*) and D7 (notated/explicit nav is
authoritative).

Why not "define a precedence" instead of forbidding? Because an armed exit and a
pending return are not orderable into one coherent outcome:

- `applyOverride`'s exit-arming sets `alCodaArmed`/`alFineActive` (`roadmap-vm.ts:565-578`).
  If a return *also* fired, the band would jump back to F **with the exit still
  armed** — the next To Coda/Fine anywhere downstream would then divert
  unexpectedly. A stranded armed exit is a latent bug, not a defined behavior.
- Conversely, if the exit fires (To Coda → Coda), the band has left toward the
  ending; there is no musical sense in which it then "returns to F." `al Coda`/
  `al Fine` are terminal-ward by construction.

So the **seam never sets both** (§5.2 sets the return leg only when `!directive.exit`),
and the resolver is never asked to attach a return to an exit-bearing jump. A
backward *"another chorus"* call with no named exit gets the default return; a
backward call **with** a named exit is a plain exit-armed `jumpTo` (continue-from-
target + the exit), today's behavior.

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

### 5.2 `applyOverride` — clear iff nav state actually changed; set on a no-exit `jumpTo` leg (D5)

A real MD override supersedes a pending return (Graham: *"in lieu of a subsequent
manual override"*) — but **only a real one**.

**Root cause, not per-case (Codex R3 MEDIUM): clear iff the directive ACTUALLY
CHANGES VM nav state.** The previous drafts gated the clear on per-case
*mutation conditions* hand-derived for each directive (`s.holding !== id`,
`s.fired[id] === true`, "a valid jumpTo always moves the cursor", "a valid
anotherRound always re-seats"). That is leak-prone — Codex found two more
effect-no-ops it missed: a **same-cursor `jumpTo`** (`pos === s.cursor`, no
exit) re-seats nothing, and a **duplicate `anotherRound`** re-seats the cursor
and `completedPasses` to the values they already hold. Each new case is another
place to get it wrong.

So `applyOverride`'s existing per-directive logic stays **`pendingReturn`-agnostic**
(it never reads or writes `pendingReturn`; `cloneState` already carries the prior
value forward), and a **single trailing policy clause** owns the register —
driven by a structural before/after comparison of the navigation-relevant fields:

```ts
// the 6 nav-relevant VMState fields — NOT passCount (telemetry) and NOT
// pendingReturn itself (the thing we're deciding).
function sameNav(a: VMState, b: VMState): boolean {
  return a.cursor === b.cursor
    && a.holding === b.holding
    && a.done === b.done
    && shallowEqualRecord(a.completedPasses, b.completedPasses)
    && shallowEqualRecord(a.fired, b.fired)
    && a.flags.toCodaFired === b.flags.toCodaFired
    && a.flags.alFineActive === b.flags.alFineActive
    && a.flags.alCodaArmed === b.flags.alCodaArmed;
}

export function applyOverride(compiled, stateIn, directive): VMState {
  const s = applyOverrideCore(compiled, stateIn, directive); // existing switch, unchanged + pendingReturn-blind
  // ── single pendingReturn policy: act ONLY when this override genuinely changed nav ──
  if (!sameNav(stateIn, s)) {
    s.pendingReturn = null;                                  // any genuine nav override supersedes (D5)
    // Install the fresh return leg INSIDE the same guard — a no-op jumpTo (unknown
    // barId, or same-cursor no-exit) leaves nav unchanged, so it must NOT install a
    // return for a jump that never applied (Codex R6 HIGH). For a no-exit jumpTo,
    // !sameNav is exactly "the cursor actually repositioned."
    if (directive.kind === 'jumpTo' && directive.return && !directive.exit) {
      const returnPos = compiled.barPos.get(directive.return.returnBarId);
      if (returnPos !== undefined) {
        s.pendingReturn = { afterPos: directive.return.afterPos, returnPos };
      }
    }
  }
  return s;
}
```

This is one rule, applied once. Every effect-no-op — unknown `jumpTo` (even one
**carrying a valid `returnBarId`** — Codex R6), same-cursor no-exit `jumpTo`,
`resetJump` on a not-fired jump, `release` while not holding, duplicate `hold`,
duplicate `anotherRound` — leaves `stateIn` nav-equal to `s`, so the whole policy
block is skipped and `pendingReturn` is preserved automatically, with no per-case
reasoning to maintain. A genuine override (cursor moved, counter bumped, flag armed,
vamp parked/released) clears it — and, **iff** that genuine override is a no-exit
`jumpTo` with a return leg, re-installs the fresh return. The clear and the set share
one `!sameNav` guard, so a return is never installed for a jump that didn't apply.
(`shallowEqualRecord` = same keys + same values; `completedPasses`/`fired` are flat
`Record<string, number|boolean>`.)

**`exit` XOR `return` (D10, Codex R3 HIGH).** The fresh return leg is set **only
when the `jumpTo` carries no explicit `exit`**. See §4.2 — an MD-named exit defines
how the inserted material is left, so it suppresses the default return; arming an
exit *and* a return would strand a live `alCodaArmed`/`alFineActive` after the return
fired. With R5's `resolveArm` reshape (§4.3) the XOR is already enforced **upstream**
— no armed directive ever carries both — so this `!directive.exit` gate is
**defense-in-depth**: it also covers any hand-built `redirect`-now directive and keeps
`applyOverride` correct in isolation, without relying on the resolver's discipline.

### 5.3 `stepVM` — fire on the natural FORWARD exit (D6)

The return must fire **only** when the inserted section completes and the VM
would advance **forward** past it — never when an internal repeat back-jumps
inside the section (so a section containing its own repeats loops correctly
first, then returns).

**CRITICAL (Codex R1 HIGH-1): there are TWO emission paths.** `stepVM` has an
**early `compiled.linear` branch** (`roadmap-vm.ts:383`) that records → advances →
returns *before* the non-linear end-edge rules ever run — and a chart with
**sections but no roadmap markers compiles `linear`** (`compileRoadmap`,
`roadmap-vm.ts:120`). That is the **most common "plain section" case** — exactly
the one this feature targets. An interception placed only after the end-edge
rules would **never fire** for it. So the interception is factored into a shared
helper applied at the **two natural-forward-advance points only** — the linear
branch and the Rule-6 `if (!handled)` advance block — and **NOT** before the shared
main-path `:504` return (which every end-edge rule reaches; see the main-path bullet
below for why gating there would clobber a notated To Coda):

```ts
// roadmap-vm.ts — called on the NATURAL FORWARD ADVANCE only: the linear branch
// (always a plain advance) and the Rule-6 advance block (the `if (!handled)` path).
// s.cursor has already been advanced to emittedPos+1 by that advance logic.
function applyPendingReturn(s: VMState, emittedPos: number): void {
  if (s.pendingReturn
      && emittedPos === s.pendingReturn.afterPos
      && s.cursor > s.pendingReturn.afterPos) {   // forward advance (cursor = emittedPos+1)
    s.cursor = s.pendingReturn.returnPos;
    s.pendingReturn = null;
    s.done = false;                                // cancel an end-of-song done if we just hit it
  }
}
```

`emittedPos` is the **bar order position** of the bar we just emitted
(`compiled.barPos.get(transition.barId)` — equivalently `compiled.bars[k]` in the
linear branch). Both call sites already hold it.

- **Linear branch (`roadmap-vm.ts:383-393`):** after `s.cursor++` and its `done`
  check, call `applyPendingReturn(s, posOfEmittedBar)` before the early return. A
  linear chart has no end-edge rules — every step is a forward advance — so the
  return fires on the section's last bar (`s.cursor === emittedPos + 1 > afterPos`).
- **Main path — ONLY inside the Rule-6 `if (!handled)` advance block
  (`roadmap-vm.ts:499-502`), NOT before the shared `:504` return (HIGH, Codex R3).**
  The `:504` return is reached by *every* end-edge rule, several of which
  **reposition the cursor**: Rule 2a/2b back-jumps (`:441/:446/:458/:463`), Rule 3
  D.S./D.C. (`:477`), and Rule 4 **To Coda** (`:487`). If `applyPendingReturn` ran
  before `:504` unconditionally, a notated **To Coda** that fires *on* `afterPos`
  (landing the cursor forward at the Coda) would satisfy `s.cursor > afterPos` and
  the return would silently **clobber the Coda** with `returnPos`. To Coda can be
  armed by a **prior notated `D.S. al Coda`** (Rule 3 sets `alCodaArmed`, `:476`) —
  entirely independent of our directive — so this collision is real even for a
  no-exit insert. Gating on `!handled` makes any **notated** reposition
  authoritative (D7): when an end-edge rule handled the step, the pending return
  **defers** — it stays set and rides to the next clean forward advance of
  `afterPos` (which may never come if notated nav carried the band elsewhere, in
  which case it harmlessly never fires).
- **Rule-5 `Fine` early-return path (`roadmap-vm.ts:495`) is DELIBERATELY
  EXCLUDED (Codex R2 MEDIUM).** Same principle: a notated `Fine` ends the song;
  a live pending return must **never** resurrect it (applying the helper there
  would clear the `done` the Fine just set and bounce the cursor back into the
  chart). So `applyPendingReturn` rides exactly TWO advance points — the linear
  branch and the Rule-6 block — and **no** end-edge (Rule 2a/2b/3/4/5) path.
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
| Non-section target (coda/segno/fine/repeatStart/plain bar) | continue-from-target — insert-and-return is section-only. D9. |
| Forward target (`targetPos >= curPos`) | continue-from-target (no return). D1. |
| Anchor is the last section | no successor → plain `jumpTo`, no return. D8. |
| Section-less / linear chart | no anchor → plain `jumpTo`, no return. D8. |
| Target section contains internal repeats | repeats loop first; return fires on the **final forward** exit (§5.3 guard). |
| MD jumps **again** while a return is pending | new override clears the old `pendingReturn` and (if itself backward) computes a **fresh** anchor = the section we're in **now** → its own successor. Each cue inserts relative to where we are. (D5; OQ1.) |
| Return target equals the inserted section (degenerate) | `returnPos === afterPos+...`; harmless one-shot. |
| Inserted section never reached (`done` first, or another jump) | `pendingReturn` simply never fires; cleared by the next override or song end. |
| Stale `afterPos` after a hand-edited chart | unknown/never-matched position ⇒ never fires (safe no-op), mirrors `applyOverride`'s unknown-target tolerance. |
| Backward call **with an explicit `exit`** (e.g. "back to C, al Coda") | exit-armed plain `jumpTo`, **no return** baked (§4.2, D10). MD named the departure. |
| **Notated To Coda inside the inserted section** (To Coda armed by a prior `D.S. al Coda`) | the notated To Coda is `handled` → authoritative; `applyPendingReturn` defers (§5.3). The Coda is taken; the return does not clobber it. |
| Notated D.S./D.C. or repeat back-jump inside the inserted section | `handled` → return defers; the section's own internal nav runs first, return rides to the next clean forward exit of `afterPos`. |
| Effect-no-op override while a return is pending (unknown/same-cursor `jumpTo`, not-fired `resetJump`, release-while-not-holding, duplicate `hold`/`anotherRound`) | `sameNav` true ⇒ `pendingReturn` preserved (§5.2). |

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
- **D9** — Insert-and-return is gated to **`kind: 'section'`** targets only
  (Codex R1 MEDIUM-2). Backward jumps to coda/segno/fine landmarks, repeat starts,
  and plain bars stay continue-from-target — the resolver takes the whole
  `JumpTarget` and bails unless it's a section. **Recommend YES.**
- **D10** — `exit` and `return` are **mutually exclusive** on a `jumpTo` (Codex R3
  HIGH). An explicit MD exit (al Coda / al Fine) defines the departure and
  suppresses the default return; the seam never bakes a return onto an exit-bearing
  jump (§4.2). Plus: `applyPendingReturn` fires only on the **natural forward
  advance** (linear branch + Rule-6 `!handled`), never after a notated end-edge
  reposition — so a notated To Coda/D.S./Fine inside the inserted section stays
  authoritative (§5.3). **Recommend YES** (correctness).

---

## 9. Open questions

- **OQ1 — RESOLVED (Graham).** Re-cue while a return is pending: each new backward
  cue recomputes its anchor from the **current** section (jumping C→A while
  pending-return-to-F yields a new return to D, not F) — the "insert relative to
  where we are now" model. Graham: *"fine with your framing. we can change later if
  need be, post actual user testing."* Revisit post-UAT if it confuses MDs in the
  room.
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
  - **non-section target** (coda/segno/fine/repeatStart/plain bar), even backward
    → `null` (D9).
  - forward call → `null`.
  - anchor is last section → `null`.
  - section-less / null `sectionId` → `null`.
- `applyOverride` (`sameNav`-driven clearing — §5.2):
  - `jumpTo` with `return` (no `exit`) sets `pendingReturn`; without, leaves it null.
  - any directive that **actually changes nav state** (cursor moved, counter bumped,
    flag armed, vamp parked/released) clears an existing `pendingReturn`.
  - unknown `returnBarId` ⇒ `pendingReturn` stays null (safe).
  - **no-op-preserves-pendingReturn invariant (Codex R3 regression guard):** with a
    `pendingReturn` set, each EFFECT-NO-OP leaves it intact — unknown `jumpTo`;
    **same-cursor no-exit `jumpTo`** (`pos === s.cursor`, R3 MEDIUM); `resetJump`
    on a known-but-not-fired jump; `release` while not holding; duplicate `hold`
    on the held repeat; **duplicate `anotherRound`** re-seating already-held values
    (R3 MEDIUM).
  - **no-op `jumpTo` CARRYING a valid `return` does NOT install one (Codex R6 HIGH):**
    an unknown-barId `jumpTo` whose `return.returnBarId` happens to be a **valid** bar
    leaves nav unchanged (`sameNav` true) → the policy block is skipped → **no fresh
    `pendingReturn` is installed**, and any prior `pendingReturn` is preserved. Same for
    a **same-cursor no-exit `jumpTo` with a `return`**. (The set is nested under the
    `!sameNav` guard, so a return is only installed when the jump actually applied.)
  - **`exit` XOR `return` (D10):** a `jumpTo` carrying an `exit` (al Coda/al Fine)
    sets **no** `pendingReturn`, even on a backward section target.
- `resolveArm` (target-identity re-derivation + exit suppression — §4.3, Codex R5):
  - **bakes the return** on a backward `kind:'section'` id with **no** `exit` arg:
    `Armed.directive.return` is present and points at the anchor's successor.
  - **valid exit suppresses the return:** same backward section id **with** a valid
    `exit` (in the re-derived `exitOptions`) → `Armed.directive.exit` present,
    `return` **absent** (D10).
  - **stale/invalid exit STILL suppresses the return:** a requested `exit` that is
    **not** in the re-derived `exitOptions` is dropped (`keepExit === undefined`) yet
    **still** bakes **no** `return` — gate is on the `exit` ARG, not `keepExit` (R5
    MEDIUM). Result is a plain continue-from-target `jumpTo`, neither exit nor return.
  - **ambiguous identity → `null`:** a `{ barId }` shared by multiple targets
    (Coda + section head on bar 1) resolved with a `kind`/`label` matching **two**
    entries, or matching **none**, returns `null` — never guesses (R5 HIGH).
  - **forward / non-section id with no exit:** `return` absent (continue-from-target).
- `stepVM`:
  - plays the inserted section once, then lands on the return target on the
    natural forward exit; `pendingReturn` cleared.
  - **marker-less `linear` chart** (sections, no roadmap markers — the common
    case): the return fires from the **linear branch** path, not just the
    non-linear end-edge path (HIGH-1 regression guard).
  - inserted section with an internal repeat: loops the repeat first, returns on
    the final forward exit (the §5.3 guard).
  - **notated To Coda inside the inserted section, To Coda armed by a prior
    `D.S. al Coda` (Codex R3 HIGH):** the To Coda fires and the return **defers**
    (`!handled` gate) — the Coda is taken, NOT clobbered by `returnPos`. Likewise a
    notated D.S./repeat back-jump inside the section: the return defers to it.
  - a second override before the boundary pre-empts the return.
  - notated repeats/jumps elsewhere unaffected (regression: existing roadmap
    fixtures still resolve identically).
- **arm/commit seam (arm-time resolution, Codex R3 HIGH):** arm an `E → C` section
  jump while the last-emitted bar is in **E**, advance the VM forward (so the
  playhead would now be in F), then auto-fire/commit — the committed directive
  still returns to **F** (E's successor, frozen at arm time), NOT G. Proves the
  return leg is baked into `Armed.directive` at arm time, not re-resolved at fire.

Report the test-count delta on the build PR.

---

## 11. Build outline (DESIGN-ONLY — do not build until GO)

1. `roadmap-vm.ts`: add `pendingReturn` to `VMState` (+ `initVM` null);
   `jumpTo.return` optional field; `applyOverride` left `pendingReturn`-blind +
   the single `sameNav`-driven policy clause (clear AND set both **nested under the
   `!sameNav` guard** so a no-op jumpTo never installs a return; set fresh only on a
   genuinely-applied **no-exit** `jumpTo.return` — §5.2, D10, Codex R6); `stepVM` §5.3 interception via the
   shared `applyPendingReturn` helper at the **two natural-advance points only** —
   the linear branch (:393) and the **Rule-6 `if (!handled)` block** (:499-502),
   NOT the shared :504 return (HIGH — keeps notated end-edge nav authoritative). +
   tests, **including the marker-less `linear`-chart case and the To-Coda-defers case**.
2. `conductor-targets.ts`:
   - `resolveInsertReturn` (takes the whole `JumpTarget`, gates on `kind === 'section'`
     — D9) + the two helpers (`nextSectionHeadAfter`, `lastBarPosOfSection`).
   - **`resolveArm` signature change (§4.3, R5):** takes a **stable identity**
     `{ barId, kind, label }` (not the raw `JumpTarget`), `exit`, `fireAt`, **and a new
     `currentBarId`** param. Re-derives the fresh target via
     `armableTargets(...).filter(barId && kind && label)`, **rejects no-match OR
     ambiguity → `null`**, then bakes the return **inside** by calling
     `resolveInsertReturn` against the re-derived target **only when `exit === undefined`
     && `kind === 'section'`**. Suppression keys on the `exit` ARG (D10), not the
     validated `keepExit`. + tests (§10 `resolveArm` group).
3. Wire the arm/redirect path (`use-conductor-session.ts` / `conductor-session.ts`)
   **at issue time** (§4.1, HIGH): the hook forwards a **stable identity**
   `{ barId: t.barId, kind: t.kind, label: t.label }` + `exit` + `fireAt` +
   `currentBarId` (the last-emitted bar) into `resolveArm`, which **bakes** the return
   leg into `Armed.directive` — `commit` applies it verbatim
   (`conductor-state.ts:242`), never re-resolving. The hook does **not** pass the raw
   `t` object and does **not** itself call `resolveInsertReturn` (don't-trust-the-object
   safety rule, §4.3). A backward **section** call with no exit carries the resolved
   leg; forward + non-section + exit-bearing stays plain. (This is the chunk-4/5 seam;
   coordinate with chunk 5's arming.) + the arm-time-freeze test (§10).
4. Amend `design-conductor-authority.md` §3.3/§3.4 line per §7.
5. MD readout/telegraph copy (OQ2) — only if confirmed; else defer to chunk 5.

Full local gate (`npm test` + lint + type-check) before any push; ShowRunr
commits direct to main per process.
