# Admin, identity, and account-lifecycle backlog

**Why this file exists.** `docs/design-admin-identity-access.md` (PR #123, 1463 lines,
v10) bundled four separate concerns behind one title. Two of them have since been solved
by a different route or overtaken by a product ruling; two are live gaps that nothing else
records. Closing that PR without salvaging the live half would have lost real, measured
findings — so they are written down here and the PR is closed.

**This is a holding pen, not a plan.** Nothing here is sequenced or committed to. Items
graduate into their own design doc or PR when picked up, and get DELETED from here when
they do — a tombstone here is worse than nothing.

**Provenance is marked per item:**
- **[verified]** — measured against the code or the live database, on the date given.
- **[carried]** — recorded from an earlier session and NOT re-checked.

---

## 1. Deleting a user account is impossible today **[verified 2026-08-31]**

Three foreign keys into `auth.users` are `NO ACTION`, so
`auth.admin.deleteUser(id)` raises a foreign-key violation for **any** user who has ever
created a show or had a chart in the library. A naive implementation passes on a fresh
test account and fails on every real one.

Measured against the live database, not the migration files:

```sql
select c.conname, src.relname || '.' || a.attname as column,
       case c.confdeltype when 'a' then 'NO ACTION' when 'c' then 'CASCADE'
            when 'n' then 'SET NULL' end as on_delete
from pg_constraint c
join pg_class src on src.oid = c.conrelid
join pg_class tgt on tgt.oid = c.confrelid
join pg_namespace tn on tn.oid = tgt.relnamespace
join unnest(c.conkey) with ordinality k(attnum, ord) on true
join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
where c.contype = 'f' and tn.nspname = 'auth' and tgt.relname = 'users';
```

| Reference | Live action | Wanted |
|---|---|---|
| `profiles.id`, `songs.owner_id`, `user_secrets.user_id` | CASCADE | already correct |
| `shows.owner_id` | **NO ACTION** | CASCADE |
| `chart_library.owner_id` | **NO ACTION** | CASCADE |
| `show_collaborators.user_id` | **NO ACTION** | SET NULL |

Corrections to what #123 recorded, both found by re-measuring:

- #123 listed `charts.uploaded_by` as a fourth blocker. **There is no `charts` table.**
  The live public schema is `chart_calibration`, `chart_library`, `profiles`,
  `setlist_entries`, `show_collaborators`, `shows`, `songs`, `tryit_quota`,
  `user_secrets`. The item is obsolete, not merely stale.
- #123 assigned this to migration `015_fk_cascades.sql`. **`015`, `016`, and `017` are
  all taken** (`user_secrets_vault`, `builder_source_prompt`, `builder_source_notation`).
  Next free number is `018`.

**The non-obvious part, worth keeping whoever builds it:** Supabase Storage objects are
not in the Postgres FK graph, so a cascade silently orphans uploaded chart files —
invisible, and billed forever. Deletion therefore has to enumerate and delete storage
objects explicitly *before* the account row goes, and record how many actually succeeded
rather than how many were attempted. Orphaned *account* is recoverable; orphaned *files*
are not. If an audit row is ever added, it must be written **before** the destructive
work, not after — otherwise the one outcome where the record is the only surviving
evidence (storage gone, account remains) is the one outcome that records nothing.

No `DELETE /api/admin/users/[id]` endpoint exists; `app/api/admin/` holds only
`backfill-chart-overlays`, `migrate-setlists`, `owners`, `settings`.

## 2. `profiles` is anonymously enumerable **[verified 2026-08-31]**

Live policies on `public.profiles`:

| Policy | Cmd | `USING` | `WITH CHECK` |
|---|---|---|---|
| `Public read` | SELECT | `true` | — |
| `Owner manage` | ALL | `auth.uid() = id` | *(none)* |

`USING (true)` means every user's auth UUID, `owner_slug`, display name, and join date is
readable by anyone, signed in or not.

Of the eight `.from('profiles')` call sites on `main`, **exactly one** depends on the
public policy — `app/api/shows/route.ts:58`, which reads *other* users' rows via
`.in('id', collabOwnerIds)` to resolve owner slugs for the "Shared with me" dashboard
section. Every other site reads the caller's own row or already uses the service role:

```
app/api/admin/owners/route.ts:27         service role
app/api/profiles/route.ts:42,52,81       own row
app/api/shows/route.ts:28                own row
app/api/shows/[owner]/[show]/route.ts:65 service role
middleware.ts:99                         own row
app/api/shows/route.ts:58                OTHER users' rows  ← the only dependency
```

So the fix is small: drop `Public read`, add `USING (auth.uid() = id)`, and switch that
one lookup to the service-role client. `collabOwnerIds` is already derived from the
caller's own collaborator rows, so it is a narrow and justified service-role use.

**Ordering constraint:** the RLS change and the `app/api/shows/route.ts` edit must ship in
the **same deploy**, or the collaborator dashboard silently drops owner slugs.

Also worth closing while in there: `Owner manage` is `FOR ALL` with no `WITH CHECK`.
Postgres falls back to `USING` for `FOR ALL`, so it is safe today — but it is an implicit
write policy, and it stops being safe the moment a column is added.

*Weigh this against Graham's stated security scope: "the only thing I care about is
protecting people's BYOA agent key." No key material is in `profiles`. This is a privacy
and tidiness item, not a key-exposure item, and should not be sold as the latter.*

## 3. Admin rate limiting is process-local **[verified 2026-08-31]**

`lib/admin-rate-limit.ts:5` is an in-process `Map`, so the limit resets on every cold
start and is not shared across instances. Five live callers: `admin/settings`,
`admin/backfill-chart-overlays`, `admin/migrate-setlists`, `admin/owners`, and
`agent/capabilities`. Minor, and only meaningful once there is something worth
brute-forcing behind it.

---

## Closed with PR #123 — recorded so they are not reopened

**Admin identity via an `admin_users` table (#123 §3).** Superseded. The shipped
mechanism is `PLATFORM_ADMIN_EMAIL` + a server-side session-email check in
`lib/admin-auth.ts:31`, trimmed and lowercased on both sides, failing closed when the env
var is unset. The problem #123 §3 set out to solve is solved; its proposed table is not
wanted.

**Signup allowlist / invite gate (#123 §4, §5).** Dropped on a product ruling. That
"invite gate" gated *account creation* — an `allowed_emails` table plus a
`signup_mode: open | invite` switch for a closed UAT window. It is **not** the same thing
as collaborator invites. Graham's ruling for a paid product is that there must be no
barrier to viral sharing: an owner shares a show, and the recipient must be able to sign
up and view it. A signup allowlist is the one mechanism that breaks exactly that path.

Two things made it stale on top of being unwanted: §4.3 claimed the mode switch could
reuse `getAdminConfig`/`setAdminConfig` and that the "mechanism EXISTS" — but
`lib/admin-config.ts` is now **env-read-only**, `setAdminConfig` and the `__DISABLED__`
sentinel were deleted with Redis, so a runtime flip would require a Vercel env change and
a redeploy. And §1's "current state" still described `show_collaborators.role` as
`'editor' | 'viewer'`; that column was dropped by migration `014`.

Nothing from #123 was ever built. `allowed_emails`, `admin_users`, `signup_mode`,
`SIGNUP_MODE`, and `lib/require-app-user.ts` each return **zero** hits across the repo.

---

## Not in #123, and the actual gap for viral sharing

**Collaborator invite issuance does not exist.** Redemption does — `activate_invites`
links `show_collaborators` rows to a signed-in user whose email matches, called from
`/api/auth/activate-invites` after OTP. But **nothing anywhere INSERTs a
`show_collaborators` row**, so "Shared with me" can never populate. Both dashboard
sections are already built (`app/dashboard/page.tsx`) — they are not the missing piece.

Graham's ruling: **any owner may invite anyone. No gate, no approval, fewest clicks.**
Transport is the native share sheet, not an app-sent email, so the invite comes *from*
the inviter and we own no deliverability.

**The open fork, and it is the whole design question:** `activate_invites` matches by
**email**, but a share-sheet link does not know who will open it.
(a) Email-keyed reuses the existing function but half-defeats the share sheet — the
inviter must know and type the address.
(b) Token-keyed matches the ruling's spirit but needs a new redemption path, and may make
`activate_invites` dead code.

This needs its own design doc. It is the piece the viral-sharing goal actually depends on.
