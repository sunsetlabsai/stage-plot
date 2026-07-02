import {
  type SessionKey,
  type ClientFrame,
  type RelayFrame,
  sessionKeyEquals,
  sessionKeyOf,
} from '../lib/relay-protocol';
import type { ConductorState } from '../lib/conductor-state';

// ── Conductor authority: the relay core (pure) ────────────────────────────────
//
// (design-conductor-3b-discovery-failover.md §2/§4/§5/§6 for the protocol;
// design-relay-cloud.md §3/§4 for the public-socket hardening.) The dumb star +
// baton arbiter, as a pure state machine: `reduceRelay(state, input)` returns
// the next registry plus EFFECTS for the socket binding (relay/server.ts) to
// execute. Same pure-first pattern as the client machine (lib/relay-protocol.ts)
// — every relay rule is unit-testable without a socket, and the ws binding
// stays a dumb pipe.
//
// The relay's contract (discovery doc §6, amended by cloud doc §4 D4):
//   1. `hello` is the door: explicit intent — `create` mints the room (the
//      RELAY mints an unused 6-char code; room == code), `join` requires an
//      existing room's code (a typo bounces `no-room`, never creates).
//   2. `msg`, `session`, `snapshot` accepted only from writerConn;
//   3. `claim-request` granted only on a free/orphaned baton;
//   4. THE EPOCH INVARIANT (cloud doc §3 S5): every epoch the relay ever
//      issues — create seed and every claim grant, across ALL rooms — is
//      `++grantCounter`, one global durable monotone integer, journaled
//      WRITE-AHEAD (the `journal` effect is ordered BEFORE the ack `send`;
//      the binding persists synchronously, fsync-real). Per-room epochs are a
//      strictly increasing subsequence of it, so no room can ever see a
//      reissued epoch no matter what was GC'd or re-minted. Room records are
//      droppable cache, not integrity state. The snapshot cache is
//      deliberately NOT journaled.
// Only `msg` and `session` fan out; everything else is point-to-point.
//
// Dumbness preserved: the relay never parses ConductorMessage.payload, never
// runs the reducer, its ONLY operation on a SessionKey is field-wise equality,
// and `showRef` is stored + echoed, never interpreted.
//
// Room lifecycle (cloud doc §3 S5): rooms are per-gig ephemera. Unclaimed
// rooms (writer never claimed) GC after 15 min; abandoned rooms (empty, no
// activity) GC after 24h. GC is safe BECAUSE of the global counter.
//
// What deliberately lives in the IMPURE binding, not here (cloud doc §3 S2-S4):
// rate limiting (per-IP hello/create buckets, frame rate, connection caps),
// tiered raw-byte payload budgets, and the Origin allowlist — all are
// properties of sockets/IPs/bytes, which this machine never sees.

// ── State ─────────────────────────────────────────────────────────────────────

export interface RoomState {
  // The room's key in RelayState.rooms IS the code (room == code, doc §4 D4);
  // there is no separate roomCode field anymore.
  epoch: number;                       // relay-assigned from grantCounter, monotonic
  writerConn: string | null;           // THE writer (a connection, not a credential)
  writerAliveAt: number;               // last proof of life (hb / any writer frame)
  activeSession: SessionKey | null;    // writer-announced; null until then + after reboot
  snapshotCache: { key: SessionKey; state: ConductorState } | null;
  // Admitted connection id → deviceLabel (from `hello`). The label exists so
  // the relay can attribute ITS OWN grants ("Rachel is conducting", doc §4.3)
  // — attribution comes from this registry, never from parsing payloads.
  members: Map<string, string>;
  // Outstanding forwarded snapshot requests: requestId → who asked, for what.
  pending: Map<string, { conn: string; session: SessionKey }>;
  // Opaque show blob from the creating hello (cloud doc §4 D4): stored +
  // echoed in every `joined`, never read. Typed-code joins navigate via it.
  showRef: string | null;
  // Lifecycle (cloud doc §3 S5):
  createdAt: number;
  lastActivityAt: number;              // any admitted frame / join / disconnect
  claimed: boolean;                    // a writer has EVER claimed (unclaimed-GC gate)
}

export interface RelayState {
  rooms: Map<string, RoomState>;
  conns: Map<string, string>;          // connection id → room (admitted only)
  nextRequestId: number;               // deterministic requestId mint
  // The one integrity datum (S5): the global monotone grant counter. Every
  // issued epoch is ++grantCounter; restore reads it back (+slack on unclean
  // shutdown — the binding's job).
  grantCounter: number;
}

// Journal v2 restore shape (the binding reads/writes the file; see server.ts).
export interface RelayRestore {
  counter: number;
  rooms: Array<{ room: string; epoch: number; showRef: string | null }>;
}

export function initRelayState(restore?: RelayRestore, now = 0): RelayState {
  const rooms = new Map<string, RoomState>();
  // Reboot restores IDENTITY, not liveness (doc §7 "relay dies"): same code
  // readmits, epoch is never reused (the counter guarantees it even if these
  // rows were lost); activeSession restarts null, cache is lost.
  for (const r of restore?.rooms ?? []) {
    rooms.set(r.room, {
      epoch: r.epoch,
      writerConn: null,
      writerAliveAt: 0,
      activeSession: null,
      snapshotCache: null,
      members: new Map(),
      pending: new Map(),
      showRef: r.showRef,
      createdAt: now,      // lifecycle clocks restart at boot: a restored room
      lastActivityAt: now, // no one rejoins is abandoned-GC'd a TTL later
      claimed: true,       // only claimed rooms are ever journaled (MED-1)
    });
  }
  return { rooms, conns: new Map(), nextRequestId: 1, grantCounter: restore?.counter ?? 0 };
}

// ── Inputs / effects ──────────────────────────────────────────────────────────

export type RelayInput =
  | { kind: 'frame'; conn: string; frame: ClientFrame; now: number }
  | { kind: 'disconnect'; conn: string; now: number }
  | { kind: 'tick'; now: number };     // lease sweep + room GC (binding's timer)

// Bounce close codes (app-defined, 4000-range). The binding closes with these;
// chunk 2's client machine reads them for honest UI ("room not found" ≠ "wrong
// code"). 4002 (bad frame) and the rate/origin codes live in the binding — they
// are socket-level, pre-reducer.
export const CLOSE_BAD_CODE = 4001;    // room exists, code mismatch / protocol misuse
export const CLOSE_RELAY_FULL = 4003;  // global room cap (S2 backstop)
export const CLOSE_NO_ROOM = 4004;     // join for an unknown/expired room (D4)

export type RelayEffect =
  | { kind: 'send'; to: string; frame: RelayFrame }
  | { kind: 'bounce'; conn: string; code: number; reason: string }
  | {
      // Journal the registry. `authority: true` = an epoch was issued — the
      // binding MUST persist durably (fsync) BEFORE executing any later effect
      // in this reduction (write-ahead-before-ack, S2/S5). `authority: false`
      // = GC compaction — the binding may coalesce (S2: compaction ONLY).
      kind: 'journal';
      authority: boolean;
      counter: number;                 // grantCounter at emit (== state's)
    };

export interface RelayReduction {
  state: RelayState;
  effects: RelayEffect[];
}

// ── Constants (cloud doc §8 Q2 defaults; injected so tests can shrink them) ──

export const HB_MS = 2000;
export const HB_MISS = 3;
export const UNCLAIMED_TTL_MS = 15 * 60_000;      // S5: created, never claimed
export const ABANDONED_TTL_MS = 24 * 3600_000;    // S5: empty, no activity
export const MAX_ROOMS = 500;                     // S2: global cap → relay-full
export const MAX_PENDING_PER_ROOM = 8;            // S3: pending snapshot-request cap

// S1: 6 chars, unambiguous alphabet (no 0/O/1/I) — ~32^6 ≈ 1.07B.
export const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const CODE_LEN = 6;

// Default (non-crypto) mint for direct/pure callers; the binding injects a
// crypto-backed one. Uniqueness is NOT the mint's job — the reducer loops
// against its own registry ("unused is a lookup, not a probability", D4).
function defaultMintCode(): string {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

export interface RelayCoreConfig {
  leaseMs: number;
  unclaimedTtlMs: number;
  abandonedTtlMs: number;
  maxRooms: number;
  maxPendingPerRoom: number;
  mintCode: () => string;
}

const DEFAULTS: RelayCoreConfig = {
  leaseMs: HB_MS * HB_MISS,
  unclaimedTtlMs: UNCLAIMED_TTL_MS,
  abandonedTtlMs: ABANDONED_TTL_MS,
  maxRooms: MAX_ROOMS,
  maxPendingPerRoom: MAX_PENDING_PER_ROOM,
  mintCode: defaultMintCode,
};

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
  cfg: Partial<RelayCoreConfig> = {},
): RelayReduction {
  const c: RelayCoreConfig = { ...DEFAULTS, ...cfg };
  switch (input.kind) {
    case 'frame':
      return reduceFrame(state, input.conn, input.frame, input.now, c);
    case 'disconnect':
      return disconnect(state, input.conn, input.now);
    case 'tick':
      return sweep(state, input.now, c);
  }
}

function reduceFrame(
  state: RelayState,
  conn: string,
  frame: ClientFrame,
  now: number,
  c: RelayCoreConfig,
): RelayReduction {
  if (frame.type === 'hello') return hello(state, conn, frame, now, c);

  // Every other frame requires admission (rule 1 — the hello is the door).
  const roomName = state.conns.get(conn);
  const room = roomName === undefined ? undefined : state.rooms.get(roomName);
  if (!room) return { state, effects: [{ kind: 'bounce', conn, code: CLOSE_BAD_CODE, reason: 'not admitted' }] };
  room.lastActivityAt = now; // any admitted traffic resets the abandoned-GC clock

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
      // THE invariant (S5): the grant is the next value of the ONE global
      // counter — never room.epoch + 1. Journal effect ordered BEFORE the
      // grant ack (write-ahead-before-ack): a grant acknowledged but not
      // durable could be reissued after a crash, the exact reuse S5 forbids.
      state.grantCounter += 1;
      room.epoch = state.grantCounter;
      room.writerConn = conn;
      room.writerAliveAt = now;
      room.claimed = true;
      // Attribution (doc §4.3): the relay announces WHO took the baton to
      // everyone else, from its own member registry (never a payload). The
      // grantee doesn't need it — `claim-grant` is its answer.
      const label = room.members.get(conn) ?? '';
      return {
        state,
        effects: [
          { kind: 'journal', authority: true, counter: state.grantCounter },
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
        // S3: bounded pending set — past the cap, answer honestly instead of
        // queueing (a request never hangs; the client can re-pull).
        if (room.pending.size >= c.maxPendingPerRoom) {
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
  c: RelayCoreConfig,
): RelayReduction {
  // One hello per connection (own-sweep): an admitted conn re-helloing would
  // enroll it in a SECOND room's member set — a cross-room fan-out leak. The
  // client machine never re-hellos a live socket (reconnect = new socket), so
  // this is protocol misuse → bounce, fail safe.
  if (state.conns.has(conn)) {
    return { state, effects: [{ kind: 'bounce', conn, code: CLOSE_BAD_CODE, reason: 'already admitted' }] };
  }

  // ── Create (D4): the RELAY mints the code; room == code. ──
  if (frame.intent === 'create') {
    // S2 structural backstop: a create-flood becomes a bounded nuisance, not
    // disk exhaustion. Honest bounce; the per-IP create bucket (binding) is
    // the first line — this is the global cap behind it.
    if (state.rooms.size >= c.maxRooms) {
      return { state, effects: [{ kind: 'bounce', conn, code: CLOSE_RELAY_FULL, reason: 'relay-full' }] };
    }
    // "Unused is a lookup, not a probability" (D4): loop the mint against the
    // live registry. 32^6 vs ≤500 rooms — collisions are re-rolled, never kept.
    let code = c.mintCode();
    while (state.rooms.has(code)) code = c.mintCode();
    // Seed epoch from the global counter (S5) — journaled write-ahead below.
    state.grantCounter += 1;
    const room: RoomState = {
      epoch: state.grantCounter,
      writerConn: null,
      writerAliveAt: now,
      activeSession: null,
      snapshotCache: null,
      members: new Map([[conn, frame.deviceLabel]]),
      pending: new Map(),
      showRef: frame.showRef ?? null,
      createdAt: now,
      lastActivityAt: now,
      claimed: false,
    };
    state.rooms.set(code, room);
    state.conns.set(conn, code);
    return {
      state,
      effects: [
        { kind: 'journal', authority: true, counter: state.grantCounter },
        {
          kind: 'send',
          to: conn,
          frame: {
            type: 'joined',
            epoch: room.epoch,
            hasWriter: false,
            activeSession: null,
            writerLabel: null,
            created: true,
            room: code,
            showRef: room.showRef,
          },
        },
      ],
    };
  }

  // ── Join (D4): the room must exist — a typo bounces, never creates. ──
  const existing = state.rooms.get(frame.room);
  if (!existing) {
    return { state, effects: [{ kind: 'bounce', conn, code: CLOSE_NO_ROOM, reason: 'no-room' }] };
  }
  // room == code, so a well-formed client sends them equal; the check remains
  // the bouncer for hand-typed joins routed with a stale/mistyped code.
  if (frame.code !== frame.room) {
    return { state, effects: [{ kind: 'bounce', conn, code: CLOSE_BAD_CODE, reason: 'bad room or code' }] };
  }
  existing.members.set(conn, frame.deviceLabel);
  existing.lastActivityAt = now;
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
        created: false,
        room: frame.room,
        showRef: existing.showRef,
      },
    }],
  };
}

function disconnect(state: RelayState, conn: string, now: number): RelayReduction {
  const roomName = state.conns.get(conn);
  state.conns.delete(conn);
  const room = roomName === undefined ? undefined : state.rooms.get(roomName);
  if (!room) return { state, effects: [] };
  room.members.delete(conn);
  room.lastActivityAt = now;
  // A requester that left can't receive its answer — forget those forwards.
  for (const [id, p] of room.pending) if (p.conn === conn) room.pending.delete(id);
  // Writer gone = INSTANT orphan (doc §4.2, "instantly on clean WS close").
  if (room.writerConn === conn) return { state, effects: orphan(room) };
  return { state, effects: [] };
}

// One timer, two sweeps: writer leases (protocol) + room GC (S5 lifecycle).
function sweep(state: RelayState, now: number, c: RelayCoreConfig): RelayReduction {
  const effects: RelayEffect[] = [];
  let collected = false;
  for (const [name, room] of state.rooms) {
    // Lease sweep (doc §4.2): HB_MISS misses (~6s default) orphans the baton.
    if (room.writerConn !== null && now - room.writerAliveAt > c.leaseMs) {
      effects.push(...orphan(room));
    }
    // Room GC (S5). Safe to drop ANY room record — the global counter, not the
    // room row, carries the epoch invariant. Unclaimed: created but no writer
    // ever claimed (the create-flood residue). Abandoned: empty + idle.
    const unclaimed = !room.claimed && now - room.createdAt > c.unclaimedTtlMs;
    const abandoned = room.members.size === 0 && now - room.lastActivityAt > c.abandonedTtlMs;
    if (unclaimed || abandoned) {
      // Anyone still sitting in an unclaimed room gets an honest close: the
      // room expired; rejoin mints/needs a fresh one.
      for (const m of room.members.keys()) {
        state.conns.delete(m);
        effects.push({ kind: 'bounce', conn: m, code: CLOSE_NO_ROOM, reason: 'room expired' });
      }
      state.rooms.delete(name);
      collected = true;
    }
  }
  // Compaction journal (S2: NON-authority — no epoch was issued; the binding
  // may coalesce this one, and only this one).
  if (collected) effects.push({ kind: 'journal', authority: false, counter: state.grantCounter });
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
