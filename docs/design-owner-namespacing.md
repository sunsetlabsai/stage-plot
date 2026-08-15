<!--
  ⚑ STATUS FLAG (do not delete this doc) — 2026-06-04
  This spec is NOT abandoned. The feature shipped (migration 005_owner_namespacing.sql,
  ~session 26), but this design doc was never committed to the repo.
  ACTION PENDING: fold this content into the canonical ShowRunr spec doc when we create it.
  Also preserved in auto-memory: project_showbible_owner_namespacing_spec.md
  Keep out of PR #71 (song library) — unrelated scope.
-->

# Owner Namespacing — Design Spec v1.0

## Problem

Current URL structure is `/{show-slug}` with globally unique slugs. This means:
- Two users can't both have a show called "friday-night"
- No concept of an owner's public identity/namespace
- Sharing links don't convey who the show belongs to
- Multi-user testing requires manual deconfliction

## Goal

URL structure that namespaces shows under owners, supports multiple independent users, and reserves root paths for marketing.

## URL Structure

```
/                               → marketing/landing page
/app/{owner-slug}/{show-slug}   → show view (Perform/Mix/Config/AI)
/app/{owner-slug}               → owner's public show list (future)
/dashboard                      → authenticated user's private dashboard
/sign-in                        → OTP auth
```

**Examples:**
- `/app/loosely-covered/fernandos-party-20260530`
- `/app/sleazzy-top/woof-camp-afterglow`
- `/app/graham/nicholson-ranch-20260606`

## Data Model Changes

### New: `owner_slug` on auth user profile

```sql
ALTER TABLE auth.users ADD COLUMN raw_user_meta_data jsonb;
-- OR use a separate profiles table:

CREATE TABLE profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id),
  owner_slug text UNIQUE NOT NULL,
  display_name text,
  created_at timestamptz DEFAULT now()
);
```

**Decision: `profiles` table.** Don't touch auth.users metadata — keep it clean.

- `owner_slug`: unique, lowercase, URL-safe. Set during onboarding (first sign-in).
- `display_name`: band name or person name, shown in UI.
- Show slugs become unique per-owner (not globally): `UNIQUE(owner_id, slug)` on `shows` table replaces the current global `UNIQUE(slug)`.

### Migration

```sql
-- 1. Create profiles table
CREATE TABLE profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  owner_slug text UNIQUE NOT NULL,
  display_name text,
  created_at timestamptz DEFAULT now()
);

-- 2. Relax shows slug uniqueness from global to per-owner
ALTER TABLE shows DROP CONSTRAINT shows_slug_key;
ALTER TABLE shows ADD CONSTRAINT shows_owner_slug_unique UNIQUE(owner_id, slug);

-- 3. RLS: anyone can read profiles, only owner can update own
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read" ON profiles FOR SELECT USING (true);
CREATE POLICY "Owner update" ON profiles FOR ALL USING (auth.uid() = id);
```

### Existing data migration

Seed profiles for existing users from their show names or email prefix.

## Route Changes

### Current
- `app/[slug]/page.tsx` → show view

### New
- `app/app/[owner]/[show]/page.tsx` → show view
- `app/[slug]/page.tsx` → redirect to `/app/{owner}/{slug}` for backwards compat (lookup owner from show)
- `app/app/[owner]/page.tsx` → owner's public show list (future, can be a simple redirect to dashboard for now)

### Onboarding flow

First sign-in → if no profile exists → prompt for owner_slug ("Choose your ShowRunr handle") before redirecting to dashboard. Simple modal or interstitial page.

## Sharing

Shared links become: `https://showrunr.app/app/loosely-covered/fernandos-party`

These work for anyone (anonymous viewing). The owner namespace makes it clear whose show it is.

## Implementation Phases

### Phase 1 (near-term)
- `profiles` table + migration
- Onboarding: claim owner_slug on first sign-in
- Route change: `/app/{owner}/{show}`
- Backwards-compat redirect from `/{show-slug}`
- Update dashboard links, share URLs, publish flow

### Phase 2 (later)
- Owner public page (`/app/{owner}` → list of published shows)
- Vanity subdomains (`{owner}.showrunr.com` → premium feature)
- Profile editing (display name, avatar)

## QR Codes + Social Links (companion feature)

Separate from namespacing but related to the public-facing identity:

### Data model addition

```typescript
interface OwnerLinks {
  social?: { platform: string; url: string }[];  // Instagram, TikTok, YouTube, etc.
  tipJar?: { platform: string; url: string }[];   // Venmo, PayPal, CashApp
  booking?: { url: string; label?: string };       // booking email or link
}
```

Stored on the `profiles` table as a `links jsonb` column.

### Display

- **Perform tab footer** (or dedicated "Band" tab): QR codes auto-generated from URLs
- Each link renders as a QR code with label (scannable from stage, merch table, etc.)
- QR codes generated client-side (e.g., `qrcode` npm package, or canvas-based — no server needed)

### Use cases
- Fan scans QR at merch table → Instagram follow
- Fan scans QR → Venmo tip
- Venue scans QR → booking inquiry

This pairs naturally with the owner namespace — the QR codes link to the owner's public identity, not a single show.
