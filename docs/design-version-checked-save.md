# Version-checked show save (UAT S5, and S3 rebuilt on it)

**Status:** BUILT (2026-10-27, branch `opus/s5-build`) — Q1–Q5 ruled by Graham 2026-10-27 (§10); Codex R1–R5 folded, R6 = GO. Migration `018` must be applied BEFORE the code deploys (Q4, §9). As-built notes are marked **As built** below.
**Supersedes:** the client-side reconcile in PR #200 (`lib/offline-sync.ts` `reconcileOnLoad`,
the set-aside store and its Restore/Discard banner, the page's reconnect effect). #200's S2 (offline owner editing) and S4 (flush on page hide)
stand; its S3 is rebuilt on §3–§5 once this merges.

## 1. Why

Today the server accepts any show save, whatever version it was based on. Every way a
stale copy overwrites a newer one comes down to that:

- **S5:** the same owner on phone and laptop. Each save replaces the whole show, so the
  later one silently undoes the other.
- **Codex R1 on #200** found four more, all on ONE device, all variants of the same gap:
  1. a cached copy opened offline is PUT before the reconnect check finishes;
  2. an edit made during the reconnect check is replaced by the server copy;
  3. two PUTs from one tab land out of order, and the older wins;
  4. a failed set-aside write loses the only copy of offline edits.

The client cannot close 1–3: it cannot see what reaches the server between its own reads
and writes. **The server has to be the arbiter.** Hence this design rather than more
client hardening (Graham, 2026-10-27: option A).

## 2. The invariant

> **A save is applied only if the show is still at the version the client's copy was
> based on. Otherwise the server refuses it, and the client never drops either copy
> without the owner choosing.**

Compare-and-set on `shows.updated_at`, which the `set_shows_updated_at` trigger
(`moddatetime`, `001_initial_schema.sql:25`) already bumps on every UPDATE.

## 3. Server

### 3.1 What the version must cover (revised after Codex R1 on #201)

A show save writes the `shows` row AND, for a migrated show, rebuilds its
`setlist_entries` with overrides computed against the song library
(`app/api/shows/update/route.ts:151`), auto-creating a song by title when one can't be
resolved (`:95`). So a stale tab can reverse more than the show row: a library key
change becomes a show override, and a deleted song can be recreated. **The version must
therefore move whenever anything a show save can echo back changes** — not only when the
`shows` row is written.

Every writer, enumerated (`grep "from('shows')"`, `from('songs')`, `setlist_entries`, `scripts/`, migrations):

| Writer | Touches | Under this design |
|---|---|---|
| `PUT /api/shows/update` → `rpc_save_show` | `shows`, `setlist_entries` | **checked** (§3.2) |
| `PUT /api/shows/update`, legacy direct `.update()` | `shows` | **checked** (§3.3) |
| `/api/songs/update` (title/artist/key/lead/notes/bpm) | `songs` | bumps every show that references the song on title/key/lead/notes (§3.5); not artist or bpm, which a show save never writes |
| `/api/songs/delete` → `rpc_delete_song` | `setlist_entries`, `songs` | bumps the affected shows via the entries trigger (§3.5) |
| `app/api/admin/migrate-setlists`, `scripts/migrate-setlists.ts` | `songs`, `setlist_entries`, `shows` | **retired** — deleted in the build PR (§3.6) |
| `POST /api/shows` (create), `/api/shows/delete` | insert / delete | unchanged; create marks an empty-setlist show migrated (§3.6) |
| `/api/charts/roadmap/save` | reads `songs` only | n/a |

### 3.2 `rpc_save_show` — migration `018_show_save_version.sql`

Adds `p_base_updated_at timestamptz` (last parameter, NO default, so a caller cannot
forget it). Inside the function, before any write:

```sql
select owner_id, updated_at into v_owner_id, v_current
  from shows where id = p_show_id
  for update;                                    -- serialises concurrent saves
if not found then raise exception 'Show not found'; end if;
if v_current is distinct from p_base_updated_at then
  raise exception 'show changed since %', p_base_updated_at using errcode = 'PT409';
end if;
```

Same `PT409` convention as `save_builder_chart` (016/017). The rest of the body is
unchanged. `revoke … from public, anon, authenticated; grant … to service_role;` and
`set search_path = public` are re-stated (a `create or replace` with a new signature is a
NEW function: the old 7-arg one is **dropped** in the same migration, so nothing can call
the unchecked version).

**Exact comparison.** Postgres compares microseconds. The client must send back the
exact string the server gave it (§4.1), never a value that has been through `Date`,
which truncates to milliseconds. (#200's `sameInstant` did exactly that, and is deleted.)

### 3.3 Legacy path

The route checks ownership explicitly FIRST, for both paths, with the admin client —
as the entries path already does (`route.ts:42-60`): no row → 404, not the owner → 403.
Only then:

```ts
.update(updatePayload).eq('id', id).eq('updated_at', base).select('updated_at, slug')
```

With ownership already proven, zero rows means the version moved (or the show was deleted
in between) → **409** (a deleted show then 404s on the GET that follows). No RLS
inference: a collaborator, who can READ the row at the matching version but not update it
(`014_collaborator_view_only.sql:80`), has already been refused 403 by the explicit check.

### 3.4 The route's contract

| Request | Response |
|---|---|
| `base_updated_at` matches | 200 `{ updated_at, slug }` (as today) |
| `base_updated_at` stale | **409** `{ error: 'This show was changed somewhere else.', conflict: true }` |
| `base_updated_at` missing | **428** `{ error: "This page is out of date and your last change was NOT saved. Reload, then make it again." }` |

428, not "accept unchecked": an old bundle (a PWA can keep one for days) would otherwise
keep doing exactly the blind overwrite this exists to stop. An old client renders `error`
in its pill as-is, so the message reaches the user with no client change (Q1, ruled).

**The old tab's rejected edit is NOT recovered automatically** (Codex R1 on #201): the old
bundle caches it without a marker, and the reload overwrites that cache. Recovering it
would need server-side storage of rejected payloads, or guessing from an unmarked cache —
which also fires on every stale cache that holds no edit at all. Per Graham's rule (§5),
the person is told plainly what was lost and redoes it: the loss is bounded to edits made
in a tab opened before the deploy, and it is never silent.

### 3.5 Library changes move the version — migration `018`

Two trigger functions, `security definer`, `set search_path = public`, execute revoked
from `public`/`anon`/`authenticated`:

- **Lock order.** `rpc_save_show` locks the show, then rewrites its entries. `rpc_delete_song`
  deletes entries first, and the entries trigger would then lock the show — the opposite
  order, so the two can deadlock (Codex R2 on #201; Postgres aborts one, so it fails loud,
  not silent). `018` re-states `rpc_delete_song` to lock the affected shows `FOR UPDATE`
  (ordered by id) **before** deleting entries, so both take show-then-entries.
- **`setlist_entries`** — AFTER INSERT / UPDATE / DELETE, statement-level with transition
  tables: `update shows set updated_at = now() where id in (affected show_ids)`. Covers
  `rpc_delete_song` and any future entries writer. Inside `rpc_save_show` it touches the
  row the function already holds `FOR UPDATE`, in the same transaction, to the same
  `now()` — the returned `updated_at` is unchanged.
- **`songs`** — AFTER UPDATE OF `title, key, lead, notes`, `when (old.* is distinct from
  new.*)` on those columns: bump every show with an entry for that song. **Not `bpm`**: a
  show save never writes bpm (entries carry key/lead/notes only), so a stale tab cannot
  reverse it, and the show page's own BPM writer must not 409 its own next save.

A stale show tab after a library edit therefore gets a 409, and §5 asks the owner. *Use
the saved one* shows the new library values; *Keep mine* re-applies the stale ones as
overrides — knowingly. A deleted song is the same: *Keep mine* recreates it by title,
because that is the setlist the owner chose to keep.

### 3.6 Retired and tightened

- **`app/api/admin/migrate-setlists` and `scripts/migrate-setlists.ts` are deleted.** They
  were the one-off song-library rollout. Prod, read 2026-10-27: `select setlist_migrated,
  count(*) from shows` → `t | 8`, nothing left to migrate. Both did read-then-replace of
  entries with no version check (Codex R1 on #201, finding 2); deleting them is cheaper
  than checking them.
- **`POST /api/shows` never creates a legacy show** (Codex R2 on #201). Today a request
  with a non-empty `config.setlist` and no `setlist_songs` takes the plain insert
  (`app/api/shows/route.ts:117`), leaving a show with no entries for §3.5 to track — the
  dashboard always sends `setlist_songs`, but the API and an older cached client need not.
  After: a non-empty `config.setlist` with no `setlist_songs` has `setlist_songs` derived
  from it server-side (title/key/lead/notes/sceneNote per row — `sceneNote` too, since the
  RPC stores `scene_note` and rebuilds `config.setlist` from entries (`007`), so an omitted
  field would drop an old client's scene notes; Codex R3 on #201) and takes the RPC path, with the same
  400 for an unnormalizable title that an explicit `setlist_songs` gets. An empty setlist
  still takes the plain insert, now with `setlist_migrated = true` (nothing to migrate).
  So no new legacy show can appear, and §4.4's migration-timing change (Q2) affects none.

## 4. Client (`lib/use-show.ts`)

### 4.0 One editing tab per show (Codex R5 on #201; Q5, ruled)

Everything in §4 reasons about one tab, but the cache entry and marker are per browser:
every tab of a show shares `showrunr-cache-{id}` while each keeps its own pending copy
and sequence (`lib/use-show.ts:33`, `:154`). With two tabs, any per-tab rule writes over
the other tab's unsynced copy — a success clearing it (R5), an ordinary edit replacing it
(`:154`), or a page load caching the server copy over it (`app/[owner]/[show]/page.tsx:583`).
Rather than a rule per path, remove the second writer:

1. **The show's storage entry is written only by the tab holding that show's lock**
   (`navigator.locks`, name `showrunr-edit-{id}`, held for the life of the page). This
   covers every write: edit cache, marker, base, step 4's refresh, and the load-time cache.
2. **Owner tabs request the lock on open, before the load writes anything** (`ifAvailable`
   for an immediate answer; a tab that misses queues a waiting request). The holder edits as §4.1–§4.5 describe. A tab
   that doesn't get it is **view-only** and writes nothing: banner "This show is open for
   editing in another tab." with **Edit here**.
3. **When the holder closes**, the browser releases the lock and a waiting tab takes it,
   then runs the normal on-load path (§4.5: marker set → show the cached copy, send it).
4. **Edit here** takes the lock (`steal: true`) after a confirm. The old tab drops to
   view-only at once: it cancels its debounce timer and held retries, sends nothing
   further, and never writes storage again — including when its in-flight save returns. Its latest edit is already in the entry (edits cache immediately), so the new
   tab sends it; if the old tab's save lands first, the new send either matches it
   (adopted silently) or 409s and the owner is asked. Nothing is lost silently. Needed
   because on a phone the other tab may be frozen in the background, not findable.
5. **Non-owner tabs** never take the lock and never write a show entry that carries a
   marker.
6. **No `navigator.locks`** (Safari < 15.4, Firefox < 96, non-HTTPS): edit as today.
   Documented limit — two tabs of one show on such a browser can lose an unsynced edit.

With one writer per browser, §4.2's per-tab "nothing pending" IS the browser's state, so
§4.2a step 4 holds as written. Cross-DEVICE remains the server's job (§3, 409).

**Known wart, not loss:** a tab closed while edit A is in flight and B is pending leaves
{B, old base}; the next open sends it, 409s against A, and asks "changed on another
device" about the owner's own work. *Keep mine* is the right answer and is offered.

### 4.1 The base

`useShow` holds `base` — the `updated_at` string of the server version this browser's
copy is built on. It is set from the show GET (which must return `updated_at`: #200 adds it, unmerged — the build carries it either way) and replaced
by each successful save's response. It is stored verbatim with the cache
(`showrunr-last-saved-{id}`, already written) so an offline-opened copy knows its base.
**As built:** base, copy AND the unsynced marker are one entry, `showrunr-show-{id}`
(`lib/show-store.ts`, `{v: 2, config, base, unsynced}`) — a NEW key, so an old bundle the
service worker still serves offline never reads the new format as a show. The old
`showrunr-cache-{id}` (bare config) is read as a fallback and removed on the first write;
neither it nor `showrunr-last-saved-{id}` is written any more. **Upgrade (Codex R1 on #202):**
that old bundle cached each edit before its 2 s debounce, so its copy may hold an edit that
never reached the server (a reload inside the debounce cancels the unload save). The owner
tab classifies it against the fresh load: same content → clean; different → unsynced, with
the old bundle's last-saved version as its base — so it saves if the server is still there,
else 409/§4.3 asks. This also changes §3.4: a 428'd old tab's edit is in that old cache,
so the reload its message asks for now recovers it (saved, or the owner is asked) — while
the 428 copy (Q1) still says to make the change again. Open question for Graham (Q6). Also as built: an owner tab is
read-only until its lock is granted (§4.0; the grant is asynchronous).

### 4.2 One save in flight

At most one PUT per show at a time. Edits during a save update the pending copy; when
the save returns, the latest pending copy goes next **with the new base**. This is
Codex finding 3: out-of-order PUTs become impossible, and a tab never conflicts with
itself.

**The marker rule, explicitly (Codex R1 on #201, finding 3):** every cached edit bumps an
edit sequence (#200's `editSeq`, kept in the rebuild). A save's success clears the unsynced
marker **only if it carried the latest sequence and nothing is pending**. Otherwise the
marker stays and the pending copy goes next. The same rule governs the 409 path: an edit
made while §4.3's GET is in flight bumps the sequence, so step 3's "equal content → clear"
compares and clears against the LATEST copy at the moment the GET returns, never the one
that was sent.

### 4.2a Persistence failures are loud

Everything above assumes the owner's copy is in the cache under a marker. Storage can
refuse either write (quota, private mode, blocked site data), and #200 swallowed both
(Codex R2 on #201). Rule:

   **As built:** the marker lives IN the entry (§4.1 note), so steps 1 and 3 hold by
   construction — one `setItem`; a write that throws leaves the previous entry whole.
1. **Marker first, then cache.** If the cache write then fails, the marker sits over the
   previous copy — which is still a correct thing to recover, never a newer one lost.
2. **Either write throwing is shown, not swallowed:** the pill reads "Couldn't keep your
   changes on this device — keep this page open until they save." Saving to the server
   carries on unchanged; once the latest edit is confirmed the warning clears with it.
3. A failed marker write never lets the next load treat the cache as clean: the load
   reads the marker, and a missing marker over a cache that holds the owner's edit is
   exactly the case step 2 has already told the owner about.
4. **Adopting a new base rewrites the cache entry before the marker moves** (Codex R3 + R4
   on #201). Show and base are ONE storage entry (§4.1), so they never disagree. The entry
   written is the **latest local copy** with the new base: the pending copy if an edit is
   newer than the one confirmed (§4.2's sequence), else the confirmed show. Never the
   confirmed show over a newer pending edit.
   - **Nothing pending:** write {confirmed show, new base}, then clear the marker and store
     the base. If the write throws, delete the entry (no cache is safe: the next load
     fetches; a stale one beside a fresh base is not). If the delete also throws, what
     remains is the previous show with its previous base, whose next send 409s and the
     owner is asked (§5).
   - **An edit is pending:** write {pending copy, new base}; the marker stays (§4.2) and
     the pending copy goes next with that base. If the write throws, leave the entry
     untouched: it holds the pending copy cached at edit time with its OLDER base (or, if
     that write failed too, step 2 has already warned), so a reload sends it, gets a 409,
     and the owner is asked. **An entry holding an unconfirmed edit is never deleted.**
   - *Use the saved one* (§5) is the only path that replaces the owner's copy with the
     server's, because the owner chose to discard it.

### 4.3 A 409

1. Stop sending. Keep the unsynced marker and this browser's copy, untouched.
2. GET the show (server copy + its `updated_at`).
3. If the server copy has the same content as this browser's (charts aside — the
   comparison #200 already has), there is nothing to choose: adopt the new base, clear
   the marker, done. This covers the admin migration, a keepalive save that landed after
   its page died, and the same edit made on two devices.
4. Otherwise **the owner chooses** (§5). Until they do, this browser's copy stays on
   screen, saves are held, and the pill reads "Not saved".

Nothing is written to storage on a conflict, so nothing can fail to be written: the
owner's copy is the cache it already was, under a marker that only a choice clears
(Codex finding 4 has nothing left to act on).

### 4.4 Only real changes are sent

A save is sent only when the content differs from the last version confirmed by the
server. Without this, the save every load makes would 409 against any newer version and
raise a restore prompt for edits nobody made (Codex finding 1).

**Behaviour change (Q2, accepted).** Today that load-save is also when an un-migrated
owner's setlist migrates to song references (`shouldSendEntries`, `lib/overrides.ts:20`).
After this, migration happens on the owner's first real edit instead. Nothing reads
differently in the meantime: the GET serves both shapes.

### 4.5 Offline and reconnect — no special path

There is no reconnect reconcile any more. The unsynced copy is simply the pending save,
and it carries its base. When the network returns (or on the next edit or load), it is
sent, and the server decides: 200 means it was safe, 409 runs §4.3. The page's
reconnect effect, `reconcileOnLoad` and the "online" special-casing from #200 are deleted
(Codex findings 1 and 2 have no window left to happen in).

**On load** with an unsynced marker: show this browser's copy, and send it with the
marker's base. A 409 runs §4.3 — the copy stays on screen and the owner is asked. A
reload before choosing simply asks again: the conflict is rediscovered, not stored.

**Triggers for retrying a held save:** `online`, `visibilitychange` → visible, and the
next edit. No timer loop.

## 5. The owner chooses (Q3, ruled)

Graham, 2026-10-27: *"don't over-engineer something that is easier for a human to
arbitrate or execute."* In v1 a conflict is one person on two devices — the laptop at
home, the phone at the gig. Neither copy is somebody else's work, so no rule should pick
for them, and their screen must not change under them mid-gig.

- **Banner** (owner only, persistent while held): "Not saved: this show was changed on
  another device." **Keep mine** · **Use the saved one**, each confirmed:
  - *Keep mine* — "Replace the saved version with yours? The changes made on the other
    device are discarded." Sends this copy with the server's CURRENT base (from §4.3
    step 2), so it wins knowingly. If a third save landed meanwhile it 409s again and the
    owner is asked again — correct, since there is something new to decide about.
  - *Use the saved one* — "Discard your unsaved changes and use the saved version?"
    Shows the server copy (today's charts reattached, `withLibraryCharts` from #200),
    writes it to the cache, adopts its base, clears the marker.
- **Edits while held** are kept on screen and in the cache and stay unsent; *Keep mine*
  then sends the latest.
- **One pending copy, ever.** There is no set-aside store and no list: the copy on screen
  IS the unsaved copy.
- **The trade-off, accepted:** until the owner chooses, viewers (bandmates) see the saved
  version, which differs from the owner's screen. The banner says so.

## 6. What this does not do

- **No merge.** A conflict is whole-show: keep one, set the other aside. Field-level
  merge is a feature, not this fix (§5 keeps it a human choice).
- **No live updates.** A second device learns of a change only when it next saves (or
  reloads). Realtime push is separate.
- **Collaborators** stay read-only (§3.3c); nothing here grants a write.

## 7. Codex R1 on #200 → where each finding closes

| # | Finding | Closed by |
|---|---|---|
| 1 | cached copy PUT before the reconnect check | §4.4 (unchanged ⇒ not sent) + §3 (a stale send is refused) |
| 2 | edit during the reconnect GET replaced | §4.5 (there is no reconnect GET) |
| 3 | out-of-order PUTs, marker cleared early | §4.2 (one in flight) + §3 (an older base is refused) |
| 4 | set-aside write failure / overwrite | §4.3 + §5: no set-aside store exists; the owner's copy stays the cache under a marker only a choice clears |

**Codex R1 on #201:**

| # | Finding | Closed by |
|---|---|---|
| 1 | a stale show save reverses a library change / recreates a deleted song | §3.1 + §3.5: library changes move the version; the owner arbitrates |
| 2 | admin migration replaces a successful save; script missing from the inventory | §3.6: both retired; no unmigrated shows exist |
| 3 | an older save's success clears the marker | §4.2 marker rule (latest sequence only, incl. during the 409 GET) |
| 4 | old tabs' rejected edit lost on reload | §3.4: not recovered, but never silent — the 428 says it was not saved |

**Codex R2 on #201:**

| # | Finding | Closed by |
|---|---|---|
| 1 | a failed marker/cache write silently loses the recovery path | §4.2a: marker first; any persistence failure is shown |
| 2 | API / old client can still create a legacy show | §3.6: derived `setlist_songs`, RPC path; empty setlist created migrated |
| — | `rpc_delete_song` vs `rpc_save_show` lock order (non-blocking) | §3.5: delete locks shows first |
| — | collaborator at the matching version | §3.3: explicit owner check before either path |

**Codex R3 on #201:**

| # | Finding | Closed by |
|---|---|---|
| 1 | after a failed cache write, a later success leaves a stale cache beside the new base | §4.2a step 4: refresh (or delete) the cache before clearing the marker / storing the base |
| 2 | derived `setlist_songs` drops `sceneNote` | §3.6: `sceneNote` derived per row |

**Codex R4 on #201:**

| # | Finding | Closed by |
|---|---|---|
| 1 | R3's cache refresh overwrites a newer pending edit with the confirmed show; a reload loses it silently | §4.2a step 4: the entry is always the LATEST local copy; an entry holding an unconfirmed edit is never deleted |

**Codex R5 on #201:**

| # | Finding | Closed by |
|---|---|---|
| 1 | a tab's success clears another tab's unsynced copy (shared entry, per-tab state) | §4.0: one lock-holding writer per show per browser — also closes two paths found in self-review: another tab's edit (`use-show.ts:154`) or page load (`page.tsx:583`) overwriting an unsynced copy |

## 8. Tests (written with the build)

- **SQL** (run against a scratch DB through psql, recorded in the PR): matching base
  saves; stale base raises `PT409`; two concurrent `rpc_save_show` with the same base →
  exactly one succeeds (the `FOR UPDATE`); the old 7-arg signature no longer exists;
  `has_function_privilege` for `anon`/`authenticated` is false, for `service_role` true.
- **Route:** 200 / 409 / 428 on both paths; owner check before either path (collaborator →
  403 even at the matching version); legacy 0-row → 409.
- **Triggers (SQL):** an entries insert/delete bumps its show; a song key/title/lead/notes
  change bumps every show referencing it, a bpm-only change bumps none; `rpc_delete_song`
  bumps the affected shows; inside `rpc_save_show` the returned `updated_at` equals the
  row's final value.
- **Create:** an empty-setlist show is created `setlist_migrated = true`; a non-empty
  `config.setlist` without `setlist_songs` goes through the RPC with derived songs, and a
  row's `sceneNote` survives into the stored entry and the rebuilt `config.setlist`.
- **Persistence:** a throwing marker write or cache write sets the "Couldn't keep your
  changes on this device" pill; the marker is written with the cache (one entry, as built). On a save's
  success (and the other base-adopting paths) with a cache write that throws, the cache
  entry is gone — never the previous show beside the new base — before the marker clears.
  Edit A in flight, edit B made, A succeeds: the entry holds {B, A's base} and the marker
  stays; with that cache write throwing, the entry still holds B (older base) and a reload
  409s and asks. A reload before B's request completes never loses B.
- **Lock order (SQL):** concurrent `rpc_save_show` and `rpc_delete_song` on the same show
  both complete (no deadlock), one after the other.
- **Hook:** one save in flight (a second edit waits, then goes with the new base); 409 →
  GET → equal content adopts silently; 409 → different content holds saves, keeps this
  copy on screen and the marker set; edits while held are cached, not sent; *Keep mine*
  sends the latest with the server's current base (and a further 409 asks again); *Use
  the saved one* adopts the server copy and clears the marker; unchanged content is never
  sent; a held-for-network save retries on `online` / visible / next edit.
- **Reload while held:** the marker survives; the load's send 409s; the owner is asked again.
- **Tabs (§4.0):** a second owner tab of the same show is view-only and writes nothing to
  storage (edit cache, marker, base, load-time cache); closing the first hands the lock to
  the second, which sends the marked copy; *Edit here* drops the first to view-only and
  its in-flight save's response writes nothing; R5's scenario (A saving, B cached then
  closed) ends with B sent or asked about, never cleared; no `navigator.locks` → today's
  behaviour.

## 9. Rollout

1. Merge this design.
2. Build PR: migration `018` (RPC check, both triggers, grants) + route + hook + the
   create-path change + deletion of both migration tools, rebased with #200's S2/S4. Codex.
3. On Graham's go: apply `018` through psql **before** the deploy (`project_showrunr_reference`:
   migrations run first). Between apply and deploy the OLD route still calls the dropped
   7-arg function and saves fail loudly for those minutes (Q4, accepted).
4. Deploy. Old open tabs get 428 and the message that their last change was not saved.

## 10. Rulings (Graham, 2026-10-27)

- **Q1 — old clients with no base: refuse with 428** ("This page is out of date. Reload to
  keep editing.").
- **Q2 — setlist migration on the owner's first real edit** instead of every owner load: OK.
- **Q3 — a conflict is arbitrated by the owner** (§5): their copy stays on screen, saves
  are held, Keep mine / Use the saved one. Not a server-wins default with a restore list.
- **Q4 — apply `018` before the deploy and accept a few minutes of loud save failures**
  in between, rather than keeping the unchecked function for a release.
- **Q5 — one editing tab per show per browser** (§4.0): a second owner tab is
  view-only with *Edit here*; browsers without `navigator.locks` keep today's behaviour as
  a documented limit.
