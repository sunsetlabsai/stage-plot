# UAT Readiness — Core-Path Gap Audit

**Status:** Findings, not a design. Nothing here is scheduled until Graham cuts the line.
**Date:** 2026-08-19
**Scope:** the core path, in Graham's order — AI stage plot → manual stage plot →
input list → mon mix → chart reading → chart building. Plus the save path and the
first ten minutes, because everything else depends on them.
**Method:** four parallel read-only code audits, then every Tier-1 claim
re-verified by hand against the source. Conductor/relay is deliberately out of
scope ("icing, not cake").

---

## The one thing to take away

**Nearly every defect below is silent, and most of them report success.**

- A network save failure renders a green **"Saved"**.
- An AI apply that destroys the input list renders **"Applied"**.
- A song title edit reverts on reload with no error.
- Deleting a monitor mix silently re-points every performer's wedge.
- An uploaded PNG chart shows a role chip, a chart count, and a working owner
  preview — and a blank canvas for every performer.

For outside testers this is the worst available failure shape. It produces
unreproducible bug reports, and it teaches testers to distrust the parts that
*do* work. **The cheapest single improvement to UAT quality is not fixing all of
these — it is making the failures loud.**

### The second takeaway: most of this was already designed

`docs/design-input-plot-linkage.md` sits on `main` marked **"Proposed (v9) —
ready for adversarial review (Codex R6)"**. Its steps 1–5 shipped (stable
`slotId`, DnD, orphan badges, the Position dropdown — all solid). **Step 6 did
not.** Step 6 is the AI-apply contract, the atomic apply, the delta gate, the
monitor-mix invariants, and the deletion of the self-cascade. Findings 3, 4, 6,
14 and 17 below are all step 6. The doc even names the code: line 68 says the
`update_stage_plot` apply "already self-destructs links" and that the
regeneration should be removed. It was not removed.

---

## TIER 1 — blocks UAT

Silent data loss, or the app actively claiming success while failing.

### 1. A save that fails on the network reports success
`lib/use-show.ts:103` — `catch { }` with only a comment. `setSaveError` is never
called, so `lastSavedAt` keeps its prior value and the status pill at
`app/[owner]/[show]/page.tsx:826` renders green **"Saved"**.
Only a non-`ok` HTTP response sets an error (`use-show.ts:100`).

**Symptom:** a tester edits for twenty minutes on venue wifi — the literal target
environment — sees "Saved" throughout, closes the tab, loses everything.
**Precision:** requires one prior successful save in the session (`lastSavedAt`
null renders blank). That is the normal case.

### 2. Editing a song title is a phantom write
- The field is free text: `page.tsx:4647`, `onUpdate(idx, 'title', …)`.
- On save the server writes the **library's** title back over it:
  `app/api/shows/update/route.ts:191` — `title: song.title`.
- The title-based lookup at `route.ts:100` is guarded by `if (!song && entry.title)`,
  so for any row carrying a `song_id` it never runs.
- Nothing in the show page ever sends a title to `/api/songs/update`. Repo-wide
  grep returns exactly two callers: the BPM writer (sends `{id, bpm}` only) and
  `/library`.

**Symptom:** owner fixes a typo, sees green "Saved", reloads, typo is back.
100% reproducible.
**Aggravator:** merely *opening* a show as owner migrates it to the entries path
(`page.tsx:566-570` fires on load; `lib/overrides.ts:28-32`), so a tester who
renames a song early may see it work once and never again.
**Compounding, from the chart audit:** the Manage Charts modal is passed the
*edited* title (`page.tsx:4668`) and uploads normalize it into a new `song_key`
(`components/ManageChartsModal.tsx:50`). So: edit title → add chart → reload →
title reverts **and the chart is gone**, filed under a key no song points at.
Meanwhile `key`/`lead`/`notes` on the same row *do* persist as overrides
(`route.ts:157-159`), so the failure looks arbitrary.

### 3. Applying an AI stage-plot change destroys the input list and monitor needs
`page.tsx:5318-5350`. `update_stage_plot` does not just set `stagePlot`:
- it regenerates the **entire** input list from the keyword heuristic
  `expandSlotToInputs` (`page.tsx:5196-5271`), renumbering `ch` from 1 and
  replacing every mic/stand/note with generic guesses;
- it rebuilds monitors with **`needs: ''` hardcoded** (`page.tsx:5345`);
- the regenerated inputs never set `slotId`, and the replacement slots arrive
  id-less, so `ensureStageSlotIds` mints fresh UUIDs — severing every
  input↔slot link the tester built by hand.

No confirm, no warning, no undo (`importUndo` is setlist-only), and the 2s
autosave commits it.

**Symptom:** the single most natural UAT action — "ask the AI to move the drummer
to USL, click Apply" — silently discards twenty minutes of channel tuning and
blanks every monitor's Needs column. The card says **Applied**.

### 4. Deleting or reordering a monitor mix silently re-routes the whole band
The mix **number is the reference**. `StageSlot.mix` is a bare `number`
(`lib/types.ts:14`) matched by value against `MonitorMix.mix`. `MonitorMix.id`
exists (`lib/types.ts:31`) but nothing references it — it is only a React key.

Two of the three monitor operations rewrite that reference:
- reorder — `lib/setlist.ts:171`: `arr.map((mon, i) => ({ ...mon, mix: i + 1 }))`
- delete — `page.tsx:6306`: the identical `.map((mon, i) => ({ ...mon, mix: i + 1 }))`

Neither touches `stagePlot[].mix`.

**Symptom:** mixes 1–5, drummer on 4, lead vox on 5. Delete mix 2 → survivors
renumber → the drummer's slot still says `mix: 4`, which is now the singer's
wedge; the singer points at a mix that no longer exists. The stage plot renders a
confident coloured `MIX 5` badge (`page.tsx:261-264`) with no membership check.
The printed rider hands a venue a plot referencing mixes the monitor section
doesn't list.

**The reorder case is worse than the delete case** — the user's intent was purely
cosmetic (tidying print order), and domain-wise renumbering an aux by dragging a
row is nonsense. Contrast slot deletion (`page.tsx:6191`), which *does* prompt.

**Designed and unbuilt:** `docs/design-input-plot-linkage.md:237` states this
defect verbatim and prescribes removing drag-renumber, immutable mix identity,
`renumberMix(from,to)` with atomic slot remapping, and orphaned-mix badges.
`renumberMix`, `validateMonitors`, `removeMonitor`, `orphanedMix` return **zero
hits** outside docs. No test references `moveMonitor`.

### 5. Image charts can be uploaded but cannot be viewed by anyone
- The picker invites them: `components/ManageChartsModal.tsx:12` —
  `const ACCEPT = '.pdf,.png,.jpg,.jpeg'`; the upload route accepts any mime
  (`app/api/charts/upload/route.ts:36-58`).
- The in-show viewer has **no image branch**. `chart.mimeType` is written once at
  `page.tsx:473` and **never read again** anywhere in the file. `ChartNavigator`
  renders either an external-only link or a `<canvas>` (`page.tsx:3749-3766`).
- `loadPdfDoc` hands PNG bytes to pdf.js → throws → `setLoadError(true)`
  (`lib/pdf-viewer.ts:120-131`).

**Symptom:** owner adds `chart.png`. The role chip appears, the library says
"1 chart", and the owner's own preview in the modal renders fine
(`ManageChartsModal.tsx:356-359`) — so it looks like it worked. Every performer
who taps it gets "Couldn't load this chart."
**Cheapest fix:** restrict `ACCEPT` to `.pdf` and reject non-PDF at the route.
Also `page.tsx:3683` hardcodes `type: 'application/pdf'` on share, so sharing an
image AirDrops a corrupt PDF.

### 6. Every AI-applied row lands without a stable `id`
`page.tsx:595` — `updateConfig` runs **only** `ensureStableSlotIds`.
`ensureSetlistSongIds` / `ensureInputIds` / `ensureMonitorIds` run only inside
`withStableIds` on load (`page.tsx:304-318`). The AI apply path assigns raw tool
output straight through (`page.tsx:5353`, `:5355`, `:5357`, and the cascade at
`:5327`/`:5342-5346`), and none of the tool schemas carry `id` (`lib/agent.ts`).

Consumers dereference `id!`: `page.tsx:4548`, `:4580`, `:4622` (setlist),
`:4720`, `:4753` (inputs), `:4882`, `:4910`, `:4941` (monitors).

**Symptom:** the flagship first-run flow — "Describe your band, lineup, and stage
layout…" (`page.tsx:5594`) — produces tables whose React keys are all
`undefined`: duplicate-key warnings, rows that mis-render on edit, dead drag
handles, and deletes that hit the wrong row. Fixed by F5, which makes it a
miserable bug report. Hand-added rows are fine; only the AI path is affected.

---

## TIER 2 — high-frequency traps and bad first impressions

### 7. A brand-new show opens on a dead-end empty state, after flashing a stranger's band
- New shows are created empty (`app/dashboard/page.tsx:427-434`) and the default
  tab is `'perform'` (`page.tsx:364`), which renders "No setlist yet."
  (`page.tsx:1088`) — no CTA, no link to Config. The Mix tab is an empty grid.
- Before the fetch resolves, `initConfig()` renders the hard-coded **Loosely
  Covered** demo band (`page.tsx:320-337`, `lib/bands/index.ts:9-13`) — a
  stranger's full plot, input list and mixes — then blanks.
- **Worse:** `page.tsx:459` — `if (cancelled || !data?.config) return;` — a
  response without a config leaves the demo band on screen permanently, with no
  error and no `showId`, so nothing saves.

### 8. The delete-slot dialog has no abort, and unlinked slots delete with no prompt at all
`page.tsx:6191-6216`. The `window.confirm` result feeds a `keep` flag; the slot is
then filtered out **unconditionally**. The dialog is honest — it labels OK as
"keep them" and Cancel as "clear their link", both delete-variants — but there is
no way to abort a misclick, and when `linked.length === 0` the confirm is skipped
entirely, so deleting a slot is instant and unrecoverable.

### 9. "Import Show" replaces the entire show with no confirm and no undo
`page.tsx:6650-6666` — fires straight from the file picker's `onload`, autosaves
2s later. `reader.onerror` is unhandled, so a read failure is a silent no-op.
Contrast the setlist import, which has a full preview/diff/apply/cancel flow
(`components/SetlistImportPreview.tsx`).

### 10. Offline fallback silently strips the Config and AI tabs
`page.tsx:419-432` restores config from localStorage but never sets `showId`,
`isOwner`, or `isEditor`. Therefore: `saveConfig` is never called (`page.tsx:566`),
so even the localStorage cache stops updating; `isReadOnly` hides the Config and
AI tabs (`page.tsx:758`, `:770`); and the read-only banner is gated on `showId`
(`page.tsx:722`) so **nothing renders to explain it**. Same path when the
ownership check throws (`page.tsx:542-544`).

### 11. One unresolvable setlist row aborts the whole save
`route.ts:148-153` returns 400 for any unresolvable entry and aborts the **whole**
save, including unrelated stage-plot and monitor work. The AI `update_setlist` and
CSV import both introduce rows with no `songId`. The AddSong widget warns about
this (`page.tsx:4508-4511`); the AI and import paths do not.

**⚠ Narrowed 2026-08-25 — see `design-single-backend.md` §3.3c.** This was titled
*"locks an **editor** out of saving anything"* and turned on the auto-create
fallback being owner-only (`route.ts:107`) while `shouldSendEntries` was
unconditional for editors (`lib/overrides.ts:25`). **With collaborators view-only,
the editor half of this gap is gone** — only owners save, and owners have the
fallback. **What survives is narrower but real:** the auto-create requires a
`songKey` (`route.ts:107` — `show.owner_id === user.id && songKey`), so an entry
with neither a resolvable `songId` nor a `songKey` still 400s and still discards
unrelated stage-plot work. **Re-verify the residual before actioning this gap** —
its original severity was measured against a principal that no longer exists.

### 12. Chart upload blocks up to ~60s with no progress, no cancel, and often no message
- `lib/chart-upload.ts:87` awaits the converter inline; the route ceiling is 60s
  with a 50s vision abort (`app/api/charts/convert/route.ts:18`,
  `lib/chart-vision.ts:6`).
- The only indicator is the Add button reading "Working…"
  (`ManageChartsModal.tsx:265`). The **Replace** path has no label change at all,
  and when all 7 roles are filled the Add block isn't rendered — so Replace gives
  **zero feedback for a minute**.
- No `AbortController` (`ManageChartsModal.tsx:46-73`); closing the modal
  mid-upload loses the result until a reload.
- Any non-2xx from the converter is swallowed to `null`
  (`lib/chart-upload.ts:54`) and `reportOverlay` early-returns — so 401/403/500/
  504/network-drop produce **no message whatsoever**.
- No retry affordance exists.
- `ManageChartsModal.tsx:76-86` reuses the amber `error` line for *success*, so
  "Chart uploaded — overlay skipped" reads as a failure.

### 13. A fully fake builder ships in the production route table
`app/mockup/roadmap-builder/page.tsx` — Generate ignores input and `setTimeout`s a
hard-coded sample (`:125-132`); Save prints "(mock) Saved" (`:429-438`); two
"Dictate (coming soon)" buttons. **Confirmed present in the build manifest**
(`.next/app-path-routes-manifest.json` maps `/mockup/roadmap-builder`) and
`middleware.ts:12-16` does not block it. Unlinked, but any tester who finds it
files a pile of bogus bugs.

---

## TIER 3 — real, survivable during a supervised UAT

14. **Shared chart deep links are positional** — built from `song.position`
    (`lib/share.ts:37-45`) and matched the same way (`:58-70`), while reorder
    renumbers every position (`lib/setlist.ts:58-70`). Stable `id`/`songId` were
    available. A link shared in the afternoon opens a *different song* after a
    soundcheck reorder — silently, with no error if the role happens to match.
15. **Replace silently destroys a verified overlay.** Calibration is keyed
    `(chart_id, source_hash)`, so new bytes = empty overlay. Replace carries no
    warning (`ManageChartsModal.tsx:224-232`) though Delete does (`:145`), and
    **no surface anywhere shows whether a chart has an overlay or is verified**.
    At the gig the bar transport has silently vanished for that song.
16. **No concurrency control at all.** `rpc_save_show` updates unconditionally;
    `setlist_entries` is deleted and re-inserted every save
    (`migrations/007:51`). Last write wins, whole setlist wiped, no warning.
    **⚠ Reframed 2026-08-25, NOT dissolved.** This read *"Two editors at
    soundcheck"*. There are no editors — collaborators are view-only
    (`design-single-backend.md` §3.3c). **The gap survives intact**, because
    `rpc_save_show` is keyed on the SHOW and carries nothing per-session: **one
    owner on two devices** — phone and laptop at soundcheck, a thoroughly normal
    setup — collides exactly the same way. Removing the editor tier reduces *how
    many people* can trigger this; it does not reduce the gap.
    `lib/use-show.ts:92` writes a
    `showrunr-last-saved-` timestamp commented "for offline conflict detection"
    that is **never read anywhere in the repo**. The roadmap builder *does* have
    optimistic concurrency (`migrations/011`); the show path has no equivalent.
17. **Mix numbers can't be typed, and duplicates are reachable.** The Mix # cell
    is a read-only `<span>` (`page.tsx:4950`) while an unreachable `field === 'mix'`
    branch lingers in the handler (`page.tsx:6299-6303`). `onAdd` seeds
    `length + 1` (`page.tsx:6310`), which collides whenever numbering is sparse —
    the design required `max(existing.mix) + 1`. So the only way to reach mix 3
    is add/delete churn, i.e. the operation that corrupts references (#4).
18. **`featured` can be set by the AI and never unset in the UI.** It is in the
    tool schema (`lib/agent.ts:68`), encouraged by the prompt (`:25`), drives a
    loud chip style (`page.tsx:259`), and has no editor column
    (`page.tsx:6098-6104`). Escape hatches: re-prompt the AI, or hand-edit YAML.
19. **Up to 2s of edits lost on tab close.** 2000ms debounce
    (`lib/use-show.ts:118-125`); the only flush is the React unmount cleanup.
    Repo-wide grep for `beforeunload`/`pagehide`/`visibilitychange`: zero hits.
20. **Both AI chart features depend on one unprobed platform key**, with no
    availability probe, no BYOA, and no rate limit — unlike the chat tab, which
    has all three. Converter degrades to a message
    (`app/api/charts/convert/route.ts:104`); roadmap parse 503s *after* the tester
    types a description (`app/api/charts/roadmap/parse/route.ts:48`). No per-owner
    cap on vision spend.
21. **Operator setup is undocumented.** `README.md` is unmodified
    `create-next-app` boilerplate. The `charts` storage bucket must be created by
    hand — `migrations/001` ends with a *comment*, not SQL. Without it every chart
    upload fails.
22. **Occupants cannot be reordered within a zone** (`page.tsx:6107-6189` has no
    handle and no arrows, unlike the input and monitor tables), and stage-plot rows
    are keyed by array index (`page.tsx:6109`) despite every slot carrying a stable
    `id` — expect "my cursor jumped" reports.
23. **`sceneNote` persists but has no editor** (`page.tsx:4646-4657`) — reachable
    only via CSV import or the AI.
24. **No cache control on real shows.** `OfflineSection` — the size readout and
    Clear Cache — is gated `{!showId && …}` (`page.tsx:6586-6592`), so it is
    unreachable for any saved show. Auto-cache pulls all roles ignoring the filter
    (`page.tsx:504-506`) and never evicts deleted charts, so it grows
    monotonically with no in-app recourse.
25. **The Drive chart path and its only documentation are unreachable** — gated
    behind `{!showId && (` (`page.tsx:6491`), so the "How it works" chart help
    never renders for a real show, leaving an unlabelled "Manage" link as the only
    entry point to a headline feature.

---

## Verified as CORRECT — do not re-investigate

Recorded so this audit isn't repeated on ground that is already solid.

- **Chart cache invalidation is right.** Keys include full-ms `modifiedTime`
  (`lib/chart-cache.ts:8-15`), a DB trigger bumps `updated_at`
  (`migrations/003:33-35`), CDN URLs are `?v=`-stamped, and `cacheChart` evicts
  prior versions. A replaced chart does **not** serve stale bytes.
- **BPM is NOT a phantom write.** It routes through `PUT /api/songs/update` via
  `lib/bpm-writer.ts` (`page.tsx:646-667`) and re-hydrates on GET.
  `config.setlist[].bpm` is a read-only mirror. **The risk is structural, not
  live:** any *new* writer setting BPM through `updateConfig` alone would be lost.
  `lib/setlist-import.ts:18,49` refuses to map a BPM column for exactly this
  reason and tells the user (`SetlistImportPreview.tsx:96-104`) — that is the
  right pattern and nothing else follows it.
- **Stage-plot fields have no field-level whitelist to drop them.** `stagePlot`,
  `inputs`, `monitors`, `lineup`, `showInfo`, `notes` ride in the JSONB config
  blob and round-trip intact, `id` included. Only `config.setlist` is rebuilt
  server-side, which is why the phantom-write class is per-song-field only.
- **The profile-claim gate is solid.** `middleware.ts:73-92` redirects to
  `/claim` with `/claim`, `/sign-in`, `/sign-out` exempted so no loop is possible,
  and `profiles` has a `Public read` policy so the anon-client read works.
  `/claim` handles already-claimed, 409, and unauthenticated.
- **The AI-key availability panel is genuinely good** — seven distinct no-key
  states resolved in `lib/agent-availability.ts`, always offering BYOA with a
  "Get a key" link. No dead ends. (This is the work of the last several sessions.)
- **The input↔slot linkage half of the linkage design shipped and is solid** —
  stable `slotId`, a full lifecycle normalizer, de-dupe, orphan flagging, and a
  relink badge. It is the slot↔**mix** half that is missing.

---

## Suspected — NOT verified, needs a probe not a code read

- **The 50s vision abort may fail more often than it succeeds on real charts.**
  `claude-opus-4-6` at `effort: 'high'`, `max_tokens: 16000` over a full PDF
  (`lib/chart-vision.ts:53-76`) plausibly exceeds the timeout beyond 1–2 pages. If
  so, the *common* path is 50s of dead UI then "overlay could not be generated"
  with no retry. **Time 5–10 representative charts before UAT** — this decides
  whether #12 is an annoyance or the dominant tester experience.
- **Pre-existing corrupt `slot.mix` data in production.** Any show ever reordered
  or deleted may already carry orphaned mix references. Nothing on the load path
  detects or repairs it. Requires a DB query, not a code read.
- **Applying a tool call mid-stream may revert the card to pending** after the
  config already mutated (`page.tsx:5145-5152` re-renders live cards; `:5177`
  replaces the message from a pre-send snapshot). Mechanism verified, trigger
  probabilistic — needs `textGrew` to fire after a completed tool block. Worth one
  deliberate probe rather than a fix on spec.
- **AI `update_setlist` may blank library-inherited notes** —
  `diffOverride(undefined, song.notes)` returns `''` (`lib/overrides.ts:55-65`)
  and `notes` is optional in the schema (`lib/agent.ts:138`).
- **Roadmap Builder preview↔PDF visual parity.** Structure is asserted server-side
  (`roadmap/save/route.ts:100-103`); nothing pins visual parity and the builder
  never shows the real PDF before save.

---

## Suggested cut line

**Tier 1 blocks UAT.** All six are silent-failure or silent-data-loss, and four
are small and local: #1 is a few lines in a `catch`; #5 is one string plus a route
guard; #6 is calling the id normalizers that already exist inside `updateConfig`;
#3 is largely *deleting* code the design doc already said to delete.
#2 (title) is a routing decision — either cascade the rename to `/api/songs/update`
or make the field read-only in the setlist and send renames to `/library`.
#4 (mix identity) is the one genuine design question, because the fix is either the
full v9 (immutable mix identity + `renumberMix` + orphan badges) or a
stop-the-bleeding cut (drop drag-renumber, prompt on delete).

**Tier 2 is the "does this feel finished" band.** #13 is a one-line delete. #7 and
#8 are small. #10, #11 and #12 are real work.

**Tier 3 can ship after**, with two caveats: #16 (concurrency) becomes urgent the
moment two people share a show, which is a stated use case; and #21 blocks anyone
but Graham from standing up an environment.
