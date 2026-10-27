# ShowRunr v1 — UAT plan

Written 2026-10-07 against `main` = `40a4318`. **This doc is dated state, not a spec.** How the
product should behave is in `SPEC.md`, and whether something is built is in `docs/INDEX.md`.
This file records what was true on the date above and how we will test it with real people.
Replace it when it goes stale; don't patch it in place.

**UAT means** real band members using ShowRunr for real gigs. The core path is: create a show →
stage plot, inputs, mixes → setlist + charts → share the link → perform from phones, including
offline at the venue.

---

## 1. Baseline, measured 2026-10-07

| Check | Result | How measured |
|---|---|---|
| Local gate on `main` | ✅ 2124/2124 tests, 89 files · lint · tsc · build all clean | `vitest run`, `npm run lint`, `tsc --noEmit`, `npm run build` |
| CI on `main` | ✅ `lint-and-build` success | GitHub check-runs on `40a4318` |
| **Production deploy** | ❌ **Stuck at `220ac5d` (2026-09-04).** Every push since has the Vercel status "Account is blocked." Not live: #179, #180 (docs), **#181 (C1+C2)**, **#183 (C4+C5)**. | `gh api …/commits/<sha>/status` on 644a3bc, 08db8bd, 8acbaa7, 40a4318; `vercel inspect showrunr.ai` → created 2026-09-04 |
| App `showrunr.ai` | ✅ 200; TLS valid to 2026-12-28 | curl, openssl |
| Relay `relay.showrunr.ai/healthz` | ✅ 200 `ok`; TLS **auto-renewed**, valid to 2026-11-30 (the old "expires Sep 30" item is closed) | curl, openssl |
| Supabase | ✅ REST + storage reachable; tables `shows` 8 · `songs` 355 · `chart_library` 350 · `profiles` 9 · bucket `charts` | service-role REST count |
| Prod env names | ✅ `PLATFORM_ADMIN_EMAIL`, `CLAUDE_TRYIT_KEY`, `NEXT_PUBLIC_RELAY_URL`, Supabase ×3, Google ×2 present | `vercel env ls production` (values are Sensitive and unreadable) |
| Platform AI key **works** | ⚠ Unverified. The var exists, but its value can't be read. | Graham: one Generate in the chart builder on prod |
| DB schema = migrations 001–017 | ⚠ Unverified this session (prod read not run) | Graham's call whether to run the column check |
| Open PRs | PR #184 (C3 review sheet), Codex R3 clean, awaiting go-ahead, never driven in a real browser | `gh pr list` |

---

## 2. Gaps before UAT

Every item was re-checked against the code on `40a4318`. Older findings that turned out to be
fixed are listed in §2.5. `P` = `app/[owner]/[show]/page.tsx`.

### 2.1 Blockers

| ID | Gap | Evidence | Fix size |
|---|---|---|---|
| **B1** | **Nothing since Sep 4 reaches production.** The Vercel account was blocked (team `salonhqs-projects`); Graham reports it unblocked 2026-10-26. Still open until the next merge to `main` is confirmed deployed to production. | §1 | S (ops) |
| **B2** | **Applying an AI stage-plot change wipes the hand-built input list and monitor needs, then says "Applied."** `update_stage_plot` regenerates every input from a keyword guess, renumbers channels, rebuilds monitors with blank needs, and cuts every input↔performer link. There is no confirm, no undo, and autosave commits it. The system prompt tells the model to "ALWAYS cascade". **Same loss with no stage-plot card:** the separate `update_inputs` tool replaces the entire input list, its schema has no `slotId`, and Apply assigns the list directly — so asking the AI to change one input erases every performer link. | `P:5608-5640`, `:5642` · `lib/agent.ts:29`, `:78` · `docs/design-ai-op-contract.md` (unbuilt) | **S stop-gap:** drop the client cascade + a confirm naming what gets replaced. M–L: the op contract |
| **B3** | **FIXED: full `design-core-path-tier1.md` §3 built.** A mix number is now immutable except through `renumberMix`, which moves its performers with it. Delete orphans and flags them; drag reorder is gone. Cases SH-20 and SH-37 verify it. | `lib/setlist.ts` (`renumberMix`, `validateMonitors`, `nextMixNumber`, `isOrphanedMix`) | Done |
| **B4** | **The offline gig path has never been run on a real phone.** Risks from the code: pdf.js is a lazy chunk that the service worker caches only if it was fetched while the SW was in control; the show fetch has no timeout, so captive "lie-fi" Wi-Fi hangs while showing the built-in demo band; an offline cold start reopens only the *last* show. | `lib/pdf-viewer.ts:10-12` · `public/sw.js:7-12,72-90` · `P:499` · `app/page.tsx:39-45` | S to test (cases PL-03/04, CH-03 below). Fix size depends on the result |

### 2.2 Conductor: not in v1 UAT (ruled 2026-10-26)

Graham ruled the conductor out of v1. K1 and K2 are now listed under §2.4.

### 2.3 Should fix before UAT

| ID | Gap | Evidence | Size |
|---|---|---|---|
| S1 | A new or slow show first renders a stranger's band (the built-in Loosely Covered demo). A new show then lands on Perform with "No setlist yet." and no pointer to Config. | `P:313-330`, `:514`, `:1161` | S |
| S2 | An owner who opens a show offline silently loses Config/AI, and no banner explains why. | `P:469-486`, `:794` | S–M |
| S3 | Offline edits are retried only on the *next* edit. Nothing listens for `online`, and the next online load overwrites the local copy. | `lib/use-show.ts:110` · `P:540-549` | S |
| S4 | Up to 2 s of edits can be lost when a tab closes or a phone locks. React unmount attempts a flush, but nothing flushes on `pagehide`/`visibilitychange`, which is what a phone lock or tab kill actually fires. | `lib/use-show.ts:150-175` | S |
| S5 | The same owner on phone + laptop is last-write-wins on the whole show (no version check). | `lib/use-show.ts:123` · `rpc_save_show` | M |
| S6 | Shared chart links point at a setlist *position*, so after a reorder they open a different song with no error. | `lib/share.ts:36-45`, `:58-70` | S |
| S7 | Config → Import Show replaces the whole show with no confirm or undo. | `P:6987-7001` | S |
| S8 | A slot delete can't be cancelled: both dialog buttons delete. | `P:6531-6556` | S |
| S9 | Performers on the share link see "Not signed in — changes won't be saved", and *any* signed-in non-owner sees "Viewing as collaborator". Both are wrong for the main UAT audience. | `P:788-797` | S |
| S10 | A signed-in user with no handle who opens a shared show is sent to `/claim`, then lands on `/dashboard`, not the show. "Sign in" on a show page also returns to `/dashboard`. | `middleware.ts:92-106` · `P:788-792` | S |
| S11 | The BYOA Claude key survives sign-out, so the next person on a shared browser inherits it (issue #134). **This is the one security-scope item.** | `app/dashboard/page.tsx:144-148` | S |
| S12 | Two settings-copy claims about the key are false: "We never receive it" (the device key passes through our server on every AI call, though it isn't stored) and "deleting your account deletes it too" (account deletion doesn't exist). | `components/ByoaKeySettings.tsx:235`, `:277` | S |
| S13 | A fake builder ships at `/mockup/roadmap-builder` (hard-coded sample, "(mock) Saved"). Testers who find it will file bogus bugs. | `app/mockup/roadmap-builder/page.tsx` | S (delete) |
| S14 | The chart builder misreads a leading time signature as a chord: `4/4 in G, 4 bars G…` gains a bogus first bar (`C/C`). Reproduced with `parseGrammarDraft`. | `lib/roadmap-authoring.ts:511-543` | S |
| S15 | The chart builder's parse refuses with 503 when the platform key is missing, even for text the no-AI grammar could handle. Convert and parse never use the owner's own key (`design-ai-key-availability` §13 unbuilt). | `app/api/charts/roadmap/parse/route.ts:49-52` | S (reorder) / M (§13) |
| S16 | Chord entry in the builder has no cue on touch screens (hover only, plus an 11 px tip far from the chart). Issue #173 is partly stale: hover cues on desktop exist. | `components/RoadmapBuilder.tsx:516-519`, `:988`, `:994` | S |
| S17 | Share-to-Messages on iOS is intermittent: the file attaches, but Messages doesn't come to the front. One possible cause is that `performShare` awaits the PDF fetch before `navigator.share`, so the tap gesture may have expired. Unconfirmed. | `lib/share.ts:94-110` | ? (repro first) |
| S18 | **FIXED by deletion (B2 step 3).** The keyword expansion that dropped the Trumpet from a "Sax/Tpt" slot is gone with the cascade; the model now sends every input itself. Case SH-27 verifies it. | `lib/agent.ts` `generate_show` | Done |

### 2.4 Deferred past v1 (Graham to confirm)

- **Payments, tiers, quotas.** No Stripe, no tier table (`design-payments.md`).
- **No spend cap on convert/parse**, which run on the platform key. This is a cost issue, not a security one.
- **PR #184, the C3 review sheet.** It is overlay-calibration polish, not core path. Drive it once in a real browser before merging, and merging can't deploy while B1 stands.
- **`RENDER_SCALE` profiling on Graham's phone** (`/dev/measure-profile` is live in prod).
- **Smaller fixes:** replacing a chart silently drops its verified overlay; `featured` can't be unset; no `sceneNote` editor; account deletion is impossible (FK `NO ACTION`); the library row has no Share; the `cacheChart` cross-version eviction race; issues #100, #136 (fix shipped, so close it), #138, #139.
- **The conductor (ruled out of v1, 2026-10-26).** Two known gaps were found by code read, never reproduced on a device:
  - **K1:** the conductor loses its controls whenever its connection drops (`lib/use-conductor-session.ts:1041` · `P:4278`).
  - **K2:** after "Conductor lost", a follower can't drive its own chart (`P:3402`, `:3512` · `CC:928` · `components/RelayStrip.tsx:101`).
  The C-series case catalogue was removed from §6.5 and is in git at `e462b47`.
- **Designed but not built:** chart role overrides, song-form-from-lyrics, `keyShift`, conductor cross-part alignment / audio clock / relay chunks 4–7, input sends, off-grid zones, BYOS.

### 2.5 Dropped: older findings verified fixed on `40a4318`

- A failed save showed "Saved" → now loud (`lib/use-show.ts:101-112`).
- The setlist-title phantom write → linked titles are read-only (`P:4897-4912`).
- Image charts could be uploaded but not viewed → upload is PDF-only, byte-sniffed (`app/api/charts/upload/route.ts:41`).
- AI/import rows had no ids → `withStableIds` runs on every mutation (`P:657`).
- Upload blocked ~60 s on the converter → overlays are now built on demand.
- Sheet re-import wiped ids/keys/charts → preview + merge.
- Mid-stream AI errors were swallowed → fixed (`lib/agent-stream.ts:107-112`).
- CI didn't run tests → `ci.yml:33` now runs `npm test`.
- The relay cert expiry → it auto-renews.

---

## 3. Entry and exit criteria

**Entry (all required before the first tester gets a link):**
1. B1 cleared and `main` deployed. `vercel inspect showrunr.ai` shows a deploy at or after the fix commits.
2. B2 and B3 fixed in full and deployed. Graham's 2026-10-26 ruling: no stop-gaps.
3. The B4 phone run (§4, steps 10–13) passes on one iPhone and one Android phone, run by Graham.
4. One successful chart-builder Generate on prod, which proves the platform AI key.
5. `relay.showrunr.ai/healthz` returns `ok` on the day.
6. Test data is ready (§5).

**Exit (v1 is UAT-accepted when):**
- Every P0 case passes on iOS Safari (installed PWA) and Android Chrome, plus a laptop for owner flows.
- No open blocker. Every P1 failure is triaged into fix-now / fix-later with Graham.
- At least one real gig was played from ShowRunr by a band other than the owner's.

## 4. The gig-day run (P0, in order)

One scripted pass that walks the core path the way a band meets it. Each step names the catalogue
case (§6) that holds the detailed expected result. Run it end to end; stop and log at the first
failure.

| # | Who / device | Step | Case |
|---|---|---|---|
| 1 | New owner · phone | Sign in by email code, claim a handle | PL-05, PL-10 |
| 2 | Owner · laptop | Create a show, confirm the URL | SH-01 |
| 3 | Owner · laptop | Build the stage plot, inputs, mixes by hand; link inputs to performers | SH-18 |
| 4 | Owner · laptop | Same with the AI co-designer on an empty show, then on two separate hand-tuned shows | SH-27, SH-28, SH-28b |
| 5 | Owner · laptop | Delete a middle monitor mix; check the plot still points at the right wedges | SH-20 |
| 6 | Owner · laptop | Import the setlist from a Google Sheet, then add one song from the library | SH-13, SH-11 |
| 7 | Owner · laptop | Upload PDF charts; build one chart from words; save it to a role | CH-10, RB-01, RB-02 |
| 8 | Owner · laptop | Autosave + reload; rename the show and confirm the link still works | SH-04, SH-03 |
| 9 | Player · phone (signed out) | Open the link from a text; read Perform and Mix; open charts; turn pages and songs | PL-01, SH-02, CH-01, CH-02 |
| 10 | Player · phone | Wait for "N charts cached"; airplane mode; reload | PL-02, PL-03 |
| 11 | Player · phone | Install to home screen; force-quit; airplane mode; cold launch | PL-04 |
| 12 | Player · phone | Owner replaces one chart → player reopens online → then offline | PL-08, CH-07 |
| 13 | Player · phone | Join captive or flaky Wi-Fi (or Network Link Conditioner "Very Bad Network"); open the show | B4 (new) |
| 14 | Signed-in non-owner · laptop | Open the link; confirm read-only everywhere | PL-07, SH-10, RB-30 |
| 15 | Owner · laptop | Print the rider | SH-09 |
| 16 | Owner · phone | Offline edit, then reconnect | SH-05, PL-23 |

## 5. Test setup

- **Accounts:** the owner (`graham@sunsetlabs.ai`, platform admin) for admin checks only. Use a
  **fresh** owner account for the run, so the real show and its 341 lyric PDFs stay untouched. Add
  a second signed-in account for the non-owner cases, plus signed-out phones.
- **Devices:** an iPhone (Safari + installed PWA), an Android phone (Chrome + installed PWA), a
  laptop (Chrome), and an LTE hotspot for the different-network relay case.
- **Data:** a 20–30 song public Google Sheet; at least 6 library songs with PDF charts in 2+
  roles; one engraved chart with repeats + D.S. al Coda for overlay/conductor cases; one lyrics
  PDF; one non-notation PDF.
- **Logging:** one GitHub issue per failure, titled `[UAT <case-id>] …`, with the device, the
  role, the step, a screenshot, and the show URL. Graham triages.

## 6. Case catalogue

Cases are grouped by area and numbered by prefix: SH = show, PL = platform, CH = charts,
RB = chart builder. P0 = gig-blocking. A case whose expected result says
**"EXPECT TODAY"** or **"known defect"** records a gap from §2. It passes once that gap is fixed.
Each line reads: *Title — Preconditions · Steps · Expected · Role · Device.*

### 6.1 Show (SH)

Roles: **Owner** (signed in, owns the show) · **Non-owner** (signed in, not owner, incl. collaborator)
· **Anon** (signed out, has the link). Devices: **Phone** (iPhone Safari + home-screen PWA where
noted) · **Laptop** (Chrome).

#### P0 — gig-blocking
- [SH-01] Create a show — Signed in, on /dashboard · New Show → type "Friday at Roxy" → Create · Lands on `/{owner}/friday-at-roxy`, Perform tab, "No setlist yet." · Owner · Laptop + Phone
- [SH-02] Shared link opens signed-out — Show with setlist + charts · Open the show URL in a private window · Perform tab with songs and keys; only Perform + Mix tabs; amber "Not signed in" banner; no edit controls anywhere · Anon · Phone
- [SH-03] Rename keeps the link — Show already shared · Owner changes Show Name in Config, waits for "Saved" → Anon reloads old link · Old link still loads, new name in header · Owner + Anon · Laptop + Phone
- [SH-04] Autosave and reload — Owner in Config · Edit a venue and an input; wait for green "Saved"; reload · Edits persist · Owner · Laptop
- [SH-05] Save failure is loud — Owner in Config · Turn off Wi-Fi/airplane mode, edit a field, wait 3 s · Pill turns red: "Couldn't save — you appear to be offline…"; turning network back on and editing again → "Saved" · Owner · Phone
- [SH-06] Perform → chart → back — Setlist with library PDF charts · Perform → tap a song's note icon → swipe to next song → close · Chart viewer opens on that song, swipes through, returns to the setlist · Anon · Phone (iPad if available)
- [SH-07] Role filter — Songs with Guitar and Lyrics charts · Tap "Guitar" pill → only songs with a guitar chart show a chart button; reload tab → still Guitar; open a different show → back to All · Anon · Phone
- [SH-08] Offline at the gig — Owner has opened the show once online · Kill network, relaunch home-screen app · App opens the last show from cache with setlist and cached charts · Anon/Owner · Phone PWA
- [SH-09] Print the rider — Show with plot, inputs, monitors, notes, 20 songs · Print icon from Perform tab → leave all ticked → Print · Preview shows Stage Plot, Input List, Monitor Mixes, Notes, compact 2-column run order; after closing print dialog the Perform tab is back · Any · Laptop
- [SH-10] Collaborator cannot edit — Non-owner who collaborates on the show · Open show; try every tab and the Mix run order · Blue "Viewing as collaborator (read-only)"; no Config/AI tabs; no Reorder button · Non-owner · Laptop
- [SH-11] Add song from library — Library has "Mustang Sally" with charts · Config → + Add Song → type "mus" → pick it · Row added at the end with key/lead and chart; Perform shows the chart button without reload · Owner · Laptop
- [SH-12] Reorder setlist — 10-song setlist · Config: drag song 7 to position 2; Mix: Reorder → ↑ on last song → Done · Numbers stay 1..10, charts stay with their songs, order matches on Perform and after reload · Owner · Laptop + Phone (touch drag)

#### P1
- [SH-13] Sheet import, first time — Public Google Sheet with Title, #, Key, Lead, Notes, Scene Note · Paste URL → Preview import → Apply · Preview counts adds; setlist matches sheet order; keys/scene notes filled · Owner · Laptop
- [SH-14] Sheet re-import keeps data — Imported setlist with charts + BPM; sheet changes one key, adds a song, drops a song · Preview → leave "Also remove" unchecked → Apply · Changed key shown in Details; dropped song listed "Not in sheet — kept"; charts/BPM kept · Owner · Laptop
- [SH-15] Opt-in removal + undo — As SH-14 · Tick "Also remove…", Apply (second confirm) → then click "Undo import" · Rows removed after confirm; Undo restores the prior setlist; Undo disappears after any edit or tab switch · Owner · Laptop
- [SH-16] Sheet tab and bad sheets — Sheet with 2 tabs; a sheet with titles blank; a private sheet · Paste URL while on tab 2; then the blank one; then private · Imports tab 2; "No songs found…"; an error message (not a crash) · Owner · Laptop
- [SH-17] Duplicate show — Show with setlist + charts · Dashboard → Duplicate → accept "Copy of …" · New URL; same band name, venue, date, plot, inputs, setlist; charts appear; editing the copy does not change the original · Owner · Laptop
- [SH-18] Link to stage plot and inputs — Config · Add performer "Bill" at USC mix 2; add input "Kick" → Position = USC — Bill · Mix tab chip shows "MIX 2" and "×1 inputs" · Owner · Laptop
- [SH-19] Delete performer with linked inputs — Bill has 3 linked inputs · Delete Bill → OK (keep) ; repeat on another with Cancel · OK: inputs flagged amber to relink; Cancel: inputs show no position, no flag · Owner · Laptop
- [SH-20] Monitor delete keeps routing — Mixes 1–4; performers on mix 2, 3 and 4 · Delete Mix 2 · The prompt names the Mix 2 performer. After OK, Mixes 1, 3, 4 remain (no renumber). The mix 3/4 performers still show MIX 3/MIX 4. The mix 2 performer shows an amber "MIX 2 REMOVED" chip on Mix tab and in print, plus a ⚠ and "Mix 2 — removed" in the Config Mix dropdown · Owner · Laptop
- [SH-37] Renumber a mix — Mixes 1, 3; two performers on 3 · Config → Monitor Mixes: change Mix # 3 to 7, press Enter · The prompt names both performers. After OK, both show MIX 7 and the row reads 7. Typing 1 into Mix 7's cell shows "mix 1 already exists" and the cell reverts. "+ Add Mix" then adds Mix 8. No drag grip or ↑/↓ on mix rows · Owner · Laptop
- [SH-21] Patch export — 20+ inputs incl. a name with a comma and "&" · Export Patch (.csv) and (.xml) · CSV opens in Excel/Sheets with correct columns, sorted by Ch; XML opens in a browser without errors · Owner · Laptop; also try Phone (iOS download behaviour)
- [SH-22] YAML round trip — Show with everything filled · Export Show (.yaml) → Dashboard → Import YAML · New show with same content; setlist songs linked to library · Owner · Laptop
- [SH-23] Share show from Perform — Any show · Tap Share in Perform header · Phone: share sheet with the show link; Laptop without Web Share: "Link copied" · Anon · Phone + Laptop
- [SH-24] Share a chart PDF to Messages — Chart open in viewer · Share → Messages · PDF attached to a Messages draft. **Known intermittent**: Messages may not come to the front; note how often, and PWA vs Safari · Anon · Phone
- [SH-25] Chart deep link — Copy a shared chart link (`?song=3&chart=Guitar`) · Open signed-out · Viewer opens on song 3's Guitar chart · Anon · Phone
- [SH-26] Bad link — Mistyped show slug; then network off on a never-visited show · Open each · "Show not found" with no tabs; "Connection error" + Retry · Anon · Phone
- [SH-27] AI co-designer first run — Empty show · AI tab → "8-piece: drums, bass, keys, 2 gtr, sax+tpt, lead vox" → Apply the one "Stage Plot, Inputs & Monitors" card · Plot, inputs and monitors match the card exactly, **including both a Sax and a Trumpet input**; every performer's inputs show that performer in the Input List's Position column; monitor needs are filled, not blank; Mix tab renders it · Owner · Laptop
- [SH-28] AI never silently replaces hand edits — Show with hand-tuned inputs, each linked to a performer, and a setlist · (a) Ask AI to "move keys to USL" · (b) Ask AI to "start over: 4-piece rock band" → click "Replace everything" → Cancel, then again → OK · (a) No card that changes the show; the AI says targeted edits aren't available yet and points to the tables · (b) The card warns with the row counts and its button reads "Replace everything", not "Apply"; Cancel changes nothing and the card stays; OK replaces plot/inputs/monitors and the **setlist is unchanged** · Owner · Laptop
- [SH-28b] AI inputs apply wipes performer links (known behaviour) — **Fresh** show with hand-tuned inputs, each linked to a performer (not the show SH-28 just ran on — that apply already removed the links) · Ask AI to "change the kick mic to a Beta 91" → Apply the inputs card · **Expected today**: the whole input list is replaced and every input↔performer link is lost, with no stage-plot card involved — record, not a pass · Owner · Laptop
- [SH-29] Library CRUD — /library · Add song, edit key, Duplicate, Delete a song used in 2 shows · Delete prompt names "2 shows"; song gone from those setlists and its charts deleted · Owner · Laptop
- [SH-30] Rename a library-linked song — Song used in a setlist · In Config the title is read-only with "Rename in Library"; rename it in /library · Show reloads with new title and charts still attached · Owner · Laptop

#### P2
- [SH-31] Print a long set — 30-song setlist · Print run order only · Songs flow across columns/pages in order, nothing cut off · Any · Laptop
- [SH-32] Name validation — New Show with "!!!" then a 150-char name · Create disabled for "!!!"; the name field stops accepting text at 100 characters · Owner · Laptop
- [SH-33] Library on a phone — /library with 10 songs · Scroll rows · Check whether the 6-column grid forces sideways scrolling (suspected; fixed column widths ~580 px) · Owner · Phone
- [SH-34] Import Show replaces everything — Config → Import Show with a different .yaml · Whole show replaced immediately with no confirm — confirm this is acceptable · Owner · Laptop
- [SH-35] Try-it quota — No API key, signed in · Send messages until exhausted · "Free messages used up. Enter your own Claude API key…" · Owner · Laptop
- [SH-36] Tab-bar copy-link icon — Owner · Click upload icon in tab bar · Link copied; icon briefly shows a tick · Owner · Laptop

#### Can't be UAT'd yet
- AI edits that change one thing without regenerating the rest; diff view; confirm-and-replace
  (ai-op-contract unbuilt).
- PIT / FOH / OTHER zones; input send matrix (parked, issue #138).
- Show freeze after the show date (backlog).
- Share from a library row; owner QR / social / tip-jar links (issue #139).
- Library filters by key/chart status; per-song list of shows.
- Real console import of CSV/XML on a DiGiCo/Midas/Yamaha desk or offline editor — needs hardware or
  vendor software.
- Lead singer / notes on Perform rows; now-playing sync across devices.

### 6.2 Platform — accounts, sharing, keys, offline (PL)

Roles: **Owner** (signed in, owns the show) · **Viewer** (signed out, has the link) · **Non-owner** (signed in, not the owner) · **Admin** (signed in as `PLATFORM_ADMIN_EMAIL`).
Devices: **Phone** (iOS Safari / Android Chrome, installed PWA where noted) · **Laptop** (desktop Chrome).

#### P0 — gig-blocking

- [PL-01] Shared link opens with no account — Owner has a show with ≥3 songs and charts · On a phone that has never signed in, open `/{owner}/{show}` from a text message · Show loads on Perform; amber "Not signed in — changes won't be saved" banner; only Perform and Mix tabs visible (no Config, no AI); charts open · Viewer · Phone
- [PL-02] Charts auto-cache for a viewer — PL-01 done, on good signal · Stay on Perform until the badge settles · Badge goes "Caching n/N" → green "N charts cached" (or amber "x of N cached" if some failed) · Viewer · Phone
- [PL-03] Show survives losing signal — PL-02 done · Turn on airplane mode, reload the show URL · Setlist, stage info and every cached chart still render; chart viewer shows an "OFFLINE" pill; no error page · Viewer · Phone
- [PL-04] Installed PWA cold-launches offline into the last show — Add ShowRunr to Home Screen after opening a show online; force-quit · Airplane mode, launch from the home-screen icon · App opens straight into the last-viewed show (not sign-in, not "Offline — page not cached") · Viewer and Owner · Phone (iOS and Android separately)
- [PL-05] Owner sign-in by email code — Owner account exists · `/sign-in` → enter email → Send Code → type the 6-digit code from email → Sign In · Lands on `/dashboard` listing owned shows; no Google button is offered · Owner · Phone + Laptop
- [PL-06] Owner edit persists across devices — Owner signed in on laptop and phone · Edit the venue on laptop, wait 3 s, reload phone · Phone shows the new venue · Owner · Laptop → Phone
- [PL-07] Non-owner cannot edit — Signed in as a different account that has claimed a handle · Open someone else's show link · Blue "Viewing as collaborator (read-only)." banner; no Config/AI tabs; no Reorder button on Mix · Non-owner · Laptop
- [PL-08] Updated chart replaces cached copy — PL-02 done; owner replaces one chart PDF · Viewer reopens the show online, then goes offline and opens that chart · The NEW chart shows offline, not the old one · Viewer · Phone

#### P1

- [PL-10] First sign-in forces a handle — Brand-new email · Sign in → redirected to `/claim` → type a handle (try `AB`, `dashboard`, an existing handle, then a valid one) · Too-short: button disabled / inline rule; `dashboard`: "That handle is reserved"; taken: "That handle is already taken"; valid: "Claimed …" then auto-load `/dashboard` with "Your shows will live at showrunr.ai/{handle}/..." · New owner · Phone
- [PL-11] Revisit /claim after claiming — PL-10 done · Open `/claim` · "Already claimed as {handle}" + Go to Dashboard link that works · Owner · Laptop
- [PL-12] Signed-in recipient with no handle opening a shared link — New account signed in, no handle claimed · Open an owner's show link · EXPECT TODAY: bounced to `/claim` instead of the show; after claiming, lands on `/dashboard`, not the show. Record as friction for viral sharing · Non-owner · Phone
- [PL-13] Sign-in from a show returns to dashboard — Signed out, on a show page · Tap "Sign in" in the banner, complete OTP · EXPECT TODAY: lands on `/dashboard`, not back on the show (link carries no redirect) · Viewer · Phone
- [PL-14] Protected pages bounce when signed out — Signed out · Visit `/dashboard`, `/dashboard/settings`, `/library?x=1` · Each goes to `/sign-in`; after signing in you return to the exact page incl. `?x=1` · Viewer · Laptop
- [PL-15] Create / duplicate / delete show — Owner on dashboard · New Show "Friday at The Roxy" → back → Duplicate it → Delete the copy · URL preview `/{handle}/friday-at-the-roxy`; duplicate gets "Copy of …"; same name twice gets a 4-char suffix; Delete asks to confirm and the card disappears; the library charts are still in `/library` · Owner · Laptop
- [PL-16] Free AI allowance shows and counts down — Owner with no key; try-it configured · Open AI tab, send one message · Panel shows "N free messages remaining." before sending; N drops by 1 after; opening the tab alone does not spend one · Owner · Laptop
- [PL-17] Save key to this device — Owner, no key · AI tab → Settings → paste key → "Remember on this device" → Save · Masked `sk-ant-…xxxx` "Saved in this browser"; AI panel says "Using your Claude API key."; composer text typed before opening Settings is still there after closing · Owner · Laptop
- [PL-18] Save key to account follows you — Owner · `/dashboard/settings` → paste key → "Save to my account" → Save; sign in on the phone · Laptop shows masked hint "Saved to your account"; phone AI tab uses the key without re-entry; no screen anywhere shows the full key · Owner · Laptop → Phone
- [PL-19] Device key beats account key — PL-17 and PL-18 both done on one browser · Open Settings · Note "This browser has its own key, and it takes precedence…" · Owner · Laptop
- [PL-20] Rejected key recovery — Save a revoked/garbage-but-well-formed key (device), send a message; repeat with account storage · Device: banner "That key was rejected…" + "Clear saved key" → clearing returns to the free-allowance state. Account: "That account key was rejected…" + "Manage key in Settings" opens the overlay · Owner · Laptop
- [PL-21] Remove keys — Keys saved both ways · Remove each in Settings · Each disappears; AI tab falls back to free allowance (or "Free messages aren't available…") · Owner · Laptop
- [PL-22] Device key after sign-out (#134) — Device key saved · Sign Out, sign in as a different account on the same browser, open an owned show's AI tab · EXPECT TODAY: the previous user's key is still used ("Using your Claude API key."). Known open issue — confirm, don't file new · Two owners · Laptop
- [PL-23] Owner offline edit warning — Owner on a show · Airplane mode, change a song note, wait 3 s · Message "you appear to be offline. Your changes are cached in this browser and will save on your next edit once you're back."; after reconnecting, make another edit → it saves and survives a reload on another device · Owner · Phone
- [PL-24] Admin page — Admin signed in · Open `/admin` · Registered Owners list (handle, name, email, show count, join date) + masked config status, read-only · Admin · Laptop
- [PL-25] Admin page refuses others — Signed out, then as a normal owner · Open `/admin` · Signed out: "Sign in to continue"; owner: unauthorized state, no owner list or config shown · Viewer / Owner · Laptop
- [PL-26] Legacy links — Any device · Open `/nicholson-ranch` and `/?show=nicholson-ranch` · Both land on `/graham/nicholson-ranch` · Viewer · Phone
- [PL-27] Import / export YAML — Owner · Config → Export Show (.yaml); dashboard → Import YAML with that file · New show created with the same setlist, opens at a new URL · Owner · Laptop

#### P2

- [PL-30] Dashboard "Shared with me" — any account · Look for the section · EXPECT TODAY: never appears (no way to invite). Confirms the gap, not a bug to file · Non-owner · Laptop
- [PL-31] Free allowance shared on one network — Two testers on the same wifi, neither with a key · Both send messages · Both counters drop together; exhausted copy says free messages are shared across everyone on your network · Owner ×2 · Phone + Laptop
- [PL-32] Settings copy honesty check — Owner · Read the Settings panel · Note two claims that are not true today: "We never receive it" (device key is passed through our server per request) and "deleting your account deletes it too" (no account deletion exists). Report for copy fix · Owner · Laptop
- [PL-33] Chart builder / converter without own key — Owner with a BYOA key; platform try-it key unset · Use Build-chart-from-description and PDF convert · EXPECT TODAY: builder errors "Parser is not configured" / converter shows "Couldn't build an overlay for this chart" with Try again, even though the owner has a key (§13 unbuilt) · Owner · Laptop

#### Can't be UAT'd yet
- Inviting a collaborator / accepting an invite — no invite issuance exists.
- Deleting your account — not possible (NO ACTION foreign keys); no UI or endpoint.
- Changing your handle or display name — no UI.
- Owner public page `/{owner}`, vanity subdomains, QR/social links.
- Install prompt banner, explicit "Ready for Offline" button, auto-clear after show date, stale-cache prompt.
- Payments, trial limits, subscription — no code.
- BYOA for chart convert / roadmap parse — §13 unbuilt.
- Try-it quota fail-closed on DB grant error (42501) and Vault trigger behaviour — needs DB access, not a device test.
- Try-it exhaustion at exactly 50 — needs 50 sends from one IP; better as an API/scripted test.

### 6.3 Charts — library, viewer, overlay (CH)

Roles: **Owner** (signed in, owns the show and its library) · **Collab** (signed in, invited to the show) · **Anon** (signed out, opening the share link). Devices: **Phone** (iOS Safari, installed as an app, unless noted) · **Laptop** (Chrome).

#### P0 — gig-blocking
- [CH-01] Library chart appears in show — Preconditions: owner library has Guitar+Lyrics PDFs for "Valerie"; a show's setlist has "Valerie" · Steps: open the show link → Show tab → tap Valerie · Expected: full-screen viewer opens on the first chart, "Song N of M", with Guitar/Lyrics pills · Role: Anon, Collab, Owner · Device: Phone
- [CH-02] Page and song navigation — Preconditions: show with ≥3 songs, one multi-page chart · Steps: tap the right half, then the left half, of the page; swipe left, then right; on Laptop use ←/→/↑/↓/Esc · Expected: taps turn pages and stop at the first/last page (they don't change song); a swipe changes song; "Page X of Y · tap left/right…" updates; Esc closes · Role: Anon · Device: Phone + Laptop
- [CH-03] Offline at the gig — Preconditions: open the show once online and wait for caching to finish · Steps: airplane mode → force-quit → reopen the show → open several charts · Expected: every library chart renders from cache with no error · Role: Anon, Owner · Device: Phone
- [CH-04] Verified overlay drives bar transport — Preconditions: chart with a verified overlay that has bars · Steps: open the chart in Perform → step with the transport → tap a bar · Expected: the red playhead sweeps bar by bar, turns the page when the next line is on a new page, and a tap jumps to that bar · Role: Anon, Collab, Owner · Device: Phone
- [CH-05] Repeat play order — Preconditions: verified overlay with `|: :|` around bars 1–8 · Steps: step through the bars · Expected: plays 1–8, then 1–8 again with "· 2nd" in the readout, then continues · Role: Anon · Device: Phone
- [CH-06] Drafts never reach performers — Preconditions: owner edits a verified overlay and saves a draft (no Verify) · Steps: Anon/Collab reloads that chart · Expected: no playhead and no transport; the strip shows nothing, or "Tap a section to seek." only if a verified row still matches · Role: Anon, Collab · Device: Phone
- [CH-07] Replaced file drops the old overlay — Preconditions: verified overlay on the Guitar chart · Steps: owner replaces the Guitar PDF with a different file → Anon reopens the chart · Expected: new PDF shows with no overlay or playhead (old geometry is never drawn on new pages); owner sees "No overlay for these bytes. [Build overlay]" · Role: Owner then Anon · Device: Laptop then Phone
- [CH-08] Add song mid-session shows charts — Preconditions: new show; library song with charts · Steps: add the song from the library → Show tab → open it · Expected: chart is there with no reload · Role: Owner · Device: Laptop

#### P1
- [CH-10] Upload PDF via Manage Charts — Steps: library row (or setlist "+" / "Manage") → pick a role → choose a PDF · Expected: role slot fills with the file name; the chart appears in every show with this song; no "Generating overlay" message · Role: Owner · Device: Laptop
- [CH-11] Non-PDF rejected — Steps: try uploading a PNG renamed `.pdf` · Expected: inline error "Charts must be PDF files — this file is not a PDF."; nothing stored · Role: Owner · Device: Laptop
- [CH-12] Replace and delete — Steps: Replace the Guitar chart; then Delete it and confirm · Expected: replace keeps a single Guitar slot with the new file name; delete removes it from the library and every show · Role: Owner · Device: Laptop
- [CH-13] Collaborator is read-only — Steps: Collab opens the show and a chart · Expected: no Config tab (it holds the only in-show path to Manage Charts, so there is no Add, Replace, Delete or Build); no Calibrate button in the viewer · Role: Collab · Device: Phone
- [CH-14] Build overlay (vector PDF) — Preconditions: freshly uploaded engraved PDF with no repeats · Steps: open the chart in Perform → strip "Build overlay" · Expected: "Building overlay… this takes a few seconds", then a draft overlay; strip says "Draft — Verify to perform" or "Add a section…"; bars land on the printed barlines · Role: Owner · Device: Laptop
- [CH-15] Build overlay is refused for gated charts — Preconditions: a `lyrics` chart; a ShowRunr-built chart; a non-notation PDF filed as Guitar · Steps: open each in Perform · Expected: no Build button for the first two, with lines "Lyrics sheet — no bars to detect…" and "Built in ShowRunr…"; the third shows "No staves found on any page…" after Build, with no retry; all three offer Calibrate · Role: Owner · Device: Laptop
- [CH-16] Calibrate sections, then verify — Steps: Calibrate → Sections → tap to drop 2 labels → name them → Verify & save · Expected: Verify is greyed out until every section is labeled; after saving, Perform shows the labels, tapping one shows "At {label}", and a long-press shows "Holding {label}" · Role: Owner · Device: Phone
- [CH-17] Bars tool — Steps: Bars → tap to drop a line → drag its edges → set count with −/+ → "⌗ Snap to lines" → drag one tick → "＋ Add barline" and tap inside a bar → tap a tick → "✕ Remove barline" · Expected: snap reports "N snapped[, M need a nudge]" or "found X, expected Y — adjust count"; ticks can't cross; add splits the bar; remove merges and shows "(−N markers)" when roadmap markers would be lost · Role: Owner · Device: Laptop + Phone (touch drag)
- [CH-18] Roadmap tool — Steps: Roadmap → select bars → add |: and :|, then a D.S. with no Segno · Expected: shows "plays: 1–8, 1–8…"; the D.S. shows a resolve error and Verify is blocked until it's fixed or deleted · Role: Owner · Device: Laptop
- [CH-19] Editing un-verifies — Preconditions: bar-ready verified chart · Steps: nudge a tick → Save draft → Done → Perform · Expected: transport disappears; strip shows "Draft — Verify to perform. [Calibrate]" · Role: Owner · Device: Laptop
- [CH-20] Review chip — Preconditions: an overlay built by the AI with low-confidence elements (a chart with printed repeats, or a raster scan) · Steps: Calibrate → use "⚑ N to review ‹ ›" · Expected: each step switches tool and page and selects the flagged item; editing it reduces N; at 0 it reads "✓ Reviewed"; Verify is never blocked by the chip · Role: Owner · Device: Laptop
- [CH-21] Part filter — Steps: viewer header → pick "guitar" → change songs → reload the tab · Expected: only guitar charts show; songs without one say "No guitar chart for this song"; the choice survives in this tab · Role: Anon · Device: Phone

#### P2
- [CH-30] Legacy image chart — Preconditions: an old non-PDF row · Expected: "This chart is an image… replace it with a PDF." plus an open link · Role: Anon · Device: Phone
- [CH-31] Duplicate-with-edit variant — Steps: Library → Duplicate "Song X" → save as "Song X (Bb)" → upload a chart · Expected: new song with no charts; its charts stay separate from the original · Role: Owner · Device: Laptop
- [CH-32] Tap in a margin doesn't select — Steps: Perform with a bar-ready chart → tap the clef margin before bar 1 · Expected: no jump · Role: Anon · Device: Phone
- [CH-33] Load failure is honest — Steps: open a never-cached chart offline · Expected: "Couldn't load this chart." (never "No overlay") · Role: Owner · Device: Phone
- [CH-34] Hand edit leaves the queue — Preconditions: a measured overlay (verdicts present) · Steps: drag a line's edge → step the review chip · Expected: that line is never flagged afterwards · Role: Owner · Device: Laptop

#### Can't be UAT'd yet
- The review sheet ("Which split looks right?" / "How many bars do you count?", "Check this line", "N lines uncertain" chip, "estimated" badge): C3 is unmerged (PR #184).
- C1/C2 verdict behaviour on prod: needs a deploy past `220ac5d`. The measured path flags 0 lines on the corpus, so an `uncertain` flag can't be reproduced with real charts.
- Multi-role overrides, bulk upload, LOOPING hold with haptics, scrub/play verify, `holdPoint` disable, auto-carrying an overlay onto a replaced file: unbuilt.
- Measurement scale 3 on a real phone (perf): never profiled on a device. It is measurable, so it's a candidate for a perf test, not a pass/fail UAT case.

### 6.4 Chart builder (RB)

Roles: **Owner** (signed in, owns the library/show) · **Collab** (signed-in non-owner collaborator) · **Viewer** (signed out, public show link). Devices: **Laptop** (Chrome, ≥ 1024 px) · **Phone** (iOS Safari / Android Chrome, portrait).

#### Core path (create → save → play it at the gig)
- [RB-01] **P0** Build a chart from plain English — Pre: song in Library with a free role, parser configured · Steps: Library → song row "Build chart" → type `Verse: 2 bars D, 2 bars G7, 2 bars D, 2 bars G7, 2 bars D, 2 bars E, 2 bars G, 2 bars Dsus2. Chorus: 4 bars G, 4 bars A in D` → Generate chart · Expected: Review screen opens; read-back shows "Verse: 16 bars — D×2, G7×2, D×2, G7×2, D×2, E×2, G×2, Dsus2×2" and "Chorus: 8 bars"; chart shows 1, 47, 1, 47, 1, 2, 4, 1sus2 (each spanning 2 bars, printed on the first); key reads D · Role: Owner · Device: Laptop
- [RB-02] **P0** Save into a role and see it in the show — Pre: RB-01 · Steps: pick "Guitar" in "Save as role" → Save → close → open a show whose setlist has the song → open the chart · Expected: builder closes; Manage Charts lists Guitar with Edit + "Replace with file"; in the show the PDF shows title at TOP, "Nashville (authored in D)", 4 bars per line, bar numbers in the left margin, slashes in every bar; no "draft/review" prompt on the overlay · Role: Owner · Device: Laptop
- [RB-03] **P0** Builder chart readable on stage — Pre: RB-02 · Steps: on phone open the show → song → chart; page through all pages (tap or arrow keys — one page shows at a time); switch to Perform · Expected: each page fits the screen width with no sideways scrolling; partial last line is left-aligned (not stretched); Perform follows bars normally · Role: Viewer and Owner · Device: Phone
- [RB-04] **P0** Live key pill follows the setlist (numbers chart) — Pre: numbers builder chart authored in G; in the show set this song's key override to Bb · Steps: open the chart in the show · Expected: header pill shows **Bb**; PDF body numbers unchanged; small PDF tag still says "authored in G" · Role: Viewer · Device: Phone
- [RB-05] **P0** Offline gig — Pre: show with a builder chart cached (open it once online) · Steps: airplane mode → reload show → open chart · Expected: chart and key pill load from cache; Offline badge shows · Role: Owner · Device: Phone

#### Editing by hand
- [RB-10] **P1** Click a bar to type chords — Pre: Review open · Steps: click an empty bar → type `5 4` → Enter; click another → `1 - 4 5` → Enter; another → `IV` → Enter; another → `G7` (key D) → Enter · Expected: input appears with live split preview ("4 beats"); bars show `5 | 4` split evenly, `1` wide (2 beats) then `4`, `5`; `IV` becomes `4`; `G7` becomes `47` · Role: Owner · Device: Laptop
- [RB-11] **P1** Bad chord input is blocked, not saved — Steps: click bar → type `1 4 5` (4/4) → Enter; then `C/Eb` in key D; then Esc · Expected: amber border + message "3 chords don't divide 4 beats evenly — use "-"…" / "is not a valid chord in D"; Enter does nothing; Esc restores the bar · Role: Owner · Device: Laptop
- [RB-12] **P1** Clear a bar — Steps: click a bar with a chord → delete all text → Enter · Expected: bar goes blank (inherits previous); split preview said "inherits previous chord" · Role: Owner · Device: Laptop
- [RB-13] **P1** Chord entry is discoverable (issue #173) — Pre: chart with empty bars · Steps: hover a bar on laptop; on phone just look at the Review screen · Expected (current main): laptop shows pointer cursor, blue tint and ＋ on empty bars; a grey tip "click a bar…" sits at the bottom of the left Refine rail; **on phone there is no visible cue** — record whether the tester found chord entry unaided · Role: Owner · Device: Laptop + Phone
- [RB-14] **P1** Section CRUD — Steps: drag a section by ⠿ to a new position; rename one; change bars 8 → 6; ✕ remove one; "+ Add section" · Expected: chart updates live; shrinking drops the last bars' chords; new section = "New section", 4 empty bars; remove has no confirm · Role: Owner · Device: Laptop
- [RB-15] **P1** Change key / Letters — Steps: toolbar Key → F; toggle Letters · Expected: numbers mode: only "Key of F" changes; letters mode: chords re-spell (1→F, 4→Bb, ♭7→Eb), note "re-spelled in F" · Role: Owner · Device: Laptop
- [RB-16] **P2** Phone layout of Review — Steps: open builder on phone · Expected: panels stack (Refine, chart, Sections/Save); 2 bars per line; no horizontal scroll; bar input usable with on-screen keyboard · Role: Owner · Device: Phone
- [RB-17] **P2** Shrinking a repeated section below 2 bars — Pre: AI chart with "Chorus … repeat x2" · Steps: set Chorus bars to 1 → Save · Expected: Save refused with "Invalid spec: … plain repeat needs section.bars >= 2"; nothing saved · Role: Owner · Device: Laptop
- [RB-18] **P2** Removing a section with a D.S./Coda target — Pre: chart with Segno + D.S. al Coda markers · Steps: remove the section holding the Coda → Save → reopen · Expected (current behaviour): ALL roadmap markers disappear, not only the Coda; no warning shown — log as observation · Role: Owner · Device: Laptop

#### Re-open, regenerate, notation
- [RB-20] **P0** Re-open and edit a saved chart — Pre: RB-02 · Steps: Manage Charts → Guitar → Edit → change one bar → Save · Expected: opens straight into Review titled "Edit Chart"; role fixed ("Saving to role: Guitar"); refine box shows the original description; after save the show displays the change · Role: Owner · Device: Laptop
- [RB-21] **P1** Open + save with no edits is a no-op — Steps: Edit → Save immediately → view in show · Expected: chart looks identical; overlay/markers still aligned · Role: Owner · Device: Laptop
- [RB-22] **P1** Regenerate replaces manual edits after warning — Steps: Edit → hand-change a bar → edit refine text → Regenerate → Cancel, then Regenerate → OK · Expected: Cancel keeps edits; OK shows confirm "Regenerate will replace your manual edits", then the whole chart is rebuilt from the text; empty refine box = Regenerate disabled · Role: Owner · Device: Laptop
- [RB-23] **P1** Toolbar key outranks the prose — Steps: description says "in F"; in Review set Key F# → Regenerate · Expected: chart regenerates in F# (not F) · Role: Owner · Device: Laptop
- [RB-24] **P1** Letters chart is baked and stays letters — Steps: toggle Letters → Save → open in show with a setlist key override → back to Edit · Expected: show PDF prints letter chords and "Key of X"; pill shows the authored key and IGNORES the override; Edit re-opens on Letters · Role: Owner then Viewer · Device: Laptop + Phone
- [RB-25] **P1** Stale edit is refused — Steps: tab A: Edit chart; tab B: Replace with file (any PDF) on same role; tab A: Save · Expected: tab A shows "This chart changed since you opened it — reload and try again."; tab B's file remains; row no longer has Edit · Role: Owner · Device: Laptop
- [RB-26] **P1** Replace with file de-builders — Steps: Replace with file on a builder row · Expected: row label becomes "Replace" (no Edit); key pill gone in show; uploaded file shown · Role: Owner · Device: Laptop

#### Permissions
- [RB-30] **P0** Non-owners can't build or edit — Steps: open the show as Collab and as Viewer · Expected: no Config tab, so no path to Manage Charts and no Build / Edit / Replace / Delete; charts open read-only · Role: Collab, Viewer · Device: Laptop
- [RB-31] **P1** Edit door is owner-only — Steps: as Collab, request `GET /api/charts/roadmap/<owner's chartId>` in the browser · Expected: 404 "Chart not found" (same as non-existent) · Role: Collab · Device: Laptop
- [RB-32] **P2** No free role — Pre: song with every role filled · Expected: Library row has no "Build chart"; Manage Charts has no "Build a chart with AI" · Role: Owner · Device: Laptop

#### Parse failure & edge
- [RB-40] **P1** Parser failure is visible — Steps: Generate with nonsense ("asdf"); then a valid one; then simulate offline · Expected: errors listed in amber with "Try rephrasing"; text kept; offline → "Could not reach the parser." · Role: Owner · Device: Laptop
- [RB-41] **P1** Time signature written first (known bug) — Steps: Generate `4/4 in G, 4 bars G, 4 bars C, 4 bars D` · Expected-correct: 12 bars. **Main today**: read-back "Section: 13 bars — C/C, G×4, C×4, D×4" — a bogus first bar. Log fail until fixed · Role: Owner · Device: Laptop
- [RB-42] **P2** Chromatic chord — Steps: `Chorus: 2 bars G, 2 bars A, 2 bars C, 2 bars G in D` · Expected: C shows as ♭7 (vector flat in PDF) · Role: Owner · Device: Laptop
- [RB-43] **P2** Navigation glyphs print — Steps: AI-describe a song with "D.S. al Coda", segno, coda, 1st/2nd endings, intro repeat x3 · Expected: PDF shows Segno, ⊕ Coda, To Coda, D.S. al Coda, volta brackets "1." "2.", repeat dots with "×3", none overprinting; read-back shows the intro as `×3` · Role: Owner · Device: Laptop
- [RB-44] **P1** "2x chorus" becomes a repeat, not longhand — Steps: Generate `Verse: 4 bars G, 4 bars C. 2x Chorus: 4 bars D, 4 bars C` (or any phrasing that yields two identical adjacent Choruses) · Expected: ONE Chorus section with a `×2` repeat in the preview and PDF; read-back line "Chorus ×2: 8 bars — D×4, C×4". Then describe two identical Verses before a "D.C. al Fine" · Expected: those stay written out (merging would drop a pass) · Role: Owner · Device: Phone

#### Can't be UAT'd yet
- Mid-song key change (`keyShift`) — unbuilt (expressiveness Gap 2).
- "Print/download in key X" export — unbuilt (key-resolution §6.1).
- "Charted in X" note on uploaded charts — blocked on `charted_key`.
- Diff-aware regenerate / scoped AI edits with change highlight — unbuilt.
- Editing repeats, endings, nav markers, time signature, artist by hand — unbuilt (read-only).
- Held diamond in the builder preview / typing a held chord — unbuilt.
- Duplicate a builder chart as a key variant — unbuilt.
- Song form from lyrics sheets (L0 import) — unbuilt.
- Orphaned PDF cleanup — no GC job; not tester-visible.
