import type { ConductorMessage, ConductorState } from './conductor-state';

// ── Conductor authority, chunk 3b-1: the pure relay protocol ──────────────────
//
// (design-conductor-3b-discovery-failover.md §6/§10-1). The control-plane frame
// types shared by client and relay, plus the CLIENT-side connection state
// machine — a pure reducer over inputs (relay frames + local intents) that emits
// EFFECTS for the impure binding to execute. Zero network, zero React, zero new
// musical semantics: the machine routes; `reduceConductor` (chunk 3a, untouched)
// remains the only authority over ConductorState.
//
// The contracts this file is built to satisfy (fixed ground, doc §0.1):
//   • Session identity is the FULL reducer-scope triple — SessionKey =
//     {sessionId, songRef, programHash} — everywhere. sessionId alone is
//     chart/show-grained; programHash changes on recompile/recalibration, and
//     the reducer fails closed on a mismatch of ANY field (conductor-state.ts
//     3.1.1). A snapshot is adopted only when every field matches (doc §5).
//   • The ONE recovery door is a snapshot pull: reducer gap/future-epoch/claim
//     all route to `needsSnapshot`, and this machine turns that into exactly one
//     outstanding `snapshot-request` (doc §5).
//   • Session switches ride the `session` frame, never a claim — the reducer's
//     scope gate runs BEFORE claim handling, so a cross-session claim is ignored,
//     not rebased (doc §4.1/§4.4).
//   • Every failure degrades to self-drive: no input ever makes this machine
//     block, and "no baton" (`conductor-lost`, `activeSession: null`) is honesty
//     state for the UI, not a mechanism (doc §7).
//
// What is deliberately NOT here (later chunks): `acceptBaton` minting the new
// generation on a grant (chunk 3b-2 — this machine emits `became-writer` and the
// binding mints per doc §4.1 step 3: announce `session`, upload `snapshot`,
// broadcast `claim`); the relay service itself (3b-3); the socket/React binding
// (3b-4); join/QR UI (3b-5).

// ── Session identity ──────────────────────────────────────────────────────────

// THE session identity, end to end (doc §2, Codex R2 HIGH): the exact triple the
// chunk-3a reducer scopes on. Compared field-wise, never by sessionId alone.
export interface SessionKey {
  sessionId: string;
  songRef: string;
  programHash: string;
}

export function sessionKeyEquals(a: SessionKey | null, b: SessionKey | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.sessionId === b.sessionId &&
    a.songRef === b.songRef &&
    a.programHash === b.programHash
  );
}

// The key a ConductorState (or ConductorMessage) self-identifies as — used for
// the client-side adopt check (doc §5 belt-and-suspenders: verify the SAME three
// fields the reducer scopes on before adopting any snapshot).
export function sessionKeyOf(scoped: {
  sessionId: string;
  songRef: string;
  programHash: string;
}): SessionKey {
  return {
    sessionId: scoped.sessionId,
    songRef: scoped.songRef,
    programHash: scoped.programHash,
  };
}

// ── Wire frames (doc §6) ──────────────────────────────────────────────────────
// JSON over one wss:// socket. The `msg` frame body is the shipped
// ConductorMessage — untouched, opaque to the relay. The relay's ONLY operation
// on a SessionKey is field-wise string equality.

export type ClientFrame =
  | { type: 'hello'; room: string; code: string; deviceLabel: string }
  | { type: 'session'; session: SessionKey }            // writer only; relay stores+broadcasts
  | { type: 'claim-request' }
  | { type: 'release-baton' }                           // deliberate handoff
  | { type: 'msg'; msg: ConductorMessage }              // writer only; fans out
  | { type: 'snapshot-request'; session: SessionKey }
  | { type: 'snapshot'; requestId?: string; state: ConductorState } // writer→relay (reply or claim-time upload)
  | { type: 'hb' };                                     // writer lease heartbeat

export type RelayFrame =
  | {
      type: 'joined';
      epoch: number;
      hasWriter: boolean;
      activeSession: SessionKey | null;                 // null = none announced yet (doc §4)
      // Late-joiner attribution (§4.3, chunk 5): the live writer's deviceLabel,
      // from the relay's OWN member registry (never a payload — dumbness holds).
      // NB: still no writer *identity* field — writer is a CONNECTION (doc §2),
      // and `joined` only ever answers a fresh `hello` on a NEW connection,
      // which by definition is not writerConn. A device that was the writer
      // re-earns the baton by claim. The label is honesty UI, not authority.
      writerLabel: string | null;
    }
  | { type: 'session'; session: SessionKey }            // switch: change chart, pull snapshot
  | { type: 'claim-grant'; epoch: number }              // you are the writer; mint via acceptBaton
  | { type: 'claim-denied'; epoch: number }             // someone else holds/won it
  | { type: 'msg'; msg: ConductorMessage }              // fan-out delivery
  | { type: 'writer'; label: string }                   // relay-authored on grant: "X is conducting" (§4.3)
  | { type: 'not-writer'; epoch: number; activeSession: SessionKey | null } // demote + resync
  | { type: 'snapshot-needed'; session: SessionKey; requestId: string }     // relay→writer
  | { type: 'snapshot'; state: ConductorState; stale: boolean }             // full-key-checked on adopt
  | { type: 'snapshot-none'; session: SessionKey }      // nothing valid for that key; self-drive
  | { type: 'conductor-lost' };                         // baton orphaned; honesty UI

export function helloFrame(room: string, code: string, deviceLabel: string): ClientFrame {
  return { type: 'hello', room, code, deviceLabel };
}

// ── Wire boundary validation ──────────────────────────────────────────────────
// The socket is a TRUST BOUNDARY: everything off it is `unknown`, and neither
// side's reducer runtime-checks field shapes (they trust their input types).
// `parseClientFrame` is the relay's door (Codex chunk-3 R1 HIGH: an admitted
// client sending {type:'bogus'} or a fieldless known type must close 4002,
// never crash the relay); the client binding mirrors this for RelayFrames in
// chunk 4. Opaqueness preserved: `msg` bodies are never deep-validated (the
// relay rebroadcasts verbatim; the chunk-3a reducer is the authority), and a
// `snapshot` state is checked ONLY for the identity triple the relay itself
// reads (its cache tag).

function isSessionKeyShape(v: unknown): v is SessionKey {
  if (typeof v !== 'object' || v === null) return false;
  const k = v as Record<string, unknown>;
  return (
    typeof k.sessionId === 'string' &&
    typeof k.songRef === 'string' &&
    typeof k.programHash === 'string'
  );
}

export function parseClientFrame(raw: unknown): ClientFrame | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const f = raw as Record<string, unknown>;
  switch (f.type) {
    case 'hello':
      return typeof f.room === 'string' && f.room !== '' &&
        typeof f.code === 'string' && f.code !== '' &&
        typeof f.deviceLabel === 'string'
        ? { type: 'hello', room: f.room, code: f.code, deviceLabel: f.deviceLabel }
        : null;
    case 'session':
      return isSessionKeyShape(f.session) ? { type: 'session', session: f.session } : null;
    case 'claim-request':
      return { type: 'claim-request' };
    case 'release-baton':
      return { type: 'release-baton' };
    case 'hb':
      return { type: 'hb' };
    case 'msg':
      // Opaque to the relay — object-ness is the whole check (dumbness, doc §2).
      return typeof f.msg === 'object' && f.msg !== null
        ? { type: 'msg', msg: f.msg as ConductorMessage }
        : null;
    case 'snapshot-request':
      return isSessionKeyShape(f.session) ? { type: 'snapshot-request', session: f.session } : null;
    case 'snapshot': {
      // The relay reads exactly the identity triple off the state (its cache
      // tag, sessionKeyOf) — validate exactly that much, nothing deeper.
      if (!isSessionKeyShape(f.state)) return null;
      const state = f.state as unknown as ConductorState;
      if (f.requestId === undefined) return { type: 'snapshot', state };
      return typeof f.requestId === 'string' ? { type: 'snapshot', requestId: f.requestId, state } : null;
    }
    default:
      return null;
  }
}

// The client's side of the boundary (chunk 4, the mirror parseClientFrame
// promised). Same "validate exactly what YOU read" rule: the conn machine reads
// frame fields; the mirror path hands `msg` to `reduceConductor`, whose ADMISSION
// reads the ConductorMessage ENVELOPE (identity triple, epoch/seq numbers,
// payload.kind) — so the envelope is validated here. Payload BODIES (an arm's
// directive, a snapshot's vm) are deliberately NOT deep-validated: they originate
// from another instance of THIS app holding the writer connection, and the v1
// trust model (doc §8/D5: AP possession + room code IS the boundary, no crypto)
// places admitted devices on the band trust plane — the same plane on which we
// adopt a snapshot's vm wholesale. A malformed frame from that plane is a local
// client failure (rejoin), not the shared-relay crash class chunk 3 closed.
// The payload discriminators the chunk-3a reducer actually switches on
// (conductor-state.ts ConductorPayload). "Validate what you read" (Codex
// chunk-4 R1 MED): admission reads payload.kind and the reducer's switch is
// exhaustive over exactly these — an unknown discriminator must be dropped at
// the boundary (bad-frame), never fall off the switch. The mixed-version
// consequence is the designed one: a dropped delta is healed by the NEXT
// delta's seq gap → needsSnapshot → pull (the one recovery door).
const PAYLOAD_KINDS = new Set(['claim', 'advance', 'redirect', 'arm', 'commit', 'disarm', 'clock']);

function isConductorMessageShape(v: unknown): v is ConductorMessage {
  if (!isSessionKeyShape(v)) return false;
  const m = v as unknown as Record<string, unknown>;
  if (
    typeof m.epoch !== 'number' ||
    typeof m.seq !== 'number' ||
    typeof m.sentAt !== 'number' ||
    typeof m.payload !== 'object' ||
    m.payload === null
  ) {
    return false;
  }
  const kind = (m.payload as Record<string, unknown>).kind;
  return typeof kind === 'string' && PAYLOAD_KINDS.has(kind);
}

// A ConductorState carries the identity triple plus the authority coordinates the
// admission path reads; validate that envelope, adopt the rest on band trust.
function isConductorStateShape(v: unknown): v is ConductorState {
  if (!isSessionKeyShape(v)) return false;
  const s = v as unknown as Record<string, unknown>;
  return typeof s.epoch === 'number' && typeof s.seq === 'number';
}

export function parseRelayFrame(raw: unknown): RelayFrame | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const f = raw as Record<string, unknown>;
  switch (f.type) {
    case 'joined':
      return typeof f.epoch === 'number' &&
        typeof f.hasWriter === 'boolean' &&
        (f.activeSession === null || isSessionKeyShape(f.activeSession)) &&
        (f.writerLabel === null || typeof f.writerLabel === 'string')
        ? {
            type: 'joined',
            epoch: f.epoch,
            hasWriter: f.hasWriter,
            activeSession: f.activeSession as SessionKey | null,
            writerLabel: f.writerLabel as string | null,
          }
        : null;
    case 'session':
      return isSessionKeyShape(f.session) ? { type: 'session', session: f.session } : null;
    case 'claim-grant':
      return typeof f.epoch === 'number' ? { type: 'claim-grant', epoch: f.epoch } : null;
    case 'claim-denied':
      return typeof f.epoch === 'number' ? { type: 'claim-denied', epoch: f.epoch } : null;
    case 'msg':
      return isConductorMessageShape(f.msg) ? { type: 'msg', msg: f.msg } : null;
    case 'writer':
      return typeof f.label === 'string' ? { type: 'writer', label: f.label } : null;
    case 'not-writer':
      return typeof f.epoch === 'number' &&
        (f.activeSession === null || isSessionKeyShape(f.activeSession))
        ? { type: 'not-writer', epoch: f.epoch, activeSession: f.activeSession as SessionKey | null }
        : null;
    case 'snapshot-needed':
      return isSessionKeyShape(f.session) && typeof f.requestId === 'string'
        ? { type: 'snapshot-needed', session: f.session, requestId: f.requestId }
        : null;
    case 'snapshot':
      return isConductorStateShape(f.state) && typeof f.stale === 'boolean'
        ? { type: 'snapshot', state: f.state, stale: f.stale }
        : null;
    case 'snapshot-none':
      return isSessionKeyShape(f.session) ? { type: 'snapshot-none', session: f.session } : null;
    case 'conductor-lost':
      return { type: 'conductor-lost' };
    default:
      return null;
  }
}

// ── The client connection machine (pure) ─────────────────────────────────────

// joining → follower ⇄ writer. "Demoted" is the writer→follower transition (the
// zombie-MD path, doc §4.2), surfaced as an effect for the UI — not a phase.
export type ConnPhase = 'joining' | 'follower' | 'writer';

export interface ClientConn {
  phase: ConnPhase;
  epoch: number;                      // last relay-reported baton generation
  hasWriter: boolean;                 // someone holds the baton (honesty UI)
  conductorLost: boolean;             // orphan banner (doc §4.2); claim affordance
                                      // is derived: follower && !hasWriter
  writerLabel: string | null;         // "X is conducting" (§4.3) — honesty UI only,
                                      // never authority; null = unknown/none/it's us
  activeSession: SessionKey | null;   // the room's live session; null = waiting
  awaitingSnapshot: SessionKey | null; // the ONE outstanding pull (doc §5)
}

export function initClientConn(): ClientConn {
  return {
    phase: 'joining',
    epoch: 0,
    hasWriter: false,
    conductorLost: false,
    writerLabel: null,
    activeSession: null,
    awaitingSnapshot: null,
  };
}

// Inputs: everything that can move the connection — a relay frame, the local
// mirror's reduce outcome (the needsSnapshot → pull loop), or a local intent.
export type ClientInput =
  | { kind: 'frame'; frame: RelayFrame }
  | { kind: 'mirror-outcome'; outcome: 'applied' | 'ignored' | 'needsSnapshot' }
  | { kind: 'request-claim' }                     // user confirmed "Take the baton?"
  | { kind: 'release-baton' }                     // deliberate handoff (writer)
  | { kind: 'announce-session'; session: SessionKey }; // writer starts/switches a session

// Effects: what the impure binding must DO. The machine never touches sockets,
// charts, or ConductorState — it only says what should happen next.
export type ClientEffect =
  | { kind: 'send'; frame: ClientFrame }
  | { kind: 'switch-session'; session: SessionKey }  // open that chart; rebuild the local mirror
  | { kind: 'adopt-snapshot'; state: ConductorState; stale: boolean } // full-key-verified already
  | { kind: 'reduce-msg'; msg: ConductorMessage }    // hand to reduceConductor (mirror path)
  | { kind: 'became-writer'; epoch: number }         // mint via acceptBaton, then announce/upload/claim (§4.1-3)
  | { kind: 'serve-snapshot'; session: SessionKey; requestId: string } // writer: reply with your state
  | { kind: 'demoted'; epoch: number };              // zombie path: you are not the writer anymore

export interface ClientReduction {
  conn: ClientConn;
  effects: ClientEffect[];
}

const noop = (conn: ClientConn): ClientReduction => ({ conn, effects: [] });

// Begin (or re-begin) the one outstanding pull for `session`. Idempotent per key:
// if that exact pull is already outstanding, don't send a duplicate request.
function pull(conn: ClientConn, session: SessionKey): ClientReduction {
  if (sessionKeyEquals(conn.awaitingSnapshot, session)) return noop(conn);
  return {
    conn: { ...conn, awaitingSnapshot: session },
    effects: [{ kind: 'send', frame: { type: 'snapshot-request', session } }],
  };
}

export function reduceClientConn(conn: ClientConn, input: ClientInput): ClientReduction {
  switch (input.kind) {
    case 'frame':
      return reduceFrame(conn, input.frame);

    // The mirror's needsSnapshot is the reducer's one recovery door (gap, future
    // epoch, higher-epoch claim) — turn it into a pull for the ACTIVE session.
    // With no active session there is nothing to pull (self-drive, doc §4).
    case 'mirror-outcome':
      if (input.outcome !== 'needsSnapshot') return noop(conn);
      if (conn.activeSession === null) return noop(conn);
      return pull(conn, conn.activeSession);

    case 'request-claim':
      if (conn.phase !== 'follower') return noop(conn); // writer already holds it; joining isn't admitted yet
      return { conn, effects: [{ kind: 'send', frame: { type: 'claim-request' } }] };

    case 'release-baton':
      if (conn.phase !== 'writer') return noop(conn);
      return {
        conn: { ...conn, phase: 'follower', hasWriter: false },
        effects: [{ kind: 'send', frame: { type: 'release-baton' } }],
      };

    // The writer starting the next song (or re-announcing after a recompile —
    // a new programHash IS a switch, doc §4.4). Sent BEFORE any msg for it, on
    // this one ordered socket.
    case 'announce-session':
      if (conn.phase !== 'writer') return noop(conn);
      return {
        conn: { ...conn, activeSession: input.session },
        effects: [{ kind: 'send', frame: { type: 'session', session: input.session } }],
      };
  }
}

function reduceFrame(conn: ClientConn, frame: RelayFrame): ClientReduction {
  switch (frame.type) {
    // Admitted to the room. activeSession tells a late joiner which chart/session
    // is live (doc §3 D1); null = no writer has announced yet → waiting state,
    // NO pull (doc §7 "join before any writer has announced").
    case 'joined': {
      const base: ClientConn = {
        ...conn,
        phase: 'follower',
        epoch: frame.epoch,
        hasWriter: frame.hasWriter,
        conductorLost: false,
        writerLabel: frame.writerLabel,
        activeSession: frame.activeSession,
        awaitingSnapshot: null,
      };
      if (frame.activeSession === null) return noop(base);
      const p = pull(base, frame.activeSession);
      return {
        conn: p.conn,
        effects: [{ kind: 'switch-session', session: frame.activeSession }, ...p.effects],
      };
    }

    // Session switch (doc §4.4). Implies a live writer. Idempotent on the same
    // key (the new MD re-announces mid-song, §4.1 step 3). The writer ignores
    // the broadcast echo of its own announcement — its state is authoritative.
    case 'session': {
      if (conn.phase === 'writer') return noop(conn);
      const alive = { ...conn, hasWriter: true, conductorLost: false };
      if (sessionKeyEquals(alive.activeSession, frame.session)) return noop(alive);
      const p = pull({ ...alive, activeSession: frame.session, awaitingSnapshot: null }, frame.session);
      return {
        conn: p.conn,
        effects: [{ kind: 'switch-session', session: frame.session }, ...p.effects],
      };
    }

    // The baton is ours. Minting the new generation (epoch := granted, seq 0)
    // is acceptBaton — chunk 3b-2; the binding then announces `session`, uploads
    // the claim-time snapshot, and broadcasts `claim` (doc §4.1 step 3).
    case 'claim-grant':
      return {
        conn: {
          ...conn,
          phase: 'writer',
          epoch: frame.epoch,
          hasWriter: true,
          conductorLost: false,
          writerLabel: null, // the writer is US — the label is for followers' UI
          awaitingSnapshot: null,
        },
        effects: [{ kind: 'became-writer', epoch: frame.epoch }],
      };

    // Someone else holds/won the baton — which means a live writer exists.
    case 'claim-denied':
      return noop({
        ...conn,
        epoch: Math.max(conn.epoch, frame.epoch),
        hasWriter: true,
        conductorLost: false,
      });

    // Fan-out delivery → the mirror path. The chunk-3a reducer self-scopes
    // (cross-session deltas are ignored there — doc §4.4 pre-switch window), so
    // the machine passes through rather than double-gating. A delta also means
    // a writer is alive. The writer ignores echoes: its state is authoritative.
    case 'msg':
      if (conn.phase === 'writer') return noop(conn);
      return {
        conn: { ...conn, hasWriter: true, conductorLost: false },
        effects: [{ kind: 'reduce-msg', msg: frame.msg }],
      };

    // Relay-authored attribution (§4.3): someone took the baton — record who.
    // Honesty UI only, no routing consequence. Receiving this while in phase
    // 'writer' would mean the relay granted past us; the AUTHORITY heal for
    // that is not-writer/conductor-lost (which the relay also sends on those
    // paths) — this frame just keeps the name honest.
    case 'writer':
      return noop({ ...conn, hasWriter: true, conductorLost: false, writerLabel: frame.label });

    // The zombie-MD path (doc §4.2): we believed we were the writer; the relay
    // says no. Demote, adopt the relay's view of the live session, resync.
    case 'not-writer': {
      if (conn.phase !== 'writer') return noop(conn); // stale routing; already a follower
      const base: ClientConn = {
        ...conn,
        phase: 'follower',
        epoch: frame.epoch,
        hasWriter: true,
        conductorLost: false,
        activeSession: frame.activeSession,
        awaitingSnapshot: null,
      };
      const effects: ClientEffect[] = [{ kind: 'demoted', epoch: frame.epoch }];
      if (frame.activeSession !== null) {
        const p = pull(base, frame.activeSession);
        effects.push({ kind: 'switch-session', session: frame.activeSession }, ...p.effects);
        return { conn: p.conn, effects };
      }
      return { conn: base, effects };
    }

    // Writer duty: someone needs state — reply through the relay (doc §5 D6).
    case 'snapshot-needed':
      if (conn.phase !== 'writer') return noop(conn);
      return {
        conn,
        effects: [{ kind: 'serve-snapshot', session: frame.session, requestId: frame.requestId }],
      };

    // The pull answered. Adopt ONLY when the state's full key matches the pull we
    // have outstanding (doc §5: the same three fields the reducer scopes on —
    // a buggy relay can't cross-feed sessions). A mismatch is rejected and the
    // pull stays outstanding (an honest relay still owes us an answer).
    case 'snapshot': {
      if (conn.awaitingSnapshot === null) return noop(conn); // unsolicited
      if (!sessionKeyEquals(sessionKeyOf(frame.state), conn.awaitingSnapshot)) return noop(conn);
      return {
        conn: { ...conn, awaitingSnapshot: null },
        effects: [{ kind: 'adopt-snapshot', state: frame.state, stale: frame.stale }],
      };
    }

    // Nothing valid for that key (dead session, or no cache during an orphan) —
    // the pull is over; self-drive. A later `session` frame is what moves us.
    case 'snapshot-none':
      if (!sessionKeyEquals(conn.awaitingSnapshot, frame.session)) return noop(conn);
      return noop({ ...conn, awaitingSnapshot: null });

    // Baton orphaned (doc §4.2): honesty UI for followers — they are already
    // self-driving correctly (no deltas are arriving). A pending pull stays
    // outstanding: the relay answers it with the stale cache or snapshot-none.
    //
    // FAIL SAFE for a believed-writer (Codex build R1 HIGH): the orphaned
    // writer's own connection may receive this broadcast (wedged device, lease
    // missed, socket still open). Relay truth at orphan time is that NO
    // connection is the writer — staying in phase 'writer' would be an invalid
    // state (writer && !hasWriter) that drops the next MD's session/msg frames
    // as "echoes" and can never offer re-claim. So self-demote. Deliberately NO
    // pull: unlike `not-writer` there is no live writer to resync to, and the
    // ex-writer's own local state is the freshest in the room — it keeps
    // self-driving on it, and can take its own baton back (epoch+1) in one tap.
    case 'conductor-lost': {
      // No one is conducting — the label clears with the baton (§4.2 honesty).
      const flagged: ClientConn = { ...conn, hasWriter: false, conductorLost: true, writerLabel: null };
      if (conn.phase !== 'writer') return noop(flagged);
      return {
        conn: { ...flagged, phase: 'follower' },
        effects: [{ kind: 'demoted', epoch: conn.epoch }],
      };
    }
  }
}

// Derived UI facts (doc §4.3/§7): may this device offer "Take the baton"?
export function canOfferClaim(conn: ClientConn): boolean {
  return conn.phase === 'follower' && !conn.hasWriter;
}
