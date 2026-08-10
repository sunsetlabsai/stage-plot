# Design — Setlist Import: merge semantics + Key/BPM/Artist columns

Status: **DESIGN — pre-Codex, not built**
Version: v1.0
Scope: Google Sheet setlist import (`/api/sheet` + the Config-tab loader)

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
): { merged: SetlistSong[]; diff: ImportDiff }
```

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
5. **Unconsumed existing row** → removal candidate; surfaced in the diff, dropped
   on apply.
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
| key | exact `key`, or contains `song key` | new |
| lead | contains `lead` or `singer` | |
| bpm | exact `bpm`, or contains `tempo` | new; parsed as int, invalid → undefined |
| artist | contains `artist` | new; library-level, see §6 |
| notes | contains `note` | must not swallow `scene note` |
| sceneNote | contains `scene` | new |

**Header matching must become precedence-ordered, not first-substring-wins.**
The current `findIndex(h => h.includes('song'))` for title will happily bind a
`Song Key` column as the title column if it appears left of `Title`. Rule:

1. For each field, try **exact** header equality against its alias list.
2. Only then fall back to substring containment.
3. A header index already bound to a field is not eligible for another field.

`notes` vs `sceneNote` is the live collision (`scene note` contains `note`);
precedence + single-binding resolves it.

**BPM parsing:** `Number.parseInt(cell, 10)`, reject `NaN` and anything outside
`20..400`, else `undefined`. The existing position parse
(`app/api/sheet/route.ts:50`) has the same latent bug — `Number('four')` yields
`NaN` and lands in `position` — and is fixed by the same guard.

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
  2 songs will be removed from this show
  Order will change

  ▸ Details
      Matched   "Ophelia"        key: — → Bb        lead: Rachel (unchanged)
      Matched   "The Weight"     no changes
      Added     "Cripple Creek"
      Removed   "Old Intro"      (2 charts stay in your library)

  [ Apply import ]  [ Cancel ]
```

Requirements:

- Removal count is rendered in **red** with the explicit reassurance that charts
  remain in the library — the sentence must be present, because "removed" reads
  as destructive and here it is not.
- The details list is a `<details>` collapsible, consistent with the existing
  "How it works" pattern (`page.tsx:6158`).
- `Cancel` restores the loader row and mutates nothing.
- Nothing is written to `config` until `Apply import`. The merge is computed
  client-side from the fetched rows, so preview costs no extra request.
- Auto-resolve charts fires after apply, as it does today
  (`page.tsx:5768` comment).

**Help text** (`page.tsx:6161`) is rewritten to name the new columns and the
blank-cell rule:

> 1. Columns: **Title** (or Song) is required. Optional: **#**, **Key**, **Lead**,
>    **BPM**, **Notes**, **Scene Note**.
> 2. Re-importing matches songs by title and keeps their charts and tempo. A blank
>    cell leaves the existing value alone.
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
- `mergeSetlist(existing, incoming): { merged, diff }`

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

**parseRows** — non-numeric position falls back to row index; BPM `"120"` → 120,
`"fast"` → undefined, `"5"` → undefined (out of range); blank title rows dropped.

**mergeSetlist** — the core:

1. Exact-title match preserves `id`, `songId`, `charts`, `bpm`.
2. `"The Weight"` in sheet matches `"Weight"` in setlist (article stripping) —
   the regression guard for §3.
3. Blank sheet cell does not clear an existing value.
4. Duplicate titles pair first-to-first and do not cross-assign.
5. Reordering the sheet reorders the setlist and renumbers positions densely.
6. A row absent from the sheet appears in `diff.removed` and is dropped.
7. A title that normalizes to empty (`"???"`) never matches anything.
8. Round-trip: merge(existing, exportOf(existing)) is a no-op — zero changes in
   the diff.

Target: **~20 new tests**, up from 0 for this feature. Test-count delta will be
reported on the build PR.

---

## 10. What this does not change

- No schema migration. No RPC change. No new table.
- `key` persistence rides the existing override mechanism: the client sends the
  effective key in `entries`, and `diffOverride`
  (`lib/overrides.ts:60-68`) computes `key_override` against the library default.
  **Mechanism EXISTS** — verified at `app/api/shows/update/route.ts:3`.
- `bpm` is carried but not written by import; it is preserved from the existing
  row only. The canonical BPM writer stays the tap-tempo path
  (`page.tsx:587-607`). Importing BPM *into* the library is deferred with artist
  (§6) — **so a BPM column is parsed and shown in the preview but only applied to
  rows that have no existing tempo.** Flagged for Codex: this asymmetry with key
  is deliberate but is the weakest point in the design.
- Google OAuth is not involved. Import remains public-CSV, so the sheet must stay
  link-viewable. `docs/strategy-pwa-commercial.md:49` contemplates an OAuth
  `sheets.readonly` importer as a Pro-tier feature; that supersedes this path
  later and is not built here.

---

## 11. Open questions for Codex

1. §10 — is "BPM applies only when the row has no existing tempo" defensible, or
   should BPM behave exactly like key (sheet wins when the cell is non-empty)?
   Asymmetry is a smell; the argument for it is that tap-tempo is a measured
   value and a typed sheet value is a guess.
2. §4 rule 5 — should removal be opt-out? A checkbox "also remove songs missing
   from the sheet", default **on**, would let a band keep a partial sheet. Adds a
   mode; may not earn it.
3. §5 — is `contains('key')` too greedy? A `Keys` column meaning the keyboard
   player's part would mis-bind. Exact-match-first mitigates but does not
   eliminate it.
4. Should apply be undoable (one-level "Undo import" restoring the pre-merge
   setlist in memory)? Cheap to add, and this is the operation testers will fear.
