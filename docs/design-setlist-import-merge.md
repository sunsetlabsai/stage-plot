# Design — Setlist Import: merge semantics + Key/BPM/Artist columns

Status: **DESIGN — Codex R1 folded, awaiting R2**
Version: **v2.0** (v1.0 = pre-Codex)
Scope: Google Sheet setlist import (`/api/sheet` + the Config-tab loader)

**v2 changelog:**

| Change | Source |
|---|---|
| **BPM import removed from v1.** It could not persist — verified. | Codex R1 **blocker** |
| §4 rule 5 — removal is now **opt-in**, plus a second confirmation | Codex R1 high |
| §4 — `mergeSetlist` takes an injected `newId`, making it genuinely pure | Codex R1 medium |
| §5 — `key` matches **exact only**; no substring | Codex R1 answer |
| §7 — one-level **Undo import** added | Codex R1 answer |
| §6 artist deferral confirmed correct | Codex R1 answer |

---

## 1. Why

Two problems, one of which is a live data-loss bug.

**1a. The importer is destructive.** `handleLoadSheet`
(`app/[owner]/[show]/page.tsx:5747-5774`) rebuilds the entire setlist from the
sheet response, minting a fresh `crypto.randomUUID()` per row and carrying only
four fields:

```ts
setlist: (data as { position: number; title: string; lead: string; notes: string }[]).map((s) => ({
  id: crypto.randomUUID(),
  position: s.position,
  title: s.title,
  lead: s.lead,
  notes: s.notes,
})),
```

Every re-import therefore silently discards, for every song:

| Lost field | Consequence |
|---|---|
| `id` | Chart Navigator position + DnD identity reset |
| `songId` | Row detaches from its canonical `songs` row. **BPM/tap-tempo UI disappears** — `showBpm = isOwner && !!song.songId` (`page.tsx:4561`) |
| `key` | Per-show key override gone; Perform tab falls back to `chart.authored_key` (`page.tsx:3582-3586`) |
| `bpm` | Conductor clock loses its static-BPM rung (`lib/types.ts:165-166`) |
| `charts` | Resolved chart links dropped from the show |

There is no warning and no undo. A UAT tester who fixes a typo in their sheet and
re-imports loses their chart wiring. This is the highest-severity item in the
document.

Mitigating fact worth stating precisely: charts are **not deleted**. They live in
the owner-scoped `chart_library` table, matched by normalized title
(`003_chart_library.sql`). Only the show's resolved `SetlistSong.charts` array is
dropped, and auto-resolve can re-populate it when a Drive folder is configured.
The loss is real but recoverable; `songId` and `key` are not.

**1b. The parser reads four columns.** `app/api/sheet/route.ts:35-38` recognizes
`pos`/`#`, `title`/`song`, `lead`/`singer`, `note`. The data model already carries
`key`, `bpm`, `sceneNote` (`lib/types.ts:156-168`) and the library `Song` carries
`artist` (`lib/types.ts:175`). A band whose sheet is their working setlist cannot
get key or tempo in without hand-typing every row.

---

## 2. Decisions taken

Ratified by Graham, 2026-08-10:

> **Merge by title, preserve matched rows.** Match incoming rows to existing songs
> by normalized title; keep their id/charts/bpm, update fields present in the
> sheet, add new rows, and show a diff before applying.

---

## 3. The matching key — must agree with the save path

This is the constraint that drives the design.

`PUT /api/shows/update` already resolves setlist rows to canonical library songs
**by `songId` when present, otherwise by normalized title**
(`app/api/shows/update/route.ts:66-90`, building `songsById` and `songsByKey`).
The normalizer is `normalizeSongKeySafe` (`lib/normalize.ts:22-24`): NFD, strip
diacritics, lowercase, strip punctuation, collapse whitespace, then strip a
leading `the|a|an`.

**Requirement:** the import merge MUST match on `normalizeSongKeySafe(title)` —
the identical primitive, imported from the identical module. It must not
re-implement or approximate it.

Rationale: if the merge matched on, say, raw lowercased title, then `"The Weight"`
in the sheet and `"Weight"` in the setlist would be treated as different songs at
import time and the *same* song at save time. The row would be added as new,
then collapse onto the existing library song during `rpc_save_show`, producing a
duplicate-position setlist. Sharing the primitive makes that class of bug
impossible by construction.

**Mechanism status: EXISTS.** `lib/normalize.ts` is already imported by
`app/api/shows/update/route.ts:4` and `lib/overrides.ts:1`. No new code.

---

## 4. Merge algorithm

Pure function, new module `lib/setlist-import.ts`:

```ts
export function mergeSetlist(
  existing: SetlistSong[],
  incoming: ImportedRow[],
  opts: { newId: () => string; removeMissing: boolean },
): { merged: SetlistSong[]; diff: ImportDiff }
```

`newId` is **injected**, not called from inside (Codex R1 medium): v1 described
the function as pure while it minted `crypto.randomUUID()` internally. Tests pass
a counter (`() => \`new-${n++}\``), which makes the no-op round-trip assertion
(test 8, §9) an exact deep-equal instead of an id-blind comparison. Production
passes `crypto.randomUUID`.

**Rules, in order:**

1. Build `byKey: Map<string, SetlistSong[]>` over `existing`, keyed by
   `normalizeSongKeySafe(title)`. Rows whose title normalizes to `null` (blank,
   punctuation-only) go in an unmatchable bucket and are treated as
   removal candidates.
2. Walk `incoming` **in sheet order**. For each row, take the *first unconsumed*
   existing row with the same normalized key and mark it consumed. Consumption
   is what makes duplicate titles behave: two `"Intro"` rows in the sheet pair
   with the two `"Intro"` rows in the setlist, first-to-first.
3. **Matched row** → carry forward `id`, `songId`, `charts`, and every field the
   sheet did not supply. Overwrite only fields present as a **non-empty cell** in
   the sheet. Sheet order sets `position`.
4. **Unmatched incoming row** → new row, fresh `crypto.randomUUID()`, no
   `songId` (the save path resolves or creates the library song).
5. **Unconsumed existing row** → removal candidate; surfaced in the diff. Dropped
   on apply **only when `removeMissing` is true — which is not the default.**

   *Changed in v2 (Codex R1 high).* v1 dropped these unconditionally, on the
   strength of the preview alone. That is the same shape as the bug this document
   exists to fix: partial sheets are common (a band sheet covering only set one),
   and a preview that is clicked through is not a guard. **Default off**, an
   explicit checkbox in the preview — *"Also remove N songs not in this sheet"* —
   and when checked with removals > 0, `Apply` requires a second confirmation
   naming the count. Additive import is the safe path and is therefore the
   default path.
6. Final `position` is `index + 1` over the merged array. The sheet's own position
   column orders the *incoming* rows (§5) and is then discarded — position is
   always dense and 1-based after a merge, never sparse.

**Empty cell ≠ clear.** A blank `Lead` cell leaves the existing lead intact; it
does not blank it. Clearing a field is done in the app, not by deleting a cell.
This is deliberate and must be stated in the help text (§7) — the alternative
(blank clears) makes a half-filled sheet destructive again, which is the bug we
are fixing.

Consequence worth naming: there is no way to clear a field *via* import. Accepted
for v1.

---

## 5. Columns

Extend the header matcher (`app/api/sheet/route.ts:35-38`), lifted into
`lib/setlist-import.ts` for testability:

| Field | Header matches | Notes |
|---|---|---|
| position | exact `#`, or contains `pos` | orders incoming rows only |
| title | contains `title`, or exact `song` | **required** |
| key | **exact `key` or exact `song key` — no substring** | new; the headline feature |
| lead | contains `lead` or `singer` | |
| artist | contains `artist` | recognized, **not persisted** — see §6 |
| bpm | exact `bpm`, or contains `tempo` | recognized, **not imported** — see §10 |
| notes | contains `note` | must not swallow `scene note` |
| sceneNote | contains `scene` | new |

**`key` is exact-match only** (Codex R1: *"`contains('key')` is too greedy; use
exact key / song key only unless you have real sheet examples proving
otherwise"*). Agreed — a `Keys` column meaning the keyboard player's part is at
least as likely in a band's working sheet as a loose spelling of the musical key,
and mis-binding it would write instrument names into every song's key field. No
real sheet examples were available to argue otherwise. Exact only.

`artist` and `bpm` are recognized **solely so the matcher does not mis-bind
them** to another field, and so the preview can say what it is ignoring and why.
Neither is written.

**Header matching must become precedence-ordered, not first-substring-wins.**
The current `findIndex(h => h.includes('song'))` for title will happily bind a
`Song Key` column as the title column if it appears left of `Title`. Rule:

1. For each field, try **exact** header equality against its alias list.
2. Only then fall back to substring containment.
3. A header index already bound to a field is not eligible for another field.

`notes` vs `sceneNote` is the live collision (`scene note` contains `note`);
precedence + single-binding resolves it.

**Position parsing:** the existing parse (`app/api/sheet/route.ts:50`) has a
latent bug — `Number('four')` yields `NaN` and lands in `position`. Guard with
`Number.parseInt` + `Number.isFinite`, falling back to row index.

**Sheet tab (`gid`):** `app/api/sheet/route.ts:16` builds
`/export?format=csv` with no `gid`, so import always reads the **first tab**
regardless of which tab the user was looking at when they copied the URL. Parse
`#gid=NNN` (and `?gid=NNN`) off the pasted URL and forward it. Small fix, real
UAT confusion.

---

## 6. Artist — library-level, not show-level

`SetlistSong` has no `artist`; the canonical `Song` does (`lib/types.ts:175`,
added in `010_song_artist.sql`). `EntryInput` in
`app/api/shows/update/route.ts:9-17` carries `song_id, title, position, key,
lead, notes, scene_note` — **no artist**, and `rpc_save_show` has no artist
parameter.

So an imported artist has nowhere to go without touching the save RPC.

**v1 decision: parse `artist`, carry it in the import diff for display, and do
not persist it.** The column is recognized so the header matcher doesn't
mis-bind it, and the preview can show it, but writing artist to the library is
**out of scope** — it needs a migration to `rpc_save_show` and belongs with the
song-library manager work (`docs/backlog-song-library-manager.md`).

Stating this explicitly per the design-claims-vs-code rule: **artist persistence
does not exist and this design does not build it.**

---

## 7. Preview / diff UI

Import becomes two steps. The button changes from `Load from Google Sheet` to
`Preview import`.

**Preview panel** replaces the loader row until dismissed:

```
Importing 14 songs from your sheet

  9 songs matched — key/lead/notes updated, charts and tempo kept
  3 songs added
  Order will change

  BPM column found — tempo is set with Tap Tempo and won't be imported.

  ▸ Details
      Matched   "Ophelia"        key: — → Bb        lead: Rachel (unchanged)
      Matched   "The Weight"     no changes
      Added     "Cripple Creek"
      Not in sheet   "Old Intro"   (kept)

  [ ] Also remove the 2 songs not in this sheet

  [ Apply import ]  [ Cancel ]
```

Requirements:

- **Removal is opt-in and unchecked by default** (§4 rule 5). Unchecked, songs
  missing from the sheet are listed as *"Not in sheet — kept"*, in neutral type.
- Checking the box re-renders those rows in **red** as removals, with the
  explicit reassurance that charts remain in the library — the sentence must be
  present, because "removed" reads as destructive and here it is not. `Apply`
  then requires a second confirmation naming the count.
- The details list is a `<details>` collapsible, consistent with the existing
  "How it works" pattern (`page.tsx:6158`).
- `Cancel` restores the loader row and mutates nothing.
- Nothing is written to `config` until `Apply import`. The merge is computed
  client-side from the fetched rows, so preview costs no extra request — and
  toggling the removal checkbox re-runs `mergeSetlist` with a different
  `removeMissing`, no refetch.
- Auto-resolve charts fires after apply, as it does today
  (`page.tsx:5768` comment).
- **Undo.** After apply, an *"Undo import"* affordance appears alongside the
  save indicator and persists until the next mutation or tab change. It restores
  the pre-merge setlist held in component state — one level, in-memory, not
  persisted across reload. Codex R1: *"Add one-level undo; this is exactly the
  sort of operation users distrust."* Agreed, and cheap: the pre-merge array is
  already in hand at apply time.

**Help text** (`page.tsx:6161`) is rewritten to name the new columns and the
blank-cell rule:

> 1. Columns: **Title** (or Song) is required. Optional: **#**, **Key**, **Lead**,
>    **Notes**, **Scene Note**.
> 2. Re-importing matches songs by title and keeps their charts and tempo. A blank
>    cell leaves the existing value alone, and songs missing from the sheet are
>    kept unless you ask for them to be removed.
> 3. Share → Anyone with the link → Viewer, then paste the URL.

---

## 8. Refactor for testability

`parseCsv` and the header matcher are module-private in
`app/api/sheet/route.ts` — there are **zero tests** for this feature today
(confirmed: no `tests/*sheet*`; `tests/share-button.test.tsx` matches only the
OS share sheet).

Move to `lib/setlist-import.ts`, exported and pure:

- `parseCsv(text): string[][]` — moved verbatim, no behavior change
- `mapHeaders(headers): FieldIndex` — new, precedence rules from §5
- `parseRows(rows): ImportedRow[]`
- `mergeSetlist(existing, incoming, { newId, removeMissing }): { merged, diff }`

`app/api/sheet/route.ts` keeps fetch + URL parsing + error mapping and imports
the rest. The route's response shape gains the new fields; the client's inline
type annotation at `page.tsx:5760` is replaced by the shared `ImportedRow` type.

---

## 9. Tests

New `tests/setlist-import.test.ts` (vitest, node env — pure functions, no DOM):

**parseCsv** — quoted fields with embedded commas; escaped `""`; CRLF; trailing
newline; a single unterminated quote at EOF.

**mapHeaders** — `Song Key` left of `Title` binds title correctly; `Scene Note`
and `Notes` bind separately; `#` binds position but `Number of takes` does not;
missing title → error; casing and surrounding whitespace ignored.

**mapHeaders — the v2 additions:** a `Keys` column does **not** bind to `key`
(exact-match-only guard); a `Key` column does; `Song Key` binds to `key`, not
title.

**parseRows** — non-numeric position falls back to row index; blank title rows
dropped.

**mergeSetlist** — the core. All calls pass a deterministic `newId` counter:

1. Exact-title match preserves `id`, `songId`, `charts`, `bpm`.
2. `"The Weight"` in sheet matches `"Weight"` in setlist (article stripping) —
   the regression guard for §3.
3. Blank sheet cell does not clear an existing value.
4. Duplicate titles pair first-to-first and do not cross-assign.
5. Reordering the sheet reorders the setlist and renumbers positions densely.
6. `removeMissing: false` (the default) **keeps** a row absent from the sheet,
   and still reports it in `diff.missing`.
7. `removeMissing: true` drops it and reports it in `diff.removed`.
8. A title that normalizes to empty (`"???"`) never matches anything.
9. Round-trip: `merge(existing, exportOf(existing))` is an exact deep-equal
   no-op — enforceable now that ids are injected.
10. A sheet BPM column never appears in the merged output (§10 regression).

Target: **~20 new tests**, up from 0 for this feature. Test-count delta will be
reported on the build PR.

---

## 10. What this does not change

- No schema migration. No RPC change. No new table.
- `key` persistence rides the existing override mechanism: the client sends the
  effective key in `entries`, and `diffOverride`
  (`lib/overrides.ts:60-68`) computes `key_override` against the library default.
  **Mechanism EXISTS** — verified at `app/api/shows/update/route.ts:3`.
- **`bpm` is NOT imported. Changed in v2 — this was Codex R1's blocker, and it
  was correct.**

  v1 said a sheet BPM would be "applied to rows that have no existing tempo."
  That was unimplementable as written. BPM has **no path to persistence** from
  the setlist save at all:

  | Layer | State |
  |---|---|
  | `lib/use-show.ts:63-66` | the `setlist` type used to build the payload does not include `bpm` — it is dropped before `entries` is constructed |
  | `app/api/shows/update/route.ts:8-17` | `EntryInput` has no `bpm` field |
  | `app/api/shows/update/route.ts:110-121` | song auto-create inserts `key`, `lead`, `notes` — no `bpm` |
  | `supabase/migrations/006_songs.sql:68` | `rpc_save_show` stores no BPM |

  So an imported BPM would appear in the preview, appear in client state, and
  **vanish on the next save/reload** — a phantom write, which is worse than not
  offering the column. Making it real means threading `bpm` through the payload
  type, `EntryInput`, auto-create, and the RPC: a schema-and-RPC change that
  belongs with the song-library work, not with an importer fix.

  Existing `bpm` on **matched** rows is preserved by the merge (§4 rule 3) — that
  is the whole point of merging, and it is what re-import destroys today. The
  canonical BPM writer stays the tap-tempo path (`page.tsx:587-607`).

  The preview names the omission rather than hiding it: *"BPM column found —
  tempo is set with Tap Tempo and won't be imported."*
- Google OAuth is not involved. Import remains public-CSV, so the sheet must stay
  link-viewable. `docs/strategy-pwa-commercial.md:49` contemplates an OAuth
  `sheets.readonly` importer as a Pro-tier feature; that supersedes this path
  later and is not built here.

---

## 11. Codex R1 — disposition

| Finding | Disposition |
|---|---|
| **Blocker** — BPM does not persist | **Accepted in full.** BPM removed from v1 import (§10). Verified all four layers independently; the finding was exactly right and v1's "weakest joint" framing understated it — it was a phantom write. |
| **High** — removal default-on | **Accepted.** Now opt-in + second confirmation (§4 rule 5, §7). |
| **Medium** — `mergeSetlist` mints UUIDs | **Accepted.** `newId` injected (§4). |
| Artist deferral correct | Unchanged (§6). |
| `contains('key')` too greedy | **Accepted.** Exact-match only (§5). |
| Add one-level undo | **Accepted** (§7). |

Nothing was declined.

## 12. Open questions for Codex R2

1. §10 — with BPM out, is the recognized-but-not-imported treatment right, or
   should an unrecognized `BPM` column simply be ignored silently? I chose to
   name it in the preview because a band that put tempo in their sheet will
   otherwise assume it imported.
2. §4 rule 5 — with removal now opt-in, a band whose sheet *is* the full setlist
   has to tick a box every time to prune. Is that friction in the right place?
   I think yes (the destructive direction should cost a click), but it inverts
   the common case for a band that keeps one authoritative sheet.
3. §7 — undo is in-memory and one level, lost on reload. Is that enough for the
   operation testers fear most, or should apply write a restore point?
4. Unchanged from R1 and still open: the merge is computed **client-side** from
   the route's rows. That keeps preview free, but it means the merge logic is
   only ever exercised in the browser. Should `/api/sheet` return the diff
   instead, so the same code path is server-testable end-to-end?
