import { describe, it, expect } from 'vitest';
import {
  serializeProgram,
  programHash,
  reduceConductor,
  type ConductorState,
  type ConductorMessage,
  type ConductorPayload,
  type Armed,
} from '../lib/conductor-state';
import { compileRoadmap, initVM, stepVM, type CompiledRoadmap, type VMState } from '../lib/roadmap-vm';
import type { RoadmapMarker } from '../lib/types';

// ── Builders ─────────────────────────────────────────────────────────────────
const rstart = (id: string, barId: string): RoadmapMarker => ({ id, kind: 'repeatStart', barId, edge: 'start' });
const ending = (id: string, repeatStartId: string, barIds: string[], numbers: number[]): RoadmapMarker =>
  ({ id, kind: 'ending', repeatStartId, barIds, numbers });

function compileOrThrow(ids: string[], markers: RoadmapMarker[] = []): CompiledRoadmap {
  const c = compileRoadmap(ids.map((id) => ({ id })), markers);
  if (!c.ok) throw new Error(`compile failed: ${c.error.reason}`);
  return c.compiled;
}

const PH = 'program-hash-A';

function baseState(compiled: CompiledRoadmap, over: Partial<ConductorState> = {}): ConductorState {
  return {
    sessionId: 's1',
    songRef: 'song1',
    programHash: PH,
    epoch: 1,
    seq: 0,
    vm: initVM(compiled),
    current: null,
    armed: null,
    clock: { tempoBpm: null, confidence: 0 },
    updatedAt: 0,
    ...over,
  };
}

function msg(payload: ConductorPayload, over: Partial<ConductorMessage> = {}): ConductorMessage {
  return {
    sessionId: 's1',
    songRef: 'song1',
    programHash: PH,
    epoch: 1,
    seq: 1,
    sentAt: 1000,
    payload,
    ...over,
  };
}

const armed = (barId: string): Armed => ({ fireAt: 'fire', directive: { kind: 'jumpTo', barId } });

// ── programHash recipe (D10, R4 LOW) ─────────────────────────────────────────
describe('serializeProgram / programHash', () => {
  const bars = ['b1', 'b2', 'b3', 'b4'];
  const markers: RoadmapMarker[] = [
    rstart('R1', 'b1'),
    ending('E1', 'R1', ['b3'], [1]),
    ending('E2', 'R1', ['b4'], [2]),
  ];

  it('is insensitive to marker INPUT order', () => {
    const a = serializeProgram(bars.map((id) => ({ id })), markers);
    const b = serializeProgram(bars.map((id) => ({ id })), [markers[2], markers[0], markers[1]]);
    expect(a).toBe(b);
  });

  it('normalizes ending.numbers ascending (permutation is irrelevant)', () => {
    const a = serializeProgram(bars.map((id) => ({ id })), [ending('E', 'R1', ['b3', 'b4'], [1, 2])]);
    const b = serializeProgram(bars.map((id) => ({ id })), [ending('E', 'R1', ['b3', 'b4'], [2, 1])]);
    expect(a).toBe(b);
  });

  it('IS sensitive to bar ORDER (it is the index identity)', () => {
    const a = serializeProgram(bars.map((id) => ({ id })), markers);
    const b = serializeProgram(['b2', 'b1', 'b3', 'b4'].map((id) => ({ id })), markers);
    expect(a).not.toBe(b);
  });

  it('excludes confidence (incidental converter metadata)', () => {
    const withConf: RoadmapMarker[] = [{ ...rstart('R1', 'b1'), confidence: 0.4 }];
    const without: RoadmapMarker[] = [rstart('R1', 'b1')];
    expect(serializeProgram(bars.map((id) => ({ id })), withConf)).toBe(
      serializeProgram(bars.map((id) => ({ id })), without),
    );
  });

  it('programHash is a stable 64-char hex, equal for equal input, differing for differing input', async () => {
    const h1 = await programHash(bars.map((id) => ({ id })), markers);
    const h2 = await programHash(bars.map((id) => ({ id })), [markers[1], markers[2], markers[0]]);
    const h3 = await programHash(['b2', 'b1', 'b3', 'b4'].map((id) => ({ id })), markers);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });
});

// ── Program pin: local mismatch throws (R3 HIGH / R4 LOW) ─────────────────────
describe('reduceConductor — program pin', () => {
  const compiled = compileOrThrow(['b1', 'b2', 'b3']);

  it('THROWS on a local programHash mismatch (programmer invariant, before admission)', () => {
    const state = baseState(compiled);
    expect(() => reduceConductor(compiled, 'WRONG', state, msg({ kind: 'advance' }))).toThrow();
  });

  it('IGNORES a cross-revision message (msg.programHash mismatch) — state unchanged', () => {
    const state = baseState(compiled);
    const out = reduceConductor(compiled, PH, state, msg({ kind: 'advance' }, { programHash: 'OTHER' }));
    expect(out.status).toBe('ignored');
    expect(out.state).toBe(state);
  });
});

// ── Scope (MED-1) ────────────────────────────────────────────────────────────
describe('reduceConductor — scope', () => {
  const compiled = compileOrThrow(['b1', 'b2', 'b3']);

  it('ignores a session mismatch', () => {
    const state = baseState(compiled);
    expect(reduceConductor(compiled, PH, state, msg({ kind: 'advance' }, { sessionId: 'sX' })).status).toBe('ignored');
  });

  it('ignores a songRef mismatch', () => {
    const state = baseState(compiled);
    expect(reduceConductor(compiled, PH, state, msg({ kind: 'advance' }, { songRef: 'songX' })).status).toBe('ignored');
  });
});

// ── Epoch / claim (HIGH-3 / D4) ──────────────────────────────────────────────
describe('reduceConductor — epoch & claim', () => {
  const compiled = compileOrThrow(['b1', 'b2', 'b3']);

  it('higher-epoch claim → needsSnapshot, state UNCHANGED (never adopts over stale vm)', () => {
    const state = baseState(compiled, { epoch: 1, seq: 5 });
    const out = reduceConductor(compiled, PH, state, msg({ kind: 'claim' }, { epoch: 2, seq: 0 }));
    expect(out.status).toBe('needsSnapshot');
    expect(out.state).toBe(state);
  });

  it('equal/lower-epoch claim → ignored, epoch NOT bumped', () => {
    const state = baseState(compiled, { epoch: 2 });
    expect(reduceConductor(compiled, PH, state, msg({ kind: 'claim' }, { epoch: 2 })).status).toBe('ignored');
    expect(reduceConductor(compiled, PH, state, msg({ kind: 'claim' }, { epoch: 1 })).status).toBe('ignored');
  });

  it('stale-epoch non-claim → ignored', () => {
    const state = baseState(compiled, { epoch: 3 });
    expect(reduceConductor(compiled, PH, state, msg({ kind: 'advance' }, { epoch: 2, seq: 1 })).status).toBe('ignored');
  });

  it('future-epoch non-claim → needsSnapshot (fail safe, not silent)', () => {
    const state = baseState(compiled, { epoch: 1 });
    const out = reduceConductor(compiled, PH, state, msg({ kind: 'advance' }, { epoch: 2, seq: 1 }));
    expect(out.status).toBe('needsSnapshot');
    expect(out.state).toBe(state);
  });
});

// ── Seq contiguity (HIGH-1) ──────────────────────────────────────────────────
describe('reduceConductor — seq contiguity', () => {
  const compiled = compileOrThrow(['b1', 'b2', 'b3']);

  it('duplicate / lower seq → ignored', () => {
    const state = baseState(compiled, { seq: 3 });
    expect(reduceConductor(compiled, PH, state, msg({ kind: 'advance' }, { seq: 3 })).status).toBe('ignored');
    expect(reduceConductor(compiled, PH, state, msg({ kind: 'advance' }, { seq: 2 })).status).toBe('ignored');
  });

  it('the next in-order seq → applied (seq advances)', () => {
    const state = baseState(compiled, { seq: 3 });
    const out = reduceConductor(compiled, PH, state, msg({ kind: 'advance' }, { seq: 4 }));
    expect(out.status).toBe('applied');
    expect(out.state.seq).toBe(4);
  });

  it('a seq GAP → needsSnapshot, state UNCHANGED (a dropped delta cannot be replayed out of order)', () => {
    const state = baseState(compiled, { seq: 2 });
    const out = reduceConductor(compiled, PH, state, msg({ kind: 'advance' }, { seq: 4 }));
    expect(out.status).toBe('needsSnapshot');
    expect(out.state).toBe(state);
  });

  it('regression: arm(2) dropped, commit(3) must NOT silently apply past the lost arm', () => {
    // seq 1 arms; seq 2 (a second arm) is dropped; seq 3 commit arrives → gap at 3.
    const compiledR = compileOrThrow(['b1', 'b2', 'b3', 'b4']);
    const state = baseState(compiledR, { seq: 1 });
    // next in-order is seq 2; instead seq 3 arrives:
    const out = reduceConductor(compiledR, PH, state, msg({ kind: 'commit' }, { seq: 3 }));
    expect(out.status).toBe('needsSnapshot');
    expect(out.state).toBe(state);
  });
});

// ── advance (HIGH-2 / D8) ────────────────────────────────────────────────────
describe('reduceConductor — advance', () => {
  const compiled = compileOrThrow(['b1', 'b2', 'b3']);

  it('current equals the chunk-2 stepVM transition stream, bar-for-bar', () => {
    let state = baseState(compiled);
    let vm: VMState = initVM(compiled);
    for (let seq = 1; seq <= 3; seq++) {
      const out = reduceConductor(compiled, PH, state, msg({ kind: 'advance' }, { seq }));
      expect(out.status).toBe('applied');
      state = out.state;
      const r = stepVM(compiled, vm);
      vm = r.state;
      expect(state.current).toEqual(r.transition); // the EMITTED bar, not vm.cursor's next index
    }
    expect(state.current?.barId).toBe('b3');
  });

  it('song-end advance → current unchanged, vm.done true', () => {
    // drive to the last bar first
    let state = baseState(compiled);
    for (let seq = 1; seq <= 3; seq++) state = reduceConductor(compiled, PH, state, msg({ kind: 'advance' }, { seq })).state;
    expect(state.vm.done).toBe(true);
    const before = state.current;
    const out = reduceConductor(compiled, PH, state, msg({ kind: 'advance' }, { seq: 4 }));
    expect(out.state.current).toBe(before);
    expect(out.state.vm.done).toBe(true);
  });
});

// ── redirect ─────────────────────────────────────────────────────────────────
describe('reduceConductor — redirect', () => {
  const compiled = compileOrThrow(['b1', 'b2', 'b3', 'b4']);

  it('jumpTo moves vm (next-step seed) but leaves current until the next advance', () => {
    const state = baseState(compiled);
    const out = reduceConductor(compiled, PH, state, msg({ kind: 'redirect', directive: { kind: 'jumpTo', barId: 'b3' } }));
    expect(out.status).toBe('applied');
    expect(out.state.current).toBe(null);           // not emitted yet
    expect(out.state.vm.cursor).toBe(compiled.barPos.get('b3')); // seed moved
    // the next advance emits the target
    const out2 = reduceConductor(compiled, PH, out.state, msg({ kind: 'advance' }, { seq: 2 }));
    expect(out2.state.current?.barId).toBe('b3');
  });
});

// ── arm / commit / disarm (D2 / D5 / R3 MED) ─────────────────────────────────
describe('reduceConductor — arm / commit / disarm', () => {
  const compiled = compileOrThrow(['b1', 'b2', 'b3', 'b4']);

  it('arm with a valid target sets armed', () => {
    const state = baseState(compiled);
    const out = reduceConductor(compiled, PH, state, msg({ kind: 'arm', armed: armed('b4') }));
    expect(out.status).toBe('applied');
    expect(out.state.armed?.directive.barId).toBe('b4');
  });

  it('arm with an INVALID target → ignored (never store a poison pill)', () => {
    const state = baseState(compiled);
    const out = reduceConductor(compiled, PH, state, msg({ kind: 'arm', armed: armed('bX') }));
    expect(out.status).toBe('ignored');
    expect(out.state).toBe(state);
  });

  it('commit applies the armed jumpTo AND emits a real current; armed cleared', () => {
    const state = baseState(compiled, { armed: armed('b4'), seq: 1 });
    const out = reduceConductor(compiled, PH, state, msg({ kind: 'commit' }, { seq: 2 }));
    expect(out.status).toBe('applied');
    expect(out.state.current?.barId).toBe('b4');
    expect(out.state.current?.pass).toBe(1);                  // real 1-based emitted pass
    expect(out.state.vm.cursor).toBe(compiled.barPos.get('b4')! + 1); // seeded past the emitted bar
    expect(out.state.armed).toBe(null);
  });

  it('commit with nothing armed → applied no-op on the VM (seq still advances)', () => {
    const state = baseState(compiled, { seq: 1 });
    const out = reduceConductor(compiled, PH, state, msg({ kind: 'commit' }, { seq: 2 }));
    expect(out.status).toBe('applied');
    expect(out.state.current).toBe(null);
    expect(out.state.seq).toBe(2);
  });

  it('commit on a CORRUPT armed target → armed cleared, vm/current UNCHANGED, no step (R3 MED)', () => {
    const state = baseState(compiled, { armed: armed('bGONE'), seq: 1 });
    const out = reduceConductor(compiled, PH, state, msg({ kind: 'commit' }, { seq: 2 }));
    expect(out.status).toBe('applied');
    expect(out.state.armed).toBe(null);
    expect(out.state.current).toBe(null);                 // did NOT advance one normal bar
    expect(out.state.vm).toEqual(state.vm);
  });

  it('disarm clears a pending change', () => {
    const state = baseState(compiled, { armed: armed('b4') });
    const out = reduceConductor(compiled, PH, state, msg({ kind: 'disarm' }));
    expect(out.state.armed).toBe(null);
  });
});

// ── clock ────────────────────────────────────────────────────────────────────
describe('reduceConductor — clock', () => {
  const compiled = compileOrThrow(['b1', 'b2', 'b3']);

  it('stores the clock verbatim', () => {
    const state = baseState(compiled);
    const out = reduceConductor(compiled, PH, state, msg({ kind: 'clock', clock: { tempoBpm: 120, confidence: 0.9 } }));
    expect(out.state.clock).toEqual({ tempoBpm: 120, confidence: 0.9 });
  });
});

// ── Determinism & purity ─────────────────────────────────────────────────────
describe('reduceConductor — determinism & purity', () => {
  const compiled = compileOrThrow(['b1', 'b2', 'b3']);

  it('updatedAt = sentAt; two reducers fed identical input agree byte-for-byte', () => {
    const state = baseState(compiled);
    const m = msg({ kind: 'advance' }, { sentAt: 4242 });
    const a = reduceConductor(compiled, PH, state, m);
    const b = reduceConductor(compiled, PH, state, m);
    expect(a.state.updatedAt).toBe(4242);
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
  });

  it('never mutates the input state', () => {
    const state = baseState(compiled, { armed: armed('b3'), seq: 1 });
    const snapshot = JSON.stringify(state);
    reduceConductor(compiled, PH, state, msg({ kind: 'commit' }, { seq: 2 }));
    reduceConductor(compiled, PH, state, msg({ kind: 'advance' }, { seq: 2 }));
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});
