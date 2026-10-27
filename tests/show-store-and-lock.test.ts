import { describe, it, expect } from 'vitest';
import { readEntry, writeEntry, deleteEntry, showContent, sameShow, entryKey, legacyKey, viewerMayOverwrite } from '../lib/show-store';
import { acquireEditLock, lockName, type LockState } from '../lib/edit-lock';
import { fakeLocks } from './fake-locks';

// docs/design-version-checked-save.md §4.0, §4.2a, §4.3.

function memStore() {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('show-store — one entry holds copy, base and the unsynced flag', () => {
  it('round-trips the three together', () => {
    const s = memStore();
    writeEntry(s, 'a', { config: { x: 1 }, base: 'v1', unsynced: true });
    expect(readEntry(s, 'a')).toEqual({ config: { x: 1 }, base: 'v1', unsynced: true });
  });

  it('reads a pre-v2 bare config (an older bundle), flagged legacy for the owner tab to classify', () => {
    const s = memStore();
    s.setItem(legacyKey('a'), JSON.stringify({ stagePlot: [] }));
    expect(readEntry(s, 'a')).toEqual({ config: { stagePlot: [] }, base: null, unsynced: false, legacy: true });
  });

  it('never writes the legacy key (an old bundle offline must not read the new format) and retires it', () => {
    const s = memStore();
    s.setItem(legacyKey('a'), JSON.stringify({ stagePlot: [] }));
    writeEntry(s, 'a', { config: { x: 1 }, base: 'v1', unsynced: false });
    expect(entryKey('a')).not.toBe(legacyKey('a'));
    expect(s.m.has(legacyKey('a'))).toBe(false);
    deleteEntry(s, 'a');
    expect(readEntry(s, 'a')).toBeNull(); // no stale copy resurfaces
  });

  it('a write that throws leaves the previous entry whole (one setItem)', () => {
    const s = memStore();
    writeEntry(s, 'a', { config: { x: 1 }, base: 'v1', unsynced: true });
    const failing = { ...s, setItem: () => { throw new DOMException('quota'); } };
    expect(() => writeEntry(failing, 'a', { config: { x: 2 }, base: 'v2', unsynced: false })).toThrow();
    expect(readEntry(s, 'a')).toEqual({ config: { x: 1 }, base: 'v1', unsynced: true });
  });
});

describe('viewerMayOverwrite — a viewer load never erases an owner\'s possible edit', () => {
  it('no entry, or a clean v2 entry → may overwrite', () => {
    const s = memStore();
    expect(viewerMayOverwrite(s, 'a')).toBe(true);
    writeEntry(s, 'a', { config: {}, base: 'v1', unsynced: false });
    expect(viewerMayOverwrite(s, 'a')).toBe(true);
  });

  it('an unsynced entry → never (§4.0 item 5)', () => {
    const s = memStore();
    writeEntry(s, 'a', { config: {}, base: 'v1', unsynced: true });
    expect(viewerMayOverwrite(s, 'a')).toBe(false);
  });

  it('an old-bundle copy where an OWNER saved (last-saved key present) → never (Codex R3: lapsed session)', () => {
    const s = memStore();
    s.setItem(legacyKey('a'), JSON.stringify({ n: 5 }));
    s.setItem('showrunr-last-saved-a', 'anything');
    expect(viewerMayOverwrite(s, 'a')).toBe(false);
  });

  it('an old-bundle copy on a performer\'s phone (never saved) → may overwrite, so it keeps refreshing', () => {
    const s = memStore();
    s.setItem(legacyKey('a'), JSON.stringify({ n: 5 }));
    expect(viewerMayOverwrite(s, 'a')).toBe(true);
  });
});

describe('showContent — "the same show" as the server would echo it back', () => {
  it('ignores charts, setlist row id/songId, key order and null-vs-missing', () => {
    const local = { setlist: [{ id: 'local-1', title: 'Song', key: 'G', charts: [{ url: 'x' }] }], showInfo: { venue: 'V', b: undefined } };
    const server = { showInfo: { venue: 'V' }, setlist: [{ songId: 's1', key: 'G', title: 'Song', id: 'srv-9', sceneNote: null }] };
    expect(sameShow(local, server)).toBe(true);
  });

  it('a real difference is different', () => {
    expect(sameShow({ setlist: [{ title: 'A', key: 'G' }] }, { setlist: [{ title: 'A', key: 'A' }] })).toBe(false);
  });

  it('`id` outside the setlist is content', () => {
    expect(sameShow({ members: [{ id: 'm1' }] }, { members: [{ id: 'm2' }] })).toBe(false);
  });

  it('a cycle never throws, and never equals anything (counts as a change)', () => {
    const c: Record<string, unknown> = {};
    c.self = c;
    expect(() => showContent(c)).not.toThrow();
    expect(showContent(c)).not.toBe(showContent(c));
  });

  it('a SHARED (non-cyclic) reference is not a cycle — else every load would look edited', () => {
    const shared = { url: 'x' };
    const cfg = { a: shared, b: shared };
    expect(showContent(cfg)).toBe(showContent({ a: { url: 'x' }, b: { url: 'x' } }));
  });
});

describe('edit lock — one editing tab per show per browser (§4.0)', () => {
  it('first tab holds; a second tab of the same show is elsewhere', async () => {
    const locks = fakeLocks();
    const a: LockState[] = [];
    const b: LockState[] = [];
    acquireEditLock('show-1', (s) => a.push(s), locks as unknown as LockManager);
    await tick();
    acquireEditLock('show-1', (s) => b.push(s), locks as unknown as LockManager);
    await tick();
    expect(a.at(-1)).toBe('held');
    expect(b.at(-1)).toBe('elsewhere');
  });

  it('a different show is independent', async () => {
    const locks = fakeLocks();
    const b: LockState[] = [];
    acquireEditLock('show-1', () => {}, locks as unknown as LockManager);
    acquireEditLock('show-2', (s) => b.push(s), locks as unknown as LockManager);
    await tick();
    expect(b.at(-1)).toBe('held');
  });

  it('closing the holder hands the lock to the waiting tab', async () => {
    const locks = fakeLocks();
    const b: LockState[] = [];
    const tabA = acquireEditLock('show-1', () => {}, locks as unknown as LockManager);
    await tick();
    acquireEditLock('show-1', (s) => b.push(s), locks as unknown as LockManager);
    await tick();
    tabA.release();
    await tick(); await tick();
    expect(b.at(-1)).toBe('held');
  });

  it('Edit here steals: the old tab is told at once (elsewhere), the new one holds', async () => {
    const locks = fakeLocks();
    const a: LockState[] = [];
    const b: LockState[] = [];
    acquireEditLock('show-1', (s) => a.push(s), locks as unknown as LockManager);
    await tick();
    const tabB = acquireEditLock('show-1', (s) => b.push(s), locks as unknown as LockManager);
    await tick();
    tabB.steal();
    await tick(); await tick();
    expect(b.at(-1)).toBe('held');
    expect(a.at(-1)).toBe('elsewhere');
  });

  it('a released tab stops waiting: it never takes the lock later', async () => {
    const locks = fakeLocks();
    const b: LockState[] = [];
    const tabA = acquireEditLock('show-1', () => {}, locks as unknown as LockManager);
    await tick();
    const tabB = acquireEditLock('show-1', (s) => b.push(s), locks as unknown as LockManager);
    await tick();
    tabB.release();
    tabA.release();
    await tick(); await tick();
    expect(b).not.toContain('held');
    expect(locks.held(lockName('show-1'))).toBe(false);
  });

  it('no Web Locks → unsupported (edit as before, a documented limit)', () => {
    const states: LockState[] = [];
    acquireEditLock('show-1', (s) => states.push(s), null);
    expect(states).toEqual(['unsupported']);
  });
});
