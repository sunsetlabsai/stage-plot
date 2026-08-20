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
// undefined) — the documented gap that left BYOA untested before #133. It is
// stubbed below so a harness explosion cannot disguise itself as the failure
// under test.
//
// ★ That stub is also how the R1 medium hid. The first version of this file
// noted "the SUCCESS path calls localStorage.setItem outside a try" and worked
// AROUND it here — treating a production hazard as a test-harness inconvenience.
// Codex found the defect I had already written down and routed past. The
// `test 2b` block below is the coverage that observation should have produced.

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

describe('test 2b — a save that PERSISTED must never report failure (Codex R1 medium)', () => {
  it('★ a localStorage quota error does not turn a successful save into "offline"', async () => {
    // The distinguishing case. The server accepted the write; only the
    // best-effort conflict-detection cache failed. Reporting "you appear to be
    // offline" here is §1.1's own defect inverted — claiming a failure that did
    // not happen — and it is exactly what a try around the whole success branch
    // produced. Real trigger: Safari private mode, or a full quota.
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => null,
        removeItem: () => {},
        setItem: () => { throw new DOMException('QuotaExceededError'); },
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ updated_at: '2026-08-20T12:00:00Z' }),
      }),
    );

    const { result } = renderUseShow();
    act(() => result.current.saveConfig({ stagePlot: [] }));
    await flushDebounce();

    expect(result.current.context.saveError).toBeNull();
    expect(result.current.context.lastSavedAt).toBe('2026-08-20T12:00:00Z');
    expect(result.current.context.saving).toBe(false);
  });

  it('★ still WRITES the conflict-detection cache — guarding it is not dropping it', async () => {
    // Mutation testing caught the gap: deleting the cache write entirely also
    // passes the quota test above, because "no error" is true when nothing was
    // attempted. Wrapping a call in try/catch must not become an invitation to
    // delete it — offline conflict detection depends on this timestamp.
    const setItem = vi.fn();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: () => null, removeItem: () => {}, setItem },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ updated_at: '2026-08-20T12:00:00Z' }),
      }),
    );

    const { result } = renderUseShow();
    act(() => result.current.saveConfig({ stagePlot: [] }));
    await flushDebounce();

    expect(setItem).toHaveBeenCalledWith('showrunr-last-saved-show-1', '2026-08-20T12:00:00Z');
    expect(result.current.context.saveError).toBeNull();
  });

  it('a malformed 200 body reports a generic error, and never claims offline', async () => {
    // Same class, second instance — found by sweeping the shape rather than
    // folding the one call site Codex named. "Offline" is one specific cause and
    // belongs only to a fetch that actually threw.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => { throw new SyntaxError('Unexpected token <'); },
      }),
    );

    const { result } = renderUseShow();
    act(() => result.current.saveConfig({ stagePlot: [] }));
    await flushDebounce();

    expect(result.current.context.saveError).toBeTruthy();
    expect(result.current.context.saveError).not.toMatch(/offline/i);
  });
});
