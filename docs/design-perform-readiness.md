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
- **One surgical read-side API addition (in scope, §3.2).** The GET route currently collapses
  *several* server states into one 404; closing the loop honestly requires letting a calibratable
  **owner** distinguish "no row" from "a row exists but this build refused to interpret it." This is
  additive and read-only — it still **never serves** an unusable calibration (fail-closed preserved),
  changes none of the four gates, and stays invisible to non-owners.
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
a stale-hash miss after a PDF re-upload, (c) when the calibration fetch **throws / is unavailable**
(the `catch` at `page.tsx:3062` sets `cal = null`), and (d) when the **PDF bytes themselves fail to
load** — `loadPdfDoc()` returns null (`pdf-viewer.ts:86`/`:127`) and the effect bails at
`page.tsx:3026` *before* `sourceHash` is ever set, so the calibration fetch never runs. Feeding raw
null to the classifier would flash "No chart map yet" during load **and** misdiagnose both a
broken/unavailable fetch (c) and a no-bytes chart (d) as "no map."

Case (d) is especially a trap: with no `sourceHash`, `saveCalibration` hard-returns
(`page.tsx:2967`), so a calibratable owner shown `none`+"Calibrate" would enter Calibrate, do work,
and have **Save silently no-op**. So `loadError` here means "the chart **or** its calibration failed
to load" — it covers both (c) and (d).

So a thin **pure** view assembler sits above the classifier (also in `lib/chart-calibration.ts`,
unit-tested), and the classifier itself is unchanged:

```ts
export type PerformReadinessView =
  | { phase: 'loading' }                              // fetch in flight ⇒ strip renders nothing
  | { phase: 'load-error' }                           // calibration fetch failed / unavailable
  | { phase: 'unreadable'; reason:                    // a row EXISTS but this build refused it (§3.2)
      'unsupported-schema' | 'invalid' }
  | { phase: 'ready'; readiness: PerformReadiness };  // settled — classify cal

export function performReadinessView(args: {
  loading: boolean;
  loadError: boolean;                                 // PDF-bytes OR calibration fetch failed
  unreadable: { reason: 'unsupported-schema' | 'invalid' } | null;  // §3.2 owner-only signal
  cal: ChartCalibration | null;
}): PerformReadinessView;
//  loading            → { phase: 'loading' }
//  else loadError     → { phase: 'load-error' }
//  else unreadable    → { phase: 'unreadable', reason }
//  else               → { phase: 'ready', readiness: performReadiness(cal) }
```

`loadError` covers any path where claiming "no map" would be a lie: the **PDF-bytes failure**
(`loadPdfDoc()` null → `:3026` bail, no `sourceHash`) and the **calibration-fetch failure**
(`:3062` catch / non-404 `!res.ok`). Build wires one `loadError` boolean: reset false at load start,
set true in the `:3026` `!loaded` bail **and** the `:3062` catch (and on a non-404/non-409 `!res.ok`);
a clean 404 leaves it false. (Drive charts also have no `sourceHash`, but they are non-calibratable
→ `none` → nothing, so no dead CTA there regardless.)

### 3.2 The 404 taxonomy — `none` must not invite a clobber

The GET route returns **one shared 404** (`route.ts:91`) for four distinct server states: no row
(`:95`), a **future/unsupported schema** row (`:103`), a **structurally invalid** stored row (`:109`),
and a hidden non-owner draft (`:113`). The first three are fail-closed *by design* — this build won't
drive Perform off a shape it can't interpret. But folding all of them into client `none` ("No chart
map — Calibrate") is a **trap for a calibratable owner**: a future-schema/invalid row is keyed by the
*same* `(chart_id, source_hash)` the owner is viewing, so a fresh Calibrate + "Verify & save" PUTs to
that same PK and **silently overwrites the map this build deliberately refused to interpret** (e.g. a
v4 map after a rollback to this v3 build). Stale-hash and genuinely-fresh charts are *not* this case —
they have no row at the current hash, so `none`/"for these bytes" is honest and a fresh save can't
clobber anything (different PK).

**Fix (owner-only, fail-closed preserved):** for an authenticated **owner**, split the `:103`/`:109`
cases out of the 404 into a distinct **`409`** with `{ unreadable: true, reason:
'unsupported-schema' | 'invalid' }`. The route still **never returns the unusable graph** — it only
admits that a row exists that this build won't interpret. **Non-owners are unchanged** (still `404`,
fail-closed, no existence leak). Sketch:

```ts
const unreadable =
  calibration.schemaVersion !== CALIBRATION_SCHEMA_VERSION ? 'unsupported-schema'
  : !isValidCalibration(calibration) ? 'invalid'
  : null;
if (unreadable) {
  return (await isOwnerOfChart(chartId))
    ? Response.json({ unreadable: true, reason: unreadable }, { status: 409 })
    : notFound;                                  // non-owner: hidden, fail-closed (unchanged)
}
// …existing non-owner performable gate (:112) and success (:116) unchanged…
```

Client: `res.status === 409` → `setCalUnreadable({ reason })`; a clean `404` → `none`. With
`:103`/`:109` carved out, an owner's remaining `404` genuinely means "no row for these bytes" — so the
**`none` copy "No chart map for these bytes — Calibrate" is honest again** (fresh or stale-hash, no
clobber). The dangerous case routes to the new `unreadable` phase instead (§4).

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
"Couldn't load this chart." for **every** viewer (covers both a failed PDF fetch and a failed
calibration fetch; honest, no dead button — reload is the recourse; and never a Calibrate CTA that
would Save-no-op for lack of `sourceHash`). `phase: 'unreadable'` (owner-only by construction, §3.2) → an honest line that does **not**
invite a blind clobber: `unsupported-schema` → "This chart's map was made by a newer version of the
app — update to edit it." / `invalid` → "This chart's stored map is corrupt." A destructive
**"Replace map"** action (→ `onCalibrate('sections')`, which on save overwrites the row) is *optional*
and must be explicitly labeled as replacing — never the innocent "Calibrate" CTA (D6). `phase:
'ready'` → the per-state table below.

**The header Calibrate button is a SECOND innocent path — suppress it too.** The strip hiding its own
CTA is necessary but not sufficient: the always-present top-right **Calibrate** toggle (`page.tsx:3259`,
gated only on `calibratable`) is still live during `load-error`/`unreadable`. For an owner `409` the
`sourceHash` is already set (`:3047`), so entering Calibrate there and Saving would PUT to the **same
`(chart_id, source_hash)`** and clobber the row this build refused to interpret — the exact trap the
`409` exists to prevent. So gate the header **enter** path off when `loadError || calUnreadable` (the
load reset forces `perform` mode when either is set, so condition it on `calMode === 'perform'` to keep
the in-calibrate **Done** exit reachable). This is the same D6 invariant applied to both Calibrate
surfaces — no innocent entry into a clobbering Save.

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

### 4.1 `onCalibrate(tool)` — route to the repair surface, via a shared `enterCalibrate(tool)`

The strip passes the tool that fixes *this* state: `none`/`no-sections`/`unlabeled-section`/
`verifiable` → `sections`; `roadmap-unresolved` → `roadmap`; `section-only`'s "Add bars" → `bars`.
But wiring it as a naive `setCalTool(tool); setCalMode('calibrate')` is **not enough** — and "reuse
the toggle's resets" is wrong, because the two existing entry points reset *different* state:

- the **mode toggle** (`page.tsx:3212`) clears `editingId` / `selectedSystemId` / `addBarMode` /
  `selectedBoundary`;
- the **tool switch** (`page.tsx:3330`) clears a **superset** — additionally `selectedBarId` /
  `selectedMarkerId` / `endingDraft`.

So a CTA that lands on Bars/Roadmap while only running the mode-toggle's reset leaves **stale
`selectedBarId` / `selectedMarkerId` / `endingDraft`**. Fix: factor a single
`enterCalibrate(tool: CalTool)` helper used by the strip CTA **and** (refactor) both existing entry
points, doing the full union reset:

```ts
function resetCalSelections() {
  setSelectedSystemId(null); setEditingId(null);
  setSelectedBarId(null); setSelectedMarkerId(null); setEndingDraft(null);
  setAddBarMode(false); setSelectedBoundary(null);
}
function enterCalibrate(tool: CalTool) { setCalTool(tool); resetCalSelections(); setCalMode('calibrate'); }
function exitCalibrate() { resetCalSelections(); setCalMode('perform'); }
```

`onCalibrate = enterCalibrate`. Wiring is **direction-explicit** — `enterCalibrate` is enter-only, so
the existing top toggle must keep its "Done exits Perform" behavior rather than blindly route through
it:

- **top button** (`page.tsx:3212`): `calMode === 'calibrate' ? exitCalibrate() : enterCalibrate(calTool)`
  (enter on the *current* tool, preserving today's behavior; exit when in calibrate);
- **tool tabs** (`page.tsx:3330`) and **strip CTAs**: `enterCalibrate(tool)`.

All three entry points share `resetCalSelections()`, so the full-union reset can't drift between them.

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
- **D6 (open) — `unreadable`: honest dead-stop vs offer "Replace map".** REC: **honest message only**
  for v1 (no action) — the safe owner move is to update the app; an explicitly-labeled destructive
  "Replace map" can come later if owners actually hit it. Never surface the innocent "Calibrate" CTA
  here (that's the clobber this fix exists to prevent). Graham's call.

## 7. Test plan

- **Pure (`tests/chart-calibration.test.ts`):** `performReadiness` over fixtures — `null → none`;
  draft no-sections / unlabeled-section / roadmap-unresolved; draft-but-canVerify → `verifiable`;
  verified no-bars → `section-only`; verified + bars → `bar-ready`. **Invariant tests** assert the
  classifier agrees with the live gates: `bar-ready ⟺ isPerformable && bars>0`, and
  `{section-only, bar-ready} ⟺ isPerformable` (would fail if the classifier ever diverges).
  Plus `performReadinessView` precedence: `loading → loading` (regardless of the other inputs);
  `!loading && loadError → load-error` (covers both PDF-bytes and calibration-fetch failure); `!loading
  && !loadError && unreadable → unreadable` (carries reason); else `ready` with the classified cal
  (incl. `null → ready/none`, proving a clean 404 is `none` not `load-error`/`unreadable`).
- **Pure GET disposition (`lib/chart-calibration.ts` or a route-local pure module):** the route's
  taxonomy decision is factored into a pure `calibrationGetDisposition(...) → { status: 200 | 404 |
  409; reason? }` so the data-safety logic is unit-tested without a Supabase harness (mirrors the
  `performDisplayPage` pure-seam precedent; the route becomes a thin adapter that does the DB read
  then calls it). **The input is a discriminated union, not a flat bag — this enforces the live
  route's check order (`route.ts:103` schema → `:109` valid → `:112` performable), which is
  load-bearing:** `isPerformable → canVerify → s.label.trim()` *throws* on a malformed row, so
  `performable` must be computed by the adapter **only after** `schemaOk && valid` both hold. Making
  it a type error to even supply `performable` on a non-valid row removes the crash path by
  construction:

  ```ts
  type CalibrationGetInput =
    | { hasRow: false }
    | { hasRow: true; schemaOk: false; isOwner: boolean }
    | { hasRow: true; schemaOk: true; valid: false; isOwner: boolean }
    | { hasRow: true; schemaOk: true; valid: true; performable: boolean; isOwner: boolean };
  // adapter computes `performable: isPerformable(cal)` ONLY in the schemaOk&&valid branch —
  // it is unreachable code on a row that would throw.
  ```

  Cases: no row → 404; bad schema / invalid → **409 for owner, 404 for non-owner** (and the adapter
  **never returns the graph** — see below); valid+performable → 200; valid+draft → 200 for owner, 404
  for non-owner. This is the route coverage Codex asked for, sited where it's testable.
- **Adapter response-shape (the "never serves the graph" guarantee):** the pure helper proves the
  *status* taxonomy but not that the 409 body withholds the unusable calibration. Add a thin adapter
  assertion (route-local, no live DB needed — a stub read feeding the disposition): a `409` body is
  **exactly `{ unreadable: true, reason }`** with **no `calibration` field**, and a `404` carries only
  the error message. This pins the fail-closed promise (§0, §3.2) that the status code alone can't.
- **jsdom (`tests/perform-readiness-strip.test.tsx`):** `loading` → renders nothing; `load-error` →
  the error line for both calibratable and not; `unreadable` → the version/corrupt line and **no**
  innocent Calibrate CTA (D6); each `ready` state's copy; the `section-only` **split** (non-calibratable
  still shows "Tap a section to seek" with no button; calibratable adds "Add bars" → `onCalibrate('bars')`);
  and `onCalibrate` fires the **correct tool** per state (`no-sections`/`unlabeled-section`/`verifiable`→
  `sections`, `roadmap-unresolved`→`roadmap`). Reuses the chunk-4 harness (`// @vitest-environment
  jsdom` + `afterEach(cleanup)`).
- **Manual UAT:** the page.tsx mount/wiring (consistent with `ChartNavigator` staying manual-UAT).

## 8. Build outline (after sign-off)

1. `performReadiness` **and** `performReadinessView` in `lib/chart-calibration.ts` (beside
   `isPerformable`/`performDisplayPage`) + pure tests (incl. the view precedence + clean-404-is-`none`
   invariants).
2. **GET route owner distinction (`route.ts:103`/`:109`):** factor the taxonomy into a pure
   `calibrationGetDisposition(...)` over the **discriminated `CalibrationGetInput`** (§7) — so the
   adapter computes `performable` only in the `schemaOk && valid` branch, preserving the live check
   order (`:103`→`:109`→`:112`) and never calling `isPerformable` on a row that would throw. Make the
   route a thin adapter over it, carving unsupported-schema / invalid into a `409 { unreadable, reason }`
   for owners only; non-owner stays `404` (§3.2). Tests (§7): pure status taxonomy **and** the adapter
   response-shape assertion (409 body is exactly `{ unreadable, reason }`, no `calibration`; 404 leaks
   nothing). Fail-closed preserved (never serves the unusable graph).
3. `PerformReadinessStrip` component (`view`/`calibratable`/`onCalibrate(tool)`) + jsdom tests.
4. Wire into the Perform transport terminal (`page.tsx:3586`) — manual UAT. This step adds the
   `loadError` **and** `calUnreadable` state (both reset at load start `:3021`; set `loadError` true in
   the `:3026` PDF-bytes bail **and** the `:3062` catch / non-404-non-409 `!res.ok`; set
   `calUnreadable({reason})` on a `409`), factors the `enterCalibrate(tool)`/`exitCalibrate()` helpers
   (§4.1, refactoring the top toggle `:3212` — `calMode==='calibrate' ? exitCalibrate() :
   enterCalibrate(calTool)` — and tool-switch `:3330` through them), assembles
   `performReadinessView({ loading, loadError, unreadable: calUnreadable, cal: calibration })`, and
   sets `onCalibrate = enterCalibrate`. **It also gates the header Calibrate ENTER path off on an
   errored/unreadable chart** — `calibratable && !(calMode === 'perform' && (loadError ||
   calUnreadable))` (§4) — so the second innocent clobber path is closed, not just the strip's CTA.

Each step is independently gate-greenable; nothing here touches the conductor libs (frozen) or the
verify/perform gates. This closes the upstream loop so the conductor work is actually exercisable
end-to-end (the gate on holistic chart testing) without the AI-designer on-ramp.
