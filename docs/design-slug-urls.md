# Slug URLs — Design Spec v1.0

> ## ⛔ SUPERSEDED — THE ROUTE THIS SPECIFIES NO LONGER EXISTS
>
> **`app/api/show/route.ts` was DELETED 2026-08-24** (`docs/design-single-backend.md`
> chunk 0). Every endpoint below — `POST /api/show`, `GET /api/show?slug=xxx`,
> and the client fetch in the flow at the end — describes code that is gone.
>
> **What replaced it:** Supabase-backed owner-scoped slugs. Shows resolve at
> `/[owner]/[show]` via `GET /api/shows/[owner]/[show]` (note the **plural**),
> and the Redis `show:{slug}` namespace is retired with the rest of Redis.
> The replacement shipped **2026-05-25 — one day after this spec's route was
> built** — and the two lived side by side, both apparently current, for fifteen
> months. That is exactly the drift `design-single-backend.md` §2.1 exists to end,
> and this notice is here because the deletion without it would have left the
> pattern intact.
>
> **Still accurate and worth keeping:** the Problem section. Base64 `?config=`
> URLs really did break over SMS and really were stale snapshots, and the
> owner-scoped replacement inherits that reasoning unchanged.

## Problem

The original sharing mechanism encoded the entire show config as base64 in a `?config=` URL parameter. This produced URLs that were thousands of characters long, broke when sent via SMS/iMessage (truncated), and represented a stale snapshot — recipients got whatever was current at share time, not the latest version.

## Solution

Publish shows to Redis with a short slug URL. The publisher owns the slug and can update it. Recipients always load the latest version.

## Architecture

### Storage

- **Backend:** Redis (already provisioned for try-it quota)
- **Key format:** `show:{slug}` → JSON record containing `{ config, token, updatedAt }`
- **TTL:** 90 days (auto-expire inactive shows)

### Slug generation

- Derived from show name (preferred) or band name via `slugify()` — lowercase, alphanumeric + hyphens
- Example: "Friday Night at The Roxy" → `friday-night-at-the-roxy`
- If slug is already taken by another user, append a random 4-char suffix and retry (up to 5 attempts)

### Ownership

- On first publish, a random UUID token is generated and returned to the client
- Token stored in publisher's `localStorage` (keyed by `stageplot-publish-token`)
- Current slug stored alongside (`stageplot-publish-slug`)
- Subsequent publishes send the token — server verifies ownership before allowing update
- If no token or wrong token, server creates a new slug (NX create, race-safe)

### Ownership scoping

- Token/slug are per-browser, not per-show
- Loading someone else's shared link (`?show=their-slug`) clears ownership **only if** the loaded slug doesn't match the browser's currently owned slug
- This prevents accidentally overwriting someone else's show on re-publish, while still allowing the owner to open their own link, edit, and re-publish to the same slug

### Race safety

- New slug creation uses Redis `SET ... NX` (set-if-not-exists) to prevent concurrent first-publish collisions
- If NX fails (slug taken), retry with a random suffix (up to 5 attempts)
- Owner updates use standard SET (safe because token is secret — only the owner can update)

## API

### POST /api/show — publish or update

**Request:**
```json
{
  "config": { ... },       // full AppConfig object
  "slug": "my-show",       // optional: existing slug to update
  "token": "uuid"          // optional: ownership token for updates
}
```

**Response:**
```json
{
  "slug": "my-show",       // actual slug (may differ if collision)
  "token": "uuid"          // ownership token (store in localStorage)
}
```

**Behavior:**
- With valid token + slug → update existing show
- Without token or slug mismatch → create new slug (NX + retry)
- Slug sanitized through `slugify()` on server (matches GET validation)
- Max body size: 500KB

### GET /api/show?slug=xxx — load published show

**Response:**
```json
{
  "config": { ... },
  "slug": "my-show"
}
```

**Errors:**
- 400: Invalid slug format
- 404: Show not found or expired
- 503: Redis unavailable

## Client UX

### Publish button

- Upload icon in the tab bar (replaces old Copy Link clipboard icon)
- On click: publishes current config to Redis, copies short URL to clipboard
- Feedback: green checkmark for 2 seconds, tooltip "Published & copied!"
- If already published: updates the existing slug (same short URL)

### Short URL format

```
https://stage-plot-five.vercel.app/?show=loosely-covered
```

### Loading a shared link

1. Recipient opens `?show=slug`
2. Client fetches config from `/api/show?slug=xxx`
3. On success: loads config, stores to localStorage, clears URL param
4. On failure: shows error banner ("Show not found"), falls through to local config
5. Ownership: clears publish credentials only if loaded slug doesn't match browser's owned slug

### Backwards compatibility

- Legacy `?config=` URLs still work (decoded inline, stripped from URL)
- No migration needed — existing shared links continue to function

## What Changes

| Component | Current | New |
|---|---|---|
| Share mechanism | Base64 config in URL | Short slug URL via Redis |
| Copy Link button | Encodes config | Publishes to Redis + copies short URL |
| URL length | Thousands of chars | ~60 chars |
| Content freshness | Stale snapshot | Always latest published version |
| SMS/iMessage | Truncated/broken | Works reliably |

## What Doesn't Change

- Show file format (YAML export/import)
- localStorage persistence (local editing still works offline)
- Google Drive integration
- AI codesigner
