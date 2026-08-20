'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { shouldSendEntries } from './overrides';

interface ShowContext {
  showId: string | null;
  slug: string | null;
  isOwner: boolean;
  isEditor: boolean;
  isReadOnly: boolean;
  saving: boolean;
  lastSavedAt: string | null;
  saveError: string | null;
  setlistMigrated: boolean;
}

interface UseShowReturn {
  context: ShowContext;
  saveConfig: (config: Record<string, unknown>) => void;
}

// Debounced auto-save to Supabase for authenticated users
export function useShow(
  showId: string | null,
  slug: string | null,
  isOwner: boolean,
  isEditor: boolean,
  setlistMigrated: boolean = false,
): UseShowReturn {
  const [saving, setSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingConfig = useRef<Record<string, unknown> | null>(null);
  // Once entries have been sent successfully, treat show as migrated for the rest of the session.
  // Prevents stale setlistMigrated=false from reverting to legacy path after removing all songs.
  const hasSentEntries = useRef(false);

  const isReadOnly = !isOwner && !isEditor;

  const doSave = useCallback(async (config: Record<string, unknown>) => {
    if (!showId || isReadOnly) return;

    setSaving(true);
    setSaveError(null);
    try {
      // Build save payload
      const payload: Record<string, unknown> = {
        id: showId,
        config,
        name: (config.showInfo as { bandName?: string; showName?: string })?.showName
          || (config.showInfo as { bandName?: string })?.bandName
          || 'Untitled',
        venue: (config.showInfo as { venue?: string })?.venue,
        show_date: (config.showInfo as { eventDate?: string })?.eventDate,
      };

      // Decide entries (reference path) vs legacy blob. Owners migrate-on-first-save;
      // editors stay legacy until owner/seed migrates. Rows with no songId and an
      // unnormalizable title fall back to legacy so the save can't be blocked.
      // See shouldSendEntries for the full rule.
      const setlist = config.setlist as Array<{
        songId?: string; position: number; title: string;
        key?: string; lead?: string; notes?: string; sceneNote?: string;
      }> | undefined;

      if (shouldSendEntries(setlist, { isOwner, setlistMigrated, hasSentEntries: hasSentEntries.current })) {
        // Send entries with effective values — server will diff against song defaults
        payload.entries = (setlist || []).map((s) => ({
          song_id: s.songId || null,
          title: s.title,
          position: s.position,
          key: s.key,
          lead: s.lead,
          notes: s.notes,
          scene_note: s.sceneNote ?? null,
        }));
      }

      // ★ Only the FETCH may produce the offline message (Codex R1 medium).
      // Wrapping the whole success branch meant any later throw — the browser
      // cache write below, or a malformed 200 body — reported "you appear to be
      // offline" for a save that had already persisted server-side. That is this
      // chunk's own defect wearing the opposite mask: §1.1 exists to stop the app
      // reporting success it did not achieve, and it must not start reporting
      // failure it did not suffer.
      // Serialize BEFORE the fetch-only try (Codex R2 low): inside it, a
      // JSON.stringify throw would report "offline" for a request never sent,
      // and the generic catch below claims to own this case but could not reach it.
      const body = JSON.stringify(payload);

      let res: Response;
      try {
        res = await fetch('/api/shows/update', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
      } catch {
        // §1.1: the config IS still cached (saveConfig writes localStorage before
        // debouncing) but it did NOT reach the server. Saying nothing here left
        // `lastSavedAt` at its previous value, so the pill kept rendering a green
        // "Saved" through an entire offline session — the app reporting success
        // for something that did not happen.
        //
        // The pill already prefixes "Couldn't save — ", so this carries the CAUSE
        // only. No auto-retry: the existing 2s debounce retries on the next edit,
        // and a background loop would be a new mechanism with its own failure modes.
        setSaveError(
          "you appear to be offline. Your changes are cached in this browser and will save on your next edit once you're back.",
        );
        return; // `finally` still clears `saving`
      }

      if (res.ok) {
        const { updated_at } = await res.json();
        setLastSavedAt(updated_at);
        setSaveError(null);
        // Cache server timestamp for offline conflict detection. Best-effort:
        // the SERVER is the source of truth and the save has already persisted,
        // so a quota error or Safari private mode must not surface as a failure.
        try {
          localStorage.setItem(`showrunr-last-saved-${showId}`, updated_at);
        } catch {
          // Conflict detection degrades; the save itself stands.
        }
        // Once entries have been sent successfully, lock into entries path
        if (payload.entries !== undefined) {
          hasSentEntries.current = true;
        }
      } else {
        // Save rejected (e.g. a song title couldn't be resolved on a migrated show).
        // Surface it — config stays in localStorage but did NOT persist server-side.
        const { error } = await res.json().catch(() => ({ error: '' }));
        setSaveError(error || 'Could not save changes.');
      }
    } catch {
      // Anything left: payload serialization, or a 200 whose body would not
      // parse. The save may or may not have landed, so this deliberately does
      // NOT claim offline — an unreachable network is one specific cause and it
      // is handled at its own call above.
      setSaveError('Could not save changes.');
    } finally {
      setSaving(false);
    }
  }, [showId, isReadOnly, isOwner, setlistMigrated]);

  const saveConfig = useCallback((config: Record<string, unknown>) => {
    if (!showId || isReadOnly) return;

    pendingConfig.current = config;

    // Also write to localStorage as offline cache
    try { localStorage.setItem(`showrunr-cache-${showId}`, JSON.stringify(config)); } catch { /* quota */ }

    // Debounce: save to Supabase after 2s of no changes
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      if (pendingConfig.current) {
        doSave(pendingConfig.current);
        pendingConfig.current = null;
      }
    }, 2000);
  }, [showId, isReadOnly, doSave]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      // Flush pending save on unmount
      if (pendingConfig.current && showId && !isReadOnly) {
        doSave(pendingConfig.current);
      }
    };
  }, [showId, isReadOnly, doSave]);

  return {
    context: {
      showId,
      slug,
      isOwner,
      isEditor,
      isReadOnly,
      saving,
      lastSavedAt,
      saveError,
      setlistMigrated,
    },
    saveConfig,
  };
}
