// Offline edits that have not reached the server (UAT S2, S3, S4).
//
// Every owner edit is written to this browser at once (`showrunr-cache-{id}`,
// lib/use-show) and to the server after a 2 s debounce. Before this module nothing
// recorded whether the browser copy had reached the server, so the next online
// load overwrote it with the server's copy and offline edits vanished (S3), and so
// did the last 2 s of edits when a phone locked (S4).
//
// The UNSYNCED marker closes that: set on every cached edit, cleared only when a
// save of the LATEST edit succeeds. It records the server version the edits were
// made on top of (`base`), which is what lets the next online load decide without
// guessing:
//   - server unchanged since `base` ⇒ the browser copy is simply newer: keep it.
//   - server changed since `base`  ⇒ another device saved too. Neither copy is
//     dropped silently: the server's is shown and the browser's is set aside for
//     the owner to restore or discard. Which copy SHOULD win when two devices edit
//     is S5's design; this only guarantees nothing is lost without being asked.

/** The slice of the DOM Storage API these rules need — so tests can fake it. */
export type SyncStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const cacheKey = (showId: string) => `showrunr-cache-${showId}`;
export const lastSavedKey = (showId: string) => `showrunr-last-saved-${showId}`;
const unsyncedKey = (showId: string) => `showrunr-unsynced-${showId}`;
const setAsideKey = (showId: string) => `showrunr-offline-edits-${showId}`;
const ownerKey = (showId: string) => `showrunr-show-owner-${showId}`;

/** Edits cached in this browser that the server has not confirmed. */
export interface Unsynced {
  /** When the first unsynced edit was cached (ISO). */
  since: string;
  /** The server `updated_at` those edits were made on top of; null if never known. */
  base: string | null;
}

function readJson<T>(store: SyncStore, key: string): T | null {
  try {
    const raw = store.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function readUnsynced(store: SyncStore, showId: string): Unsynced | null {
  const u = readJson<Unsynced>(store, unsyncedKey(showId));
  return u && typeof u.since === 'string' ? u : null;
}

/**
 * Mark the cached copy as not yet on the server. The FIRST unsynced edit fixes
 * `since` and `base`; later edits keep them, because the base that matters is the
 * server version the whole run of edits started from.
 */
export function markUnsynced(store: SyncStore, showId: string, now: string): void {
  if (readUnsynced(store, showId)) return;
  const base = store.getItem(lastSavedKey(showId));
  try {
    store.setItem(unsyncedKey(showId), JSON.stringify({ since: now, base } satisfies Unsynced));
  } catch {
    // Quota: recovery degrades to today's behaviour; the save itself is unaffected.
  }
}

export function clearUnsynced(store: SyncStore, showId: string): void {
  try { store.removeItem(unsyncedKey(showId)); } catch { /* storage blocked */ }
}

/** Record the server version this browser last saw (a load or a successful save). */
export function rememberServerVersion(store: SyncStore, showId: string, updatedAt: string): void {
  try { store.setItem(lastSavedKey(showId), updatedAt); } catch { /* quota */ }
}

export type Reconcile =
  /** Nothing unsynced: the server copy is the show. */
  | { kind: 'server' }
  /** The server has not moved since the offline edits began: they are simply newer. */
  | { kind: 'local'; config: unknown }
  /** Both moved. Show the server's; set the browser's aside for the owner to decide. */
  | { kind: 'conflict'; config: unknown; since: string };

/**
 * What an ONLINE load of a show this owner has unsynced edits for should show.
 * Pure: the caller reads the store first, before anything overwrites the cache.
 *
 * `base` null means this browser never learned a server version (a pre-marker
 * cache). That cannot prove the server unchanged, so it is a conflict — asking is
 * the only answer that cannot lose an edit.
 */
export function reconcileOnLoad(
  unsynced: Unsynced | null,
  cachedConfig: unknown,
  serverUpdatedAt: string | null,
  serverConfig: unknown,
): Reconcile {
  if (!unsynced || cachedConfig == null) return { kind: 'server' };
  // A marker over a copy that IS the server's (a save-on-load that failed, then
  // nothing edited) has nothing to keep. Without this, another device's save
  // would raise a restore prompt for edits nobody made.
  if (sameShow(cachedConfig, serverConfig)) return { kind: 'server' };
  if (sameInstant(unsynced.base, serverUpdatedAt)) {
    return { kind: 'local', config: cachedConfig };
  }
  return { kind: 'conflict', config: cachedConfig, since: unsynced.since };
}

// Compared as instants, not strings: the save RPC and the show GET serialise
// `updated_at` by different paths, and a formatting difference must not read as
// another device's save.
function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isFinite(ta) && ta === tb;
}

// Same show content, ignoring `charts`: the cache holds the config with the
// owner's library charts attached at load, the server config does not. Key order
// can differ, which only ever reads as "different" — the asking direction.
function sameShow(a: unknown, b: unknown): boolean {
  const strip = (c: unknown) =>
    JSON.stringify(c, (k, v) => (k === 'charts' ? undefined : v));
  try {
    return strip(a) === strip(b);
  } catch {
    return false;
  }
}

/** The cached config, or null. */
export function readCachedConfig(store: SyncStore, showId: string): unknown {
  return readJson<unknown>(store, cacheKey(showId));
}

/** Offline edits set aside by a conflict, kept across reloads until the owner decides. */
export interface SetAside {
  config: unknown;
  since: string;
}

export function setAside(store: SyncStore, showId: string, edits: SetAside): void {
  try { store.setItem(setAsideKey(showId), JSON.stringify(edits)); } catch { /* quota */ }
}

export function readSetAside(store: SyncStore, showId: string): SetAside | null {
  const s = readJson<SetAside>(store, setAsideKey(showId));
  return s && typeof s.since === 'string' && s.config != null ? s : null;
}

export function clearSetAside(store: SyncStore, showId: string): void {
  try { store.removeItem(setAsideKey(showId)); } catch { /* storage blocked */ }
}

/** What the offline fallback needs to restore owner editing (S2). */
export interface CachedOwnership {
  ownerId: string;
  setlistMigrated: boolean;
}

export function rememberOwnership(store: SyncStore, showId: string, o: CachedOwnership): void {
  try { store.setItem(ownerKey(showId), JSON.stringify(o)); } catch { /* quota */ }
}

export function readOwnership(store: SyncStore, showId: string): CachedOwnership | null {
  const o = readJson<CachedOwnership>(store, ownerKey(showId));
  return o && typeof o.ownerId === 'string' ? o : null;
}
