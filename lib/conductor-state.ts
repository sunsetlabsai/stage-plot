import type { RoadmapMarker } from './types';
import {
  type CompiledRoadmap,
  type VMState,
  type TraversalStep,
  type Directive,
  stepVM,
  applyOverride,
} from './roadmap-vm';

// ── Conductor authority, chunk 3a: the pure shared state machine ──────────────
//
// (design-conductor-chunk3.md). The MD owns one ConductorState; `reduceConductor`
// is how every directive mutates it; followers run the SAME reducer on the SAME
// messages and converge. Zero network, zero React — the pure core, mirroring the
// chunk-1/2 "pure first" pattern. Transport (own-AP relay, discovery, the claim
// wire protocol) is chunk 3b, gated on parent §8.2-2.
//
// Two hard rules the whole design turns on:
//   • Messages are DELTAS, not snapshots — admission must be CONTIGUOUS, and any
//     gap routes to `needsSnapshot` (the one late-join recovery door).
//   • The state's numeric indices (vm.cursor, counters, fired flags) are meaningful
//     ONLY against the exact compiled roadmap — so the program is PINNED by
//     `programHash` and the reducer fails closed on any mismatch.

// ── Types ────────────────────────────────────────────────────────────────────

// The authoritative shared state. The MD owns it; followers mirror it verbatim.
export interface ConductorState {
  sessionId: string;
  songRef: string;        // which SongStructure this VM runs on (song identity)
  programHash: string;    // D10: identity of the EXACT compiled program the indices
                          // below run against. The session is bound to an immutable
                          // (songRef, programHash); a structure edit ends the session.
  epoch: number;          // baton generation; a higher-epoch claim forces a re-base
  seq: number;            // monotonic per-epoch, MD-only; orders + supersedes
  vm: VMState;            // the chunk-2 resumable seed (the NEXT-step state)
  current: TraversalStep | null;  // the last bar the VM EMITTED — what renderers display
  armed: Armed | null;    // pending telegraphed change (advisory display)
  clock: ClockState;      // MD-re-emitted tempo telemetry (chunk 5 fills it)
  updatedAt: number;      // = the admitted message's sentAt (MD clock); display/debug only
}

export interface Armed {
  fireAt: string;                                     // barId where the change commits
  directive: Extract<Directive, { kind: 'jumpTo' }>;  // armable directive (widens in ch4)
}

export interface ClockState {
  tempoBpm: number | null;
  downbeatAt?: number;
  confidence: number;     // 0 when absent
}

// The wire unit. Carries the authority coordinates AND the (session, song, program)
// it scopes to — the reducer fails closed on a cross-room / cross-revision / replayed
// message. This is SCOPING, not authentication (sender authenticity is a relay job).
export interface ConductorMessage {
  sessionId: string;
  songRef: string;
  programHash: string;
  epoch: number;
  seq: number;            // ignored for `claim` (a claim → needsSnapshot); required otherwise
  sentAt: number;         // MD wall clock at emit — the ONLY time source; copied to updatedAt
  payload: ConductorPayload;
}

export type ConductorPayload =
  | { kind: 'claim' }                              // baton (re)claim — a SNAPSHOT BOUNDARY
  | { kind: 'advance' }                            // normal playhead motion (the only stepVM caller)
  | { kind: 'redirect'; directive: Directive }     // immediate VM redirect (wraps chunk-2 Directive)
  | { kind: 'arm'; armed: Armed }                  // drop a telegraphed change marker
  | { kind: 'commit' }                             // fire the currently-armed change ("go now")
  | { kind: 'disarm' }                             // MD cancels a pending change
  | { kind: 'clock'; clock: ClockState };          // MD-re-emitted clock telemetry

// The reducer CANNOT return bare state: transport (3b) must distinguish "nothing to
// do" from "I am behind — pull a snapshot," or a dropped delta diverges a follower.
export type ReduceOutcome =
  | { status: 'applied'; state: ConductorState }       // admitted; state advanced
  | { status: 'ignored'; state: ConductorState }       // stale / dup / mismatch — UNCHANGED
  | { status: 'needsSnapshot'; state: ConductorState }; // re-base needed — UNCHANGED; pull a snapshot

// ── programHash: pin the exact compiled program (D10) ────────────────────────
// `serializeProgram` is the canonical, deterministic encoding; `programHash` is its
// SHA-256. Two devices compiling the SAME (bars, markers) MUST agree byte-for-byte,
// else they would fail closed needlessly (a false-mismatch, not a wrong-note risk).
// Identity-determining inputs only: bar ORDER (what cursor indexes) + the roadmap
// markers. `confidence` (converter metadata) is deliberately excluded.

const FIELD = '\u001f'; // within a marker
const RECORD = '\u001e'; // between markers
const SECTION = '\u0000'; // between the prefix / bars / markers sections
const SCHEMA = 'chunk3-v1';

// Total order independent of input order: marker position (CANONICAL bar order, the
// same index space cursor runs on), then kind, then unique id. An ending's position is
// its MINIMUM canonical bar index — barId text is NOT a stable order (lexicographic
// "b10" < "b9"), and the input barIds array may be permuted device-to-device.
function markerSortKey(m: RoadmapMarker, barPos: Map<string, number>): [number, string, string] {
  const pos = m.kind === 'ending'
    ? Math.min(...m.barIds.map((b) => barPos.get(b) ?? Infinity))
    : barPos.get(m.barId) ?? Infinity;
  return [pos, m.kind, m.id];
}

// Fixed field order per kind; inner arrays normalized so input order never matters.
function encodeMarker(m: RoadmapMarker, barPos: Map<string, number>): string {
  switch (m.kind) {
    case 'repeatStart':
      return ['repeatStart', m.id, m.barId, m.edge].join(FIELD);
    case 'repeatEnd':
      return ['repeatEnd', m.id, m.barId, m.edge, m.repeatStartId, m.times === undefined ? '' : String(m.times)].join(FIELD);
    case 'ending':
      // barIds normalized to CANONICAL bar order (compileRoadmap sorts the span the same
      // way at roadmap-vm.ts:231) so a permuted input array hashes identically; numbers
      // normalized ascending.
      return ['ending', m.id, m.repeatStartId,
        [...m.barIds].sort((a, b) => (barPos.get(a) ?? Infinity) - (barPos.get(b) ?? Infinity)).join(','),
        [...m.numbers].sort((a, b) => a - b).join(',')].join(FIELD);
    case 'segno':
      return ['segno', m.id, m.barId, m.edge].join(FIELD);
    case 'coda':
      return ['coda', m.id, m.barId, m.edge].join(FIELD);
    case 'toCoda':
      return ['toCoda', m.id, m.barId, m.edge].join(FIELD);
    case 'fine':
      return ['fine', m.id, m.barId, m.edge].join(FIELD);
    case 'jump':
      return ['jump', m.id, m.barId, m.edge, m.from, m.until].join(FIELD);
  }
}

export function serializeProgram(bars: { id: string }[], markers: RoadmapMarker[]): string {
  // The canonical index space cursor runs on: bar ORDER. Sort/encode endings against it.
  const barPos = new Map(bars.map((b, i) => [b.id, i]));
  const barPart = bars.map((b) => b.id).join(FIELD);
  const markerPart = [...markers]
    .sort((a, b) => {
      const ka = markerSortKey(a, barPos);
      const kb = markerSortKey(b, barPos);
      for (let i = 0; i < 3; i++) {
        if (ka[i] < kb[i]) return -1;
        if (ka[i] > kb[i]) return 1;
      }
      return 0;
    })
    .map((m) => encodeMarker(m, barPos))
    .join(RECORD);
  return [SCHEMA, barPart, markerPart].join(SECTION);
}

export async function programHash(bars: { id: string }[], markers: RoadmapMarker[]): Promise<string> {
  const bytes = new TextEncoder().encode(serializeProgram(bars, markers));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ── reduceConductor: the single authority gate (pure) ────────────────────────

export function reduceConductor(
  compiled: CompiledRoadmap,
  programHashArg: string,
  state: ConductorState,
  msg: ConductorMessage,
): ReduceOutcome {
  // Local invariant (D10): the loader handed a `compiled` matching the state it is
  // reducing. A mismatch is a PROGRAMMER error (not a runtime condition) — throw
  // before any admission, so a wrong program can never corrupt the indices.
  if (programHashArg !== state.programHash) {
    throw new Error(
      'reduceConductor: local programHash does not match state.programHash — the loader compiled the wrong structure',
    );
  }

  // 3.1.1 — session / song / program scope. Fail closed on a cross-room /
  // cross-revision / replayed message (the reducer never trusts transport to scope).
  if (
    msg.sessionId !== state.sessionId ||
    msg.songRef !== state.songRef ||
    msg.programHash !== state.programHash
  ) {
    return { status: 'ignored', state };
  }

  // 3.1.2 — claim is a SNAPSHOT BOUNDARY, never a follower-applicable delta. A
  // higher-epoch claim routes to a snapshot (local vm may be stale on the old epoch);
  // an equal/lower claim is a replay no-op. The reducer never adopts a claim.
  if (msg.payload.kind === 'claim') {
    return msg.epoch > state.epoch
      ? { status: 'needsSnapshot', state }
      : { status: 'ignored', state };
  }

  // 3.1.3 — stale epoch.
  if (msg.epoch < state.epoch) return { status: 'ignored', state };
  // 3.1.4 — future non-claim epoch: missed-claim vs forgery is indistinguishable
  // here, so fail SAFE (snapshot) not silent. Forgery is rejected by the relay (3b).
  if (msg.epoch > state.epoch) return { status: 'needsSnapshot', state };

  // 3.1.5 — same epoch: seq must be contiguous.
  if (msg.seq <= state.seq) return { status: 'ignored', state };       // dup / reorder
  if (msg.seq > state.seq + 1) return { status: 'needsSnapshot', state }; // gap

  // Admitted (the next in-order delta).
  return applyAdmitted(compiled, state, msg);
}

// 3.2 — payload application. Only reached for an admitted, same-epoch, contiguous,
// non-claim message. Pure: builds a fresh state, never mutates `state`.
function applyAdmitted(compiled: CompiledRoadmap, state: ConductorState, msg: ConductorMessage): ReduceOutcome {
  const base: ConductorState = { ...state, seq: msg.seq, updatedAt: msg.sentAt };
  const p = msg.payload;

  switch (p.kind) {
    case 'advance': {
      const r = stepVM(compiled, state.vm);
      return { status: 'applied', state: { ...base, vm: r.state, current: r.transition ?? state.current } };
    }

    case 'redirect':
      // Moves the next-step seed only; `current` re-emits on the following advance.
      return { status: 'applied', state: { ...base, vm: applyOverride(compiled, state.vm, p.directive) } };

    case 'arm':
      // Never store a marker that points at no bar (a poison pill commit can't honor).
      if (!compiled.barPos.has(p.armed.directive.barId)) return { status: 'ignored', state };
      return { status: 'applied', state: { ...base, armed: p.armed } };

    case 'disarm':
      return { status: 'applied', state: { ...base, armed: null } };

    case 'commit': {
      if (state.armed === null) return { status: 'applied', state: base }; // nothing armed — VM no-op
      // Defensive re-validation: a corrupt/stale target (e.g. via snapshot) must NOT
      // advance one normal bar (chunk-2 no-ops unknown jumpTo). Clear armed, no step.
      if (!compiled.barPos.has(state.armed.directive.barId)) {
        return { status: 'applied', state: { ...base, armed: null } };
      }
      // "Go now": apply the armed jumpTo AND step once, so the committed position is
      // a REAL emitted bar visible to a mid-cue joiner; armed cleared.
      const afterOverride = applyOverride(compiled, state.vm, state.armed.directive);
      const r = stepVM(compiled, afterOverride);
      return { status: 'applied', state: { ...base, vm: r.state, current: r.transition ?? state.current, armed: null } };
    }

    case 'clock':
      return { status: 'applied', state: { ...base, clock: p.clock } };

    case 'claim':
      // Unreachable: claim is fully handled in reduceConductor's admission gate and
      // never reaches payload application. Present for switch exhaustiveness.
      return { status: 'ignored', state };
  }
}
