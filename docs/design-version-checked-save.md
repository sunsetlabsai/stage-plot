# Version-checked show save (UAT S5, and S3 rebuilt on it)

**Status:** DESIGN — Q1–Q4 ruled by Graham 2026-10-27 (§10); Codex R1 folded (§3.1, §3.3–§3.6, §4.2, §7); awaiting Codex R2. Nothing here is built.
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
- **`POST /api/shows` (plain create) sets `setlist_migrated = true` when the config's
  setlist is empty** — an empty setlist has nothing to migrate. So no new legacy shows
  appear, and §4.4's migration-timing change (Q2) affects no show in practice.

## 4. Client (`lib/use-show.ts`)

### 4.1 The base

`useShow` holds `base` — the `updated_at` string of the server version this browser's
copy is built on. It is set from the show GET (which must return `updated_at`: #200 adds it, unmerged — the build carries it either way) and replaced
by each successful save's response. It is stored verbatim with the cache
(`showrunr-last-saved-{id}`, already written) so an offline-opened copy knows its base.

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
| — | collaborator at the matching version | §3.3: explicit owner check before either path |

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
- **Create:** an empty-setlist show is created `setlist_migrated = true`.
- **Hook:** one save in flight (a second edit waits, then goes with the new base); 409 →
  GET → equal content adopts silently; 409 → different content holds saves, keeps this
  copy on screen and the marker set; edits while held are cached, not sent; *Keep mine*
  sends the latest with the server's current base (and a further 409 asks again); *Use
  the saved one* adopts the server copy and clears the marker; unchanged content is never
  sent; a held-for-network save retries on `online` / visible / next edit.
- **Reload while held:** the marker survives; the load's send 409s; the owner is asked again.

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
