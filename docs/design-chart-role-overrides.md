# Multi-Role Chart Overrides — Design Spec v1.0

Phase 2 of the inline chart viewer (see `design-inline-chart-viewer.md` v1.3).

## Problem

Charts live in a single Drive folder by role (e.g., `Guitar/Superstition.pdf`). But the same chord chart is often useful for multiple roles — the guitarist, pianist, and vocalist may all use the same chart. Today, the only way to make a chart appear for multiple roles is to duplicate the file into each folder in Drive. This is fragile, wastes space, and creates duplicate-detection noise.

## Goal

Let users assign a chart to additional roles without touching Drive. A chord chart in `Guitar/` can be tagged to also show for Piano and Lyrics, all within the app.

## Data Model

### ChartOverride

```typescript
interface ChartOverride {
  fileId: string;          // references the Chart.fileId from resolution
  sourceRole: string;      // original folder role (e.g., "Guitar")
  additionalRoles: string[]; // roles this chart should also appear for
}
```

### Storage: per-song on SetlistSong

```typescript
interface SetlistSong {
  // ... existing fields (id, position, title, lead, notes, sceneNote, charts)
  chartOverrides?: ChartOverride[];
}
```

Per-song only — no top-level map. Overrides are colocated with the song they apply to. This means:
- Each song independently controls its chart assignments
- No cross-song state to keep in sync
- YAML serialization is straightforward (nested under each song)

### Why not per-show global overrides?

A global "Guitar charts always apply to Piano" rule sounds convenient but breaks in practice:
- Some songs have instrument-specific arrangements (Piano has a different chart than Guitar)
- A shared override would silently apply to new songs added later, which may not be correct
- Per-song granularity is explicit and predictable

## YAML Serialization

Overrides serialize as part of the setlist in the show file:

```yaml
setlist:
  - title: Superstition
    lead: Graham
    notes: "Key of E"
    chartOverrides:
      - fileId: "1L2OMatyMcvDxMFC8S2uiuiJFyWD8R-IS"
        sourceRole: Guitar
        additionalRoles:
          - Piano
          - Lyrics
  - title: September
    lead: Rachel
```

Songs without overrides omit the field entirely (no empty arrays).

### Backwards compatibility

- Existing show files without `chartOverrides` load normally (field is optional)
- Show files with overrides opened in an older app version are unaffected — unknown fields are ignored by the YAML parser
- The `charts` array on SetlistSong (populated at runtime by batch resolution) is never serialized, so overrides don't conflict with it

## Resolution with Overrides

Chart resolution (batch API) is unchanged — it produces `charts[]` per song from Drive folders as today.

At **display time**, the role filter applies overrides:

```typescript
function chartsForRole(song: SetlistSong, role: string): Chart[] {
  const direct = (song.charts ?? []).filter((c) => c.role === role);

  if (role === 'all') return song.charts ?? [];

  // Find charts from other roles that have been overridden to include this role
  const overridden = (song.charts ?? []).filter((c) => {
    if (c.role === role) return false; // already in direct
    const override = song.chartOverrides?.find((o) => o.fileId === c.fileId);
    return override?.additionalRoles.includes(role) ?? false;
  });

  return [...direct, ...overridden];
}
```

This function replaces the current inline filter in ChartNavigator. The pill picker and viewer use its output.

## Setup Tab UX

### Where it lives

Inside the existing **Setlist** section of the Setup tab. After chart resolution, each song row that has matched charts gets an expandable override control.

### Interaction flow

1. Charts resolve as today (automatic on setlist/folder change, or manual "Refresh Charts")
2. For songs with matched charts, a small "Roles" link appears next to the chart indicator dot
3. Clicking "Roles" expands an inline panel below the song row showing:

```
┌─────────────────────────────────────────────────┐
│ Superstition                                     │
│ ┌─────────────────────────────────────────────┐  │
│ │ Guitar/Superstition.pdf                     │  │
│ │ Also show for: [x] Piano [ ] Bass           │  │
│ │                [x] Lyrics [ ] Horns          │  │
│ └─────────────────────────────────────────────┘  │
│ ┌─────────────────────────────────────────────┐  │
│ │ Lyrics/Superstition.pdf                     │  │
│ │ Also show for: [ ] Piano [ ] Bass           │  │
│ │                [ ] Guitar [ ] Horns          │  │
│ └─────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

- Each matched chart shows its source role and filename
- Checkboxes for all other known roles (derived from Drive folder names)
- Checking a role adds it to `additionalRoles` for that chart's override
- Unchecking removes it
- If all additional roles are removed, the override entry is deleted (no empty arrays)

### Available roles

The checkbox list comes from the set of all role folder names discovered during chart resolution (same `allRoles` array used by the role filter dropdown). This ensures only real folder names appear — no freeform text.

### Bulk override (future consideration)

A "same for all songs" shortcut is deliberately excluded from v1.0. Per-song is explicit and avoids surprises. If users request it, a bulk-apply UI can be added later without schema changes.

## Show Tab / Viewer Integration

### Role filter

When the role filter is active (e.g., "Guitar"), `chartsForRole(song, 'Guitar')` returns:
- Charts natively in the Guitar folder, PLUS
- Charts from other folders that have Guitar in their `additionalRoles`

### Pill picker

The pill picker shows all charts returned by `chartsForRole()`. Override-sourced charts show their source role in the pill label (e.g., "Guitar (from Lyrics)") so the user knows it's a shared chart, not a native one.

### Chart count / indicator

The chart indicator dot on the setlist row reflects override-augmented counts. A song with 0 native Guitar charts but 1 override from Lyrics shows as having 1 chart when Guitar filter is active.

### Opacity / dimming

The role-filter dimming logic (songs without charts for the active role are dimmed) uses the override-aware count. Songs that have no native chart but DO have an override are shown at full opacity.

## Shareable URL

`chartOverrides` is part of the config that gets encoded into the shareable `?config=` URL parameter. This means:
- Override assignments travel with the shared link
- Band members opening the link see the same chart assignments
- No server-side state required

## What Changes

| Component | Current | New |
|---|---|---|
| SetlistSong type | No overrides field | Optional `chartOverrides` array |
| Role filter logic | Direct role match only | Direct + override match |
| Setup tab setlist | No override controls | Expandable role checkboxes per chart |
| Pill picker labels | Role name only | Role name + "(from X)" for overrides |
| Chart count/dimming | Native charts only | Override-augmented counts |
| YAML schema | No overrides | Optional `chartOverrides` per song |
| Shareable URL | No overrides | Overrides included in config encoding |

## What Doesn't Change

- Drive folder structure / batch resolution API
- Offline cache (caches by fileId, unaffected by role assignments)
- PDF viewer rendering (receives charts from `chartsForRole()`)
- Memory management / prefetch strategy

## Build Checklist

1. Add `chartOverrides` to `SetlistSong` type in `lib/types.ts`
2. Add `chartsForRole()` utility function
3. Replace inline role filter in ChartNavigator with `chartsForRole()`
4. Update pill picker to show "(from X)" for override-sourced charts
5. Update role-filter dimming logic in setlist rows to use `chartsForRole()`
6. Add override UI in Setup tab setlist (expandable panel with checkboxes)
7. Wire checkbox changes to `updateConfig` (add/remove override entries)
8. Update YAML serialization to include/exclude `chartOverrides`
9. Verify shareable URL round-trips overrides correctly
