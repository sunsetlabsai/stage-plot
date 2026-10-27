// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useShow } from '../lib/use-show';
import { readUnsynced, cacheKey, lastSavedKey } from '../lib/offline-sync';

// UAT S3/S4 in the save hook: the unsynced marker's lifetime, the flush on page
// hide, and the re-send on reconnect. Same harness rules as use-show-save-error
// (fake timers, advanceTimersByTimeAsync, a stubbed localStorage) — but a REAL
// map, because these assertions are about what the store holds.

let map: Map<string, string>;
const ls = () => ({
  getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
  setItem: (k: string, v: string) => void map.set(k, v),
  removeItem: (k: string) => void map.delete(k),
});

beforeEach(() => {
  vi.useFakeTimers();
  map = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: ls() });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
});

const ok = (updated_at = '2026-10-27T12:00:00Z') => ({ ok: true, json: async () => ({ updated_at }) });
const render = () => renderHook(() => useShow('show-1', 'my-show', true, false));
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe('the unsynced marker (S3)', () => {
  it('an edit is cached and marked at once; a successful save of it clears the mark', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok()));
    const { result } = render();
    act(() => result.current.saveConfig({ v: 1 }));
    expect(map.get(cacheKey('show-1'))).toBe('{"v":1}');
    expect(readUnsynced(localStorage, 'show-1')).not.toBeNull();
    await tick(2000);
    expect(readUnsynced(localStorage, 'show-1')).toBeNull();
    expect(map.get(lastSavedKey('show-1'))).toBe('2026-10-27T12:00:00Z');
  });

  it('a failed save leaves the mark — the browser copy is still the only copy', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const { result } = render();
    act(() => result.current.saveConfig({ v: 1 }));
    await tick(2000);
    expect(readUnsynced(localStorage, 'show-1')).not.toBeNull();
  });

  it('★ an older save succeeding does not clear the mark for a newer, unsaved edit', async () => {
    let resolve!: (v: unknown) => void;
    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise((r) => { resolve = r; })).mockResolvedValue(ok()));
    const { result } = render();
    act(() => result.current.saveConfig({ v: 1 }));
    await tick(2000); // save of v1 now in flight
    act(() => result.current.saveConfig({ v: 2 })); // newer edit, debounce pending
    await act(async () => { resolve(ok()); await Promise.resolve(); });
    expect(readUnsynced(localStorage, 'show-1')).not.toBeNull();
  });
});

describe('page hide flushes the waiting edit (S4)', () => {
  it('pagehide sends now, with keepalive, instead of waiting out the debounce', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal('fetch', fetchMock);
    const { result } = render();
    act(() => result.current.saveConfig({ v: 1 }));
    await act(async () => { window.dispatchEvent(new Event('pagehide')); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].keepalive).toBe(true);
    await tick(2000);
    expect(fetchMock).toHaveBeenCalledTimes(1); // the debounce does not send it twice
  });

  it('a body over the keepalive budget is sent without keepalive (the mark recovers it)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal('fetch', fetchMock);
    const { result } = render();
    act(() => result.current.saveConfig({ big: 'x'.repeat(70_000) }));
    await act(async () => { window.dispatchEvent(new Event('pagehide')); await Promise.resolve(); });
    expect(fetchMock.mock.calls[0][1].keepalive).toBe(false);
  });

  it('nothing waiting ⇒ page hide sends nothing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal('fetch', fetchMock);
    render();
    await act(async () => { window.dispatchEvent(new Event('pagehide')); await Promise.resolve(); });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('reconnecting is the page\'s job, not a blind push (S3)', () => {
  it('★ the hook sends nothing on "online" — another device may have saved meanwhile', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValue(ok());
    vi.stubGlobal('fetch', fetchMock);
    const { result } = render();
    act(() => result.current.saveConfig({ v: 1 }));
    await tick(2000); // fails offline, marked
    await act(async () => { window.dispatchEvent(new Event('online')); await vi.advanceTimersByTimeAsync(0); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readUnsynced(localStorage, 'show-1')).not.toBeNull();
  });

  it('resave sends the given show now, and clears the mark on success', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValue(ok());
    vi.stubGlobal('fetch', fetchMock);
    const { result } = render();
    act(() => result.current.saveConfig({ v: 1 }));
    await tick(2000);
    await act(async () => { result.current.resave({ v: 1 }); await vi.advanceTimersByTimeAsync(0); });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).config).toEqual({ v: 1 });
    expect(readUnsynced(localStorage, 'show-1')).toBeNull();
  });

  it('★ saving a copy identical to the cache does not mark it (the save every load makes)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    map.set(cacheKey('show-1'), '{"v":1}'); // what the offline fallback opened
    const { result } = render();
    act(() => result.current.saveConfig({ v: 1 }));
    await tick(2000);
    expect(readUnsynced(localStorage, 'show-1')).toBeNull();
  });
});
