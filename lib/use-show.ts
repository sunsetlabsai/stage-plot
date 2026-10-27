'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { shouldSendEntries } from './overrides';
import { cacheKey, clearUnsynced, markUnsynced, rememberServerVersion } from './offline-sync';

// keepalive requests share a 64 KiB in-flight budget; a larger body is rejected
// outright. Over it, the flush on page hide sends normally and may be cut off —
// the unsynced marker then recovers the edit on the next load (lib/offline-sync).
const KEEPALIVE_MAX_BYTES = 60_000;

interface ShowContext {
  showId: string | null;
  slug: string | null;
  isOwner: boolean;
  isReadOnly: boolean;
  saving: boolean;
  lastSavedAt: string | null;
  saveError: string | null;
  setlistMigrated: boolean;
}

interface UseShowReturn {
  context: ShowContext;
  saveConfig: (config: Record<string, unknown>) => void;
  resave: (config: Record<string, unknown>) => void;
}

// Debounced auto-save to Supabase for authenticated users
export function useShow(
  showId: string | null,
  slug: string | null,
  isOwner: boolean,
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
  // Bumped per cached edit. A save clears the unsynced marker only if it carried
  // the LATEST edit and nothing is waiting — else an older save's success would
  // declare a newer, unsaved edit synced (UAT S3).
  const editSeq = useRef(0);

  // Collaborators are view-only (§3.3c), so ownership is the whole write gate.
  const isReadOnly = !isOwner;

  const doSave = useCallback(async (config: Record<string, unknown>, opts: { seq: number; keepalive?: boolean }) => {
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
      // rows with no songId and an unnormalizable title fall back to legacy so the
      // save can't be blocked.
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
          // On page hide (S4): lets the request outlive the page, within budget.
          keepalive: !!opts.keepalive && body.length <= KEEPALIVE_MAX_BYTES,
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
          "you appear to be offline. Your changes are kept in this browser and will save when you're back online.",
        );
        return; // `finally` still clears `saving`
      }

      if (res.ok) {
        const { updated_at } = await res.json();
        setLastSavedAt(updated_at);
        setSaveError(null);
        // Cache the server version for the next load's reconcile, and clear the
        // unsynced marker if this save carried the latest edit (lib/offline-sync).
        // Best-effort: the SERVER is the source of truth and the save has already
        // persisted, so blocked storage must not surface as a failure.
        try {
          rememberServerVersion(localStorage, showId, updated_at);
          if (opts.seq === editSeq.current && pendingConfig.current === null) clearUnsynced(localStorage, showId);
        } catch {
          // Reconcile degrades to asking; the save itself stands.
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
    const seq = ++editSeq.current;

    // Write to this browser first, and mark it unsynced until the server confirms
    // (UAT S3/S4): this copy is what survives an offline session or a killed tab.
    // Only a CHANGE marks it. The page saves once on every load; a show opened
    // offline and never touched must not later read as offline edits — or worse,
    // be pushed over another device's save.
    try {
      const json = JSON.stringify(config);
      const changed = localStorage.getItem(cacheKey(showId)) !== json;
      localStorage.setItem(cacheKey(showId), json);
      if (changed) markUnsynced(localStorage, showId, new Date().toISOString());
    } catch { /* quota */ }

    // Debounce: save to Supabase after 2s of no changes
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      if (pendingConfig.current) {
        const latest = pendingConfig.current;
        pendingConfig.current = null;
        doSave(latest, { seq });
      }
    }, 2000);
  }, [showId, isReadOnly, doSave]);

  // Send the waiting edit now instead of after the debounce.
  const flush = useCallback((keepalive: boolean) => {
    if (!pendingConfig.current || !showId || isReadOnly) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const latest = pendingConfig.current;
    pendingConfig.current = null;
    doSave(latest, { seq: editSeq.current, keepalive });
  }, [showId, isReadOnly, doSave]);

  // S4: a phone lock or tab kill fires pagehide / visibilitychange, never React's
  // unmount, so the last 2 s of edits waited on a timer that would never run.
  // (Reconnecting is NOT handled here: re-sending blind could overwrite another
  // device's save. The page re-checks the server version first — S3.)
  useEffect(() => {
    if (!showId || isReadOnly) return;
    const onHide = () => flush(true);
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush(true); };
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVisibility);
      // Unmount (or a show change): send what is waiting rather than drop it.
      flush(false);
    };
  }, [showId, isReadOnly, flush]);

  // Save the current show now, even though it is already cached — the page's
  // reconnect path calls this once it has checked the server has not moved.
  const resave = useCallback((config: Record<string, unknown>) => {
    if (!showId || isReadOnly) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    pendingConfig.current = null;
    doSave(config, { seq: editSeq.current });
  }, [showId, isReadOnly, doSave]);

  return {
    context: {
      showId,
      slug,
      isOwner,
      isReadOnly,
      saving,
      lastSavedAt,
      saveError,
      setlistMigrated,
    },
    saveConfig,
    resave,
  };
}
