# Design: New Show Modal + Duplicate Show

**Status:** Draft v1.0
**Date:** 2026-06-04

---

## Problem

Clicking "New Show" on the dashboard immediately creates a show with `name: 'New Show'` and slug `new-show`. The slug is immutable after creation (PR #62 made this intentional for link stability). This causes two bugs:

1. **All new shows compete for the same slug.** The first gets `new-show`, subsequent ones get `new-show-x7f2` etc. — meaningless URLs that never reflect the actual show name.
2. **No rename escape hatch.** If you name a show wrong, or want a different slug, the only option today is to delete and recreate. There's no way to get a new URL for existing content.

---

## Solution

### A. New Show Modal

Replace the immediate-create with a lightweight modal that collects the show name before creation.

**Flow:**
```
Dashboard → [+ New Show] → Modal opens
                            ┌──────────────────────────────┐
                            │  Create a New Show           │
                            │                              │
                            │  Show Name                   │
                            │  [_________________________]  │
                            │                              │
                            │  URL: /graham/friday-at-roxy │
                            │                              │
                            │         [Cancel]  [Create]   │
                            └──────────────────────────────┘
                            → POST /api/shows with real name
                            → Redirect to /{owner}/{slug}
```

**Details:**
- Modal is a simple overlay div (no external dependency). Escape or Cancel dismisses.
- Show name is required. Create button disabled until non-empty.
- Slug preview shown below the input, live-updating as you type: `/{ownerSlug}/{slugify(name)}`.
- Slug preview is informational only — the server generates the actual slug (with collision handling). If the server appends a suffix, the redirect uses the server's slug.
- The `showInfo.bandName` is left blank in the initial config — the user sets it in Config tab. `shows.name` (the DB field used in dashboard + slug) comes from the modal input.
- `showInfo.showName` is populated from the modal input so it shows on Perform/Mix tabs immediately.

**Config sent to POST /api/shows:**
```typescript
{
  config: {
    showInfo: { bandName: '', showName: name, eventDate: '', venue: '' },
    stagePlot: [],
    inputs: [],
    monitors: [],
    notes: [],
    setlist: [],
  },
  name,        // → shows.name (DB), used for slug
  venue: null,
  show_date: null,
}
```

### B. Duplicate Show

Copy all config from an existing show into a new show with a fresh name and slug.

**Entry points:**
1. Dashboard — "Duplicate" action on each owned show card (next to Delete).
2. Show page — could add later; dashboard-only for now.

**Flow:**
```
Dashboard → [Duplicate] on "Friday at Roxy"
         → Same modal opens, pre-filled: "Copy of Friday at Roxy"
         → User edits name if desired
         → POST /api/shows with full config from original + new name
         → Redirect to /{owner}/{new-slug}
```

**Details:**
- Fetch the original show's full config via `GET /api/shows/{owner}/{slug}` (already exists — returns the config).
- The duplicate is a new independent show. No link to the original. All config (stage plot, inputs, monitors, notes, setlist) is deep-copied.
- Charts in the setlist reference Supabase Storage URLs, which are owner-scoped and public-read. They work across shows without copying blobs.
- `showInfo.showName` is set to the new name from the modal.
- `showInfo.bandName` carries over from the original (same band, different show — the common case).

### C. use-show.ts Name Sync Fix

Currently `useShow.doSave()` extracts `name` from `config.showInfo.showName || config.showInfo.bandName`. This means the `shows.name` DB field (shown on dashboard) updates on every auto-save. That's correct behavior — it keeps the dashboard in sync with whatever the user types in Config.

No change needed here. The modal sets the initial name + slug; subsequent edits update `shows.name` but not the slug (immutable). This is the right behavior.

---

## API Changes

### POST /api/shows — No changes needed

Already accepts `{ config, name, venue, show_date }` and slugifies `name`. Works as-is.

### GET /api/shows/{owner}/{slug} — No changes needed

Already returns the full show config. Used by Duplicate to fetch source config.

---

## Files Changed

| File | Change |
|------|--------|
| `app/dashboard/page.tsx` | Replace `handleCreate` with modal. Add `handleDuplicate`. Add modal component. Add Duplicate button to ShowCard. |

One file. No API changes. No migration.

---

## Test Plan

### New Show Modal
- [ ] Click "New Show" — modal opens, Create disabled
- [ ] Type show name — slug preview updates live
- [ ] Click Create — show created with correct name and slug
- [ ] Slug collision — server appends suffix, redirect uses server slug
- [ ] Cancel / Escape — modal closes, no show created
- [ ] Empty name — Create stays disabled
- [ ] Show page reflects showName on Perform/Mix tabs

### Duplicate Show
- [ ] Click "Duplicate" on a show — modal opens pre-filled "Copy of {name}"
- [ ] Edit name, Create — new show with all config from original
- [ ] Original show unchanged after duplicate
- [ ] Charts work in duplicate (Supabase URLs still valid)
- [ ] Band name carries over from original
- [ ] New slug is independent

### Regression
- [ ] Import YAML still works (no modal — direct create with parsed name)
- [ ] Auto-save updates shows.name from config (dashboard stays in sync)
- [ ] Slugs remain immutable after creation

---

## Out of Scope

- Show rename (changing slug of existing show)
- Show templates / presets
- Duplicate from within the show page (dashboard-only for now)
