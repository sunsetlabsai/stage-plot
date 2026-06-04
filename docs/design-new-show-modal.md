# Design: New Show Modal + Duplicate Show

**Status:** Draft v1.1 (addresses Codex round 1 — 5 findings)
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
- API (`POST /api/shows`): add equivalent server-side check — if `slugify(name)` produces empty string, return 400. This hardens the existing API against whitespace-only or punctuation-only names.

**Modal interaction states:**
- Autofocus on the name input when modal opens.
- Focus trap: Tab cycles within the modal (name input → Cancel → Create → name input). Implemented via `onKeyDown` handler on the overlay.
- Submit-in-flight: Create button shows "Creating..." and is disabled. Prevent double-submit.
- POST failure: show inline error below the form ("Could not create show. Try again."). Modal stays open.
- Escape key or overlay click: dismiss modal, return focus to the "New Show" button.

**Config sent to POST /api/shows:**
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

Copy config from an existing show into a new show with a fresh name and slug. **Config is independent; chart assets are shared.**

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
- The duplicate creates a new independent show. Config (stage plot, inputs, monitors, notes, setlist) is deep-copied into the new show's JSON.
- **Charts are shared, not copied.** Charts live in `chart_library` (owner-scoped, matched by `song_key`). Both the original and duplicate reference the same library entries. Deleting a chart from the library removes it from all shows. This is by design — the chart library is owner-level, not show-level. The duplicate inherits chart references via the normal resolution path.
- `showInfo.showName` and `showInfo.bandName` are both set to the new modal name. `bandName` carries over from the original as the default pre-fill in the modal's name field (user can change).
- Duplicate explicitly sends `venue` and `show_date` from the source show's config: `venue: sourceConfig.showInfo.venue || null`, `show_date: sourceConfig.showInfo.eventDate || null` (validated as `YYYY-MM-DD` or null).
- Modal reuses the same component as New Show — just different pre-fill and title ("Duplicate Show" vs "Create a New Show").

### C. use-show.ts Name Sync Fix

Currently `useShow.doSave()` extracts `name` from `config.showInfo.showName || config.showInfo.bandName`. This means the `shows.name` DB field (shown on dashboard) updates on every auto-save. That's correct behavior — it keeps the dashboard in sync with whatever the user types in Config.

No change needed here. The modal sets the initial name + slug; subsequent edits update `shows.name` but not the slug (immutable). This is the right behavior.

---

## API Changes

### POST /api/shows — Name validation hardening

Add server-side check: if `slugify(name.trim())` produces an empty string, return 400 `{ error: 'Name must contain at least one letter or number' }`. This prevents "show" slugs from whitespace/punctuation-only names.

### GET /api/shows/{owner}/{slug} — No changes needed

Already returns the full show config. Used by Duplicate to fetch source config.

---

## Files Changed

| File | Change |
|------|--------|
| `app/dashboard/page.tsx` | Replace `handleCreate` with modal component. Add `handleDuplicate`. Add Duplicate button to ShowCard. Modal with focus trap, loading/error states. |
| `app/api/shows/route.ts` | Add name validation in POST handler (reject empty slugs). |

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
- [ ] Punctuation-only name — Create stays disabled
- [ ] Name > 100 chars — input truncates
- [ ] Double-click Create — only one POST fires
- [ ] POST failure — error shown inline, modal stays open
- [ ] Tab key — cycles within modal (focus trap)

### Duplicate Show
- [ ] Click "Duplicate" on a show — modal opens pre-filled "Copy of {name}"
- [ ] Edit name, Create — new show with all config from original
- [ ] Original show unchanged after duplicate
- [ ] Charts resolve in duplicate (shared chart_library references)
- [ ] Deleting a chart affects both original and duplicate (shared, by design)
- [ ] Band name, venue, show_date carry over from original
- [ ] New slug is independent
- [ ] Duplicate fetch failure — error shown

### API Hardening
- [ ] POST /api/shows with whitespace-only name — 400
- [ ] POST /api/shows with punctuation-only name — 400
- [ ] POST /api/shows with valid name — 201 (unchanged)

### Regression
- [ ] Import YAML still works (no modal — direct create with parsed name)
- [ ] Auto-save updates shows.name from config (dashboard stays in sync)
- [ ] Slugs remain immutable after creation

---

## Out of Scope

- Show rename (changing slug of existing show)
- Show templates / presets
- Duplicate from within the show page (dashboard-only for now)
- Chart duplication (charts are owner-level library assets, shared by design)
