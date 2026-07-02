import { describe, it, expect } from 'vitest';
import type { ConductorMessage, ConductorState } from '../lib/conductor-state';
import { type SessionKey } from '../lib/relay-protocol';
import {
  type BindingEffect,
  type BindingInput,
  type RelayBinding,
  initRelayBinding,
  reduceBinding,
  relayFacts,
  shouldAdoptSnapshot,
  stateSupersedes,
} from '../lib/relay-binding';

// ── Conductor 3b chunk 4: the pure binding orchestrator ───────────────────────
// (design-conductor-3b-discovery-failover.md §10-4). The localKey gates the conn
// machine cannot know: mirror/adopt only on this device's loaded chart, the
// chart-arrived-late force re-pull, claim gated on having a chart, the writer's
// §4.4 re-announce, the §4.1-3 grant sequence order, and the two-regime
// snapshot-adoption guard (`shouldAdoptSnapshot`: FRESH = live-writer authority
// force-adopts, STALE = forward-only ex-writer-rewind guard).
// The binding never touches ConductorState internals, so identity+coordinate
// stand-ins suffice (same trick as relay-protocol.test.ts) — envelope-complete
// so parseRelayFrame admits them on the raw-frame path.

const KEY_A: SessionKey = { sessionId: 'chart1::band/show', songRef: 'song-a', programHash: 'hash-a' };
const KEY_B: SessionKey = { sessionId: 'chart2::band/show', songRef: 'song-b', programHash: 'hash-b' };

function fakeState(key: SessionKey, epoch = 1, seq = 3): ConductorState {
  return { ...key, epoch, seq } as ConductorState;
}
function fakeMsg(key: SessionKey, epoch = 1, seq = 4): ConductorMessage {
  return { ...key, epoch, seq, sentAt: 0, payload: { kind: 'advance' } } as ConductorMessage;
}

/** Run a sequence of inputs, returning the final binding and ALL effects in order. */
function run(inputs: BindingInput[], from: RelayBinding = initRelayBinding()) {
  const effects: BindingEffect[] = [];
  let binding = from;
  for (const input of inputs) {
    const r = reduceBinding(binding, input);
    binding = r.binding;
    effects.push(...r.effects);
  }
  return { binding, effects };
}

// Raw wire frames (the binding parses; feed JSON-shaped objects, not typed frames).
const raw = (frame: unknown): BindingInput => ({ kind: 'raw-frame', raw: frame });
const joined = (activeSession: SessionKey | null, hasWriter = activeSession !== null) =>
  raw({ type: 'joined', epoch: 1, hasWriter, activeSession, writerLabel: null });

/** A follower on KEY_A with the chart loaded and the join-pull already answered. */
function followerOnA(): RelayBinding {
  return run([
    { kind: 'local-ready', key: KEY_A },
    joined(KEY_A),
    raw({ type: 'snapshot', state: fakeState(KEY_A), stale: false }),
    { kind: 'mirror-outcome', outcome: 'applied' },
  ]).binding;
}

/** A writer on KEY_A: chart loaded, joined, claimed, grant sequence completed. */
function writerOnA(epoch = 2): RelayBinding {
  const granted = run([
    { kind: 'local-ready', key: KEY_A },
    joined(null, false),
    { kind: 'request-claim' },
    raw({ type: 'claim-grant', epoch }),
  ]).binding;
  // The hook's acceptBaton feedback leg:
  return run(
    [{ kind: 'baton-accepted', key: KEY_A, state: fakeState(KEY_A, epoch, 0), claim: fakeMsg(KEY_A, epoch, 0) }],
    granted,
  ).binding;
}

const sends = (effects: BindingEffect[]) =>
  effects.filter((e): e is Extract<BindingEffect, { kind: 'send' }> => e.kind === 'send');

describe('the wire trust boundary (raw-frame, §6 rule 5)', () => {
  it.each([
    ['a string', 'joined'],
    ['null', null],
    ['unknown type', { type: 'bogus' }],
    ['fieldless joined', { type: 'joined' }],
    ['msg with a bad envelope', { type: 'msg', msg: { ...KEY_A, epoch: 1 } }],
  ])('drops %s as bad-frame — never reaches the conn machine', (_name, garbage) => {
    const before = followerOnA();
    const { binding, effects } = run([raw(garbage)], before);
    expect(effects).toEqual([{ kind: 'bad-frame' }]);
    expect(binding).toEqual(before); // dropped, not closed — the relay is our box
  });

  it('a well-formed frame flows through to the machine', () => {
    const { effects } = run([{ kind: 'local-ready', key: KEY_A }, joined(KEY_A)]);
    expect(effects.map((e) => e.kind)).toEqual(['switch-session', 'send']);
  });
});

describe('the localKey mirror gates', () => {
  it('an incoming msg on the active key mirrors when the local chart matches', () => {
    const { effects } = run([raw({ type: 'msg', msg: fakeMsg(KEY_A) })], followerOnA());
    expect(effects).toEqual([{ kind: 'apply-mirror', msg: fakeMsg(KEY_A) }]);
  });

  it('an incoming msg is DROPPED when no local chart is loaded (reduceConductor would throw)', () => {
    const { binding, effects } = run([joined(KEY_A), raw({ type: 'msg', msg: fakeMsg(KEY_A) })]);
    expect(effects.filter((e) => e.kind === 'apply-mirror')).toEqual([]);
    expect(relayFacts(binding).chartMismatch).toBe(true); // honesty, never a throw
  });

  it('an incoming msg is DROPPED when the local chart differs from the active session', () => {
    const { effects } = run(
      [{ kind: 'local-ready', key: KEY_B }, joined(KEY_A), raw({ type: 'msg', msg: fakeMsg(KEY_A) })],
    );
    expect(effects.filter((e) => e.kind === 'apply-mirror')).toEqual([]);
  });

  it('a snapshot for a key we did not load is dropped even though the pull matched it', () => {
    const { effects } = run([
      joined(KEY_A), // pull for A outstanding, but NO localKey yet
      raw({ type: 'snapshot', state: fakeState(KEY_A), stale: false }),
    ]);
    expect(effects.filter((e) => e.kind === 'adopt-snapshot')).toEqual([]);
  });

  it('a snapshot on the loaded key adopts (stale flag carried through)', () => {
    const { effects } = run([
      { kind: 'local-ready', key: KEY_A },
      joined(KEY_A),
      raw({ type: 'snapshot', state: fakeState(KEY_A), stale: true }),
    ]);
    expect(effects).toContainEqual({ kind: 'adopt-snapshot', state: fakeState(KEY_A), stale: true });
  });
});

describe('chart-arrived-late: local-ready force re-pull (the gated-adoption heal)', () => {
  it('local-ready ON the active key re-opens the consumed pull', () => {
    // Join without a chart: pull goes out, snapshot arrives, adoption is gated
    // away — the machine believes the pull is answered.
    const stuck = run([
      joined(KEY_A),
      raw({ type: 'snapshot', state: fakeState(KEY_A), stale: false }),
    ]).binding;
    expect(stuck.conn.awaitingSnapshot).toBeNull(); // the consumed pull
    // The chart finishes loading — the binding force-feeds needsSnapshot.
    const { binding, effects } = run([{ kind: 'local-ready', key: KEY_A }], stuck);
    expect(sends(effects).map((s) => s.frame)).toEqual([
      { type: 'snapshot-request', session: KEY_A },
    ]);
    expect(binding.conn.awaitingSnapshot).toEqual(KEY_A);
    // ...and the re-served snapshot now adopts.
    const healed = run([raw({ type: 'snapshot', state: fakeState(KEY_A), stale: false })], binding);
    expect(healed.effects).toContainEqual({
      kind: 'adopt-snapshot', state: fakeState(KEY_A), stale: false,
    });
  });

  it('local-ready on a DIFFERENT key from the active session sends nothing (mismatch fact instead)', () => {
    const base = run([joined(KEY_A)]).binding; // the join's own pull is out already
    const { binding, effects } = run([{ kind: 'local-ready', key: KEY_B }], base);
    expect(effects).toEqual([]);
    expect(relayFacts(binding).chartMismatch).toBe(true);
  });

  it('local-ready while a pull is STILL outstanding is a no-op re-pull (pull is idempotent per key)', () => {
    const { effects } = run([joined(KEY_A), { kind: 'local-ready', key: KEY_A }]);
    // ONE request total: the join's pull; the force-feed dedupes on the same key.
    expect(sends(effects).filter((s) => s.frame.type === 'snapshot-request')).toHaveLength(1);
  });

  it('local-gone clears the key: subsequent msgs stop mirroring', () => {
    const { effects } = run(
      [{ kind: 'local-gone' }, raw({ type: 'msg', msg: fakeMsg(KEY_A) })],
      followerOnA(),
    );
    expect(effects.filter((e) => e.kind === 'apply-mirror')).toEqual([]);
  });
});

describe('the writer fan-out seam (applied-msg)', () => {
  it('a writer broadcasts its applied msg verbatim', () => {
    const { effects } = run([{ kind: 'applied-msg', msg: fakeMsg(KEY_A, 2, 1) }], writerOnA());
    expect(effects).toEqual([
      { kind: 'send', frame: { type: 'msg', msg: fakeMsg(KEY_A, 2, 1) } },
    ]);
  });

  it('a follower NEVER broadcasts (defense in depth behind the hook gate)', () => {
    const { effects } = run([{ kind: 'applied-msg', msg: fakeMsg(KEY_A) }], followerOnA());
    expect(effects).toEqual([]);
  });
});

describe('claim + the §4.1-3 grant sequence', () => {
  it('request-claim without a loaded chart is a no-op (nothing to announce)', () => {
    const { effects } = run([joined(null, false), { kind: 'request-claim' }]);
    expect(effects).toEqual([]);
  });

  it('request-claim with a chart sends claim-request; grant emits accept-baton', () => {
    const { effects } = run([
      { kind: 'local-ready', key: KEY_A },
      joined(null, false),
      { kind: 'request-claim' },
      raw({ type: 'claim-grant', epoch: 3 }),
    ]);
    expect(effects).toEqual([
      { kind: 'send', frame: { type: 'claim-request' } },
      { kind: 'accept-baton', epoch: 3 },
    ]);
  });

  it('baton-accepted emits announce → snapshot upload → claim broadcast, IN ORDER (§4.1 step 3)', () => {
    const granted = run([
      { kind: 'local-ready', key: KEY_A },
      joined(null, false),
      raw({ type: 'claim-grant', epoch: 2 }),
    ]).binding;
    const state = fakeState(KEY_A, 2, 0);
    const claim = fakeMsg(KEY_A, 2, 0);
    const { binding, effects } = run([{ kind: 'baton-accepted', key: KEY_A, state, claim }], granted);
    expect(sends(effects).map((s) => s.frame)).toEqual([
      { type: 'session', session: KEY_A },
      { type: 'snapshot', state },
      { type: 'msg', msg: claim },
    ]);
    expect(binding.conn.activeSession).toEqual(KEY_A);
    expect(binding.localKey).toEqual(KEY_A);
  });

  it('baton-accepted after a demote race is dropped (stale feedback)', () => {
    // Grant, then not-writer lands BEFORE the hook's feedback arrives.
    const demoted = run([
      { kind: 'local-ready', key: KEY_A },
      joined(null, false),
      raw({ type: 'claim-grant', epoch: 2 }),
      raw({ type: 'not-writer', epoch: 3, activeSession: null }),
    ]).binding;
    const { effects } = run(
      [{ kind: 'baton-accepted', key: KEY_A, state: fakeState(KEY_A, 2, 0), claim: fakeMsg(KEY_A, 2, 0) }],
      demoted,
    );
    expect(effects).toEqual([]);
  });

  it('release-baton as the writer sends the frame and demotes locally', () => {
    const { binding, effects } = run([{ kind: 'release-baton' }], writerOnA());
    expect(effects).toEqual([{ kind: 'send', frame: { type: 'release-baton' } }]);
    expect(binding.conn.phase).toBe('follower');
  });
});

describe('writer duties: §4.4 re-announce, serve, heartbeat', () => {
  it('a writer whose local key changes re-announces the new session (chart switch / recompile)', () => {
    const { binding, effects } = run([{ kind: 'local-ready', key: KEY_B }], writerOnA());
    expect(effects).toEqual([{ kind: 'send', frame: { type: 'session', session: KEY_B } }]);
    expect(binding.conn.activeSession).toEqual(KEY_B);
    expect(binding.localKey).toEqual(KEY_B);
  });

  it('a writer local-ready on the SAME key announces nothing (idempotent)', () => {
    const { effects } = run([{ kind: 'local-ready', key: KEY_A }], writerOnA());
    expect(effects).toEqual([]);
  });

  it('snapshot-needed → serve-snapshot; serve-state feedback sends the reply with the requestId', () => {
    const w = writerOnA();
    const askEffects = run([raw({ type: 'snapshot-needed', session: KEY_A, requestId: 'r9' })], w);
    expect(askEffects.effects).toEqual([{ kind: 'serve-snapshot', requestId: 'r9' }]);
    const state = fakeState(KEY_A, 2, 7);
    const { effects } = run([{ kind: 'serve-state', requestId: 'r9', state }], askEffects.binding);
    expect(effects).toEqual([
      { kind: 'send', frame: { type: 'snapshot', requestId: 'r9', state } },
    ]);
  });

  it('serve-state after a demote race is dropped', () => {
    const { effects } = run([{ kind: 'serve-state', requestId: 'r9', state: fakeState(KEY_A) }], followerOnA());
    expect(effects).toEqual([]);
  });

  it('hb-tick sends hb only as the writer', () => {
    expect(run([{ kind: 'hb-tick' }], writerOnA()).effects).toEqual([
      { kind: 'send', frame: { type: 'hb' } },
    ]);
    expect(run([{ kind: 'hb-tick' }], followerOnA()).effects).toEqual([]);
    expect(run([{ kind: 'hb-tick' }]).effects).toEqual([]); // joining
  });
});

describe('demotion and room movement surface through', () => {
  it('not-writer as a believed-writer emits demoted + switch + pull', () => {
    const { effects } = run([raw({ type: 'not-writer', epoch: 4, activeSession: KEY_B })], writerOnA());
    expect(effects.map((e) => e.kind)).toEqual(['demoted', 'switch-session', 'send']);
  });

  it('a session switch broadcast surfaces switch-session and the mismatch fact until the chart loads', () => {
    const { binding, effects } = run([raw({ type: 'session', session: KEY_B })], followerOnA());
    expect(effects.map((e) => e.kind)).toEqual(['switch-session', 'send']); // pull for B
    expect(relayFacts(binding).chartMismatch).toBe(true); // localKey is still A
  });

  it('conductor-lost surfaces the orphan facts and opens the claim (chart loaded)', () => {
    const { binding } = run([raw({ type: 'conductor-lost' })], followerOnA());
    const facts = relayFacts(binding);
    expect(facts.conductorLost).toBe(true);
    expect(facts.canClaim).toBe(true);
  });

  it('conductor-lost with NO chart loaded keeps canClaim false (nothing to conduct)', () => {
    const { binding } = run([joined(KEY_A), raw({ type: 'conductor-lost' })]);
    const facts = relayFacts(binding);
    expect(facts.conductorLost).toBe(true);
    expect(facts.canClaim).toBe(false);
  });
});

describe('relayFacts', () => {
  it('initial: joining, nothing claimable, no mismatch', () => {
    expect(relayFacts(initRelayBinding())).toEqual({
      phase: 'joining',
      canClaim: false,
      conductorLost: false,
      conductorLabel: null,
      activeSession: null,
      chartMismatch: false,
      room: null,
    });
  });

  it('surfaces the relay-reported room off joined (D4: create-mode QR renders from this)', () => {
    const { binding } = run([
      raw({ type: 'joined', epoch: 1, hasWriter: false, activeSession: null, writerLabel: null, room: 'AB7XQ2', created: true }),
    ]);
    expect(relayFacts(binding).room).toBe('AB7XQ2');
  });

  it('chartMismatch is false when the local key matches the active session', () => {
    expect(relayFacts(followerOnA()).chartMismatch).toBe(false);
  });

  it('chartMismatch is false when NO session is active (nothing to mismatch)', () => {
    const { binding } = run([joined(null, false)]);
    expect(relayFacts(binding).chartMismatch).toBe(false);
  });
});

describe('stateSupersedes — forward-only coordinates (the STALE-regime comparator)', () => {
  it.each([
    ['higher epoch', { epoch: 3, seq: 0 }, { epoch: 2, seq: 9 }, true],
    ['same epoch, higher seq', { epoch: 2, seq: 5 }, { epoch: 2, seq: 4 }, true],
    ['equal coordinates', { epoch: 2, seq: 4 }, { epoch: 2, seq: 4 }, false],
    ['same epoch, lower seq', { epoch: 2, seq: 3 }, { epoch: 2, seq: 4 }, false],
    ['lower epoch, higher seq', { epoch: 1, seq: 99 }, { epoch: 2, seq: 0 }, false],
  ])('%s → %s', (_name, candidate, current, expected) => {
    expect(stateSupersedes(candidate, current)).toBe(expected);
  });
});

describe('shouldAdoptSnapshot — the two authority regimes (Codex chunk-4 R1 HIGH)', () => {
  // FRESH = authored by the LIVE writer answering this pull: THE authority.
  // Adopted unconditionally — including BACKWARD coordinates, which is the
  // fork-crush: an offline follower self-drove (allowed — the self-drive
  // floor), so its coords are on a fork, not on the writer's timeline.
  it.each([
    ['backward seq (the reconnected fork)', { epoch: 1, seq: 1 }, { epoch: 1, seq: 9 }],
    ['equal coordinates (divergent position possible)', { epoch: 1, seq: 3 }, { epoch: 1, seq: 3 }],
    ['backward epoch (fork crossed a claim it never heard)', { epoch: 1, seq: 2 }, { epoch: 2, seq: 0 }],
    ['forward (ordinary late join)', { epoch: 2, seq: 0 }, { epoch: 1, seq: 7 }],
  ])('FRESH adopts unconditionally: %s', (_name, candidate, current) => {
    expect(shouldAdoptSnapshot(false, candidate, current)).toBe(true);
  });

  // STALE = the relay's claim-time cache, served only with NO live writer:
  // unattributed, so forward-only holds (the ex-writer-rewind guard, §4.2).
  it.each([
    ['behind the ex-writer', { epoch: 1, seq: 1 }, { epoch: 1, seq: 9 }, false],
    ['equal coordinates', { epoch: 1, seq: 3 }, { epoch: 1, seq: 3 }, false],
    ['genuinely forward', { epoch: 2, seq: 0 }, { epoch: 1, seq: 7 }, true],
  ])('STALE stays forward-only: %s → %s', (_name, candidate, current, expected) => {
    expect(shouldAdoptSnapshot(true, candidate, current)).toBe(expected);
  });
});
