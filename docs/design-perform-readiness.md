# Perform readiness — closing the "I have a chart but can't Perform/Conduct" dead-end

Design-only. This is **not** a new conductor chunk — chunk 4 (the MD's manual baton) is built and
merged (`docs/design-conductor-chunk4-ui.md`, main `0a54084`). This doc closes the **loop gaps**
that sit *upstream* of Conduct: the path from "I have a chart" to "I'm conducting through it" goes
silent whenever the chart hasn't cleared the Perform gates, and the owner gets no reason and no
next step. The fix is a pure readiness **diagnosis** plus one small Perform-mode strip that renders
it — no gate changes, no new mutators, no conductor changes.

Parent loop: `docs/design-conductor-authority.md` (the epic this enables end-to-end testing for).
Adjacent: `docs/design-perform-tab.md`, `docs/design-nav-graph.md` (the resolver behind `canVerify`).

## 0. Scope & non-goals

- **In:** surface, in Perform mode, **why** a chart has no bar transport / isn't conductable, and
  the owner's one next step to fix it. A pure classifier `performReadiness(cal)` + a small
  presentational `PerformReadinessStrip` mounted exactly where the transport block today falls to
  `null`.
- **Out — do not touch the gates.** `isPerformable` / `canVerify` / `barMode` / `resolveRoadmap`
  are unchanged; the classifier only *explains* them, never re-decides them. No auto-verify, no new
  calibration mutators, no conductor/session changes, no follower-facing pixels.
- **Non-goal — no new verify path.** "Verify & save" already exists (the calibrate toolbar,
  `page.tsx:3510`). The strip routes the owner *to* it; it does not duplicate the promotion.

## 1. The dead-end (the loop gap, traced)

In Perform mode the transport renders only inside one conditional
(`page.tsx:3523` conductor cluster / `:3549` self-drive bar transport) — both branches require
**`barMode`**. When `barMode` is false the whole conditional falls to its terminal **`: null`**
(`page.tsx:3586`): the owner opens a chart expecting to step or conduct and there is **no control
and no reason why**.

The single existing hint — "every section needs a label to verify" (`page.tsx:3375`) — lives in the
**calibrate toolbar**, i.e. it is only visible *after* you have already guessed to enter Calibrate.
A non-owner sees nothing at all. This is the loudest break in the end-to-end loop: not a crash, a
**silent absence**.

## 2. The four gates (why `barMode` is false)

`barMode` (`page.tsx:2875`) sits at the top of an independent gate chain:

| Gate | Source | Requires |
|---|---|---|
| `barMode` | `page.tsx:2875` | perform mode **and** `overlayCalibration` **and** ≥1 **bar** |
| `overlayCalibration` (perform) | `page.tsx:2605` | `isPerformable(calibration)` |
| `isPerformable` | `chart-calibration.ts:151` | `status === 'verified'` **and** `canVerify` |
| `canVerify` | `chart-calibration.ts:136` | ≥1 **labeled section** **and** roadmap resolves |

Two of these are **orthogonal**: `canVerify` needs at least one labeled **section**; `barMode` needs
at least one **bar**. A chart can satisfy one and not the other and fall into a quiet hole
(converter output with bars but no section → can't verify → never performable; a manual
sections-only chart → verifiable but no bar transport).

**Important nuance — bars-absent is not fully dead.** A *verified* sections-only chart still drives
the **section** redline and section-tap seek (`page.tsx:3589`). So the diagnosis must distinguish
"not performable at all" (loud — draft/unverifiable) from "performable at the section level but not
bar-level / not conductable" (a quiet nudge, not an error).

## 3. The pure diagnosis — `performReadiness`

A thin classifier next to `isPerformable` / `performDisplayPage` in `lib/chart-calibration.ts`:

```ts
export type PerformReadiness =
  | { state: 'none' }                                   // no calibration at all
  | { state: 'unverifiable'; reason:                    // draft, and can't be promoted yet
      'no-sections' | 'unlabeled-section' | 'roadmap-unresolved' }
  | { state: 'verifiable' }                             // canVerify true, status still draft
  | { state: 'section-only' }                           // verified, no bars (section rail works)
  | { state: 'bar-ready' };                             // verified + bars (full transport + conduct)

export function performReadiness(cal: ChartCalibration | null): PerformReadiness;
```

Derivation maps **directly** onto the existing predicates so it cannot drift from the live gate:

- `cal == null` → `none`.
- `isPerformable(cal)` → `(cal.bars?.length ?? 0) > 0 ? 'bar-ready' : 'section-only'`.
- else (draft) → `canVerify(cal) ? 'verifiable' : { unverifiable, reason }` where `reason` decomposes
  the **same** `canVerify` conditions, for messaging only:
  - `sections.length === 0` → `no-sections`
  - some section `label.trim() === ''` → `unlabeled-section`
  - roadmap present and `!resolveRoadmap(cal).ok` → `roadmap-unresolved`

The classifier reuses `isPerformable` / `canVerify` / `resolveRoadmap` verbatim — it never re-implements
them. Invariants (enforced in tests, §7) pin it to the gates:
`state === 'bar-ready'  ⟺  isPerformable(cal) && bars > 0` and
`state ∈ {section-only, bar-ready}  ⟺  isPerformable(cal)`.

## 4. The strip — `PerformReadinessStrip` (presentational)

A small pure component (mirrors `ConductorCluster`: render + callbacks, jsdom-testable, no
session/PDF/validity). Props:

```ts
interface PerformReadinessStripProps {
  readiness: PerformReadiness;
  isOwner: boolean;
  onCalibrate: () => void;   // enter Calibrate (where section labels, bars, and Verify & save live)
}
```

Per state (owner column actionable; non-owner never gets a false promise):

| state | owner | non-owner |
|---|---|---|
| `none` | "No chart map yet — Calibrate to set up Perform." + **Calibrate** | — (nothing) |
| `unverifiable: no-sections` | "Add a section to verify this chart." + **Calibrate** | — |
| `unverifiable: unlabeled-section` | "Label every section to verify." + **Calibrate** | — |
| `unverifiable: roadmap-unresolved` | "The roadmap doesn't resolve — fix it in Calibrate." + **Calibrate** | — |
| `verifiable` | "Draft — Verify to perform." + **Calibrate** | — |
| `section-only` | quiet — section rail already shows (`:3589`); optional subtle "Add bars to conduct" | — |
| `bar-ready` | renders nothing (the transport / Conduct already shows) | renders nothing |

**Mount:** replace the transport conditional's terminal `: null` (`page.tsx:3586`) with the strip,
gated `calMode === 'perform' && !barMode`. It appears in exactly the hole — when there is no bar
transport — and never competes with it.

**Owner-only actions are principled, not arbitrary:** only the owner can Calibrate/Verify
(`calibratable = isOwner && calibrationChartId`, the v1 source-scope boundary). A non-owner can't act
on any of these states, so an actionable label would be noise; today's "show nothing" is preserved
for them (no false Perform promise).

## 5. Re-verify honesty (the third gap, folded in for free)

Every calibration mutator stamps `status: 'draft'` (`chart-calibration.ts` — `addSection`,
`addBar`, `addRoadmapMarker`, …). So **any edit silently drops a previously-conductable chart back
to draft** and Conduct vanishes until re-verified. The `verifiable` state *is* the cure: after an
edit, Perform mode now reads "Draft — Verify to perform" with a Calibrate jump, instead of going
silent. The loop becomes legible: **edit → strip shows `verifiable` → Calibrate → Verify & save →
`bar-ready`.** No new verify path — the strip just makes the dangling draft state visible.

## 6. Decisions (recommendations) & open Qs

- **D1 — pure classifier vs inline booleans.** REC: pure `performReadiness` (a tested seam, mirrors
  the `performDisplayPage` precedent that carried the chunk-4 page-turn regression).
- **D2 — extract the strip vs inline JSX.** REC: extract `PerformReadinessStrip` so it's
  jsdom-testable like `ConductorCluster` (page.tsx render stays manual-UAT by repo precedent).
- **D3 (open) — non-owner on a non-performable chart:** show nothing (preserve today) vs an honest
  "not set up to perform." REC: **nothing** for `none`/`unverifiable` (a performer can't fix it; a
  label is noise). Graham's call.
- **D4 (open) — `section-only` owner nudge:** subtle "add bars to conduct" vs stay quiet. REC:
  **quiet** (the section rail is a legitimate Perform mode; nudging implies it's broken). Graham's
  call.
- **D5 (open) — inline Verify in the strip vs route-to-Calibrate only.** REC: **route only** for
  `verifiable` (Verify & save lives in the calibrate toolbar with the full reviewed-calibration
  context; an inline verify would duplicate the gate). Could add inline later if the extra hop annoys.

## 7. Test plan

- **Pure (`tests/chart-calibration.test.ts`):** `performReadiness` over fixtures — `null → none`;
  draft no-sections / unlabeled-section / roadmap-unresolved; draft-but-canVerify → `verifiable`;
  verified no-bars → `section-only`; verified + bars → `bar-ready`. **Invariant tests** assert the
  classifier agrees with the live gates: `bar-ready ⟺ isPerformable && bars>0`, and
  `{section-only, bar-ready} ⟺ isPerformable` (would fail if the classifier ever diverges).
- **jsdom (`tests/perform-readiness-strip.test.tsx`):** renders the right copy per state, owner vs
  non-owner (non-owner gets nothing for the actionable states), fires `onCalibrate`. Reuses the
  chunk-4 harness (`// @vitest-environment jsdom` + `afterEach(cleanup)`).
- **Manual UAT:** the page.tsx mount/wiring (consistent with `ChartNavigator` staying manual-UAT).

## 8. Build outline (after sign-off)

1. `performReadiness` in `lib/chart-calibration.ts` (beside `isPerformable`/`performDisplayPage`) + pure tests.
2. `PerformReadinessStrip` component + jsdom tests.
3. Wire into the Perform transport terminal (`page.tsx:3586`) — manual UAT.

Each step is independently gate-greenable; nothing here touches the conductor libs (frozen) or the
verify/perform gates. This closes the upstream loop so the conductor work is actually exercisable
end-to-end (the gate on holistic chart testing) without the AI-designer on-ramp.
