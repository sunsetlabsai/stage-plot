# ShowRunr — Product Spec

**One file for how the product behaves.** Written 2026-10-07 against `main` = `40a4318`. Every
behaviour rule below cites the code that makes it true. The rules were checked against the code,
not copied from the design docs.

| Question | Where the answer lives |
|---|---|
| How does feature X behave? | **This file.** |
| Is X built? | `docs/INDEX.md`, the build-state authority, enforced by `tests/docs-index-contract.test.ts`. |
| Why was X designed this way? | The design doc listed under "Source docs" in Appendix B. Read it only when changing X. |
| What's left before UAT, and how do we test it? | `docs/uat-plan-v1.md`. |

**Maintenance rule.** A PR that changes behaviour described here updates the matching rule in the
same PR. This file never carries a build-status line; that is INDEX.md's job, and per-doc status
lines rotted once before (INDEX.md §preamble). Where a design doc and this file disagree, the code
decides, and Appendix A records the known drift.

Cite shorthand: `P` = `app/[owner]/[show]/page.tsx` (≈7,160 lines), `CC` = `lib/chart-calibration.ts`.
Bare `page.tsx:N` also means `P`. Line numbers are as of `40a4318` and will drift; the symbol
names are the stable part.

---

## 1. The product in one page

**What it is.** A live, phone-first technical rider and gig book for a working band. A band
leader builds a **show** with the stage plot (who stands where), input list, monitor mixes,
notes and setlist, and gets a link at `showrunr.ai/{handle}/{show}`. Anyone with the link opens it
on a phone with no account. The engineer reads the rider. The players read their charts, which
keep working offline at the venue. One player can **conduct**: their phone moves everyone's
"you are here" line through the chart in real time.

**Who does what.**

| Role | How you get it | Can |
|---|---|---|
| Link viewer | Has the URL; signed out, or signed in to a different account | Read Perform + Mix, read charts, print, share, follow or take the conductor baton |
| Owner | Signed in; created the show (`shows.owner_id`) | Everything above, plus Config + AI tabs, song library, chart upload/build, overlays |
| Platform admin | Session email = `PLATFORM_ADMIN_EMAIL` | `/admin` and `/api/admin/*` (owners list, backfills) |

Collaborators are view-only and behave exactly like link viewers. Nothing creates a collaborator
row, so the role exists in the schema only (§3, rule 13).

**Surfaces.**
- `/sign-in` (email code) → `/claim` (pick a handle) → `/dashboard` (your shows) · `/library` (your songs and charts) · `/dashboard/settings` (your Claude key).
- Show page `/{owner}/{show}`, with tabs **Perform** (setlist + charts, the gig view), **Mix**
  (the rider; also the print view), **Config** (owner editor), **AI** (owner co-designer).
- Chart viewer (full-screen, per song): page turns, part filter, overlay/playhead, calibrate
  editor (owner), conductor cluster.
- Chart builder: describe a song in words and get a clean number chart PDF (owner).
- Relay at `relay.showrunr.ai`: the room server that lets one device conduct many.

**Stack.** Next.js 16.2.6 on Vercel (project `stage-plot`, team `salonhqs-projects`) ·
Supabase (Postgres + Auth + Storage bucket `charts` + Vault) · Anthropic API (AI co-designer,
chart overlay labels, chart builder parse) · relay = Node WebSocket server on Fly (`showrunr-relay`,
exactly one machine) · PWA with a hand-written service worker. Local gate before any PR:
`npm test && npm run lint && npx tsc --noEmit && npm run build`.

---

## 2. Show — dashboard, show page, setlist, song library, sharing, export, AI co-designer

**What it is.** A show is one gig's rider at a public URL, `/{owner}/{show}`, that anyone with the link
can open on a phone. It holds the stage plot (who stands where), the input list, monitor mixes,
general notes and the setlist. Performers use the **Perform** tab (setlist + charts); the engineer uses
**Mix** (the full rider, also the print view); only the owner sees **Config** (the editor) and **AI**
(describe the band in plain words, approve the changes). Songs live once in the owner's song library
and are referenced by every setlist that uses them.

### 2.1 Behaviour

Dashboard and show creation
1. `/dashboard` and `/library` require sign-in; middleware redirects otherwise (`middleware.ts:74`).
2. Dashboard lists **Owned** shows (Open / Duplicate / Delete) and **Shared with me** (Open only)
   (`app/dashboard/page.tsx:230-260`, card `:279-326`). Delete asks `confirm()` (`:133`).
3. **New Show** opens a modal that takes a name; Create posts `showInfo.bandName = showName = name`
   and an empty plot/inputs/monitors/notes/setlist (`app/dashboard/page.tsx:431-440`).
4. **Duplicate** copies the source config, sets `showName` to the new name, keeps `bandName`, venue
   and date, and strips per-song `charts` (charts re-resolve on load) (`app/dashboard/page.tsx:398-429`).
5. The server trims the name to 100 chars and rejects names with no letter/digit (400)
   (`app/api/shows/route.ts:97-110`). Slug = slugified name; a reserved word or a collision gets a
   random 4-char suffix, up to 5 tries, then 409 (`:113-115`, `:171-180`, `:205-214`).
6. **Slugs never change after creation.** Save writes name/venue/date/config only; nothing in
   `PUT /api/shows/update` touches `slug` (`app/api/shows/update/route.ts:193-239`). Renaming a show
   changes the display name, never the link.
7. A non-empty setlist on create/duplicate/YAML import goes through `rpc_create_show_with_setlist`
   (library-referenced, `setlist_migrated=true`); an empty one takes the legacy insert
   (`app/api/shows/route.ts:118-181`, `:183-214`). **Import YAML** on the dashboard creates a new show
   from a `.yaml/.yml/.json` file (`app/dashboard/page.tsx:87-130`).
8. Deleting a show does not delete charts — they are owner-scoped, not show-scoped
   (`app/api/shows/delete/route.ts:31-36`).

Loading, access and saving
9. `GET /api/shows/{owner}/{show}` needs **no sign-in**; it returns the config with the setlist
   hydrated from `setlist_entries`+`songs` (migrated) or the inline config, plus library charts matched
   by normalized title (`app/api/shows/[owner]/[show]/route.ts:50-145`).
10. Everyone lands on **Perform**; switching shows resets to Perform (`page.tsx:405`, `:494`).
    Perform and Mix are visible to all; Config and AI render only for the owner, enforced by
    derivation, not just hidden buttons (`lib/show-tabs.ts:20-30`, `page.tsx:754`, `:830-853`).
11. Collaborators are **view-only**. Ownership (`owner_id === user.id`) is the only write gate:
    client chokepoint `updateConfig` refuses for non-owners (`page.tsx:656`); `useShow` never saves for
    non-owners (`lib/use-show.ts:42`,`:149`); the server checks owner on the entries path
    (`update/route.ts:57-63`) and relies on RLS on the legacy path (`:227-232`).
12. Banners: signed-out viewer sees "Not signed in — changes won't be saved" (`page.tsx:788-793`);
    any signed-in non-owner sees "Viewing as collaborator (read-only)" (`page.tsx:794-798`).
13. Owner edits autosave 2 s after the last change; config is also written to localStorage first
    (`lib/use-show.ts:148-164`). The tab-bar pill shows Saving… / Saved / red "Couldn't save — …";
    a network failure says "you appear to be offline…" (`use-show.ts:109-111`, `page.tsx:890-903`).
14. Setlist save: owners send entries; the server resolves each row by `songId`, else by normalized
    title, **auto-creating a missing library song**, then stores per-show key/lead/notes overrides
    (null = library default, '' = blank, value = override) (`update/route.ts:66-163`).
15. Bad link: a 4xx shows "Show not found" with a home link and no tabs; a network error or 5xx
    first tries the cached copy, else shows "Connection error" + Retry (`page.tsx:502-512`,
    `:586-592`, `:756-783`). `showrunr-last-show` is written only after a successful load
    (incl. the offline-cache restore) (`page.tsx:600-605`). Offline app launch at `/` jumps to it
    (`app/page.tsx:39-46`).

Perform tab
16. Dark, setlist-first view: header = show name (else "venue · date", else "Setlist"), song count,
    chart-caching status, a Share button (`page.tsx:1072-1126`). Rows show number, title, key pill and
    a chart button when the song has charts for the selected role (`page.tsx:1160-1201`).
    "No setlist yet." when empty (`:1158`).
17. Role pills (All + roles present in charts) filter chart buttons; the choice is kept per show in
    sessionStorage `showrunr-role-filter-{owner}/{slug}` (`page.tsx:1013-1025`, `:1129-1153`).
18. `?song=N&chart=ROLE` opens the chart viewer on song N; `?join=CODE` auto-opens the first charted
    song for the relay (`page.tsx:1043-1067`, `:1033-1058`; `lib/share.ts:58-70`).

Mix tab and print
19. Mix shows header (band name, show name, venue · date, lineup) then 1 Stage Plot, 2 Input List,
    3 Monitor Mixes (with type tag if set), 4 Notes, 5 Run Order (lead colour-coded, notes, scene note,
    charts) (`page.tsx:1497-1612`).
20. Stage plot = 3×3 zones; a zone can hold several people (stacked chips with MIX n, ×n inputs,
    POWER badges); the mid-stage row appears only if occupied (`page.tsx:1254-1290`, `:258-300`).
21. Only the owner sees **Reorder** on the Mix run order (drag + ↑/↓) (`page.tsx:1472`, `:1612-1621`).
22. The print button (any tab, any viewer) opens a section picker, switches to Mix, prints, then
    restores the tab (`page.tsx:927-981`). Printed run order: ≤16 songs normal, >16 compact, ≥29 flows
    in CSS columns across pages (`page.tsx:1745-1795`).

Config tab (owner)
23. Sections: Show Info (band name, show name, date, venue), Stage Plot (drag chips between zones +
    table with mix dropdown, position, power, name), Input List, Monitor Mixes, Notes, Setlist, Drive
    charts (legacy, only with Drive configured), Export/Import (`page.tsx:6353-6935`).
24. Each input has a Position dropdown linking it to a performer (`slotId`); "+ New occupant at…"
    makes or reuses a performer; deleting a performer with linked inputs asks keep-and-flag vs clear;
    flagged inputs get an amber "relink" state until re-picked (`page.tsx:6527-6560`, `:6588-6619`,
    `:5097-5115`; `lib/setlist.ts:99-143`).
25. Reordering inputs or monitors renumbers `ch`/`mix` to 1..N; deleting one renumbers the rest;
    adding uses N+1 (`lib/setlist.ts:154-180`, `page.tsx:6622-6651`). Monitor Mix # is a read-only cell.
26. Setlist rows: drag + ↑/↓, positions always 1..N (`lib/setlist.ts:66-86`, `page.tsx:4941`). A
    library-linked row's title is read-only with "Rename in Library"; unlinked rows stay editable
    (`lib/setlist.ts:202`, `page.tsx:4897-4910`). Owners get Tap Tempo BPM on library-linked rows,
    written straight to the song (`page.tsx:4872`, `:705-735`).
27. **+ Add Song** searches the library; picking one adds it with its key/lead/notes/bpm/charts;
    no exact match → owner sees **Create & Add "title"** (POST `/api/songs`) (`page.tsx:4599-4760`).
28. Google Sheet import: paste URL → **Preview import** → diff panel → **Apply import**. Matches by
    normalized title, keeps matched rows' id/charts/bpm, a blank cell never clears a value, removal of
    songs missing from the sheet is opt-in (unchecked) with a second confirm, a zero-row sheet is
    refused, the sheet tab (`gid`) is honoured, BPM/Artist columns are reported and ignored. One-level
    **Undo import** until the next user edit or tab change (`lib/setlist-import.ts:143-180`,`:202-211`,
    `:358`; `app/api/sheet/route.ts`; `page.tsx:6286-6346`, `:610-697`, `:881-888`;
    `components/SetlistImportPreview.tsx:48-70`).
29. Export: **Export Show (.yaml)** (`{name}.showrunr.yaml`, strips ids/songId/charts), **Export
    Patch (.csv)** (BOM, RFC-4180, header `Channel,Name,Mic,Stand,Notes`, sorted by ch) and
    **Export Patch (.xml)** (`<showrunr-patch version="1">`, blank attrs omitted). Filenames use
    slugified show-or-band name (`page.tsx:6939-6985`, `lib/console-export.ts`, `lib/show-file.ts:35-60`).
30. **Import Show** in Config replaces the whole current config from a file, with no confirm
    (`page.tsx:6987-7003`).

Sharing
31. Share buttons use a 3-tier fallback: share the PDF file (chart only) → share the link →
    copy the link ("Link copied"); cancel is a no-op (`lib/share.ts:83-134`, `components/ShareButton.tsx`).
    Perform header shares the bare show URL (`page.tsx:1123-1126`); the chart viewer shares the PDF or
    `?song=N&chart=ROLE` (`page.tsx:3898-3915`).
32. The tab-bar "Publish & copy link" icon only copies `/{owner}/{slug}` to the clipboard; there is no
    publish step — a show is live at its URL from creation (`page.tsx:743-748`, `:857-874`).

Song library (`/library`)
33. Lists the owner's songs (title/artist, key, bpm, lead, chart count, show count); title search;
    owner can Add, Edit, Duplicate (metadata only, title "X (copy)"; `lib/chart-management.ts:49`), Delete (confirm names show
    count), Manage charts, Build chart (`app/library/page.tsx:11-340`).
34. Song titles are unique per owner by normalized key (409); renaming re-keys that song's charts;
    BPM must be an integer 20–400 (`app/api/songs/route.ts:140-180`, `songs/update/route.ts:61-106`).
35. Deleting a song removes it from every setlist (renumbered) and deletes its charts and blobs
    (`songs/delete/route.ts:22-34`, `rpc_delete_song` in `006_songs.sql`).

AI co-designer
36. AI tab (owner only): chat proxied through `POST /api/agent/chat`; device key → account key →
    free "try-it" key (50 messages per IP per 30 days), model from env (default
    `claude-sonnet-4-6`) (`app/api/agent/chat/route.ts:46-103`, `lib/agent-key.ts:14-29`).
37. Six full-replace tools: `update_stage_plot/inputs/monitors/setlist/notes/show_info`; only the
    nine on-grid positions are allowed (`lib/agent.ts:49-198`). Each tool call is a card with
    **Apply / Reject**; nothing changes until Apply (`page.tsx:5588-5664`, `:5840-5866`).
38. Applying `update_stage_plot` **regenerates the whole input list and monitor list** from performer
    roles (keyword expansion) — prior inputs/monitors are discarded, with no confirm
    (`page.tsx:5608-5640`, `:5486-5559`). The card previews the generated lists (`page.tsx:5954-6018`).

### 2.2 Data & key files

- `shows` (id, owner_id, slug unique per owner, name, venue, show_date, config jsonb,
  setlist_migrated) · `songs` (id, owner_id, song_key unique per owner, title, artist, key, lead,
  notes, bpm int 20–400) · `setlist_entries` (show_id, song_id RESTRICT, position, key/lead/notes
  overrides, scene_note) · `show_collaborators` · `chart_library` keyed by (owner_id, song_key, role).
  Migrations `001`, `005`, `006`, `010`, `012`, `014`.
- Config types: `StageSlot{id,name,pos,role,mix,power,featured}`, `InputChannel{id,ch,inst,mic,stand,
  notes,slotId,needsReview}`, `MonitorMix{id,mix,name,needs,type}`, `SetlistSong{id,songId,position,
  title,key,lead,notes,sceneNote,bpm,charts}` (`lib/types.ts:1-47`, `:225-237`).
- Routes: `/api/shows` (GET list, POST create), `/api/shows/{owner}/{show}` (public GET),
  `/api/shows/update` (PUT), `/api/shows/delete`, `/api/songs` (GET/POST), `/api/songs/update`,
  `/api/songs/delete`, `/api/sheet` (public CSV proxy, Google Sheets only), `/api/agent/chat`.
- Modules: `app/[owner]/[show]/page.tsx` (7161 lines), `app/dashboard/page.tsx`, `app/library/page.tsx`,
  `lib/{show-tabs,use-show,setlist,setlist-import,share,console-export,show-file,agent,agent-key,
  normalize,overrides}.ts`, `components/{ShareButton,SetlistImportPreview}.tsx`.

### 2.3 Settled rulings (do not re-litigate)

- Slugs are immutable; a show created as "New Show" keeps `new-show` (design-share-reliability Fix 1).
- Setlists **reference** library songs; per-show overrides only for key/lead/notes; three-state
  override semantics (design-song-library §Architecture).
- Collaborators are view-only everywhere — no setlist, song or reorder edits (design-single-backend §3.3c).
- Import: "Merge by title, preserve matched rows… show a diff before applying" (Graham 2026-08-10);
  `key` header matches exact only; BPM and artist never imported.
- Library-linked titles are renamed in the library, not the setlist (core-path-tier1 §5.4).
- No repair/migration of past production data (core-path-tier1 §5.2).
- `MonitorMix.type` is free text, not an enum; agent model is an env value; regenerate on a
  non-empty show = confirm-and-replace, not refuse (ai-op-contract §12).
- Mix (slot) stays off the input list and off the console export until a real sends model exists
  (input-plot-linkage; design-input-sends).
- Console export Tier 1 only (CSV/XML); vendor formats only on demand (design-console-export).
- Off-grid zones and input sends: parked, build only on show-runner confirmation (issue #138).

### 2.4 Not built / partial

- Mix identity: `renumberMix`, `validateMonitors`, sort-by-mix, orphaned-mix badge/"Mix 7 — removed",
  delete-names-performers prompt (design-core-path-tier1 §3; input-plot-linkage step 5 monitor parts).
- Op-based AI contract (`edit_show`/`apply_changes`, `planChanges`, diff card, confirm-and-replace,
  `generate_show`), gated on an unrun model spike (design-ai-op-contract; linkage step 6).
- AI diff view (+/~/−) against current config (design-agent-codesigner §Preview); cards list the
  proposed rows only.
- Off-grid PIT/FOH/OTHER rendering (design-offgrid-zones); input send matrix (design-input-sends).
- Show freeze after the show date (backlog-show-freeze).
- Library: filter by key / chart status, list of which shows use a song, "Reset to default" for
  per-show overrides (backlog-song-library-manager; design-song-library §Config tab).
- Song-library PR B cleanup (drop dual-write/dual-read, `setlist_migrated`) (design-song-library).
- Artist persistence from sheet import (design-setlist-import-merge §6).
- Share action on library rows; owner QR/social/tip-jar links (issue #139).
- Perform v1 extras: lead singer + notes on rows, now-playing sync, setlist-only sharing
  (design-perform-tab; §Future).
- Console export Tier 2/3 and `phantom/stereoLink/directOut` fields (design-console-export).

## 3. Platform — accounts, sharing, AI keys, offline

**What it is.** ShowRunr runs on one backend (Supabase: Postgres + Auth + Storage + Vault). A band
leader signs in with an emailed 6-digit code, claims a handle, and every show lives at
`/{handle}/{show}`. Anyone with that link can open the show — no account, no barrier — but only the
owner can change it. AI features run on the owner's own Anthropic key (kept in this browser or saved
encrypted to their account) or on a small shared free allowance. Once a show has been opened online,
its setlist and charts keep working on that device with no signal.

### 3.1 Behaviour

**Sign-in and onboarding**
1. Sign-in is email OTP only: `signInWithOtp({email})` then `verifyOtp({type:'email'})` with a 6-digit code — `app/sign-in/page.tsx:34,50`. There is no Google sign-in button and no `signInWithOAuth` anywhere in `app/`/`components/`/`lib/`.
2. After verify, the client POSTs `/api/auth/activate-invites` (`app/sign-in/page.tsx:63`), which links any `show_collaborators` rows matching the email via the `activate_invites` RPC — `app/api/auth/activate-invites/route.ts:15`.
3. After sign-in the browser does a full document load to `?redirect=` if it is same-origin (URL-parser check, `lib/safe-redirect.ts:33-56`), else `/dashboard` (`lib/safe-redirect.ts:22`).
4. A signed-in user with no `profiles` row is redirected to `/claim` from EVERY page except `/claim`, `/sign-in`, `/sign-out` and `/api/*` — including public show pages — `middleware.ts:92-106`.
5. Handle rules: 3–30 chars, `[a-z0-9-]`, no leading/trailing hyphen (`app/api/profiles/route.ts:4`); 15 reserved words rejected (`:6-10,36`); taken → 409 "That handle is already taken" (`:62`); one profile per user (`:47`). After claim the page shows success and loads `/dashboard` after 1.5 s (`app/claim/page.tsx:70`). There is no UI to change a handle.
6. `/dashboard`, any `/dashboard/*` child, and `/library` redirect signed-out visitors to `/sign-in?redirect=<path+query>` — `middleware.ts:74-87`. `/admin` is NOT middleware-gated; its APIs 401 instead.
7. Sign-out (`app/dashboard/page.tsx:144-147`) calls `supabase.auth.signOut()` and does not clear the device BYOA key (issue #134, open).

**Roles (three tiers + link viewers)**
8. Platform admin = the signed-in user whose server-side `getUser()` email equals `PLATFORM_ADMIN_EMAIL` (both trimmed + lowercased); fails closed on unset env, no session, or auth error; every rejection is an identical 401 — `lib/admin-auth.ts:30-52`. Used by all four `/api/admin/*` routes (`settings`, `owners`, `migrate-setlists`, `backfill-chart-overlays`). `/api/admin/settings` is GET-only (masked config) — `app/api/admin/settings/route.ts:15`.
9. Admin routes are rate-limited 5 req/min per IP per route, in a process-local Map — `lib/admin-rate-limit.ts:3-5`.
10. Owner = `shows.owner_id`. On the show page `isReadOnly = !isOwner` (`app/[owner]/[show]/page.tsx:749`); ownership is `data.owner_id === user.id` (`:579`). Config and AI tabs render only for the owner (`:830,842`; enforced again by `lib/show-tabs.ts:20,28`). Reorder on Mix is owner-only (`:1612`).
11. Every non-owner (signed-out OR signed-in) is read-only. Signed-out sees "Not signed in — changes won't be saved. Sign in" (`:788-792`; the link carries no `redirect`, so sign-in lands on `/dashboard`). Any signed-in non-owner sees "Viewing as collaborator (read-only)." (`:794-797`) — regardless of whether a collaborator row exists.
12. Writes check ownership server-side: `PUT /api/shows/update` 403s a non-owner before its service-role RPC (`app/api/shows/update/route.ts:48-60`); its legacy path uses the user client under RLS "Owner update" (`:232`). `DELETE /api/shows/delete` is owner-only (`app/api/shows/delete/route.ts:20-29`) and does NOT delete library charts (`:32`).
13. Collaborators are view-only; the `editor` role and `show_collaborators.role` column are gone (`supabase/migrations/014_collaborator_view_only.sql`). Nothing in the app INSERTs a `show_collaborators` row (grep of `app lib components` finds only reads at `app/api/shows/route.ts:44`, `app/api/songs/route.ts:37`), so the dashboard's "Shared with me" (`app/dashboard/page.tsx:247-261`) can never populate.

**Shows and URLs**
14. Show URLs are `/{owner_slug}/{show_slug}`; show slugs are unique per owner (`005_owner_namespacing.sql:19-20`). Slug = lowercased name, non-alphanumerics → `-` (`app/api/shows/route.ts:13-15`); a collision or reserved word gets a random 4-char suffix, 5 attempts, then 409 (`:113-115,153-180`).
15. `GET /api/shows/[owner]/[show]` has NO auth check by design and reads via the service role (`app/api/shows/[owner]/[show]/route.ts:50-61`). It returns config, hydrated setlist, `show_id`, `owner_id`, and public Storage URLs for every library chart matching a setlist title (`:97-134`). Privacy, if ever wanted, must be built in this route — RLS is not involved.
16. Three legacy single-segment slugs 301 to their namespaced URLs (`middleware.ts:4-8,52-60`); `/?show=` and `/?config=` legacy links are handled in `app/page.tsx:22-37`.
17. Dashboard lists Owned shows (New, Import YAML, Duplicate, Delete) — `app/dashboard/page.tsx:194-243`. Per-show `.showrunr.yaml` export is in the Config tab (`app/[owner]/[show]/page.tsx:6943`).

**AI keys**
18. Key precedence for `/api/agent/chat`: device key (Authorization header) → account key (Vault, only looked up when no header) → shared try-it key + quota — `lib/agent-key.ts:361-402`, `app/api/agent/chat/route.ts:66-75`.
19. Try-it: 50 messages per hashed IP per FIXED 30-day window (`lib/agent-key.ts:14,97`; `001_initial_schema.sql:234-257`); IP is HMAC-SHA256'd with the service-role key (`lib/agent-key.ts:259-260`). Exhausted → 429 "Free messages used up…" (`chat/route.ts:76-84`). DB error → in-memory fallback (fail open), except 42501 → fail closed (`lib/agent-key.ts:200-213`).
20. Capability probe `GET /api/agent/capabilities` never consumes quota (`peek_tryit`); an account-key user is answered `{accountKey:true}` before the 60/min/IP probe limiter — `app/api/agent/capabilities/route.ts:40-54`.
21. A BYOA key Anthropic rejects returns 401 with `keyReject: 'device'|'account'` (`chat/route.ts:131-142`); the AI tab shows "Clear saved key" for device, "Manage key in Settings" for account (`page.tsx:5893-5920`). A rejected shared key carries no `keyReject`.
22. Key entry lives in `ByoaKeySettings`, shown standalone at `/dashboard/settings` or as an overlay over the AI tab (`page.tsx:5805`). Two choices, default "Remember on this device" (`components/ByoaKeySettings.tsx:37`): device → localStorage (`:89`); account → `PUT /api/settings/byoa` → `set_user_secret` → Vault (`:94`). Saved keys show masked (`sk-ant-…abcd`); Remove per backend.
23. No route returns a stored key. `GET /api/settings/byoa` returns only `key_hint` (`app/api/settings/byoa/route.ts:45-61`); `user_secrets` has no client RLS policy at all (`015_user_secrets_vault.sql:22-23`); write errors are opaque (`route.ts:26-29`). Deleting the row deletes the Vault secret via trigger (`015_user_secrets_vault.sql:225-227`).
24. Chart convert and roadmap parse require sign-in but use the platform `CLAUDE_TRYIT_KEY` directly — no BYOA, no quota (`app/api/charts/convert/route.ts:174`, `app/api/charts/roadmap/parse/route.ts:49`).

**Offline / PWA**
25. Installable PWA: `start_url: '/'`, standalone, 192/512 icons (`app/manifest.ts`). The service worker is registered when a show page loads (`page.tsx:557`), not globally.
26. SW (`public/sw.js`): precaches `/` + PDF worker; on registration the page also sends the current URL and its loaded static assets to the worker to warm the cache (`lib/chart-cache.ts:247`, `sw.js:33`) — relevant when diagnosing an offline launch; `/_next/static/*` cache-first; page navigations network-first with fallback to the cached page, then cached `/`; `/api/*` never cached; `/api/chart-cache/*` served only from the chart cache.
27. Every viewer (owner or not) caches the show config in localStorage on load (`page.tsx:544-555`); a network error or 5xx falls back to it (`:469-487,505,590`); 4xx does not.
28. Every viewer auto-downloads all Supabase-hosted charts into Cache API `stageplot-charts-v1`, keyed `/api/chart-cache/{chartId}/{updated_at ms}` (`lib/chart-cache.ts:8-14`; `page.tsx:559-566`); Perform shows "Caching n/N" → "N charts cached" or "x of N cached" (`page.tsx:1106-1120`). The chart viewer reads cache first, then network, and writes back on fetch (`lib/pdf-viewer.ts:88-130`). A replaced chart gets a new key; old versions are deleted (`lib/chart-cache.ts:54-60`).
29. Launching the PWA offline at `/` redirects to the last-viewed show (`app/page.tsx:39-46`, `showrunr-last-show`). Chart viewer shows an "OFFLINE" pill (`page.tsx:3889`).
30. Owner edits write localStorage immediately and save to the server after a 2 s debounce; a failed fetch shows "you appear to be offline… will save on your next edit" (`lib/use-show.ts:110,153-163`). No auto-retry, no background sync.

### 3.2 Data & key files

- `profiles(id→auth.users CASCADE, owner_slug UNIQUE, display_name, created_at)`; RLS Public read `true` + Owner manage FOR ALL (`005`).
- `shows(id, slug, owner_id→auth.users NO ACTION, config jsonb, name, venue, show_date, setlist_migrated, …)`, `UNIQUE(owner_id,slug)`. `show_collaborators(show_id CASCADE, user_id→auth.users NO ACTION, email, invited_at, accepted_at, UNIQUE(show_id,email))`.
- `songs(owner_id CASCADE, song_key, title, key, lead, notes, artist, bpm 20–400)`; `setlist_entries(show_id CASCADE, song_id RESTRICT, position, *_override, scene_note)` — service-role only.
- `chart_library(owner_id NO ACTION, song_key, role, storage_path, … source_spec, source_prompt, source_notation)`; `chart_calibration(chart_id CASCADE, source_hash, status draft|verified, graph)`. Storage bucket `charts` is PUBLIC; path `{owner_id}/{song_key}/{role}.pdf` (`app/api/charts/upload/route.ts:53`).
- `tryit_quota(ip_hash, message_count, window_start)` + `increment_tryit`/`peek_tryit` (service-role). `user_secrets(user_id CASCADE, vault_secret_id UNIQUE, key_hint ≤20)` + `set/get/delete_user_secret`.
- Env: `PLATFORM_ADMIN_EMAIL`, `CLAUDE_TRYIT_KEY`, `GOOGLE_CLIENT_ID/SECRET`, `AGENT_MODEL_*` (default `claude-sonnet-4-6`), Supabase URL/anon/service-role. Config is env-only (`lib/admin-config.ts:31-43`).
- Modules: `middleware.ts`, `lib/admin-auth.ts`, `lib/agent-key.ts`, `lib/agent-availability.ts`, `lib/byoa-key-storage.ts`, `lib/chart-cache.ts`, `lib/use-show.ts`, `public/sw.js`, `components/ByoaKeySettings.tsx`.

### 3.3 Settled rulings (do not re-litigate)

- **One backend, Supabase; Redis retired** — "AI is purely a 'construction' mode NOT the 'show' mode" (single-backend §1).
- **Collaborators are view only**; no `editor`, no stored role. Any future song-lead delegate is ephemeral session state, never a column (single-backend §4.2; supabase-backend §Auth Model).
- **Link viewing is public by design** — no barrier to viral sharing; no signup allowlist (backlog-admin-identity, "Closed with PR #123").
- **Invites: any owner may invite anyone, no gate, native share sheet** — transport ruled, mechanism not designed (backlog-admin-identity).
- **Only the BYOA key is security-sensitive** (Graham's stated scope; backlog-admin-identity §2).
- **Device key beats account key** (ruling 2026-08-26, `lib/agent-key.ts:351`). Key is never readable back; Vault, not pgsodium.
- **Fixed, not sliding, 30-day try-it window**; one AI call = one try-it unit, no weighting (ai-key-availability §13.6 Q5).
- **Admin config is env + redeploy, no UI**; admin = one email, no `admin_users` table.
- **Email OTP, not magic links** (stays in-app; supabase-backend §Why Email OTP).
- **Google Drive is vestigial but kept** (ruled 2026-09-04; `/api/drive/*`, `/api/auth/google*` live).
- **PWA, not app store**; hand-written SW, no Workbox (strategy-pwa-commercial; alpha-ready).

### 3.4 Not built / partial

- Collaborator invite issuance (any writer of `show_collaborators`, invite UI, token vs email redemption) — backlog-admin-identity.
- Account deletion: `shows.owner_id`, `chart_library.owner_id`, `show_collaborators.user_id` are NO ACTION → `deleteUser` fails for any real owner; no endpoint; Storage orphan handling — backlog-admin-identity §1.
- `profiles` privacy (Public read) and admin rate-limit persistence — backlog-admin-identity §2-3.
- §13 single key resolver: BYOA + quota for convert/parse, `no_key` degrade reason, actionable parse copy — design-ai-key-availability §13.
- Fix for BYOA key surviving sign-out — issue #134.
- Handle rename / profile editing, owner public page `/{owner}`, vanity subdomains, QR/social links on profile — design-owner-namespacing Phase 2.
- Global SW registration, build-time asset manifest, SW cache of `/api/shows/*`, install prompt, "Offline — showing cached data" banner — design-alpha-ready Part 2.
- Explicit "Ready for Offline" action, cache eviction after show date, stale-cache prompt — backlog-offline-performer-cache.
- Offline conflict detection (`showrunr-last-saved-*` written at `lib/use-show.ts:123`, never read).
- Payments/subscriptions/trial/tier limits (Stripe) — design-payments; commercial half of strategy-pwa-commercial.
- BYOS / GitHub provider and .md-first charts — design-storage-notation Phases 2–3 (Phase 1 YAML import/export is built).
- Drive retirement — will not ship (ruled).

## 4. Charts — library, viewer, overlay (calibration), converter, measurement

**What it is.** Each owner keeps one chart library: PDFs filed by song title and part (guitar, keys, lyrics…). Any show whose setlist has that song picks the charts up automatically. In a show, performers flip through charts full-screen on a phone (swipe changes song, tap changes page). On top of a chart the owner can lay an "overlay": section labels, the lines of music, the bars within each line, and repeat/D.S./Coda signs. Once the owner verifies it, the overlay drives a red playhead and a bar-by-bar transport (the conductor builds on that). The app can draft the overlay itself, on the owner's request. It measures the PDF's own drawn lines and asks the AI for section names. The owner fixes what's wrong and signs it off.

### 4.1 Behaviour

**Library and upload**
1. A chart's identity is `(owner, normalized song title, role)`. Role is one of `guitar|lyrics|keys|bass|horns|drums|other`, and anything else becomes `other` (`003_chart_library.sql:16-29`, `lib/normalize.ts:41-45`). Uploading to a filled slot replaces it and keeps the same `chart_library.id` (`app/api/charts/upload/route.ts:96-113`).
2. Upload accepts PDFs only. The server checks the file's first bytes, not its name or claimed type, and rejects anything else with 400 "Charts must be PDF files" (`upload/route.ts:40-46`). It stores the file at `{owner}/{song_key}/{role}.pdf` as `application/pdf` (`:53,76,106`) and clears `source_spec/source_prompt/source_notation` (`:108-110`). The picker accepts `.pdf` only (`components/ManageChartsModal.tsx:19`).
3. Upload stores the file and stops. It never generates an overlay (`lib/chart-upload.ts:6-12,134-160`; `ManageChartsModal.tsx:88-91`).
4. Only the owner can write. Insert, update and delete are owner-only in RLS (`003:58-68`). Delete removes the DB row first, then the stored file (`app/api/charts/delete/route.ts:20-34`). Collaborators can read the owner's whole library, not just this show's songs (`003:46-56`).
5. Opening a show attaches charts fresh from the library by normalized title, using the service-role client, so no login is needed (`app/api/shows/[owner]/[show]/route.ts:97-136`). Shows store no chart data. Blank titles are skipped (`normalizeSongKeySafe`, `:98-100`).
6. One Manage-Charts modal serves both the library row and the setlist row (`app/library/page.tsx:233`, `P:6814`). Owners can add, replace, delete (with `confirm()`), and build with AI; preview and Share are in the same modal (`ManageChartsModal.tsx:178,244-246,319`). In a show, the setlist row that opens it is in the Config tab, which is owner-only (`P:749,830`; row `P:4932`, `ConfigTab` `P:6095`) — so a non-owner never reaches the modal from a show. The row's non-owner branch (Manage shown when charts exist, `P:4932`) is unreachable today.
7. Adding a library song to a show attaches its charts straight away and caches them for offline use, with no reload (`app/api/songs/route.ts:70-98`, `P:6790-6808`). Opening a show caches all of its library charts for every viewer (`P:557-567`). The manual "Download for offline" button appears only on Drive/anonymous shows (`P:6925-6926`). The Drive-era chart-wipe effect skips library-backed shows (`P:6209`).

**Viewer**
8. Charts render one page at a time on a canvas (pdf.js). Up to 5 parsed PDFs stay in memory, oldest out first (`lib/pdf-viewer.ts:38-45`). The file is fetched from the offline cache first, then the network (`pdf-viewer.ts:78-100`). The previous and next songs' first charts are prefetched (`P:3773-3782`).
9. Gestures: a tap on the right/left half of the page turns the page (no wrap). A horizontal swipe over 60px changes song. Movement locks to one direction after 10px, and taps on overlay controls are ignored (`P:3802-3846`). Keys: ←/→ song, ↑/↓ page, Esc closes (`P:3792-3796`).
10. The part filter is remembered per show for the browser session (`P:1012-1026`). If no chart matches, the viewer says "No {role} chart for this song" (`P:3978-3982`). A legacy non-PDF chart shows "This chart is an image…" plus a link to open it (`P:3984-3990`).

**Overlay (calibration)**
11. An overlay is stored per `(chart_id, source_hash)`, where the hash is the SHA-256 of the exact PDF bytes the viewer loaded (`008_chart_calibration.sql:8-17`, `P:3711-3720`). It applies only to those exact bytes. A replaced file gets a new hash and starts with no overlay. Old rows are kept.
12. Overlay GET (`app/api/charts/calibration/route.ts:71-132`): the chart's owner gets any row, drafts included. Everyone else, including signed-in collaborators, gets the row only if it is performable (verified, and `canVerify` passes). Otherwise they get 404. A stored row this build can't read returns 409 to the owner and 404 to anyone else (`CC:251-264`).
13. An overlay can be verified only when it has at least one section, every section is labeled, and its repeat/jump roadmap (if any) plays through cleanly (`CC:157-170`). The server rejects a dishonest `verified` PUT with the specific reason (`calibration/route.ts:177-184`). The roadmap is checked at verify time only, so drafts save even when they don't resolve.
14. Perform shows the overlay only when it is performable. The bar transport and conductor need performable **and** at least one bar (`P:3079-3084,3350`). Any edit puts the overlay back to `draft`, and Verify must be done again.
15. Only the owner can edit (`calibratable = isOwner && library chart`, `P:3052-3060`). Saving is blocked unless `isOwner` (`P:3540-3545`). The PUT is an owner-only upsert (`calibration/route.ts:143-225`).
16. Calibrate has three tools: Sections, Bars, Roadmap (`P:4063-4074`).
    - Sections: tap the page to drop one, tap a pill to label it.
    - Bars: drop a line ("system"), drag its top and bottom edges, use the −/+ bar count (spaces bars evenly and wipes earlier nudges, `CC:496-540`), drag a barline tick (`moveBarBoundary`, `CC:557`), "＋ Add barline" splits the bar under a tap (`CC:813`), tapping a tick then "✕ Remove barline (−N markers)" merges two bars and shows how many roadmap markers it will drop (`CC:772`, `P:4165-4186`), and "⌗ Snap to lines" (`lib/chart-snap.ts:163`, `P:4135-4158`) moves positions only, never the count, and reports "N snapped, M need a nudge / found X, expected Y — adjust count".
    - Roadmap: places markers and shows "plays: …" live (`P:2644`).
17. Bar edits keep bars at least `MIN_BAR_W = 0.01` wide and never let a barline cross its neighbour (`CC:544`). A perform tap in the margin before bar 1 or after the last bar selects nothing, apart from a 0.01 grace zone (`tapToBar`, `CC:862-905`).
18. Adding or removing a barline remaps roadmap markers by position. Adding drops nothing. Removing drops only markers that sat on the removed line, plus any conflict that edit itself caused, and only if the roadmap resolved before the edit (`CC:772-860`).
19. Repeats and jumps are stored as the printed signs (`|:`, `:|`, voltas, segno, coda, To Coda, Fine, D.C./D.S.), each bound to a bar edge. A pure resolver works out the play order. Perform steps through that order and shows "· 2nd" on repeat passes (`lib/types.ts:187-210`, `CC:974`, `P:4402`). At most one segno, coda and fine are allowed.
20. Overlay schema: a row is stored as version 3 only when it has a roadmap, otherwise version 2. PUT accepts versions 1, 2 and 3. A row from a newer schema is refused (`calibration/route.ts:21-24,168-173,109`).
21. Perform without bars: a quick tap on a section label jumps there, and a ≥450ms long-press "holds" it. Both just park the playhead, with "At / Holding {label} · clear" (`P:1923,1952-1963,4470-4480`).

**Readiness strip and on-demand overlay build**
22. When there's no bar transport, the Perform view shows one line explaining why and one next step (`components/PerformReadinessStrip.tsx:77-164`, mounted `P:4438`). Non-owners only ever see "Tap a section to seek." or nothing.
23. "Build overlay" on the strip is the only in-show way to convert an **uploaded PDF** into an overlay (`P:3578-3646`). Two other paths write overlay rows: saving a builder chart ("Build a chart with AI" in Manage Charts, `ManageChartsModal.tsx:313,350`) writes its overlay in the same transaction as the chart (`supabase/migrations/017_builder_source_notation.sql:108`), and the platform-admin backfill (`app/api/admin/backfill-chart-overlays/route.ts:69,81`) converts uploaded PDFs under the same never-gate.
    - The chart must have no overlay for these bytes and must not be a known-never chart: a builder chart ("Built in ShowRunr…") or role `lyrics` ("Lyrics sheet…"). The same rule is checked on the client and on the server (`lib/chart-converter.ts:74-81`, `convert/route.ts:108-112`).
    - The browser measures the PDF (`lib/chart-measure-client.ts:88-122`) and POSTs it to `/api/charts/convert`. The server re-hashes the stored file and returns 409 if the hash doesn't match. The client then clears both caches, re-measures once, and gives up after a second mismatch.
    - If the PDF has no staves on any page and the drawing was fully readable, the strip shows "No staves found on any page…" with no retry (`convert/route.ts:167`).
    - The server always calls the AI for section labels. It keeps the measured bars only when the AI found no roadmap; otherwise it keeps the AI's estimated bars (`convert/route.ts:223-227`).
    - The insert never overwrites (`ON CONFLICT DO NOTHING`, `:238-260`). `exists` is not treated as a failure: the client refetches the overlay for its own hash (`lib/chart-upload.ts:81-85`).
24. Convert limits: 15 MB, PDF-only, 50 s AI timeout inside a 60 s route. Any failure returns a typed reason and writes nothing (`chart-converter.ts:17`, `chart-vision.ts:7`, `convert/route.ts:25,126-204`).
25. Review queue (calibrate toolbar): "⚑ N to review ‹ ›" steps through flagged items. "✓ Reviewed" appears only once a flagged draft has been cleared (`P:4205-4231`). It never blocks Verify.
    - A section or roadmap marker is flagged when its AI confidence is below 0.8, or the marker is in a resolve error.
    - A line (system) that has a measurement verdict is flagged only if the verdict is `uncertain`. A line without one uses the confidence roll-up (`lib/chart-review.ts:28,51-80`).
26. Any hand edit to a line's geometry or its bars sets that line's verdict to `edited`, including Snap, which goes through `moveBarBoundary` (`CC:90,429,533,617,801,849`). `confirmed`/`edited` are valid verdicts (`CC:1045-1059`). Verdicts are checked against the enum at the DB boundary (`CC:1063-1080`).

### 4.2 Data & key files

- **Tables:** `chart_library` (003, plus `source_spec` 009, `source_prompt` 016, `source_notation` 017) and `chart_calibration(chart_id FK cascade, source_hash, schema_version, status draft|verified, graph jsonb)` with PK `(chart_id, source_hash)` (008). Storage bucket `charts`, public read.
- **Graph types** (`lib/types.ts:82-224`): `SectionAnchor`, `System{verdict?}`, `Bar{absNumber dense 1..n, measures?}`, `RoadmapMarker`, `ChartCalibration`. `confidence` is optional on every element and cleared on hand edit.
- **Routes:** `POST /api/charts/upload` · `DELETE /api/charts/delete` · `GET|PUT /api/charts/calibration` · `POST /api/charts/convert` · `POST /api/admin/backfill-chart-overlays` (platform-admin, AI-only, idempotent).
- **Modules:**
  - `lib/chart-calibration.ts`: model, editing helpers, verify, readiness.
  - `lib/roadmap-vm.ts`: play-order resolver.
  - `lib/chart-review.ts`, `lib/chart-snap.ts`.
  - `lib/chart-measure*.ts`: measurement engine (`RENDER_SCALE = 3`).
  - `lib/chart-measured.ts`: payload, whole-chart disposition, `installMeasured`.
  - `lib/chart-resegment.ts`: count→split re-segmenter; on main, with no UI caller yet.
  - `lib/chart-converter.ts`, `lib/chart-vision.ts`, `lib/chart-upload.ts`, `lib/pdf-viewer.ts`, `lib/chart-cache.ts`.
  - UI: `components/ManageChartsModal.tsx`, `components/PerformReadinessStrip.tsx`, and `ChartNavigator` in `P:2797+`.
- **Harness:** `scripts/chart-measure-acceptance.ts`, run locally against the private corpus. Baseline 464/464, 550 staves, 3044 spans, PARITY clean.

### 4.3 Settled rulings

- **Generate once, never overwrite.** The machine writes an overlay only if no row exists for these bytes, and never re-runs on the same bytes. Hand edits are never overwritten (converter §Core guarantee; review-step §Persistence).
- **Hash rule.** Both sides hash the exact fetched bytes, and an overlay never applies to bytes it wasn't built for (converter §Hash rule; measurement §split contract).
- **Lazy conversion** (Graham 2026-09-02): "Upload stores bytes and stops." Conversion runs only when the owner asks. Lyrics and builder charts, plus a measured zero-staves backstop, are never sent to the AI (backlog §Ruled 2026-09-02).
- **Measuring is the client's job; the server commits and pays.** The browser measures and never writes or holds keys. Convert is the only insert-only writer. The engine must not use the PUT (measurement §split contract).
- **Measurement replaces the AI's geometry, not its meaning.** The AI still supplies section labels. A chart with a printed roadmap keeps the AI's bars until rebinding is built (measurement §section gap / roadmap).
- **Multirests stay one visible bar.** `measures` counts the bars of rest, and `absNumber` is bar identity, never the musical bar number (measurement §Multirests, Graham 2026-09-02). Measure numbers count written bars, not played ones (backlog §Not defects).
- **Review is guidance, never a wall.** The machine verdict decides whether we *ask*, not whether the owner can open the review sheet (review-step §Principles; Amendment 2026-09-06).
- **Roadmap:** printed markers plus a resolver (not a hand-built graph), explicit `repeatStartId`, one segno/coda/fine, play order recomputed on load, v3 stored only when a roadmap exists (nav-graph §11).
- **Overlay editing:** shared-boundary barline drag. Snap is treated as a manual edit (option A) and never changes the count. The count stepper is a deliberate "reset this line". Removing a barline drops only what it must (barline docs; cv-snap §Decisions).
- **Google Drive stays**, as vestigial code. Do not re-derive the retirement plan (backlog §Drive stays, 2026-09-04).
- **Per-key variants** use duplicate-with-edit (the title carries the variant). No schema change (library-chart-management).

### 4.4 Not built / partial

- `lib/chart-resegment.ts` (count → split re-segmenter, #183) has no UI caller; the C3 sheet is its consumer.
- **C3 review sheet** ("Which split looks right?", count fallback, "Check this line", "N lines uncertain" chip, "estimated" badge, re-deriving `measures`, writing `confirmed`): **not on main**. `components/ChartReviewSheet.tsx`, `components/ChartSystemStrip.tsx` and `lib/chart-review-sheet.ts` exist only on `opus/chunk-c3-review-sheet` (PR #184) (review-step §C3/§C4).
- Per-system AI fallback for `uncertain`, the `corroborated`/`estimated` verdict writers, roadmap ordinal rebinding, and text-layer section detection are deferred (measurement §Scope ruling).
- Multi-role chart overrides (`chartOverrides`/`sourceRole`) (role-overrides).
- From realtime-chart-control: the temporal layer inside the overlay (`beatsPerBar`, `holdPoints`), scrub/play verify, a "LOOPING" hold state with haptics, auto-carrying the old file's overlay onto a replacement, disabling a jump as a hold point, copying one line's layout to another, and "Snap all".
- Bulk/drop-zone upload and role auto-detect from filename; tapping a setlist-row chart pill to open it, since the pills are plain labels (`P:4925-4928`) (chart-library §Upload UX).
- Per-reason convert copy (`too_large` / `unsupported_type`): all failures read "Couldn't build an overlay for this chart." (`PerformReadinessStrip.tsx:136`) (converter §Execution model).
- An override for the measured never-gate (role is identity, so correcting it is a move between slots).

## 5. Chart builder — native charts + AI text-to-chart

**What it is.** An owner describes a song in plain English ("4/4 in G, Verse: 2 bars D, 2 bars G7 …") and
ShowRunr builds a clean Nashville-number chart from it. The owner can then fix it by hand (click a bar to
type chords, add/remove/reorder sections, change key, flip Numbers ⇄ Letters) or re-describe it and
regenerate. Saving produces an ordinary PDF chart in the song's library slot, plus an exact bar map, so
it works everywhere an uploaded chart does (show viewer, offline, Perform, conductor) with no review step.
The saved chart can be re-opened and edited later.

### 5.1 Behaviour

**Source of truth & validation**
1. The authored `RoadmapSpec` (time sig, `renderKey`, optional `barsPerLine`, ordered sections with bar counts, sparse chord changes, optional section repeat, optional navigation) is the source of truth; the PDF and calibration are derived from it. `lib/roadmap-spec.ts:19-87`
2. `validateRoadmapSpec` is the boundary gate and fails closed on: version ≠ 1, beats ∉ 1..32, unit ∉ {1,2,4,8,16}, key not `^[A-G](#|b)?m?$`, `barsPerLine` ∉ 1..16, empty sections, duplicate/blank ids or labels, bars < 1, change bar out of range or duplicated, degree/bass ∉ 1..7, `alter` ∉ {-1,0,1}, quality off the whitelist, split-bar beats not all-or-none / not summing / not dividing evenly. `lib/roadmap-spec.ts:165-340`
3. Quality whitelist is exactly `'' m dim aug sus sus2 sus4 7 maj7 m7 m7b5 dim7 6 m6` (no `7sus2`, `9`, `13`, alt). `lib/roadmap-spec.ts:102-114`
4. Plain repeat needs `times ≥ 2` and section ≥ 2 bars; volta needs ≥ 2 endings, `start > 1`, in-range, non-overlapping, passes partitioning 1..max. Navigation: every ref resolves; toCoda ⇒ coda; D.S. ⇒ segno; al Coda ⇒ coda+toCoda; al Fine ⇒ fine. `lib/roadmap-spec.ts:348-496`
5. A chromatic root is `{degree, alter:±1}` and prints ♭/♯ before the number; a chromatic slash **bass** is rejected, never downgraded (`1/b2` → error). `lib/roadmap-view.ts:126-150`, `lib/roadmap-view.ts:462-506`

**AI parse (description → spec)** — `POST /api/charts/roadmap/parse`, authed, never writes
6. Description required, ≤ 8,000 chars; no platform key → 503 "Parser is not configured" (checked *before* the no-AI grammar path, so even grammar-clean text needs a key); model failure/timeout (50 s) → 502. `app/api/charts/roadmap/parse/route.ts:39-73`
7. Key resolution (L0), in order: Review-toolbar key (override) → key stated in the prose ("in Bb", "key of F sharp", "D minor") → Compose "Key" selector → `C`. `lib/roadmap-authoring.ts:378-389`
8. L1 deterministic grammar is tried first: optional `Label:` headers, clauses split on `, ; . newline then`, each clause `N bars [of] CHORD` / `CHORD for N bars` / bare `CHORD` (= 1 bar). Any unparseable clause → whole description falls to the model. Multi-chord bars are accepted only with an explicit `-` tie. L1 always assumes 4/4. `lib/roadmap-authoring.ts:465-581`, `lib/roadmap-parse.ts:226-231`
9. L2 model **transcribes** into a per-span draft (one span per contiguous region, no invented repeats); our code folds it into the sparse spec; the validator disposes. Model is `AGENT_MODEL_ROADMAP` via the admin `claude_tryit_key`. `lib/roadmap-parse.ts:35-85,148-189`, `parse/route.ts:49`
10. Every parse returns a per-section read-back tally ("Verse: 16 bars — D×2, G7×2 …") shown on Compose and Review, even when the spec is invalid. The tally counts spans only and ignores repeat/splice ops. `lib/roadmap-authoring.ts:407-416`, `components/RoadmapBuilder.tsx:754-770`
11. Invalid result = HTTP 200 `{ok:false, errors}`; the UI lists up to 6 errors and keeps the user's text. `components/RoadmapBuilder.tsx:92-115`

**Builder UI** — `components/RoadmapBuilder.tsx`, full-screen overlay
12. Entry (owner only, only when the song has a free role): "Build chart" on a Library song row, or "Build a chart with AI" in Manage Charts (library + show). `app/library/page.tsx:280,313-318`, `components/ManageChartsModal.tsx:313-320`
13. Compose → Review. Review is three panes on desktop (refine | chart | structure), stacked on phone. There is no path to Review without a successful parse. `RoadmapBuilder.tsx:216-243,492`
14. Chord entry = click a bar on the chart → inline input (grammar `1`, `IV`, `5 4`, `1 - 4 5`, letters like `G7` in key context) with a live split preview; Enter/blur commits a valid parse, Esc cancels, empty input clears the bar to "inherits previous". Bars show pointer cursor + blue hover and an empty bar shows ＋ on hover. `RoadmapBuilder.tsx:960-1080`
15. Structure panel: drag to reorder, rename, edit bar count (min 1; shrinking truncates chords), remove (✕, no confirm), `+ Add section` (4 empty bars). Repeats and nav markers are **read-only** badges/chips. `RoadmapBuilder.tsx:375-400,555-590,691-750`
16. Toolbar: Numbers ⇄ Letters toggle and a key picker (24 keys + any off-menu current key). Changing key in numbers mode changes only the key label. `RoadmapBuilder.tsx:780-818`, `lib/roadmap-spec.ts:142-148`
17. Preview is fit-to-width: bars/line = spec value if set, else 2 (< 480 px), 4 (< 700 px), 8; constant bar width, partial last line left-aligned, never horizontal scroll; each line shows its first bar's global number. `RoadmapBuilder.tsx:840-958`, `lib/roadmap-layout.ts:41-86`
18. Regenerate (refine rail) re-parses the whole description and **replaces** the chart after a confirm "Regenerate will replace your manual edits"; disabled while the box is empty. `RoadmapBuilder.tsx:162-196,241,502-509`
19. Removing a section that a nav marker points at drops the **whole** navigation block silently. `lib/roadmap-view.ts:308-330`

**Save** — `POST /api/charts/roadmap/save`
20. Server re-validates (400 + details), renders, asserts spec↔calibration parity (500), gates `isValidCalibration`/`canVerify` (500), stores PDF at `owner/songKey/role/<sha>.pdf`, then one atomic RPC writes chart row + `verified` calibration; old PDF best-effort deleted. Never triggers the converter. `save/route.ts:67-207`, `supabase/migrations/017_builder_source_notation.sql:31-121`
21. Fresh build picks a free role; Edit locks the role and sends `expected_chart_id/updated_at`; a slot changed since opening → 409 "This chart changed since you opened it — reload". `RoadmapBuilder.tsx:420-455,596-640`, `017:67-87`
22. Save persists the refine-box text verbatim (blank → null) and the toggle's notation; the PDF is baked in that notation. `save/route.ts:89-113`
23. Artist on the PDF comes from the `songs` row at save time; title from the request. `save/route.ts:104-113`

**Rendered PDF** — `lib/roadmap-render.ts`, US Letter, Helvetica, vector music glyphs, deterministic bytes
24. Header at top: title (18 bold), artist (11), then `Nashville (authored in X)` in numbers mode or `Key of X` in letters mode. `roadmap-render.ts:243-256`
25. Default 4 bars/line (or `spec.barsPerLine`), each section starts a new line, constant bar width, page break when a system won't fit; line-start bar number in the left gutter (omitted if it would leave the page). `lib/roadmap-layout.ts:138-229`, `roadmap-render.ts:258-293`
26. Every bar has a 1-slash-per-beat rhythm strip (held beats suppressed); chords sparse; split bars with ticks; held = diamond; repeat dots, ×N when N > 2, volta brackets, Segno / ⊕ Coda / To Coda / Fine / D.S.·D.C. [al Fine/al Coda], stacked so they don't overprint. `roadmap-render.ts:306-440`

**Re-open & show display**
27. Builder rows in Manage Charts show Preview · Share · **Edit** · **Replace with file** · Delete; uploaded rows show no Edit and "Replace". `ManageChartsModal.tsx:241-275`
28. `GET /api/charts/roadmap/[chartId]`: owner-only (404 for not-found *and* not-owned), 422 if no spec or invalid spec; returns spec, prompt, notation, `updated_at`. Builder opens straight into Review with refine box + toggle pre-filled. `app/api/charts/roadmap/[chartId]/route.ts:17-72`, `ManageChartsModal.tsx:127-157`
29. Replace-with-file nulls `source_spec`, `source_prompt`, `source_notation` (row stops being a builder chart). `app/api/charts/upload/route.ts:90-110`
30. Show/song payloads carry `is_builder`, `authored_key`, `notation`, `charted_key:null`. Show navigator key pill: numbers chart → `song.key || authored_key` (live setlist override); letters chart → `authored_key` only. Library preview pill → `authored_key`. `app/api/shows/[owner]/[show]/route.ts:119-132`, `app/[owner]/[show]/page.tsx:3874-3885`, `ManageChartsModal.tsx:411-416`

### 5.2 Data & key files

- `chart_library.source_spec jsonb` (009), `source_prompt text` (016), `source_notation text check in ('numbers','letters')` (017); `is_builder` = `source_spec IS NOT NULL`. RPC `save_builder_chart` (17 args, `FOR UPDATE` slot lock, PT409, service_role only).
- `chart_calibration (chart_id, source_hash)` row written `verified` by the RPC.
- Pure libs: `roadmap-spec.ts` (model+validator) · `roadmap-authoring.ts` (key L0, grammar L1, fold L3, tally L4) · `roadmap-parse.ts` (model transport) · `roadmap-view.ts` (editor bridge, chord grammar, letters) · `roadmap-layout.ts` (shared layout, pdf-lib-free) · `roadmap-render.ts` (PDF+calibration) · `roadmap-rhythm.ts` (slash rule) · `roadmap-save.ts` (parity).
- Routes: `/api/charts/roadmap/parse` · `/save` · `/[chartId]` (GET). UI: `components/RoadmapBuilder.tsx`, `components/ManageChartsModal.tsx`, `app/library/page.tsx`. Stub prototype: `app/mockup/roadmap-builder/page.tsx`.

### 5.3 Settled rulings

- Builder is an **additional** path to the PDF importer, not a replacement; substrate is a rendered PDF, not a second viewer. (builder §Decisions 1)
- AI is copilot: "the model proposes, the validator disposes"; builder charts are born `verified` but still pass the server gate. (builder #3, #5)
- Model transcribes, code compresses; never infer a repeat the author didn't state. (authoring-fidelity §3)
- Key: `songs.key` and `renderKey` stay independent; numbers charts relabel live, never transpose (Option A only). (key-resolution §10)
- One PDF per chart, baked in the saved notation; change notation by re-saving. No per-show notation. (notation-toggle)
- Regenerate is dump-and-replace; stored prompt is a seed saved verbatim, not a mirror of the chart; collaborator-readable prompt accepted. (prompt-persistence §2, §5c, §8)
- Review-toolbar key outranks a key in the prose; Compose selector does not (Graham 2026-08-28). (`roadmap-authoring.ts:366-377`)
- Letter spelling: one name per pitch class (F# major's 7th prints F, not E#) — accepted. (`roadmap-view.ts:416-422`)
- Fit-to-width {2,4,8}, explicit `barsPerLine` wins on both surfaces; preview and PDF may wrap differently by design. (fit-to-width §6, line-measure §3.3)
- Song-form-from-lyrics: lyrics never go on the roadmap; L0→L1 chords are typed, never AI-inferred. (song-form §8)

### 5.4 Not built / partial

- Gap 2 mid-song key change (`keyShift`). — expressiveness
- Print/download "in key X" re-render export (`/api/charts/roadmap/export`). — key-resolution §6.1
- "Charted in X" note for uploaded charts (`charted_key` always null). — key-resolution Q3
- Diff-aware regenerate (prior spec + correction) and scoped AI patches with diff highlight; Regenerate is cold full-replace. — authoring-fidelity §8 / 5c, builder §UI "Option A"
- Manual editing of repeats, voltas, nav markers, time signature, or artist; markers are read-only. — builder §UI
- Duplicate-a-builder-chart cloning the spec (key variant). — builder §UX
- Held (diamond) in the preview, and held via the bar grammar (retyping a held bar drops it). — edit-loop §6, prompt-persistence §11
- Op-aware read-back tally (repeats not reflected). — fit-to-width §7, song-form §6.4
- Orphaned-PDF garbage collection (no GC job exists; failed/replaced objects linger). — builder §Save
- Bundled embedded font (renderer uses StandardFonts Helvetica instead). — builder Open Q1
- Pickup/anacrusis measure numbering. — line-measure §1
- Entire song-form-from-lyrics pipeline (no lyrics parser, no `timeSigSource`, no proposal record). — song-form
- Issue #173 chord-entry discoverability on touch/empty charts (see Discrepancies).

## 6. Conductor (one device leads, everyone follows) + the cloud relay

**What it is.** One band member's phone becomes the conductor: it moves the red "you are here"
bar line through the chart (by tap, or by a fixed-tempo clock) and makes live calls such as "to
the Coda", "another round", "vamp", "back to the chorus". Everyone else who joins the room by QR
code or 6-letter code sees their redline and page turns follow the conductor's. Connections go
through a small always-on server at `relay.showrunr.ai`, so the venue needs working internet.
Without it, each phone can still be driven on its own. Today every follower must have **the
same chart file with the same bar map** as the conductor. Following a different part (for
example a horn chart following the piano chart) is not built.

### 6.1 Behaviour

*Local conducting (one device)*
1. Anyone viewing a chart that has a performable bar map sees **Conduct** in the bar transport.
   There is no owner gate (`app/[owner]/[show]/page.tsx:4417-4424`). Conducting needs bar-level
   calibration (`barMode`, `page.tsx:3369`). Without it the readiness strip shows instead
   (`page.tsx:4435-4446`).
2. A session belongs to one chart in one show: `sessionId = <chartFileId>::<owner>/<slug>`,
   `songRef = chartFileId` (`page.tsx:3373-3374`). It always starts unarmed at the song head
   with no tempo (`lib/conductor-session.ts:39-59`).
3. **Advance** steps to the next bar the roadmap actually plays, following repeats, voltas,
   D.S./D.C., Coda and Fine (`conductor-state.ts:216-219`). Advance and Arm are disabled at song
   end (`page.tsx` cluster `canAdvance={!conductor.done}`).
4. The conductor's page follows the redline in the same frame, with no lagging page turn
   (`lib/chart-calibration.ts:923-929`). While a session drives, tapping the chart does nothing
   (`page.tsx:3512`).
5. **Arm change…** lists jump targets in this order: Coda, Segno, Fine, section heads (numbered
   only when a label repeats, e.g. "Chorus 2"), repeat starts, then plain bars
   (`lib/conductor-targets.ts:90-136`). "al Coda" / "al Fine" appear only when a To-Coda / Fine
   exists at or after the target (`:45-62`).
6. The change fires at **Next bar** (the next bar actually played) or **Next section**. Next
   section is disabled when no section head lies ahead (`conductor-targets.ts:200-265`;
   `ConductorCluster.tsx:276-301`).
7. Arming re-checks the target from scratch. An unknown, ambiguous or stale target is ignored
   (`conductor-targets.ts:368-393`).
8. **Insert-and-return.** Calling a section *behind* you with no al-Coda/al-Fine plays it once,
   then returns to the section that would have come next. This applies to section heads only,
   and only when both the target and current sections are contiguous. In every other case the
   jump just continues from the target (`conductor-targets.ts:275-314`; `lib/roadmap-vm.ts:394-404`).
9. **Go** commits the armed change: it jumps and lands on a real bar in one step. **Cancel**
   disarms it (`conductor-state.ts:230-245`).
10. Immediate redirects appear only when they would change something: Another round, Vamp
    (hold), Release vamp, Re-arm jump (`conductor-targets.ts:170-193`).
11. **Auto-fire** is opt-in and off by default (`use-conductor-session.ts:253`). When on, the
    armed change fires as the playhead *arrives* on the fire bar, never while a vamp is held
    (`conductor-session.ts:166-173`). A Release that frees a hold parked on the fire bar also
    fires it. An arrival placed by the clock fires only within 8 bars of the last human anchor
    (`conductor-clock.ts:149-168`; `use-conductor-session.ts:821-824`).
12. **Clock** is opt-in and off by default. It needs the song's stated BPM, and always assumes
    4/4 (`page.tsx:3378-3379`; `use-conductor-session.ts:231`). It moves at most one bar per
    80 ms tick (`:72`, `:851-892`). If it falls 2 or more bars behind (for example after the
    tab slept), it **pauses** and shows "Clock paused — tap 'On the 1' to catch up" instead of
    jumping ahead (`:876-881`; `ConductorCluster.tsx:364-368`).
13. **On the 1** starts bar 1 at the top of the song. Mid-song it re-zeroes the clock's timing
    on the current bar without moving it and without sending anything (`use-conductor-session.ts:1014-1025`).
14. A tap the reducer refuses shows "Not available right now" (`ConductorCluster.tsx:423-425`).
15. **Detection (mic)** is a shadow readout only: it shows stated vs detected BPM plus a
    confidence %, labelled "measuring only — doesn't drive the chart yet", and keeps a copyable
    log of up to 600 rows (`ConductorCluster.tsx:373-421`; `use-conductor-session.ts:141`).
    Audio stays on the device. Leaving conductor mode releases the mic (`:700`).
16. The song owner can set a song's BPM from the in-show setlist editor (library-linked songs
    only), with the hint "sets this song's tempo everywhere" (`page.tsx:4872`, `:4954-4956`,
    `:705-735`).

*Rooms (relay)*
17. Room features exist only when `NEXT_PUBLIC_RELAY_URL` is set (`page.tsx:2874`). **Go live**
    asks for a name once per device (stored in localStorage, `lib/relay-join.ts:53-69`). The
    relay creates the room and picks a 6-character code from an alphabet with no 0/O/1/I
    (`relay/relay-core.ts:157-158, 362-410`). The QR encodes `<origin>/<owner>/<slug>?join=CODE`
    (`relay-join.ts:28-30`).
18. Go-live claims the baton automatically, once per go-live (`page.tsx:3407-3417`). After that,
    a claim only happens when someone taps for it.
19. Opening a `?join=CODE` link opens the first song that has charts and auto-joins the room
    (with the stored name, or after asking for one) (`page.tsx:1036-1058`, `:2891-2908`). The
    **Join** button with a typed code does the same (`page.tsx:4425-4432`). A code for a room
    that does not exist gets "Room not found — it may have ended." and retrying stops
    (`use-conductor-session.ts:606-612`; `page.tsx:4351-4360`).
20. A follower's redline is driven only by the room. It has no transport controls and chart
    taps do nothing (`use-conductor-session.ts:419-420`; `page.tsx:3402, 3512`). The follower
    strip shows, in this priority order: Joining the room… → Conductor lost (with a **Take the
    baton** button and an in-place confirm) → "waiting for a conductor" (with **Conduct from
    here**) → "The room is playing <song> — not on this device" → "<name> is conducting" plus
    the bar readout (`components/RelayStrip.tsx`).
21. A follower mirrors only when its chart's identity matches the room's exactly: session id,
    chart file id and a hash of the bar map plus roadmap (`lib/relay-binding.ts:115-116, 189-196`;
    `conductor-state.ts:153-157`). When the conductor changes chart, followers auto-open that
    exact chart file, matched by file id (`page.tsx:3426-3452`; `relay-join.ts:38-48`).
22. Only one device conducts at a time. The relay grants the baton only when nobody holds it.
    A second claim is denied (`relay-core.ts:247-274`). Only the conductor's messages reach
    followers (`:288-294`).
23. If the conductor closes the connection, the room is orphaned **instantly**. If it stops
    sending heartbeats, the room is orphaned after 6 s (heartbeat every 2 s, 3 misses;
    `relay-core.ts:149-150, 457-470`; the client heartbeat is every 1 s,
    `use-conductor-session.ts:145`). Every member then sees "Conductor lost".
24. **Exit** in the cluster releases the baton but stays in the room as a follower. **Leave**
    releases it and disconnects (`page.tsx:4334-4339`, `:3468-3473`).
25. Followers recover missed messages by pulling a full snapshot from the conductor. A
    snapshot from the live conductor always wins; an old cached copy only moves state forward
    (`relay-binding.ts:155-161`).
26. When a drop is not a "room gone" case, the client reconnects with jittered backoff of
    0.75–10 s (`use-conductor-session.ts:150-158, 618`). If the creator's room has died, the
    reconnect quietly **creates a new code** (`:613-617`).
27. Rooms that never got a conductor are deleted after 15 minutes. Empty rooms are deleted
    after 24 hours. The relay holds at most 500 rooms (`relay-core.ts:151-153, 474-485`).

*Relay service*
28. `GET /healthz` returns `200 ok` and every other path returns 404 (`relay/server.ts:281-289`).
    Only the origins `https://showrunr.ai` and `https://www.showrunr.ai` are allowed. A request
    with no Origin header is allowed; an unlisted Origin gets close 4005 (`fly.toml` `[env]`;
    `server.ts:296-301`).
29. Rate limits: hello 10/min per IP (burst 20), create 3/min per IP (burst 5), 30 frames/s per
    connection, 20 connections per IP (`relay/limits.ts:65-68`). Frame size limits: 1 KB before
    joining, 8 KB for followers, 1 MB for the conductor (`server.ts:81-83`).
30. Baton numbers (epochs) come from one global counter that never goes backwards. The counter
    is written to disk with fsync **before** a grant is acknowledged (`relay-core.ts:253-273`;
    `server.ts:133-154, 228-235`). Exactly one machine runs, and deploys stop the old machine
    before starting the new one (`fly.toml` `[deploy] strategy="immediate"`).

### 6.2 Data & key files

- No database tables. Live state is never persisted: rooms live in relay memory, plus a journal
  file on the Fly volume (`/data/relay-journal.json`) holding `{v:2, clean, counter, rooms[]}`
  (`server.ts:102-128`).
- Song tempo source: `songs.bpm` (migration 012), read through as `SetlistSong.bpm`.
- Pure core: `lib/conductor-state.ts` (reducer), `conductor-session.ts` (dispatch/baton/auto-fire),
  `conductor-targets.ts` (targets/redirects/insert-return), `conductor-clock.ts` (position trust,
  rungs, confidence), `lib/roadmap-vm.ts` (stepping engine).
- Wiring: `lib/use-conductor-session.ts` (the hook), `lib/relay-protocol.ts` (frames + client
  state machine), `lib/relay-binding.ts`, `lib/relay-join.ts`, `lib/tempo-detect.ts` /
  `tempo-telemetry.ts` / `use-tempo-detector.ts`.
- UI: `components/ConductorCluster.tsx`, `RelayStrip.tsx`, `RelayQrOverlay.tsx`; the bottom
  transport slot in `app/[owner]/[show]/page.tsx:4253-4460`.
- Relay: `relay/relay-core.ts` (pure), `server.ts` (ws + limits + journal), `start.ts` (env),
  `Dockerfile`, root `fly.toml` (app `showrunr-relay`, region sjc, shared-cpu-1x 256 MB).

### 6.3 Settled rulings (do not re-litigate)

- **Single writer.** Only the conductor issues sequence numbers. Followers never commit a change
  themselves. Baton numbers come from the relay (authority §4, 3b §4).
- **Every failure degrades to self-driving, never to a wrong position.** A follower whose chart
  doesn't match gets an honest banner, never a guess (3b §7, authority §2.2.0). **Not yet true
  for conductor loss:** the follower stays session-driven and its chart taps are ignored
  (`page.tsx:3402, 3512`) — see Appendix A.
- **Any joined device may claim the baton, behind a confirm.** "Owner ≠ conductor" (3b D4; owner
  gate dropped in 3b chunk 5).
- Session identity is the full triple {sessionId, songRef, programHash}. A recalibration mid-song
  counts as a new session (3b §4.4).
- A cloud relay is the only deployment. Exactly one instance; no local-box hardware for
  musicians (relay-cloud §0, D1). A dead venue network means no togetherness; the fix is a
  native app, never a hardware kit (relay-cloud §8 Q5). WebRTC hybrid declined for v1 (§9.4).
- Clock owns speed, the MD owns place. The Go tap is the floor. Auto-fire is a luxury that needs
  confidence (5b-clock; authority §3.5).
- Section calls going backward insert and return. Forward calls continue from the target.
  Return only for section targets (insert-return D1, D9). `exit` and `return` are mutually
  exclusive (D10).
- In-show BPM edits write the song row, so they apply in every show. Owner-only. No per-show
  tempo (ux-polish §3, Q2–Q4).
- Live performance state is never written back to calibration or song structure (authority §7).

### 6.4 Not built / partial

- Canonical `SongStructure` + per-chart alignment (local/tacet/unmapped). There is no
  cross-part following; songRef is a chart file id (authority §2, §9-1).
- Follower "detach" (drive your own chart privately) and one-tap resync (authority §4).
- Showing "change pending" to followers. The armed change reaches them in state, but only the
  conductor's cluster renders it (authority §3.5).
- Live / coasting clock rungs and the audio-driven clock (5b-c4 item 4b,
  `conductor-clock.ts:161-164`). Seek re-seat (5b-clock). The `clock` wire payload is never
  sent, so followers get no tempo. Meters other than 4/4.
- Relay chunk 4: docs rewrite to `relay-ops.md` plus deleting `relay/provision-cert.sh`. Both
  the script and `relay-provisioning.md` still exist (relay-cloud §6, §7-4).
- Relay chunk 5: uptime ping/alert on `/healthz`. Only the Fly health check exists (`fly.toml`).
- Relay chunk 6: `presence` frame (the conductor sees who is following). Not in
  `relay-protocol.ts` or `relay-core.ts` (relay-cloud §9.3.2).
- Relay chunk 7: six-state connection model (idle / connecting-initial / joined / reconnecting
  / room-gone / room-rotated). The hook still has `off|connecting|joined`, and room rotation is
  silent (relay-cloud §9.3.1).

---

## Appendix A — Known drift: where a design doc (or INDEX cite) disagrees with the code

Code wins. Each item is a doc to fix the next time someone touches that area. None of them is a defect in the product by itself; the product defects among them are carried into `docs/uat-plan-v1.md`.

### A2. Show

- **INDEX says input-plot-linkage steps 1–5 shipped.** Step 5's monitor rules (immutable mix#,
  `max+1` add, no renumber on reorder, `validateMonitors`) are not on main: reorder and delete renumber
  mixes and leave `slot.mix` pointing at the old numbers (`lib/setlist.ts:172-180`,
  `page.tsx:6646`,`:6650`). Deleting Mix 2 of 4 silently re-routes performers on 3 and 4.
- **design-agent-codesigner** shows a +/~/− diff and an approve per change; code previews proposed rows
  only, and `update_stage_plot` wipes inputs/monitors (`page.tsx:5608-5640`). AI tools carry no ids or
  `slotId`, so applying any AI plot/input change drops input↔performer links, and `update_setlist`
  drops `songId`/charts/bpm until the next save+reload (`lib/agent.ts:78-150`, `page.tsx:5642-5647`).
- **design-agent-codesigner**: try-it quota 10 turns via Redis; code is 50 per IP per 30 days in
  Supabase (`lib/agent-key.ts:14`, `:158-220`).
- **design-perform-tab**: rows show lead singer and notes; code shows number, title, key, chart only
  (`page.tsx:1166-1199`). Header falls back to venue·date/"Setlist", not band name.
- **design-share-reliability Fix 3** specifies a `showLoaded` flag; code uses `loadedPath`, which is
  also set by the offline-cache restore (`page.tsx:478`, `:600-605`) — equivalent intent.
- **design-song-library**: "Reset to default" for overrides and role-pill Charts column — absent;
  Charts column is a count. Collaborator "Ask the show owner…" message is moot (non-owners never reach
  Config).
- **backlog-song-library-manager** says there is "zero visibility" and no songs table; `/library` with
  CRUD, counts, search and chart management is live (`app/library/page.tsx`), songs table since `006`.
  Remaining asks are filters and per-song show list only.
- **design-console-export** button labels "Export Patch List (.csv/.xml)"; code "Export Patch (.csv/.xml)".
- **design-offgrid-zones** cites `page.tsx:872` / `agent.ts:12` / `POS_ENUM` at `:49` — `:49` still
  right; page cite stale (grid is `page.tsx:1254`).

### A3. Platform

1. **Google sign-in.** supabase-backend §Auth ("Email OTP or Google OAuth"), single-backend §4.1 ("Google OAuth *login*") say Google is a sign-in method. Code: `/api/auth/google` requests only Drive scopes (`drive.file drive.readonly`, `app/api/auth/google/route.ts:27`) and hands tokens back in a URL fragment; it never creates a Supabase session. Sign-in is OTP only.
2. **Settings copy promises account deletion.** `ByoaKeySettings.tsx:277` "deleting your account deletes it too" — no account deletion exists (above). The trigger would delete it IF it existed.
3. **Device-key copy.** `ByoaKeySettings.tsx:235` "We never receive it" — the device key is sent to our server as `Authorization: Bearer` on every AI request (`page.tsx:5386`) and proxied to Anthropic; it is not stored server-side. strategy-pwa-commercial §BYOA ("never sent to any server except the AI provider") is likewise false.
4. **"Remember" checkbox.** ai-key-availability §5 and `lib/byoa-key-storage.ts` describe a Remember box with a session-only option; the shipped settings UI always writes localStorage (`ByoaKeySettings.tsx:89`, `remember=true`). The sessionStorage branch has no UI path in.
5. **Collaborator banner/dashboard.** supabase-backend §Auth Flow describes invite → collaborator dashboard. Code: no inserter; banner fires for any signed-in non-owner (`page.tsx:794`).
6. **URL shape.** design-owner-namespacing says `/app/{owner}/{show}`; code is `/{owner}/{show}`. supabase-backend "Resolved Decisions #1: globally unique slugs" is superseded by `005`.
7. **Storage path.** supabase-backend: `{show_id}/{song_id}/{role}.{ext}` and delete-show removes chart files. Code: owner-scoped `{owner_id}/{song_key}/{role}.pdf`; show delete keeps charts.
8. **single-backend §3.2** says the probe is not account-aware; it is (`capabilities/route.ts:40`). Issue #136 is still OPEN on GitHub but its fix shipped (`lib/agent-availability.ts:216`, tests at `tests/agent-availability.test.ts:326`).
9. **alpha-ready** is indexed SHIPPED-RECORD "both parts", but its Part 2 SW (show-data cache, asset manifest, global `SwRegister`, install prompt, offline banner) was not built; the shipped design is design-offline-pwa-supabase.
10. **Manual "download charts for offline" CTA** (design-offline-chart-cache) renders only when `!showId` inside the Config tab (`page.tsx:6926`) — but Config is owner-only and owners always have a `showId`, so it is unreachable for Supabase shows.
11. **Reserved handles** differ across three lists: profiles route omits `library` (a real route), `mockup`, `dev`; middleware `RESERVED_PATHS` also omits `library`. RLS "Owner manage" FOR ALL lets a signed-in browser client insert/update its own profile directly, bypassing the route's regex and reserved list (`005:12`). Not key-related.
12. owner-onboarding Out-of-Scope says "collaborators use public links, no auth needed" while supabase-backend designs authenticated collaborators — code matches the former in effect (public link) and keeps the latter's tables.
13. Stale comments: `app/api/charts/convert/route.ts:169-170` and `roadmap/parse/route.ts:47` still say the key comes from "Redis admin:claude_tryit_key"; it is env only.

### A4. Charts

- **INDEX line cites have drifted:** `moveBarBoundary` 526 → actual `CC:557`; `addBarline`/`removeBarline` 738,778 → `813,772`; `resolveRoadmap` 938 → `974`; `relabelSection` 101 → `122`; offline-fix `page.tsx:6208` → `6209`.
- **converter.md and library-chart-management.md still say upload fires the converter** ("Every chart ADD/REPLACE fires…", the "Generating overlay…" transient). The code says upload stops (`chart-upload.ts:6-12`). converter.md also says "Upload accepts images too", but upload rejects non-PDF (`upload/route.ts:41`).
- **converter.md specifies a page cap and a standalone A2 node script.** The code has only a 15 MB byte cap: an AI 400 is mapped to `too_large` (`convert/route.ts:189`). A2 shipped as an admin route (`app/api/admin/backfill-chart-overlays/route.ts`) and does not use measurement.
- **backlog "Graceful empty/non-chart upload"** cites `ManageChartsModal.tsx:120` "overlay could not be generated". That string no longer exists; the item is stale since lazy conversion.
- **realtime-chart-control: long-press should enter "◌ LOOPING" with haptics.** The code only parks the playhead and shows "Holding" (`P:1920-1923,4475`).
- **inline-viewer: eviction outside the [N−2, N+2] window.** The code evicts the least recently used doc once there are 5 (`pdf-viewer.ts:38-45`).
- **cv-snap: "No clear barlines found — drag to align".** The code shows "no clear barlines to snap" (`P:4146`). The doc treats snap as confidence-clearing only; on main it also stamps `verdict:'edited'` (`chart-snap.ts:8`, review-step §C2).
- **chart-library: setlist pills "click to view inline".** The pills are plain `<span>`s (`P:4925`).

### A5. Chart builder

- **L1 grammar misreads a time signature as a chord (verified by running `parseGrammarDraft`).** Header-less "4/4 in G, 4 bars G, 4 bars C, 4 bars D" → `Section: 13 bars — C/C, G×4, …`: "4/4" is parsed as degree 4 over bass 4, adding a bogus bar; "3/4, 2 bars D…" in D gives an extra F#/G bar and stays 4/4. Doc §7 says non-grammar prose falls to L2. `lib/roadmap-authoring.ts:511-543`, `lib/roadmap-view.ts:126-150`
- Issue #173 says bars have "no hover state, no cursor change, no hint". Main has `cursor-pointer hover:bg-blue-50`, ＋ on hover for empty bars (both since June) and a tip "click a bar — 1 or IV …" at the bottom of the refine rail. The real gap: hover-only cues are invisible on touch, the tip is 11 px grey and far from the chart, and there's no empty-chart prompt. `RoadmapBuilder.tsx:516-519,988,994`
- `docs/INDEX.md` cites `relabelSection (lib/chart-calibration.ts:101)` for key resolution (and expressiveness repeats it). `relabelSection` renames a calibration section anchor; the key relabel is `roadmap-render.ts:252-256` + `page.tsx:3874`.
- Builder doc Open Q1 / Codex NB requires an embedded bundled font; code uses `StandardFonts.Helvetica` and says the bundled font is deferred. `roadmap-render.ts:11-16,216`
- Builder doc: periodic GC sweeps orphaned objects; none exists (grep). `save/route.ts:184-190`
- Authoring-fidelity §4.1: prose key outranks any UI key; code adds a higher Review-toolbar override. `roadmap-authoring.ts:378-389`
- Edit-loop §3: "nav drops only when its target section is deleted" — code drops the entire nav block, not just the orphaned marker. `roadmap-view.ts:308-330`
- Parse route requires the platform key before even trying the no-AI grammar (503), contrary to "zero LLM" L1 framing. `parse/route.ts:49-52`
- Validator requires ≥ 2 volta endings; builder doc does not state it. `roadmap-spec.ts:374`
- Song-form doc cites `RoadmapBuilder.tsx:573-574, 742` for add/remove; now `:573` and `:743` (minor drift). Line-measure doc cites `RoadmapBuilder.tsx:756-805` for preview grid; now `:900-955`.

### A6. Conductor + relay

- **The conductor loses its controls when its socket drops.** The hook reports the
  `'joining'` phase as role `'follower'` (`use-conductor-session.ts:1041`). The page mounts the
  cluster only when the role is not `'follower'` (`page.tsx:4278`). So during a reconnect, and
  during the first go-live connect, the MD sees "Joining the room…" with only Leave. The
  cluster's amber "relay connecting…" facet (`ConductorCluster.tsx:152-160`) is unreachable in
  the page, and only its unit test exercises it. The hook's own comment promises the MD
  "keeps conducting locally" (`:415-418`). A clock that is on keeps advancing unseen, because
  local dispatch is not blocked in `'joining'`. Verify on a device.
- **A follower in "Conductor lost" cannot steer its own chart, despite the copy "you're on your
  own chart for now"** (`RelayStrip.tsx:101`). `sessionDriving` stays true for any follower
  (`page.tsx:3402`), so chart taps do nothing (`:3512`). The displayed page is pinned to the
  last mirrored bar's page (`chart-calibration.ts:928`). The 3b failure matrix says followers
  "keep playing (self-drive floor)". In practice they must tap Leave. Verify on a device.
- Authority §5 and the 3b doc §1–§2 still describe a band-owned local access point with no
  backhaul. The code is cloud-only (`fly.toml`, `start.ts`). The amendments promised in
  relay-cloud §6 were never made.
- `relay-provisioning.md` gives `wss://relay.showrunr.ai:8787`. Production uses port 443 with
  TLS terminated by Fly (relay-cloud D2, `fly.toml` `http_service`).
- INDEX says "Cert expires 2026-09-30". That date belongs to the retired local-box Let's
  Encrypt cert in `relay/certs/` (gitignored). The Fly edge cert auto-renews (valid to 2026-11-30
  when checked on 2026-10-07).
- Authority §3.5 says auto-fire needs "clock present AND …". In code, a manual arrival fires
  with no clock at all (5a floor, `use-conductor-session.ts:823`); clock-placed arrivals need
  confidence. This matches the chunk5 doc D1. The epic text is stale.
- chunk4-ui §3 says the cluster is "MD-only, interim gate isOwner". The owner gate was dropped
  (`page.tsx:4419`).
- The comment `RelayQrOverlay.tsx:7` says "4-char code". Codes are 6 characters
  (`relay-core.ts:158`).
- `RelayConnectingOverlay` says "the cluster's connecting chip re-opens it". Per the first
  bullet, that chip is not mounted while connecting.
- Known bug, offline: `cacheChart` lists the cache's keys, deletes this fileId's other versions,
  *then* writes (`lib/chart-cache.ts:54-62`). Two overlapping writes of different versions (the
  render-path cache write in `pdf-viewer.ts:148` plus a download) can delete the *newer* copy
  and keep the older one. The newer chart is then missing offline until it is fetched again.

## Appendix B — Source docs this file replaces as reading material

Read these only when changing the area. They hold rationale and derivations, not current behaviour.

- **§2:** design-song-library, design-setlist-import-merge, design-setlist-reordering, design-new-show-modal, design-share-reliability, design-perform-tab, design-console-export, design-input-plot-linkage, design-input-sends, design-offgrid-zones, backlog-song-library-manager, backlog-show-freeze, design-agent-codesigner, design-core-path-tier1, design-ai-op-contract (still needed if the op contract or mix identity is built), and the v0.1 SPEC.md (May 2026) that this file replaces.
- **§3:** design-single-backend.md · design-supabase-backend.md · design-owner-namespacing.md · design-owner-onboarding.md · design-ai-key-availability.md · design-account-key-recovery.md · design-payments.md · strategy-pwa-commercial.md · backlog-admin-identity.md · design-offline-pwa-supabase.md · design-offline-chart-cache.md · design-alpha-ready.md · design-storage-notation.md · backlog-offline-performer-cache.md
- **§4:** design-chart-converter · design-chart-library · design-chart-measurement · design-chart-review-step · design-chart-offline-fixes · design-chart-role-overrides · design-barline-calibration · design-barline-add-remove · design-cv-barline-snap · design-library-chart-management · design-inline-chart-viewer · design-realtime-chart-control · design-nav-graph · design-perform-readiness · design-batch-chart-resolution · backlog-charting
- **§5:** design-roadmap-builder.md · design-roadmap-key-resolution.md · design-roadmap-edit-loop.md · design-roadmap-authoring-fidelity.md · design-roadmap-expressiveness.md · design-roadmap-fit-to-width.md · design-roadmap-line-measure-numbers.md · design-roadmap-notation-toggle.md · design-roadmap-prompt-persistence.md · design-song-form-from-lyrics.md (unbuilt; keep as design) · issue #173
- **§6:** design-conductor-authority.md, design-conductor-chunk3.md, design-conductor-chunk4.md, design-conductor-chunk4-ui.md, design-conductor-chunk5.md, design-conductor-chunk5b-clock.md, design-conductor-chunk5b-c1-align.md, design-conductor-chunk5b-c2-motion.md, design-conductor-chunk5b-c3-confidence.md, design-conductor-chunk5b-c4-live.md, design-conductor-insert-return.md, design-conductor-3b-discovery-failover.md, design-conductor-ux-polish.md, design-relay-cloud.md, relay-provisioning.md.
