// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import { useConductorSession, type RelaySocket } from '../lib/use-conductor-session';
import { barMs } from '../lib/tempo';
import { programHash as computeProgramHash } from '../lib/conductor-state';
import { initSession, dispatch, type ConductorSession } from '../lib/conductor-session';
import { compileRoadmap } from '../lib/roadmap-vm';
import { barsInOrder } from '../lib/chart-calibration';
import type { ChartCalibration, RoadmapMarker, SectionAnchor } from '../lib/types';

// ── Conductor authority, chunk 4: the React binding (jsdom) ──────────────────
// The hook is a THIN wrapper over the frozen pure libs — so these tests assert the
// BINDING contract (active-gating on the async programHash, driver state, and that
// every action routes through the pure controller), NOT the pure logic itself
// (conductor-targets.test.ts / conductor-session.test.ts own that). The session is
// minted in an async resolve callback (programHash is async), so activation is
// always awaited via waitFor.

afterEach(cleanup);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// A LOCAL ChartCalibration mirroring tests/conductor-targets.test.ts: one system,
// bars left→right, with a REAL repeat (volta group) so availableRedirects has
// something to surface and armableTargets carries a repeat landmark + plain bars.
function makeCal(
  bars: { id: string; sectionId?: string | null }[],
  roadmap: RoadmapMarker[] = [],
  sections: SectionAnchor[] = [],
): ChartCalibration {
  const systemId = 'sys1';
  return {
    schemaVersion: 3,
    status: 'verified',
    sections,
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

const sec = (id: string, label: string): SectionAnchor => ({ id, page: 1, x: 0, y: 0, label });

const rstart = (id: string, barId: string): RoadmapMarker => ({ id, kind: 'repeatStart', barId, edge: 'start' });
const ending = (id: string, repeatStartId: string, barIds: string[], numbers: number[]): RoadmapMarker =>
  ({ id, kind: 'ending', repeatStartId, barIds, numbers });
const fine = (id: string, barId: string): RoadmapMarker => ({ id, kind: 'fine', barId, edge: 'end' });

// A sectioned linear chart for the boundary-snap + insert-return arm-seam tests:
// Intro b1,b2 / Verse b3,b4 / Chorus b5,b6, with a Fine so alFine is an exit option.
const secCal = makeCal(
  [
    { id: 'b1', sectionId: 'sI' },
    { id: 'b2', sectionId: 'sI' },
    { id: 'b3', sectionId: 'sV' },
    { id: 'b4', sectionId: 'sV' },
    { id: 'b5', sectionId: 'sC' },
    { id: 'b6', sectionId: 'sC' },
  ],
  [fine('F', 'b6')],
  [sec('sI', 'Intro'), sec('sV', 'Verse'), sec('sC', 'Chorus')],
);

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

  // 5b chunk 4a: the shadow detector surface is purely additive — it exposes an OFF
  // detector and an empty comparison by default, and does NOT touch the motion rung
  // (4a drives nothing; the rung stays computeStaticRung: 'manual' with no bpm/clock).
  it('exposes an inert shadow detector surface that does not affect the rung', async () => {
    const { result } = renderHook(() => useConductorSession(args({ bpm: 120 })));
    await waitFor(() => expect(result.current.active).toBe(true));
    expect(result.current.micStatus).toBe('off');
    expect(result.current.shadow).toBeNull();
    expect(result.current.validationLog).toEqual([]);
    // clock off ⇒ manual; the detector being present changes nothing.
    expect(result.current.rung).toBe('manual');
    act(() => result.current.setClockOn(true));
    expect(result.current.rung).toBe('static-bpm'); // unchanged by the shadow channel
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

  // ── chunk 5: auto-fire opt-in + synchronous advance→commit chain (§3) ────────
  it('auto-fire is OFF by default; setAutoFire flips the toggle', async () => {
    const { result } = renderHook(() => useConductorSession(args()));
    await waitFor(() => expect(result.current.active).toBe(true));
    expect(result.current.autoFireOn).toBe(false);
    act(() => result.current.setAutoFire(true));
    expect(result.current.autoFireOn).toBe(true);
  });

  it('auto-fire OFF: advancing onto the fire bar leaves armed set (chunk-4 parity)', async () => {
    const { result } = renderHook(() => useConductorSession(args()));
    await waitFor(() => expect(result.current.active).toBe(true));
    act(() => result.current.arm(result.current.targets[0])); // fireAt = b1 (next emit)
    expect(result.current.armed?.fireAt).toBe('b1');
    act(() => result.current.advance()); // lands on b1 === fireAt
    expect(result.current.current?.barId).toBe('b1');
    expect(result.current.armed).not.toBeNull(); // not auto-committed (toggle OFF)
  });

  it('auto-fire ON: advancing onto the fire bar auto-commits in the same act', async () => {
    const { result } = renderHook(() => useConductorSession(args()));
    await waitFor(() => expect(result.current.active).toBe(true));
    act(() => result.current.setAutoFire(true));
    act(() => result.current.arm(result.current.targets[0])); // fireAt = b1
    act(() => result.current.advance()); // lands on b1 === fireAt → auto-fire
    expect(result.current.armed).toBeNull(); // committed → armed cleared
    expect(result.current.outcome).toBe('applied');
  });

  it('toggle OFF mid-arm reverts to needing a go-tap', async () => {
    const { result } = renderHook(() => useConductorSession(args()));
    await waitFor(() => expect(result.current.active).toBe(true));
    act(() => result.current.setAutoFire(true));
    act(() => result.current.arm(result.current.targets[0]));
    act(() => result.current.setAutoFire(false)); // MD turns it off before arrival
    act(() => result.current.advance()); // lands on the fire bar
    expect(result.current.armed).not.toBeNull(); // no auto-commit — go-tap restored
  });

  it('canArmNextSection reflects whether a section boundary lies ahead', async () => {
    const { result } = renderHook(() => useConductorSession(args({ cal: secCal })));
    await waitFor(() => expect(result.current.active).toBe(true));
    act(() => result.current.advance()); // current b1 (Intro) — Verse/Chorus ahead
    expect(result.current.canArmNextSection).toBe(true);
    for (let i = 0; i < 4; i++) act(() => result.current.advance()); // → b5 (Chorus, last)
    expect(result.current.current?.barId).toBe('b5');
    expect(result.current.canArmNextSection).toBe(false); // no section ahead
  });

  it('release preserves the auto-fire latch: a held marker still fires on arrival post-release', async () => {
    // §8 hold path. Verse b1..b4 is a repeat body+volta (sV); Chorus b5,b6 (sC) follow.
    // Arm "fire at next section" (= b5, the Chorus head, reached only AFTER the vamp).
    // While holding, the playhead loops the verse and never reaches b5 → no fire. On
    // Release the vamp exits forward; the marker must STILL auto-fire when it lands on
    // b5 — i.e. the Release redirect must NOT clear the eligibility latch (Codex HIGH).
    const vampCal = makeCal(
      [
        { id: 'b1', sectionId: 'sV' },
        { id: 'b2', sectionId: 'sV' },
        { id: 'b3', sectionId: 'sV' },
        { id: 'b4', sectionId: 'sV' },
        { id: 'b5', sectionId: 'sC' },
        { id: 'b6', sectionId: 'sC' },
      ],
      [rstart('R', 'b1'), ending('E1', 'R', ['b3'], [1]), ending('E2', 'R', ['b4'], [2])],
      [sec('sV', 'Verse'), sec('sC', 'Chorus')],
    );
    const { result } = renderHook(() => useConductorSession(args({ cal: vampCal })));
    await waitFor(() => expect(result.current.active).toBe(true));
    act(() => result.current.setAutoFire(true));
    act(() => result.current.advance()); // current b1
    expect(result.current.canArmNextSection).toBe(true);
    act(() => result.current.arm(result.current.targets[0], undefined, 'next-section'));
    expect(result.current.armed?.fireAt).toBe('b5'); // Chorus head, post-vamp
    // vamp the verse — loops, never reaches b5 → no auto-fire, marker stays armed
    const hold = result.current.redirects.find((o) => o.label === 'Vamp (hold)')!;
    act(() => result.current.redirect(hold));
    expect(result.current.state?.vm.holding).toBe('R');
    act(() => result.current.advance());
    act(() => result.current.advance());
    expect(result.current.armed).not.toBeNull(); // still pending mid-vamp
    expect(result.current.current?.barId).not.toBe('b5');
    // release the vamp — must preserve the armed marker AND the auto-fire latch
    const release = result.current.redirects.find((o) => o.label === 'Release vamp')!;
    act(() => result.current.redirect(release));
    expect(result.current.state?.vm.holding).toBeNull();
    expect(result.current.armed).not.toBeNull(); // release does not disarm
    // advance to the Chorus head — the marker must auto-fire on arrival
    let fired = false;
    for (let i = 0; i < 10 && !fired; i++) {
      act(() => result.current.advance());
      if (result.current.armed === null) fired = true; // auto-fire cleared the marker
    }
    expect(fired).toBe(true);
  });

  it('holding AT the fire bar: gate refuses on arrival, then the release ITSELF fires it (Codex repro)', async () => {
    // The literal Codex repro: a NEXT-BAR fire whose target lands INSIDE the vamp body,
    // so the playhead arrives ON fireAt while still holding. The §3.5 gate must refuse
    // there (never fire mid-vamp). The reducer keeps `current` PARKED on fireAt across a
    // redirect, so when Release clears the hold `shouldAutoFire` becomes true on the
    // release itself — and the release must fire it THERE. (The NEXT advance would step
    // the volta straight off fireAt and never return, so "fire on the next advance" is
    // mechanically impossible for a next-bar fire in the vamp body — the original bug.)
    // Default `cal`: R repeat over body b1,b2 with voltas b3/b4; arm next-bar = b2.
    const { result } = renderHook(() => useConductorSession(args()));
    await waitFor(() => expect(result.current.active).toBe(true));
    act(() => result.current.setAutoFire(true));
    act(() => result.current.advance()); // current b1
    expect(result.current.current?.barId).toBe('b1');
    // arm "next bar" (default) → fireAt = b2, a bar the vamp parks on
    act(() => result.current.arm(result.current.targets[0]));
    expect(result.current.armed?.fireAt).toBe('b2');
    // start the vamp, then advance ONTO b2 (= fireAt) while holding → gate refuses
    const hold = result.current.redirects.find((o) => o.label === 'Vamp (hold)')!;
    act(() => result.current.redirect(hold));
    expect(result.current.state?.vm.holding).toBe('R');
    act(() => result.current.advance()); // emit b2 = fireAt, but holding ⇒ refused
    expect(result.current.current?.barId).toBe('b2');
    expect(result.current.armed).not.toBeNull(); // refused mid-vamp — marker survives
    // release the vamp while parked on the fire bar → the release fires the marker
    const release = result.current.redirects.find((o) => o.label === 'Release vamp')!;
    act(() => result.current.redirect(release));
    expect(result.current.state?.vm.holding).toBeNull();
    expect(result.current.armed).toBeNull(); // auto-fired on release (not a later advance)
    expect(result.current.outcome).toBe('applied'); // the COMMIT result, not the redirect
  });

  it('no spurious fire: a non-opening redirect on an ALREADY-open gate preserves the marker (Codex R3 repro)', async () => {
    // Auto-fire fires on the RISING EDGE of the §3.5 gate, never merely because the gate
    // is open. Repro: arm while parked one bar short, advance ONTO fireAt with auto-fire
    // OFF (so it does not fire), THEN toggle auto-fire ON — the gate is now open but no
    // arrival/release happened. A subsequent unrelated redirect ("Another round", which
    // does not move `current` off fireAt) must NOT auto-commit the stale armed marker.
    const { result } = renderHook(() => useConductorSession(args()));
    await waitFor(() => expect(result.current.active).toBe(true));
    act(() => result.current.advance()); // current b1
    act(() => result.current.arm(result.current.targets[0])); // fireAt = b2
    expect(result.current.armed?.fireAt).toBe('b2');
    act(() => result.current.advance()); // arrive b2 = fireAt, auto-fire OFF ⇒ no fire
    expect(result.current.current?.barId).toBe('b2');
    expect(result.current.armed).not.toBeNull();
    act(() => result.current.setAutoFire(true)); // gate now OPEN, but no edge event
    const round = result.current.redirects.find((o) => o.label === 'Another round')!;
    expect(round).toBeDefined();
    act(() => result.current.redirect(round)); // applied, but current stays on fireAt
    expect(result.current.outcome).toBe('applied'); // the redirect REALLY applied (non-vacuous)
    expect(result.current.armed).not.toBeNull(); // NOT fired — no rising edge
    expect(result.current.armed?.fireAt).toBe('b2');
  });

  it('arm seam: a backward section with NO exit bakes the insert-return leg', async () => {
    const { result } = renderHook(() => useConductorSession(args({ cal: secCal })));
    await waitFor(() => expect(result.current.active).toBe(true));
    for (let i = 0; i < 3; i++) act(() => result.current.advance()); // current b3 (Verse)
    expect(result.current.current?.barId).toBe('b3');
    const intro = result.current.targets.find((t) => t.kind === 'section' && t.barId === 'b1')!;
    act(() => result.current.arm(intro)); // backward (b1 < b3), no exit
    expect(result.current.armed?.directive).toMatchObject({ kind: 'jumpTo', barId: 'b1' });
    expect(result.current.armed?.directive.return).toBeDefined(); // return leg baked
    expect(result.current.armed?.directive.exit).toBeUndefined();
  });

  it('arm seam: the SAME backward section WITH an exit carries the exit and NO return', async () => {
    const { result } = renderHook(() => useConductorSession(args({ cal: secCal })));
    await waitFor(() => expect(result.current.active).toBe(true));
    for (let i = 0; i < 3; i++) act(() => result.current.advance()); // current b3 (Verse)
    const intro = result.current.targets.find((t) => t.kind === 'section' && t.barId === 'b1')!;
    act(() => result.current.arm(intro, 'alFine')); // exit requested → suppresses return
    expect(result.current.armed?.directive.exit).toEqual({ kind: 'alFine' });
    expect(result.current.armed?.directive.return).toBeUndefined();
  });

  // ── 5b chunk 1: align / true-up + Invariant (P) bookkeeping (the binding) ─────
  it('reckoning starts at the unconfirmed-start (anchor null, untrusted)', async () => {
    const { result } = renderHook(() => useConductorSession(args()));
    await waitFor(() => expect(result.current.active).toBe(true));
    expect(result.current.reckoning.anchor).toBeNull();
    expect(result.current.reckoning.positionTrusted).toBe(false);
  });

  it('align at the start (current=null) seeds bar 1 and re-anchors trusted onto {b1,1}', async () => {
    const { result } = renderHook(() => useConductorSession(args()));
    await waitFor(() => expect(result.current.active).toBe(true));
    expect(result.current.current).toBeNull();
    act(() => result.current.align()); // seed = the first manual advance
    expect(result.current.current?.barId).toBe('b1');
    expect(result.current.reckoning.anchor).toEqual({ barId: 'b1', pass: 1 });
    expect(result.current.reckoning.positionTrusted).toBe(true);
    expect(result.current.reckoning.barsSinceAnchor).toBe(0);
  });

  it('align mid-song re-zeros onto current with NO dispatch (session unchanged)', async () => {
    const { result } = renderHook(() => useConductorSession(args()));
    await waitFor(() => expect(result.current.active).toBe(true));
    act(() => result.current.advance()); // current b1, trusted
    const stateBefore = result.current.state; // same ref iff no dispatch happens
    act(() => result.current.align()); // mid-song true-up — MD-local only
    expect(result.current.state).toBe(stateBefore); // no session replacement = no dispatch
    expect(result.current.current?.barId).toBe('b1'); // never moves current
    expect(result.current.reckoning.anchor).toEqual({ barId: 'b1', pass: 1 });
    expect(result.current.reckoning.positionTrusted).toBe(true);
  });

  it('a manual advance re-anchors (positionTrusted, barsSinceAnchor=0)', async () => {
    const { result } = renderHook(() => useConductorSession(args()));
    await waitFor(() => expect(result.current.active).toBe(true));
    act(() => result.current.advance());
    expect(result.current.reckoning.positionTrusted).toBe(true);
    expect(result.current.reckoning.barsSinceAnchor).toBe(0);
    expect(result.current.reckoning.anchor).toEqual({ barId: 'b1', pass: 1 });
  });

  it('a redirect does NOT re-anchor — reckoning preserved (Invariant (P) no-op)', async () => {
    const { result } = renderHook(() => useConductorSession(args()));
    await waitFor(() => expect(result.current.active).toBe(true));
    act(() => result.current.advance()); // current b1, trusted, anchor {b1,1}
    const before = result.current.reckoning;
    const opt = result.current.redirects.find((o) => o.label === 'Another round')!;
    act(() => result.current.redirect(opt)); // moves vm seed only — current unchanged
    expect(result.current.reckoning).toBe(before); // untouched (anchor/aligned/trust all kept)
  });

  it('a no-armed commit does NOT re-anchor (R8 guarantee)', async () => {
    const { result } = renderHook(() => useConductorSession(args()));
    await waitFor(() => expect(result.current.active).toBe(true));
    act(() => result.current.advance()); // current b1, trusted
    const before = result.current.reckoning;
    act(() => result.current.commit()); // nothing armed → current unchanged
    expect(result.current.reckoning.anchor).toEqual(before.anchor);
    expect(result.current.reckoning.positionTrusted).toBe(true);
    expect(result.current.reckoning.alignedAtMs).toBe(before.alignedAtMs);
  });

  it('chained auto-fire (advance-opened): manual leg re-anchors, autofire leg stamps untrusted — single coherent reckoning, no double-count', async () => {
    const { result } = renderHook(() => useConductorSession(args({ cal: secCal })));
    await waitFor(() => expect(result.current.active).toBe(true));
    act(() => result.current.advance()); // current b1 (Intro), trusted
    act(() => result.current.setAutoFire(true));
    const chorus = result.current.targets.find((t) => t.kind === 'section' && t.barId === 'b5')!;
    act(() => result.current.arm(chorus)); // fireAt next-bar = b2
    expect(result.current.armed?.fireAt).toBe('b2');
    act(() => result.current.advance()); // emit b2 = fireAt → chained commit jumps to b5
    expect(result.current.armed).toBeNull(); // auto-fired
    expect(result.current.current?.barId).toBe('b5'); // MACHINE-placed by the autofire commit
    // The manual leg re-anchored onto b2; the autofire leg flipped ONLY positionTrusted.
    expect(result.current.reckoning.positionTrusted).toBe(false);
    expect(result.current.reckoning.anchor).toEqual({ barId: 'b2', pass: 1 }); // NOT b5
    expect(result.current.reckoning.barsSinceAnchor).toBe(0); // no double-count
  });

  it('release-opened auto-fire stamps untrusted (the §5.5 #5 path)', async () => {
    const { result } = renderHook(() => useConductorSession(args()));
    await waitFor(() => expect(result.current.active).toBe(true));
    act(() => result.current.setAutoFire(true));
    act(() => result.current.advance()); // current b1
    act(() => result.current.arm(result.current.targets[0])); // fireAt = b2 (inside vamp body)
    expect(result.current.armed?.fireAt).toBe('b2');
    const hold = result.current.redirects.find((o) => o.label === 'Vamp (hold)')!;
    act(() => result.current.redirect(hold));
    act(() => result.current.advance()); // emit b2 = fireAt, but holding ⇒ gate refused
    expect(result.current.armed).not.toBeNull();
    const release = result.current.redirects.find((o) => o.label === 'Release vamp')!;
    act(() => result.current.redirect(release)); // release OPENS the gate → fires THERE
    expect(result.current.armed).toBeNull(); // auto-fired on the release
    expect(result.current.reckoning.positionTrusted).toBe(false); // machine-placed
  });

  it('reckoning resets to the unconfirmed-start on disable', async () => {
    const { result, rerender } = renderHook(
      (p: Parameters<typeof useConductorSession>[0]) => useConductorSession(p),
      { initialProps: args() },
    );
    await waitFor(() => expect(result.current.active).toBe(true));
    act(() => result.current.advance()); // trusted, anchor {b1,1}
    expect(result.current.reckoning.positionTrusted).toBe(true);
    rerender(args({ enabled: false }));
    await act(async () => {}); // disabled branch defers its reset to a microtask
    expect(result.current.reckoning.anchor).toBeNull();
    expect(result.current.reckoning.positionTrusted).toBe(false);
  });

  it('reckoning resets to the unconfirmed-start on identity change (new sessionId)', async () => {
    const { result, rerender } = renderHook(
      (p: Parameters<typeof useConductorSession>[0]) => useConductorSession(p),
      { initialProps: args() },
    );
    await waitFor(() => expect(result.current.active).toBe(true));
    act(() => result.current.advance());
    expect(result.current.reckoning.positionTrusted).toBe(true);
    rerender(args({ sessionId: 'chart2::owner/show', songRef: 'chart2' }));
    await waitFor(() => expect(result.current.current).toBeNull()); // fresh session
    expect(result.current.reckoning.anchor).toBeNull();
    expect(result.current.reckoning.positionTrusted).toBe(false);
  });
});

// ── 5b chunk 2: the static-BPM motion driver (jsdom + controlled clock) ───────
// We fake ONLY setInterval/clearInterval and drive Date.now() through a spy so each
// tick observes an EXACT time. (Faking Date too would make sinon's catch-up replay
// every intermediate tick at its own scheduled instant — which can never produce the
// owed≥2 jump a real tab-sleep causes; a single controlled tick is the faithful model.)
// `enabled` defaults to true; bpm is the static-BPM source (null ⇒ manual rung).

const T0 = 1_700_000_000_000; // a fixed, large epoch so (now − baseline) is always ≥ 0
const lin = (...ids: string[]) => makeCal(ids.map((id) => ({ id }))); // linear (no roadmap)
const bm120 = barMs(120, 4); // 2000 ms/bar

// Activate a session at a controlled clock, returning the time handle + render result.
async function activateAt(over: Partial<Parameters<typeof useConductorSession>[0]> = {}) {
  const clock = { t: T0 };
  vi.spyOn(Date, 'now').mockImplementation(() => clock.t);
  const rh = renderHook(
    (p: Parameters<typeof useConductorSession>[0]) => useConductorSession(p),
    { initialProps: args({ bpm: 120, ...over }) },
  );
  await waitFor(() => expect(rh.result.current.active).toBe(true)); // real timers — not faked yet
  // From here on, fake ONLY the interval so we can fire single, time-exact ticks.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  return { clock, ...rh };
}

describe('useConductorSession — static-BPM motion driver (5b chunk 2)', () => {
  it('rung is manual until the clock is turned on; static-bpm once it is (with a stated tempo)', async () => {
    const { result } = await activateAt();
    expect(result.current.clockOn).toBe(false);
    expect(result.current.rung).toBe('manual');
    act(() => result.current.align()); // seed b1 (the clock needs a position to dead-reckon from)
    act(() => result.current.setClockOn(true));
    expect(result.current.rung).toBe('static-bpm');
  });

  it('no stated tempo (null bpm) keeps the rung manual even with the clock on', async () => {
    const { result } = await activateAt({ bpm: null });
    act(() => result.current.align());
    act(() => result.current.setClockOn(true));
    expect(result.current.rung).toBe('manual');
  });

  it('drives EXACTLY one advance per bar period (no fast-forward within a tick)', async () => {
    const { result, clock } = await activateAt();
    act(() => result.current.align()); // current b1, baseline T0, barsSinceAnchor 0
    act(() => result.current.setClockOn(true));
    clock.t = T0 + bm120; // one bar has elapsed → owed 1
    act(() => vi.advanceTimersToNextTimer()); // one tick
    expect(result.current.current?.barId).toBe('b2');
    expect(result.current.reckoning.barsSinceAnchor).toBe(1);
    clock.t = T0 + 2 * bm120; // a second bar → owed 1 again
    act(() => vi.advanceTimersToNextTimer());
    expect(result.current.current?.barId).toBe('b3');
    expect(result.current.reckoning.barsSinceAnchor).toBe(2);
  });

  it('two clock ticks at the SAME bar (no time passed between) yield only ONE advance (driverRef gate)', async () => {
    const { result, clock } = await activateAt();
    act(() => result.current.align());
    act(() => result.current.setClockOn(true));
    clock.t = T0 + bm120; // owed 1
    act(() => vi.advanceTimersToNextTimer()); // advances → b2, barsSinceAnchor 1
    act(() => vi.advanceTimersToNextTimer()); // SAME clock.t — driverRef already advanced ⇒ owed 0
    expect(result.current.current?.barId).toBe('b2'); // not b3
    expect(result.current.reckoning.barsSinceAnchor).toBe(1);
  });

  it('owed ≥ 2 in a single tick (a tab-sleep) STALLS instead of fast-forwarding; align clears it', async () => {
    const { result, clock } = await activateAt();
    act(() => result.current.align()); // current b1
    act(() => result.current.setClockOn(true));
    clock.t = T0 + 2 * bm120 + 50; // two bars elapsed in one tick (loop was suspended)
    act(() => vi.advanceTimersToNextTimer());
    expect(result.current.stalled).toBe(true);
    expect(result.current.rung).toBe('manual'); // stall demotes the readout honestly
    expect(result.current.current?.barId).toBe('b1'); // frozen — never fast-forwarded
    // the align tap re-seeds the baseline onto current and resumes
    act(() => result.current.align());
    expect(result.current.stalled).toBe(false);
    expect(result.current.current?.barId).toBe('b1');
  });

  it('a no-armed commit while stalled does NOT clear the stall (only a real move / align does)', async () => {
    const { result, clock } = await activateAt();
    act(() => result.current.align());
    act(() => result.current.setClockOn(true));
    clock.t = T0 + 2 * bm120 + 50;
    act(() => vi.advanceTimersToNextTimer());
    expect(result.current.stalled).toBe(true);
    act(() => result.current.commit()); // nothing armed ⇒ current does not move
    expect(result.current.stalled).toBe(true); // still stalled
  });

  it('a manual advance mid-clock re-anchors (trusted) and is not double-counted by the clock', async () => {
    const { result, clock } = await activateAt();
    act(() => result.current.align()); // b1
    act(() => result.current.setClockOn(true));
    clock.t = T0 + bm120;
    act(() => vi.advanceTimersToNextTimer()); // clock → b2, untrusted
    expect(result.current.reckoning.positionTrusted).toBe(false);
    act(() => result.current.advance()); // MD taps ahead manually → b3, re-anchored trusted
    expect(result.current.current?.barId).toBe('b3');
    expect(result.current.reckoning.positionTrusted).toBe(true);
    expect(result.current.reckoning.barsSinceAnchor).toBe(0);
  });

  it('a redirect mid-clock leaves the reckoning untouched and does not clear a running clock', async () => {
    const { result, clock } = await activateAt();
    act(() => result.current.advance()); // current b1 (need a vamp redirect available; default cal has the repeat)
    act(() => result.current.setClockOn(true));
    const before = result.current.reckoning;
    const round = result.current.redirects.find((o) => o.label === 'Another round')!;
    clock.t = T0; // no time passes
    act(() => result.current.redirect(round));
    expect(result.current.reckoning).toBe(before); // Invariant (P) no-op — current never moved
  });

  it('a mid-clock tempo change re-baselines the MOTION axis IN-TICK — no jump, no stall (Codex R5/R6 HIGH 2)', async () => {
    const { result, clock, rerender } = await activateAt();
    act(() => result.current.align()); // b1, baseline T0
    act(() => result.current.setClockOn(true));
    clock.t = T0 + bm120;
    act(() => vi.advanceTimersToNextTimer()); // → b2, barsSinceAnchor 1 (establishes bpm 120)
    // MD changes the song's stated tempo to 140 mid-clock. NO manual flush: the cfgRef mirror is a
    // LAYOUT effect (Codex R6), so the new bpm lands in the rerender's COMMIT — every subsequent tick
    // reads 140 with no commit→passive window to lose. The reconcile then happens INSIDE the tick,
    // atomically aligned with the baseline: the FIRST tick after the change re-zeros the motion axis
    // to NOW (consumes no bar); the NEXT tick (one 140-bpm bar later) advances cleanly.
    rerender(args({ bpm: 140 }));
    const bm140 = barMs(140, 4);
    clock.t = T0 + bm120 + 7; // a beat after the change — the reconcile tick re-zeros to here
    act(() => vi.advanceTimersToNextTimer());
    expect(result.current.current?.barId).toBe('b2'); // reconcile only — did NOT jump a bar
    expect(result.current.stalled).toBe(false);
    clock.t = T0 + bm120 + 7 + bm140 + 5; // just past one 140-bpm bar (epsilon clears float floor)
    act(() => vi.advanceTimersToNextTimer());
    expect(result.current.current?.barId).toBe('b3'); // advanced one bar off the NEW tempo
    expect(result.current.stalled).toBe(false);
  });

  it('an identity change while the clock runs inerts the stale interval — no ghost advance (Codex R5/R6 HIGH 1)', async () => {
    const { result, clock, rerender } = await activateAt({
      cal: lin('a1', 'a2', 'a3'),
      songRef: 'songA',
      sessionId: 'songA::o/s',
    });
    act(() => result.current.align()); // a1
    act(() => result.current.setClockOn(true));
    clock.t = T0 + bm120;
    act(() => vi.advanceTimersToNextTimer()); // clock → a2
    expect(result.current.current?.barId).toBe('a2');
    // Swap to a DIFFERENT chart while clockOn is still true. The OLD interval is still keyed
    // [enabled, clockOn] and mounted; the new session is reseeded asynchronously (programHash). A
    // LAYOUT effect nulls driverRef.session in the rerender's COMMIT (Codex R6) — before the event
    // loop can run a due timer — so the still-mounted interval is inert against the stale session.
    // (RTL's act collapses the commit→passive flush, so this asserts the post-commit invariant: the
    // session is null in the same commit, hence even a maximally-owed stale tick advances/stalls nothing.)
    rerender(args({ cal: lin('z1', 'z2', 'z3'), songRef: 'songZ', sessionId: 'songZ::o/s', bpm: 120 }));
    clock.t = T0 + 10 * bm120; // a long owed window — a LIVE stale tick would stall/fast-forward songA
    act(() => vi.advanceTimersToNextTimer()); // the stale interval fires once — must do nothing
    expect(result.current.stalled).toBe(false); // no ghost stall leaked across the swap
    // The new session settles (async programHash) with the clock reset OFF (per-session §12-Q4) and a
    // fresh cursor. Use REAL timers + waitFor so the assertion is robust to the resolve's microtask
    // depth (a single act-flush was order-sensitive across the full suite — the prior flake).
    vi.useRealTimers();
    await waitFor(() => expect(result.current.clockOn).toBe(false));
    expect(result.current.current).toBeNull();
  });

  it('toggling the clock OFF tears the interval down in-commit — no spurious post-off advance (Codex R6 class)', async () => {
    const { result, clock } = await activateAt();
    act(() => result.current.align()); // b1
    act(() => result.current.setClockOn(true));
    clock.t = T0 + bm120;
    act(() => vi.advanceTimersToNextTimer()); // → b2
    expect(result.current.current?.barId).toBe('b2');
    // MD turns the clock off. The driver is a LAYOUT effect, so its cleanup clears the interval in
    // the setClockOn(false) commit (before a due tick can run). A long owed window then fires nothing.
    act(() => result.current.setClockOn(false));
    clock.t = T0 + 20 * bm120;
    act(() => vi.advanceTimersByTime(20 * bm120));
    expect(result.current.current?.barId).toBe('b2'); // no spurious advance after clock-off
    expect(result.current.stalled).toBe(false);
  });

  it('the clock idles at song end — no churn, no stall (vm.done guard)', async () => {
    const { result, clock } = await activateAt({ cal: lin('x1', 'x2') });
    for (let i = 0; i < 6 && !result.current.done; i++) act(() => result.current.advance());
    expect(result.current.done).toBe(true);
    const at = result.current.current?.barId ?? null;
    act(() => result.current.setClockOn(true));
    clock.t = T0 + 10 * bm120; // plenty of time — but the song is over
    act(() => vi.advanceTimersToNextTimer());
    expect(result.current.current?.barId ?? null).toBe(at); // unchanged
    expect(result.current.stalled).toBe(false);
  });

  it('the clock is inert while unseeded (current === null): no advance, no stall', async () => {
    const { result, clock } = await activateAt();
    act(() => result.current.setClockOn(true)); // NEVER aligned — nothing to dead-reckon from
    clock.t = T0 + 5 * bm120;
    act(() => vi.advanceTimersToNextTimer());
    expect(result.current.current).toBeNull();
    expect(result.current.stalled).toBe(false);
  });

  it('with the clock OFF the interval never mounts — the redline does not self-advance', async () => {
    const { result, clock } = await activateAt();
    act(() => result.current.align()); // b1
    clock.t = T0 + 5 * bm120; // lots of time, but clockOn stays false
    act(() => vi.advanceTimersByTime(5 * bm120)); // no interval scheduled ⇒ nothing fires
    expect(result.current.current?.barId).toBe('b1');
  });
});

// ── 5b chunk 3: the confidence gate — clock-driven auto-fire (the trusted slice) ─
// A clock arrival is UNTRUSTED (positionTrusted=false); it auto-commits an armed marker only
// when clockConfidenceOk holds (trued + within the bound + static-bpm). A MANUAL arrival is
// trusted → fires unconditionally (the 5a floor). The toggles route through gateRef so the
// FROZEN motion-tick reads them LIVE (§2). Same fake-interval + Date.now-spy harness as chunk 2.

describe('useConductorSession — the confidence gate (5b chunk 3)', () => {
  it('a trusted clock arrival within the bound AUTO-FIRES an armed marker (auto-fire on)', async () => {
    const { result, clock } = await activateAt();
    act(() => result.current.align()); // seed b1 (trusted, alignedAtMs set, barsSinceAnchor 0)
    act(() => result.current.arm(result.current.targets[0])); // fireAt = b2 (next emitted)
    expect(result.current.armed?.fireAt).toBe('b2');
    act(() => result.current.setAutoFire(true));
    act(() => result.current.setClockOn(true));
    clock.t = T0 + bm120; // one bar elapsed → the clock drives b1 → b2 = fireAt
    act(() => vi.advanceTimersToNextTimer());
    expect(result.current.armed).toBeNull(); // confident clock arrival auto-committed
    expect(result.current.outcome).toBe('applied');
  });

  it('§2 regression: toggling auto-fire AFTER the interval mounts is still respected (gateRef, not a stale closure)', async () => {
    const { result, clock } = await activateAt();
    act(() => result.current.align());
    act(() => result.current.arm(result.current.targets[0])); // fireAt = b2
    act(() => result.current.setClockOn(true)); // interval mounts with auto-fire still OFF
    act(() => result.current.setAutoFire(true)); // flipped AFTER mount — a stale closure would miss this
    clock.t = T0 + bm120;
    act(() => vi.advanceTimersToNextTimer());
    expect(result.current.armed).toBeNull(); // the frozen tick read the LIVE toggle via gateRef
  });

  it('auto-fire OFF: a clock arrival onto the fire bar never auto-commits (5a parity)', async () => {
    const { result, clock } = await activateAt();
    act(() => result.current.align());
    act(() => result.current.arm(result.current.targets[0])); // fireAt = b2
    act(() => result.current.setClockOn(true)); // auto-fire stays OFF
    clock.t = T0 + bm120;
    act(() => vi.advanceTimersToNextTimer());
    expect(result.current.current?.barId).toBe('b2'); // clock advanced onto the fire bar
    expect(result.current.armed).not.toBeNull(); // but the toggle is off ⇒ no auto-commit
  });

  it('a MANUAL arrival fires unconditionally even with the clock off (trust bypasses confidence — the 5a floor)', async () => {
    const { result } = await activateAt();
    act(() => result.current.advance()); // manual seed b1 (trusted)
    act(() => result.current.arm(result.current.targets[0])); // fireAt = b2
    act(() => result.current.setAutoFire(true)); // clock stays OFF ⇒ rung 'manual' (clockConfidenceOk=false)
    expect(result.current.rung).toBe('manual');
    act(() => result.current.advance()); // manual onto b2 = fireAt → positionTrusted=true → fires
    expect(result.current.armed).toBeNull();
    expect(result.current.outcome).toBe('applied');
  });

  it('a release over a CLOCK-placed fire bar fires WITHIN the bound (untrusted arrival, but confident — closes the R6 hole)', async () => {
    const { result, clock } = await activateAt();
    act(() => result.current.align()); // b1
    act(() => result.current.arm(result.current.targets[0])); // fireAt = b2 (a vamp body bar)
    expect(result.current.armed?.fireAt).toBe('b2');
    act(() => result.current.setAutoFire(true));
    const hold = result.current.redirects.find((o) => o.label === 'Vamp (hold)')!;
    act(() => result.current.redirect(hold)); // holding ⇒ the gate refuses mid-vamp
    act(() => result.current.setClockOn(true));
    clock.t = T0 + bm120;
    act(() => vi.advanceTimersToNextTimer()); // clock drives b1 → b2 (= fireAt) while holding → refused
    expect(result.current.current?.barId).toBe('b2');
    expect(result.current.armed).not.toBeNull(); // mid-vamp, no fire
    expect(result.current.reckoning.positionTrusted).toBe(false); // the CLOCK placed b2
    const release = result.current.redirects.find((o) => o.label === 'Release vamp')!;
    act(() => result.current.redirect(release)); // hold clears, current parked on fireAt → gate opens
    expect(result.current.armed).toBeNull(); // clock-placed arrival, but trued + within bound ⇒ fires
    expect(result.current.outcome).toBe('applied');
  });

  it('a release over a clock-placed fire bar PAST the bound DEFERS to the MD (long vamp); a manual commit recovers it', async () => {
    const { result, clock } = await activateAt();
    act(() => result.current.align()); // b1
    act(() => result.current.arm(result.current.targets[0])); // fireAt = b2
    act(() => result.current.setAutoFire(true));
    const hold = result.current.redirects.find((o) => o.label === 'Vamp (hold)')!;
    act(() => result.current.redirect(hold));
    act(() => result.current.setClockOn(true));
    // Vamp 9 bars (barsSinceAnchor 1..9): each held clock advance loops the body (b2,b1,b2,…),
    // counting +1 but never firing (holding). 9 > CLOCK_CONFIDENCE_BOUND_BARS (8), and odd ⇒ b2.
    for (let k = 1; k <= 9; k++) {
      clock.t = T0 + k * bm120;
      act(() => vi.advanceTimersToNextTimer());
    }
    expect(result.current.reckoning.barsSinceAnchor).toBe(9);
    expect(result.current.current?.barId).toBe('b2'); // parked on the fire bar
    expect(result.current.armed).not.toBeNull(); // survived the vamp
    const release = result.current.redirects.find((o) => o.label === 'Release vamp')!;
    act(() => result.current.redirect(release)); // gate opens, but barsSinceAnchor 9 > bound
    expect(result.current.armed).not.toBeNull(); // DEFERRED — past the trust horizon, not auto-fired
    // no corruption: the MD's manual "Go now" still jumps to the target
    act(() => result.current.commit());
    expect(result.current.armed).toBeNull();
  });
});

// ── 3b chunk 4: the relay slice (socket seam + gates, jsdom) ──────────────────
// The routing/gating matrix lives in tests/relay-binding.test.ts (pure) and the
// multi-device convergence proof in tests/relay-e2e.test.ts (real relay). These
// assert the HOOK wiring only: the injected socket lifecycle (hello on open),
// the local-ready hand-off from the async programHash, the fan-out seam on the
// real dispatch path, and the follower hard gate on local gestures.
describe('useConductorSession — relay binding (3b chunk 4)', () => {
  class FakeSocket implements RelaySocket {
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    closedByClient = false;
    constructor(public url: string) {}
    send(data: string) {
      this.sent.push(data);
    }
    close() {
      this.closedByClient = true;
    }
    // Test controls — the hook assigns handlers AFTER the factory returns, so
    // tests drive these inside act() once rendered.
    open() {
      this.onopen?.();
    }
    push(frame: unknown) {
      this.onmessage?.({ data: JSON.stringify(frame) });
    }
    drop() {
      this.onclose?.();
    }
    frames(): Array<Record<string, unknown>> {
      return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
    }
  }

  function relayHarness() {
    const sockets: FakeSocket[] = [];
    const socketFactory = (url: string) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    };
    const relay = {
      url: 'wss://relay.test:8787',
      room: 'band-show',
      code: 'XYZW',
      deviceLabel: 'Rachel',
      socketFactory,
    };
    return { sockets, relay, sock: () => sockets.at(-1)! };
  }

  /** The MD-side state another device would broadcast: the SAME chart compiled
   *  to the SAME hash the hook computes locally (identity by construction). */
  async function simPeer(sessionId: string, songRef: string, c: ChartCalibration): Promise<ConductorSession> {
    const compiled = compileRoadmap(barsInOrder(c), c.roadmap ?? []);
    if (!compiled.ok) throw new Error('sim compile failed');
    const hash = await computeProgramHash(barsInOrder(c), c.roadmap ?? []);
    return initSession(sessionId, songRef, hash, compiled.compiled, 0);
  }

  it('exposes the hard OFF block when no relay is configured', async () => {
    const { result } = renderHook(() => useConductorSession(args()));
    await waitFor(() => expect(result.current.active).toBe(true));
    expect(result.current.relay.status).toBe('off');
    expect(result.current.relay.role).toBe('local');
    expect(result.current.relay.canClaim).toBe(false);
  });

  it('writer flow: hello → joined → claim → grant sequence → advances fan out (§4.1)', async () => {
    const h = relayHarness();
    const { result } = renderHook(() => useConductorSession(args({ relay: h.relay })));
    await waitFor(() => expect(result.current.active).toBe(true));
    expect(result.current.relay.status).toBe('connecting');
    expect(h.sockets).toHaveLength(1);
    const sock = h.sock();

    // Socket opens → hello with room/code/label (join intent — D4; the
    // create-mode config split is chunk 2).
    act(() => sock.open());
    expect(sock.frames()).toEqual([
      { type: 'hello', intent: 'join', room: 'band-show', code: 'XYZW', deviceLabel: 'Rachel' },
    ]);

    // Admitted to an empty room: joined + claimable (the chart is loaded).
    act(() => sock.push({ type: 'joined', epoch: 0, hasWriter: false, activeSession: null, writerLabel: null }));
    expect(result.current.relay.status).toBe('joined');
    expect(result.current.relay.role).toBe('follower');
    expect(result.current.relay.canClaim).toBe(true);

    // Claim → grant: acceptBaton rebirths the session at the granted epoch and
    // the binding emits announce → snapshot upload → claim, in pinned order.
    act(() => result.current.relay.requestClaim());
    act(() => sock.push({ type: 'claim-grant', epoch: 1 }));
    expect(result.current.relay.role).toBe('writer');
    expect(result.current.state?.epoch).toBe(1);
    expect(result.current.state?.seq).toBe(0);
    const hash = result.current.state!.programHash;
    const key = { sessionId: 'chart1::owner/show', songRef: 'chart1', programHash: hash };
    const afterGrant = sock.frames().slice(1);
    expect(afterGrant.map((f) => f.type)).toEqual(['claim-request', 'session', 'snapshot', 'msg']);
    expect(afterGrant[1]).toEqual({ type: 'session', session: key });
    expect((afterGrant[3] as { msg: { payload: { kind: string } } }).msg.payload.kind).toBe('claim');

    // The fan-out seam: a local advance broadcasts exactly the applied mint.
    act(() => result.current.advance());
    expect(result.current.current?.barId).toBe('b1');
    const last = sock.frames().at(-1) as { type: string; msg: { seq: number; payload: { kind: string } } };
    expect(last.type).toBe('msg');
    expect(last.msg.payload.kind).toBe('advance');
    expect(last.msg.seq).toBe(1);
  });

  it('follower flow: join pulls, adopts the writer state, mirrors live msgs; local gestures are hard-gated', async () => {
    const h = relayHarness();
    const { result } = renderHook(() => useConductorSession(args({ relay: h.relay })));
    await waitFor(() => expect(result.current.active).toBe(true));
    const sock = h.sock();

    // A peer MD elsewhere on the SAME chart, two bars in.
    let md = await simPeer('chart1::owner/show', 'chart1', cal);
    md = dispatch(md, { kind: 'advance' }, 10).session; // → b1
    md = dispatch(md, { kind: 'advance' }, 20).session; // → b2
    const key = { sessionId: md.state.sessionId, songRef: md.state.songRef, programHash: md.state.programHash };

    // Join a room where that session is live → the binding pulls it.
    act(() => sock.open());
    act(() => sock.push({ type: 'joined', epoch: 0, hasWriter: true, activeSession: key, writerLabel: 'MD' }));
    expect(result.current.relay.role).toBe('follower');
    expect(result.current.relay.chartMismatch).toBe(false); // same chart → same hash
    expect(sock.frames().at(-1)).toEqual({ type: 'snapshot-request', session: key });

    // The served snapshot re-bases the local session onto the writer's state.
    act(() => sock.push({ type: 'snapshot', state: md.state, stale: false }));
    expect(result.current.current?.barId).toBe('b2');
    expect(result.current.state?.seq).toBe(2);

    // Live delta mirrors bar-for-bar.
    const step = dispatch(md, { kind: 'advance' }, 30); // → b3, seq 3
    act(() => sock.push({ type: 'msg', msg: step.msg }));
    expect(result.current.current?.barId).toBe('b3');

    // The follower hard gate: local gestures must NOT fork the wire's seq.
    const sentBefore = sock.sent.length;
    act(() => result.current.advance());
    expect(result.current.current?.barId).toBe('b3'); // unmoved
    expect(result.current.state?.seq).toBe(3); // no burned seq
    expect(sock.sent.length).toBe(sentBefore); // nothing broadcast

    // A seq GAP routes to needsSnapshot → exactly one re-pull (the recovery door).
    const gap = { ...step.msg!, seq: 9, payload: { kind: 'advance' } };
    act(() => sock.push({ type: 'msg', msg: gap }));
    expect(sock.frames().at(-1)).toEqual({ type: 'snapshot-request', session: key });
  });

  it('a socket drop resets to connecting and reconnects with a fresh hello (failure matrix row 1)', async () => {
    vi.useFakeTimers();
    const h = relayHarness();
    const { result } = renderHook(() => useConductorSession(args({ relay: h.relay })));
    await act(async () => {
      await vi.runOnlyPendingTimersAsync(); // flush the async programHash resolve
    });
    expect(result.current.active).toBe(true);
    const first = h.sock();
    act(() => first.open());
    act(() => first.push({ type: 'joined', epoch: 0, hasWriter: false, activeSession: null, writerLabel: null }));
    expect(result.current.relay.status).toBe('joined');

    // Drop: back to connecting, and a NEW socket dials after the backoff.
    act(() => first.drop());
    expect(result.current.relay.status).toBe('connecting');
    act(() => {
      vi.advanceTimersByTime(2000); // > RELAY_RECONNECT_MS
    });
    expect(h.sockets).toHaveLength(2);
    const second = h.sock();
    act(() => second.open());
    expect(second.frames()).toEqual([
      { type: 'hello', intent: 'join', room: 'band-show', code: 'XYZW', deviceLabel: 'Rachel' },
    ]);
    // The localKey survived the reconnect: joining a room running OUR chart is
    // claimable/mirrorable immediately (no re-hash needed).
    act(() => second.push({ type: 'joined', epoch: 0, hasWriter: false, activeSession: null, writerLabel: null }));
    expect(result.current.relay.canClaim).toBe(true);
  });

  it('a follower that self-drove while offline is crushed back onto the writer on rejoin (Codex R1 HIGH)', async () => {
    vi.useFakeTimers();
    const h = relayHarness();
    const { result } = renderHook(() => useConductorSession(args({ relay: h.relay })));
    await act(async () => {
      await vi.runOnlyPendingTimersAsync(); // flush the async programHash resolve
    });
    expect(result.current.active).toBe(true);
    const first = h.sock();

    // Converge as a follower on the peer MD's session (writer two bars in).
    let md = await simPeer('chart1::owner/show', 'chart1', cal);
    md = dispatch(md, { kind: 'advance' }, 10).session; // → b1
    md = dispatch(md, { kind: 'advance' }, 20).session; // → b2, seq 2
    const key = { sessionId: md.state.sessionId, songRef: md.state.songRef, programHash: md.state.programHash };
    act(() => first.open());
    act(() => first.push({ type: 'joined', epoch: 0, hasWriter: true, activeSession: key, writerLabel: 'MD' }));
    act(() => first.push({ type: 'snapshot', state: md.state, stale: false }));
    expect(result.current.current?.barId).toBe('b2');

    // Wi-Fi dies → 'joining' → the self-drive floor deliberately unblocks
    // local gestures: the follower forks AHEAD of the writer's coordinates.
    act(() => first.drop());
    act(() => result.current.advance()); // → b3, local seq 3 (a FORK)
    act(() => result.current.advance()); // → wraps to b1, local seq 4
    expect(result.current.state?.seq).toBe(4);
    expect(result.current.current?.barId).toBe('b1');

    // Rejoin: the mandatory pull is answered by the LIVE writer's FRESH
    // snapshot at LOWER coordinates — it must force-adopt (fork ≠ freshness);
    // forward-only here would freeze the mirror forever.
    act(() => {
      vi.advanceTimersByTime(2000); // > RELAY_RECONNECT_MS
    });
    const second = h.sock();
    act(() => second.open());
    act(() => second.push({ type: 'joined', epoch: 0, hasWriter: true, activeSession: key, writerLabel: 'MD' }));
    act(() => second.push({ type: 'snapshot', state: md.state, stale: false }));
    expect(result.current.current?.barId).toBe('b2'); // crushed onto the writer
    expect(result.current.state?.seq).toBe(2);

    // ...and live deltas mirror again (they would land `ignored` on the fork).
    const step = dispatch(md, { kind: 'advance' }, 30); // → b3, seq 3
    act(() => second.push({ type: 'msg', msg: step.msg }));
    expect(result.current.current?.barId).toBe('b3');
  });

  it('relay off→on with the SAME session keeps the localKey (teardown must not strand the binding)', async () => {
    const h = relayHarness();
    const { result, rerender } = renderHook(
      (p: Parameters<typeof useConductorSession>[0]) => useConductorSession(p),
      { initialProps: args({ relay: h.relay }) },
    );
    await waitFor(() => expect(result.current.active).toBe(true));
    act(() => h.sock().open());
    act(() => h.sock().push({ type: 'joined', epoch: 0, hasWriter: false, activeSession: null, writerLabel: null }));
    expect(result.current.relay.canClaim).toBe(true);

    // Toggle the relay OFF (identity unchanged ⇒ local-ready never re-fires)...
    rerender(args({ relay: null }));
    expect(result.current.relay.status).toBe('off');
    // ...and back ON: a fresh socket dials, and the surviving localKey still
    // gates claim/mirror correctly after the rejoin.
    rerender(args({ relay: h.relay }));
    expect(h.sockets).toHaveLength(2);
    act(() => h.sock().open());
    act(() => h.sock().push({ type: 'joined', epoch: 0, hasWriter: false, activeSession: null, writerLabel: null }));
    expect(result.current.relay.canClaim).toBe(true);
  });

  it('unmount closes the socket without a reconnect (teardown is not a drop)', async () => {
    const h = relayHarness();
    const { result, unmount } = renderHook(() => useConductorSession(args({ relay: h.relay })));
    await waitFor(() => expect(result.current.active).toBe(true));
    unmount();
    expect(h.sock().closedByClient).toBe(true);
    expect(h.sockets).toHaveLength(1); // no retry socket
  });
});
