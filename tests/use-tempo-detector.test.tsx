// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { renderHook, act, cleanup, waitFor } from '@testing-library/react';
import { useTempoDetector } from '../lib/use-tempo-detector';

// ── Conductor 5b chunk 4a: the detector IO shell (jsdom) ─────────────────────
// jsdom has no Web Audio / getUserMedia, so we stub the boundary and assert the
// LIFECYCLE the shell owns: gesture acquire → running, permission denial → 'denied',
// generic failure → 'error', and disable() releasing the mic tracks. The DSP itself is
// the pure core (tempo-detect.test.ts) — this file only covers acquisition/teardown.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as unknown as { AudioContext?: unknown }).AudioContext;
});

class FakeAudioContext {
  currentTime = 0;
  state: AudioContextState = 'running';
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {
    this.state = 'closed';
  });
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
  createAnalyser = vi.fn(() => ({
    fftSize: 0,
    frequencyBinCount: 1024,
    getFloatFrequencyData: vi.fn(),
  }));
}

function installAudioContext(): void {
  (window as unknown as { AudioContext: unknown }).AudioContext =
    FakeAudioContext as unknown as typeof AudioContext;
}

function mockGetUserMedia(impl: () => Promise<MediaStream>): { stop: ReturnType<typeof vi.fn> } {
  const stop = vi.fn();
  const getUserMedia = vi.fn(impl);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  });
  return { stop };
}

describe('useTempoDetector lifecycle', () => {
  it('acquires on enable() and reaches running, then releases the mic on disable()', async () => {
    installAudioContext();
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
    mockGetUserMedia(async () => stream);

    const onTelemetry = vi.fn();
    const { result } = renderHook(() => useTempoDetector({ prefer: 120, onTelemetry }));
    expect(result.current.status).toBe('off');

    await act(async () => {
      await result.current.enable();
    });
    expect(result.current.status).toBe('running');

    act(() => result.current.disable());
    expect(result.current.status).toBe('off');
    expect(stop).toHaveBeenCalled(); // mic track released (OS indicator off)
    expect(onTelemetry).not.toHaveBeenCalled(); // no real audio ⇒ no estimate
  });

  it('maps a permission denial to status "denied"', async () => {
    installAudioContext();
    mockGetUserMedia(async () => {
      const e = new Error('denied');
      e.name = 'NotAllowedError';
      throw e;
    });
    const { result } = renderHook(() => useTempoDetector({ prefer: null, onTelemetry: vi.fn() }));
    await act(async () => {
      await result.current.enable();
    });
    await waitFor(() => expect(result.current.status).toBe('denied'));
    expect(result.current.lastError).toBeTruthy();
  });

  it('maps a generic acquisition failure to status "error"', async () => {
    installAudioContext();
    mockGetUserMedia(async () => {
      throw new Error('no device');
    });
    const { result } = renderHook(() => useTempoDetector({ prefer: null, onTelemetry: vi.fn() }));
    await act(async () => {
      await result.current.enable();
    });
    await waitFor(() => expect(result.current.status).toBe('error'));
  });

  // ── Codex 4a-review HIGH: the async-acquire concurrency leak ────────────────────────────
  // A deferred getUserMedia lets us exercise the window BETWEEN enable() and the mic resolving.
  function deferredGetUserMedia(): {
    resolve: (s: MediaStream) => void;
    getUserMedia: ReturnType<typeof vi.fn>;
  } {
    let resolve!: (s: MediaStream) => void;
    const pending = new Promise<MediaStream>((r) => {
      resolve = r;
    });
    const getUserMedia = vi.fn(() => pending);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    return { resolve, getUserMedia };
  }
  const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

  it('ignores a re-entrant enable() during the async acquire (one stream/context/interval)', async () => {
    installAudioContext();
    const { resolve, getUserMedia } = deferredGetUserMedia();
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;

    const { result } = renderHook(() => useTempoDetector({ prefer: 120, onTelemetry: vi.fn() }));
    await act(async () => {
      void result.current.enable();
      void result.current.enable(); // the second click, before the mic resolves
    });
    expect(getUserMedia).toHaveBeenCalledTimes(1); // second enable blocked by the acquiring guard

    await act(async () => {
      resolve(stream);
      await flushMicrotasks();
    });
    expect(result.current.status).toBe('running');

    act(() => result.current.disable());
    expect(stop).toHaveBeenCalledTimes(1); // exactly one graph installed ⇒ released once
  });

  it('tears down its own graph when disable() lands mid-acquire (no leaked mic)', async () => {
    installAudioContext();
    const { resolve } = deferredGetUserMedia();
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;

    const { result } = renderHook(() => useTempoDetector({ prefer: null, onTelemetry: vi.fn() }));
    await act(async () => {
      void result.current.enable();
    });
    act(() => result.current.disable()); // supersede the in-flight acquire before it resolves

    await act(async () => {
      resolve(stream);
      await flushMicrotasks();
    });
    expect(result.current.status).toBe('off'); // never flipped to running
    expect(stop).toHaveBeenCalledTimes(1); // the just-built stream torn down (mic released)
  });
});
