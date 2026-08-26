# Backlog: Show Freeze After Performance

> Status: Backlog (design doc needed before build)

## Problem

Shows remain fully editable forever. **The owner** can keep editing the same show indefinitely, which circumvents any show-count limits in the subscription model and doesn't match the real-world lifecycle of a performance.

*(Amended 2026-08-25: read "Collaborators (or even the owner) can keep editing". Collaborators are VIEW ONLY — see `design-single-backend.md` §3.3c. **The problem this backlog item describes is unchanged**: a single owner editing one show forever is the whole loophole. Removing collaborators from the sentence narrows who can trigger it, not whether it happens.)*

## Requirements

- Shows become read-only after the show date passes
- Owner retains copy/duplicate and export rights but cannot edit the frozen show
- ~~Collaborators also cannot edit after the show date~~ — **MOOT 2026-08-25.** Collaborators cannot edit at *any* time (§3.3c), so a freeze adds nothing for them. The freeze rule applies to **the owner** alone.
- "Save as new show" or "Duplicate" as the escape hatch — creates a new show (counts toward show quota)
- Clear visual indicator that a show is frozen and why

## Design Questions (for full spec)

- Grace period after show date? (e.g., 24-48 hours for post-show corrections)
- What about shows with no date set? (Treat as always editable until a date is added?)
- Does the owner get an "unfreeze" override, or is duplication the only path?
- Interaction with free trial show count — does duplicating a frozen show count as a new show? (Yes — confirmed in payments spec v1.1)

## Design Prerequisites (Codex finding #6)

- Full design must include server-side enforcement (API route guards and/or Supabase RLS policies), not just UI-level freeze.
- Without backend enforcement, UI-only freeze can be bypassed via existing write routes (`PUT /api/shows/update`).
