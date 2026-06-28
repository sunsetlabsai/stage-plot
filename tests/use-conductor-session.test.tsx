// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import { useConductorSession } from '../lib/use-conductor-session';
import type { ChartCalibration, RoadmapMarker } from '../lib/types';

// ── Conductor authority, chunk 4: the React binding (jsdom) ──────────────────
// The hook is a THIN wrapper over the frozen pure libs — so these tests assert the
// BINDING contract (active-gating on the async programHash, driver state, and that
// every action routes through the pure controller), NOT the pure logic itself
// (conductor-targets.test.ts / conductor-session.test.ts own that). The session is
// minted in an async resolve callback (programHash is async), so activation is
// always awaited via waitFor.

afterEach(cleanup);

// A LOCAL ChartCalibration mirroring tests/conductor-targets.test.ts: one system,
// bars left→right, with a REAL repeat (volta group) so availableRedirects has
// something to surface and armableTargets carries a repeat landmark + plain bars.
function makeCal(bars: { id: string; sectionId?: string | null }[], roadmap: RoadmapMarker[] = []): ChartCalibration {
  const systemId = 'sys1';
  return {
    schemaVersion: 3,
    status: 'verified',
    sections: [],
    systems: [{ id: systemId, page: 1, yTop: 0, yBottom: 0.2, xStart: 0, xEnd: 1 }],
    bars: bars.map((b, i) => ({
      id: b.id,
      systemId,
      xStart: i / bars.length,
      xEnd: (i + 1) / bars.length,
      absNumber: i + 1,
      sectionId: b.sectionId ?? null,
    })),
    roadmap,
  };
}

const rstart = (id: string, barId: string): RoadmapMarker => ({ id, kind: 'repeatStart', barId, edge: 'start' });
const ending = (id: string, repeatStartId: string, barIds: string[], numbers: number[]): RoadmapMarker =>
  ({ id, kind: 'ending', repeatStartId, barIds, numbers });

const cal = makeCal(
  [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }, { id: 'b4' }],
  [rstart('R', 'b1'), ending('E1', 'R', ['b3'], [1]), ending('E2', 'R', ['b4'], [2])],
);

const args = (over: Partial<Parameters<typeof useConductorSession>[0]> = {}) => ({
  enabled: true,
  sessionId: 'chart1::owner/show',
  songRef: 'chart1',
  cal,
  ...over,
});

describe('useConductorSession', () => {
  it('stays inactive when disabled (no session, empty enumerators)', async () => {
    const { result } = renderHook((p: Parameters<typeof useConductorSession>[0]) => useConductorSession(p), {
      initialProps: args({ enabled: false }),
    });
    // The disabled branch defers its reset to a microtask; give it a tick.
    await act(async () => {});
    expect(result.current.active).toBe(false);
    expect(result.current.state).toBeNull();
    expect(result.current.current).toBeNull();
    expect(result.current.redirects).toEqual([]);
  });

  it('activates once the async programHash resolves, with the VM at the song head', async () => {
    const { result } = renderHook(() => useConductorSession(args()));
    await waitFor(() => expect(result.current.active).toBe(true));
    expect(result.current.state).not.toBeNull();
    expect(result.current.current).toBeNull(); // nothing emitted until the first advance
    expect(result.current.done).toBe(false);
    // pure enumerators surfaced: a real repeat ⇒ targets + redirects are non-empty
    expect(result.current.targets.length).toBeGreaterThan(0);
    expect(result.current.redirects.map((o) => o.label)).toContain('Another round');
  });

  it('advance emits the next TraversalStep as the live driver (state.current)', async () => {
    const { result } = renderHook(() => useConductorSession(args()));
    await waitFor(() => expect(result.current.active).toBe(true));
    act(() => result.current.advance());
    expect(result.current.current?.barId).toBe('b1'); // first emitted bar
    expect(result.current.outcome).toBe('applied');
  });

  it('arm ALWAYS routes through resolveArm — the component never hand-builds a directive', async () => {
    const { result } = renderHook(() => useConductorSession(args()));
    await waitFor(() => expect(result.current.active).toBe(true));
    const t = result.current.targets[0];
    act(() => result.current.arm(t));
    // armed reflects the resolveArm output: a jumpTo at the chosen target, fired at
    // the real next emitted bar (the hook supplies fireAt, the component cannot).
    expect(result.current.armed).not.toBeNull();
    expect(result.current.armed?.directive).toMatchObject({ kind: 'jumpTo', barId: t.barId });
    expect(result.current.armed?.fireAt).toBe('b1');
  });

  it('disarm clears the pending change', async () => {
    const { result } = renderHook(() => useConductorSession(args()));
    await waitFor(() => expect(result.current.active).toBe(true));
    act(() => result.current.arm(result.current.targets[0]));
    expect(result.current.armed).not.toBeNull();
    act(() => result.current.disarm());
    expect(result.current.armed).toBeNull();
  });

  it('commit fires the armed change and clears it', async () => {
    const { result } = renderHook(() => useConductorSession(args()));
    await waitFor(() => expect(result.current.active).toBe(true));
    act(() => result.current.arm(result.current.targets[0]));
    act(() => result.current.commit());
    expect(result.current.armed).toBeNull();
    expect(result.current.current).not.toBeNull(); // commit steps once to a real bar
    expect(result.current.outcome).toBe('applied');
  });

  it('redirect dispatches the option directive through the pure controller', async () => {
    const { result } = renderHook(() => useConductorSession(args()));
    await waitFor(() => expect(result.current.active).toBe(true));
    const opt = result.current.redirects.find((o) => o.label === 'Another round')!;
    act(() => result.current.redirect(opt));
    expect(result.current.outcome).toBe('applied');
  });
});
