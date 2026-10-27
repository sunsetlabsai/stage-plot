import { describe, it, expect } from 'vitest';
import {
  cacheKey, lastSavedKey, markUnsynced, readUnsynced, clearUnsynced, reconcileOnLoad,
  setAside, readSetAside, clearSetAside, rememberOwnership, readOwnership, type SyncStore,
} from '../lib/offline-sync';

// UAT S2/S3/S4: what this browser holds that the server has not confirmed, and
// what the next online load does with it.

const store = (initial: Record<string, string> = {}): SyncStore & { map: Map<string, string> } => {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
};

const ID = 'show-1';
const T1 = '2026-10-27T10:00:00.123456+00:00';
const T2 = '2026-10-27T11:00:00+00:00';
const SERVER = { showInfo: { venue: 'A' }, setlist: [{ title: 'Song', charts: [{ url: 'x' }] }] };
const LOCAL = { showInfo: { venue: 'B' }, setlist: [{ title: 'Song' }] };

describe('the unsynced marker', () => {
  it('the FIRST edit fixes since and base; later edits keep them', () => {
    const s = store({ [lastSavedKey(ID)]: T1 });
    markUnsynced(s, ID, 'first');
    s.setItem(lastSavedKey(ID), T2);
    markUnsynced(s, ID, 'second');
    expect(readUnsynced(s, ID)).toEqual({ since: 'first', base: T1 });
  });

  it('records base null when this browser never learned a server version', () => {
    const s = store();
    markUnsynced(s, ID, 'now');
    expect(readUnsynced(s, ID)).toEqual({ since: 'now', base: null });
    clearUnsynced(s, ID);
    expect(readUnsynced(s, ID)).toBeNull();
  });
});

describe('reconcileOnLoad', () => {
  const u = (base: string | null) => ({ since: 'then', base });

  it('nothing unsynced ⇒ the server copy', () => {
    expect(reconcileOnLoad(null, LOCAL, T1, SERVER)).toEqual({ kind: 'server' });
  });

  it('server unchanged since the edits began ⇒ the edits are just newer: keep them', () => {
    expect(reconcileOnLoad(u(T1), LOCAL, T1, SERVER)).toEqual({ kind: 'local', config: LOCAL });
  });

  it('the same instant in a different format still counts as unchanged', () => {
    expect(reconcileOnLoad(u('2026-10-27T11:00:00Z'), LOCAL, T2, SERVER).kind).toBe('local');
  });

  it('★ server changed since ⇒ conflict: both kept, never a silent overwrite', () => {
    expect(reconcileOnLoad(u(T1), LOCAL, T2, SERVER)).toEqual({ kind: 'conflict', config: LOCAL, since: 'then' });
  });

  it('an unknown base cannot prove the server unchanged ⇒ conflict (ask, never lose)', () => {
    expect(reconcileOnLoad(u(null), LOCAL, T1, SERVER).kind).toBe('conflict');
  });

  it('a cached copy that IS the server copy (charts aside) has nothing to keep', () => {
    const cachedWithCharts = { showInfo: { venue: 'A' }, setlist: [{ title: 'Song', charts: [{ url: 'old' }] }] };
    const serverBare = { showInfo: { venue: 'A' }, setlist: [{ title: 'Song' }] };
    expect(reconcileOnLoad(u(T1), cachedWithCharts, T2, serverBare)).toEqual({ kind: 'server' });
  });

  it('no cached copy ⇒ the server copy', () => {
    expect(reconcileOnLoad(u(T1), null, T2, SERVER)).toEqual({ kind: 'server' });
  });
});

describe('set-aside edits and cached ownership survive a reload', () => {
  it('round-trips, and clears', () => {
    const s = store();
    setAside(s, ID, { config: LOCAL, since: 'then' });
    expect(readSetAside(s, ID)).toEqual({ config: LOCAL, since: 'then' });
    clearSetAside(s, ID);
    expect(readSetAside(s, ID)).toBeNull();
    rememberOwnership(s, ID, { ownerId: 'u1', setlistMigrated: true });
    expect(readOwnership(s, ID)).toEqual({ ownerId: 'u1', setlistMigrated: true });
  });

  it('a corrupt entry reads as absent, never throws', () => {
    const s = store({ [cacheKey(ID)]: '{', 'showrunr-offline-edits-show-1': 'nope', 'showrunr-show-owner-show-1': '{}' });
    expect(readSetAside(s, ID)).toBeNull();
    expect(readOwnership(s, ID)).toBeNull();
  });
});
