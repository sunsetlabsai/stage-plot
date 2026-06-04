# Design: Owner Onboarding + Multi-User UAT

**Status:** Draft v1.0
**Date:** 2026-06-04
**Depends on:** Owner namespacing (PR #57, migration 005)

---

## Problem

ShowRunr needs multiple owners for UAT and eventual launch. Today the system technically supports it — anyone can sign in via OTP and claim a handle at `/claim` — but there are gaps:

1. **No way to invite collaborators.** The `show_collaborators` table + RLS + `activate_invites` RPC all exist, but there's no UI to add a collaborator to a show. The only path is a manual DB insert.
2. **No discoverability.** A new user who signs in lands on `/claim` (good), then the dashboard (good), but there's no guidance on what to do next — and no way for an existing owner to share edit access.
3. **No visibility into who has accounts.** Graham (as platform operator) has no admin view of registered owners.

---

## Scope

This design covers three things:
- **A: Collaborator invite UI** — let show owners invite others by email
- **B: Owner admin list** — let the platform operator see registered owners
- **C: Onboarding polish** — small UX improvements for new users

---

## A. Collaborator Invite UI

### Where

Config tab on the show page, new "Sharing" section below the existing sections. Owner-only (editors can't invite).

### UX

```
┌──────────────────────────────────────────┐
│  Sharing                                 │
│                                          │
│  Invite by email                         │
│  [email@example.com___] [Editor ▼] [Add] │
│                                          │
│  Current collaborators                   │
│  ┌──────────────────────────────────────┐│
│  │ rachel@band.com   Editor  ✓ Joined  ││
│  │ mike@band.com     Editor  ⏳ Pending ││
│  │                           [Remove]   ││
│  └──────────────────────────────────────┘│
│                                          │
│  Share link (read-only, no sign-in)      │
│  showrunr.ai/graham/friday-at-roxy [Copy]│
└──────────────────────────────────────────┘
```

### Behavior

- **Add:** POST email + role to a new API route. Inserts into `show_collaborators` with `user_id = NULL` (pending). If the email already has a Supabase auth account, resolve `user_id` immediately.
- **Pending state:** Collaborator invited but hasn't signed in yet. When they sign in via OTP, `activate_invites` links their `user_id` (this already works).
- **Joined state:** `user_id` is set and `accepted_at` is non-null.
- **Remove:** DELETE from `show_collaborators`. Owner-only.
- **Role:** `editor` or `viewer`. Editor can edit the show config. Viewer is read-only (same as anonymous, but appears in the list and gets the authenticated experience).
- **No email notification.** For now, the owner tells the collaborator out-of-band ("go to showrunr.ai/sign-in, use your email"). Email notifications are a future enhancement.

### API Route

**`/api/shows/collaborators/route.ts`**

```
GET  ?show_id=...     → list collaborators (owner-only via RLS)
POST { show_id, email, role }  → insert collaborator (owner-only)
DELETE { show_id, email }      → remove collaborator (owner-only)
```

Uses the authenticated Supabase client (RLS on `show_collaborators` already restricts to owners for writes). For the POST, also attempt to resolve `user_id` from `auth.users` by email — this requires the admin client since `auth.users` isn't accessible via RLS.

```typescript
// POST handler — resolve user_id if possible
const admin = getSupabaseAdmin();
const { data: authUsers } = await admin.auth.admin.listUsers();
const match = authUsers.users.find(u => u.email === email);

await supabase.from('show_collaborators').insert({
  show_id,
  email,
  role,
  user_id: match?.id || null,
  accepted_at: match ? new Date().toISOString() : null,
});
```

Note: `listUsers()` is fine at ShowRunr's scale (< 100 users). For larger scale, use `admin.auth.admin.getUserByEmail()` if available, or query `auth.users` directly via admin.

### Files Changed

| File | Change |
|------|--------|
| `app/api/shows/collaborators/route.ts` | New — GET/POST/DELETE for collaborator management |
| `app/[owner]/[show]/page.tsx` | Add Sharing section to Config tab (owner-only) |

---

## B. Owner Admin List

### Where

Existing `/admin` page (ADMIN_SECRET-gated). Add a "Registered Owners" section.

### UX

```
┌──────────────────────────────────────────┐
│  Registered Owners                       │
│                                          │
│  Handle        Display Name    Joined    │
│  ──────────    ────────────    ────────  │
│  graham        Graham Devlin   2026-05-15│
│  fernando      Fernando S      2026-05-20│
│  rachel        Rachel K        2026-06-01│
│                                          │
│  3 owners registered                     │
└──────────────────────────────────────────┘
```

### API Route

**`GET /api/admin/owners`**

- Auth: `Authorization: Bearer {ADMIN_SECRET}` (same as existing admin routes)
- Returns: all `profiles` rows with `created_at`, joined to `auth.users` for email
- Uses admin client (needs `auth.users` for email)

### Files Changed

| File | Change |
|------|--------|
| `app/api/admin/owners/route.ts` | New — list registered owners (admin-only) |
| `app/admin/page.tsx` | Add "Registered Owners" section |

---

## C. Onboarding Polish

### Empty dashboard guidance

When a new user hits the dashboard with zero shows, show slightly better guidance:

```
No shows yet.
Create a new show, or ask a bandmate to invite you as a collaborator.
```

### /claim improvements

- After claiming, redirect to dashboard (already works).
- Add a subtle "What's a handle?" tooltip: "Your handle is your unique URL prefix. Shows you create will live at showrunr.ai/{handle}/{show-name}."

### Files Changed

| File | Change |
|------|--------|
| `app/dashboard/page.tsx` | Updated empty state copy |
| `app/claim/page.tsx` | Handle tooltip |

---

## UAT Workflow

With these changes, the UAT flow for multi-user testing:

1. **Graham** shares showrunr.ai with a tester (e.g., Rachel)
2. **Rachel** signs in via OTP → `/claim` → picks handle → dashboard (empty)
3. **Graham** opens a show → Config → Sharing → invites rachel@band.com as Editor
4. **Rachel** refreshes dashboard → sees shared show under "Shared with me"
5. **Rachel** opens the show → can edit (except collaborator management)

Alternatively, Rachel can create her own shows from scratch.

---

## Test Plan

### Collaborator Invite
- [ ] Owner adds collaborator by email — row created in show_collaborators
- [ ] Collaborator signs in (new account) — activate_invites links user_id
- [ ] Collaborator signs in (existing account) — user_id resolved at invite time
- [ ] Collaborator appears in list with correct status (Pending / Joined)
- [ ] Remove collaborator — row deleted, collaborator loses access
- [ ] Non-owner cannot see or modify Sharing section
- [ ] Duplicate email — 409 (unique constraint on show_id + email)
- [ ] Invalid email — 400

### Owner Admin List
- [ ] Admin page shows all registered owners
- [ ] Non-admin gets 401
- [ ] Owner count is accurate

### Onboarding
- [ ] New user: sign-in → claim → dashboard (empty with guidance)
- [ ] New user: invited before sign-up → sign-in → activate_invites → claim → dashboard (show appears)
- [ ] Existing user: sign-in → dashboard (no claim redirect)

### Regression
- [ ] Anonymous show viewing still works (no auth required)
- [ ] Owner can still edit shows
- [ ] Existing collaborator access unchanged

---

## Out of Scope

- Email notifications on invite (tell collaborators out-of-band for now)
- Collaborator self-removal
- Transfer show ownership
- Role changes (remove + re-add for now)
- Invite links (magic URLs that auto-add collaborator)
