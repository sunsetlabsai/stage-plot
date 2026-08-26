# Conductor-area UX polish (post-4a)

Small batch of clarity fixes surfaced while validating the 5b clock in prod. Three items,
all in the Perform-mode conductor surface. Two are presentational; one (BPM-in-show) is a
data write with a real semantic decision, called out in §3.

Not a new capability — the static-BPM clock (c2) and the 4a shadow detector already shipped.
This pass removes the friction that made them hard to find/read.

---

## 1. Toggle state clarity — `Clock` and `Auto-fire`

### Problem (observed)
The header toggles read `Clock off` / `Clock on` (and `Auto-fire off/on`). The bare word is
ambiguous between **state** ("the clock is off") and **action** ("click to turn it off").
A first-time MD read `off` as the action and assumed the clock was currently on — so when the
bar didn't move, the control seemed broken rather than simply off. Color (`bg-sky-700` when on)
and `aria-pressed` carry the true state, but the word fights them.

### Decision
Make the label an unambiguous **state readout**, with the on-state visually dominant (it already
is, via the filled background). Two candidate forms:

- **(A) Colon readout** — `Clock: on` / `Clock: off`. Minimal diff, keeps the single-button
  toggle. The colon reframes the word as "current state," not "action."
- **(B) Label + pill** — a static `Clock` label with a small `on`/`off` pill that carries the
  filled/empty state; the whole control stays the toggle.

**Recommend (A)** — smallest change, reads correctly, no layout shift. Apply identically to
`Auto-fire`. Keep `aria-pressed` (already correct) so the accessible state is unchanged.

### Change
`components/ConductorCluster.tsx` — the two toggle buttons (the `Clock {clockOn ? 'on':'off'}`
and `Auto-fire {autoFire ? 'on':'off'}` spans). Text only; no behavior change.

---

## 2. Shadow hint on the Detection row

### Problem (observed)
With the mic enabled, the Detection row streams `stated X · detected Y (Z%) · shadow` and the
detector is visibly "doing something," but nothing on the chart moves. That's correct — 4a is
measurement-only — but the row doesn't *say* so, so it reads as broken.

### Decision
Add a one-line, low-emphasis clarifier that the mic is **observing only** and does not drive the
chart yet. The row already ends in `· shadow`; promote that from a bare word to an explained
state. Options:

- Inline subtext under the readout: *"measuring only — doesn't drive the chart yet."*
- A `title=`/tooltip on `shadow` (less discoverable; the inline subtext is better for a first-run
  MD).

**Recommend the inline subtext** (one muted line), shown only while `micStatus === 'running'`.
Purely presentational.

### Change
`components/ConductorCluster.tsx` — the Detection block (the `micStatus === 'running'` branch).
Copy only.

---

## 3. BPM in-show (close the authoring gap)

### Problem (observed + verified)
BPM is the static-BPM clock's source. It is editable **only** in the Library song form
(`app/library/page.tsx` → `TapTempo`). The in-show flows — add-to-show, the setlist editor
(`SetupSetlistTable`), create-chart — have **no** BPM control. So an MD setting up a show in-app
cannot give the conductor a tempo without leaving for the Library screen, and a song with no BPM
silently lands on the `manual` rung (no auto-advance). This was the single biggest source of the
"nothing moves" confusion.

### The data-model fact that drives the design
BPM is **song-level**: `songs.bpm` (migration 012) is the source of truth. `SetlistSong.bpm` is a
**read-through copy** hydrated from the songs table on show load ("from the songs table"). This is
unlike the other inline setlist fields (`key`, `lead`), which write the **per-show config blob**
and are deliberately per-show.

**Consequence:** an in-show BPM edit must write the **canonical song** (`/api/songs/update` by
`songId`) — the same write the Library form does — and therefore changes the song's tempo in
**every** show that uses it. It is NOT a per-show override. (Whether per-show tempo override is
ever wanted is out of scope; today the clock has one song-level tempo, by design.)

### Decision
Surface a BPM control in the **in-show setlist editor** (`SetupSetlistTable` row), reusing the
existing `TapTempo` component, wired to a song-table write:

- On change → **`PUT /api/songs/update { id: songId, bpm }`** (the existing endpoint + method —
  it implements PUT only, and Library writes via `method: 'PUT'`; **not** PATCH) → on success,
  patch the local `SetlistSong.bpm` so Perform reads it immediately (no reload).
- **Owner-only control (Codex R1 HIGH-1).** `/api/songs/update` is owner-scoped — it verifies
  `songs.owner_id === user.id` and returns 404 otherwise. So the BPM control is **gated on
  `isOwner`** (no silent "control shown, write 404s").

  **⛔ AMENDED 2026-08-25 by the roles ruling — `design-single-backend.md` §3.3c (v1.9).** This
  bullet previously described a deliberate owner-vs-**editor** asymmetry: *"editors keep per-show
  `key`/`lead`, but song-level tempo stays owner-only."* **That asymmetry no longer exists.**
  Collaborators are **VIEW ONLY** and the `editor` role is deleted, so there is no principal who
  can edit a show but not the song row. **The `isOwner` gate is unchanged and still correct** — what
  is deleted is the reasoning that framed it as a *trade-off between two writing populations*. It is
  now simply: only the owner writes. Nothing to widen, no RBAC fence to hold.
- **Library-linked songs only** (`songId` present). Inline/legacy setlist songs (no `songId`) have
  no canonical row to write — **omit the control** for them (resolved Q3). They keep falling to the
  `manual` rung (the honest floor).
- **Global-write hint (resolved Q2 = yes).** Because the write is global, show a quiet hint near the
  control — *"sets this song's tempo everywhere"* — so the owner isn't surprised.

### Add-time BPM threading (Codex R1 MEDIUM)
`/api/songs` GET returns `bpm`, but `AddSongFromLibrary.handleSelect` currently **drops** it from
the selected-song payload, and the new setlist row lands BPM-less — so adding an existing
library song that already has a BPM shows no row tempo until reload or a manual edit. The build
**must** thread `bpm` through: include `bpm: song.bpm` in the `onAddSong({...})` payload and carry
it onto the new `SetlistSong` row. (Page anchors: the select handler ~`page.tsx:3862`; the add
payload mapping; the row builder in `onAddSong`.)

### Why the setlist editor (not add-to-show, not create-chart)
The setlist row is where per-song show metadata is already edited (`key`/`lead`), so it's the
natural home and covers both "song already in the show" and (after add) "song just added." With the
add-time threading above, an added song's existing BPM shows immediately; the row control then
covers create/override.

### Change
- `app/[owner]/[show]/page.tsx`:
  - `SetupSetlistTable` row — add the `TapTempo` control **only** for rows with a `songId` **and**
    when `isOwner`; an `onBpmChange(idx, songId, bpm)` handler that PUTs `/api/songs/update` and
    patches local setlist state; the global-write hint adjacent.
  - `AddSongFromLibrary.handleSelect` + `onAddSong` row builder — thread `bpm` through (MEDIUM).
- No schema change (column exists). No new endpoint, no auth change (`PUT /api/songs/update` already
  takes `bpm`, owner-scoped — which is exactly why the control is owner-only).

---

## Resolved decisions (Graham + Codex R1)

- **Q1 — toggle form → (A) colon readout.** `Clock: on/off` and `Auto-fire: on/off`. Minimal diff,
  no layout shift, reads as state not action.
- **Q2 — global-write hint → yes.** Show *"sets this song's tempo everywhere"* near the in-show BPM
  control (the write is genuinely global).
- **Q3 — inline songs (no `songId`) → omit.** No control at all for legacy/inline rows; they keep
  falling to the `manual` rung.
- **Q4 — scope fence → confirmed.** This pass is the 3 items only; per-show tempo *override* stays
  out of scope.
- **Owner-only authorization (Codex R1 HIGH-1).** The BPM control is gated on `isOwner`.
  `/api/songs/update` is owner-scoped. *(Amended 2026-08-25: previously read "editors don't see it
  … widening it to editors is out of scope". There are no editors — collaborators are view-only per
  `design-single-backend.md` §3.3c. The gate stands; the editor framing is deleted.)*
- **Method = PUT (Codex R1 HIGH-2).** The endpoint implements `PUT` only (Library writes via PUT);
  the spec calls `PUT /api/songs/update`, not PATCH.
- **Add-time bpm threading (Codex R1 MEDIUM).** `AddSongFromLibrary` must thread `bpm` through so an
  added library song shows its tempo without reload (§3 Add-time BPM threading).

**Status:** §1 + §2 (A+B presentational) are **GO** from Codex R1. §3 (C, BPM-in-show) is GO once the
above three Codex R1 findings are folded — which they now are. **Codex R2 = GO, no blocking findings.**

- **Codex R2 note (non-blocking, chunk 2):** when patching local `SetlistSong.bpm` after the PUT
  resolves, guard the patch by **`songId`, not a naked row index** — a row reorder/delete during the
  async request must not patch the wrong visible row. Update by matching `row.songId === songId`.

## Build chunks (after Codex R2 GO)
1. **A+B presentational** (toggle readouts + shadow hint) — copy-only, ConductorCluster, +tests for
   the rendered labels. (Codex R1 already GO on §1+§2.)
2. **C BPM-in-show** —
   - `SetupSetlistTable` row: `TapTempo` shown **only** when `isOwner && row.songId` (Codex R1 HIGH-1);
     `onBpmChange(idx, songId, bpm)` → `PUT /api/songs/update { id: songId, bpm }` (Codex R1 HIGH-2) →
     patch local `SetlistSong.bpm` **guarded by `songId`, not index** (Codex R2) — global-write hint
     adjacent (Q2).
   - `AddSongFromLibrary.handleSelect` + `onAddSong` row builder: thread `bpm` through (Codex R1 MEDIUM).
   - No schema change, no new endpoint, no auth change.

## Test plan
- ConductorCluster renders `Clock: on`/`Clock: off` and `Auto-fire: on/off` per state.
- Detection row shows the measuring-only subtext only while `micStatus === 'running'`.
- SetupSetlistTable: for an owner + `songId` row, BPM change calls `PUT /api/songs/update` with
  `{ id, bpm }` and patches local state; **non-owner** sees no control; **inline** (no `songId`) row
  sees no control (Q3 omit).
- AddSongFromLibrary: selecting a library song with a BPM carries `bpm` onto the new setlist row.
