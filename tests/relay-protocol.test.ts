import { describe, it, expect } from 'vitest';
import type { ConductorMessage, ConductorState } from '../lib/conductor-state';
import {
  type ClientConn,
  type ClientEffect,
  type SessionKey,
  canOfferClaim,
  helloFrame,
  parseClientFrame,
  parseRelayFrame,
  initClientConn,
  reduceClientConn,
  sessionKeyEquals,
  sessionKeyOf,
} from '../lib/relay-protocol';

// ── Conductor 3b chunk 1: the pure protocol machine ───────────────────────────
// (design-conductor-3b-discovery-failover.md §10-1/§11). Frame-sequence tables
// driving the client connection machine: every §7 failure row that lives client-
// side, the full-SessionKey identity checks (Codex R2 HIGH — mismatch on ANY of
// the three fields rejects), the session-switch flow incl. programHash-only
// change (§4.4), claim/deny/demote, and the activeSession:null waiting state.
// The machine never touches ConductorState internals, so tests use identity-only
// state stubs; the musical mirror is chunk-3a's already-tested reducer.

const KEY_A: SessionKey = { sessionId: 'chart1::band/show', songRef: 'song-a', programHash: 'hash-a' };
const KEY_B: SessionKey = { sessionId: 'chart2::band/show', songRef: 'song-b', programHash: 'hash-b' };
// The Codex R2 corollary key: SAME sessionId, new programHash (mid-song recalibration).
const KEY_A_RECAL: SessionKey = { ...KEY_A, programHash: 'hash-a2' };

function fakeState(key: SessionKey): ConductorState {
  return { ...key, epoch: 1, seq: 3 } as ConductorState;
}

function fakeMsg(key: SessionKey): ConductorMessage {
  return { ...key, epoch: 1, seq: 4, sentAt: 0, payload: { kind: 'advance' } } as ConductorMessage;
}

/** Run a sequence of inputs, returning the final conn and ALL effects in order. */
function run(inputs: Parameters<typeof reduceClientConn>[1][], from: ClientConn = initClientConn()) {
  const effects: ClientEffect[] = [];
  let conn = from;
  for (const input of inputs) {
    const r = reduceClientConn(conn, input);
    conn = r.conn;
    effects.push(...r.effects);
  }
  return { conn, effects };
}

const joined = (activeSession: SessionKey | null, hasWriter = activeSession !== null) =>
  ({ kind: 'frame', frame: { type: 'joined', epoch: 1, hasWriter, activeSession } }) as const;

describe('sessionKeyEquals — identity is the FULL triple', () => {
  it('matches only when every field matches', () => {
    expect(sessionKeyEquals(KEY_A, { ...KEY_A })).toBe(true);
    expect(sessionKeyEquals(KEY_A, { ...KEY_A, sessionId: 'x' })).toBe(false);
    expect(sessionKeyEquals(KEY_A, { ...KEY_A, songRef: 'x' })).toBe(false);
    expect(sessionKeyEquals(KEY_A, { ...KEY_A, programHash: 'x' })).toBe(false);
  });

  it('treats null as equal only to null', () => {
    expect(sessionKeyEquals(null, null)).toBe(true);
    expect(sessionKeyEquals(KEY_A, null)).toBe(false);
    expect(sessionKeyEquals(null, KEY_A)).toBe(false);
  });

  it('sessionKeyOf extracts exactly the reducer-scope triple', () => {
    expect(sessionKeyOf(fakeState(KEY_A))).toEqual(KEY_A);
  });
});

describe('join (§3 D1 / §7)', () => {
  it('late-join with a live session: switch chart + pull that exact key', () => {
    const { conn, effects } = run([joined(KEY_A)]);
    expect(conn.phase).toBe('follower');
    expect(conn.activeSession).toEqual(KEY_A);
    expect(effects).toEqual([
      { kind: 'switch-session', session: KEY_A },
      { kind: 'send', frame: { type: 'snapshot-request', session: KEY_A } },
    ]);
  });

  it('join before any writer has announced: activeSession null → NO pull, waiting + claim affordance', () => {
    const { conn, effects } = run([joined(null, false)]);
    expect(effects).toEqual([]);
    expect(conn.awaitingSnapshot).toBeNull();
    expect(canOfferClaim(conn)).toBe(true);
  });

  it('helloFrame carries room, code, and device label', () => {
    expect(helloFrame('band-show', 'XYZW', 'Rachel')).toEqual({
      type: 'hello', room: 'band-show', code: 'XYZW', deviceLabel: 'Rachel',
    });
  });
});

describe('snapshot adoption (§5 — full-key verified, Codex R2 HIGH)', () => {
  const awaiting = () => run([joined(KEY_A)]).conn;

  it('adopts a snapshot whose state matches the outstanding pull on all three fields', () => {
    const { conn, effects } = run(
      [{ kind: 'frame', frame: { type: 'snapshot', state: fakeState(KEY_A), stale: false } }],
      awaiting(),
    );
    expect(effects).toEqual([{ kind: 'adopt-snapshot', state: fakeState(KEY_A), stale: false }]);
    expect(conn.awaitingSnapshot).toBeNull();
  });

  it.each([
    ['sessionId', { ...KEY_A, sessionId: 'other' }],
    ['songRef', { ...KEY_A, songRef: 'other' }],
    ['programHash', { ...KEY_A, programHash: 'other' }],
  ])('rejects a snapshot mismatching on %s alone (pull stays outstanding)', (_field, key) => {
    const { conn, effects } = run(
      [{ kind: 'frame', frame: { type: 'snapshot', state: fakeState(key), stale: false } }],
      awaiting(),
    );
    expect(effects).toEqual([]);
    expect(conn.awaitingSnapshot).toEqual(KEY_A);
  });

  it('ignores an unsolicited snapshot (nothing outstanding)', () => {
    const { effects } = run([
      joined(null, false),
      { kind: 'frame', frame: { type: 'snapshot', state: fakeState(KEY_A), stale: false } },
    ]);
    expect(effects).toEqual([]);
  });

  it('adopts a stale-marked snapshot during an orphan (join-during-orphan row)', () => {
    const { effects } = run([
      joined(KEY_A, false),
      { kind: 'frame', frame: { type: 'snapshot', state: fakeState(KEY_A), stale: true } },
    ]);
    expect(effects).toContainEqual({ kind: 'adopt-snapshot', state: fakeState(KEY_A), stale: true });
  });

  it('snapshot-none for the outstanding key ends the pull (self-drive)', () => {
    const { conn, effects } = run(
      [{ kind: 'frame', frame: { type: 'snapshot-none', session: KEY_A } }],
      awaiting(),
    );
    expect(effects).toEqual([]);
    expect(conn.awaitingSnapshot).toBeNull();
  });

  it('snapshot-none for a DIFFERENT key does not end the outstanding pull', () => {
    const { conn } = run(
      [{ kind: 'frame', frame: { type: 'snapshot-none', session: KEY_B } }],
      awaiting(),
    );
    expect(conn.awaitingSnapshot).toEqual(KEY_A);
  });
});

describe('the needsSnapshot → pull loop (§5)', () => {
  it('mirror needsSnapshot pulls the active session', () => {
    const base = run([
      joined(KEY_A),
      { kind: 'frame', frame: { type: 'snapshot', state: fakeState(KEY_A), stale: false } },
    ]).conn;
    const { effects } = run([{ kind: 'mirror-outcome', outcome: 'needsSnapshot' }], base);
    expect(effects).toEqual([{ kind: 'send', frame: { type: 'snapshot-request', session: KEY_A } }]);
  });

  it('never sends a duplicate request while one is outstanding for the same key', () => {
    const { effects } = run([
      joined(KEY_A), // starts a pull
      { kind: 'mirror-outcome', outcome: 'needsSnapshot' },
      { kind: 'mirror-outcome', outcome: 'needsSnapshot' },
    ]);
    const requests = effects.filter((e) => e.kind === 'send' && e.frame.type === 'snapshot-request');
    expect(requests).toHaveLength(1);
  });

  it('applied/ignored outcomes do nothing', () => {
    const base = run([joined(null, false)]).conn;
    expect(run([{ kind: 'mirror-outcome', outcome: 'applied' }], base).effects).toEqual([]);
    expect(run([{ kind: 'mirror-outcome', outcome: 'ignored' }], base).effects).toEqual([]);
  });

  it('needsSnapshot with NO active session pulls nothing (self-drive floor)', () => {
    const { effects } = run([joined(null, false), { kind: 'mirror-outcome', outcome: 'needsSnapshot' }]);
    expect(effects).toEqual([]);
  });
});

describe('session switch (§4.4)', () => {
  const following = () =>
    run([
      joined(KEY_A),
      { kind: 'frame', frame: { type: 'snapshot', state: fakeState(KEY_A), stale: false } },
    ]).conn;

  it('a new key switches the chart and pulls the new session', () => {
    const { conn, effects } = run(
      [{ kind: 'frame', frame: { type: 'session', session: KEY_B } }],
      following(),
    );
    expect(conn.activeSession).toEqual(KEY_B);
    expect(effects).toEqual([
      { kind: 'switch-session', session: KEY_B },
      { kind: 'send', frame: { type: 'snapshot-request', session: KEY_B } },
    ]);
  });

  it('a programHash-ONLY change is a switch too (mid-song recalibration, Codex R2 corollary)', () => {
    const { conn, effects } = run(
      [{ kind: 'frame', frame: { type: 'session', session: KEY_A_RECAL } }],
      following(),
    );
    expect(conn.activeSession).toEqual(KEY_A_RECAL);
    expect(effects.map((e) => e.kind)).toEqual(['switch-session', 'send']);
  });

  it('a re-announce of the SAME key is idempotent (no re-pull, no re-switch)', () => {
    const { effects } = run(
      [{ kind: 'frame', frame: { type: 'session', session: { ...KEY_A } } }],
      following(),
    );
    expect(effects).toEqual([]);
  });

  it('a switch arriving mid-pull re-targets the pull to the new key', () => {
    const { conn, effects } = run([
      joined(KEY_A), // pull for A outstanding
      { kind: 'frame', frame: { type: 'session', session: KEY_B } },
    ]);
    expect(conn.awaitingSnapshot).toEqual(KEY_B);
    // ...and the OLD key's snapshot arriving late is now rejected by the key check.
    const late = run(
      [{ kind: 'frame', frame: { type: 'snapshot', state: fakeState(KEY_A), stale: false } }],
      conn,
    );
    expect(late.effects).toEqual([]);
    expect(effects.filter((e) => e.kind === 'switch-session')).toHaveLength(2);
  });

  it('a session announce implies a live writer (clears the orphan banner)', () => {
    const { conn } = run([
      joined(KEY_A, false),
      { kind: 'frame', frame: { type: 'conductor-lost' } },
      { kind: 'frame', frame: { type: 'session', session: KEY_B } },
    ]);
    expect(conn.hasWriter).toBe(true);
    expect(conn.conductorLost).toBe(false);
  });
});

describe('claim lifecycle (§4.1–§4.3)', () => {
  it('request-claim as a follower sends claim-request', () => {
    const { effects } = run([joined(null, false), { kind: 'request-claim' }]);
    expect(effects).toEqual([{ kind: 'send', frame: { type: 'claim-request' } }]);
  });

  it('request-claim while joining or already writer is a no-op', () => {
    expect(run([{ kind: 'request-claim' }]).effects).toEqual([]);
    const writer = run([joined(null, false), { kind: 'frame', frame: { type: 'claim-grant', epoch: 2 } }]).conn;
    expect(run([{ kind: 'request-claim' }], writer).effects).toEqual([]);
  });

  it('claim-grant makes us the writer and emits became-writer with the granted epoch', () => {
    const { conn, effects } = run([
      joined(null, false),
      { kind: 'frame', frame: { type: 'claim-grant', epoch: 5 } },
    ]);
    expect(conn.phase).toBe('writer');
    expect(conn.epoch).toBe(5);
    expect(conn.hasWriter).toBe(true);
    expect(effects).toEqual([{ kind: 'became-writer', epoch: 5 }]);
    expect(canOfferClaim(conn)).toBe(false);
  });

  it('claim-denied leaves us a follower and records that a writer exists (no tie exists)', () => {
    const { conn, effects } = run([
      joined(null, false),
      { kind: 'request-claim' },
      { kind: 'frame', frame: { type: 'claim-denied', epoch: 5 } },
    ]);
    expect(conn.phase).toBe('follower');
    expect(conn.epoch).toBe(5);
    expect(conn.hasWriter).toBe(true);
    expect(effects.filter((e) => e.kind !== 'send')).toEqual([]);
    expect(canOfferClaim(conn)).toBe(false);
  });

  it('the writer announces sessions; a follower cannot', () => {
    const writer = run([joined(null, false), { kind: 'frame', frame: { type: 'claim-grant', epoch: 2 } }]).conn;
    const { conn, effects } = run([{ kind: 'announce-session', session: KEY_A }], writer);
    expect(conn.activeSession).toEqual(KEY_A);
    expect(effects).toEqual([{ kind: 'send', frame: { type: 'session', session: KEY_A } }]);
    expect(run([joined(null, false), { kind: 'announce-session', session: KEY_A }]).effects).toEqual([]);
  });

  it('release-baton hands off: back to follower, no writer, frame sent', () => {
    const writer = run([joined(null, false), { kind: 'frame', frame: { type: 'claim-grant', epoch: 2 } }]).conn;
    const { conn, effects } = run([{ kind: 'release-baton' }], writer);
    expect(conn.phase).toBe('follower');
    expect(conn.hasWriter).toBe(false);
    expect(effects).toEqual([{ kind: 'send', frame: { type: 'release-baton' } }]);
  });
});

describe('writer duties and echoes', () => {
  const writer = () =>
    run([
      joined(null, false),
      { kind: 'frame', frame: { type: 'claim-grant', epoch: 2 } },
      { kind: 'announce-session', session: KEY_A },
    ]).conn;

  it('snapshot-needed as the writer emits serve-snapshot with the requestId', () => {
    const { effects } = run(
      [{ kind: 'frame', frame: { type: 'snapshot-needed', session: KEY_A, requestId: 'r1' } }],
      writer(),
    );
    expect(effects).toEqual([{ kind: 'serve-snapshot', session: KEY_A, requestId: 'r1' }]);
  });

  it('snapshot-needed as a follower is ignored (stale routing)', () => {
    const { effects } = run([
      joined(KEY_A),
      { kind: 'frame', frame: { type: 'snapshot-needed', session: KEY_A, requestId: 'r1' } },
    ]);
    expect(effects.filter((e) => e.kind === 'serve-snapshot')).toEqual([]);
  });

  it('the writer ignores msg and session broadcast echoes — its state is authoritative', () => {
    const { effects } = run(
      [
        { kind: 'frame', frame: { type: 'msg', msg: fakeMsg(KEY_A) } },
        { kind: 'frame', frame: { type: 'session', session: KEY_A } },
      ],
      writer(),
    );
    expect(effects).toEqual([]);
  });

  it('a follower routes msg frames to the mirror (reduce-msg)', () => {
    const { effects } = run([joined(KEY_A), { kind: 'frame', frame: { type: 'msg', msg: fakeMsg(KEY_A) } }]);
    expect(effects).toContainEqual({ kind: 'reduce-msg', msg: fakeMsg(KEY_A) });
  });

  it('cross-session msg frames still pass through — the chunk-3a scope gate owns that ignore', () => {
    const { effects } = run([joined(KEY_A), { kind: 'frame', frame: { type: 'msg', msg: fakeMsg(KEY_B) } }]);
    expect(effects).toContainEqual({ kind: 'reduce-msg', msg: fakeMsg(KEY_B) });
  });
});

describe('failover (§4.2/§7)', () => {
  it('conductor-lost flags the orphan and opens the claim affordance; a pending pull stays outstanding', () => {
    const { conn } = run([joined(KEY_A), { kind: 'frame', frame: { type: 'conductor-lost' } }]);
    expect(conn.hasWriter).toBe(false);
    expect(conn.conductorLost).toBe(true);
    expect(conn.awaitingSnapshot).toEqual(KEY_A); // relay answers it: stale cache or snapshot-none
    expect(canOfferClaim(conn)).toBe(true);
  });

  it('conductor-lost as a believed-writer FAILS SAFE: demote to follower, claim affordance open (Codex R1 HIGH)', () => {
    const writer = run([
      joined(null, false),
      { kind: 'frame', frame: { type: 'claim-grant', epoch: 3 } },
      { kind: 'announce-session', session: KEY_A },
    ]).conn;
    const { conn, effects } = run([{ kind: 'frame', frame: { type: 'conductor-lost' } }], writer);
    expect(conn.phase).toBe('follower'); // never writer && !hasWriter — the invalid state
    expect(conn.hasWriter).toBe(false);
    expect(conn.conductorLost).toBe(true);
    expect(effects).toEqual([{ kind: 'demoted', epoch: 3 }]); // NO pull: no live writer to resync to
    expect(canOfferClaim(conn)).toBe(true); // can take its own baton back (epoch+1)
    // ...and the next MD's session frame now moves it like any follower.
    const next = run([{ kind: 'frame', frame: { type: 'session', session: KEY_B } }], conn);
    expect(next.effects.map((e) => e.kind)).toEqual(['switch-session', 'send']);
  });

  it('zombie demote: not-writer as a believed-writer → follower + demoted + resync to the relay session', () => {
    const zombie = run([
      joined(null, false),
      { kind: 'frame', frame: { type: 'claim-grant', epoch: 2 } },
      { kind: 'announce-session', session: KEY_A },
    ]).conn;
    const { conn, effects } = run(
      [{ kind: 'frame', frame: { type: 'not-writer', epoch: 4, activeSession: KEY_B } }],
      zombie,
    );
    expect(conn.phase).toBe('follower');
    expect(conn.epoch).toBe(4);
    expect(conn.activeSession).toEqual(KEY_B);
    expect(effects).toEqual([
      { kind: 'demoted', epoch: 4 },
      { kind: 'switch-session', session: KEY_B },
      { kind: 'send', frame: { type: 'snapshot-request', session: KEY_B } },
    ]);
  });

  it('not-writer with a null activeSession demotes without a pull (nothing live to resync to)', () => {
    const zombie = run([joined(null, false), { kind: 'frame', frame: { type: 'claim-grant', epoch: 2 } }]).conn;
    const { conn, effects } = run(
      [{ kind: 'frame', frame: { type: 'not-writer', epoch: 4, activeSession: null } }],
      zombie,
    );
    expect(conn.phase).toBe('follower');
    expect(effects).toEqual([{ kind: 'demoted', epoch: 4 }]);
  });

  it('not-writer as an already-follower is ignored (stale routing)', () => {
    const { conn, effects } = run([
      joined(KEY_A),
      { kind: 'frame', frame: { type: 'not-writer', epoch: 4, activeSession: KEY_B } },
    ]);
    expect(effects.filter((e) => e.kind === 'demoted')).toEqual([]);
    expect(conn.activeSession).toEqual(KEY_A);
  });

  it('full failover arc: join → adopt → orphan → claim → grant (the §7 MD-death row end to end)', () => {
    const { conn, effects } = run([
      joined(KEY_A),
      { kind: 'frame', frame: { type: 'snapshot', state: fakeState(KEY_A), stale: false } },
      { kind: 'frame', frame: { type: 'conductor-lost' } },
      { kind: 'request-claim' },
      { kind: 'frame', frame: { type: 'claim-grant', epoch: 2 } },
    ]);
    expect(conn.phase).toBe('writer');
    expect(conn.conductorLost).toBe(false);
    expect(effects.map((e) => e.kind)).toEqual([
      'switch-session', 'send', // join + pull
      'adopt-snapshot',         // mirror seeded
      'send',                   // claim-request
      'became-writer',          // mint via acceptBaton (chunk 2)
    ]);
  });

  it('reconnect after a drop is just a fresh join: initClientConn → joined → pull (§7 row 1)', () => {
    const { conn, effects } = run([joined(KEY_A)], initClientConn());
    expect(conn.phase).toBe('follower');
    expect(effects.at(-1)).toEqual({ kind: 'send', frame: { type: 'snapshot-request', session: KEY_A } });
  });
});

// ── parseClientFrame: the wire trust boundary (chunk 3, Codex R1 HIGH) ────────
describe('parseClientFrame', () => {
  it.each([
    ['hello', helloFrame('gig', 'XYZW', 'dev')],
    ['session', { type: 'session', session: KEY_A }],
    ['claim-request', { type: 'claim-request' }],
    ['release-baton', { type: 'release-baton' }],
    ['hb', { type: 'hb' }],
    ['msg', { type: 'msg', msg: fakeMsg(KEY_A) }],
    ['snapshot-request', { type: 'snapshot-request', session: KEY_A }],
    ['snapshot (upload)', { type: 'snapshot', state: fakeState(KEY_A) }],
    ['snapshot (reply)', { type: 'snapshot', requestId: '7', state: fakeState(KEY_A) }],
  ])('accepts a well-formed %s frame', (_name, frame) => {
    expect(parseClientFrame(JSON.parse(JSON.stringify(frame)))).toEqual(frame);
  });

  it.each([
    ['not an object', 'hello'],
    ['null', null],
    ['no type', { room: 'gig' }],
    ['unknown type', { type: 'bogus' }],
    ['hello missing fields', { type: 'hello', room: 'gig' }],
    ['hello empty room', { type: 'hello', room: '', code: 'XYZW', deviceLabel: 'd' }],
    ['hello empty code', { type: 'hello', room: 'gig', code: '', deviceLabel: 'd' }],
    ['session without key', { type: 'session' }],
    ['session partial key', { type: 'session', session: { sessionId: 's' } }],
    ['session non-string key field', { type: 'session', session: { ...KEY_A, programHash: 9 } }],
    ['msg without body', { type: 'msg' }],
    ['snapshot-request without key', { type: 'snapshot-request' }],
    ['snapshot without state', { type: 'snapshot' }],
    ['snapshot state missing identity triple', { type: 'snapshot', state: { seq: 1 } }],
    ['snapshot non-string requestId', { type: 'snapshot', requestId: 7, state: fakeState(KEY_A) }],
  ])('rejects %s → null (close 4002, never a reducer crash)', (_name, raw) => {
    expect(parseClientFrame(raw)).toBeNull();
  });

  it('stays dumb: a msg body is NOT deep-validated (payload opaque to the relay, doc §2)', () => {
    expect(parseClientFrame({ type: 'msg', msg: { anything: true } })).toEqual({
      type: 'msg',
      msg: { anything: true },
    });
  });
});

// ── parseRelayFrame: the client's side of the boundary (chunk 4, §6 rule 5) ───
// "Validate exactly what YOU read": frame fields + the ConductorMessage/State
// ENVELOPE the reducer's admission path reads (identity triple, epoch/seq/sentAt
// numbers, payload.kind). Payload bodies / snapshot vm stay band-plane-trusted
// (doc §8/D5) — deep shape is NOT checked here by design.
describe('parseRelayFrame', () => {
  it.each([
    ['joined (live session)', { type: 'joined', epoch: 2, hasWriter: true, activeSession: KEY_A }],
    ['joined (empty room)', { type: 'joined', epoch: 0, hasWriter: false, activeSession: null }],
    ['session', { type: 'session', session: KEY_A }],
    ['claim-grant', { type: 'claim-grant', epoch: 3 }],
    ['claim-denied', { type: 'claim-denied', epoch: 3 }],
    ['msg', { type: 'msg', msg: fakeMsg(KEY_A) }],
    ['not-writer (live session)', { type: 'not-writer', epoch: 4, activeSession: KEY_B }],
    ['not-writer (no session)', { type: 'not-writer', epoch: 4, activeSession: null }],
    ['snapshot-needed', { type: 'snapshot-needed', session: KEY_A, requestId: 'r1' }],
    ['snapshot', { type: 'snapshot', state: fakeState(KEY_A), stale: false }],
    ['snapshot (stale)', { type: 'snapshot', state: fakeState(KEY_A), stale: true }],
    ['snapshot-none', { type: 'snapshot-none', session: KEY_A }],
    ['conductor-lost', { type: 'conductor-lost' }],
  ])('accepts a well-formed %s frame (JSON round-trip)', (_name, frame) => {
    expect(parseRelayFrame(JSON.parse(JSON.stringify(frame)))).toEqual(frame);
  });

  it.each([
    ['not an object', 'joined'],
    ['null', null],
    ['no type', { epoch: 1 }],
    ['unknown type', { type: 'bogus' }],
    ['joined missing epoch', { type: 'joined', hasWriter: true, activeSession: null }],
    ['joined missing hasWriter', { type: 'joined', epoch: 1, activeSession: null }],
    ['joined activeSession undefined (must be null or a key)', { type: 'joined', epoch: 1, hasWriter: false }],
    ['joined partial activeSession', { type: 'joined', epoch: 1, hasWriter: true, activeSession: { sessionId: 's' } }],
    ['session without key', { type: 'session' }],
    ['claim-grant non-numeric epoch', { type: 'claim-grant', epoch: '3' }],
    ['claim-denied missing epoch', { type: 'claim-denied' }],
    ['msg without body', { type: 'msg' }],
    ['msg missing identity triple', { type: 'msg', msg: { epoch: 1, seq: 1, sentAt: 0, payload: { kind: 'advance' } } }],
    ['msg missing seq', { type: 'msg', msg: { ...KEY_A, epoch: 1, sentAt: 0, payload: { kind: 'advance' } } }],
    ['msg missing sentAt', { type: 'msg', msg: { ...KEY_A, epoch: 1, seq: 1, payload: { kind: 'advance' } } }],
    ['msg payload not an object', { type: 'msg', msg: { ...KEY_A, epoch: 1, seq: 1, sentAt: 0, payload: 'advance' } }],
    ['msg payload without kind', { type: 'msg', msg: { ...KEY_A, epoch: 1, seq: 1, sentAt: 0, payload: {} } }],
    // The reducer's switch is exhaustive over the KNOWN payload kinds — an
    // unknown discriminator would fall off it, so it is dropped at the
    // boundary (Codex R1 MED). Mixed-version heal is the designed one: the
    // next delta's seq gap → needsSnapshot → pull.
    ['msg with an unknown payload kind', { type: 'msg', msg: { ...KEY_A, epoch: 1, seq: 1, sentAt: 0, payload: { kind: 'futureKind' } } }],
    ['not-writer activeSession undefined', { type: 'not-writer', epoch: 4 }],
    ['snapshot-needed missing requestId', { type: 'snapshot-needed', session: KEY_A }],
    ['snapshot missing stale', { type: 'snapshot', state: fakeState(KEY_A) }],
    ['snapshot state missing identity triple', { type: 'snapshot', state: { epoch: 1, seq: 0 }, stale: false }],
    ['snapshot state missing coordinates', { type: 'snapshot', state: { ...KEY_A }, stale: false }],
    ['snapshot-none without key', { type: 'snapshot-none' }],
  ])('rejects %s → null (dropped by the client binding, never a machine crash)', (_name, rawFrame) => {
    expect(parseRelayFrame(rawFrame)).toBeNull();
  });

  it('trusts the band plane past the envelope: payload bodies are NOT deep-validated (doc §8/D5)', () => {
    const msg = { ...KEY_A, epoch: 1, seq: 1, sentAt: 0, payload: { kind: 'arm', nonsense: true } };
    expect(parseRelayFrame({ type: 'msg', msg })).toEqual({ type: 'msg', msg });
  });

  it('admits every ConductorPayload discriminator the reducer switches on', () => {
    for (const kind of ['claim', 'advance', 'redirect', 'arm', 'commit', 'disarm', 'clock']) {
      const msg = { ...KEY_A, epoch: 1, seq: 1, sentAt: 0, payload: { kind } };
      expect(parseRelayFrame({ type: 'msg', msg })).toEqual({ type: 'msg', msg });
    }
  });
});
