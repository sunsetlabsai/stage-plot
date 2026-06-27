import {
  type ConductorState,
  type ConductorMessage,
  type ConductorPayload,
  type ReduceOutcome,
  reduceConductor,
} from './conductor-state';
import { type CompiledRoadmap, initVM } from './roadmap-vm';

// ── Conductor authority, chunk 4: the single-device session controller (pure) ─
//
// (design-conductor-chunk4.md §1). The MD's live control surface over the chunk-3
// pure reducer. Following the chunk-1/2/3 "pure first" pattern, ALL live logic
// lives here (unit-testable in the lib gate, no jsdom); the React hook is a thin
// binding. The MD is a SINGLE WRITER, so on one device it is also its own relay:
// `dispatch` mints a message, applies it through `reduceConductor`, and keeps the
// result. That mint+loopback is the seam 3b replaces with the real fan-out.
//
// Chunk 4 introduces ZERO new wire types and ZERO changes to conductor-state.ts —
// it is a consumer. Every id it touches is LOCAL (the MD's own ChartCalibration);
// the canonical SongStructure layer is a 3b cross-chart concern (design §0 / D0).

// Everything the controller needs to mint + apply a message, with no React and no
// network. `compiled` + `programHash` are the loader-pinned program (chunk-3 D10).
export interface ConductorSession {
  state: ConductorState;
  compiled: CompiledRoadmap;
  programHash: string;
}

// Initialize the MD's own session for a chart. Single-device: epoch 0, seq 0, the
// VM seeded at the song head, nothing armed, and the canonical CLOCK-ABSENT value
// `{ tempoBpm: null, confidence: 0 }` (ConductorState.clock is REQUIRED, not
// optional — chunk-3 models absence, not undefined; chunk 5 fills it). claim /
// snapshot are 3b concerns and never arise on one device (the MD always holds the
// baton). `programHash` is the loader-computed hash of the EXACT compiled program
// (chunk-3 `programHash` helper, async, computed by the caller). `now` is injected
// (determinism; mirrors chunk-3's sentAt-is-the-only-clock).
export function initSession(
  sessionId: string,
  songRef: string,
  programHash: string,
  compiled: CompiledRoadmap,
  now: number,
): ConductorSession {
  const state: ConductorState = {
    sessionId,
    songRef,
    programHash,
    epoch: 0,
    seq: 0,
    vm: initVM(compiled),
    current: null,
    armed: null,
    clock: { tempoBpm: null, confidence: 0 },
    updatedAt: now,
  };
  return { state, compiled, programHash };
}

// The MD's intent, applied. `dispatch` is the SOLE seq-issuer: it stamps the next
// (epoch held, seq+1) + `sentAt = now`, builds the ConductorMessage, and loops it
// through `reduceConductor`. Returns the new session (state replaced on `applied`;
// session UNCHANGED on `ignored` — e.g. an arm at a bar the program doesn't have).
// Single-device never produces `needsSnapshot` (the MD applies its own contiguous
// deltas), but the generic outcome is surfaced so the UI can disable an `ignored`
// control. `now` injected per call.
export function dispatch(
  session: ConductorSession,
  payload: ConductorPayload,
  now: number,
): { session: ConductorSession; outcome: ReduceOutcome['status'] } {
  const { state, compiled, programHash } = session;
  const msg: ConductorMessage = {
    sessionId: state.sessionId,
    songRef: state.songRef,
    programHash: state.programHash,
    epoch: state.epoch,
    seq: state.seq + 1,
    sentAt: now,
    payload,
  };
  const outcome = reduceConductor(compiled, programHash, state, msg);
  if (outcome.status === 'applied') {
    return { session: { ...session, state: outcome.state }, outcome: 'applied' };
  }
  return { session, outcome: outcome.status };
}

// The auto-fire seam (design §4), defined + stubbed OFF. Chunk 4: always false
// (go-tap only). The SIGNATURE + the post-advance / `current.barId === armed.fireAt`
// / "the hook should now dispatch one commit" contract are fixed now so chunk 5
// keeps the SAME public API. HONEST scope (design §4): chunk 5 is NOT a pure
// body-swap — it replaces this body with the §3.5 confidence gate AND ANDs in the
// arm-time `fireAtEligible` result, which lives as LOCAL hook state OUTSIDE this
// predicate (the wire ConductorState stays chunk-3-frozen):
//   if (armedFireAtEligible && shouldAutoFire(session)) commit();
export function shouldAutoFire(session: ConductorSession): boolean {
  void session; // chunk 5 reads session.current/armed/clock here; chunk 4 is a hard OFF stub
  return false; // go-tap is the floor; auto-fire is a chunk-5, clock-gated luxury
}
