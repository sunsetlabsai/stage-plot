// This browser's copy of a show (docs/design-version-checked-save.md §4).
//
// ONE storage entry per show holds the config, the server version it is built on
// (`base`) and whether it holds edits the server has not confirmed (`unsynced`).
// One entry, one setItem: the three can never disagree, and a write that throws
// leaves the previous entry whole (§4.2a). Only the tab holding the show's edit
// lock writes an owner's entry (§4.0, lib/edit-lock).
//
// Pure apart from the Storage it is handed, so tests pass a fake.

export type ShowStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const entryKey = (showId: string) => `showrunr-show-${showId}`;
// What bundles before this one wrote: a bare config. Read as a fallback only, and
// never written — a NEW key, so an old bundle still served offline by the service
// worker can never read this format as a show (it would render garbage).
export const legacyKey = (showId: string) => `showrunr-cache-${showId}`;

export interface ShowEntry {
  config: Record<string, unknown>;
  /** The server `updated_at` this copy is built on, verbatim; null if never known. */
  base: string | null;
  /** True while the copy holds edits the server has not confirmed. */
  unsynced: boolean;
  /**
   * Read from a pre-v2 bundle's bare cache. Whether it holds an unsent edit is NOT
   * known (that bundle cached before its 2 s debounce), so the owner's tab decides
   * against the server (lib/use-show `onWritable`, Codex R1 on #202).
   */
  legacy?: boolean;
}

interface StoredEntry extends ShowEntry {
  v: 2;
}

/**
 * The entry, or null. A pre-v2 value is a bare config written by an older bundle,
 * returned with `legacy: true` and no known base.
 */
export function readEntry(store: ShowStore, showId: string): ShowEntry | null {
  let raw: string | null;
  try {
    raw = store.getItem(entryKey(showId)) ?? store.getItem(legacyKey(showId));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const p = parsed as Partial<StoredEntry>;
    if (p.v === 2) {
      if (!p.config || typeof p.config !== 'object') return null;
      return {
        config: p.config,
        base: typeof p.base === 'string' ? p.base : null,
        unsynced: p.unsynced === true,
      };
    }
    // NO base, ever (Codex R2 on #202): that bundle wrote the copy and its
    // `showrunr-last-saved-{id}` version separately, and swallowed a failed copy
    // write, so the version cannot prove the copy was built on it. Paired, a stale
    // copy could be sent at a matching version and overwrite a newer save.
    return { config: parsed as Record<string, unknown>, base: null, unsynced: false, legacy: true };
  } catch {
    return null;
  }
}

/**
 * May a VIEWER's load replace this show's entry with the server copy? Never over an
 * owner's unsynced edits (§4.0 item 5), and never over an old bundle's copy in a
 * browser where an owner has saved (Codex R3 on #202): that copy may hold an unsent
 * edit, and only the owner's tab can classify it — a lapsed session must not erase
 * it. The old bundle wrote `showrunr-last-saved-{id}` only on an owner's save, so a
 * performer's phone has none and keeps refreshing. Only the key's presence is used,
 * never its value (R2).
 */
export function viewerMayOverwrite(store: ShowStore, showId: string): boolean {
  const e = readEntry(store, showId);
  if (!e) return true;
  if (e.unsynced) return false;
  if (e.legacy) {
    try { return store.getItem(`showrunr-last-saved-${showId}`) === null; } catch { return false; }
  }
  return true;
}

/** Write the whole entry. THROWS if storage refuses — callers decide what that means. */
export function writeEntry(store: ShowStore, showId: string, entry: ShowEntry): void {
  const stored: StoredEntry = { v: 2, config: entry.config, base: entry.base, unsynced: entry.unsynced };
  store.setItem(entryKey(showId), JSON.stringify(stored));
  // The old copy is now superseded; it must not resurface if this entry is deleted.
  try { store.removeItem(legacyKey(showId)); } catch { /* harmless: v2 is read first */ }
}

/** Remove the entry. THROWS if storage refuses. */
export function deleteEntry(store: ShowStore, showId: string): void {
  store.removeItem(entryKey(showId));
  store.removeItem(legacyKey(showId));
}

/**
 * The show's content as the server would echo it back, for "is this the same
 * show?" (§4.3 step 3, §4.4). Ignored:
 *  - `charts` — attached from the library on every load, never part of a save;
 *  - setlist row `id` and `songId` — rpc_save_show gives every row a fresh random id
 *    per save and resolves songId server-side, so the client's copy may lack it;
 *  - key order and undefined/null-vs-missing — JSON shape, not content.
 * A false "different" only ever asks the owner; it can never drop a copy.
 */
export function showContent(config: unknown): string {
  try {
    return JSON.stringify(canon(config, null, new Set()));
  } catch {
    // Unserializable (a cycle): never equal to anything, so it counts as a change
    // and the save path reports the failure — this must not throw into a render.
    return `\u0000unserializable:${++unserializable}`;
  }
}
let unserializable = 0;

export function sameShow(a: unknown, b: unknown): boolean {
  try {
    return showContent(a) === showContent(b);
  } catch {
    return false;
  }
}

function canon(v: unknown, parentKey: string | null, path: Set<object>): unknown {
  if (!v || typeof v !== 'object') return v;
  // Ancestors only: a shared (non-cyclic) reference is fine, as for JSON.stringify.
  if (path.has(v)) throw new TypeError('cycle');
  path.add(v);
  try {
    if (Array.isArray(v)) return v.map((x) => canon(x, parentKey, path));
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      if (k === 'charts') continue;
      if ((k === 'id' || k === 'songId') && parentKey === 'setlist') continue;
      const val = (v as Record<string, unknown>)[k];
      if (val === undefined || val === null) continue;
      out[k] = canon(val, k, path);
    }
    return out;
  } finally {
    path.delete(v);
  }
}

// ── Ownership, for opening a show offline (UAT S2) ──────────────────────────
// Who owned the show when this browser last loaded it, so an owner who opens it
// offline can still edit. Not show content: any tab may write it.

const ownerKey = (showId: string) => `showrunr-show-owner-${showId}`;

export interface Ownership {
  ownerId: string;
  setlistMigrated: boolean;
}

export function rememberOwnership(store: ShowStore, showId: string, own: Ownership): void {
  try { store.setItem(ownerKey(showId), JSON.stringify(own)); } catch { /* offline editing degrades to read-only */ }
}

export function readOwnership(store: ShowStore, showId: string): Ownership | null {
  try {
    const raw = store.getItem(ownerKey(showId));
    if (!raw) return null;
    const o = JSON.parse(raw) as Partial<Ownership>;
    return typeof o.ownerId === 'string' ? { ownerId: o.ownerId, setlistMigrated: o.setlistMigrated === true } : null;
  } catch {
    return null;
  }
}
