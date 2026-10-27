// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useShow, type ServerShow } from '../lib/use-show';
import { readEntry, writeEntry, entryKey, legacyKey } from '../lib/show-store';
import { fakeLocks } from './fake-locks';

// docs/design-version-checked-save.md §8 "Hook", "Reload while held", "Tabs",
// and the Codex R4/R5 scenarios on #201.

const V0 = '2026-10-27T10:00:00.000001+00:00';
const V1 = '2026-10-27T10:00:05.000002+00:00';
const V2 = '2026-10-27T10:00:09.000003+00:00';

function memStore() {
  const m = new Map<string, string>();
  const store = {
    m,
    failWrites: false,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: vi.fn((k: string, v: string) => {
      if (store.failWrites) throw new DOMException('QuotaExceededError');
      m.set(k, v);
    }),
    removeItem: vi.fn((k: string) => { m.delete(k); }),
  };
  return store;
}

/** fetch whose responses the test releases one at a time. */
function controlledFetch() {
  const calls: Array<{ body: Record<string, unknown>; respond: (status: number, json: unknown) => void; fail: () => void }> = [];
  const fn = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    calls.push({
      body: JSON.parse(init.body as string),
      respond: (status, json) => resolve({ ok: status >= 200 && status < 300, status, json: async () => json } as Response),
      fail: () => reject(new TypeError('Failed to fetch')),
    });
  }));
  vi.stubGlobal('fetch', fn);
  return calls;
}

const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const debounce = () => act(async () => { await vi.advanceTimersByTimeAsync(2000); });

function setup(opts: {
  store?: ReturnType<typeof memStore>;
  loaded?: ServerShow | null;
  fetchServer?: () => Promise<ServerShow | null>;
} = {}) {
  const store = opts.store ?? memStore();
  const applyConfig = vi.fn();
  const fetchServer = vi.fn(opts.fetchServer ?? (async () => null));
  const loaded = opts.loaded === undefined ? { config: { n: 0 }, updatedAt: V0 } : opts.loaded;
  const hook = renderHook(() => useShow('show-1', 'my-show', true, true, { loaded, applyConfig, fetchServer, storage: store }));
  return { hook, store, applyConfig, fetchServer };
}

const entry = (store: ReturnType<typeof memStore>) => readEntry(store, 'show-1');

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (navigator as unknown as { locks?: unknown }).locks;
});

describe('§4.4 only real changes are sent', () => {
  it('the save every load makes (unchanged content) is never marked, cached or sent', async () => {
    const calls = controlledFetch();
    const { hook, store } = setup();
    await flush();
    act(() => hook.result.current.saveConfig({ n: 0 }));
    await debounce();
    expect(calls).toHaveLength(0);
    expect(entry(store)).toEqual({ config: { n: 0 }, base: V0, unsynced: false });
  });
});

describe('§4.2 one save in flight; the next goes with the NEW base', () => {
  it('a second edit waits for the first, then carries the base the first returned', async () => {
    const calls = controlledFetch();
    const { hook } = setup();
    await flush();
    act(() => hook.result.current.saveConfig({ n: 1 }));
    await debounce();
    expect(calls).toHaveLength(1);
    expect(calls[0].body.base_updated_at).toBe(V0);

    act(() => hook.result.current.saveConfig({ n: 2 }));
    await debounce();
    expect(calls).toHaveLength(1); // still in flight: nothing out of order

    calls[0].respond(200, { updated_at: V1 });
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1].body.config).toEqual({ n: 2 });
    expect(calls[1].body.base_updated_at).toBe(V1);
  });
});

describe('§4.2a step 4 — adopting a base never drops a newer pending edit (Codex R4)', () => {
  it('A in flight, B made, A succeeds: the entry holds {B, A\'s base}, still unsynced', async () => {
    const calls = controlledFetch();
    const { hook, store } = setup();
    await flush();
    act(() => hook.result.current.saveConfig({ n: 1 })); // A
    await debounce();
    act(() => hook.result.current.saveConfig({ n: 2 })); // B, cached at once
    calls[0].respond(200, { updated_at: V1 });
    await flush();
    // A reload now (B's request cut off) would send B — not lose it.
    expect(entry(store)).toEqual({ config: { n: 2 }, base: V1, unsynced: true });
  });

  it('…and if that rewrite throws, the entry still holds B (older base: a reload 409s and asks)', async () => {
    const calls = controlledFetch();
    const { hook, store } = setup();
    await flush();
    act(() => hook.result.current.saveConfig({ n: 1 }));
    await debounce();
    act(() => hook.result.current.saveConfig({ n: 2 }));
    store.failWrites = true;
    calls[0].respond(200, { updated_at: V1 });
    await flush();
    expect(entry(store)).toEqual({ config: { n: 2 }, base: V0, unsynced: true });
    expect(store.removeItem).not.toHaveBeenCalledWith(entryKey('show-1')); // never delete an unconfirmed edit
    expect(hook.result.current.context.persistWarning).toBe(true);
  });

  it('nothing pending and the rewrite throws: the entry is deleted, never stale-beside-fresh', async () => {
    const calls = controlledFetch();
    const { hook, store } = setup();
    await flush();
    act(() => hook.result.current.saveConfig({ n: 1 }));
    await debounce();
    store.failWrites = true;
    calls[0].respond(200, { updated_at: V1 });
    await flush();
    expect(store.m.has(entryKey('show-1'))).toBe(false);
  });
});

describe('§4.3 a 409', () => {
  it('server has the same content → adopt its base silently, no prompt', async () => {
    const calls = controlledFetch();
    const { hook, store } = setup({ fetchServer: async () => ({ config: { n: 1, charts: [] }, updatedAt: V2 }) });
    await flush();
    act(() => hook.result.current.saveConfig({ n: 1 }));
    await debounce();
    calls[0].respond(409, { conflict: true });
    await flush();
    expect(hook.result.current.context.conflict).toBeNull();
    expect(entry(store)).toMatchObject({ base: V2, unsynced: false });
  });

  it('different content → the owner chooses; saves held; edits while held cached, not sent', async () => {
    const calls = controlledFetch();
    const server = { config: { n: 9 }, updatedAt: V2 };
    const { hook, store } = setup({ fetchServer: async () => server });
    await flush();
    act(() => hook.result.current.saveConfig({ n: 1 }));
    await debounce();
    calls[0].respond(409, { conflict: true });
    await flush();
    expect(hook.result.current.context.conflict?.server).toEqual(server);
    expect(entry(store)).toMatchObject({ config: { n: 1 }, unsynced: true });

    act(() => hook.result.current.saveConfig({ n: 2 }));
    await debounce();
    expect(calls).toHaveLength(1);
    expect(entry(store)).toMatchObject({ config: { n: 2 }, unsynced: true });

    // Keep mine: the LATEST copy, over the server's CURRENT version.
    act(() => hook.result.current.keepMine());
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1].body.config).toEqual({ n: 2 });
    expect(calls[1].body.base_updated_at).toBe(V2);
  });

  it('Use the saved one → shows the server copy, adopts its base, clears the flag', async () => {
    const calls = controlledFetch();
    const server = { config: { n: 9 }, updatedAt: V2 };
    const { hook, store, applyConfig } = setup({ fetchServer: async () => server });
    await flush();
    act(() => hook.result.current.saveConfig({ n: 1 }));
    await debounce();
    calls[0].respond(409, { conflict: true });
    await flush();
    act(() => hook.result.current.useSaved());
    expect(applyConfig).toHaveBeenCalledWith({ n: 9 });
    expect(entry(store)).toEqual({ config: { n: 9 }, base: V2, unsynced: false });
    expect(hook.result.current.context.conflict).toBeNull();
    // The page re-renders the server copy and saves: unchanged, so not sent.
    act(() => hook.result.current.saveConfig({ n: 9 }));
    await debounce();
    expect(calls).toHaveLength(1);
  });

  it('409 with the server unreachable: nothing dropped; the next trigger re-sends and asks again', async () => {
    const calls = controlledFetch();
    const { hook, store, fetchServer } = setup();
    await flush();
    act(() => hook.result.current.saveConfig({ n: 1 }));
    await debounce();
    calls[0].respond(409, { conflict: true });
    await flush();
    expect(entry(store)).toMatchObject({ config: { n: 1 }, unsynced: true });
    act(() => { window.dispatchEvent(new Event('online')); });
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1].body.base_updated_at).toBe(V0);
    calls[1].respond(409, { conflict: true });
    await flush();
    expect(fetchServer).toHaveBeenCalledTimes(2);
  });
});

describe('§4.5 offline, reconnect, reload', () => {
  it('an offline failure keeps the copy and re-sends on `online` — not in a loop', async () => {
    const calls = controlledFetch();
    const { hook, store } = setup();
    await flush();
    act(() => hook.result.current.saveConfig({ n: 1 }));
    await debounce();
    calls[0].fail();
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(calls).toHaveLength(1); // no retry loop
    expect(entry(store)).toMatchObject({ config: { n: 1 }, unsynced: true });
    act(() => { window.dispatchEvent(new Event('online')); });
    await flush();
    expect(calls).toHaveLength(2);
  });

  it('reload with an unsynced copy: shows it and sends it with ITS base (a 409 then asks again)', async () => {
    const calls = controlledFetch();
    const store = memStore();
    writeEntry(store, 'show-1', { config: { n: 5 }, base: V0, unsynced: true });
    const { applyConfig } = setup({ store, loaded: { config: { n: 9 }, updatedAt: V2 } });
    await flush();
    expect(applyConfig).toHaveBeenCalledWith({ n: 5 });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.base_updated_at).toBe(V0);
  });
});

describe('Codex R1 on #202 — nothing is editable before the lock, nothing lost on upgrade', () => {
  it('an owner tab is read-only while the lock grant is pending', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: fakeLocks() });
    controlledFetch();
    const { hook } = setup();
    // Before the (asynchronous) grant: no edit surface, so no edit to drop.
    expect(hook.result.current.context.isReadOnly).toBe(true);
    await flush();
    expect(hook.result.current.context.lockState).toBe('held');
    expect(hook.result.current.context.isReadOnly).toBe(false);
  });

  function legacy(store: ReturnType<typeof memStore>, config: unknown, lastSaved?: string) {
    store.m.set(legacyKey('show-1'), JSON.stringify(config));
    if (lastSaved) store.m.set('showrunr-last-saved-show-1', lastSaved);
  }

  it('old-bundle cache with an unsent edit on top of the CURRENT version → shown, re-homed, sent at that version', async () => {
    const calls = controlledFetch();
    const store = memStore();
    legacy(store, { n: 5 }, V0);
    const { applyConfig } = setup({ store, loaded: { config: { n: 0 }, updatedAt: V0 } });
    await flush();
    expect(applyConfig).toHaveBeenCalledWith({ n: 5 });
    expect(entry(store)).toMatchObject({ config: { n: 5 }, base: V0, unsynced: true });
    expect(store.m.has(legacyKey('show-1'))).toBe(false);
    expect(calls[0].body).toMatchObject({ config: { n: 5 }, base_updated_at: V0 });
  });

  it('old-bundle cache that differs with no usable version → the owner is asked, never dropped', async () => {
    controlledFetch();
    const store = memStore();
    legacy(store, { n: 5 }); // no last-saved
    const server = { config: { n: 0 }, updatedAt: V2 };
    const { hook } = setup({ store, loaded: server, fetchServer: async () => server });
    await flush();
    expect(hook.result.current.context.conflict?.server).toEqual(server);
    expect(entry(store)).toMatchObject({ config: { n: 5 }, unsynced: true });
  });

  it('old-bundle cache equal to the server → clean, nothing sent, re-homed', async () => {
    const calls = controlledFetch();
    const store = memStore();
    legacy(store, { n: 0 }, V0);
    setup({ store, loaded: { config: { n: 0 }, updatedAt: V2 } });
    await flush();
    expect(calls).toHaveLength(0);
    expect(entry(store)).toEqual({ config: { n: 0 }, base: V2, unsynced: false });
  });
});

describe('taking the lock picks the newer copy', () => {
  it('a clean entry at a LATER version than this tab\'s load is shown and used as the base', async () => {
    const calls = controlledFetch();
    const store = memStore();
    writeEntry(store, 'show-1', { config: { n: 7 }, base: V2, unsynced: false });
    const { hook, applyConfig } = setup({ store, loaded: { config: { n: 0 }, updatedAt: V0 } });
    await flush();
    expect(applyConfig).toHaveBeenCalledWith({ n: 7 });
    act(() => hook.result.current.saveConfig({ n: 8 }));
    await debounce();
    expect(calls[0].body.base_updated_at).toBe(V2);
  });

  it('an OLDER clean entry loses to the fresh load', async () => {
    const calls = controlledFetch();
    const store = memStore();
    writeEntry(store, 'show-1', { config: { n: 7 }, base: V0, unsynced: false });
    const { hook, applyConfig } = setup({ store, loaded: { config: { n: 0 }, updatedAt: V2 } });
    await flush();
    expect(applyConfig).not.toHaveBeenCalled();
    act(() => hook.result.current.saveConfig({ n: 8 }));
    await debounce();
    expect(calls[0].body.base_updated_at).toBe(V2);
  });
});

describe('§4.0 one editing tab per show — the Codex R5 scenario', () => {
  function twoTabs() {
    const locks = fakeLocks();
    Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
    const store = memStore();
    const calls = controlledFetch();
    const opts = { loaded: { config: { n: 0 }, updatedAt: V0 }, applyConfig: vi.fn(), fetchServer: vi.fn(async () => null), storage: store };
    const a = renderHook(() => useShow('show-1', 'my-show', true, true, opts));
    return { locks, store, calls, opts, a };
  }

  it('a second owner tab is read-only and writes NOTHING (edit, cache, send)', async () => {
    const { store, calls, opts, a } = twoTabs();
    await flush();
    const b = renderHook(() => useShow('show-1', 'my-show', true, true, opts));
    await flush();
    expect(a.result.current.context.lockState).toBe('held');
    expect(b.result.current.context.lockState).toBe('elsewhere');
    expect(b.result.current.context.isReadOnly).toBe(true);

    act(() => a.result.current.saveConfig({ n: 1 })); // A's unsynced edit
    store.setItem.mockClear();
    act(() => b.result.current.saveConfig({ n: 99 }));
    await debounce();
    expect(store.setItem).not.toHaveBeenCalled();
    expect(calls.every((c) => (c.body.config as { n: number }).n !== 99)).toBe(true);
    expect(entry(store)).toMatchObject({ config: { n: 1 }, unsynced: true });
  });

  it('the holder closing hands over: the waiting tab sends the unsynced copy it finds', async () => {
    const { store, calls, opts, a } = twoTabs();
    await flush();
    const b = renderHook(() => useShow('show-1', 'my-show', true, true, opts));
    await flush();
    act(() => a.result.current.saveConfig({ n: 1 }));
    // A closes before its debounce fires; its unmount sends (keepalive) and lets go.
    a.unmount();
    await flush(); await flush();
    expect(b.result.current.context.lockState).toBe('held');
    expect(entry(store)).toMatchObject({ config: { n: 1 }, unsynced: true });
    const fromB = calls.filter((c) => (c.body.config as { n: number }).n === 1);
    expect(fromB.length).toBeGreaterThanOrEqual(1);
  });

  it('Edit here: the old tab drops to view-only, and its in-flight response writes nothing', async () => {
    const { store, calls, opts, a } = twoTabs();
    await flush();
    act(() => a.result.current.saveConfig({ n: 1 }));
    await debounce(); // A's save in flight
    const b = renderHook(() => useShow('show-1', 'my-show', true, true, opts));
    await flush();
    act(() => b.result.current.editHere());
    await flush(); await flush();
    expect(b.result.current.context.lockState).toBe('held');
    expect(a.result.current.context.lockState).toBe('elsewhere');

    const before = store.m.get(entryKey('show-1'));
    calls[0].respond(200, { updated_at: V1 });
    await flush();
    // A no longer holds the lock: its late success must not touch storage.
    expect(store.m.get(entryKey('show-1'))).toBe(before);
    expect(a.result.current.context.lastSavedAt).toBeNull();
  });
});
