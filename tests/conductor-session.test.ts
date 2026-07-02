import { describe, it, expect } from 'vitest';
import { initSession, dispatch, acceptBaton, shouldAutoFire } from '../lib/conductor-session';
import { reduceConductor, type ConductorMessage } from '../lib/conductor-state';
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

// ── acceptBaton (3b chunk 2: mint the new baton generation) ──────────────────
describe('acceptBaton', () => {
  // A device that has been mirroring: some real position, a pending armed cue,
  // live clock — the state a claimer actually holds when the old MD dies.
  function midSongSession() {
    let s = freshSession(linear4(), 0);
    s = dispatch(s, { kind: 'advance' }, 10).session; // current = b1
    s = dispatch(s, { kind: 'advance' }, 20).session; // current = b2
    s = dispatch(s, { kind: 'arm', armed: { fireAt: 'b3', directive: { kind: 'jumpTo', barId: 'b4' } } }, 30).session;
    s = dispatch(s, { kind: 'clock', clock: { tempoBpm: 120, confidence: 0.9 } }, 40).session;
    return s;
  }

  it('mints the new generation: epoch := granted, seq := 0, armed cleared, updatedAt = now; OWN vm/current/clock carried verbatim', () => {
    const before = midSongSession();
    const { session: after } = acceptBaton(before, 5, 100);
    expect(after.state.epoch).toBe(5);
    expect(after.state.seq).toBe(0);
    expect(after.state.armed).toBeNull(); // the old MD's cue is never inherited
    expect(after.state.updatedAt).toBe(100);
    // own authority carries forward
    expect(after.state.vm).toEqual(before.state.vm);
    expect(after.state.current).toEqual(before.state.current);
    expect(after.state.clock).toEqual({ tempoBpm: 120, confidence: 0.9 });
    // identity + program pin untouched
    expect(after.state.sessionId).toBe(before.state.sessionId);
    expect(after.state.songRef).toBe(before.state.songRef);
    expect(after.state.programHash).toBe(before.state.programHash);
    expect(after.compiled).toBe(before.compiled);
    expect(after.programHash).toBe(before.programHash);
    // pure: input untouched
    expect(before.state.epoch).toBe(0);
    expect(before.state.armed).not.toBeNull();
  });

  it('returns the claim broadcast: full session key, (grantedEpoch, seq 0), sentAt = now, payload claim', () => {
    const { session, claim } = acceptBaton(midSongSession(), 5, 100);
    expect(claim).toEqual({
      sessionId: session.state.sessionId,
      songRef: session.state.songRef,
      programHash: session.state.programHash,
      epoch: 5,
      seq: 0,
      sentAt: 100,
      payload: { kind: 'claim' },
    });
  });

  it('the claim consumes no seq: the first post-accept dispatch mints (grantedEpoch, seq 1)', () => {
    const { session } = acceptBaton(midSongSession(), 5, 100);
    const r = dispatch(session, { kind: 'advance' }, 110);
    expect(r.outcome).toBe('applied');
    expect(r.session.state.epoch).toBe(5);
    expect(r.session.state.seq).toBe(1);
  });

  it('follower on the old epoch converges: claim → needsSnapshot → adopt snapshot → next delta applies contiguously', () => {
    // Two mirrors of the same generation; the old MD dies; B claims at epoch+1.
    const compiled = linear4();
    const follower = midSongSession();
    const { session: md, claim } = acceptBaton(midSongSession(), 1, 100);

    // 1. claim broadcast → the shipped snapshot boundary
    const r1 = reduceConductor(compiled, PH, follower.state, claim);
    expect(r1.status).toBe('needsSnapshot');
    expect(r1.state).toBe(follower.state); // unchanged until the pull lands

    // 2. adopt the new MD's snapshot (what acceptBaton uploaded to the relay)
    const mirrored = md.state;

    // 3. the new MD's first delta is contiguous from the snapshot → applied
    const r2 = dispatch(md, { kind: 'advance' }, 110); // mints (epoch 1, seq 1)
    const delta: ConductorMessage = {
      sessionId: mirrored.sessionId,
      songRef: mirrored.songRef,
      programHash: mirrored.programHash,
      epoch: 1,
      seq: 1,
      sentAt: 110,
      payload: { kind: 'advance' },
    };
    const r3 = reduceConductor(compiled, PH, mirrored, delta);
    expect(r3.status).toBe('applied');
    if (r3.status !== 'applied') throw new Error('unreachable');
    expect(r3.state).toEqual(r2.session.state); // full convergence
  });

  it('equal/lower-epoch claim is ignored by a mirror (replay no-op)', () => {
    const compiled = linear4();
    const mirror = midSongSession(); // epoch 0
    const { session: promoted, claim: claim1 } = acceptBaton(midSongSession(), 1, 100);
    // equal epoch: the new MD's own mirror path sees its claim echo — ignored
    expect(reduceConductor(compiled, PH, promoted.state, claim1).status).toBe('ignored');
    // lower epoch: a stale replayed claim against an already-advanced mirror
    const advanced = acceptBaton(mirror, 2, 200).session;
    expect(reduceConductor(compiled, PH, advanced.state, claim1).status).toBe('ignored');
  });

  it('cross-session claim is ignored at the scope gate — never needsSnapshot (Codex R1 MED-1: the session frame moves that follower, not the claim)', () => {
    const compiled = linear4();
    const otherShow = initSession('s2', 'song1', PH, compiled, 0); // different sessionId
    const { claim } = acceptBaton(freshSession(), 7, 100); // claim for s1
    const r = reduceConductor(compiled, PH, otherShow.state, claim);
    expect(r.status).toBe('ignored');
    expect(r.state).toBe(otherShow.state);
  });
});

// ── shouldAutoFire (chunk-5 §3.5 gate) ───────────────────────────────────────
const repeatCal = () =>
  compileOrThrow(['b1', 'b2', 'b3', 'b4'], [
    { id: 'R', kind: 'repeatStart', barId: 'b1', edge: 'start' },
    { id: 'E1', kind: 'ending', repeatStartId: 'R', barIds: ['b3'], numbers: [1] },
    { id: 'E2', kind: 'ending', repeatStartId: 'R', barIds: ['b4'], numbers: [2] },
  ]);

describe('shouldAutoFire', () => {
  it('nothing armed → false', () => {
    let s = freshSession();
    s = dispatch(s, { kind: 'advance' }, 1).session; // current = b1, but no armed
    expect(shouldAutoFire(s)).toBe(false);
  });

  it('no current (fresh session) → false even when armed', () => {
    const s = dispatch(
      freshSession(),
      { kind: 'arm', armed: { fireAt: 'b1', directive: { kind: 'jumpTo', barId: 'b3' } } },
      1,
    ).session;
    expect(s.state.current).toBeNull();
    expect(shouldAutoFire(s)).toBe(false);
  });

  it('armed but current.barId !== fireAt (before arrival) → false', () => {
    let s = freshSession();
    s = dispatch(s, { kind: 'advance' }, 1).session; // current = b1
    s = dispatch(s, { kind: 'arm', armed: { fireAt: 'b2', directive: { kind: 'jumpTo', barId: 'b4' } } }, 2).session;
    expect(shouldAutoFire(s)).toBe(false);
  });

  it('armed, current.barId === fireAt, holding == null → true', () => {
    let s = freshSession();
    s = dispatch(s, { kind: 'advance' }, 1).session; // current = b1
    s = dispatch(s, { kind: 'arm', armed: { fireAt: 'b1', directive: { kind: 'jumpTo', barId: 'b3' } } }, 2).session;
    expect(shouldAutoFire(s)).toBe(true);
  });

  it('armed, at fireAt, but holding != null (vamping) → false (§3.5 hold guard)', () => {
    let s = freshSession(repeatCal());
    s = dispatch(s, { kind: 'advance' }, 1).session; // current = b1 (the repeat start)
    s = dispatch(s, { kind: 'arm', armed: { fireAt: 'b1', directive: { kind: 'jumpTo', barId: 'b3' } } }, 2).session;
    s = dispatch(s, { kind: 'redirect', directive: { kind: 'hold', repeatStartId: 'R' } }, 3).session;
    expect(s.state.vm.holding).toBe('R');
    expect(shouldAutoFire(s)).toBe(false); // refuses even at the fire bar
    // release clears the vamp → the same armed marker now fires
    s = dispatch(s, { kind: 'redirect', directive: { kind: 'release', repeatStartId: 'R' } }, 4).session;
    expect(s.state.vm.holding).toBeNull();
    expect(shouldAutoFire(s)).toBe(true);
  });

  it('fires once: after a commit clears armed, a subsequent evaluation → false', () => {
    let s = freshSession();
    s = dispatch(s, { kind: 'advance' }, 1).session; // current = b1
    s = dispatch(s, { kind: 'arm', armed: { fireAt: 'b1', directive: { kind: 'jumpTo', barId: 'b3' } } }, 2).session;
    expect(shouldAutoFire(s)).toBe(true);
    s = dispatch(s, { kind: 'commit' }, 3).session; // clears armed
    expect(s.state.armed).toBeNull();
    expect(shouldAutoFire(s)).toBe(false);
  });
});

// ── dispatch chain invariant: auto-fire ≡ go-tap in outcome ───────────────────
describe('auto-fire ≡ go-tap (dispatch chain)', () => {
  it('advance-onto-fireAt then commit lands the committed jump with armed cleared', () => {
    // arm a jump that fires on arrival at b2; advance until current === fireAt, then
    // the auto-fire path commits exactly the go-tap commit (same end-state).
    let s = freshSession();
    s = dispatch(s, { kind: 'arm', armed: { fireAt: 'b2', directive: { kind: 'jumpTo', barId: 'b4' } } }, 1).session;
    s = dispatch(s, { kind: 'advance' }, 2).session; // b1
    s = dispatch(s, { kind: 'advance' }, 3).session; // b2 === fireAt
    expect(s.state.current?.barId).toBe('b2');
    expect(shouldAutoFire(s)).toBe(true); // the hook would commit here
    const afterFire = dispatch(s, { kind: 'commit' }, 4).session;
    expect(afterFire.state.armed).toBeNull();
    expect(afterFire.state.current?.barId).toBe('b4'); // committed jump cursor
  });
});
