# Version-checked show save (UAT S5, and S3 rebuilt on it)

**Status:** DESIGN — Q1–Q4 ruled by Graham 2026-10-27 (§10); awaiting Codex. Nothing here is built.
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

### 3.1 Every writer of a `shows` row (enumerated, `grep "from('shows')"` + migrations)

| Writer | Changes `updated_at`? | Under this design |
|---|---|---|
| `PUT /api/shows/update`, entries path → `rpc_save_show` | yes | **checked** (§3.2) |
| `PUT /api/shows/update`, legacy path → direct `.update()` | yes | **checked** (§3.3) |
| `app/api/admin/migrate-setlists` (sets `setlist_migrated`) | yes | unchanged. An open tab then gets one 409, which §4.3 resolves silently because the content is identical. |
| `POST /api/shows` (create), `/api/shows/delete` | n/a (insert/delete) | unchanged |

Song-library edits (`/api/songs/*`) write `songs`/`setlist_entries`, not `shows`, so they
neither bump nor need the check.

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

```ts
.update(updatePayload).eq('id', id).eq('updated_at', base).select('updated_at, slug')
```

Zero rows is ambiguous: wrong version, RLS refusal, or missing show. Disambiguate by
re-reading `updated_at` for `id` with the user client: a row whose `updated_at` ≠ `base`
→ **409**; no row → **403** (today's answer).

### 3.4 The route's contract

| Request | Response |
|---|---|
| `base_updated_at` matches | 200 `{ updated_at, slug }` (as today) |
| `base_updated_at` stale | **409** `{ error: 'This show was changed somewhere else.', conflict: true }` |
| `base_updated_at` missing | **428** `{ error: 'This page is out of date. Reload to keep editing.' }` |

428, not "accept unchecked": an old bundle (a PWA can keep one for days) would otherwise
keep doing exactly the blind overwrite this exists to stop. An old client renders `error`
in its pill as-is, so the message reaches the user with no client change (Q1, ruled).

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

## 8. Tests (written with the build)

- **SQL** (run against a scratch DB through psql, recorded in the PR): matching base
  saves; stale base raises `PT409`; two concurrent `rpc_save_show` with the same base →
  exactly one succeeds (the `FOR UPDATE`); the old 7-arg signature no longer exists;
  `has_function_privilege` for `anon`/`authenticated` is false, for `service_role` true.
- **Route:** 200 / 409 / 428 on both paths; the legacy path's 0-row 409-vs-403 split.
- **Hook:** one save in flight (a second edit waits, then goes with the new base); 409 →
  GET → equal content adopts silently; 409 → different content holds saves, keeps this
  copy on screen and the marker set; edits while held are cached, not sent; *Keep mine*
  sends the latest with the server's current base (and a further 409 asks again); *Use
  the saved one* adopts the server copy and clears the marker; unchanged content is never
  sent; a held-for-network save retries on `online` / visible / next edit.
- **Reload while held:** the marker survives; the load's send 409s; the owner is asked again.

## 9. Rollout

1. Merge this design.
2. Build PR: migration `018` + route + hook, rebased with #200's S2/S4. Codex.
3. On Graham's go: apply `018` through psql **before** the deploy (`project_showrunr_reference`:
   migrations run first). Between apply and deploy the OLD route still calls the dropped
   7-arg function and saves fail loudly for those minutes (Q4, accepted).
4. Deploy. Old open tabs get 428 and the reload message.

## 10. Rulings (Graham, 2026-10-27)

- **Q1 — old clients with no base: refuse with 428** ("This page is out of date. Reload to
  keep editing.").
- **Q2 — setlist migration on the owner's first real edit** instead of every owner load: OK.
- **Q3 — a conflict is arbitrated by the owner** (§5): their copy stays on screen, saves
  are held, Keep mine / Use the saved one. Not a server-wins default with a restore list.
- **Q4 — apply `018` before the deploy and accept a few minutes of loud save failures**
  in between, rather than keeping the unchecked function for a release.
