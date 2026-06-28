# Design: Setlist Reordering (Setup + Show)

**Status:** Draft v1.1 — reviewed by Opus
**Depends on:** Existing setlist UI in `app/page.tsx` (Setup + Show tabs)  
**Scope:** Drag-and-drop + explicit move up/down controls for run-order changes

---

## Problem

Setlist order is currently edited by manually changing numeric position fields. That is slow during rehearsal/show prep and easy to get wrong:

1. Users have to edit two or more rows to perform one move.
2. Duplicate/missing numbers happen easily.
3. Show tab is read-optimized, but there is no fast "bump this song up/down" workflow.

The user need is straightforward: quickly move songs up/down from either tab, including touch devices.

---

## Goals

1. Reorder songs from **Setup** and **Show** tabs.
2. Support both **drag-and-drop** and explicit **Move Up / Move Down** actions.
3. Keep `position` values correct and contiguous (`1..N`) after every reorder.
4. Preserve all per-song metadata (`lead`, `notes`, `sceneNote`, `charts`) during moves.
5. Work on desktop and mobile without backend changes.

## Non-Goals

1. Collaborative/multi-user ordering conflict resolution.
2. Undo history stack.
3. Cross-show setlist libraries.
4. AI/autofill reordering logic.

---

## UX

### Setup Tab

- Add a drag handle column to the setlist table.
- Add per-row `↑` and `↓` controls.
- Dragging or button moves immediately updates row order.
- `position` column auto-renumbers after each move.
- First-row `↑` and last-row `↓` are disabled.

### Show Tab

- Add a `Reorder` toggle/button in the Run Order / Setlist section header.
- Default state remains read-first (today's behavior).
- In reorder mode:
  - Each song row shows drag handle + `↑` / `↓`.
  - Row drag and buttons use the same reorder engine as Setup.
  - Chart icon behavior remains unchanged.
- Exit reorder mode returns to normal show view.

### Touch + Keyboard

- Touch drag supported (no long-press requirement).
- Keyboard-accessible fallback via `↑` / `↓` buttons.
- Optional: keyboard drag sensor for advanced accessibility, but not required for v1 since buttons provide full functionality.

---

## Data Contract

### Recommended Song Identity

Drag systems require stable item identity that is independent from index and visible position.

Recommended update to `SetlistSong`:

```ts
// Serialized type (localStorage / shared URL) — id optional for backwards compat
interface SetlistSong {
  id?: string;
  position: number;
  title: string;
  lead: string;
  notes?: string;
  sceneNote?: string;
  charts?: Chart[];
}

// Runtime guarantee: id is always present after load
// ensureSetlistSongIds() runs at config init, before any rendering
```

Why this split:
- `id` is for UI identity, DnD keys, and navigator song tracking.
- `position` is user-facing run-order number, auto-derived from array index after every move.

### Migration Strategy

On config init/load, `ensureSetlistSongIds()` guarantees every song has an `id`:

1. If `id` exists, keep it.
2. If missing, generate via `crypto.randomUUID()` and persist on next save.
3. Old shared links without `id` work — IDs are generated on load.

No fallback ID scheme needed — `crypto.randomUUID()` is supported in all modern browsers (Chrome 92+, Safari 15.4+, Firefox 95+).

### Position Field in Setup Tab

With auto-renumbering, the manual `position` input field in Setup becomes **read-only display** (not an editable input). Position is derived from array order — users change order via drag or arrows, not by typing numbers. This eliminates the duplicate/gap problem that motivated this feature.

---

## Reorder Rules

Single source of truth: setlist array order.

After any move:

1. Move full song object from `fromIndex` to `toIndex`.
2. Recompute `position = index + 1` for all songs.
3. Persist updated config (existing localStorage flow).
4. Keep all other fields untouched, including `charts`.

This guarantees chart bindings move with the song and prevents manual renumber drift.

---

## Implementation Plan

### 1. Shared Reorder Helpers

Create a shared helper module (e.g., `lib/setlist.ts`):

```ts
export function moveSetlistSong(setlist: SetlistSong[], from: number, to: number): SetlistSong[];
export function renumberSetlist(setlist: SetlistSong[]): SetlistSong[];
export function ensureSetlistSongIds(setlist: SetlistSong[]): SetlistSong[];
```

### 2. Setup Tab Integration

- Add drag handle + `↑` / `↓` controls to setlist table rows.
- Wire all move actions through shared helper.
- Preserve current inline editing behavior.

### 3. Show Tab Integration

- Add `Reorder` mode state scoped to Show tab.
- Render reorder controls only in reorder mode.
- Use same shared helper as Setup tab.

### 4. Drag-and-Drop Library

Use `@dnd-kit/core` + `@dnd-kit/sortable`:

- Supports pointer + touch.
- Lightweight and React-native to current architecture.
- Works with unique item IDs and sortable vertical lists.
- **Note:** This is a new dependency. SPEC.md explicitly calls out `@dnd-kit/core` as viable (SPEC.md:116). This is the one exception to the "no new component libraries" rule — it's a focused utility, not a UI framework.

Recommended configuration:
- Vertical list strategy.
- Drag activation threshold (small pointer movement) to reduce accidental drags while scrolling.

### 5. Cross-Feature Behavior

- If chart navigator overlay is open and the setlist is reordered in Show tab:
  - Keep focus on the same song `id` if present.
  - Otherwise close navigator safely.

---

## Edge Cases

| Scenario | Behavior |
|---|---|
| Move first row up | No-op; button disabled |
| Move last row down | No-op; button disabled |
| Duplicate song titles | Works; identity is by `id`, not title |
| Reorder after chart resolution | `charts` travel with each song object |
| Old config/share link without `id` | IDs generated on load, then persisted |
| Song deleted after reorder | Existing delete behavior unchanged |
| 100+ song setlist | Reorder remains client-side array ops; no network dependency |

---

## Acceptance Criteria

1. User can reorder setlist in Setup via drag and via `↑` / `↓`.
2. User can reorder setlist in Show via drag and via `↑` / `↓` (inside reorder mode).
3. `position` is always contiguous `1..N` after every move.
4. `charts`, `sceneNote`, and other song fields remain attached to the moved song.
5. Reordered list persists after refresh and is present in shareable URL payload.
6. Existing links/configs without song IDs continue to load and become reorder-capable.

---

## Testing Plan

1. Manual:
   - Reorder middle song to top/bottom in Setup.
   - Reorder in Show mode and verify Setup reflects same order.
   - Verify chart badges/icons still map to correct song after multiple moves.
2. Interaction:
   - Mouse drag, touch drag, and button-only reordering.
3. Regression:
   - Import setlist from Google Sheet, then reorder.
   - Share link open in new browser, reorder still works.
4. Optional unit tests:
   - `moveSetlistSong` + `renumberSetlist` + `ensureSetlistSongIds`.

---

## Future (Commercial Hardening, Not Blocking v1)

1. Reorder audit events (who moved what/when) once auth/backend exists.
2. Undo/redo stack for high-pressure showtime edits.
3. Conflict handling for collaborative editing sessions.
4. Role-based permissions (view-only vs reorder-enabled users).

---

## Out of Scope

1. Multi-show playlist management.
2. Automatic reorder suggestions from AI.
3. Server-side persistence or revision history.
