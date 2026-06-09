# Design — Library Chart Management

Status: **DRAFT for review** · Branch `opus/design-library-chart-management` · Owner: Graham (sign-off gate)

## Problem

`/library` (`app/library/page.tsx`) is a song catalog: title / key / lead / notes plus a
non-interactive **Charts** count column. There is no way from the library to **see**, **preview**,
**upload**, **replace**, or **delete** a song's chart files. Today the only chart-management surface
is buried in a show's **Perform** tab (`ChartNavigator` → `onChartUpload`), which uses a raw
`window.prompt()` to pick the role and only operates on songs that are already in that show's setlist.
Managing a song's charts out of show context (the natural "library" mental model) is impossible.

## Goals

- From `/library`, an owner can **view the charts attached to each song**, **preview** them,
  **upload** a new chart for a role, **replace** an existing role's chart, and **delete** a chart.
- Collaborators (non-owners) can **preview** charts but not mutate them.
- Replace the `prompt()` role flow with a proper **role picker** driven by the canonical role enum.
- **Every chart ADD fires the overlay-create (converter) trigger** — see "Overlay-create on add".

## Non-goals (this build)

- The calibration/overlay **editor** stays in-show (`ChartNavigator` calibrate mode). The library
  preview is **read-only** — no section/bar/roadmap authoring here. (Calibration is chart-scoped, so a
  library-side editor is *possible* later; explicitly deferred.)
- Building the **converter** itself. This build wires the trigger *seam*; the converter mini-spec owns
  the overlay-create implementation (see below).
- Bulk operations (multi-select, batch upload), drag-reorder of roles, chart versioning UI.

## What already exists (so this is mostly front-end)

The backend is done; we are adding UI plus one shared trigger seam.

| Concern | Existing surface | Notes |
| --- | --- | --- |
| List charts per song | `GET /api/songs` (`app/api/songs/route.ts:58`) | Already returns `song.charts[]` (full `Chart`: `url`, `role`, `label`, `fileId` = `chart_library.id`, `mimeType`, `modifiedTime`) **and** `song.chart_count`. No new endpoint needed to list. |
| Upload / replace | `POST /api/charts/upload` (`app/api/charts/upload/route.ts`) | FormData `file` + `song_title` + `role`. Owner-scoped, RLS. **Upserts** by `(owner_id, song_key, role)` → uploading a role that exists **replaces** it (clobbers blob, keeps `chart_library.id`? — see Open Q1). Returns the new `Chart`-shaped row. |
| Delete | `DELETE /api/charts/delete` (`app/api/charts/delete/route.ts`) | Body `{ chart_id }`. Owner/RLS; removes row + storage blob. |
| Preview render | `lib/pdf-viewer.ts` (`loadPdfDoc(chart)`, `renderPage(...)`) | Reusable PDF.js page render, takes a `Chart`. Images (png/jpg) render via plain `<img src={chart.url}>`. |
| Role vocabulary | `lib/normalize.ts` — `ALLOWED_ROLES` (`guitar/lyrics/keys/bass/horns/drums/other`), `canonicalizeRole`, `displayRole` | Source of truth for the role `<select>`. No hardcoding. |

## UX design

### Entry point
The **Charts** count cell in each `SongRow` becomes a button (e.g. `3 charts ›` / `+ Add chart` when
zero). Clicking opens a per-song **Manage Charts modal**. Count stays visible at a glance; the modal
is the management surface (cleaner than an inline accordion inside the grid).

### Manage Charts modal
Header: song title. Body: a list of **role slots**. Two presentations of the same list:
- **Filled role** → row shows `displayRole(role)`, file name (`chart.label`), a **Preview** button, a
  **Replace** button (re-upload for that role), and a **Delete** button (owner only).
- **Add** → a single "Add chart" affordance: role `<select>` (`ALLOWED_ROLES`, excluding roles already
  filled, since the backend is one-chart-per-role) + file picker (`.pdf,.png,.jpg,.jpeg`).

Owner gates: Replace / Delete / Add are owner-only (`is_owner` from `GET /api/songs`). Non-owner sees
Preview only.

### Upload / replace flow
1. Pick role (Add) or use the slot's role (Replace) + choose file.
2. `POST /api/charts/upload` (FormData). On success, update `songs[i].charts` in place and bump
   `chart_count`.
3. **Fire the overlay-create trigger** on the returned `chart_id` (see next section).
4. Errors surface inline in the modal (reuse the `SongForm` error pattern), no `alert()`.

### Preview
A lightweight read-only viewer (modal-over-modal or a right pane in the manage modal):
- **PDF** → `loadPdfDoc(chart)` + `renderPage` to a `<canvas>`, with prev/next page controls. **No
  calibration overlay.**
- **Image** → `<img src={chart.url}>`.
- "Open in show to calibrate" is out of scope as a deep-link for now (note for future).

## Overlay-create on add (REQUIRED — Graham)

> "Make sure we add an overlay-create trigger if we allow ADD (which we do/should)."

Per converter decision **A1 = auto-run-on-add**: whenever a chart is added, the converter should
produce a draft overlay (calibration) for it. Because this build introduces a **second** ADD path
(the library), both ADD paths must fire the same trigger — otherwise charts added via the library
would silently never get an overlay.

**Design:** route **both** ADD paths through one shared helper:

- New `lib/chart-upload.ts` (or similar) exporting `uploadChart(file, songTitle, role)` that:
  1. POSTs to `/api/charts/upload`,
  2. on success calls the **converter trigger** `triggerOverlayCreate(chartId)` (the seam),
  3. returns the new `Chart`.
- The in-show `onChartUpload` (`app/[owner]/[show]/page.tsx`) is refactored to call this same helper
  (and drops its `prompt()` in favor of the role picker if cheap; otherwise left as a follow-up — the
  trigger wiring is the load-bearing part).

**Sequencing / seam behavior:** the converter is its own next mini-spec. Until it ships,
`triggerOverlayCreate` is a **no-op stub** (charts get no overlay = today's behavior, no regression).
Once the converter lands, *every* ADD path (library + in-show) auto-fires overlay-create with zero
further wiring. This is the whole point of centralizing the seam now.

> Open sequencing question for Graham: ship the library with the **stub** seam (converter follows), or
> hold the library until the converter is built so ADD produces overlays from day one? Recommendation:
> **ship library with the stub** — it's independently valuable, and the seam guarantees no ADD path is
> ever missed once the converter merges.

## Data flow / state

`/library` already loads `songs[]` with `charts[]` embedded. The modal reads `song.charts`; after any
mutation it updates that song's `charts` array in place (same pattern as the existing
create/update/delete handlers) and adjusts `chart_count`. No refetch required.

## Build outline (proposed, gated commits → one PR)

1. **Shared upload helper + trigger seam** (`lib/chart-upload.ts`): `uploadChart()` +
   `triggerOverlayCreate()` stub. Refactor in-show `onChartUpload` to use it. (Tests for the helper's
   POST/return contract; trigger stub asserted called.)
2. **Manage Charts modal**: role-slot list, role `<select>`, upload/replace/delete wiring, owner gates.
3. **Preview**: PDF.js read-only viewer + image fallback.
4. **Library row**: Charts count → opens modal; empty-state "+ Add chart".

Gate (`npx tsc --noEmit && npm run lint && npm test && npm run build`) + commit per chunk; one PR.

## Open questions

1. **Replace identity** — does `POST /api/charts/upload` upsert preserve `chart_library.id` across a
   replace (same role)? If the id changes, any existing calibration row (`chart_calibration.chart_id`
   FK) is orphaned/cascade-deleted. Need to confirm and, if it changes, ensure the overlay-create
   trigger re-fires on replace (it will, since replace = an ADD through the same helper). *Verify in
   build.*
2. **Sequencing** — library-with-stub now vs converter-first (see above). Recommend stub-now.
3. **Preview placement** — separate modal vs split pane inside the manage modal. Minor; will pick the
   cleaner one in build.

## Out of scope / future

- Library-side calibration editor (chart-scoped, feasible later).
- Deep-link "open this chart in a show to calibrate".
- Chart versioning / history UI (the calibration sidecar already keys by `source_hash`).
