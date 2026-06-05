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
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingConfig = useRef<Record<string, unknown> | null>(null);
  // Once entries have been sent successfully, treat show as migrated for the rest of the session.
  // Prevents stale setlistMigrated=false from reverting to legacy path after removing all songs.
  const hasSentEntries = useRef(false);

  const isReadOnly = !isOwner && !isEditor;

  const doSave = useCallback(async (config: Record<string, unknown>) => {
    if (!showId || isReadOnly) return;

    setSaving(true);
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

      const res = await fetch('/api/shows/update', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const { updated_at } = await res.json();
        setLastSavedAt(updated_at);
        // Cache server timestamp for offline conflict detection
        localStorage.setItem(`showrunr-last-saved-${showId}`, updated_at);
        // Once entries have been sent successfully, lock into entries path
        if (payload.entries !== undefined) {
          hasSentEntries.current = true;
        }
      }
    } catch {
      // Network error — config remains in localStorage as fallback
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
      setlistMigrated,
    },
    saveConfig,
  };
}
