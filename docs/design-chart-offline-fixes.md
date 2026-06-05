# Design: Chart offline fixes (S30)

Two defects reported after the Song Library went live. Both relate to the
Drive→Supabase transition leaving stale behavior on the Config tab.

## Issue 1 — confusing/dead "Download Charts for Offline" CTA on a Supabase show

**Observed:** On a real show, the Config tab shows an "Offline Access → Download
Charts for Offline" button that doesn't do anything useful and whose empty-state
copy says "connect Google Drive" (deprecated).

**Cause:** `OfflineSection` (app/[owner]/[show]/page.tsx) is rendered for *all*
shows. It predates Supabase. For Supabase shows, charts now **auto-cache on every
page GET** (the load effect calls `downloadAllCharts` on all
`/storage/v1/object/public/` charts), so the manual button is redundant; its
Drive-era empty-state copy is just wrong.

The Google Drive **setup** section is already gated `{!showId && ...}` — it never
appears on a Supabase show — so it is not the source of the complaint and is left
intact for the anonymous / try-it Drive path.

**Fix:** Gate `OfflineSection` behind `!showId`, matching the existing Drive-setup
gate. Supabase shows (showId set) rely on auto-cache and no longer show the manual
CTA. Anonymous/Drive shows keep the manual download (auto-cache only handles
Supabase URLs, so Drive users still need it). No code deleted; one conditional.

## Issue 2 — new show: library songs don't show/cache charts in-session

**Observed:** Adding a song from the library to a new show shows the song row but
no chart, and nothing caches. Existing shows are fine (charts appear on load).

**Cause A:** Chart resolution + auto-cache run **only on page GET** (load effect,
keyed `[owner, slug]`). `onAddSong` pushes a setlist row with
`songId/title/key/lead/notes` but no `charts` array and never fetches the song's
charts from `chart_library`. So in-session adds have no charts until a full reload.

**Cause B:** The Drive-era "wipe charts when Drive disconnected" effect
(`if (!config.chartsRootFolderId) → set every charts = undefined`) runs for every
Supabase show (which never has `chartsRootFolderId`). On the Setup tab it nukes any
charts in config state — so even resolved/attached charts get cleared.

**Fix A:** `/api/songs` GET returns a `charts[]` per song (built from the
`chart_library` rows it already queries for counts), shaped like the load path
(`role, url, fileId, mimeType, modifiedTime, label`). `AddSongFromLibrary` carries
`charts` through `handleSelect → onAddSong`. The `onAddSong` handler attaches
`charts` to the new row and fires `downloadAllCharts` for the Supabase ones so they
cache immediately — no reload.

**Fix B:** Guard the wipe effect with `if (showId) return;`. The wipe is only
meaningful for the Drive/anonymous path; Supabase charts come from the library and
must never be wiped. (Newly created songs with no charts simply get an empty array,
which is fine.)

## Out of scope (follow-up)
Full Google Drive teardown (resolveCharts/batch, token threading through
Mix/Perform/ChartNavigator, `/api/drive/*`). Deprecated but still serves the
anonymous/try-it path; ripping it is a larger, separate change.

## Test plan
- New show, add library song that has charts → chart shows immediately, caches (no reload).
- Open Setup tab on an existing Supabase show with charts → charts remain (not wiped).
- Supabase show Config tab → no manual "Download Charts for Offline" CTA.
- Anonymous/try-it Drive show → Drive setup + manual offline CTA still present.
