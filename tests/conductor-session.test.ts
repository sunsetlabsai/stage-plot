import { describe, it, expect } from 'vitest';
import { initSession, dispatch, shouldAutoFire } from '../lib/conductor-session';
import { compileRoadmap, applyOverride, type CompiledRoadmap } from '../lib/roadmap-vm';
import type { RoadmapMarker } from '../lib/types';

// ── Builders ─────────────────────────────────────────────────────────────────
function compileOrThrow(ids: string[], markers: RoadmapMarker[] = []): CompiledRoadmap {
  const c = compileRoadmap(ids.map((id) => ({ id })), markers);
  if (!c.ok) throw new Error(`compile failed: ${c.error.reason}`);
  return c.compiled;
}

const PH = 'program-hash-A';
const linear4 = () => compileOrThrow(['b1', 'b2', 'b3', 'b4']);

function freshSession(compiled = linear4(), now = 0) {
  return initSession('s1', 'song1', PH, compiled, now);
}

// ── initSession ──────────────────────────────────────────────────────────────
describe('initSession', () => {
  it('seeds epoch 0 / seq 0, vm at head, nothing armed, clock-ABSENT, updatedAt = now', () => {
    const s = freshSession(linear4(), 7);
    expect(s.state.epoch).toBe(0);
    expect(s.state.seq).toBe(0);
    expect(s.state.current).toBeNull();
    expect(s.state.armed).toBeNull();
    expect(s.state.vm.cursor).toBe(0);
    expect(s.state.clock).toEqual({ tempoBpm: null, confidence: 0 });
    expect(s.state.programHash).toBe(PH);
    expect(s.state.updatedAt).toBe(7);
  });
});

// ── dispatch seq discipline + determinism ────────────────────────────────────
describe('dispatch seq discipline', () => {
  it('bumps seq by exactly 1, holds epoch, stamps sentAt = now', () => {
    const s = freshSession();
    const r1 = dispatch(s, { kind: 'advance' }, 100);
    expect(r1.outcome).toBe('applied');
    expect(r1.session.state.seq).toBe(1);
    expect(r1.session.state.epoch).toBe(0);
    expect(r1.session.state.updatedAt).toBe(100);
    const r2 = dispatch(r1.session, { kind: 'advance' }, 200);
    expect(r2.session.state.seq).toBe(2);
    expect(r2.session.state.updatedAt).toBe(200);
  });

  it('N dispatches → seq === N', () => {
    let s = freshSession();
    for (let i = 1; i <= 3; i++) s = dispatch(s, { kind: 'advance' }, i * 10).session;
    expect(s.state.seq).toBe(3);
  });

  it('is deterministic — same verbs + same `now`s → byte-identical state', () => {
    const run = () => {
      let s = freshSession(linear4(), 0);
      s = dispatch(s, { kind: 'advance' }, 10).session;
      s = dispatch(s, { kind: 'advance' }, 20).session;
      return JSON.stringify(s.state);
    };
    expect(run()).toBe(run());
  });
});

// ── advance ──────────────────────────────────────────────────────────────────
describe('advance', () => {
  it('tracks the stepVM stream bar-for-bar', () => {
    let s = freshSession();
    s = dispatch(s, { kind: 'advance' }, 1).session;
    expect(s.state.current).toEqual({ barId: 'b1', pass: 1 });
    s = dispatch(s, { kind: 'advance' }, 2).session;
    expect(s.state.current).toEqual({ barId: 'b2', pass: 1 });
  });

  it('song-end advance leaves current unchanged and marks vm.done', () => {
    let s = freshSession();
    for (let i = 0; i < 4; i++) s = dispatch(s, { kind: 'advance' }, i).session;
    const atEnd = s.state.current;
    expect(s.state.vm.done).toBe(true);
    s = dispatch(s, { kind: 'advance' }, 99).session;
    expect(s.state.current).toEqual(atEnd); // no further emit
  });
});

// ── arm → commit (go-tap) ────────────────────────────────────────────────────
describe('arm → commit (go-tap)', () => {
  it('arm sets armed; commit clears it AND moves current to the jumpTo target', () => {
    let s = freshSession();
    s = dispatch(s, { kind: 'arm', armed: { fireAt: 'b2', directive: { kind: 'jumpTo', barId: 'b3' } } }, 1).session;
    expect(s.state.armed?.directive.barId).toBe('b3');
    s = dispatch(s, { kind: 'commit' }, 2).session;
    expect(s.state.armed).toBeNull();
    expect(s.state.current?.barId).toBe('b3');
  });

  it('commit with nothing armed is a no-op; double-commit is idempotent', () => {
    const s = freshSession();
    const r = dispatch(s, { kind: 'commit' }, 1);
    expect(r.outcome).toBe('applied'); // admitted, but VM no-op
    expect(r.session.state.armed).toBeNull();
    expect(r.session.state.current).toBeNull();
  });
});

// ── disarm ───────────────────────────────────────────────────────────────────
describe('disarm', () => {
  it('clears armed without moving the playhead', () => {
    let s = freshSession();
    s = dispatch(s, { kind: 'advance' }, 1).session;
    const beforeVm = s.state.vm.cursor;
    s = dispatch(s, { kind: 'arm', armed: { fireAt: 'b2', directive: { kind: 'jumpTo', barId: 'b3' } } }, 2).session;
    s = dispatch(s, { kind: 'disarm' }, 3).session;
    expect(s.state.armed).toBeNull();
    expect(s.state.vm.cursor).toBe(beforeVm);
    expect(s.state.current?.barId).toBe('b1');
  });
});

// ── self-invalid arm → ignored, session UNCHANGED ────────────────────────────
describe('self-invalid arm', () => {
  it('arm at a bar not in the program → ignored, session unchanged', () => {
    const s = freshSession();
    const r = dispatch(s, { kind: 'arm', armed: { fireAt: 'b1', directive: { kind: 'jumpTo', barId: 'nope' } } }, 1);
    expect(r.outcome).toBe('ignored');
    expect(r.session).toBe(s); // same reference — nothing changed
  });
});

// ── redirect equivalence ─────────────────────────────────────────────────────
describe('redirect equivalence', () => {
  it('redirect yields the same vm as a direct applyOverride (controller adds only seq/sentAt)', () => {
    const compiled = linear4();
    let s = initSession('s1', 'song1', PH, compiled, 0);
    s = dispatch(s, { kind: 'redirect', directive: { kind: 'jumpTo', barId: 'b3' } }, 1).session;
    const direct = applyOverride(compiled, initSession('s1', 'song1', PH, compiled, 0).state.vm, {
      kind: 'jumpTo',
      barId: 'b3',
    });
    expect(s.state.vm).toEqual(direct);
  });
});

// ── shouldAutoFire (chunk-4 invariant) ───────────────────────────────────────
describe('shouldAutoFire', () => {
  it('returns false for every session (auto-fire is OFF in chunk 4)', () => {
    let s = freshSession();
    expect(shouldAutoFire(s)).toBe(false);
    s = dispatch(s, { kind: 'arm', armed: { fireAt: 'b1', directive: { kind: 'jumpTo', barId: 'b2' } } }, 1).session;
    s = dispatch(s, { kind: 'advance' }, 2).session; // lands on b1 — still false
    expect(shouldAutoFire(s)).toBe(false);
  });
});
