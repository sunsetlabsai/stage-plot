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
});
