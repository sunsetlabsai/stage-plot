// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useShow } from '../lib/use-show';

// design-core-path-tier1 §4 tests 1 and 2 — chunk 1, §1.1.
//
// The defect: `doSave`'s catch swallowed network errors without calling
// setSaveError, so `lastSavedAt` kept its previous value and the status pill
// kept rendering a green "Saved" through an entire offline session. The app
// reported success for something that did not happen.
//
// NOTE ON THE HARNESS: this repo's jsdom `localStorage` is a bare `{}` (setItem
// undefined) — the documented gap that left BYOA untested before #133. The
// SUCCESS path calls localStorage.setItem outside a try, so it is stubbed here
// rather than left to explode and disguise itself as the failure being tested.

const SAVE_DEBOUNCE_MS = 2000;

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
});

/** Owner on a real show — the only combination that saves at all. */
function renderUseShow() {
  return renderHook(() => useShow('show-1', 'my-show', true, false, false));
}

/**
 * Drive the 2s debounce so the pending save actually fires, THEN flush the
 * promise chain inside `doSave`.
 *
 * `advanceTimersByTimeAsync` rather than the sync form, and no `waitFor`:
 * RTL's waitFor polls on REAL timers, so under `vi.useFakeTimers()` it never
 * ticks and every assertion hangs to the 5s timeout instead of failing.
 */
async function flushDebounce() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
  });
}

describe('test 1 — a network failure is surfaced, not swallowed', () => {
  it('sets saveError when the fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const { result } = renderUseShow();
    act(() => result.current.saveConfig({ stagePlot: [] }));
    await flushDebounce();

    expect(result.current.context.saveError).toBeTruthy();
    // The message must name the actual state. The pill prefixes "Couldn't save — ",
    // so this carries the CAUSE only; asserting on content rather than an exact
    // string keeps the copy editable without a false failure.
    expect(result.current.context.saveError).toMatch(/offline/i);
    expect(result.current.context.saveError).toMatch(/cached/i);
  });

  it('★ leaves lastSavedAt untouched, so the pill cannot still read "Saved"', async () => {
    // The distinguishing assertion. `saveError` alone does not prove the bug is
    // fixed: the pill renders green "Saved" whenever lastSavedAt is set and
    // saveError is null, so what matters is that a FAILED save never advances
    // the timestamp. An implementation that set both would look fixed here and
    // still lie in the UI.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const { result } = renderUseShow();
    act(() => result.current.saveConfig({ stagePlot: [] }));
    await flushDebounce();

    expect(result.current.context.saveError).toBeTruthy();
    expect(result.current.context.lastSavedAt).toBeNull();
    expect(result.current.context.saving).toBe(false);
  });
});

describe('test 2 — a later success clears the error', () => {
  it('clears saveError and records the server timestamp', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ updated_at: '2026-08-19T12:00:00Z' }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderUseShow();

    act(() => result.current.saveConfig({ stagePlot: [] }));
    await flushDebounce();
    expect(result.current.context.saveError).toBeTruthy();

    // Back online: the next edit retries. Explicitly NOT an auto-retry loop —
    // the recovery path is the user's next change, which is what the copy promises.
    act(() => result.current.saveConfig({ stagePlot: [{ name: 'Drums' }] }));
    await flushDebounce();

    expect(result.current.context.saveError).toBeNull();
    expect(result.current.context.lastSavedAt).toBe('2026-08-19T12:00:00Z');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('an HTTP rejection still surfaces its server-supplied reason', async () => {
    // Guards the pre-existing non-ok branch against regression while the catch
    // beside it changes.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: 'Song at position 3 could not be resolved' }),
      }),
    );

    const { result } = renderUseShow();
    act(() => result.current.saveConfig({ stagePlot: [] }));
    await flushDebounce();

    expect(result.current.context.saveError).toMatch(/position 3/);
    expect(result.current.context.lastSavedAt).toBeNull();
  });
});
