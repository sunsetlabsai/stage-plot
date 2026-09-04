# Design — Library Chart Management

Status: **build state in `docs/INDEX.md`, not here** · Branch `opus/design-library-chart-management` · Owner: Graham (sign-off gate)

> **Revision note (S34).** This spec was first drafted *before* the auto-overlay converter shipped.
> The converter is now **live** (route `/api/charts/convert` + shared seam `lib/chart-upload.ts`), so
> the old "stub seam / sequencing" question is moot and Open Q1 is resolved by reading the code.
> Graham also confirmed the architecture below: **the library is the authority; a show is just a link
> to it**, so chart management is one shared surface used from both places. Per-key variants are
> handled by **duplicate-with-edit**, no schema change.

## Problem

`/library` (`app/library/page.tsx`) is a song catalog: title / key / lead / notes plus a
non-interactive **Charts** count column. There is no way from the library to **see**, **preview**,
**upload**, **replace**, or **delete** a song's chart files. Today the only chart-management surface
is buried in a show's setlist (`SetupSortableRow` → `onChartUpload`, `app/[owner]/[show]/page.tsx:5151`),
which uses a raw `window.prompt()` to pick the role and only operates on songs already in that show's
setlist. Managing a song's charts out of show context (the natural "library" mental model) is impossible.

## The library is the authority (confirmed)

A show persists **zero** chart data — charts live only in `chart_library`, keyed
`(owner_id, song_key = normalize(title), role)`:

- Save sends setlist entries with only `song_id, title, key, lead, notes, sceneNote` — no charts
  (`lib/use-show.ts:70`).
- YAML export explicitly strips `charts` (and `id/position/songId`) off each entry (`lib/show-file.ts:50`).
- On load, charts are resolved fresh from the library by **normalized title** (`app/[owner]/[show]/page.tsx:419-434`).

**Consequence:** add / replace / delete in *either* surface mutates the same `chart_library` rows.
So we do **not** build a separate show-side chart manager — we build **one shared Manage-Charts
component** and open it from both the library row and the in-show "+" chip. This also retires the
`window.prompt()` role flow everywhere (one role `<select>`, one component).

## Goals

- From `/library`, an owner can **view** a song's charts, **preview** them, **upload** a new chart for
  a role, **replace** an existing role's chart, and **delete** a chart.
- The **same Manage-Charts component** replaces the in-show `prompt()` add path — both surfaces are
  windows onto the one authority (`chart_library`).
- Collaborators (non-owners) can **preview** charts but not mutate them.
- Every chart ADD/REPLACE fires the live overlay-create converter (already wired via `uploadChart`).
- **Per-key variants via duplicate-with-edit**: duplicate a song row to get e.g. "Song X (Bb)" with its
  own chart set — no schema change.

## Non-goals (this build)

- The calibration/overlay **editor** stays in-show (`ChartNavigator` calibrate mode). The library
  preview is **read-only** — no section/bar/roadmap authoring here. (Chart-scoped, so a library-side
  editor is feasible later; explicitly deferred.)
- Bulk operations (multi-select, batch upload), drag-reorder of roles, chart versioning UI.
- **Auto-transposing** a chart to a new key (the "key-change converter") — future idea, backlog only.
  Duplicate-with-edit gives the variant slot; you re-upload transposed charts manually for now.

## What already exists (so this is mostly front-end)

| Concern | Existing surface | Notes |
| --- | --- | --- |
| Shared ADD path + overlay seam | `lib/chart-upload.ts` — `uploadChart(file, songTitle, role)` | **LIVE.** POSTs `/api/charts/upload`, then fires `triggerOverlayCreate(chartId)` → `/api/charts/convert`. Throws `ChartUploadError` on upload failure; overlay failure is swallowed (chart still uploads). In-show already calls this. |
| List charts per song | `GET /api/songs` | Returns `song.charts[]` (full `Chart`: `url`, `role`, `label`, `fileId` = `chart_library.id`, `mimeType`, `modifiedTime`) **and** `song.chart_count` **and** `is_owner`. No new list endpoint needed. |
| Upload / replace | `POST /api/charts/upload` (`app/api/charts/upload/route.ts:70`) | FormData `file` + `song_title` + `role`. Owner-scoped, RLS. Upserts on `(owner_id, song_key, role)` → re-uploading a filled role **replaces** it and **preserves `chart_library.id`** (see Resolved Q1). |
| Delete | `DELETE /api/charts/delete` | Body `{ chart_id }`. Owner/RLS; removes row + storage blob. |
| Preview render | `lib/pdf-viewer.ts` (`loadPdfDoc(chart)`, `renderPage(...)`) | Reusable PDF.js page render. Images render via `<img src={chart.url}>`. |
| Role vocabulary | `lib/normalize.ts` — `ALLOWED_ROLES`, `canonicalizeRole`, `displayRole` | Source of truth for the role `<select>`. No hardcoding. |
| Song create/update/delete | `POST /api/songs`, `/api/songs/update`, `/api/songs/delete` | Used for the **duplicate** flow (create with copied metadata). |

## UX design

### Entry points (two, one component)
1. **Library row** — the **Charts** count cell becomes a button (`3 charts ›`, or `+ Add chart` when
   zero). Opens the per-song **Manage Charts modal**.
2. **In-show "+" chip** (`SetupSortableRow`, `page.tsx:5527`) — opens the **same** modal instead of the
   current `prompt()`.

### Manage Charts modal (shared component)
Props: the song (`title`, `charts[]`), `isOwner`, and an `onChartsChanged` callback so each caller
updates its own local state. Library: the one `songs[i].charts` + `chart_count`. In-show: **every
setlist row whose normalized title matches** (not just the clicked row) — a song can legitimately
appear in a setlist more than once, and charts are title-keyed authority, so all matching rows must
reflect the change. This mirrors the existing prompt-flow update (`page.tsx` `setlist.map((s) =>
s.title === songTitle ? … : s)`).
Header: song title. Body: a list of **role slots**:
- **Filled role** → `displayRole(role)`, file name (`chart.label`), **Preview**, **Replace** (re-upload
  same role), **Delete** (owner only).
- **Add** → role `<select>` (`ALLOWED_ROLES`, **excluding already-filled roles** since backend is
  one-chart-per-role) + file picker (`.pdf,.png,.jpg,.jpeg`).

Owner gates: Replace / Delete / Add are owner-only (`isOwner`). Non-owner sees Preview only.

### Upload / replace / delete flow
1. Add: pick role + file. Replace: slot's role + file.
2. Call `uploadChart(file, songTitle, role)` (the live shared helper — uploads then auto-fires the
   converter). Surface the returned `overlay` outcome as transient status (reuse the in-show
   `overlayStatus` "Generating overlay…" pattern where present).
3. On success, update the caller's local `charts`. **Bump `chart_count` only on a genuinely new role**,
   not on replace (replace keeps the same row/id).
4. Delete: `DELETE /api/charts/delete` → drop from local `charts`, decrement `chart_count`.
5. Errors surface inline (reuse the `SongForm` error pattern), no `alert()`. Delete uses `confirm()`
   (matches the existing library delete UX).

### Preview
Read-only viewer, **split pane inside the manage modal** (Open Q3 resolved → split pane; fewer stacked
overlays):
- **PDF** → `loadPdfDoc(chart)` + `renderPage` to a `<canvas>`, prev/next page controls. **No
  calibration overlay.**
- **Image** → `<img src={chart.url}>`.

## Per-key variants — duplicate song (decided)

**Constraint:** charts key by `normalize(title)` and the show resolves charts by `normalize(title)`, so
one title = one chart set regardless of `key`. You cannot hold Song-X-in-G *and* Song-X-in-Bb under one
title.

**Decision (blessed):** *duplicate-with-edit*, **no schema change**:
- A **Duplicate** action on a library song creates a new song row with **metadata only** copied
  (`title` suffixed e.g. "Song X (Bb)", plus `key`/`lead`/`notes`) and **no charts** — you then set the
  new key and upload the transposed charts. (Charts deliberately not copied: they differ by definition;
  copying blobs you'd immediately replace is waste.)
- **Title is identity.** The variant marker lives in the title text ("(Bb)") → a distinct `song_key` →
  its own chart set. A show's setlist entry simply names the variant it wants. (Alternative — making
  `key` part of song identity — is a schema change + backfill; rejected for now.)
- UI: a **Duplicate** button on `SongRow` (owner only) opens the existing `SongForm` pre-filled with the
  copied metadata; on save it `POST`s `/api/songs` like a normal create. (No new endpoint.)

## Data flow / state

`/library` already loads `songs[]` with `charts[]` embedded; the in-show page holds `setlist[]` with
`charts[]`. The shared modal never refetches — it mutates the caller's local array via the
`onChartsChanged` callback (same pattern as the existing create/update/delete handlers). The library
caller updates the single matching `Song`; the in-show caller updates **all** setlist rows sharing the
normalized title (title-keyed authority). Duplicate inserts a new `Song` into the library list
(re-sorted by title).

## Resolved questions

1. **Replace identity — RESOLVED.** `POST /api/charts/upload` upserts on
   `onConflict: 'owner_id,song_key,role'`, so a replace **preserves `chart_library.id`** → the
   `chart_calibration` FK is **not** orphaned/cascade-deleted. The new file has a new `source_hash`, so
   the re-fired converter **inserts a fresh DRAFT** calibration row and the viewer picks it by hash; a
   prior *verified* overlay is correctly superseded (new file needs re-verify). Only side effect: the
   old-hash calibration row lingers as harmless dead data — note for a future cleanup, not a blocker.
2. **Sequencing — MOOT.** The converter shipped; `uploadChart` already fires it. No stub, no gating.
3. **Preview placement — RESOLVED.** Split pane inside the manage modal.

## Build outline (gated commits → one PR)

1. **Manage Charts modal** (shared component): role-slot list, role `<select>` (filled roles excluded),
   upload/replace/delete via `uploadChart` + `/api/charts/delete`, owner gates, inline errors, transient
   overlay status. Tests for slot rendering, owner gating, add-vs-replace `chart_count` logic.
2. **Wire entry points**: (a) library `SongRow` Charts cell → opens modal; empty-state "+ Add chart".
   (b) in-show "+" chip → opens the same modal, **removing the `prompt()`** (`page.tsx:5151-5162`).
3. **Preview**: PDF.js read-only split pane + image fallback.
4. **Duplicate song**: owner-only Duplicate on `SongRow` → pre-filled `SongForm` → `POST /api/songs`.

Gate (`npx tsc --noEmit && npm run lint && npm test && npm run build`) + commit per chunk; one PR.
Report test-count delta.

## Out of scope / future

- **Key-change converter** — auto-transpose a chart to a new key (notation → transpose → re-render, not
  audio). Pairs with the duplicate-variant slot above. Backlog (`project_showbible_backlog.md`).
- Library-side calibration editor (chart-scoped, feasible later).
- Deep-link "open this chart in a show to calibrate".
- Stale-calibration-row cleanup (old `source_hash` rows after a replace).
- Chart versioning / history UI.
