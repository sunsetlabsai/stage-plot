# Design: New Show Modal + Duplicate Show

**Status:** v1.3 — addresses Codex rounds 1-3
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
- Show name is required. Create button disabled until the trimmed name produces a non-empty slug.
- Slug preview shown below the input, live-updating as you type: `/{ownerSlug}/{slugify(name)}`.
- Slug preview is informational only — the server generates the actual slug (with collision handling). If the server appends a suffix, the redirect uses the server's slug.
- Both `showInfo.bandName` and `showInfo.showName` are initialized to the modal name. This ensures exports (YAML serializer reads `bandName`), Mix tab header (`bandName || 'Untitled'`), and Perform tab all work correctly from creation. The user can change either independently in Config later.

**Name validation (client + API hardening):**
- Client: trim whitespace, reject if `slugify(trimmed)` is empty (e.g., all punctuation). Max length 100 characters.
- API (`POST /api/shows`): server-side trim + max 100 chars. **Change `slugify()` fallback:** currently returns `'show'` for empty input. Change to return `''` (empty string), then reject with 400 `{ error: 'Name must contain at least one letter or number' }` if the slug base is empty. This prevents phantom "show" slugs from invalid names.

**Modal interaction states:**
- Autofocus on the name input when modal opens.
- Focus trap: Tab cycles within the modal (name input → Cancel → Create → name input). Implemented via `onKeyDown` handler on the overlay.
- Submit-in-flight: Create button shows "Creating..." and is disabled. Prevent double-submit.
- POST failure: show inline error below the form ("Could not create show. Try again."). Modal stays open.
- Escape key or overlay click: dismiss modal, return focus to the "New Show" button.

**Config sent to POST /api/shows (new show):**
```typescript
{
  config: {
    showInfo: { bandName: name, showName: name, eventDate: '', venue: '' },
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

Copy config from an existing show into a new show with a fresh name and slug.

**Entry points:**
1. Dashboard — "Duplicate" action on each owned show card (next to Delete).
2. Show page — could add later; dashboard-only for now.

**Flow:**
```
Dashboard → [Duplicate] on "Friday at Roxy"
         → Same modal opens, pre-filled: "Copy of Friday at Roxy"
         → User edits name if desired
         → POST /api/shows with cleaned config from original + new name
         → Redirect to /{owner}/{new-slug}
```

**Details:**
- Fetch the original show's full config via `GET /api/shows/{owner}/{slug}` (already exists — returns the config).
- The duplicate creates a new independent show. Config (stage plot, inputs, monitors, notes, setlist) is deep-copied into the new show's JSON.

**Config cleaning on duplicate:**
- `showInfo.showName`: set to the new name from the modal.
- `showInfo.bandName`: **preserved from the original.** Same band, different show — the common case.
- Modal pre-fill: `"Copy of " + (sourceConfig.showInfo.showName || show.name || sourceConfig.showInfo.bandName || 'Untitled')`. Falls back through all possible name sources — older configs may lack `showName`.
- `showInfo.venue` and `showInfo.eventDate`: preserved from the original.
- `setlist[].charts`: **stripped from copied setlist items.** Charts are resolved at load time from `chart_library` by `song_key` + `owner_id`. Persisted `charts` arrays in the config are stale snapshots from the last save. Copying them creates stale embedded references. By stripping them, the duplicate relies on the same chart resolution path as any other show load — fresh, correct, no stale references.

**Config sent to POST /api/shows (duplicate):**
```typescript
const cleanedSetlist = sourceConfig.setlist?.map(song => {
  const { charts, ...rest } = song;  // strip stale chart snapshots
  return rest;
}) ?? [];

{
  config: {
    ...sourceConfig,
    showInfo: {
      ...sourceConfig.showInfo,
      showName: newName,       // new name from modal
      // bandName preserved from original
    },
    setlist: cleanedSetlist,
  },
  name: newName,
  venue: sourceConfig.showInfo.venue || null,
  show_date: sourceConfig.showInfo.eventDate && /^\d{4}-\d{2}-\d{2}$/.test(sourceConfig.showInfo.eventDate)
    ? sourceConfig.showInfo.eventDate
    : null,
}
```

- Modal reuses the same component as New Show — just different pre-fill and title ("Duplicate Show" vs "Create a New Show").

### C. use-show.ts Name Sync Fix

Currently `useShow.doSave()` extracts `name` from `config.showInfo.showName || config.showInfo.bandName`. This means the `shows.name` DB field (shown on dashboard) updates on every auto-save. That's correct behavior — it keeps the dashboard in sync with whatever the user types in Config.

No change needed here. The modal sets the initial name + slug; subsequent edits update `shows.name` but not the slug (immutable). This is the right behavior.

---

## API Changes

### POST /api/shows — Name validation + slugify fix

Two changes:

1. **Server-side validation:** Trim name, enforce max 100 characters. If empty after trim, return 400.
2. **Fix `slugify()` fallback:** Change the `|| 'show'` fallback to `|| ''`. Then check: if slug base is empty, return 400 `{ error: 'Name must contain at least one letter or number' }`. This prevents the current behavior where punctuation-only names silently get a "show" slug.

```typescript
// Current (app/api/shows/route.ts:11):
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'show';
}

// After:
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// In POST handler, before slug generation:
if (typeof name !== 'string') {
  return Response.json({ error: 'Name must be a string' }, { status: 400 });
}
const trimmed = name.trim().slice(0, 100);
if (!trimmed) {
  return Response.json({ error: 'Name is required' }, { status: 400 });
}
const baseSlug = slugify(trimmed);
if (!baseSlug) {
  return Response.json({ error: 'Name must contain at least one letter or number' }, { status: 400 });
}
```

Note: `slugify()` is also used in `lib/show-file.ts:154` for YAML export. That usage is unaffected — export names always have content from real show data.

**Client-side slug validation:** The dashboard uses a local `slugBase()` helper (not the `show-file.ts` `slugify` which has the `|| 'show'` fallback). This is a no-fallback version used only for the modal preview and create-button gate:

```typescript
function slugBase(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}
// Create button disabled when: !slugBase(name.trim())
```

### GET /api/shows/{owner}/{slug} — No changes needed

Already returns the full show config. Used by Duplicate to fetch source config.

---

## Files Changed

| File | Change |
|------|--------|
| `app/dashboard/page.tsx` | Replace `handleCreate` with modal component. Add `handleDuplicate` (with chart stripping). Add Duplicate button to ShowCard. Modal with focus trap, loading/error states. |
| `app/api/shows/route.ts` | Trim + max length + fix `slugify()` fallback + empty slug rejection. |

---

## Test Plan

### New Show Modal
- [ ] Click "New Show" — modal opens, Create disabled, name input focused
- [ ] Type show name — slug preview updates live
- [ ] Click Create — show created with correct name and slug
- [ ] Both bandName and showName set to modal name — verify export works, Mix tab shows name, Perform tab shows name
- [ ] Slug collision — server appends suffix, redirect uses server slug
- [ ] Cancel / Escape / overlay click — modal closes, no show created, focus returns to button
- [ ] Empty name — Create stays disabled
- [ ] Whitespace-only name — Create stays disabled (slugify produces empty)
- [ ] Punctuation-only name (e.g., "!!!") — Create stays disabled
- [ ] Name > 100 chars — truncated to 100
- [ ] Double-click Create — only one POST fires
- [ ] POST failure — error shown inline, modal stays open
- [ ] Tab key — cycles within modal (focus trap)

### Duplicate Show
- [ ] Click "Duplicate" on a show — modal opens pre-filled "Copy of {showName}"
- [ ] Edit name, Create — new show with config from original
- [ ] Original show unchanged after duplicate
- [ ] bandName preserved from original (not overwritten with new name)
- [ ] showName set to new name from modal
- [ ] venue and show_date carry over from original
- [ ] Charts stripped from copied setlist — verify no stale chart references in config
- [ ] Charts resolve correctly on first load (chart_library resolution)
- [ ] New slug is independent
- [ ] Duplicate of show with no showName — prefill falls back to show.name or bandName
- [ ] Duplicate fetch failure — error shown

### API Hardening
- [ ] POST /api/shows with whitespace-only name — 400
- [ ] POST /api/shows with punctuation-only name — 400
- [ ] POST /api/shows with name > 100 chars — accepted, trimmed to 100
- [ ] POST /api/shows with valid name — 201 (unchanged)
- [ ] slugify("!!!") returns "" (not "show")

### Regression
- [ ] Import YAML still works (no modal — direct create with parsed name)
- [ ] Auto-save updates shows.name from config (dashboard stays in sync)
- [ ] Slugs remain immutable after creation
- [ ] YAML export still works (lib/show-file.ts slugify unaffected)

---

## Out of Scope

- Show rename (changing slug of existing show)
- Show templates / presets
- Duplicate from within the show page (dashboard-only for now)
- Chart duplication (charts are owner-level library assets, resolved at load time)
