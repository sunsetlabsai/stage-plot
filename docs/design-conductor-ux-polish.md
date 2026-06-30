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

- On change → `PATCH /api/songs/update { id: songId, bpm }` (same endpoint/shape as Library) →
  on success, update the local `SetlistSong.bpm` so Perform reads it immediately (no reload).
- **Library-linked songs only** (`songId` present). Inline/legacy setlist songs (no `songId`)
  have no canonical row to write — keep them BPM-less (they already fall to the `manual` rung,
  the honest floor). Show the control disabled with a hint, or omit it, for inline songs
  (decision Q3).
- Because the write is global, show a quiet hint near the control — *"sets this song's tempo
  everywhere"* — so the MD isn't surprised (decision Q2).

### Why the setlist editor (not add-to-show, not create-chart)
The setlist row is where per-song show metadata is already edited (`key`/`lead`), so it's the
natural home and covers both "song already in the show" and (after add) "song just added." Add-time
BPM entry is a nice-to-have but redundant once the row has it; create-chart is a separate flow and
out of scope for this pass.

### Change
- `app/[owner]/[show]/page.tsx` — `SetupSetlistTable` row: add the `TapTempo` control for rows with
  a `songId`; an `onBpmChange(idx, songId, bpm)` handler that calls the songs-update endpoint and
  patches local setlist state.
- No schema change (column exists). No new endpoint (`/api/songs/update` already takes `bpm`).

---

## Open questions for Graham

- **Q1 — toggle form:** (A) `Clock: on/off` colon readout [recommended] vs (B) label + pill.
- **Q2 — global-write hint:** show *"sets this song's tempo everywhere"* near the in-show BPM
  control? [recommend yes — the write is genuinely global]
- **Q3 — inline songs (no `songId`):** disabled control with a hint, or omit the control entirely?
  [recommend omit — quieter; inline songs are the legacy minority]
- **Q4 — scope fence:** confirm this pass is the 3 items only, and that per-show tempo *override*
  (a setlist-level bpm distinct from the song) stays out of scope.

## Build chunks (after approval + Codex)
1. **A+B presentational** (toggle readouts + shadow hint) — copy-only, ConductorCluster, +tests for
   the rendered labels.
2. **C BPM-in-show** — TapTempo in SetupSetlistTable + song-update wiring + local patch; tests for
   the write call shape and the disabled/omitted inline case.

## Test plan
- ConductorCluster renders `Clock: on`/`Clock: off` and `Auto-fire: on/off` per state.
- Detection row shows the measuring-only subtext only while running.
- SetupSetlistTable: BPM change for a `songId` row calls `/api/songs/update` with `{ id, bpm }` and
  reflects locally; inline (no `songId`) row behaves per Q3.
