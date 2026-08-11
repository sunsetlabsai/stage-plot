# Design — Setlist Import: merge semantics + Key / Scene Note columns

*(BPM and Artist are recognized but **deliberately not imported** — §6, §10.)*

Status: **DESIGN — Codex R4 folded, awaiting R5**
Version: **v5.0** (v1 = pre-Codex, v2 = R1, v3 = R2, v4 = R3)
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

**v3 changelog:**

| Change | Source |
|---|---|
| §4 rule 5a NEW — **kept-missing row ordering** is now a stated invariant. It was undefined. | Codex R2 **high** |
| Title and §1b no longer promise tempo import | Codex R2 low |

**v4 changelog:**

| Change | Source |
|---|---|
| §4 rule 5a — the `[C',NEW]` **example contradicted its own invariant** (dropped a kept row). Corrected, derived step by step, plus the slot-count identity that makes it checkable. | Codex R3 **blocking** |
| §4 rule 5a — the interleave consequence (incoming rows fill slots, not sheet intent) now stated explicitly | follows from the fix |
| §9 — ordering tests assert the **full merged array + dense positions**, not spot-checks. 7e/7f/7g added. | Codex R3 |
| Q2 (removal friction) and Q3 (client-side merge) **closed** by Codex's R3 answers | Codex R3 answers |

**v5 changelog:**

| Change | Source |
|---|---|
| §4 — **"sheet order" is now defined**: `parseRows` owns a stable sort by resolved position, `mergeSetlist` never re-sorts. The `#` column was promised to order incoming rows with no mechanism named, so ignoring it entirely passed the spec and the suite. | Codex R4 **medium** |
| §9 — tests 3a–3e pin position ordering, identity when no `#` column, stability on duplicate/partial values | Codex R4 |

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
`key` and `sceneNote` (`lib/types.ts:156-168`). A band whose sheet is their
working setlist cannot get **key** in without hand-typing every row — and key is
the whole ask.

`bpm` (`lib/types.ts:165`) and the library `Song.artist` (`lib/types.ts:175`)
also exist in the model, but **neither can be persisted from this path** and
neither is imported. See §6 (artist) and §10 (bpm) — both are recognized only so
the header matcher cannot mis-bind them. Nothing in this document imports tempo.

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

**"Sheet order" is defined, and `parseRows` owns it** *(new in v4 — Codex R4
medium)*. The doc says in three places that the `#` column "orders incoming rows"
(§4 rule 6, §5) and never said **who does the sorting**. "Walk incoming in sheet
order" reads equally well as physical row order, so an implementation that
ignores numeric `#` values entirely satisfies every word of v3 — and every v3
test, since they all reorder rows physically.

> **Sheet order ≡ the order `parseRows` returns.** `parseRows` resolves each row
> to an effective position — the parsed `#` value when it is a finite number,
> otherwise the row's physical index (§5's existing fallback) — and returns rows
> **stably sorted** by it. `mergeSetlist` consumes that array as given and never
> re-sorts.

Three consequences worth pinning, all tested (§9):

- A sheet with `#` values that disagree with physical order is sorted by `#`.
  That is the whole point of recognizing the column.
- A sheet with **no** `#` column degenerates to identity: every row resolves to
  its own index, so a stable sort is a no-op. The common case is unchanged.
- **Duplicate or partial `#` values fall back gracefully** rather than throwing.
  Two rows claiming `1` keep their physical order relative to each other
  (stability); a sheet where only some rows have a number interleaves numbered
  rows against unnumbered rows' indices. Neither is a great sheet, and neither
  should lose a song. `NaN` is already guarded at §5.

Locating the sort in `parseRows` also keeps `mergeSetlist` a pure function of the
order it is handed, which is what makes rule 5a testable in isolation.

**Rules, in order:**

1. Build `byKey: Map<string, SetlistSong[]>` over `existing`, keyed by
   `normalizeSongKeySafe(title)`. Rows whose title normalizes to `null` (blank,
   punctuation-only) go in an unmatchable bucket and are treated as
   removal candidates.
2. Walk `incoming` **in sheet order as defined above** — i.e. the order
   `parseRows` returned, already position-sorted. For each row, take the *first
   unconsumed* existing row with the same normalized key and mark it consumed.
   Consumption is what makes duplicate titles behave: two `"Intro"` rows in the
   sheet pair with the two `"Intro"` rows in the setlist, first-to-first.
3. **Matched row** → carry forward `id`, `songId`, `charts`, and every field the
   sheet did not supply. Overwrite only fields present as a **non-empty cell** in
   the sheet. Sheet order sets `position`.
4. **Unmatched incoming row** → new row, fresh id from the injected `newId`, no
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
5a. **Ordering when rows are kept (`removeMissing: false`).** *New in v3 —
   Codex R2 high. v2 said missing rows are kept and that positions are dense over
   the merged array, but never said **where** the kept rows go. Undefined
   behavior in the default path.*

   The naive reading — incoming rows in sheet order, kept rows appended — is
   badly wrong for the common case. A tester who imports a one-row sheet to fix
   one song's key would see that song jump to position 1 and the entire rest of
   the show shuffle down. That is a silent reorder of a live setlist, which is
   the same class of surprise as the data loss this document exists to remove.

   **Invariant: kept-missing rows hold their existing index. Incoming rows fill
   the remaining slots, in sheet order.**

   ```
   existing: [A, B, C, D, E]
   sheet:    [C']              → [A, B, C', D, E]        C' keeps slot 2
   sheet:    [C', A']          → [C', B, A', D, E]       subset reorders in place
   sheet:    [C', NEW]         → [A, B, C', D, E, NEW]   kept A,B,D,E hold 0,1,3,4
   sheet:    [NEW, C']         → [A, B, NEW, D, E, C']   free slots 2,5, sheet order
   sheet:    [E',D',C',B',A']  → [E', D', C', B', A']    full sheet ⇒ sheet order
   ```

   *Corrected in v4 — Codex R3 blocking. v3's third line read
   `[A, B, C', NEW, E]`, which is length 5 against 6 rows: it silently dropped
   `D` and moved `E`. The invariant one paragraph above it was right; the example
   under it was not, and an implementer building to the example would have
   shipped exactly the shuffle-and-drop this rule exists to prevent. That is the
   second time in this document a worked example has been the thing that was
   wrong while the prose was right — see §11b.*

   The derivation for that row, in full, because it is the case that was wrong:

   ```
   existing [A,B,C,D,E], sheet [C',NEW], removeMissing: false
     C' matches C (consumed)     → incoming, needs a slot
     NEW matches nothing         → incoming, needs a slot
     A,B,D,E unconsumed          → kept, hold indices 0,1,3,4
     merged length = 5 existing + 1 added = 6
     free slots  = {2, 5}
     incoming in sheet order     → C'→2, NEW→5
     result [A, B, C', D, E, NEW], positions 1..6
   ```

   Three properties worth stating because they make this safe to implement:

   - **The slots always fit exactly.** Free slots number
     `merged.length − kept = (existing + added) − (existing − matched)
     = added + matched = incoming.length`. There is never a spare slot and never
     an incoming row without one, so the fill needs no fallback branch. Any
     implementation that can leave a hole has a bug, and a hole is assertable in
     test.
   - **Slots are always in range.** With `removeMissing: false` the merged length
     is `existing.length + added.length ≥ existing.length`, so every retained
     existing index is a valid slot. No clamping, no edge case.
   - **A full sheet degenerates to pure sheet order.** When nothing is missing
     there are no held slots, so the rule collapses to v2's behavior and the
     "sheet is authoritative" case is unchanged.

   **The consequence to state out loud** (`[NEW, C']` above): kept rows and
   incoming rows each preserve their own relative order, but the two sequences
   are *interleaved by slot availability*, not merged by sheet intent. So an
   incoming row listed **before** another in the sheet can land **after** it,
   when the earlier free slot falls earlier in the setlist. This is the price of
   "nothing you didn't mention moves," and it is the right trade for the partial
   sheet this rule is for — but it means a band using the sheet to *reorder*
   should send the whole setlist, not a fragment. §7's preview renders the final
   order, so the effect is visible before Apply rather than discovered after.

   With `removeMissing: true` there are no kept rows and sheet order is the
   order, exactly as v2 specified.

   The preview (§7) renders the **final** order, not the sheet order, so what is
   shown is what is applied.
6. Final `position` is `index + 1` over the merged array, after rule 5a has
   placed everything. The sheet's own position column orders the *incoming* rows
   (§5) and is then discarded — position is always dense and 1-based after a
   merge, never sparse.

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
| position | exact `#`, or contains `pos` | orders incoming rows only — **sorted by `parseRows`**, §4 |
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

**parseRows ordering — new in v4 (Codex R4 medium).** The `#` column is promised
to order incoming rows; nothing tested that it does:

3a. **Physical rows `[B(#=2), A(#=1)]` parse to `[A, B]`.** The direct assertion
    that numeric positions are honored — an implementation that ignores the
    column passes every other test in this file.
3b. End to end through the merge: existing `[X, Y]`, sheet physically
    `[Y'(#=2), X'(#=1)]` → exactly `[X', Y']`, not `[Y', X']`. Pins that the
    order `parseRows` establishes is the order `mergeSetlist` consumes, which is
    the seam where an implementation can quietly re-sort or not sort at all.
3c. **No `#` column ⇒ identity.** Physical order is preserved exactly; the sort
    is a no-op. Guards against a fix that sorts by an undefined field and
    scrambles the common case.
3d. Duplicate `#` values (two rows both `1`) keep physical order between them —
    stability asserted, not incidental.
3e. Partial `#` values (some rows numbered, some not) drop no rows. Assert the
    full output set, since the risk here is a song vanishing, not a song
    misplaced.

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
**Ordering tests pin the FULL output array, exactly** — Codex R3, and it is the
condition attached to keeping the merge client-side (§12). Not "the new row is
not at position 1", not a length check, not a spot-check of one index: each of
7a–7e deep-equals the complete merged title sequence **and** asserts
`positions === [1..n]`. The v3 blocker was a worked example that disagreed with
its own rule; a test that asserts less than the whole array is a test that would
not have caught it.

7a. **Partial-sheet ordering (§4 rule 5a):** existing `[A,B,C,D,E]`, sheet `[C']`
    → exactly `[A,B,C',D,E]` — C' holds index 2 and **nothing else moves**.
7b. Subset reorder: sheet `[C',A']` → exactly `[C',B,A',D,E]`.
7c. Partial sheet with an addition: sheet `[C',NEW]` → exactly
    `[A,B,C',D,E,NEW]`. Length 6: no kept row is dropped, `D` and `E` hold slots
    3 and 4, `NEW` takes the appended slot 5. **This is the v3 blocker, frozen
    as a regression guard** — assert the full array, not just NEW's index.
7d. Full sheet degenerates to pure sheet order (no held slots): sheet
    `[E',D',C',B',A']` → exactly `[E',D',C',B',A']`.
7e. **Interleave order** — sheet `[NEW,C']` → exactly `[A,B,NEW,D,E,C']`. The
    incoming rows fill free slots `{2,5}` in sheet order, so `C'` lands *after*
    `NEW` despite being listed second. Pins the consequence named in §4 rule 5a
    so it can only change deliberately.
7f. **No holes, exact fit.** Property test over random
    existing/sheet/overlap combinations with `removeMissing: false`: the merged
    array contains no empty slot, its length is `existing + added`, every kept
    row sits at its original index, and incoming rows appear in sheet order
    among themselves. This is the §4 slot-arithmetic identity asserted directly.
7g. **Duplicate titles × held slots** — §12 Q1's intersection, which Codex asked
    about in R3 and did not find a break in. Existing `[Intro,A,Intro,B]`, sheet
    `[Intro']`: first-unconsumed pairing binds `Intro'` to index 0, the second
    `Intro` is kept at index 2 → exactly `[Intro',A,Intro,B]`.
8. A title that normalizes to empty (`"???"`) never matches anything.
9. Round-trip: `merge(existing, exportOf(existing))` is an exact deep-equal
   no-op — enforceable now that ids are injected.
10. A sheet BPM column never appears in the merged output (§10 regression).

Target: **~29 new tests**, up from 0 for this feature (v3 said ~20; 7e–7g and
3a–3e are the v4 additions). Test-count delta will be reported on the build PR.

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

## 11a. Codex R2 — disposition

| Finding | Disposition |
|---|---|
| **High** — kept-missing row ordering underspecified | **Accepted.** New §4 rule 5a states the invariant: kept rows hold their index, incoming rows fill remaining slots in sheet order. Your partial-sheet scenario is exactly the failure I'd have shipped. Tests 7a–7d. |
| **Low** — stale wording promises tempo import | **Accepted.** Title is now "Key / Scene Note columns", §1b says nothing in the doc imports tempo. |
| Naming the ignored BPM column in preview is right | Confirmed, unchanged. |
| One-level in-memory undo is enough for v1 | Confirmed — and the ordering fix was your stated condition for that, now done. |

Of the two invariants you offered I took the second ("missing rows retain their
existing relative positions"), tightened to an exact rule rather than
"as much as possible" — see 5a for why slots are always in range, which is what
makes the exact form implementable.

## 11b. Codex R3 — disposition

| Finding | Disposition |
|---|---|
| **Blocking** — the addition example contradicts the slot invariant | **Accepted in full, and it was a real one.** `[C',NEW]` under the stated rule is `[A,B,C',D,E,NEW]`; the doc printed `[A,B,C',NEW,E]`, dropping `D` and moving `E`. §4 rule 5a now carries the corrected table, a step-by-step derivation of that exact case, and the slot-count identity (`free slots ≡ incoming.length`) that makes the wrong answer arithmetically impossible to write. Test 7c freezes the full array as a regression guard. |
| Pin the exact full output in 7c | **Accepted, and widened.** All ordering tests (7a–7e) now deep-equal the complete title sequence *and* assert dense 1..n positions, with 7f as a property test for "no holes, exact fit" and 7g for the duplicates × held-slots intersection you probed in R2. |
| Removal opt-in is still the right friction | Confirmed — §4 rule 5 and §7 unchanged. **Q2 closed.** |
| Keep merge client-side for now | Confirmed — §8 refactor stands (pure functions in `lib/setlist-import.ts`, node-env tests, no route change). **Q3 closed**, on the stated condition that the pure-function tests pin full slot outputs, which is now §9's explicit rule. |

Nothing was declined. **Three rounds, three docs, and Codex has found something
real in every one** — this round's was the sharpest kind: prose and example
disagreeing, where the prose is right and the example is what an implementer
copies. Both prior instances in this document were the same shape (v1's BPM
table, v2's ordering gap). The standing lesson in
[[project_showrunr_uat_readiness]] gets a corollary: **after writing an
invariant, re-derive every worked example from it rather than reading them back
for plausibility.** I had read that block twice and seen what I meant.

## 11c. Codex R4 — disposition

| Finding | Disposition |
|---|---|
| **Medium** — position-column ordering promised but not tested | **Accepted, and the gap was upstream of the tests.** The doc asserted three times that `#` "orders incoming rows" and never named who sorts; "walk incoming in sheet order" reads equally well as physical order, so an implementation that ignores numeric `#` entirely satisfied every word *and* every test — all the v3 ordering tests reorder rows physically. §4 now **defines sheet order as the order `parseRows` returns** and gives `parseRows` the stable position-sort; `mergeSetlist` consumes it and never re-sorts. Tests 3a–3e, including your `[B(#=2), A(#=1)] → [A,B]` case (3a) and the same case through the merge (3b). |

Nothing declined. Worth noting the pattern: **all four rounds on this document
found a claim that was true in prose and unenforced in mechanism** — BPM
persistence (R1), kept-row ordering (R2), the worked example (R3), and now the
sort owner (R4). The tests kept passing because they tested what I meant.

## 12. Open questions for Codex R5

1. **§4 rule 5a's interleave consequence** is now stated rather than implied: an
   incoming row listed earlier in the sheet can land later than one listed after
   it, when free slots fall that way (test 7e). I believe that is inherent to
   "kept rows don't move" and not fixable without breaking the invariant that
   makes this safe — but if there is a rule that preserves both intents for the
   partial-sheet case, this is where it would go.
2. **R4 Q2 answered itself.** I asked whether any ordering case in §9 *passes
   under a wrong implementation*; your position-column finding is exactly that,
   in the one dimension I hadn't thought to check. So the standing question,
   sharpened: with `parseRows` now owning the sort and 3a–3e pinning it, is
   there **another** promised behavior in this doc whose only enforcement is
   that I meant it? §5's "empty cell ≠ clear" and §6's artist non-persistence
   are the two I'd audit next; both are stated as rules and neither has a
   dedicated negative test.
3. §4's stable-sort fallbacks (duplicate `#`, partial `#`) are my call, not a
   requirement anyone stated. Never losing a row is the priority I optimized
   for; rejecting a malformed sheet outright is the alternative. Right trade for
   a band's hand-maintained Google Sheet?
4. R3's Q2 (removal friction) and Q3 (client-side merge) remain **closed**.
