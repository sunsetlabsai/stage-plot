import type { ConductorMessage, ConductorState } from './conductor-state';
import {
  initClientConn,
  reduceClientConn,
  parseRelayFrame,
  canOfferClaim,
  sessionKeyEquals,
  sessionKeyOf,
  type ClientConn,
  type ClientEffect,
  type ClientFrame,
  type SessionKey,
} from './relay-protocol';

// ── Conductor authority, chunk 3b-4: the pure binding orchestrator ───────────
//
// (design-conductor-3b-discovery-failover.md §10-4). The layer between the
// FROZEN chunk-1 connection machine (`reduceClientConn` — pure routing over
// frames, no knowledge of charts) and the impure React hook (sockets, the one
// ConductorSession, async chart loads). It owns exactly the gates the conn
// machine CANNOT know, because they depend on this device's local chart:
//
//   • `localKey` — what THIS device's loaded chart hashes to (sessionId,
//     songRef, programHash). The mirror path (apply an incoming msg) and
//     snapshot adoption are executed ONLY when localKey field-wise equals the
//     room's activeSession: `reduceConductor` throws by design on a local-hash
//     mismatch, and adopting a state we can't compile would be that crash. A
//     mismatch is surfaced as the honest `chartMismatch` fact (§4.4 "chart not
//     on this device / differs on this device"), never a throw.
//   • Chart-arrived-late re-pull: a gated-away adoption cleared the machine's
//     outstanding pull, so when `local-ready` lands ON the active key the
//     binding force-feeds `needsSnapshot` — the pull re-opens (idempotent) and
//     the mirror converges without waiting for the next delta's gap.
//   • Claim gated on having a chart: a writer with nothing to announce is a
//     headless room by another name — `request-claim` no-ops until localKey
//     exists (and `relayFacts.canClaim` says so honestly).
//   • Writer re-announce (§4.4): a `local-ready` whose key differs from the
//     announced activeSession while we hold the baton IS a session switch
//     (next song, or a mid-song recompile — new programHash, same sessionId).
//   • The §4.1-3 grant sequence, order pinned PURELY: became-writer →
//     `accept-baton` effect → the hook mints via acceptBaton and feeds back
//     `baton-accepted` → the binding emits announce `session`, the snapshot
//     upload, and the `claim` broadcast — in that order, on one socket.
//
// Same shape discipline as chunks 1/3: pure reducer over inputs, effects out,
// zero sockets, zero React, zero ConductorState authority (the chunk-3a
// reducer stays the only one; this layer only decides WHETHER to invoke it).

export interface RelayBinding {
  conn: ClientConn;
  localKey: SessionKey | null; // null until the hook's session (chart+hash) is ready
}

export function initRelayBinding(): RelayBinding {
  return { conn: initClientConn(), localKey: null };
}

// Everything that can move the binding: the wire (unparsed — the trust boundary
// lives HERE, §6 rule 5), the hook's session lifecycle, the mirror's outcome
// feedback, the writer's applied dispatches (fan-out seam), the grant/serve
// feedback loops, local intents, and the heartbeat tick.
export type BindingInput =
  | { kind: 'raw-frame'; raw: unknown }
  | { kind: 'local-ready'; key: SessionKey } // the hook's session (re)initialized to this key
  | { kind: 'local-gone' } // chart unloaded / conductor disabled
  | { kind: 'mirror-outcome'; outcome: 'applied' | 'ignored' | 'needsSnapshot' }
  | { kind: 'applied-msg'; msg: ConductorMessage } // a local dispatch APPLIED (dispatch's fan-out seam)
  | { kind: 'baton-accepted'; key: SessionKey; state: ConductorState; claim: ConductorMessage }
  | { kind: 'serve-state'; requestId: string; state: ConductorState }
  | { kind: 'request-claim' }
  | { kind: 'release-baton' }
  | { kind: 'hb-tick' };

// What the hook must DO. apply-mirror / adopt-snapshot / accept-baton /
// serve-snapshot all operate on the hook's ONE ConductorSession; switch-session
// is a page-level fact (open that chart — chunk 5 wires the navigation).
export type BindingEffect =
  | { kind: 'send'; frame: ClientFrame }
  | { kind: 'apply-mirror'; msg: ConductorMessage } // reduceConductor it; feed back mirror-outcome
  | { kind: 'adopt-snapshot'; state: ConductorState; stale: boolean } // replace the session state
  | { kind: 'accept-baton'; epoch: number } // acceptBaton(session, epoch); feed back baton-accepted
  | { kind: 'serve-snapshot'; requestId: string } // reply with current state; feed back serve-state
  | { kind: 'switch-session'; session: SessionKey } // the room moved charts; surface to the page
  | { kind: 'demoted'; epoch: number } // we are not the writer anymore (zombie / funeral)
  | { kind: 'bad-frame' }; // wire garbage — dropped at the boundary (telemetry hook)

export interface BindingReduction {
  binding: RelayBinding;
  effects: BindingEffect[];
}

// The honest UI facts the hook mirrors into React state (doc §4.3/§7).
export interface RelayFacts {
  phase: ClientConn['phase'];
  canClaim: boolean; // follower && !hasWriter && a chart is loaded to conduct
  conductorLost: boolean; // orphan banner
  conductorLabel: string | null; // "X is conducting" (§4.3); null = unknown/none/us
  activeSession: SessionKey | null;
  // The room is running a session this device can't mirror: no chart loaded, a
  // different chart, or the same chart compiled to a different programHash
  // (needs sync / recalibrated elsewhere). Honesty banner, never a wrong chart.
  chartMismatch: boolean;
  // Cloud-relay D4: the relay-reported room code (creator adopts it; the QR
  // renders from it). null until admitted.
  room: string | null;
}

export function relayFacts(b: RelayBinding): RelayFacts {
  return {
    phase: b.conn.phase,
    canClaim: canOfferClaim(b.conn) && b.localKey !== null,
    conductorLost: b.conn.conductorLost,
    conductorLabel: b.conn.writerLabel,
    activeSession: b.conn.activeSession,
    chartMismatch:
      b.conn.activeSession !== null && !sessionKeyEquals(b.conn.activeSession, b.localKey),
    room: b.conn.room,
  };
}

// Forward-only along the authority coordinates (epoch, then seq within an
// epoch — the reducer's own admission order). This is the comparator for the
// STALE regime of `shouldAdoptSnapshot` (below); it is meaningful only when
// both states sit on the same writer timeline.
export function stateSupersedes(
  candidate: { epoch: number; seq: number },
  current: { epoch: number; seq: number },
): boolean {
  return (
    candidate.epoch > current.epoch ||
    (candidate.epoch === current.epoch && candidate.seq > current.seq)
  );
}

// Should an incoming snapshot REPLACE the local session state? TWO authority
// regimes, told apart by the wire's `stale` flag (chunk-3 relay semantics):
//
//  • FRESH (stale: false) — authored by the room's LIVE writer answering this
//    pull. Within a session the live writer is THE authority (single-writer,
//    doc §2), so a fresh snapshot is adopted UNCONDITIONALLY. The case that
//    makes this load-bearing (Codex chunk-4 R1 HIGH): a follower that lost its
//    socket self-drove meanwhile — the self-drive floor deliberately allows it
//    ('joining' does not block local dispatch) — minting seqs on a FORK that
//    is not on the writer's timeline. Coordinate comparison across that fork
//    boundary is meaningless (equal-or-higher local coords can hide a divergent
//    position), and rejecting the writer's snapshot would strand the device:
//    every later delta lands `ignored` (seq ≤ local) — a silently frozen
//    mirror. The rejoin pull is mandatory (`joined` always pulls the active
//    session), so unconditional fresh adoption is the fork-crushing door.
//  • STALE (stale: true) — the relay's claim-time cache, served only when NO
//    writer is live: unattributed, so forward-only applies (stateSupersedes).
//    The case that makes THIS load-bearing (doc §4.2): an EX-WRITER reconnects
//    and its join-pull is answered by that cache, which is BEHIND the freshest
//    state in the room — adopting it would rewind the one device that's right.
export function shouldAdoptSnapshot(
  stale: boolean,
  candidate: { epoch: number; seq: number },
  current: { epoch: number; seq: number },
): boolean {
  return stale ? stateSupersedes(candidate, current) : true;
}

const noop = (binding: RelayBinding): BindingReduction => ({ binding, effects: [] });

// Run the conn machine and translate its effects through the localKey gates.
function throughMachine(
  b: RelayBinding,
  input: Parameters<typeof reduceClientConn>[1],
): BindingReduction {
  const r = reduceClientConn(b.conn, input);
  const next: RelayBinding = { ...b, conn: r.conn };
  const effects: BindingEffect[] = [];
  for (const eff of r.effects) {
    effects.push(...mapEffect(next, eff));
  }
  return { binding: next, effects };
}

function mapEffect(b: RelayBinding, eff: ClientEffect): BindingEffect[] {
  switch (eff.kind) {
    case 'send':
      return [{ kind: 'send', frame: eff.frame }];
    case 'switch-session':
      return [{ kind: 'switch-session', session: eff.session }];
    // The localKey gate (the whole reason this layer exists): only mirror /
    // adopt what this device's loaded program can actually reduce. A dropped
    // adoption is healed by `local-ready`'s force-pull (below) or, at worst,
    // the next delta's seq gap → needsSnapshot → pull (the one recovery door).
    case 'adopt-snapshot':
      return sessionKeyEquals(sessionKeyOf(eff.state), b.localKey)
        ? [{ kind: 'adopt-snapshot', state: eff.state, stale: eff.stale }]
        : [];
    case 'reduce-msg':
      return sessionKeyEquals(b.conn.activeSession, b.localKey)
        ? [{ kind: 'apply-mirror', msg: eff.msg }]
        : [];
    case 'became-writer':
      return [{ kind: 'accept-baton', epoch: eff.epoch }];
    // The relay only forwards requests matching the writer's announced
    // activeSession (chunk-3 rule), which the writer announced from its own
    // localKey — no extra gate to apply.
    case 'serve-snapshot':
      return [{ kind: 'serve-snapshot', requestId: eff.requestId }];
    case 'demoted':
      return [{ kind: 'demoted', epoch: eff.epoch }];
  }
}

export function reduceBinding(b: RelayBinding, input: BindingInput): BindingReduction {
  switch (input.kind) {
    // The wire trust boundary, client side (§6 rule 5). Garbage never reaches
    // the conn machine — mirrors the relay's parseClientFrame → 4002, except a
    // client drops rather than closes (the relay is OUR box; a bad frame off it
    // is a bug to survive, not a peer to eject).
    case 'raw-frame': {
      const frame = parseRelayFrame(input.raw);
      if (frame === null) return { binding: b, effects: [{ kind: 'bad-frame' }] };
      return throughMachine(b, { kind: 'frame', frame });
    }

    // The hook's session came up (or re-keyed: chart switch, recompile,
    // recalibration — any of which mints a new programHash and therefore a new
    // key, §4.4).
    case 'local-ready': {
      const next: RelayBinding = { ...b, localKey: input.key };
      // Writer: an unannounced key IS a session switch — (re-)announce (§4.4).
      // Idempotent on the same key (the machine's announce just re-sends; the
      // relay re-broadcast is the doc's idempotent mid-song re-announce).
      if (b.conn.phase === 'writer' && !sessionKeyEquals(b.conn.activeSession, input.key)) {
        return throughMachine(next, { kind: 'announce-session', session: input.key });
      }
      // Follower whose chart just arrived ON the active key: the earlier
      // adoption (if any) was gated away and its pull consumed — force the
      // pull back open so the mirror converges NOW, not at the next delta.
      // (pull() is idempotent per key, so a still-outstanding pull is a no-op.)
      if (
        b.conn.phase === 'follower' &&
        b.conn.activeSession !== null &&
        sessionKeyEquals(b.conn.activeSession, input.key)
      ) {
        return throughMachine(next, { kind: 'mirror-outcome', outcome: 'needsSnapshot' });
      }
      return noop(next);
    }

    case 'local-gone':
      return noop({ ...b, localKey: null });

    // The mirror's verdict on an applied msg loops back through the machine —
    // needsSnapshot is how a seq gap / future epoch / claim opens the pull.
    case 'mirror-outcome':
      return throughMachine(b, { kind: 'mirror-outcome', outcome: input.outcome });

    // dispatch()'s fan-out seam. Only the writer broadcasts; a locally-applied
    // msg on any other phase is a hook-gate bug surfacing here as silence
    // (defense in depth — the hook hard-gates local dispatch off-writer).
    case 'applied-msg':
      if (b.conn.phase !== 'writer') return noop(b);
      return { binding: b, effects: [{ kind: 'send', frame: { type: 'msg', msg: input.msg } }] };

    // The §4.1-3 grant sequence, in pinned order on the one socket: announce
    // the session (through the machine, so conn.activeSession is OUR key),
    // upload the claim-time snapshot (the relay's stale-cache seed), then
    // broadcast the claim (rides `msg`; epoch := granted, seq 0 — every
    // follower's epoch gate routes it to needsSnapshot → they pull this very
    // snapshot).
    case 'baton-accepted': {
      if (b.conn.phase !== 'writer') return noop(b); // grant raced a demote — stale feedback
      const next: RelayBinding = { ...b, localKey: input.key };
      const announced = throughMachine(next, { kind: 'announce-session', session: input.key });
      return {
        binding: announced.binding,
        effects: [
          ...announced.effects,
          { kind: 'send', frame: { type: 'snapshot', state: input.state } },
          { kind: 'send', frame: { type: 'msg', msg: input.claim } },
        ],
      };
    }

    // serve-snapshot's feedback leg: the hook read its current state; route it
    // back with the relay's requestId (still writer-gated — a demote between
    // effect and feedback is same-tick impossible in the hook, but pure layers
    // don't rely on caller timing).
    case 'serve-state':
      if (b.conn.phase !== 'writer') return noop(b);
      return {
        binding: b,
        effects: [
          {
            kind: 'send',
            frame: { type: 'snapshot', requestId: input.requestId, state: input.state },
          },
        ],
      };

    // Claim gated on having a chart to conduct (see header). The machine
    // additionally gates on phase === 'follower'.
    case 'request-claim':
      if (b.localKey === null) return noop(b);
      return throughMachine(b, { kind: 'request-claim' });

    case 'release-baton':
      return throughMachine(b, { kind: 'release-baton' });

    // The writer's lease heartbeat (§4.2). The hook ticks unconditionally on
    // its interval; the gate lives here so it is pure-tested.
    case 'hb-tick':
      if (b.conn.phase !== 'writer') return noop(b);
      return { binding: b, effects: [{ kind: 'send', frame: { type: 'hb' } }] };
  }
}
