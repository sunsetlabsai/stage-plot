# Design — retire Google Drive as a chart source

Status: **PRE-CODEX. Do not build to this text until it has been through review
and Graham has given the go.**
Version: **v1**
Scope: `app/api/drive/*`, `app/api/auth/google/*`, `lib/drive.ts`, the Drive
branches in `lib/chart-cache.ts` / `lib/pdf-viewer.ts` / `lib/chart-converter.ts`,
the `googleToken` plumbing and Drive section in `app/[owner]/[show]/page.tsx`,
and `chartsSource` in `lib/show-file.ts`.

**Explicitly NOT in scope: setlist import.** See §2 — it does not use Google
auth and this design cannot break it.

**Ruled by Graham 2026-08-25:** retire Drive. *"Easy to add back if ever we want
/ need it, but not good to have it around and non-functional. Red herrings cost
us time."* The library is the driver of relevance.

---

## 0. Invariants this design establishes

1. **Nothing that renders a chart today stops rendering.** Every chart in
   production is Supabase-backed (§1); the deleted paths serve zero of them.
2. **A chart that cannot render fails LOUDLY, not silently.** Today an
   unrecognised chart URL falls through to the Drive proxy. After this it must
   return a stated failure, not a request to a route that no longer exists (§4.2).
3. **Old show files still import.** A `.yaml` written before this change carries
   `chartsSource`; loading it must not error (§4.3).
4. **Deletion is justified by reachability, not by taste.** Every removal below
   cites the gate that makes it unreachable. Where a path IS reachable, it is
   listed as reachable and ruled on separately.

---

## 1. The evidence — Drive is already unreachable

Three independent measurements, all taken 2026-08-25.

### 1.1 No show uses it

```sql
select count(*) as total_shows,
       count(config->>'chartsRootFolderId') as drive_shows
from shows;
-- → 6 shows, 0 with a Drive folder
```

### 1.2 The code already calls it legacy and fences it off

| Site | What it says |
|---|---|
| `page.tsx:6560` | `── 6. Google Drive Charts (legacy — only when no Supabase show) ──` |
| `page.tsx:6561` | the whole section is gated `{!showId && (` |
| `page.tsx:5937` | `// Drive-era only. Supabase shows resolve charts from the library on every GET` |
| `page.tsx:5939` | that effect bails: `if (showId) return;` |

### 1.3 ★ The gate is NOT what its comment claims — and it is still unreachable

**`!showId` does not mean "not a Supabase show."** `setShowId` is called in
exactly one place, `page.tsx:526`, inside `if (user && data.show_id)` — so
`showId` is also null for **any anonymous viewer of a real show**, and for the
offline-fallback path (`page.tsx:402`, which sets config from cache and never
calls `setShowId`).

That looked like a live defect: the effect at `page.tsx:5941` wipes `charts` from
every song when `!showId && !config.chartsRootFolderId`, and an anonymous viewer
satisfies both.

**It does not fire.** The effect lives inside `ConfigTab`; the Config tab button
is rendered only when `!isReadOnly` (`page.tsx:759`), and `isReadOnly` is
`!isOwner && !isEditor` (`page.tsx:683`). An anonymous or read-only viewer cannot
reach the tab, and nothing else sets `tab` to `'config'`.

**⇒ The branch is unreachable for every principal on every show that exists in
Supabase:**

| Principal | `showId` | Config tab | Branch reached? |
|---|---|---|---|
| Owner / editor | set (authenticated, row exists) | visible | **no** — `showId` truthy |
| Anonymous viewer | null | hidden (`isReadOnly`) | **no** — tab unreachable |
| Read-only collaborator | set | hidden | **no** — both |
| Offline fallback | null | hidden (`isOwner`/`isEditor` false) | **no** — tab unreachable |

*This is recorded at length because the reachability argument — not the row count
— is what makes the deletion safe. Six rows is evidence about today; the gate
analysis is evidence about every future show too.*

### 1.4 ⚠ One residual risk worth naming

`page.tsx:853` renders `{tab === 'config' && <ConfigTab …>}` with **no
`isReadOnly` guard** — the guard is on the button only. Nothing today sets `tab`
from a URL, so this is not exploitable. But it means the safety of §1.3 rests on
a *button*, not on the render. **Deleting the branch removes that dependency
entirely**, which is a second reason to delete rather than leave it fenced.

---

## 2. What is NOT Drive — the red herring this design must not repeat

**Setlist import from Google Sheets does not use Google OAuth.**
`app/api/sheet/route.ts:29` is a bare `fetch(csvUrl)` against the sheet's public
CSV export, with no `Authorization` header; the caller at `page.tsx:6022` sends
none either. It requires only that the sheet be shared publicly.

**Retiring Drive cannot break setlist import.** They share the word "Google" and
nothing else.

*Recorded as its own section because the two were conflated during the very
conversation that produced this document, and the conflation cost a full
investigation into a Google OAuth outage that did not matter. That is precisely
the "red herrings cost us time" Graham named when ruling.*

---

## 3. Deletion surface

### 3.1 Whole files

| Path | Lines | Note |
|---|---|---|
| `app/api/auth/google/route.ts` | ~38 | OAuth consent redirect |
| `app/api/auth/google/callback/route.ts` | ~66 | token exchange |
| `app/api/drive/route.ts` | — | chart search |
| `app/api/drive/batch/route.ts` | — | the resolve endpoint (`page.tsx:5884`) |
| `app/api/drive/download/route.ts` | — | byte proxy + PDF export |
| `app/api/drive/setup/route.ts` | — | role-folder creation (`page.tsx:5997`) |
| `lib/drive.ts` | 97 | `driveQuery`, `driveQueryAll`, `normalize`, `DriveAuthError`, `DriveFile`, `EXPORT_MIME_TYPES` — but see §4.1 |

### 3.2 Within `app/[owner]/[show]/page.tsx`

Roughly **71 lines** carry `googleToken`/`GoogleToken`/`googleError` and their
Drive-only companions:

- `:158` `interface GoogleToken`; `:164` `getGoogleToken`; `:176`
  `saveGoogleToken`; `:180` `clearGoogleToken`; `:324` `initGoogleToken` (the
  `#google_auth=` hash handler); `:353` the `googleToken` state
- `:5873` `canResolveCharts`, `:5879` `resolveCharts`, `:5936` the resolve effect
  (including the chart-wipe at `:5941`), `resolveVersionRef` / `prevSignatureRef`
  / `resolveTimerRef`
- `:5987` `handleSetupDrive`, `:5973` `parseFolderId`, `folderIdInput`,
  `driveSetupLoading`, `driveError`
- `:6560-6653` the entire Drive section JSX, including the `<details>` how-to
- the `accessToken` prop threaded into `PerformTab` (`:848`), `MixTab` (`:851`)
  and the chart viewer (`:2720`, `:3475`, `:3569`, `:3689`)
- `config.chartsRootFolderId` (`:152`) and every read of it

### 3.3 Branches inside surviving files

| File | Branch |
|---|---|
| `lib/chart-cache.ts:129-146` | the Drive proxy arm and the "Drive chart but no token — skip" arm; the Supabase arm at `:125` becomes unconditional |
| `lib/pdf-viewer.ts:78-86` | the `else` Drive-proxy arm — **but see §4.2, this is not a plain delete** |
| `lib/chart-converter.ts:9, :82` | the `EXPORT_MIME_TYPES` import and exemption — see §4.1 |

### 3.4 ★ What must NOT be deleted

- **`Chart.fileId` and `Chart.mimeType` (`lib/types.ts:59-60`).** `fileId` is
  dual-purpose: *"Drive file ID (for offline cache); **for library charts =
  chart_library.id**"*. It is load-bearing for `chartCacheKey`. Removing it
  breaks caching for every surviving chart.
- **`lib/normalize.ts`.** Distinct from `lib/drive.ts`'s `normalize`. The
  setlist/library matcher uses `normalizeSongKeySafe` from the former; only the
  Drive routes use the latter.
- **`app/api/sheet/route.ts` and `lib/setlist-import.ts`** — §2.

---

## 4. The three couplings that need rulings

### 4.1 ★★ `EXPORT_MIME_TYPES` has a consumer outside Drive, and a Tier-1 test pins it

`lib/drive.ts:23` exports a map of Google-native MIME types the Drive API can
export to PDF. It has **three** consumers:

1. `app/api/drive/download/route.ts:48` — dies with Drive.
2. `lib/chart-converter.ts:82` — `if (EXPORT_MIME_TYPES[mimeType]) return false;`
   inside `isUnsupportedChartMime`. **Survives Drive.**
3. `tests/tier1-loud-failures.test.ts` — three cases (`:30`, `:41`, `:52`) assert
   the map's behaviour and pin its exact contents by name.

**What contract does that test encode?** Test 4 is *"the viewer can say WHY a
legacy chart will not render."* Its `:30` case — *"★★ does NOT flag a
Google-native type — the proxy exports it to PDF"* — exists because a previous
review caught the viewer refusing exactly the charts the export path existed to
serve. The comment at `lib/chart-converter.ts:62-68` records that as a retraction.

**⇒ The exemption is conditional on the proxy existing.** Once
`/api/drive/download` is gone, nothing can turn a Google-native MIME into
renderable bytes, so *"does not flag it as unsupported"* becomes **wrong** — the
viewer would promise a render it cannot perform, violating invariant 2.

**PROPOSED RULING:** delete `EXPORT_MIME_TYPES` with `lib/drive.ts`, delete the
exemption at `chart-converter.ts:82`, and **invert** the three test cases: a
Google-native MIME must now be flagged **unsupported**, with the reason naming
that the Drive export path was retired. This is a **deliberate behaviour change**
and the only one in this document.

*Open question Q1 (§7): is inverting correct, or should a Google-native MIME be
impossible-by-construction instead — i.e. can a `chart_library` row even hold
one? If the upload guard already rejects them, the cases should be deleted
rather than inverted. **I have not measured the upload guard; do not build this
sub-section until it is measured.***

### 4.2 `lib/pdf-viewer.ts`'s `else` is a catch-all, not a Drive branch

```ts
if (chart.url && chart.url.includes('/storage/v1/object/public/')) {
  res = await fetch(versionedChartUrl(chart));
} else {
  // Legacy Drive charts — go through the proxy
  res = await fetch('/api/drive/download', { … });
}
```

The `else` catches **any** chart whose URL is not a Supabase public URL — not
only Drive charts. Deleting the arm without replacing it would leave a `fetch` to
a deleted route (a 404 swallowed by the surrounding `catch`, returning `null`
silently).

**PROPOSED RULING:** replace the `else` with an explicit `return null` and route
the reason through the same "why this will not render" surface test 4 covers.
Same treatment in `lib/chart-cache.ts`, where the equivalent arm already has a
"skip" path that must become a stated failure rather than a silent one.

### 4.3 `chartsSource` in the show file

`lib/show-file.ts:56` writes `chartsSource: { provider: 'drive', folderId }` on
export; `:100` reads it back.

**Graham ruled 2026-08-25** that the show file is a **desk-handoff artifact** —
inputs, monitors, stage plot — and that chart-library export is separate work.

**★ Note the pre-existing asymmetry**, which is not caused by this change:
`serializeShow` (`show-file.ts:50`) destructures `charts` out of every setlist
song, so **library charts have never survived export**. Only the Drive folder
pointer did.

**PROPOSED RULING:** stop **writing** `chartsSource` on export; keep **reading**
it as a no-op on import so pre-existing `.yaml` files still load (invariant 3).
Do not add a library-chart export here — that is the separate task.

---

## 5. What survives, and one claim that is not yet closed

**Survives untouched:** setlist import (§2); the library upload/attach path;
`chart_library`; Supabase-backed chart rendering and caching; the builder;
calibration; everything in Perform and Mix that reads a Supabase chart URL.

### 5.1 ⚠ `OfflineSection` — gated on a runtime observation not yet made

`page.tsx:6657` gates `OfflineSection` on the same `!showId`, so by §1.3 it is
**equally unreachable** and goes out with the branch. Its comment says why:
*"Drive/anonymous only — Supabase shows auto-cache on load."*

The replacement is real in code: `page.tsx:491-499`, on the main load path,
*before* the auth check, filters the setlist to `/storage/v1/object/public/`
charts and calls `downloadAllCharts(supabaseCharts, null, …)`. Passing `null` as
the token means it takes the no-auth Supabase arm of `chart-cache.ts:125`.

**This claim is NOT verified at runtime, and this section must not be built
until it is.** Two reasons it could not be closed while writing:

- `tests/chart-cache.test.ts` covers only `chartCacheKey` and
  `versionedChartUrl` — **`downloadAllCharts` has no test**, and neither does the
  on-load effect.
- Local dev cannot reach Supabase; `.env.local` holds placeholder keys.

**The check:** open a show, let Perform load, then either inspect DevTools →
Application → Cache Storage, or go offline and open a chart. If charts render
offline, the claim is closed and `OfflineSection` may be deleted. **If they do
not, removing `OfflineSection` is a gig-day regression** and this section must be
re-designed instead.

---

## 6. Build order

Each chunk is independently shippable and independently revertable.

| # | Chunk | Ships | Depends on |
|---|---|---|---|
| 1 | **Delete the unreachable UI branch** | §3.2 in `page.tsx` — the Drive section, the resolve effect, the `googleToken` plumbing, `chartsRootFolderId` | nothing. **§5.1's check gates `OfflineSection` only**; the rest may ship without it |
| 2 | **Delete the routes and `lib/drive.ts`** | §3.1 in full, plus the §3.3 branches and the §4.1/§4.2 rulings | chunk 1 — no callers may remain |
| 3 | **Show-file `chartsSource`** | §4.3 | independent |
| 4 | **Infrastructure** (Graham's action, not a code change) | remove `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` from Vercel; decide whether to delete the Google Cloud OAuth client or leave it dormant | chunks 1–2 deployed |

### 6.1 ★ Ordering against the `admin_config` decision

Graham ruled 2026-08-25 that **`admin_config` is not worth building** — with
Drive gone its allowlist holds one key, `claude_tryit_key`, which already
resolves through the `CLAUDE_TRYIT_KEY` env fallback.

**Drive retirement lands FIRST, deliberately.** `getAllAdminConfig` and the
`allowedKeys` array in `app/api/admin/settings/route.ts` both enumerate
`google_client_id` and `google_client_secret`. Amending
`design-single-backend.md` before those keys are gone would mean authoring a
specification around two values about to be deleted — a stale restatement
written on purpose.

---

## 7. Open questions

- **Q1 — §4.1: invert the Tier-1 cases, or delete them?** Depends on whether the
  chart upload guard can even accept a Google-native MIME. **Unmeasured.** Needs
  measuring before chunk 2, not before review.
- **Q2 — §5.1: does auto-cache actually work?** Graham's 20-second browser check.
  Gates the `OfflineSection` deletion only.
- ~~**Q3 — the dormant OAuth client.**~~ **RULED by Graham 2026-08-25: PRESERVE
  the client, dormant.** Remove only the Vercel env vars. Deleting it would make
  re-adding Drive a fresh setup — new client, new redirect URIs, new consent
  screen — and defeat the "easy to add back" that motivated the retirement. See
  §9 for the disclosure this ruling requires.
- **Q4 — does anything else read `Chart.mimeType`?** §3.4 keeps it for
  `chartCacheKey`, but its *only* stated purpose in `types.ts:60` is *"original
  MIME type (for export detection)"* — an export path that is being deleted.
  Worth a sweep before chunk 2; it may be removable, or it may have picked up a
  library consumer.

---

## 8. Tests

**Chunk 1:** a source-level assertion that no file under `app/` references
`chartsRootFolderId` or `googleToken` — the same shape as chunk 0's
`redis-retirement.test.ts` guard, which is the pattern that proved a deletion
stays deleted.

**Chunk 2:** `grep -rn "from '@/lib/drive'"` returns nothing; no file under
`app/api/` matches `drive` or `auth/google`. Plus the §4.1 cases in their ruled
form and a case that a non-Supabase chart URL now fails **loudly** (§4.2), which
is the only new behaviour this design introduces.

**Chunk 3:** round-trip — a `.yaml` containing `chartsSource` imports without
error and re-exports without it.

**Regression guard, all chunks:** `tests/setlist-import.test.ts` and
`tests/sheet-route.test.ts` must pass untouched. If a Drive change requires
editing either, the change is wrong (§2).

**Delta measured on both refs immediately before each PR body is written, never
quoted from notes** (`feedback_report_test_delta`).

---

## 9. ★★ Tombstones — normative, required by the Q3 ruling

Graham ruled 2026-08-25: preserve the Google Cloud OAuth client dormant, and
**comment the fact clearly — in this document and adjacent to the code.**

### 9.1 The code is DELETED, not commented out

Stated explicitly because "adjacent to the commented-out code" admits two
readings, and they contradict each other. Graham also ruled *"we should remove
the dead code"* in the same conversation. **Commented-out code is dead code that
survives review** — it is exactly the artifact §2.1 of `design-single-backend.md`
was written to stop.

**⇒ Delete the code. Git preserves it. Leave a tombstone COMMENT at each seam a
future reader will actually land on.** A tombstone is one to four lines naming
what was removed, when, why, and where to find the design — never the removed
code itself.

### 9.2 Required tombstone sites

Each of these is a place where a reader encounters a shape that only makes sense
if they know Drive existed. A tombstone is **required** at each; wording may vary,
content may not.

| Site | Why a reader lands here confused |
|---|---|
| `lib/chart-cache.ts` — at the now-unconditional Supabase fetch | the `if` collapses to a single arm; the vanished `else` is the question |
| `lib/pdf-viewer.ts` — at the §4.2 `return null` | a bare "give up" needs its reason stated, or someone will "fix" it back into a proxy call |
| `lib/chart-converter.ts` — at `isUnsupportedChartMime` | §4.1 inverts a rule whose original justification is now invisible |
| `lib/show-file.ts` — at the surviving `chartsSource` **read** (`:100`) | a read with no matching write reads as a bug, not as deliberate back-compat (§4.3) |
| `app/api/admin/settings/route.ts` — at the `allowedKeys` array | two keys leave it; the shrunken list is the whole argument for §6.1 |

### 9.3 The dormant-client tombstone — content requirements

At least one tombstone — **`lib/chart-cache.ts` is the natural home**, being the
first file a chart-loading investigation reaches — must additionally record:

1. The Google Cloud **OAuth client still exists and is deliberately dormant.**
2. **`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` were removed from Vercel**, so
   re-enabling means restoring env vars, not creating a client.
3. The **redirect URI** the preserved client expects:
   `<origin>/api/auth/google/callback` — the value `app/api/auth/google/route.ts`
   constructed. Recorded because it is the one piece of configuration that is
   invisible from the code once the code is gone.
4. A pointer to **this document** and to the retiring commit.

**⚠ A tombstone must not name a secret, an account, or a Cloud project ID.** It
records that a client exists and how to re-point it — never how to authenticate
as it.

### 9.4 The document side of the ruling

This file is the durable record: §7 Q3 carries the ruling, §9.3 carries the
re-enable facts. **`docs/reference_doc_locations.md`-style indexes are not a
substitute** — a reader deleting a `fetch` will not consult an index. The
tombstone has to be where the confusion happens.
