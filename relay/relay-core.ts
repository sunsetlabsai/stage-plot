import {
  type SessionKey,
  type ClientFrame,
  type RelayFrame,
  sessionKeyEquals,
  sessionKeyOf,
} from '../lib/relay-protocol';
import type { ConductorState } from '../lib/conductor-state';

// ── Conductor authority, chunk 3b-3: the relay core (pure) ────────────────────
//
// (design-conductor-3b-discovery-failover.md §2/§4/§5/§6). The dumb star +
// baton arbiter, as a pure state machine: `reduceRelay(state, input)` returns
// the next registry plus EFFECTS for the socket binding (relay/server.ts) to
// execute. Same pure-first pattern as the client machine (lib/relay-protocol.ts)
// — every relay rule is unit-testable without a socket, and the ws binding
// stays a dumb pipe.
//
// The relay's whole contract (doc §6, "Relay-enforced rules, complete"):
//   1. `hello` requires the room code;
//   2. `msg`, `session`, `snapshot` accepted only from writerConn;
//   3. `claim-request` granted only on a free/orphaned baton;
//   4. the room registry is journaled as `{room, roomCode, epoch}` — epoch
//      relay-assigned + monotonic per room, roomCode survives a reboot
//      ("same QR readmits"); the snapshot cache is deliberately NOT journaled.
// Only `msg` and `session` fan out; everything else is point-to-point.
//
// Dumbness preserved: the relay never parses ConductorMessage.payload, never
// runs the reducer, and its ONLY operation on a SessionKey is field-wise
// equality across all three fields (Codex R2 HIGH — never sessionId alone).
//
// Room creation (design detail pinned in doc §3): rooms are created by the
// FIRST `hello` for an unknown room — the opening device generates the slug +
// 4-char code, joins, and renders the QR; there is no separate create frame.
// Later `hello`s must present the journaled code (D3: stale QRs don't admit).

// ── State ─────────────────────────────────────────────────────────────────────

export interface RoomState {
  roomCode: string;
  epoch: number;                       // relay-assigned, monotonic, journaled
  writerConn: string | null;           // THE writer (a connection, not a credential)
  writerAliveAt: number;               // last proof of life (hb / any writer frame)
  activeSession: SessionKey | null;    // writer-announced; null until then + after reboot
  snapshotCache: { key: SessionKey; state: ConductorState } | null;
  // Admitted connection id → deviceLabel (from `hello`). The label exists so
  // the relay can attribute ITS OWN grants ("Rachel is conducting", doc §4.3)
  // — attribution comes from this registry, never from parsing payloads, so
  // dumbness is preserved.
  members: Map<string, string>;
  // Outstanding forwarded snapshot requests: requestId → who asked, for what.
  pending: Map<string, { conn: string; session: SessionKey }>;
}

export interface RelayState {
  rooms: Map<string, RoomState>;
  conns: Map<string, string>;          // connection id → room (admitted only)
  nextRequestId: number;               // deterministic requestId mint
}

export function initRelayState(
  journal: Array<{ room: string; roomCode: string; epoch: number }> = [],
): RelayState {
  const rooms = new Map<string, RoomState>();
  // Reboot restores IDENTITY, not liveness (doc §7 "Relay box dies"): same code
  // readmits, epoch is never reused; activeSession restarts null, cache is lost.
  for (const r of journal) {
    rooms.set(r.room, {
      roomCode: r.roomCode,
      epoch: r.epoch,
      writerConn: null,
      writerAliveAt: 0,
      activeSession: null,
      snapshotCache: null,
      members: new Map(),
      pending: new Map(),
    });
  }
  return { rooms, conns: new Map(), nextRequestId: 1 };
}

// ── Inputs / effects ──────────────────────────────────────────────────────────

export type RelayInput =
  | { kind: 'frame'; conn: string; frame: ClientFrame; now: number }
  | { kind: 'disconnect'; conn: string; now: number }
  | { kind: 'tick'; now: number };     // lease sweep (binding's interval timer)

export type RelayEffect =
  | { kind: 'send'; to: string; frame: RelayFrame }
  | { kind: 'bounce'; conn: string }   // bad room code — close at the door (doc §3)
  | { kind: 'journal'; room: string; roomCode: string; epoch: number };

export interface RelayReduction {
  state: RelayState;
  effects: RelayEffect[];
}

// Lease constants (doc §9 Q2 defaults; injected so tests can shrink them).
export const HB_MS = 2000;
export const HB_MISS = 3;

// ── The reducer ───────────────────────────────────────────────────────────────
//
// PRAGMATIC MUTATION, PURE BOUNDARY: room objects are mutated in place (they
// are registry rows, not shared values — nothing outside the relay ever holds
// one), but every input returns the full {state, effects} and the binding only
// ever acts on effects. This keeps the hot path allocation-free without
// sacrificing testability.

export function reduceRelay(
  state: RelayState,
  input: RelayInput,
  leaseMs: number = HB_MS * HB_MISS,
): RelayReduction {
  switch (input.kind) {
    case 'frame':
      return reduceFrame(state, input.conn, input.frame, input.now);
    case 'disconnect':
      return disconnect(state, input.conn);
    case 'tick':
      return sweepLeases(state, input.now, leaseMs);
  }
}

function reduceFrame(state: RelayState, conn: string, frame: ClientFrame, now: number): RelayReduction {
  if (frame.type === 'hello') return hello(state, conn, frame, now);

  // Every other frame requires admission (rule 1 — the code check is the door).
  const roomName = state.conns.get(conn);
  const room = roomName === undefined ? undefined : state.rooms.get(roomName);
  if (!room) return { state, effects: [{ kind: 'bounce', conn }] };

  switch (frame.type) {
    case 'session': {
      // Rule 2: writer-only.
      if (room.writerConn !== conn) return notWriter(state, room, conn);
      room.writerAliveAt = now;
      const effects: RelayEffect[] = [];
      if (!sessionKeyEquals(room.activeSession, frame.session)) {
        // A real switch (§4.4): replace the blob, DROP the previous key's cache,
        // and answer every pending request — all were keyed to the old session,
        // so all mismatch the new one → snapshot-none (a request never hangs;
        // the `session` broadcast is what moves those requesters).
        room.snapshotCache = null;
        effects.push(...drainPending(room, null));
        room.activeSession = frame.session;
      }
      // Store + rebroadcast verbatim (idempotent re-announce included — §4.1
      // step 3 re-announces mid-song; clients dedupe on the key).
      effects.push(...broadcast(room, conn, { type: 'session', session: frame.session }));
      return { state, effects };
    }

    case 'claim-request': {
      // Rule 3: granted only on a free/orphaned baton. The relay is a single
      // serial process — concurrent claims have no tie to break (§7).
      if (room.writerConn !== null) {
        return { state, effects: [{ kind: 'send', to: conn, frame: { type: 'claim-denied', epoch: room.epoch } }] };
      }
      room.epoch += 1; // never reused: journaled below (rule 4)
      room.writerConn = conn;
      room.writerAliveAt = now;
      // Attribution (doc §4.3, chunk 5): the relay announces WHO took the baton
      // to everyone else, from its own member registry (never a payload). The
      // grantee doesn't need it — `claim-grant` is its answer.
      const label = room.members.get(conn) ?? '';
      return {
        state,
        effects: [
          { kind: 'journal', room: roomName!, roomCode: room.roomCode, epoch: room.epoch },
          { kind: 'send', to: conn, frame: { type: 'claim-grant', epoch: room.epoch } },
          ...broadcast(room, conn, { type: 'writer', label }),
        ],
      };
    }

    case 'release-baton': {
      // Deliberate handoff (§4.1 step 5) = an INSTANT orphan (Codex chunk-3
      // HIGH-2): without the conductor-lost broadcast no follower's hasWriter
      // ever clears, the claim affordance (follower && !hasWriter) never opens,
      // and the released baton is unreachable through the client machine — a
      // permanently headless room. "No orphan wait" still holds: the baton is
      // free NOW (no lease lapse), the first claim wins immediately. And the
      // honesty frame is honest — no one is conducting.
      if (room.writerConn !== conn) return { state, effects: [] };
      return { state, effects: orphan(room) };
    }

    case 'msg': {
      // Rule 2: only the writer's msgs fan out — this is the "forgery rejected
      // by the relay" line the reducer comment promises (conductor-state.ts:198).
      if (room.writerConn !== conn) return notWriter(state, room, conn);
      room.writerAliveAt = now; // any writer traffic proves liveness
      return { state, effects: broadcast(room, conn, { type: 'msg', msg: frame.msg }) };
    }

    case 'snapshot-request': {
      // §5: with a live writer, forward ONLY when the request's key fully
      // equals activeSession — otherwise snapshot-none IMMEDIATELY, without
      // bothering the writer (Codex R3: the requester is on a dead session;
      // the `session` frame is what moves it).
      if (room.writerConn !== null) {
        if (!sessionKeyEquals(room.activeSession, frame.session)) {
          return { state, effects: [{ kind: 'send', to: conn, frame: { type: 'snapshot-none', session: frame.session } }] };
        }
        const requestId = String(state.nextRequestId++);
        room.pending.set(requestId, { conn, session: frame.session });
        return {
          state,
          effects: [{ kind: 'send', to: room.writerConn, frame: { type: 'snapshot-needed', session: frame.session, requestId } }],
        };
      }
      // No live writer: the stale-marked cache, iff EVERY field of its tag
      // matches (Codex R1 HIGH-2 + R2 HIGH); any mismatch → snapshot-none.
      return { state, effects: [serveCacheOrNone(room.snapshotCache, conn, frame.session)] };
    }

    case 'snapshot': {
      // Rule 2: writer-only (a follower has no authority to seed the room).
      if (room.writerConn !== conn) return notWriter(state, room, conn);
      room.writerAliveAt = now;
      // Every upload refreshes the cache, tagged with the state's OWN full key
      // (claim-time upload is just the requestId-less case).
      room.snapshotCache = { key: sessionKeyOf(frame.state), state: frame.state };
      if (frame.requestId === undefined) return { state, effects: [] };
      const p = room.pending.get(frame.requestId);
      if (!p) return { state, effects: [] }; // requester left / already drained
      room.pending.delete(frame.requestId);
      return {
        state,
        effects: [{ kind: 'send', to: p.conn, frame: { type: 'snapshot', state: frame.state, stale: false } }],
      };
    }

    case 'hb': {
      if (room.writerConn === conn) room.writerAliveAt = now;
      return { state, effects: [] };
    }
  }
}

function hello(
  state: RelayState,
  conn: string,
  frame: Extract<ClientFrame, { type: 'hello' }>,
  now: number,
): RelayReduction {
  // One hello per connection (own-sweep): an admitted conn re-helloing would
  // enroll it in a SECOND room's member set — a cross-room fan-out leak. The
  // client machine never re-hellos a live socket (reconnect = new socket), so
  // this is protocol misuse → bounce, fail safe.
  if (state.conns.has(conn)) return { state, effects: [{ kind: 'bounce', conn }] };
  // Defense in depth: `parseClientFrame` (server.ts) is the trust boundary;
  // this keeps the pure layer junk-proof for direct callers too (no registry
  // row keyed by an empty room).
  if (frame.room === '' || frame.code === '') {
    return { state, effects: [{ kind: 'bounce', conn }] };
  }
  const existing = state.rooms.get(frame.room);
  if (existing) {
    // The bouncer, not cryptography (doc §3): stale QR screenshots don't admit.
    if (existing.roomCode !== frame.code) return { state, effects: [{ kind: 'bounce', conn }] };
    existing.members.set(conn, frame.deviceLabel);
    state.conns.set(conn, frame.room);
    return {
      state,
      effects: [{
        kind: 'send',
        to: conn,
        frame: {
          type: 'joined',
          epoch: existing.epoch,
          hasWriter: existing.writerConn !== null,
          activeSession: existing.activeSession,
          // Late-joiner attribution (§4.3): who is conducting right now.
          writerLabel:
            existing.writerConn === null
              ? null
              : existing.members.get(existing.writerConn) ?? null,
        },
      }],
    };
  }
  // First hello creates the room (doc §3): the opening device brings the code.
  const room: RoomState = {
    roomCode: frame.code,
    epoch: 0,
    writerConn: null,
    writerAliveAt: now,
    activeSession: null,
    snapshotCache: null,
    members: new Map([[conn, frame.deviceLabel]]),
    pending: new Map(),
  };
  state.rooms.set(frame.room, room);
  state.conns.set(conn, frame.room);
  return {
    state,
    effects: [
      { kind: 'journal', room: frame.room, roomCode: frame.code, epoch: 0 },
      {
        kind: 'send',
        to: conn,
        frame: { type: 'joined', epoch: 0, hasWriter: false, activeSession: null, writerLabel: null },
      },
    ],
  };
}

function disconnect(state: RelayState, conn: string): RelayReduction {
  const roomName = state.conns.get(conn);
  state.conns.delete(conn);
  const room = roomName === undefined ? undefined : state.rooms.get(roomName);
  if (!room) return { state, effects: [] };
  room.members.delete(conn);
  // A requester that left can't receive its answer — forget those forwards.
  for (const [id, p] of room.pending) if (p.conn === conn) room.pending.delete(id);
  // Writer gone = INSTANT orphan (doc §4.2, "instantly on clean WS close").
  if (room.writerConn === conn) return { state, effects: orphan(room) };
  return { state, effects: [] };
}

function sweepLeases(state: RelayState, now: number, leaseMs: number): RelayReduction {
  const effects: RelayEffect[] = [];
  for (const room of state.rooms.values()) {
    if (room.writerConn !== null && now - room.writerAliveAt > leaseMs) {
      effects.push(...orphan(room)); // HB_MISS misses (~6s default) — doc §4.2
    }
  }
  return { state, effects };
}

// ── Shared paths ──────────────────────────────────────────────────────────────

// The baton orphans: no connection is the writer any more. Broadcast the
// honesty frame to EVERYONE (including the lapsed writer's own connection if
// it is still open — the client machine fails safe by self-demoting, §4.2),
// and answer every pending request the departed writer will never serve:
// matching stale cache or snapshot-none — a request never hangs (§5).
function orphan(room: RoomState): RelayEffect[] {
  room.writerConn = null;
  const effects: RelayEffect[] = [];
  for (const m of room.members.keys()) effects.push({ kind: 'send', to: m, frame: { type: 'conductor-lost' } });
  effects.push(...drainPending(room, room.snapshotCache));
  return effects;
}

// Answer + clear all pending forwards against `cache` (null = none survives).
function drainPending(
  room: RoomState,
  cache: { key: SessionKey; state: ConductorState } | null,
): RelayEffect[] {
  const effects: RelayEffect[] = [];
  for (const p of room.pending.values()) effects.push(serveCacheOrNone(cache, p.conn, p.session));
  room.pending.clear();
  return effects;
}

// Full-key check against the stale cache (§5): serve `stale: true` only when
// EVERY field matches; any mismatch → snapshot-none.
function serveCacheOrNone(
  cache: { key: SessionKey; state: ConductorState } | null,
  to: string,
  session: SessionKey,
): RelayEffect {
  if (cache !== null && sessionKeyEquals(cache.key, session)) {
    return { kind: 'send', to, frame: { type: 'snapshot', state: cache.state, stale: true } };
  }
  return { kind: 'send', to, frame: { type: 'snapshot-none', session } };
}

// A non-writer used a writer-only frame: bounce with the authority facts so the
// client demotes + resyncs (the zombie-MD path, §4.2).
function notWriter(state: RelayState, room: RoomState, conn: string): RelayReduction {
  return {
    state,
    effects: [{ kind: 'send', to: conn, frame: { type: 'not-writer', epoch: room.epoch, activeSession: room.activeSession } }],
  };
}

// Only msg + session (doc §6) and the relay-authored `writer` attribution fan
// out — to every admitted member EXCEPT the sender/grantee (the writer's own
// state is authoritative; it ignores echoes anyway).
function broadcast(room: RoomState, sender: string, frame: RelayFrame): RelayEffect[] {
  const effects: RelayEffect[] = [];
  for (const m of room.members.keys()) if (m !== sender) effects.push({ kind: 'send', to: m, frame });
  return effects;
}
