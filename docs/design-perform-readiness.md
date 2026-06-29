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
bar-level / not conductable" (a minimal nudge, not an error). Note the section seek-status block at
`:3589` only renders *after* a section is tapped (`seekId` set) — so for `section-only` the strip is
the one thing advertising the affordance before any interaction (this drives D4).

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

### 3.1 The load/status layer — `none` must not overclaim

`performReadiness` stays **pure on `cal`** (gate-pinned), but `cal === null` is *overloaded* in the
live load effect: it is the value (a) while the PDF + calibration fetch are in flight
(`setLoading(true)` `page.tsx:3022` → `setLoading(false)` `:3067`, calibration awaited *inside* that
window so `loading === false` ⟹ the fetch settled), (b) when the GET 404s — genuinely no row, **or**
a stale-hash miss after a PDF re-upload, and (c) when the fetch **throws / is unavailable** (the
`catch` at `page.tsx:3062` sets `cal = null`). Feeding raw null to the classifier would flash "No
chart map yet" during load and **misdiagnose a broken/unavailable fetch as "no map."**

So a thin **pure** view assembler sits above the classifier (also in `lib/chart-calibration.ts`,
unit-tested), and the classifier itself is unchanged:

```ts
export type PerformReadinessView =
  | { phase: 'loading' }                              // fetch in flight ⇒ strip renders nothing
  | { phase: 'load-error' }                           // calibration fetch failed / unavailable
  | { phase: 'ready'; readiness: PerformReadiness };  // settled — classify cal

export function performReadinessView(args: {
  loading: boolean;
  loadError: boolean;                                 // true only on fetch throw / non-404 failure
  cal: ChartCalibration | null;
}): PerformReadinessView;
//  loading            → { phase: 'loading' }
//  else loadError     → { phase: 'load-error' }
//  else               → { phase: 'ready', readiness: performReadiness(cal) }
```

**A 404 is *not* `loadError`.** No row for the bytes you're viewing (fresh chart or stale hash after
a re-upload) leaves `cal = null` with `loadError = false` ⇒ `ready` → `none`, which honestly says
"Calibrate to set up Perform **for these bytes**." `loadError` is reserved for the `catch`/non-404
path (network/unavailable), where claiming "no map" would be a lie. Build wires a `calFetchError`
boolean: reset false at load start, set true in the `:3062` catch (and on a non-404 `!res.ok`); a
404 leaves it false.

## 4. The strip — `PerformReadinessStrip` (presentational)

A small pure component (mirrors `ConductorCluster`: render + callbacks, jsdom-testable, no
session/PDF/validity). Props:

```ts
type CalTool = 'sections' | 'bars' | 'roadmap';   // existing page.tsx calTool union

interface PerformReadinessStripProps {
  view: PerformReadinessView;             // load/status + readiness (§3.1)
  calibratable: boolean;                  // NOT isOwner — see boundary note below
  onCalibrate: (tool: CalTool) => void;   // enter Calibrate on the RIGHT repair surface (§4.1)
}
```

`phase: 'loading'` → render nothing (no flash). `phase: 'load-error'` → a non-actionable line
"Couldn't load this chart's map." for **every** viewer (honest; no dead button — reload is the
recourse). `phase: 'ready'` → the per-state table below.

The split is **two orthogonal axes**, not one owner column: (a) does an affordance exist for *any*
viewer (section seek does — `page.tsx:1683` / `:2075` — for owner and performer alike), vs (b) is
this viewer `calibratable` (can enter Calibrate / add bars / verify). So `section-only`'s "Tap a
section to seek" shows for **all** viewers; only "Add bars to Conduct" is calibratable-gated.

| ready state | calibratable | not calibratable |
|---|---|---|
| `none` | "No chart map for these bytes — Calibrate to set up Perform." + **Calibrate**→`sections` | — (nothing) |
| `unverifiable: no-sections` | "Add a section to verify this chart." + **Calibrate**→`sections` | — † |
| `unverifiable: unlabeled-section` | "Label every section to verify." + **Calibrate**→`sections` | — † |
| `unverifiable: roadmap-unresolved` | "The roadmap doesn't resolve — fix it in Calibrate." + **Calibrate**→`roadmap` | — † |
| `verifiable` | "Draft — Verify to perform." + **Calibrate**→`sections` | — † |
| `section-only` | "Tap a section to seek · Add bars to Conduct." + **Add bars**→`bars` | "Tap a section to seek." (no button) |
| `bar-ready` | renders nothing (transport / Conduct already shows) | renders nothing |

† **Unreachable for a non-calibratable viewer, by construction:** the API serves a non-owner *only*
an `isPerformable` row (`route.ts:111`) — drafts (`none`-by-404 aside) and `unverifiable`/`verifiable`
states never reach them. A non-calibratable viewer can therefore only land in `none` (404),
`section-only`, or `bar-ready`. The "—" rows are listed for completeness, not because they render.

**Mount:** replace the transport conditional's terminal `: null` (`page.tsx:3586`) with the strip,
gated `calMode === 'perform' && !barMode`. It appears in exactly the hole — when there is no bar
transport — and never competes with it.

### 4.1 `onCalibrate(tool)` — route to the repair surface, not just the mode

The live Calibrate toggle (`page.tsx:3212`) only flips `calMode` and **preserves the current
`calTool`** — so "one next step" would otherwise dump the owner on whatever tool was last active. The
strip therefore passes the tool that fixes *this* state, and the mount sets both
(`setCalTool(tool); setCalMode('calibrate')`, reusing the toggle's existing reset side-effects —
`setEditingId(null)` etc.): `none`/`no-sections`/`unlabeled-section`/`verifiable` → `sections`;
`roadmap-unresolved` → `roadmap`; `section-only`'s "Add bars" → `bars`.

**Why `calibratable`, not `isOwner` (the v1 source-scope boundary).** The live affordance gate is
`calibratable = isOwner && !!calibrationChartId` (`page.tsx:2602`), and the Calibrate toggle itself
is gated on it (`page.tsx:3210`). A **Drive-resolved chart** carries no `calibrationChartId`, so the
owner is `isOwner` but **not** `calibratable` — there is no calibrate mode to enter. Keying the strip
on `isOwner` would hand that owner a **Calibrate** button that can't do anything (a dead/false
promise). The strip's mount has no calibration gate (`!barMode` is true for any uncalibrated chart,
Drive charts included), so it *will* render there. Therefore the actionable column keys on
`calibratable`: a non-calibratable viewer (non-owner, **or** an owner on a Drive chart) gets the
"nothing" column — identical to today's behavior for those charts. `isOwner` alone is the wrong
predicate.

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
- **D3 (open) — non-calibratable viewer on a non-performable chart:** show nothing (preserve today)
  vs an honest "not set up to perform." REC: **nothing** for `none` (a viewer who can't Calibrate
  can't fix it; a label is noise) — and `unverifiable`/`verifiable` never reach them anyway (§4 †).
  But note this is now narrow: the one affordance a non-calibratable viewer *does* get is
  `section-only`'s "Tap a section to seek" (resolved below). Graham's call.
- **D4 (RESOLVED via Codex R1 — split, not gated).** Earlier I flipped to "minimal nudge" but kept it
  calibratable-only; Codex caught that section seek works for *any* viewer (`page.tsx:1683`/`:2075`)
  and non-owners *do* receive verified sections-only rows (`route.ts:111`). So `section-only` is now
  split on the affordance-exists axis: **"Tap a section to seek" renders for all viewers**; "· Add
  bars to Conduct" + the `bars` route is calibratable-only. This both closes the pre-tap silent gap
  (the `:3589` rail only shows *after* a tap) and stops hiding a real affordance from performers.
- **D5 (open) — inline Verify in the strip vs route-to-Calibrate only.** REC: **route only** for
  `verifiable` (Verify & save lives in the calibrate toolbar with the full reviewed-calibration
  context; an inline verify would duplicate the gate). Could add inline later if the extra hop annoys.

## 7. Test plan

- **Pure (`tests/chart-calibration.test.ts`):** `performReadiness` over fixtures — `null → none`;
  draft no-sections / unlabeled-section / roadmap-unresolved; draft-but-canVerify → `verifiable`;
  verified no-bars → `section-only`; verified + bars → `bar-ready`. **Invariant tests** assert the
  classifier agrees with the live gates: `bar-ready ⟺ isPerformable && bars>0`, and
  `{section-only, bar-ready} ⟺ isPerformable` (would fail if the classifier ever diverges).
  Plus `performReadinessView`: `loading → loading` (regardless of cal); `!loading && loadError →
  load-error`; `!loading && !loadError → ready` with the classified cal (incl. `null → ready/none`,
  proving a 404 is `none` not `load-error`).
- **jsdom (`tests/perform-readiness-strip.test.tsx`):** `loading` → renders nothing; `load-error` →
  the error line for both calibratable and not; each `ready` state's copy; the `section-only` **split**
  (non-calibratable still shows "Tap a section to seek" with no button; calibratable adds "Add bars"
  → `onCalibrate('bars')`); and `onCalibrate` fires the **correct tool** per state
  (`no-sections`/`unlabeled-section`/`verifiable`→`sections`, `roadmap-unresolved`→`roadmap`). Reuses
  the chunk-4 harness (`// @vitest-environment jsdom` + `afterEach(cleanup)`).
- **Manual UAT:** the page.tsx mount/wiring (consistent with `ChartNavigator` staying manual-UAT).

## 8. Build outline (after sign-off)

1. `performReadiness` **and** `performReadinessView` in `lib/chart-calibration.ts` (beside
   `isPerformable`/`performDisplayPage`) + pure tests (both — incl. the 404-is-`none`-not-`load-error`
   invariant).
2. `PerformReadinessStrip` component (`view`/`calibratable`/`onCalibrate(tool)`) + jsdom tests.
3. Wire into the Perform transport terminal (`page.tsx:3586`) — manual UAT. This step also adds the
   `calFetchError` state (reset false at load start `:3021`, set true in the `:3062` catch and on a
   non-404 `!res.ok`), assembles `performReadinessView({ loading, loadError: calFetchError, cal:
   calibration })`, and wires `onCalibrate={(tool) => { setCalTool(tool); /* + toggle resets */
   setCalMode('calibrate'); }}`.

Each step is independently gate-greenable; nothing here touches the conductor libs (frozen) or the
verify/perform gates. This closes the upstream loop so the conductor work is actually exercisable
end-to-end (the gate on holistic chart testing) without the AI-designer on-ramp.
