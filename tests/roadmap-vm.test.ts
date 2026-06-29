import { describe, it, expect } from 'vitest';
import {
  compileRoadmap,
  initVM,
  stepVM,
  applyOverride,
  type CompiledRoadmap,
  type VMState,
  type Directive,
} from '../lib/roadmap-vm';
import { resolveRoadmap } from '../lib/chart-calibration';
import type { ChartCalibration, RoadmapMarker, Bar, System } from '../lib/types';

// ── Builders ─────────────────────────────────────────────────────────────────
const rstart = (id: string, barId: string): RoadmapMarker => ({ id, kind: 'repeatStart', barId, edge: 'start' });
const rend = (id: string, barId: string, repeatStartId: string, times?: number): RoadmapMarker =>
  ({ id, kind: 'repeatEnd', barId, edge: 'end', repeatStartId, times });
const ending = (id: string, repeatStartId: string, barIds: string[], numbers: number[]): RoadmapMarker =>
  ({ id, kind: 'ending', repeatStartId, barIds, numbers });
const segno = (id: string, barId: string): RoadmapMarker => ({ id, kind: 'segno', barId, edge: 'start' });
const coda = (id: string, barId: string): RoadmapMarker => ({ id, kind: 'coda', barId, edge: 'start' });
const toCoda = (id: string, barId: string): RoadmapMarker => ({ id, kind: 'toCoda', barId, edge: 'end' });
const fine = (id: string, barId: string): RoadmapMarker => ({ id, kind: 'fine', barId, edge: 'end' });
const jump = (id: string, barId: string, from: 'capo' | 'segno', until: 'end' | 'fine' | 'coda'): RoadmapMarker =>
  ({ id, kind: 'jump', barId, edge: 'end', from, until });

function compileOrThrow(ids: string[], markers: RoadmapMarker[]): CompiledRoadmap {
  const c = compileRoadmap(ids.map((id) => ({ id })), markers);
  if (!c.ok) throw new Error(`compile failed: ${c.error.reason}`);
  return c.compiled;
}

// Step to completion from a given state, collecting barIds in order.
function runCollect(compiled: CompiledRoadmap, start: VMState): { state: VMState; ids: string[] } {
  const ids: string[] = [];
  let s = start;
  while (!s.done) {
    const r = stepVM(compiled, s);
    if (r.transition) ids.push(r.transition.barId);
    s = r.state;
    if (ids.length > 1000) throw new Error('runaway traversal');
  }
  return { state: s, ids };
}

const runToIds = (compiled: CompiledRoadmap): string[] => runCollect(compiled, initVM(compiled)).ids;

// Step exactly n times (used to drive a live VM to a chosen state, e.g. under a vamp hold).
function stepN(compiled: CompiledRoadmap, start: VMState, n: number): { state: VMState; ids: string[] } {
  const ids: string[] = [];
  let s = start;
  for (let i = 0; i < n; i++) {
    const r = stepVM(compiled, s);
    if (r.transition) ids.push(r.transition.barId);
    s = r.state;
  }
  return { state: s, ids };
}

const override = (compiled: CompiledRoadmap, s: VMState, d: Directive): VMState => applyOverride(compiled, s, d);

// Minimal ChartCalibration over one system (for the resolveRoadmap delegation check).
function cal(ids: string[], markers: RoadmapMarker[]): ChartCalibration {
  const system: System = { id: 'sys1', page: 1, yTop: 0, yBottom: 0.1, xStart: 0, xEnd: 1 };
  const bars: Bar[] = ids.map((id, i) => ({
    id, systemId: 'sys1', xStart: i / ids.length, xEnd: (i + 1) / ids.length, absNumber: i + 1, sectionId: null,
  }));
  return { schemaVersion: 3, status: 'draft', sections: [], systems: [system], bars, roadmap: markers };
}

// ── Default traversal (the resolver semantics, stepped) ──────────────────────
describe('roadmap-vm — default traversal matches the resolver semantics', () => {
  it('linear (no markers) plays bars once in order', () => {
    const c = compileOrThrow(['b1', 'b2', 'b3'], []);
    expect(c.linear).toBe(true);
    expect(runToIds(c)).toEqual(['b1', 'b2', 'b3']);
  });

  it('plain 2x repeat loops the body once', () => {
    const c = compileOrThrow(['b1', 'b2', 'b3', 'b4'], [rstart('rs', 'b1'), rend('re', 'b4', 'rs', 2)]);
    expect(runToIds(c)).toEqual(['b1', 'b2', 'b3', 'b4', 'b1', 'b2', 'b3', 'b4']);
  });

  it('1st/2nd voltas select by pass', () => {
    const c = compileOrThrow(
      ['b1', 'b2', 'b3', 'b4'],
      [rstart('rs', 'b1'), ending('e1', 'rs', ['b3'], [1]), ending('e2', 'rs', ['b4'], [2])],
    );
    expect(runToIds(c)).toEqual(['b1', 'b2', 'b3', 'b1', 'b2', 'b4']);
  });

  it('nested repeats replay the inner repeat on each outer pass', () => {
    const c = compileOrThrow(
      ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'],
      [rstart('o', 'b1'), rend('oe', 'b6', 'o', 2), rstart('i', 'b2'), rend('ie', 'b4', 'i', 2)],
    );
    expect(runToIds(c)).toEqual([
      'b1', 'b2', 'b3', 'b4', 'b2', 'b3', 'b4', 'b5', 'b6',
      'b1', 'b2', 'b3', 'b4', 'b2', 'b3', 'b4', 'b5', 'b6',
    ]);
  });

  it('D.C. al Fine returns to the top and stops at Fine', () => {
    const c = compileOrThrow(['b1', 'b2', 'b3', 'b4'], [fine('fn', 'b2'), jump('jp', 'b4', 'capo', 'fine')]);
    expect(runToIds(c)).toEqual(['b1', 'b2', 'b3', 'b4', 'b1', 'b2']);
  });

  it('D.S. al Coda jumps to the segno then diverts at To Coda', () => {
    // b1 b2[segno] b3[toCoda] b4[D.S. al coda] b5[coda]
    const c = compileOrThrow(
      ['b1', 'b2', 'b3', 'b4', 'b5'],
      [segno('sg', 'b2'), toCoda('tc', 'b3'), coda('cd', 'b5'), jump('jp', 'b4', 'segno', 'coda')],
    );
    expect(runToIds(c)).toEqual(['b1', 'b2', 'b3', 'b4', 'b2', 'b3', 'b5']);
  });

  it('compile reports structural errors (D.S. without a Segno)', () => {
    const c = compileRoadmap([{ id: 'b1' }], [jump('jp', 'b1', 'segno', 'end')]);
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.error.reason).toMatch(/D\.S\. has no Segno/);
  });
});

// ── Delegation: resolveRoadmap is the batch runner over the core ─────────────
describe('roadmap-vm — resolveRoadmap delegates to the core', () => {
  const fixtures: [string, string[], RoadmapMarker[]][] = [
    ['linear', ['b1', 'b2', 'b3'], []],
    ['plain repeat', ['b1', 'b2', 'b3', 'b4'], [rstart('rs', 'b1'), rend('re', 'b4', 'rs', 2)]],
    ['voltas', ['b1', 'b2', 'b3', 'b4'], [rstart('rs', 'b1'), ending('e1', 'rs', ['b3'], [1]), ending('e2', 'rs', ['b4'], [2])]],
  ];
  for (const [name, ids, markers] of fixtures) {
    it(`${name}: resolveRoadmap == stepped core`, () => {
      const res = resolveRoadmap(cal(ids, markers));
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.traversal.map((t) => t.barId)).toEqual(runToIds(compileOrThrow(ids, markers)));
    });
  }

  it('pass numbers increment per bar entry', () => {
    const res = resolveRoadmap(cal(['b1', 'b2'], [rstart('rs', 'b1'), rend('re', 'b2', 'rs', 2)]));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.traversal).toEqual([
      { barId: 'b1', pass: 1 }, { barId: 'b2', pass: 1 },
      { barId: 'b1', pass: 2 }, { barId: 'b2', pass: 2 },
    ]);
  });
});

// ── §3.3 "another round" — clamp to times-1 = exactly one more pass ──────────
describe('roadmap-vm — "another round" clamp (§3.3)', () => {
  it('plain 2x: one extra full pass, then exits naturally', () => {
    const c = compileOrThrow(['b1', 'b2', 'b3', 'b4'], [rstart('rs', 'b1'), rend('re', 'b4', 'rs', 2)]);
    const { state } = runCollect(c, initVM(c)); // run to completion
    expect(state.done).toBe(true);
    const after = runCollect(c, override(c, state, { kind: 'anotherRound', repeatStartId: 'rs' }));
    expect(after.ids).toEqual(['b1', 'b2', 'b3', 'b4']); // exactly one more pass
    expect(after.state.done).toBe(true);
  });

  it('plain 3x: still exactly one more pass (clamp generalizes)', () => {
    const c = compileOrThrow(['b1', 'b2', 'b3'], [rstart('rs', 'b1'), rend('re', 'b3', 'rs', 3)]);
    const { state } = runCollect(c, initVM(c));
    const after = runCollect(c, override(c, state, { kind: 'anotherRound', repeatStartId: 'rs' }));
    expect(after.ids).toEqual(['b1', 'b2', 'b3']);
  });

  it('non-contiguous voltas: the extra pass takes the FINAL ending', () => {
    // e1=[1] on b3, e2=[2,3] on b4 → times=3.
    const c = compileOrThrow(
      ['b1', 'b2', 'b3', 'b4'],
      [rstart('rs', 'b1'), ending('e1', 'rs', ['b3'], [1]), ending('e2', 'rs', ['b4'], [2, 3])],
    );
    const { state } = runCollect(c, initVM(c));
    const after = runCollect(c, override(c, state, { kind: 'anotherRound', repeatStartId: 'rs' }));
    expect(after.ids).toEqual(['b1', 'b2', 'b4']); // body + final ending (e2)
  });

  it('nested: re-entering the OUTER resets the inner (descendant nested-reset)', () => {
    const c = compileOrThrow(
      ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'],
      [rstart('o', 'b1'), rend('oe', 'b6', 'o', 2), rstart('i', 'b2'), rend('ie', 'b4', 'i', 2)],
    );
    const { state } = runCollect(c, initVM(c));
    const after = runCollect(c, override(c, state, { kind: 'anotherRound', repeatStartId: 'o' }));
    // inner played TWICE in the extra outer pass ⇒ its counter was reset.
    expect(after.ids).toEqual(['b1', 'b2', 'b3', 'b4', 'b2', 'b3', 'b4', 'b5', 'b6']);
  });

  it('an unknown repeat target is a no-op', () => {
    const c = compileOrThrow(['b1', 'b2'], [rstart('rs', 'b1'), rend('re', 'b2', 'rs', 2)]);
    const init = initVM(c);
    expect(override(c, init, { kind: 'anotherRound', repeatStartId: 'nope' })).toEqual(init);
  });
});

// ── §3.4 continuation / exit semantics (the four cases) ──────────────────────
describe('roadmap-vm — §3.4 exit semantics', () => {
  it('jump INTO an outer repeat: the outer repeatEnd still fires (counter untouched)', () => {
    const c = compileOrThrow(['b1', 'b2', 'b3', 'b4'], [rstart('rs', 'b1'), rend('re', 'b4', 'rs', 2)]);
    const after = runCollect(c, override(c, initVM(c), { kind: 'jumpTo', barId: 'b3' }));
    // lands at b3, walks to the repeatEnd which loops back (op 0→1<2), then exits.
    expect(after.ids).toEqual(['b3', 'b4', 'b1', 'b2', 'b3', 'b4']);
  });

  it('jump into a volta body: the ending taken is fixed by the counter', () => {
    const c = compileOrThrow(
      ['b1', 'b2', 'b3', 'b4'],
      [rstart('rs', 'b1'), ending('e1', 'rs', ['b3'], [1]), ending('e2', 'rs', ['b4'], [2])],
    );
    // Drive one pass so completedPasses[rs] = 1, then jump to the top.
    const { state } = stepN(c, initVM(c), 3); // b1, b2, b3(e1) → exit increments to 1, backjumps
    expect(state.completedPasses['rs']).toBe(1);
    const after = runCollect(c, override(c, state, { kind: 'jumpTo', barId: 'b1' }));
    expect(after.ids).toEqual(['b1', 'b2', 'b4']); // k=2 ⇒ final ending e2
  });

  it('vamp hold loops body-only; release takes the final ending', () => {
    const c = compileOrThrow(
      ['b1', 'b2', 'b3', 'b4'],
      [rstart('rs', 'b1'), ending('e1', 'rs', ['b3'], [1]), ending('e2', 'rs', ['b4'], [2])],
    );
    const held = stepN(c, override(c, initVM(c), { kind: 'hold', repeatStartId: 'rs' }), 6);
    // Under hold it loops the BODY ONLY (stays before the endings), never an ending.
    expect(held.ids).toEqual(['b1', 'b2', 'b1', 'b2', 'b1', 'b2']);
    expect(held.state.completedPasses['rs']).toBe(0); // exit-increment suppressed
    const released = runCollect(c, override(c, held.state, { kind: 'release', repeatStartId: 'rs' }));
    expect(released.ids).toEqual(['b4']); // release clamps to times-1 ⇒ final ending next
    expect(released.state.done).toBe(true);
  });

  it('plain-repeat vamp loops the whole body; release takes the natural exit', () => {
    const c = compileOrThrow(['b1', 'b2', 'b3'], [rstart('rs', 'b1'), rend('re', 'b3', 'rs', 2)]);
    const held = stepN(c, override(c, initVM(c), { kind: 'hold', repeatStartId: 'rs' }), 6);
    // No ending group ⇒ the whole body (b1..b3) loops; the repeatEnd never increments.
    expect(held.ids).toEqual(['b1', 'b2', 'b3', 'b1', 'b2', 'b3']);
    expect(held.state.completedPasses['rs']).toBe(0);
    const released = runCollect(c, override(c, held.state, { kind: 'release', repeatStartId: 'rs' }));
    expect(released.ids).toEqual(['b1', 'b2', 'b3']); // one final pass then exits
    expect(released.state.done).toBe(true);
  });

  it('release on a repeat that is not held is a no-op', () => {
    const c = compileOrThrow(['b1', 'b2', 'b3'], [rstart('rs', 'b1'), rend('re', 'b3', 'rs', 2)]);
    const s0 = initVM(c);
    expect(override(c, s0, { kind: 'release', repeatStartId: 'rs' })).toEqual(s0);
  });

  it('jump to a non-adjacent section: continue forward from the target', () => {
    const c = compileOrThrow(['b1', 'b2', 'b3', 'b4', 'b5'], []);
    const after = runCollect(c, override(c, initVM(c), { kind: 'jumpTo', barId: 'b4' }));
    expect(after.ids).toEqual(['b4', 'b5']); // never the origin's fall-through
  });
});

// ── Already-fired D.S./D.C. stays inert on redirect (Codex R3 nuance) ────────
describe('roadmap-vm — a redirect before an already-fired jump is inert', () => {
  it('does not re-fire a jump that already fired', () => {
    const c = compileOrThrow(['b1', 'b2', 'b3', 'b4'], [fine('fn', 'b2'), jump('jp', 'b4', 'capo', 'fine')]);
    const { state } = stepN(c, initVM(c), 4); // b1..b4 → the D.C. fires
    expect(state.fired['jp']).toBe(true);
    const after = runCollect(c, override(c, state, { kind: 'jumpTo', barId: 'b3' }));
    expect(after.ids).toEqual(['b3', 'b4']); // reaches b4, jump inert ⇒ no second return
  });

  it('resetJump re-arms it so a redirect can re-fire', () => {
    const c = compileOrThrow(['b1', 'b2', 'b3', 'b4'], [fine('fn', 'b2'), jump('jp', 'b4', 'capo', 'fine')]);
    const { state } = stepN(c, initVM(c), 4);
    const reset = override(c, state, { kind: 'resetJump', jumpId: 'jp' });
    expect(reset.fired['jp']).toBe(false);
    const after = runCollect(c, override(c, reset, { kind: 'jumpTo', barId: 'b3' }));
    expect(after.ids).toEqual(['b3', 'b4', 'b1', 'b2']); // fires again → top → Fine
  });
});

// ── jumpTo exit policy arms al-Coda ──────────────────────────────────────────
describe('roadmap-vm — jumpTo exit policy', () => {
  it('exit:alCoda arms the To Coda divert en route', () => {
    // b1 b2[toCoda] b3 b4[coda]
    const c = compileOrThrow(['b1', 'b2', 'b3', 'b4'], [toCoda('tc', 'b2'), coda('cd', 'b4')]);
    // Without arming, To Coda is inert (needs an al-Coda jump to arm it).
    expect(runToIds(c)).toEqual(['b1', 'b2', 'b3', 'b4']);
    const after = runCollect(c, override(c, initVM(c), { kind: 'jumpTo', barId: 'b1', exit: { kind: 'alCoda' } }));
    expect(after.ids).toEqual(['b1', 'b2', 'b4']); // diverts at To Coda → Coda
  });

  it('a second al-Coda redirect re-takes To Coda after a prior coda fire', () => {
    const c = compileOrThrow(['b1', 'b2', 'b3', 'b4'], [toCoda('tc', 'b2'), coda('cd', 'b4')]);
    const { state } = runCollect(c, override(c, initVM(c), { kind: 'jumpTo', barId: 'b1', exit: { kind: 'alCoda' } }));
    expect(state.flags.toCodaFired).toBe(true);
    // arming again clears the prior fire so the divert takes a second time.
    const again = runCollect(c, override(c, state, { kind: 'jumpTo', barId: 'b1', exit: { kind: 'alCoda' } }));
    expect(again.ids).toEqual(['b1', 'b2', 'b4']);
  });

  it('an explicit exit WINS: al-Coda clears a stale al-Fine (does not stop at Fine)', () => {
    // b1 b2[fine] b3[toCoda] b4[coda] — Fine precedes To Coda.
    const c = compileOrThrow(['b1', 'b2', 'b3', 'b4'], [fine('fn', 'b2'), toCoda('tc', 'b3'), coda('cd', 'b4')]);
    const stale = runCollect(c, override(c, initVM(c), { kind: 'jumpTo', barId: 'b1', exit: { kind: 'alFine' } }));
    expect(stale.ids).toEqual(['b1', 'b2']); // stale run stops at Fine, arming alFineActive
    expect(stale.state.flags.alFineActive).toBe(true);
    // explicit al-Coda must disarm the stale al-Fine, run past Fine, divert at To Coda.
    const after = runCollect(c, override(c, stale.state, { kind: 'jumpTo', barId: 'b1', exit: { kind: 'alCoda' } }));
    expect(after.ids).toEqual(['b1', 'b2', 'b3', 'b4']);
  });

  it('exit modes are mutually exclusive at the flag level (each disarms the other)', () => {
    const c = compileOrThrow(['b1', 'b2', 'b3', 'b4'], [fine('fn', 'b2'), toCoda('tc', 'b3'), coda('cd', 'b4')]);
    const a1 = override(c, initVM(c), { kind: 'jumpTo', barId: 'b1', exit: { kind: 'alFine' } });
    const a2 = override(c, a1, { kind: 'jumpTo', barId: 'b1', exit: { kind: 'alCoda' } });
    expect(a2.flags.alCodaArmed).toBe(true);
    expect(a2.flags.alFineActive).toBe(false);
    const b1 = override(c, initVM(c), { kind: 'jumpTo', barId: 'b1', exit: { kind: 'alCoda' } });
    const b2 = override(c, b1, { kind: 'jumpTo', barId: 'b1', exit: { kind: 'alFine' } });
    expect(b2.flags.alFineActive).toBe(true);
    expect(b2.flags.alCodaArmed).toBe(false);
  });
});

// ── insert-and-return (pendingReturn) ────────────────────────────────────────
describe('roadmap-vm — insert-and-return', () => {
  it('plays the inserted block once then returns at afterPos (linear)', () => {
    const c = compileOrThrow(['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8'], []);
    // Jump back to b3 (pos2); after emitting b4 (pos3) return to b7 (pos6).
    const after = runCollect(
      c,
      override(c, initVM(c), { kind: 'jumpTo', barId: 'b3', return: { afterPos: 3, returnBarId: 'b7' } }),
    );
    expect(after.ids).toEqual(['b3', 'b4', 'b7', 'b8']);
    expect(after.state.pendingReturn).toBeNull(); // consumed
  });

  it('an internal repeat inside the inserted span loops BEFORE the return fires', () => {
    // b2..b4 is a 2x repeat; return is armed after b4 (pos3). The back-jump end-edge
    // must win each pass (handled) — the return only fires on the clean forward exit.
    const c = compileOrThrow(
      ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'],
      [rstart('rs', 'b2'), rend('re', 'b4', 'rs', 2)],
    );
    const after = runCollect(
      c,
      override(c, initVM(c), { kind: 'jumpTo', barId: 'b2', return: { afterPos: 3, returnBarId: 'b6' } }),
    );
    expect(after.ids).toEqual(['b2', 'b3', 'b4', 'b2', 'b3', 'b4', 'b6']);
  });

  it('a notated To Coda at afterPos stays authoritative (defers the return)', () => {
    // b3 carries a To Coda; with al-Coda armed, the divert (handled) wins over the
    // pending return that happens to share that bar's position.
    const c = compileOrThrow(
      ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'],
      [toCoda('tc', 'b3'), coda('cd', 'b5')],
    );
    const crafted: VMState = {
      ...initVM(c),
      cursor: 2, // at b3 (the To Coda bar)
      flags: { toCodaFired: false, alFineActive: false, alCodaArmed: true },
      pendingReturn: { afterPos: 2, returnPos: 5 },
    };
    const r = stepVM(c, crafted);
    expect(r.transition?.barId).toBe('b3');
    expect(r.state.cursor).toBe(4); // diverted to the Coda (b5), NOT the return target
    expect(r.state.pendingReturn).toEqual({ afterPos: 2, returnPos: 5 }); // untouched (deferred)
  });

  it('installs a fresh pendingReturn only on a GENUINE backward jumpTo', () => {
    const c = compileOrThrow(['b1', 'b2', 'b3', 'b4'], []);
    const s = override(c, { ...initVM(c), cursor: 3 }, {
      kind: 'jumpTo', barId: 'b1', return: { afterPos: 0, returnBarId: 'b3' },
    });
    expect(s.pendingReturn).toEqual({ afterPos: 0, returnPos: 2 });
  });

  it('a no-op jumpTo (unknown barId) with a valid return installs nothing and preserves prior', () => {
    const c = compileOrThrow(['b1', 'b2', 'b3', 'b4'], []);
    const prior: VMState = { ...initVM(c), cursor: 1, pendingReturn: { afterPos: 0, returnPos: 3 } };
    const s = override(c, prior, { kind: 'jumpTo', barId: 'nope', return: { afterPos: 0, returnBarId: 'b4' } });
    expect(s.pendingReturn).toEqual({ afterPos: 0, returnPos: 3 }); // untouched (sameNav ⇒ block skipped)
  });

  it('a same-cursor jumpTo with a return is a no-op and installs nothing', () => {
    const c = compileOrThrow(['b1', 'b2', 'b3', 'b4'], []);
    const s = override(c, { ...initVM(c), cursor: 2 }, {
      kind: 'jumpTo', barId: 'b3', return: { afterPos: 2, returnBarId: 'b4' },
    });
    expect(s.pendingReturn).toBeNull();
  });

  it('a genuine override CLEARS a prior pendingReturn', () => {
    const c = compileOrThrow(['b1', 'b2', 'b3', 'b4'], []);
    const prior: VMState = { ...initVM(c), cursor: 0, pendingReturn: { afterPos: 1, returnPos: 3 } };
    const s = override(c, prior, { kind: 'jumpTo', barId: 'b3' }); // genuine, no return
    expect(s.pendingReturn).toBeNull();
  });

  it('exit XOR return: a jumpTo carrying BOTH never installs a return (exit wins)', () => {
    const c = compileOrThrow(['b1', 'b2', 'b3', 'b4'], [toCoda('tc', 'b2'), coda('cd', 'b4')]);
    const s = override(c, { ...initVM(c), cursor: 3 }, {
      kind: 'jumpTo', barId: 'b1', exit: { kind: 'alCoda' }, return: { afterPos: 0, returnBarId: 'b3' },
    });
    expect(s.pendingReturn).toBeNull();
    expect(s.flags.alCodaArmed).toBe(true);
  });
});

// ── hold guards unknown targets (parity with anotherRound) ───────────────────
describe('roadmap-vm — hold on an unknown repeat is a no-op', () => {
  it('does not park a vamp on a non-existent repeat id', () => {
    const c = compileOrThrow(['b1', 'b2'], [rstart('rs', 'b1'), rend('re', 'b2', 'rs', 2)]);
    const s0 = initVM(c);
    expect(override(c, s0, { kind: 'hold', repeatStartId: 'nope' })).toEqual(s0);
  });
});

// ── purity ───────────────────────────────────────────────────────────────────
describe('roadmap-vm — purity', () => {
  it('stepVM does not mutate the input state', () => {
    const c = compileOrThrow(['b1', 'b2', 'b3', 'b4'], [rstart('rs', 'b1'), rend('re', 'b4', 'rs', 2)]);
    const s0 = initVM(c);
    const snapshot = JSON.stringify(s0);
    stepVM(c, s0);
    expect(JSON.stringify(s0)).toBe(snapshot);
  });

  it('applyOverride does not mutate the input state', () => {
    const c = compileOrThrow(['b1', 'b2', 'b3', 'b4'], [rstart('rs', 'b1'), rend('re', 'b4', 'rs', 2)]);
    const s0 = initVM(c);
    const snapshot = JSON.stringify(s0);
    applyOverride(c, s0, { kind: 'anotherRound', repeatStartId: 'rs' });
    expect(JSON.stringify(s0)).toBe(snapshot);
  });
});
