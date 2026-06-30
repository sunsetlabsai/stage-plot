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

// The auto-fire seam (design-conductor-chunk5.md §2). Chunk 5a fills the chunk-4
// hard-OFF stub with the §3.5 gate for MANUAL advance. SAME signature (chunk-4
// frozen). The frozen hook contract ANDs in the arm-time local bit:
//   if (armedFireAtEligible && shouldAutoFire(session)) commit();
//
// Three guards, evaluated POST-advance:
//   1. `armed` present       — auto-fire only ever fires an already-telegraphed
//      change; it never invents one.
//   2. `current === fireAt`   — the playhead has ARRIVED at the fire bar. In 5a the
//      playhead moves only on the MD's manual advance, so arrival is EXACT (the §3.5
//      position gate satisfied by construction, NOT by a confidence estimate — D1).
//   3. `vm.holding == null`   — §3.5 verbatim "no unresolved hold/vamp": never
//      auto-fire a structural change while the band is parked on a vamp; the MD must
//      `release` (or go-tap) first. The one place the gate refuses even at the bar.
//
// Fires exactly once: `commit` clears `armed` (chunk-3 reducer), so the next
// post-advance evaluation sees `armed == null` → false. No latch needed.
// Clock is NOT read in 5a (D1/D2) — 5b owns the whole clock layer.
export function shouldAutoFire(session: ConductorSession): boolean {
  const s = session.state;
  const armed = s.armed;
  if (!armed) return false; // nothing telegraphed
  if (!s.current || s.current.barId !== armed.fireAt) return false; // not yet at the fire bar
  if (s.vm.holding != null) return false; // §3.5: never auto-fire through an unresolved hold/vamp
  return true; // arrival is exact (manual advance) → fire
}
