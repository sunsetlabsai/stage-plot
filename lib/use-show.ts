'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { shouldSendEntries } from './overrides';
import { readEntry, writeEntry, deleteEntry, showContent, type ShowStore } from './show-store';
import { acquireEditLock, type EditLock, type LockState } from './edit-lock';

// Version-checked save (docs/design-version-checked-save.md §4–§5).
//
// Every save carries `base`, the server version this browser's copy is built on,
// and the server refuses a stale one (409). So the rules here are about never
// dropping the owner's copy, not about deciding who wins:
//  - one save in flight; later edits wait and go next with the new base (§4.2);
//  - the copy is cached under an "unsynced" flag in ONE storage entry (§4.2a);
//  - on 409, compare with the server: same content → adopt; else the owner
//    chooses Keep mine / Use the saved one, saves held meanwhile (§4.3, §5);
//  - only the tab holding the show's edit lock writes or sends (§4.0).

// keepalive requests share a 64 KiB in-flight budget; a larger body is rejected
// outright. Over it, the flush on page hide sends normally and may be cut off —
// the unsynced entry then recovers the edit on the next load (S4).
const KEEPALIVE_MAX_BYTES = 60_000;

const OFFLINE_MESSAGE = "you appear to be offline. Your changes are kept in this browser and will save when you're back online.";
export const PERSIST_WARNING = "Couldn't keep your changes on this device — keep this page open until they save.";

type Config = Record<string, unknown>;

/** The server's copy, as the page renders it (charts attached). */
export interface ServerShow {
  config: Config;
  updatedAt: string;
}

export interface Conflict {
  server: ServerShow;
}

interface ShowContext {
  showId: string | null;
  slug: string | null;
  isOwner: boolean;
  /** True for a viewer, AND for an owner whose show is being edited in another tab. */
  isReadOnly: boolean;
  saving: boolean;
  lastSavedAt: string | null;
  saveError: string | null;
  setlistMigrated: boolean;
  lockState: LockState | null;
  /** Set while a 409 waits for the owner's choice (§5). */
  conflict: Conflict | null;
  /** A storage write failed: the changes live only in this page until they save (§4.2a). */
  persistWarning: boolean;
}

interface UseShowOptions {
  /** The show as the page's online load got it; null when opened from the device copy. */
  loaded: ServerShow | null;
  /** Replace what is on screen (restoring this browser's unsynced copy, or Use the saved one). */
  applyConfig: (config: Config) => void;
  /** GET the server's current copy for a 409; null if unreachable. */
  fetchServer: () => Promise<ServerShow | null>;
  /** Injected for tests. */
  storage?: ShowStore;
}

interface UseShowReturn {
  context: ShowContext;
  saveConfig: (config: Config) => void;
  /** "Edit here": take editing over from another tab of this browser (§4.0). */
  editHere: () => void;
  keepMine: () => void;
  useSaved: () => void;
}

function browserStorage(): ShowStore | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function useShow(
  showId: string | null,
  slug: string | null,
  isOwner: boolean,
  setlistMigrated: boolean = false,
  options: UseShowOptions = { loaded: null, applyConfig: () => {}, fetchServer: async () => null },
): UseShowReturn {
  const [saving, setSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lockState, setLockState] = useState<LockState | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [persistWarning, setPersistWarning] = useState(false);

  // Latest options without re-running effects when the page re-renders.
  const opts = useRef(options);
  useEffect(() => { opts.current = options; });
  const store = () => opts.current.storage ?? browserStorage();

  /** This tab may write storage and send saves: it holds the lock (or locks are unsupported). */
  const writable = useRef(false);
  /** The server version this browser's copy is built on, verbatim (§4.1). */
  const base = useRef<string | null>(null);
  /** showContent of the newest local copy — pending, in flight, or confirmed. */
  const latest = useRef<string | null>(null);
  /** The newest edit not yet sent. */
  const pending = useRef<Config | null>(null);
  const inFlight = useRef(false);
  /** Saves held: a 409 is being resolved, or waits for the owner (§4.3). */
  const held = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Once entries have been sent successfully, treat show as migrated for the rest of the session.
  // Prevents stale setlistMigrated=false from reverting to legacy path after removing all songs.
  const hasSentEntries = useRef(false);
  const lock = useRef<EditLock | null>(null);
  /** Whether this tab has taken the lock before (first take may prefer the fresh load). */
  const tookLock = useRef(false);

  // Only an owner's tab asks for the lock; a stale state from a previous show is ignored.
  const effectiveLock = showId && isOwner ? lockState : null;
  // Read-only until this tab may actually write (Codex R1 on #202): a lock grant is
  // asynchronous, and an edit shown on screen but refused by saveConfig while the
  // grant was pending would be dropped on the next reload with no warning.
  const isReadOnly = !isOwner || !(effectiveLock === 'held' || effectiveLock === 'unsupported');

  /** Write the entry; on failure show the warning and report it (§4.2a step 2). */
  const persist = useCallback((config: Config, unsynced: boolean): boolean => {
    const s = store();
    if (!showId || !s) { setPersistWarning(true); return false; }
    try {
      writeEntry(s, showId, { config, base: base.current, unsynced });
      return true;
    } catch {
      setPersistWarning(true);
      return false;
    }
  }, [showId]);

  /**
   * A new base is adopted (§4.2a step 4): the entry becomes the LATEST local copy
   * with that base. Nothing pending → the confirmed copy, clean; if that write
   * throws, delete the entry (no cache beats a stale one beside a fresh base).
   * Pending → the pending copy, still unsynced; if that throws, leave the entry
   * alone — it holds the pending edit with its older base, which 409s and asks.
   */
  const adoptBase = useCallback((newBase: string, confirmed: Config) => {
    base.current = newBase;
    if (pending.current) {
      persist(pending.current, true);
      return;
    }
    if (persist(confirmed, false)) {
      setPersistWarning(false);
      return;
    }
    const s = store();
    try { if (s && showId) deleteEntry(s, showId); } catch { /* the old entry 409s on its next send */ }
  }, [persist, showId]);

  // `send` and `resolveConflict` call each other; refs break the cycle.
  const sendRef = useRef<(keepalive?: boolean) => void>(() => {});

  /** §4.3: the server refused our base. Compare, then adopt or ask. */
  const resolveConflict = useCallback(async () => {
    held.current = true;
    const server = await opts.current.fetchServer();
    if (!writable.current) return;
    if (!server) {
      // Unreachable: un-hold, so `online` / visible / the next edit re-sends,
      // gets the 409 again and comes back here.
      held.current = false;
      setSaveError(OFFLINE_MESSAGE);
      return;
    }
    // Compare against the LATEST local copy at the moment the GET returns (§4.2).
    if (showContent(server.config) === latest.current) {
      pending.current = null;
      held.current = false;
      adoptBase(server.updatedAt, server.config);
      setLastSavedAt(server.updatedAt);
      setSaveError(null);
      return;
    }
    setConflict({ server });
    setSaveError(null);
  }, [adoptBase]);

  const send = useCallback(async (keepalive = false) => {
    if (!showId || !writable.current || inFlight.current || held.current) return;
    const config = pending.current;
    if (!config) return;
    if (base.current === null) {
      // A copy with no known base can't be checked: ask the server (§4.3).
      void resolveConflict();
      return;
    }
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    pending.current = null;
    inFlight.current = true;
    setSaving(true);
    setSaveError(null);

    // Re-queue unless something newer arrived meanwhile.
    const requeue = () => { if (!pending.current) pending.current = config; };
    // Only a success sends the next copy straight away; a failure waits for a
    // retry trigger, or an unreachable server would be hammered in a loop.
    let succeeded = false;

    try {
      const payload: Record<string, unknown> = {
        id: showId,
        config,
        base_updated_at: base.current,
        name: (config.showInfo as { bandName?: string; showName?: string })?.showName
          || (config.showInfo as { bandName?: string })?.bandName
          || 'Untitled',
        venue: (config.showInfo as { venue?: string })?.venue,
        show_date: (config.showInfo as { eventDate?: string })?.eventDate,
      };

      // Decide entries (reference path) vs legacy blob. Owners migrate-on-first-save;
      // rows with no songId and an unnormalizable title fall back to legacy so the
      // save can't be blocked. See shouldSendEntries for the full rule.
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

      // Serialize BEFORE the fetch-only try (Codex R2 low): inside it, a
      // stringify throw would report "offline" for a request never sent.
      const body = JSON.stringify(payload);

      let res: Response;
      try {
        res = await fetch('/api/shows/update', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body,
          // On page hide (S4): lets the request outlive the page, within budget.
          keepalive: keepalive && body.length <= KEEPALIVE_MAX_BYTES,
        });
      } catch {
        // Only the FETCH may produce the offline message. The copy stays cached
        // (unsynced) and goes again on `online`, visible, or the next edit.
        if (!writable.current) return;
        requeue();
        setSaveError(OFFLINE_MESSAGE);
        return;
      }

      // Another tab took editing over while this was in flight: write nothing (§4.0 item 4).
      if (!writable.current) return;

      if (res.ok) {
        const { updated_at } = await res.json();
        latest.current = latest.current ?? showContent(config);
        if (payload.entries !== undefined) hasSentEntries.current = true;
        adoptBase(updated_at, config);
        setLastSavedAt(updated_at);
        setSaveError(null);
        succeeded = true;
        return;
      }

      if (res.status === 409) {
        requeue();
        inFlight.current = false;
        setSaving(false);
        await resolveConflict();
        return;
      }

      // Rejected (e.g. 400 unresolvable title, 428). The copy stays cached and unsynced.
      requeue();
      const { error } = await res.json().catch(() => ({ error: '' }));
      setSaveError(error || 'Could not save changes.');
    } catch {
      // A 200 whose body would not parse: the save may or may not have landed,
      // so this does NOT claim offline. The next send's base check sorts it out.
      if (!writable.current) return;
      requeue();
      setSaveError('Could not save changes.');
    } finally {
      if (inFlight.current) {
        inFlight.current = false;
        setSaving(false);
        // §4.2: what arrived meanwhile goes next, with the new base — unless its
        // debounce is still running, or this attempt failed (retry triggers).
        if (succeeded && writable.current && pending.current && !saveTimer.current && !held.current) {
          sendRef.current();
        }
      }
    }
  }, [showId, isOwner, setlistMigrated, adoptBase, resolveConflict]);

  useEffect(() => { sendRef.current = (k?: boolean) => { void send(k); }; }, [send]);

  // A failed send stops the follow-on loop above (an unreachable server would spin).
  // It goes again on these, and on the next edit (§4.5).
  const retry = useCallback(() => {
    if (pending.current && !inFlight.current && !held.current) sendRef.current();
  }, []);

  const saveConfig = useCallback((config: Config) => {
    if (!showId || isReadOnly || !writable.current) return;
    const content = showContent(config);
    // §4.4: only real changes. The page saves on every load and every render that
    // touches config; an unchanged copy is never marked, cached or sent.
    if (content === latest.current) return;
    latest.current = content;
    pending.current = config;
    persist(config, true);

    if (held.current) return; // §5: edits while held stay unsent
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      sendRef.current();
    }, 2000);
  }, [showId, isReadOnly, persist]);

  /** Taking the lock (load, a closed tab handing over, Edit here): run the load path (§4.5). */
  const onWritable = useCallback(() => {
    if (!showId) return;
    const s = store();
    let entry = s ? readEntry(s, showId) : null;
    const loaded = opts.current.loaded;
    const first = !tookLock.current;
    tookLock.current = true;

    // A pre-v2 bundle's cache (Codex R1 on #202): it cached each edit before its
    // 2 s debounce, so it may hold an edit that never reached the server.
    //  - same content as the fresh load → nothing unsent: treat as clean;
    //  - different → treat as unsynced. Its base is the version that bundle last
    //    saved at: if that is still the server's, the edit goes through (200);
    //    otherwise it 409s — or, with no base, goes straight to §4.3 — and the
    //    owner is asked. Never dropped, never silently overwritten.
    const legacyUnsent = !!entry?.legacy && !(loaded && showContent(entry.config) === showContent(loaded.config));
    if (entry?.unsynced || legacyUnsent) {
      entry = { ...entry!, unsynced: true };
      // This browser holds edits the server never confirmed: show them and send
      // them with their base. A 409 asks (§4.3) — never dropped.
      base.current = entry.base;
      latest.current = showContent(entry.config);
      pending.current = entry.config;
      // Re-home a legacy copy as a marked v2 entry now, so it stays recoverable
      // even if this send never lands.
      if (legacyUnsent) persist(entry.config, true);
      opts.current.applyConfig(entry.config);
      sendRef.current();
      return;
    }
    // A clean entry can be NEWER than this tab's load: a tab that waited for the lock
    // loaded when it opened, and the tab it takes over from may have saved since.
    // Take whichever copy is at the later server version (ordering only — equality
    // is never decided through Date, §3.2).
    const entryIsNewer = !!entry?.base && (!loaded || Date.parse(entry.base) > Date.parse(loaded.updatedAt));
    if (first && loaded && !entryIsNewer) {
      base.current = loaded.updatedAt;
      latest.current = showContent(loaded.config);
      pending.current = null;
      if (!persist(loaded.config, false)) {
        try { if (s) deleteEntry(s, showId); } catch { /* nothing to protect: no edit */ }
      }
      return;
    }
    if (entry) {
      // Handed over from another tab, or opened offline: the entry is the newest copy here.
      base.current = entry.base;
      latest.current = showContent(entry.config);
      pending.current = null;
      if (!first || loaded) opts.current.applyConfig(entry.config);
      return;
    }
    if (loaded) {
      base.current = loaded.updatedAt;
      latest.current = showContent(loaded.config);
    }
  }, [showId, persist]);

  // The edit lock: owners only, per show (§4.0).
  const loadedReady = !!options.loaded;
  useEffect(() => {
    if (!showId || !isOwner) {
      writable.current = false;
      return;
    }
    const l = acquireEditLock(showId, (state) => {
      setLockState(state);
      const nowWritable = state === 'held' || state === 'unsupported';
      if (nowWritable && !writable.current) {
        writable.current = true;
        onWritable();
      } else if (!nowWritable && writable.current) {
        // Lost (Edit here in another tab): stop in this same task — no timer,
        // no retries, no storage writes, including when an in-flight save returns.
        writable.current = false;
        if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
        pending.current = null;
        held.current = false;
        setConflict(null);
        setPersistWarning(false);
      }
    });
    lock.current = l;
    return () => {
      // Unmount or show change: send what is waiting rather than drop it, then let go.
      if (writable.current && pending.current && !inFlight.current && !held.current) sendRef.current(true);
      writable.current = false;
      tookLock.current = false;
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
      l.release();
      lock.current = null;
    };
  // loadedReady: an offline-opened owner who then loads keeps the same lock.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showId, isOwner]);

  // A fresh online load that arrives after the lock: adopt it if nothing local is newer.
  useEffect(() => {
    if (!loadedReady || !writable.current || pending.current || inFlight.current || held.current) return;
    const loaded = opts.current.loaded;
    if (!loaded || base.current === loaded.updatedAt) return;
    if (base.current !== null) return; // the entry already gave a base; a later 409 settles it
    base.current = loaded.updatedAt;
    latest.current = showContent(loaded.config);
    persist(loaded.config, false);
  }, [loadedReady, persist]);

  // S4: a phone lock or tab kill fires pagehide / visibilitychange, never React's
  // unmount, so the last 2 s of edits would wait on a timer that never runs.
  // Coming back (visible, online) retries a save that failed (§4.5).
  useEffect(() => {
    if (!showId || !isOwner) return;
    const flush = () => {
      if (!writable.current || !pending.current || inFlight.current || held.current) return;
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
      sendRef.current(true);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
      else retry();
    };
    window.addEventListener('pagehide', flush);
    window.addEventListener('online', retry);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('online', retry);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [showId, isOwner, retry]);

  const editHere = useCallback(() => {
    if (effectiveLock !== 'elsewhere') return;
    if (!window.confirm('Edit this show here? The other tab becomes view-only.')) return;
    lock.current?.steal();
  }, [effectiveLock]);

  /** §5 Keep mine: send this copy over the server's CURRENT version, knowingly. */
  const keepMine = useCallback(() => {
    if (!conflict || !writable.current) return;
    if (!window.confirm('Replace the saved version with yours? The changes made on the other device are discarded.')) return;
    base.current = conflict.server.updatedAt;
    held.current = false;
    setConflict(null);
    // If a third save landed meanwhile this 409s again and asks again.
    sendRef.current();
  }, [conflict]);

  /** §5 Use the saved one: the only path that replaces the owner's copy — they chose to. */
  const useSaved = useCallback(() => {
    if (!conflict || !writable.current) return;
    if (!window.confirm('Discard your unsaved changes and use the saved version?')) return;
    const { server } = conflict;
    pending.current = null;
    latest.current = showContent(server.config);
    held.current = false;
    setConflict(null);
    adoptBase(server.updatedAt, server.config);
    setLastSavedAt(server.updatedAt);
    opts.current.applyConfig(server.config);
  }, [conflict, adoptBase]);

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
      lockState: effectiveLock,
      conflict,
      persistWarning,
    },
    saveConfig,
    editHere,
    keepMine,
    useSaved,
  };
}
