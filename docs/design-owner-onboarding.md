# Design: Owner Onboarding Polish + Admin Visibility

**Status:** Draft v1.1 (rescoped from v1.0)
**Date:** 2026-06-04
**Depends on:** Owner namespacing (PR #57, migration 005)

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
`/claim` → POST → `router.push('/dashboard')`. No feedback. If push is slow, user sees nothing.

### Proposed change

After successful claim:
1. Show a brief success state in the form: "Claimed! Redirecting..." with a manual link to `/dashboard` as fallback.
2. Add a persistent back-nav link at the top of `/claim` for users who land there by accident or want to go back: "← Back to Dashboard" (only shown if they already have a profile — but since middleware redirects to /claim when no profile exists, this link only appears on direct navigation).

### Files changed

| File | Change |
|------|--------|
| `app/claim/page.tsx` | Success state with "Claimed!" message + fallback link to /dashboard |

---

## B. Owner Admin List

### Where

Existing `/admin` page (ADMIN_SECRET-gated). New "Registered Owners" section.

### UX

```
┌──────────────────────────────────────────┐
│  Registered Owners                       │
│                                          │
│  Handle        Display Name    Shows  Joined    │
│  ──────────    ────────────    ─────  ────────  │
│  graham        Graham Devlin   3      2026-05-15│
│  rachel        Rachel K        1      2026-06-01│
│                                                  │
│  2 owners registered                             │
└──────────────────────────────────────────────────┘
```

### API Route

**`GET /api/admin/owners`**

- Auth: `Authorization: Bearer {ADMIN_SECRET}` (same pattern as existing `/api/admin/settings`)
- Query: join `profiles` with show count (aggregate) and `auth.users` for email
- Uses admin client (needs `auth.users` for email)
- Returns: `{ owners: [{ owner_slug, display_name, email, show_count, created_at }] }`

### Files changed

| File | Change |
|------|--------|
| `app/api/admin/owners/route.ts` | New — list registered owners (admin-only) |
| `app/admin/page.tsx` | Add "Registered Owners" section below existing settings |

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

Where `{handle}` is the user's actual owner_slug (already available in the dashboard data).

### Files changed

| File | Change |
|------|--------|
| `app/dashboard/page.tsx` | Updated empty state copy with personalized URL hint |

---

## Test Plan

### /claim polish
- [ ] Claim handle — see "Claimed!" success message
- [ ] Fallback link to /dashboard works
- [ ] Redirect to dashboard still fires automatically

### Owner admin list
- [ ] /admin shows registered owners with handle, name, email, show count, join date
- [ ] Non-admin gets 401
- [ ] Owner with zero shows displays correctly

### Dashboard guidance
- [ ] New user with zero shows sees personalized welcome with their handle
- [ ] User with shows sees normal show list (no welcome message)

---

## Out of Scope

- Collaborator invite UI (collaborators use public links, no auth needed)
- Billing / usage gates (see `docs/design-payments.md`)
- Email notifications
- Profile editing (handle rename, display name change)
