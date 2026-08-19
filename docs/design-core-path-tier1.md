# Design: Core-Path UAT Blockers (Tier 1)

**Status:** Proposed v2 — Codex R1 folded (2 High + 1 Medium), plus three gaps
found by my own sweep of the class R1's second finding named. Awaiting Graham's
approval and Codex R2.
**Date:** 2026-08-19
**Source:** `docs/uat-readiness-gaps.md` (PR #142). Graham ruled **all six Tier-1
items** in scope, and ruled that **pre-existing production data does not need
repair or migration** — all but one show is past-tense and that one can be
recreated by hand. That removes migration cost from every decision below.

**Partially supersedes** `docs/design-input-plot-linkage.md` **step 6** (line
331), which specified an op-based AI contract and was never built. This document
builds a smaller mechanism that satisfies the same invariants — see §6.

---

## §0 Invariants

Every change below is walked against this list, and every claim names the
mechanism that enforces it and whether that mechanism exists today.

| # | Invariant | Enforced by |
|---|---|---|
| I1 | The UI never reports success for an operation that did not succeed. | `use-show.ts` catch sets `saveError` (§1.1); apply-impact warning (§2.4) |
| I2 | A field that cannot persist is not presented as editable. | Title becomes read-only when `songId` is present (§1.3) |
| I3 | A file the viewer cannot render is refused at upload, not accepted and broken later. | `ACCEPT` + route-side mime guard (§1.2) |
| I4 | No user-entered data is destroyed by an AI apply without the user being told first. | Identity in tool schemas (§2.1) + cascade removal (§2.2) + apply-impact warning (§2.4) |
| I5 | Every row that any view keys by `id` has one, at all times, regardless of how it was created. | `withStableIds` in `updateConfig` (§2.3) |
| I6 | A reference is never rewritten underneath the thing that points at it. | Mix identity is immutable; `renumberMix` remaps atomically (§3) |
| I7 | A dangling reference is visible, not silently coerced or silently wrong. | Orphaned-mix badge + flagged dropdown entry (§3.4) |
| I8 | No fix introduces a new silent path. Every new failure mode gets a user-visible surface. | Per-section "what the user sees" clauses |

---

## §1 Chunk 1 — Make the silent failures loud

Three independent, small fixes. No shared code. Ships as one PR.

### 1.1 A failed save must say so (`#1`)

**Today:** `lib/use-show.ts:103` is `catch { }` with a comment and no
`setSaveError`. `lastSavedAt` retains its previous value, so the pill at
`app/[owner]/[show]/page.tsx:826` keeps rendering green **"Saved"**.

**Spec:** the `catch` sets a save error naming the actual state:

> `Couldn't save — you appear to be offline. Your changes are cached in this
> browser and will save on your next edit once you're back.`

That sentence is true and must stay true: `saveConfig` already writes
`localStorage` before debouncing (`use-show.ts:117`), and the next successful
`doSave` clears the error (`use-show.ts:90`).

**No auto-retry.** Consistent with the no-auto-retry rule established for the
agent send path. The existing 2s debounce already retries on the next edit; a
background retry loop would be a new mechanism with its own failure modes.

**What the user sees:** the pill turns red and stays red until a save succeeds.
The `title` attribute already surfaces the full text (`page.tsx:821`).

**★ Coverage boundary, stated so it is not assumed wider than it is.** This fixes
the path where `showId` is set and the `fetch` fails. It does **not** cover the
offline-fallback path (gap #10, Tier 2): `page.tsx:419-432` restores from
localStorage without setting `showId`, so `page.tsx:566`'s `if (showId)` is false
and `saveConfig` is never called at all — meaning no save is attempted and this
new error never fires. **A tester in that state still gets silence**, from a
different mechanism, and I1 is only partly satisfied until #10 is fixed.
Recorded rather than quietly implied, because "we fixed the silent save" would
otherwise read as covering both.

**Not in scope:** the 2s debounce losing edits on tab close (gap #19, Tier 3).
Fixing it means a `visibilitychange` flush, which is its own change.

### 1.2 Refuse charts the viewer cannot render (`#3` in the gap doc, `#5` here)

**Today:** `components/ManageChartsModal.tsx:12` is
`ACCEPT = '.pdf,.png,.jpg,.jpeg'`, the upload route accepts any mime
(`app/api/charts/upload/route.ts:36-58`), and the in-show viewer has no image
branch — `chart.mimeType` is written at `page.tsx:473` and never read again.

> **★ To be unmistakable: PDF is, and remains, the supported chart format.**
> Graham flagged that ~95%+ of real charts are PDFs. Nothing here narrows PDF
> support — this section *narrows to* PDF. **PDF is the only format the viewer
> has ever rendered**; `.png/.jpg` are accepted by the picker today and then fail
> for every performer, which is the bug. After this change a PDF is accepted
> whether or not the browser supplies a correct MIME type (test 3), which is
> strictly *more* permissive for real PDFs than a MIME check would be.

**Spec, three parts:**
1. `ACCEPT = '.pdf'` — images leave the picker; PDF stays.
2. `/api/charts/upload` **sniffs the leading bytes** and rejects anything that is
   not a PDF with **400** and a message naming the reason.
   **Use `sniffPdf(bytes)` — it already exists** (`lib/chart-converter.ts:17`).

   > **Codex R1 High, folded.** v1 of this section specified a *MIME* guard.
   > That does not satisfy I3: `file.type` is caller-controlled and can be empty
   > or spoofed, so a direct caller could upload PNG bytes labelled
   > `application/pdf` and strand the viewer exactly as today. The distinction
   > matters because the picker (`ACCEPT`) is a **hint**, the route is the
   > **boundary**, and a boundary that trusts caller-supplied metadata is not a
   > boundary. `sniffPdf`'s own comment already states the rule — *"Classify by
   > the leading bytes of the FETCHED object, never the claimed MIME/extension
   > (which can be wrong or spoofed)"* — so this repo had written the rule down
   > and I specified something weaker anyway. Same class as every "true in prose,
   > unenforced in mechanism" finding in this project's history.

   The rejection must happen **before storage**, so a spoofed upload never
   produces a row that the viewer will later fail on.
3. **Use the dead `mimeType` field** rather than deleting it: when a chart's
   `mimeType` is present and is not `application/pdf`, `ChartNavigator` renders
   *"This chart is an image. Images can't be displayed in the viewer — replace it
   with a PDF."* instead of the generic "Couldn't load this chart."

Part 3 is not redundant with parts 1–2. Legacy rows exist (Graham's own shows),
and the honest message costs three lines and turns a dead field into the thing
that explains the failure.

**Also:** `page.tsx:3683` hardcodes `type: 'application/pdf'` when building the
share `File`. With parts 1–2 that becomes true by construction; it stays as-is,
noted here so a future reader knows it was checked rather than missed.

### 1.3 Stop presenting an unsavable title as editable (`#2`)

**Today:** `page.tsx:4647` is a free-text input. On save,
`app/api/shows/update/route.ts:191` writes `title: song.title` — the library's
title — back over it. The title-based lookup at `route.ts:100` is guarded by
`if (!song && entry.title)`, so for any row carrying a `song_id` it never runs.

**Graham ruled: read-only in the setlist, rename in the library.**
The deciding argument: typing over a linked song's title is genuinely ambiguous —
renaming "Wonderwall" to "Champagne Supernova" could mean *rename this song* or
*swap this row to a different song*, and the existing song picker already
expresses the second meaning unambiguously.

**Spec — the precise rule, which is not "make the field read-only":**

| Row state | Title field | Why |
|---|---|---|
| `songId` present (library-linked) | **read-only text**, with a "Rename in Library" affordance linking to `/library` | The server overwrites it; presenting it as editable is I2's violation |
| `songId` absent (imported/unresolved row) | **stays editable** | `route.ts:100` genuinely uses `entry.title` to resolve or auto-create. Making this read-only would break CSV import and the AI's `update_setlist`. |

That distinction is load-bearing and is the reason this is not a one-line change.

**What the user sees:** a linked title renders as text with a small "Rename in
Library" link; an unresolved row still takes typing, as it must.

**★ The parallel path, found in the same sweep and NOT fixed here.** The AI's
`update_setlist` can also set `title` on a row that already carries a `songId`,
and `route.ts:191` overwrites it identically — so the AI path keeps the silent
no-op that §1.3 removes from the UI. It is not fixed in this document because the
honest fix is the same product question Graham already ruled on (renames belong
in the library), and the AI has no library-rename tool. **Recorded as a known
limitation** so it is not later rediscovered as a regression introduced by this
work. Candidate follow-ups, not scheduled: teach `summarizeApplyImpact` to report
"N title changes will be ignored", or give the agent a rename tool.

---

## §2 Chunk 2 — AI apply integrity

Fixes gap-doc findings 3 and 6 together, because they are one flow.

### 2.0 What the audits missed, found while speccing

The client-side cascade is **not** the only destroyer. `lib/agent.ts:39`
instructs the model: *"ALWAYS cascade… Call `update_stage_plot`, `update_inputs`,
and `update_monitors` together."* Those tool schemas carry **no `id` and no
`slotId`** (`lib/agent.ts:77-123`; `required` is `['ch','inst','mic','stand']`
and `['mix','name','needs']`). So approving the model's *own* `update_inputs`
wipes every input↔slot link even with the client cascade deleted.

**Deleting the cascade alone would not have fixed #3.** Identity has to be in the
schemas.

### 2.1 Put the stable identifiers in the tool contract

The model already receives the entire current config, ids included, as JSON in
`<current_config>` (`app/api/agent/chat/route.ts:79-80`). It can echo ids; it is
simply never asked to.

**Spec:**
- `update_stage_plot` slots gain optional `id`.
- `update_inputs` inputs gain optional `id` **and optional `slotId`**.
- `update_monitors` monitors gain optional `id`.
- All remain optional, and none are added to `required` — a model that omits them
  must degrade to today's behaviour, not error.
- The system prompt gains an explicit rule: *when modifying an existing
  configuration, echo the `id` (and `slotId`) of every row you are keeping,
  verbatim from `<current_config>`; omit them only for genuinely new rows.*

**Apply:** a row arriving with an `id` keeps it. A row arriving without one gets
a fresh id from the §2.3 normalizers. That is the whole mechanism.

**Stated limitation, not hidden:** this depends on the model echoing correctly. A
dropped `id` silently becomes a new row and its links break. **§2.4 is the
backstop for exactly that**, and is why §2.4 is not optional polish.

### 2.2 Remove the client-side cascade, conditionally

**Today:** `page.tsx:5318-5350` regenerates the entire input list from the
keyword heuristic `expandSlotToInputs` and rebuilds monitors with `needs: ''`
hardcoded, on every `update_stage_plot` apply.

**Spec:**
- `update_stage_plot` applies **only** `stagePlot` when the show already has
  content — `inputs.length > 0` or `monitors.length > 0`.
- When both are empty (a genuine first generation), the cascade still runs. This
  preserves the first-run "describe your band" magic, which is the flagship flow
  and the one thing the cascade was actually good for.
- `needs: ''` is **never** written over an existing monitor row. When the cascade
  runs at all, it is populating empty state, so there is nothing to blank.

**Deviation from `design-input-plot-linkage.md`, deliberate:** that doc says
delete the self-cascade outright (line 68). Deleting it outright would leave a
first-run AI plot with an empty input list, which is a worse first ten minutes
than the bug we are fixing — and the model's own `update_inputs` call is a
*separate approve card* the user may reject. The conditional satisfies the same
invariant (I4: never destroy user data) while keeping the empty-state value.

### 2.3 Every row gets an id, at the mutation chokepoint (`#6`)

**Today:** `page.tsx:595` — `updateConfig` runs **only** `ensureStageSlotIds`.
`ensureSetlistSongIds` / `ensureInputIds` / `ensureMonitorIds` run only inside
`withStableIds` on load (`page.tsx:304-318`). Every AI-applied row therefore
lands with `id: undefined`, and `page.tsx:4548`, `:4580`, `:4622`, `:4720`,
`:4753`, `:4882`, `:4910`, `:4941` all dereference `id!`.

**Spec:** `updateConfig` uses `withStableIds` instead of `ensureStageSlotIds`
alone. **The function already exists and already does exactly this**, including a
change-detection guard that returns the original object when nothing was minted
(`page.tsx:313-317`) — so this is a one-line substitution, not new code, and it
does not allocate on no-op mutations.

**Checked, not assumed:** `withStableIds` runs `ensureStageSlotIds` *first* so
input id-minting runs on top of any cleared `slotId`s — its own comment says the
ordering is deliberate. Calling it per-mutation preserves that ordering.

**★ `updateConfig` is NOT the only site, and v1 of this section was wrong to name
only it.** Found by sweeping for the class Codex R1's second finding named
(*guarded one path, left another that triggers the same event*) rather than only
folding the finding. `grep 'setConfig('` returns five sites:

| Site | Today | Disposition |
|---|---|---|
| `page.tsx:595` `updateConfig` | `ensureStageSlotIds` only | → `withStableIds` |
| `page.tsx:613` `applyImportMerge` | `ensureStageSlotIds` only | → `withStableIds` |
| `page.tsx:621` `undoImport` | `ensureStageSlotIds` only | → `withStableIds` |
| `page.tsx:426` offline cache restore | already `withStableIds` | unchanged |
| `page.tsx:484` fetch load | `cfg` already normalized at `:461` | unchanged — **verified, not assumed** |

`applyImportMerge` and `undoImport` **deliberately bypass `updateConfig`** (their
comments say so, and the reason — no side effect inside a state updater — is
still valid). But they call `ensureStageSlotIds` alone, so **setlist rows arriving
from a CSV/sheet import get no `id`**, and `page.tsx:4548`, `:4580`, `:4622`
dereference `s.id!`. That is the identical broken-keys/dead-drag defect as the AI
path, on the import path, and fixing only `updateConfig` would have shipped it.

The fix does not change the bypass — it swaps the normalizer at all three sites.

### 2.4 Make residual loss loud (the backstop for §2.1)

**Spec:** a pure function

```
summarizeApplyImpact(current: AppConfig, toolName: string, toolInput: unknown)
  → {
      inputsUnlinked: number;          // inputs whose slotId will dangle
      monitorNeedsCleared: number;     // non-empty `needs` about to be blanked
      rowsRemoved: number;             // rows present now, absent after
      mixesRemoved: number;            // live mix numbers about to disappear
      performersOrphanedByMix: number; // slots whose `mix` will dangle as a result
    }
```

computed **before** applying, and rendered on the approve card as a plain warning
when any count is non-zero:

> ⚠ Applying this will unlink 12 inputs from their performers, clear 3 monitor
> "needs" entries, and leave 4 performers pointing at a mix that no longer exists.

> **Codex R1 High, folded.** v1 counted only unlinked inputs, cleared needs, and
> removed rows — **and therefore left the AI path unguarded against the very
> defect §3 exists to fix.** An approved `update_monitors` can remove or renumber
> a live mix and orphan every performer whose `stagePlot[].mix` points at it,
> silently, while §3's prompts cover only the *manual* delete and renumber. That
> is this project's most-repeated defect class verbatim: **I fixed one call site
> and left the other path that triggers the same event.** The AI-key work hit it
> twice in one chunk (R1 fixed the button, R2 found the input field). It is the
> reason `renumberMix` is one funnel in §3.3, and the same discipline has to
> reach the apply path.

**`validateMonitors` runs on the AI `update_monitors` apply path too** — not only
on manual edit/add/renumber (§3.3). A model can emit duplicate or non-positive
mix numbers as easily as a user can type them, and today's `[1, 2, 5]` example in
§3.3 comes *from* an AI-produced list. A failing plan is refused with the reason
shown on the card, and nothing is applied.

**State-and-recovery for that refusal** (required of every error path in this
project — an error return is not a fix if it strands the caller): the config is
**unchanged**, the proposal **stays in the transcript**, and the card shows why
it was refused plus what to do — *"This plan would create two Mix 3 rows. Ask
again, or renumber the existing mix first."* The user is never left with a
half-applied plan or a card they cannot act on. No auto-retry.

**Why this is the load-bearing piece:** §2.1 depends on model behaviour, which we
do not control. This converts a silent destruction into an informed choice, which
is I4's actual requirement — the invariant is "without the user being told
first," not "never." It is also a pure function over two plain objects, so unlike
the apply path itself it is fully testable in this repo's harness.

**Not** a block: the user can still approve. No new refusal path, so no new
stranding.

---

## §3 Chunk 3 — Mix identity

Fixes gap-doc finding 4. **Graham ruled: full v9 minus the derived roster
display.**

### 3.1 The defect restated in one line

`StageSlot.mix` is a bare `number` (`lib/types.ts:14`) matched by value against
`MonitorMix.mix`. `MonitorMix.id` exists (`lib/types.ts:31`) and **nothing
references it**. Reorder (`lib/setlist.ts:171`) and delete (`page.tsx:6306`) both
rewrite `mix = i + 1` and leave every `stagePlot[].mix` untouched.

### 3.2 Mix number becomes an immutable routing identity

A mix number *is* an aux number — "Mix 3" is aux 3, like a console. It changes
only when the user deliberately renumbers it.

- **Drag-renumber is removed.** `moveMonitor` (`lib/setlist.ts:164-172`) is
  deleted along with its drag grip (`page.tsx:4946`) and ↑/↓ buttons
  (`page.tsx:4960-4961`). Monitor rows render **sorted by `mix`**.
- Domain justification, from the design doc: you do not renumber a console aux by
  dragging a row. The reorder affordance was offering a capability that cannot
  exist.
- **Note the asymmetry with `moveInput`** (`lib/setlist.ts:146-154`), which also
  renumbers `ch` and is *safe* — nothing references `ch`; input links are by
  `slotId`. That is why input drag stays and monitor drag goes.

### 3.3 `renumberMix(from, to)` — the one deliberate path

```
renumberMix(config, from, to) → AppConfig
```
Sets the monitor row's `mix` to `to` **and** remaps every `stagePlot[].mix ===
from` to `to`, in one transaction. Rejects when `to` collides with a live monitor
or is not a positive integer.

**This makes the Mix # cell editable**, which it is not today — `page.tsx:4950`
is a read-only `<span>`, while an unreachable `field === 'mix'` branch lingers in
the handler (`page.tsx:6299-6303`). The dead branch is deleted; the cell becomes
an input routed through `renumberMix`.

**Confirm-worthy:** a renumber implicitly moves a group of performers, so it
prompts and names who moves.

`validateMonitors(monitors)` enforces unique positive integer `mix` values and
rejects duplicates and `≤ 0`. `onAdd` seeds `max(existing.mix) + 1`
(`page.tsx:6310` currently uses `length + 1`, which collides whenever numbering
is sparse — reachable today via any AI-produced `[1, 2, 5]`).

### 3.4 Delete orphans, it does not cascade (I7)

Deleting a monitor removes that aux. There is no destination to remap to, so
slots pointing at it become **orphaned-mix**:
- a slot-level needs-attention badge, mirroring the input orphan badge that
  already exists (`page.tsx:4796-4800`, `:4847-4849`);
- the stage-plot mix dropdown shows the dangling value as a flagged, **disabled**
  entry — `"Mix 7 — removed"` — instead of today's bare fallback `<option>`
  (`page.tsx:6140-6142`), so the user can see they *were* on Mix 7 rather than
  having it silently read as "None";
- the delete prompt **names the affected performers**, mirroring the slot-delete
  prompt (`page.tsx:6191`).

Orphaned-mix is an **allowed, flagged state, not a hard error** — a slot may
carry a `mix` with no matching row after a delete or a hand-edited import.
Rejecting it would make deleting a referenced mix impossible.

### 3.5 The `OccupantChip` badge must stop lying

`page.tsx:261-264` renders `MIX {slot.mix}` with no membership check against
`config.monitors`, on screen **and in print**. It gains the orphan treatment, so
a rider never ships a confident badge for a mix the monitor section does not
list.

**Out of scope, per Graham:** the derived read-only roster beside each monitor row
("→ Strings, Brass"). `monitor.name` therefore remains free text with no enforced
relationship to the slots pointing at it — the cross-view disagreement in gap-doc
finding 7 is **reduced but not closed**, and that is a deliberate, recorded
choice.

---

## §4 Test plan

The house rule applies: **a test must distinguish the correct implementation from
the plausible-wrong one.** Every rule below gets its mutation.

**Chunk 1**
1. A rejected `fetch` sets `saveError`; the pill renders red, not "Saved".
2. A subsequent successful save clears it.
3. Upload route **sniffs bytes**: PNG bytes are rejected 400 **even when the
   claimed MIME is `application/pdf`** (the distinguishing case — a MIME-only
   guard passes this and is the implementation Codex R1 rejected), and a real PDF
   with an empty/missing `type` is **accepted**.
4. `ChartNavigator` renders the image-specific message for a non-PDF `mimeType`,
   and the generic load error for a PDF that genuinely fails.
5. Title is read-only **iff** `songId` is present — both directions, since the
   `songId`-absent case is what keeps import working.

**Chunk 2**
6. `update_stage_plot` on a config with existing inputs leaves `inputs`
   byte-identical.
7. …and on a config with empty inputs/monitors, still cascades.
7a. **Codex R1 medium, folded — the case that catches the plausible-wrong
    implementation:** `inputs` empty but `monitors` non-empty with typed `needs`.
    Assert `monitors` stays **byte-identical**. An implementation that gates the
    whole cascade on `inputs.length === 0` alone passes tests 6 and 7 and still
    blanks every monitor's `needs` — which is half the original bug. The rule is
    "either has content", and only this case distinguishes it.
7b. The mirror: `monitors` empty but `inputs` non-empty ⇒ `inputs` untouched.
8. A slot echoing its `id` keeps it; a slot without one is minted a new one.
9. An input echoing `slotId` keeps its link across an apply.
10. `updateConfig` mints ids for setlist/inputs/monitors, not just slots —
    asserted on the AI-apply path specifically, since that is the broken one.
10a. **The same assertion on `applyImportMerge`**: setlist rows arriving from a
    CSV/sheet import carry ids afterwards. This is a *different call site* with
    the same defect (§2.3), and a fix applied only to `updateConfig` passes
    test 10 and fails this one.
11. `summarizeApplyImpact` counts unlinked inputs, cleared needs, and removed
    rows. **Distinguishing test:** an apply that changes nothing reports zeroes
    (a plausible-wrong implementation reports the whole array length).
11a. It also counts `mixesRemoved` and `performersOrphanedByMix` — an
    `update_monitors` dropping a live mix that three slots point at reports
    `mixesRemoved: 1, performersOrphanedByMix: 3`. Without this the AI path has
    no surface for the defect §3 exists to fix.
11b. **`validateMonitors` runs on the AI apply path:** an `update_monitors`
    carrying duplicate or non-positive mix numbers is refused, **the config is
    unchanged** (assert byte-identical, not merely "an error was shown"), and the
    proposal survives in the transcript so the user can act.

**Chunk 3**
12. `renumberMix(3 → 5)` remaps every `slot.mix === 3` and leaves others alone.
13. `renumberMix` rejects a collision and a non-positive target, mutating nothing.
14. Deleting a monitor leaves `stagePlot[].mix` **untouched** — the direct
    regression test for the shipped bug.
15. Orphan detection: a slot whose `mix` matches no monitor is flagged; one that
    matches is not.
16. `validateMonitors` rejects duplicates and `≤ 0`, accepts sparse `[1, 2, 5]`.
17. `onAdd` after `[1, 2, 5]` yields `6`, not `4`.
18. **`moveMonitor` is gone** — assert the export no longer exists, so its
    deletion cannot be quietly reverted.

---

## §5 Decisions ruled by Graham (do not re-litigate)

1. **All six Tier-1 items in scope.**
2. **No production-data repair or migration** — shows are past-tense or
   recreatable. This is why §3 needs no backfill for pre-existing orphans.
3. **#4 = full v9 minus the roster display.**
4. **#2 = title read-only in the setlist, renamed in the library.**

## §6 Relationship to `design-input-plot-linkage.md` step 6

Step 6 specified an **op-based** AI contract (add/update/remove ops), an atomic
apply, and a delta gate. This document builds **identity-preserving full-replace
plus an impact warning** instead. Same invariants (I4, I5), materially less work,
and it does not require rewriting the tool contract the model is already trained
against by the system prompt.

**What step 6 still holds that this does not build:** true op-level granularity
(so a model can say "move one slot" rather than re-emitting the world) and a
hard atomic gate that refuses a partially-invalid plan. Both remain open. This
document should be treated as reducing step 6's scope, not closing it — and
`design-input-plot-linkage.md` should have its status line updated to say so
rather than sitting at "Proposed (v9)" implying nothing shipped.

## §7 Explicitly out of scope

Tier 2 and Tier 3 of `docs/uat-readiness-gaps.md`, except where a fix above
touches the same lines. Named here so the boundary is visible: the `/mockup`
route (gap #13), concurrency control (#16), positional deep links (#14), Replace
destroying a verified overlay (#15), and the converter's 60s blocking upload
(#12) are all **not** in this document.
