# Design: Owner Onboarding Polish + Admin Visibility

**Status:** v1.4 — build-ready (Codex rounds 1-3, all HIGH/MEDIUM resolved)
**Date:** 2026-06-04
**Depends on:** Owner namespacing (PR #57, migration 005)

> ## ⛔ SUPERSEDED IN PART — the admin auth model in this document is DEAD
>
> Superseded by `design-single-backend.md` §3.3a/§3.3b, shipped in its chunk-1
> build. This document is otherwise still current; only the auth is wrong.
>
> **`ADMIN_SECRET` no longer exists.** `/api/admin/owners` — and the other three
> `/api/admin/*` routes — authenticate against a platform super-admin session:
> server-side `supabase.auth.getUser()`, compared case-insensitively against
> `PLATFORM_ADMIN_EMAIL`, failing closed on any missing input. There is no bearer
> token and no shared secret. Wherever this document says
> `Authorization: Bearer {ADMIN_SECRET}` (`:55`, `:82`), read "the super-admin's
> session cookie."
>
> **§61's KV-independence rationale is retired, deliberately.** This document had
> `/api/admin/owners` validate its secret independently of KV so the owner list
> still rendered when settings 503'd on an unreachable store. There is no store:
> both routes now read the same environment and the same Postgres, so no
> partial-availability case remains to preserve. It was a workaround for two
> stores, not a requirement — recorded here because silently deleting a
> degradation path is how the next reader concludes it was never wanted.
>
> **The `/admin` settings surface is now READ-ONLY.** `PUT /api/admin/settings`
> was deleted, not re-authed: config lives in environment variables, so there is
> nothing to write. Changing a value is a Vercel env edit plus a redeploy.

---

## Problem

The multi-owner flow works end-to-end (sign-in → OTP → /claim → dashboard → create shows), but there are UX gaps that block practical UAT with other people:

1. **Dead end after /claim.** After claiming a handle, the user is redirected to `/dashboard` — but there's no success message confirming the claim worked, and if the redirect fails or is slow, the user is stranded with no navigation.
2. **No operator visibility.** Graham (platform operator) can't see who has signed up, claimed handles, or how many shows they own. No admin view exists for owners.
3. **Sparse guidance for new users.** Empty dashboard says "No shows yet" with no context about what ShowRunr is or what to do next.

---

## Scope

Three small, targeted fixes. No migration. No new auth model. Collaborator permissions and billing/usage are out of scope (billing covered by `docs/design-payments.md`, PR #59).

---

## A. /claim Success + Navigation

### Current behavior
`/claim` → POST → `router.push('/dashboard')`. No feedback. If push is slow, user sees nothing. Revisiting `/claim` after already claiming shows the form again (middleware exempts `/claim` from the profile redirect check).

### Proposed change

**On-mount profile check:** When `/claim` loads, show a loading spinner while calling `GET /api/profiles`. The claim form is NOT rendered until the check resolves. Three cases:

1. **200 (profile exists):** Show "Already claimed as **{handle}**" with a link to `/dashboard`. Do not show the claim form.
2. **404 (no profile):** Show the claim form (current behavior).
3. **401 (not authenticated):** Redirect to `/sign-in?redirect=/claim`.
4. **Network error:** Show the claim form as fallback (don't block on check failure).

**409 handling on submit:** If the user somehow reaches the claim form despite having a profile (network error on mount check) and submits, `/api/profiles` returns 409 "Profile already exists." Handle this gracefully: show "Already claimed" with a link to `/dashboard` instead of a generic error.

**After successful claim:** Show a brief success state: "Claimed **{handle}**! Redirecting..." with a manual link to `/dashboard` as fallback. Then `router.push('/dashboard')` as today.

### Files changed

| File | Change |
|------|--------|
| `app/claim/page.tsx` | On-mount profile check, already-claimed state, success state with fallback link |

---

## B. Owner Admin List

### Where

Existing `/admin` page (ADMIN_SECRET-gated). New "Registered Owners" section.

### Admin auth independence

The current `/admin` page authenticates by calling `GET /api/admin/settings` — if KV is disconnected, that returns 503 and the page never enters authenticated state. The owner list is Supabase-backed and should not be gated on KV health.

**Fix:** Split admin auth from settings load. The new `/api/admin/owners` route validates `ADMIN_SECRET` independently (direct `process.env` comparison, no KV dependency). The `/admin` page calls both endpoints after the user enters the secret — if settings returns 503 (KV down), still show the owner list if `/api/admin/owners` succeeds.

### UX

```
┌──────────────────────────────────────────────────┐
│  Registered Owners                               │
│                                                  │
│  Handle        Display Name   Email         Shows  Joined    │
│  ──────────    ────────────   ───────────   ─────  ────────  │
│  graham        Graham Devlin  g@sunset...   3      2026-05-15│
│  rachel        Rachel K       r@band.com    1      2026-06-01│
│                                                              │
│  2 owners registered                                         │
└──────────────────────────────────────────────────────────────┘
```

### API Route

**`GET /api/admin/owners`**

- Auth: `Authorization: Bearer {ADMIN_SECRET}` — validated against `process.env.ADMIN_SECRET` (no KV dependency)
- Rate limit: extract the rate limiter from `/api/admin/settings` into a shared `lib/admin-rate-limit.ts` helper. Both `/api/admin/settings` and `/api/admin/owners` import the same helper. Single map, consistent limits, no drift.
- **Multi-query implementation** (not a single join — `auth.users` is not a PostgREST table, and `profiles` has no FK to `shows`):

```typescript
const admin = getSupabaseAdmin();

// 1. Fetch all profiles
const { data: profiles, error: profilesErr } = await admin
  .from('profiles')
  .select('id, owner_slug, display_name, created_at')
  .order('created_at', { ascending: false });

if (profilesErr || !profiles) {
  return Response.json({ error: 'Failed to load profiles' }, { status: 500 });
}

// 2. Fetch show counts grouped by owner_id
const { data: shows, error: showsErr } = await admin
  .from('shows')
  .select('owner_id');

if (showsErr) {
  return Response.json({ error: 'Failed to load shows' }, { status: 500 });
}

const showCounts: Record<string, number> = {};
for (const s of shows || []) {
  showCounts[s.owner_id] = (showCounts[s.owner_id] || 0) + 1;
}

// 3. Fetch emails via admin auth API (default is 50/page, request 1000)
const { data: { users }, error: usersErr } = await admin.auth.admin.listUsers({
  page: 1,
  perPage: 1000,
});

// Email lookup is non-fatal — return owners with email: null + warning
const emailMap: Record<string, string> = {};
let emailWarning: string | null = null;
if (usersErr || !users) {
  emailWarning = 'Could not load user emails';
} else {
  for (const u of users) {
    emailMap[u.id] = u.email || '';
  }
}

// 4. Assemble
const owners = profiles.map(p => ({
  owner_slug: p.owner_slug,
  display_name: p.display_name,
  email: emailMap[p.id] || null,
  show_count: showCounts[p.id] || 0,
  created_at: p.created_at,
}));

return Response.json({ owners, ...(emailWarning && { warning: emailWarning }) });
```

Supabase `listUsers()` defaults to 50/page (not 1000). Explicit `perPage: 1000` handles up to 1000 owners. Beyond that, add pagination loop — not needed at current scale.

- Returns: `{ owners: [...] }`

### Files changed

| File | Change |
|------|--------|
| `app/api/admin/owners/route.ts` | New — multi-query owner list with rate limiting (admin-only) |
| `app/admin/page.tsx` | Add "Registered Owners" section; split auth so owner list works even if KV is down. If API returns `warning`, show yellow banner above owner table: "Email lookup unavailable — emails may be blank." |
| `lib/admin-rate-limit.ts` | New — shared rate limiter extracted from `/api/admin/settings` |

---

## C. Empty Dashboard Guidance

### Current
```
No shows yet.
Create a new show or import a .showrunr.yaml file.
```

### Proposed
```
Welcome to ShowRunr.
Create your first show, or import an existing .showrunr.yaml file.
Your shows will live at showrunr.ai/{handle}/...
```

Where `{handle}` is the user's actual `ownerSlug` (already loaded into state before the empty branch renders — `dashboard/page.tsx:31`).

### Files changed

| File | Change |
|------|--------|
| `app/dashboard/page.tsx` | Updated empty state copy with personalized URL hint |

---

## Test Plan

### /claim polish
- [ ] New user: claim handle — see "Claimed {handle}!" success message
- [ ] Fallback link to /dashboard works
- [ ] Redirect to dashboard still fires automatically
- [ ] Revisit /claim after already claiming — see "Already claimed as {handle}" with dashboard link (no form)
- [ ] Unauthenticated visit to /claim — redirect to /sign-in
- [ ] Profile check failure (network error) — show claim form as fallback (don't block)
- [ ] Already-claimed user submits form (network error on mount check) — 409 shows "Already claimed" + dashboard link

### Owner admin list
- [ ] /admin shows registered owners with handle, name, email, show count, join date
- [ ] Non-admin (wrong/missing secret) gets 401
- [ ] Rate limiting: 6th request in 1 minute returns 429
- [ ] Owner with zero shows displays correctly (show_count: 0)
- [ ] Multiple owners with varying show counts — counts are accurate
- [ ] KV disconnected — settings section shows error, but owner list still loads
- [ ] Email mapping works (listUsers response matched by user ID)
- [ ] Email lookup failure — owner list loads, emails show blank, yellow warning banner visible

### Dashboard guidance
- [ ] New user with zero shows sees personalized welcome with their handle
- [ ] User with shows sees normal show list (no welcome message)

---

## Out of Scope

- Collaborator invite UI (collaborators use public links, no auth needed)
- Billing / usage gates (see `docs/design-payments.md`)
- Email notifications
- Profile editing (handle rename, display name change)
- Unifying admin + owner auth (admin is a separate URL + password for now)
