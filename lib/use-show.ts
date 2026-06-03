'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

interface ShowContext {
  showId: string | null;
  slug: string | null;
  isOwner: boolean;
  isEditor: boolean;
  isReadOnly: boolean;
  saving: boolean;
  lastSavedAt: string | null;
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
): UseShowReturn {
  const [saving, setSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingConfig = useRef<Record<string, unknown> | null>(null);

  const isReadOnly = !isOwner && !isEditor;

  const doSave = useCallback(async (config: Record<string, unknown>) => {
    if (!showId || isReadOnly) return;

    setSaving(true);
    try {
      const res = await fetch('/api/shows/update', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: showId,
          config,
          name: (config.showInfo as { bandName?: string; showName?: string })?.showName
            || (config.showInfo as { bandName?: string })?.bandName
            || 'Untitled',
          venue: (config.showInfo as { venue?: string })?.venue,
          show_date: (config.showInfo as { eventDate?: string })?.eventDate,
        }),
      });

      if (res.ok) {
        const { updated_at } = await res.json();
        setLastSavedAt(updated_at);
        // Cache server timestamp for offline conflict detection
        localStorage.setItem(`showrunr-last-saved-${showId}`, updated_at);
      }
    } catch {
      // Network error — config remains in localStorage as fallback
    } finally {
      setSaving(false);
    }
  }, [showId, isReadOnly]);

  const saveConfig = useCallback((config: Record<string, unknown>) => {
    if (!showId || isReadOnly) return;

    pendingConfig.current = config;

    // Also write to localStorage as offline cache
    localStorage.setItem(`showrunr-cache-${showId}`, JSON.stringify(config));

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
    },
    saveConfig,
  };
}
