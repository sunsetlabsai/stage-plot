# Design: Batch Chart Resolution & Navigator

**Status:** SUPERSEDED — see `docs/INDEX.md`. Drive-era batch resolution, replaced by
library-keyed resolution at show GET.
**Depends on:** PR #1 (Charts / Lead Sheets — Google Drive integration)
**Scope:** Setup-time batch resolution + showtime chart navigator

---

## Problem

Current implementation loads chart links on-demand per tap in the Show tab. This creates two UX problems:

1. **Setup tax:** Engineer has to tap every song individually to discover which charts exist. For a 30-song setlist, that's 30 taps with loading spinners.
2. **No visual signal:** Chart icons are all gray until tapped — no way to see at a glance which songs have charts and which don't.

The chart links themselves are small (~200 bytes each). A worst-case 30-song x 8-role setlist is ~48KB — trivially fits in localStorage and the shareable URL.

---

## Design

### Phase: Setup (can afford latency)

#### Batch Resolution Trigger

Chart resolution fires automatically when **all three conditions** are met:
1. Google Drive is connected (valid token)
2. A `chartsRootFolderId` is configured
3. The setlist has at least one song

**Triggers:**
- Setlist loaded from Google Sheet import
- Song added manually to the setlist
- Song title edited (debounced — 1s after last keystroke)
- User clicks "Refresh Charts" button (manual re-scan)

#### Resolution Flow

Single request sends the full setlist; server resolves all songs in one pass:

```
POST /api/drive/batch
  body: {
    folderId: "...",
    songs: [
      { idx: 0, title: "Superstition" },
      { idx: 1, title: "Brick House" },
      { idx: 5, title: "Superstition" },   // reprisal — same title, different slot
      ...
    ]
  }

Response: {
  results: [
    {
      idx: 0,
      charts: [
        { role: "Guitar", url: "...", label: "Superstition.pdf", fileId: "abc", dupeCount: 1 },
        { role: "Lyrics", url: "...", label: "Superstition - lyrics.docx", fileId: "def", dupeCount: 1 }
      ]
    },
    {
      idx: 1,
      charts: [
        { role: "Horns", url: "...", label: "Brick House Bb.pdf", fileId: "ghi", dupeCount: 2 }
      ]
    },
    {
      idx: 5,
      charts: [...]  // same charts as idx 0 — resolved identically but returned per-slot
    }
  ]
}
```

**Why a batch endpoint?** One client round-trip. The server fetches each role folder's file list once (paginated), then matches all song titles against those lists in memory. No per-song API calls.

#### Storage

Resolved charts are written to `SetlistSong.charts` on each song in the config. This means:
- They persist in localStorage automatically (existing mechanism)
- They're included in the shareable URL (existing `encodeConfig`)
- Anyone who opens a shared link gets pre-resolved chart links — no Drive connection needed to *view* them
- Only the person who *resolves* needs Drive access

#### UI Changes (Setup Tab)

- **Status indicator** on the Setlist section header: "Charts: 24/30 songs matched" or "Charts: not connected"
- **Refresh Charts** button — re-runs batch resolution for all songs
- **Per-song indicator** in the setlist table: small colored dot (green = has charts, gray = none, orange = has dupes)

#### Incremental Updates

When a song is added or its title changes:
- Resolve just that song (single-song API call, not full batch)
- Merge result into the existing charts data
- Debounce title edits (1s) to avoid API spam while typing

---

### Phase: Show (must be instant)

#### Setlist Table Enhancement

The existing setlist table gains a **Charts column** (already partially built in PR #1):
- Icon is pre-colored based on resolved data: **blue** = has charts, **gray** = no charts
- No loading spinners — data is already in config
- Tap icon → opens the **Chart Navigator** overlay

#### Chart Navigator Overlay

Full-screen overlay optimized for musicians at the gig.

```
┌─────────────────────────────────────┐
│  ← Back to Setlist                  │
│                                     │
│  Song 3 of 30                       │
│  "Superstition"                     │
│                                     │
│  ┌─────────────────────────────┐    │
│  │ Lyrics    Superstition.docx →│    │
│  │ Guitar    Superstition.pdf  →│    │
│  │ Horns     Superstition Bb   →│    │
│  │           ⚠ 2 found          │    │
│  │ Drums     Superstition.pdf  →│    │
│  └─────────────────────────────┘    │
│                                     │
│  [← Prev Song]      [Next Song →]  │
│                                     │
│  Filter: [All Roles ▼]             │
└─────────────────────────────────────┘
```

**Key interactions:**
- **Prev/Next** buttons step through the setlist in order. Swipe left/right also works (touch events).
- **Role filter dropdown** (sticky per session): pick "Guitar" and you only see Guitar charts as you step through songs. Persisted in sessionStorage so it survives page navigations but not new sessions.
- **Chart link tap** → opens in new tab. When the musician returns to the app tab, the navigator is still showing the same song, ready for next/prev.
- **Back to Setlist** returns to the full setlist table.
- **Keyboard nav:** left/right arrow keys for prev/next (desktop use case).
- **Empty state:** if a song has no charts for the selected role, show "No [Guitar] chart for this song" with prev/next still active.

#### Why Not Embed Charts?

Google Drive files can't be reliably iframed (CORS, auth, mixed content). The navigator is a **launch pad** — it shows what's available, you tap to open, and when you come back the navigator is waiting with prev/next. This is the same UX pattern as music apps that link to external scores.

---

## New API Route

### `POST /api/drive/batch`

Accepts song slots (idx + title), searches all role subfolders, returns results keyed by idx to handle duplicate titles (reprises, medleys, same song in two sets).

```ts
// Request
{
  folderId: string;
  songs: { idx: number; title: string }[];
}

// Response
{
  results: {
    idx: number;
    charts: Chart[];  // includes fileId and mimeType for offline cache
  }[];
}
```

**Implementation:** Same fuzzy matching as the existing `/api/drive` route. Server fetches each role folder's full file listing once (paginated via `nextPageToken`), then matches all song titles against those lists in memory.

**Complexity:** O(roleFolders x pages) Drive API calls. For the 8 canonical folders with <100 files each, that's 8 calls. Extensible role folders and large folders with pagination increase linearly. Independent of setlist length — a 50-song setlist costs the same as a 10-song setlist.

All requests include `supportsAllDrives=true` and `includeItemsFromAllDrives=true` for Shared Drive compatibility.

---

## Data Model Changes

None — `SetlistSong.charts?: Chart[]` already exists from PR #1. The batch resolution just populates it at setup time instead of on-demand at show time.

`AppConfig.chartsRootFolderId` already exists.

---

## Migration from PR #1

The on-demand per-tap loading in PR #1 becomes dead code. It gets replaced by:
1. Batch resolution at setup time (writes to config)
2. Pre-colored icons at show time (reads from config)
3. Navigator overlay (pure client-side, no API calls)

---

## Edge Cases

| Scenario | Behavior |
|---|---|
| Song title changed after resolution | Re-resolve that song (debounced). Old charts cleared, new ones populated. |
| Song deleted from setlist | Charts removed with the song (they're on the SetlistSong object). |
| Drive folder has new files after initial resolution | Stale until "Refresh Charts" is clicked. No auto-polling. |
| Token expired during batch resolution | Show error banner with "Reconnect Google Drive" action. Partial results kept. |
| Shared link opened by someone without Drive access | Charts work — links are in the URL. They can open Drive files if they have access to the Drive folder (separate from app auth). |
| 50+ song setlist | Batch endpoint handles it — O(roleFolders x pages) Drive calls, independent of song count. |
| Duplicate song titles (reprises) | Keyed by idx, not title. Each slot gets its own chart bindings (identical charts, separate entries). |

---

## Future Considerations

- **URL size guardrail:** With chart data in the config, the shareable URL can grow large. If encoded config exceeds ~8KB, fall back to JSON export/import instead of share URL. Not blocking — current worst case (~48KB) still works in most browsers but should be guarded.

---

## Out of Scope

- Offline chart caching (separate design doc)
- "My Charts" per-musician filtered view (future feature)
- Drag-and-drop chart reordering
- Chart upload from within the app
