import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChartCalibration } from './types';
import { barsInOrder, type TraversalStep } from './chart-calibration';
import { compileRoadmap, type CompiledRoadmap, type ExitPolicy } from './roadmap-vm';
import {
  programHash as computeProgramHash,
  reduceConductor,
  type ConductorState,
  type ConductorPayload,
  type ReduceOutcome,
  type Armed,
} from './conductor-state';
import {
  initSession,
  dispatch,
  shouldAutoFire,
  acceptBaton,
  type ConductorSession,
} from './conductor-session';
import { helloFrame, initClientConn, sessionKeyOf, type SessionKey } from './relay-protocol';
import {
  initRelayBinding,
  reduceBinding,
  relayFacts,
  stateSupersedes,
  type RelayBinding,
  type BindingInput,
  type RelayFacts,
} from './relay-binding';
import {
  initReckoning,
  reckonAfter,
  alignReckoning,
  computeStaticRung,
  clockConfidenceOk,
  rebaselineMotion,
  expectedClockBars,
  type ClockReckoning,
  type ClockRung,
} from './conductor-clock';
import { barMs, DEFAULT_BAR_BEATS } from './tempo';
import { useTempoDetector, type TempoDetectorStatus } from './use-tempo-detector';
import {
  initTelemetryState,
  ingestTelemetry,
  type ClockTelemetryState,
  type TempoTelemetry,
} from './tempo-telemetry';
import {
  armableTargets,
  availableRedirects,
  resolveArm,
  nextEmittedBarId,
  nextSectionBoundaryBarId,
  type JumpTarget,
  type RedirectOption,
} from './conductor-targets';

// ── Conductor authority, chunk 4: the React binding ──────────────────────────
//
// (design-conductor-chunk4-ui.md). A THIN hook over the already-built, frozen pure
// controller (lib/conductor-session.ts) + enumerators (lib/conductor-targets.ts).
// ALL logic that matters lives in those libs; this hook holds the one React state
// (the ConductorSession), owns the async programHash, and surfaces the pure
// enumerators as memoized reads. The component renders exactly its output and can
// emit nothing else — validity lives in the pure layer, never in React.

// 5b chunk 2: the motion driver's interval period (§3 / §12-Q2). Small relative to the
// shortest bar (at 400 bpm 4/4 barMs = 600), so every bar resolves with margin. NOT
// load-bearing for correctness — the driverRef gate closes the batching race at any tick
// rate (§3.2) — only for resolution; tune in UAT.
const CLOCK_TICK_MS = 80;

// 5b chunk 2 (Codex R6): the free-running motion interval is a MACROTASK. Any input it consumes
// that is synchronized through a PASSIVE useEffect has a race window — a due interval can fire in
// the gap between React's commit and the (later, separate-macrotask) passive flush, reading the
// STALE value. The fix for the whole class is to synchronize every such input in the COMMIT phase
// via a LAYOUT effect (runs synchronously before control yields to the event loop, so no due timer
// can interleave). On the server, effects never run, so useEffect is behaviorally identical and
// avoids the useLayoutEffect SSR warning.
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

// 3b chunk 4: the socket seam. Structurally satisfied by the browser WebSocket;
// tests inject a factory (a fake, or the `ws` client against a loopback relay).
export interface RelaySocket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
}

export interface RelayConfig {
  url: string; // wss://relay.showrunr.ai:8787 (doc §1a)
  room: string; // show slug (doc §3)
  code: string; // the rotating room code (D3)
  deviceLabel: string; // claim attribution ("Rachel is conducting")
  socketFactory?: (url: string) => RelaySocket; // test seam; default = browser WebSocket
}

export interface UseConductorArgs {
  // isOwner && the MD turned on "Local MD mode" && a performable bar-cal is loaded.
  enabled: boolean;
  // Stable per (chart-in-show); changing it mints a fresh session (Q1).
  sessionId: string;
  // The chart/song identity for this session.
  songRef: string;
  // The MD's LOCAL chart (D0). compiled + programHash both derive from THIS, so they
  // can never come from divergent inputs (the reducer fails closed on a hash mismatch).
  cal: ChartCalibration | null;
  // 5b chunk 2: the conducted song's stated tempo (the static-BPM rung's source). null /
  // undefined (legacy/inline song, no migrated tempo) ⇒ manual rung (honest floor).
  bpm?: number | null;
  // 5b chunk 2: bar length in beats. timeSig is NOT exposed to Perform yet (route strips
  // source_spec), so callers default to 4/4 (DEFAULT_BAR_BEATS); honoring non-4/4 is a follow-on.
  barBeats?: number;
  // 3b chunk 4: bind this session to a room relay. Absent/null = the shipped
  // single-device behaviour, byte-for-byte (role 'local').
  relay?: RelayConfig | null;
}

// 5b chunk 4a: one row of the shadow validation log (§5) — a detected-vs-stated sample the
// MD can eyeball over a real rehearsal before any audio is allowed to drive (4b).
export interface ValidationLogEntry {
  tMs: number; // MD-clock instant of the estimate
  detectedBpm: number; // the raw emitted tempo for this estimate
  confidence: number; // [0,1] the detector's self-report
  statedBpm: number | null; // the song's stated tempo at the time (null ⇒ no migrated tempo)
}

// Cap the in-memory validation log so a long rehearsal can't grow it unbounded (§5).
const VALIDATION_LOG_CAP = 600;

// 3b chunk 4: the writer's app-level heartbeat period. Half the relay's lease
// HB_MS (2000, doc §4.2) so a single delayed tick never costs a lease miss.
const RELAY_HB_MS = 1000;
// Reconnect backoff after a socket drop (failure matrix row 1: reconnect →
// hello → pull). Flat, not exponential — the relay is the band's own box on the
// band's own AP; the only recovery is it coming back.
const RELAY_RECONNECT_MS = 1500;

// 3b chunk 4: the relay-facing slice of the surface (doc §4.3/§7 honesty).
export interface RelaySurface {
  status: 'off' | 'connecting' | 'joined';
  role: 'local' | 'writer' | 'follower'; // follower = the wire owns this session's motion
  canClaim: boolean; // "Take the baton" affordance (follower && !hasWriter && chart ready)
  conductorLost: boolean; // orphan banner
  activeSession: SessionKey | null; // what the room is running (page switches charts on it)
  chartMismatch: boolean; // room session ≠ this device's chart — honesty banner, no mirror
  requestClaim: () => void;
  releaseBaton: () => void;
}

export interface ConductorSurface {
  active: boolean;
  state: ConductorState | null;
  current: TraversalStep | null; // = state.current — the bar to redline (§1)
  armed: Armed | null;
  done: boolean; // vm.done — song end; advance/arm disabled (§3 guard)
  targets: JumpTarget[];
  redirects: RedirectOption[];
  autoFireOn: boolean; // §3 opt-in toggle (default OFF = chunk-4 behaviour)
  setAutoFire: (on: boolean) => void;
  canArmNextSection: boolean; // §4 — a next-section boundary exists ahead of the cursor
  // 5b chunk 1: the MD-LOCAL position-trust bookkeeping (parent §5.1b). Read-only here;
  // chunk 3 (the confidence gate) is its first consumer. Never on the wire.
  reckoning: ClockReckoning;
  // 5b chunk 2: the static-BPM motion driver surface (all MD-local, never broadcast).
  clockOn: boolean; // the Clock opt-in toggle (default OFF — the 5a manual floor is default)
  setClockOn: (on: boolean) => void;
  rung: ClockRung; // computeStaticRung — 'static-bpm' when self-driving, else 'manual'
  stalled: boolean; // the loop saw ≥2 bars owed (suspended) and froze; cleared by an align
  advance: () => void;
  arm: (t: JumpTarget, exit?: ExitPolicy['kind'], fireAt?: 'next-bar' | 'next-section') => void;
  commit: () => void;
  disarm: () => void;
  redirect: (opt: RedirectOption) => void;
  // 5b chunk 1: the align / true-up tap — "we are on this bar's downbeat, now." Seeds bar 1
  // at the start (= first manual advance) or re-zeros the timing baseline mid-song off the
  // wire (no dispatch / seq / broadcast).
  align: () => void;
  outcome: ReduceOutcome['status'] | null;
  // 5b chunk 4a: the tempo detector's SHADOW channel (§5). The detector runs behind a
  // user gesture and ingests telemetry into a synchronous ref, but DRIVES NOTHING — the
  // motion driver + rung above are byte-unchanged in 4a. `shadow` is the latest
  // detected-vs-stated readout; `validationLog` is the rolling comparison the MD eyeballs
  // before opting any audio into driving (4b). Mic audio is processed in-process and never
  // leaves the device; enabling is explicit and revocable.
  micStatus: TempoDetectorStatus;
  micError: string | null;
  enableMicDetection: () => void; // MUST originate from a user gesture (iOS)
  disableMicDetection: () => void;
  shadow: { detectedBpm: number; confidence: number; statedBpm: number | null } | null;
  validationLog: ValidationLogEntry[];
  clearValidationLog: () => void;
  // 3b chunk 4: the relay slice — status 'off' with role 'local' when no relay
  // is configured (the shipped single-device behaviour).
  relay: RelaySurface;
}

export function useConductorSession(args: UseConductorArgs): ConductorSurface {
  const { enabled, sessionId, songRef, cal } = args;
  // 5b chunk 2: normalize the tempo source (undefined legacy/inline song ⇒ null) and the
  // bar length (timeSig not exposed to Perform yet ⇒ 4/4 default).
  const bpm = args.bpm ?? null;
  const barBeats = args.barBeats ?? DEFAULT_BAR_BEATS;
  // 3b chunk 4: destructure the relay config to FIELDS so the socket effect keys
  // on values, not the (possibly per-render) config object identity.
  const relayCfg = args.relay ?? null;
  const relayOn = relayCfg !== null;
  const relayUrl = relayCfg?.url ?? null;
  const relayRoom = relayCfg?.room ?? null;
  const relayCode = relayCfg?.code ?? null;
  const relayLabel = relayCfg?.deviceLabel ?? null;
  const relaySocketFactory = relayCfg?.socketFactory ?? null;

  // compiled is sync + pure over the local chart; null when the roadmap can't compile.
  const compiled = useMemo<CompiledRoadmap | null>(() => {
    if (!cal) return null;
    const r = compileRoadmap(barsInOrder(cal), cal.roadmap ?? []);
    return r.ok ? r.compiled : null;
  }, [cal]);

  const [session, setSession] = useState<ConductorSession | null>(null);
  const [outcome, setOutcome] = useState<ReduceOutcome['status'] | null>(null);
  // §3 auto-fire is opt-in, default OFF (D3) — purely local UI state, never on the wire.
  const [autoFireOn, setAutoFireOn] = useState(false);
  // 5b chunk 2: the Clock motion opt-in (default OFF, §2) and the stall flag (§3.1 ≥2 owed).
  // Both MD-local, reset on identity change / disable (per-session, §12-Q4). Orthogonal to
  // autoFireOn — clock auto-ADVANCE and auto-COMMIT are independent.
  const [clockOn, setClockOn] = useState(false);
  const [stalled, setStalled] = useState(false);
  // §1/§3.1 arm-time forward reachability of the fire bar. Invariantly true in 5a (the
  // walk that picked the fire bar IS the proof), kept to honour the frozen contract
  // `if (armedFireAtEligible && shouldAutoFire(...))` and stays load-bearing in 5b. Set
  // true only AFTER an arm succeeds; cleared on commit/disarm/identity change — NOT on
  // redirect (R1/R3: a release is a redirect, so clearing it there would disable the
  // hold→release→fire path; a non-firing redirect must preserve the latch).
  const [armedFireAtEligible, setArmedFireAtEligible] = useState(false);

  // 5b chunk 1: the MD-LOCAL ClockReckoning (parent §5.1b). Re-initialized on identity
  // change / disable in the SAME two places as armedFireAtEligible (same deferred discipline
  // for the react-hooks/set-state-in-effect rule). reckonAfter (Invariant (P)) threads it
  // through every dispatch seam; the align action re-zeros it. Never broadcast (§9).
  const [reckoning, setReckoning] = useState<ClockReckoning>(() => initReckoning(Date.now()));

  // 5b chunk 2 (§3.2): the AUTHORITATIVE, synchronously-written driver transaction —
  // { session, reckoning, stalled } — that the motion loop reads AND writes. Refs are not
  // subject to React batching, so this (NOT committed React state) is the loop's source of
  // truth + its re-entrancy gate: a second tick firing before a React commit reads the
  // already-advanced ref and computes owed = 0. EVERY mutation seam (the manual run /
  // applyWithAutoFire / align, the resets, the tempo detector, AND the tick) writes this
  // synchronously BEFORE mirroring to setState — that uniformity IS the invariant. Seeded
  // from the first render's state (session null, fresh reckoning, not stalled).
  const driverRef = useRef<{
    session: ConductorSession | null;
    reckoning: ClockReckoning;
    stalled: boolean;
  }>({ session, reckoning, stalled });
  // A SEPARATE ref for the tick's non-transaction config (bpm/barBeats feed barMs + the in-tick
  // tempo reconcile). Mirrored in a LAYOUT effect (Codex R6 HIGH 2) — NOT a passive one: a passive
  // mirror leaves a window where a due interval fires after the bpm-prop commit but before the
  // passive flush, reading the OLD bpm against the OLD baseline (a stale old-tempo advance instead
  // of a reconcile). The layout write lands in the commit, so every post-commit tick sees the
  // current tempo. NOT written during render (react-hooks/refs bans ref.current there) and NOT the
  // driver transaction (only written at mutation seams, so a re-render can't clobber an in-flight advance).
  const cfgRef = useRef({ bpm, barBeats });
  useIsomorphicLayoutEffect(() => {
    cfgRef.current = { bpm, barBeats };
  }, [bpm, barBeats]);
  // 5b chunk 3 (§2): the auto-fire toggles the gate reads, mirrored so the FROZEN motion-tick
  // closure (the [enabled,clockOn] interval is set up once → captures one render) sees the LIVE
  // values when it delegates to applyWithAutoFire. Reading them from render state in that frozen
  // closure would gate on whatever they were when the clock was toggled on (stale). The ref
  // identity is stable, so the frozen closure dereferences a current `.current`. LAYOUT (not
  // passive) for the cfgRef reason: a due tick must never read a stale toggle across the
  // commit→passive gap. setArmedFireAtEligible(false) after a fire still mirrors next commit — a
  // one-tick lag that fails SAFE (the session's armed-null is the real re-fire backstop).
  const gateRef = useRef({ autoFireOn, armedFireAtEligible });
  useIsomorphicLayoutEffect(() => {
    gateRef.current = { autoFireOn, armedFireAtEligible };
  }, [autoFireOn, armedFireAtEligible]);

  // 5b chunk 4a (§3): the SYNCHRONOUS telemetryRef — the same time-axis discipline as
  // driverRef/cfgRef/gateRef. The detector callback writes the ingested ClockTelemetryState
  // here SYNCHRONOUSLY; in 4b the tick + the gate read THIS ref (never passive state), which
  // is why it is established now even though 4a drives nothing. The React-state mirrors below
  // (shadow / validationLog) are a SEPARATE, lossy-OK display channel.
  const telemetryRef = useRef<ClockTelemetryState>(initTelemetryState());
  const [shadow, setShadow] = useState<{
    detectedBpm: number;
    confidence: number;
    statedBpm: number | null;
  } | null>(null);
  const [validationLog, setValidationLog] = useState<ValidationLogEntry[]>([]);

  // The detector's sink (§5): ingest into the synchronous ref FIRST (the invariant), then
  // mirror the lossy display state. Recreated when the stated bpm changes (so the shadow
  // readout and the log capture the CURRENT stated tempo); the detector hook re-syncs its
  // callback ref, so the frozen poll always calls the latest.
  const onTelemetry = useCallback(
    (t: TempoTelemetry) => {
      const now = Date.now();
      telemetryRef.current = ingestTelemetry(telemetryRef.current, t, now); // synchronous (§3)
      const st = telemetryRef.current;
      setShadow(
        st.lastTempoBpm === null
          ? null
          : { detectedBpm: st.lastTempoBpm, confidence: st.lastConfidence, statedBpm: bpm },
      );
      setValidationLog((log) => {
        const next = [
          ...log,
          { tMs: now, detectedBpm: t.tempoBpm, confidence: t.confidence, statedBpm: bpm },
        ];
        return next.length > VALIDATION_LOG_CAP ? next.slice(-VALIDATION_LOG_CAP) : next;
      });
    },
    [bpm],
  );
  const detector = useTempoDetector({ prefer: bpm, onTelemetry });

  // Ride the detector's enable/disable through refs — the same frozen-closure discipline as
  // the driver seams — so the public enableMicDetection/disableMicDetection are STABLE
  // identities (empty deps). A no-array effect re-syncs every render, so the wrappers always
  // call the latest detector methods without re-creating themselves.
  const detectorEnableRef = useRef(detector.enable);
  const detectorDisableRef = useRef(detector.disable);
  useEffect(() => {
    detectorEnableRef.current = detector.enable;
    detectorDisableRef.current = detector.disable;
  });

  const enableMicDetection = useCallback(() => {
    void detectorEnableRef.current();
  }, []);
  // Releasing the mic also resets the synchronous telemetry channel (a fresh incarnation on
  // re-enable). The validation log is kept for post-run eyeballing — cleared on session
  // identity change or explicitly.
  const disableMicDetection = useCallback(() => {
    detectorDisableRef.current();
    telemetryRef.current = initTelemetryState();
    setShadow(null);
  }, []);
  const clearValidationLog = useCallback(() => setValidationLog([]), []);

  // The single authoritative transaction write: driverRef synchronously, THEN the React
  // mirror. Stall-clear rides the SAME reckonAfter identity result that decides re-anchor
  // (§6): a NEW reckoning object (current moved / align) clears a stall; a no-move
  // (reckonAfter returned the input by identity) leaves `stalled` as-is — so "clear" and
  // "re-anchor" are one decision and cannot drift. Used by every MANUAL seam (the clock tick
  // writes driverRef itself, since a clock advance must NOT clear a stall).
  const writeDriver = (nextSession: ConductorSession, nextReckoning: ClockReckoning) => {
    const prev = driverRef.current;
    const nextStalled = nextReckoning !== prev.reckoning ? false : prev.stalled;
    driverRef.current = { session: nextSession, reckoning: nextReckoning, stalled: nextStalled };
    setSession(nextSession);
    setReckoning(nextReckoning);
    if (nextStalled !== prev.stalled) setStalled(nextStalled);
  };

  // ── 3b chunk 4: the relay binding (design-conductor-3b §10-4) ───────────────
  //
  // The pure orchestrator (lib/relay-binding.ts) owns ALL routing + gating; this
  // hook only executes its effects against the ONE ConductorSession (driverRef)
  // and the socket. Same synchronous-ref discipline as driverRef: bindingRef is
  // the authority (socket callbacks are macrotasks — committed React state is
  // always potentially stale to them); relayFactsState is the lossy display
  // mirror.
  const bindingRef = useRef<RelayBinding>(initRelayBinding());
  const sockRef = useRef<RelaySocket | null>(null);
  // Seeded from a FRESH binding, not bindingRef (react-hooks/refs: no ref reads
  // in render) — identical by construction, since bindingRef is seeded the same.
  const [relayFactsState, setRelayFactsState] = useState<RelayFacts>(() =>
    relayFacts(initRelayBinding()),
  );
  // Live relay-on flag for the FROZEN closures (driveClockTick's interval) — the
  // same layout-mirror discipline as cfgRef/gateRef: a due tick must never read
  // a stale "relay off" across the commit→passive gap and self-drive a follower.
  const relayOnRef = useRef(relayOn);
  useIsomorphicLayoutEffect(() => {
    relayOnRef.current = relayOn;
  }, [relayOn]);

  // May a LOCAL gesture (or the local clock) dispatch into this session? With a
  // relay bound and this device a FOLLOWER, the wire is the session's ONE writer
  // — a local dispatch would burn seq numbers the mirror never saw, and every
  // subsequent wire delta would land `ignored` (seq ≤ local): a silently frozen
  // mirror. 'joining' (relay unreachable / not yet admitted) deliberately does
  // NOT block: the epic's floor is that every failure degrades to SELF-drive —
  // an MD whose relay box died keeps conducting locally; nothing mirrors into a
  // joining session (the binding's activeSession is null there), so no fork.
  const localDispatchBlocked = () =>
    relayOnRef.current && bindingRef.current.conn.phase === 'follower';

  const factsEqual = (a: RelayFacts, b: RelayFacts) =>
    a.phase === b.phase &&
    a.canClaim === b.canClaim &&
    a.conductorLost === b.conductorLost &&
    a.chartMismatch === b.chartMismatch &&
    a.activeSession === b.activeSession; // conn holds the same reference between moves

  // Drive the pure binding: reduce, execute effects (some loop back as inputs —
  // a QUEUE, not recursion, so ordering stays first-in-first-out), then mirror
  // the honest facts once. Reads ONLY refs + stable setters, so the stale-closure
  // hazard of the passive feedRef sync below is a non-issue.
  const feed = (first: BindingInput) => {
    const queue: BindingInput[] = [first];
    while (queue.length > 0) {
      const input = queue.shift()!;
      const r = reduceBinding(bindingRef.current, input);
      bindingRef.current = r.binding;
      for (const eff of r.effects) {
        switch (eff.kind) {
          case 'send':
            sockRef.current?.send(JSON.stringify(eff.frame));
            break;
          // The mirror path: the wire's msg through the chunk-3a reducer, its
          // verdict looped back (needsSnapshot is how the pull opens). The
          // binding's localKey gate guarantees programHash agreement, so the
          // reducer's fail-closed throw is unreachable here by construction.
          case 'apply-mirror': {
            const d = driverRef.current;
            const s = d.session;
            if (!s) break; // identity re-initializing — the pull loop heals
            const res = reduceConductor(s.compiled, s.programHash, s.state, eff.msg);
            if (res.status === 'applied') {
              const nextReck = reckonAfter(
                d.reckoning,
                s.state.current,
                res.state.current,
                'manual',
                Date.now(),
              );
              writeDriver({ ...s, state: res.state }, nextReck);
            }
            queue.push({ kind: 'mirror-outcome', outcome: res.status });
            break;
          }
          // The rebase door. stateSupersedes keeps it forward-only: an
          // ex-writer's reconnect pull must not rewind the freshest state in
          // the room with the relay's older stale cache (doc §4.2).
          case 'adopt-snapshot': {
            const d = driverRef.current;
            const s = d.session;
            if (!s) break;
            if (!stateSupersedes(eff.state, s.state)) break;
            const nextReck = reckonAfter(
              d.reckoning,
              s.state.current,
              eff.state.current,
              'manual',
              Date.now(),
            );
            writeDriver({ ...s, state: eff.state }, nextReck);
            break;
          }
          // The §4.1-3 grant: mint the new generation from OUR freshest state
          // (mirror or self-drive survivor), then feed back so the binding
          // emits announce → snapshot upload → claim in pinned order.
          case 'accept-baton': {
            const d = driverRef.current;
            const s = d.session;
            if (!s) break; // claim was gated on localKey; unreachable in practice
            const { session: reborn, claim } = acceptBaton(s, eff.epoch, Date.now());
            writeDriver(reborn, d.reckoning); // no position move — same reckoning
            queue.push({
              kind: 'baton-accepted',
              key: sessionKeyOf(reborn.state),
              state: reborn.state,
              claim,
            });
            break;
          }
          case 'serve-snapshot': {
            const s = driverRef.current.session;
            if (!s) break;
            queue.push({ kind: 'serve-state', requestId: eff.requestId, state: s.state });
            break;
          }
          // Facts carry activeSession/chartMismatch; the page reacts to them
          // (chart navigation is the chunk-5 join/failover UI).
          case 'switch-session':
          case 'demoted':
          case 'bad-frame':
            break;
        }
      }
    }
    const f = relayFacts(bindingRef.current);
    setRelayFactsState((prev) => (factsEqual(prev, f) ? prev : f));
  };
  // Socket callbacks + intervals are macrotasks; they reach feed through this
  // ref. A stale closure is safe (feed reads only refs/stable setters), so the
  // passive re-sync suffices — no layout timing to defend here.
  const feedRef = useRef<(input: BindingInput) => void>(feed);
  useEffect(() => {
    feedRef.current = feed;
  });

  // The socket lifecycle: connect → hello; drop → fresh conn machine + retry
  // (failure matrix row 1 — the localKey SURVIVES a reconnect; the room's conn
  // state does not). Keyed on config FIELDS, so a per-render config object
  // doesn't churn connections.
  useEffect(() => {
    if (relayUrl === null || relayRoom === null || relayCode === null || relayLabel === null) {
      return;
    }
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let sock: RelaySocket | null = null;
    const factory =
      relaySocketFactory ?? ((u: string) => new WebSocket(u) as unknown as RelaySocket);
    const connect = () => {
      bindingRef.current = { conn: initClientConn(), localKey: bindingRef.current.localKey };
      const s = factory(relayUrl);
      sock = s;
      sockRef.current = s;
      s.onopen = () => {
        s.send(JSON.stringify(helloFrame(relayRoom, relayCode, relayLabel)));
      };
      s.onmessage = (ev) => {
        let raw: unknown;
        try {
          raw = JSON.parse(String(ev.data));
        } catch {
          raw = undefined; // parseRelayFrame(undefined) → bad-frame, dropped
        }
        feedRef.current({ kind: 'raw-frame', raw });
      };
      s.onclose = () => {
        if (!alive) return;
        sockRef.current = null;
        bindingRef.current = { conn: initClientConn(), localKey: bindingRef.current.localKey };
        const f = relayFacts(bindingRef.current);
        setRelayFactsState((prev) => (factsEqual(prev, f) ? prev : f));
        retry = setTimeout(connect, RELAY_RECONNECT_MS);
      };
    };
    connect();
    return () => {
      alive = false;
      if (retry !== undefined) clearTimeout(retry);
      sockRef.current = null;
      if (sock) {
        sock.onclose = null; // teardown is not a drop — no retry, no facts churn
        sock.close();
      }
      // The conn dies with the socket; the localKey does NOT — it tracks the
      // SESSION lifecycle (local-ready / local-gone from the identity effect),
      // which this effect does not own. Wiping it here would strand a config
      // change / relay off→on toggle (identity unchanged ⇒ local-ready never
      // re-fires) with no key to mirror or claim on.
      bindingRef.current = { conn: initClientConn(), localKey: bindingRef.current.localKey };
      // Facts intentionally not reset here (setState-in-cleanup): with the relay
      // off the surface hard-codes the 'off' block below, so stale facts are
      // unobservable; a config change re-runs connect(), which re-mirrors.
    };
  }, [relayUrl, relayRoom, relayCode, relayLabel, relaySocketFactory]);

  // The writer's lease heartbeat (§4.2). The pure binding gates the send on
  // phase — this interval just ticks. Keyed on the mirrored phase so followers
  // and local-mode devices run no timer at all.
  const relayIsWriter = relayFactsState.phase === 'writer';
  useEffect(() => {
    if (!relayIsWriter) return;
    const id = setInterval(() => feedRef.current({ kind: 'hb-tick' }), RELAY_HB_MS);
    return () => clearInterval(id);
  }, [relayIsWriter]);

  // §4 tempo establish/reconcile lives INSIDE driveClockTick (Codex R5 HIGH 2), NOT a passive
  // [bpm] effect: a microtask scheduled from a passive effect can lose to an ALREADY-DUE timer,
  // so the tick would read the new cfgRef bpm against the OLD motion baseline (a false jump /
  // stall). The tick is the one place synchronized with the baseline — so it reconciles there,
  // atomically, before computing owed. See driveClockTick below.

  // SYNCHRONOUSLY inert the still-mounted interval the instant identity changes (Codex R6 HIGH 1).
  // The driver interval is keyed on [enabled, clockOn], so when sessionId / songRef / cal change
  // while clockOn stays true, the OLD interval keeps ticking against the OLD driverRef.session until
  // the async programHash reseeds it. The previous fix nulled the session at the TOP of the PASSIVE
  // reset effect — but that passive body runs in a later macrotask, so a due interval could still
  // fire in the commit→passive gap and advance/stall the previous chart. A LAYOUT effect nulls it in
  // the commit phase (before the event loop can run a due timer), truly closing the window. Ref write
  // only (no setState), so it's lint-clean here; the tick's `if (!s || ...) return` catches the null,
  // the passive effect below reseeds, and a fresh session's `current === null` guard covers the interim.
  useIsomorphicLayoutEffect(() => {
    driverRef.current = { ...driverRef.current, session: null };
  }, [enabled, compiled, cal, sessionId, songRef]);

  // (Re)initialize the session on identity change. programHash is async, so init
  // happens in the resolve callback — naturally deferred (no sync setState-in-effect).
  // The disabled/teardown branch defers its reset to a microtask for the same lint
  // rule (mirrors the cross-chart reset idiom in page.tsx). A `cancelled` guard drops
  // a stale async if cal/identity changed under it. (The driverRef.session null that
  // inerts the live interval is done synchronously in the LAYOUT effect above — this
  // passive effect owns only the deferred setState resets + the async reseed.)
  useEffect(() => {
    let cancelled = false;
    // Identity changed — drop any prior arm-eligibility bit alongside the session
    // reset. Deferred (not synchronous-in-effect) for the same lint rule the
    // setSession resets below follow. (Harmless even if it lagged: shouldAutoFire
    // guards on `armed`, and a fresh session is always unarmed.)
    if (!enabled || !compiled || !cal) {
      Promise.resolve().then(() => {
        if (!cancelled) {
          const fresh = initReckoning(Date.now());
          // Reset the authoritative driver FIRST (sync), then mirror — the same discipline
          // every seam follows. Clock state resets per-session (§12-Q4); the fresh reckoning
          // already carries a current motionBaselineAtMs, so no tempo rebaseline is owed.
          driverRef.current = { session: null, reckoning: fresh, stalled: false };
          setSession(null);
          setArmedFireAtEligible(false);
          setReckoning(fresh);
          setStalled(false);
          setClockOn(false);
          // 5b chunk 4a: leaving MD mode releases the mic for privacy (the detector is an
          // independent switch but must not outlive the session it shadows), then resets the
          // shadow telemetry channel + log for the new identity.
          detectorDisableRef.current();
          telemetryRef.current = initTelemetryState();
          setShadow(null);
          setValidationLog([]);
          // 3b: no session ⇒ nothing to mirror or announce (clears canClaim).
          feedRef.current({ kind: 'local-gone' });
        }
      });
      return () => {
        cancelled = true;
      };
    }
    const bars = barsInOrder(cal);
    const markers = cal.roadmap ?? [];
    void computeProgramHash(bars, markers).then((hash) => {
      if (cancelled) return;
      const fresh = initReckoning(Date.now());
      const minted = initSession(sessionId, songRef, hash, compiled, Date.now());
      // 3b §4.4 epoch semantics: the baton epoch is relay-owned and ORTHOGONAL
      // to sessions — a same-baton session switch (next song, recompile)
      // INHERITS the granted epoch; only a claim bumps it. initSession mints
      // epoch 0 (single-device), so a WRITER's fresh session is rebased onto
      // the relay's grant (conn.epoch) here, before it is announced. seq stays
      // 0 — per-session restart is the pinned rule.
      const next =
        bindingRef.current.conn.phase === 'writer'
          ? { ...minted, state: { ...minted.state, epoch: bindingRef.current.conn.epoch } }
          : minted;
      driverRef.current = { session: next, reckoning: fresh, stalled: false };
      setSession(next);
      setArmedFireAtEligible(false);
      setReckoning(fresh);
      setStalled(false);
      setClockOn(false);
      // 5b chunk 4a: reset the shadow telemetry channel + log for the new identity.
      telemetryRef.current = initTelemetryState();
      setShadow(null);
      setValidationLog([]);
      // 3b: the session's key is ready — the binding announces (writer, §4.4:
      // a recompile/recalibration lands here with a NEW hash = a session
      // switch) or force-re-pulls (follower whose chart arrived late).
      feedRef.current({ kind: 'local-ready', key: { sessionId, songRef, programHash: hash } });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, compiled, cal, sessionId, songRef]);

  // Mint + apply through the pure controller; record the outcome so a dead tap
  // (`ignored`) surfaces honestly, and replace the session only when state advanced.
  const run = (payload: ConductorPayload) => {
    const before = driverRef.current.session;
    if (!before) return;
    if (localDispatchBlocked()) return; // 3b: a follower's session has ONE writer — the wire
    const now = Date.now();
    const res = dispatch(before, payload, now);
    setOutcome(res.outcome);
    if (res.outcome === 'applied') {
      // Invariant (P): re-anchor IFF current moved. arm/disarm never move current → no-op;
      // a Go-now commit that jumps re-anchors ('manual'); a no-armed/stale commit leaves
      // current put → no re-anchor (the R8 guarantee, for free — §2.3). Read the
      // authoritative reckoning (driverRef), so a manual gesture can never disagree with a
      // clock tick about "where we are" (§3.2); writeDriver also clears a stall iff this moved.
      const nextReck = reckonAfter(
        driverRef.current.reckoning,
        before.state.current,
        res.session.state.current,
        'manual',
        now,
      );
      writeDriver(res.session, nextReck);
      // 3b fan-out seam: broadcast exactly what the local mirror admitted. The
      // binding drops this unless we hold the baton (writer-gated purely).
      if (res.msg) feedRef.current({ kind: 'applied-msg', msg: res.msg });
    }
  };

  // Commit the result of an action that may have satisfied the §3.5 gate, chaining a
  // synchronous auto-commit when it does (NEVER a deferred effect — the chunk-4
  // page-turn-parity lesson, D5). Fire on the RISING EDGE of the gate — when THIS action
  // OPENED it — NOT merely because the gate is already open. The two legitimate openers:
  // an `advance` that ARRIVES at the fire bar (current transitions onto fireAt), and a
  // `release` redirect that CLEARS the hold while the playhead is already PARKED on the
  // fire bar (the holding-guard flips, and the reducer keeps `current` on the fire bar
  // across a redirect, so for a fire bar inside the vamp body the hold-clear is the EXACT —
  // and only — moment the gate opens; the following advance steps off and never returns).
  // A redirect that finds the gate ALREADY open — e.g. a stale marker parked on fireAt with
  // auto-fire toggled on AFTER the arrival, then any unrelated redirect ("Another round",
  // "Re-arm jump") — did NOT arrive or release, so it must NOT fire: it preserves the latch
  // and leaves the marker for the next genuine arrival (Codex build-review R3 HIGH).
  // edge = !shouldAutoFire(before) && shouldAutoFire(after) is caller-agnostic — no
  // redirect-kind special-casing. Both dispatch on the returned session (a value, not React
  // state) with a SINGLE setSession, so there is no read-after-setState hazard.
  const applyWithAutoFire = (
    before: ConductorSession,
    res: ReturnType<typeof dispatch>,
    opts: { provenance: 'manual' | 'clock'; rung: ClockRung },
  ) => {
    if (localDispatchBlocked()) return; // 3b: drop the caller's mint — the wire owns motion
    setOutcome(res.outcome);
    if (res.outcome !== 'applied') return;
    // Invariant (P) threads a SINGLE composed reckoning so the chained auto-fire commit
    // stacks atop the primary leg, written through driverRef in one transaction (no
    // read-after-set hazard). The primary leg carries the CALLER's provenance (§5.2): 'manual'
    // for advance()/redirect()/align (advance() IS a manual position gesture; a redirect's leg
    // never moves current (:223) so reckonAfter no-ops it — "a redirect does NOT re-anchor",
    // §2.3), 'clock' for the motion tick. Compute it FIRST so the gate can key on the ARRIVAL.
    const now = Date.now();
    const primaryReck = reckonAfter(
      driverRef.current.reckoning,
      before.state.current,
      res.session.state.current,
      opts.provenance,
      now,
    );
    // 5b chunk 3 (§5.2): the auto-fire DECISION is the frozen 5a rising-edge predicate PLUS one
    // confidence gate. The requirement keys on the ARRIVAL's provenance (primaryReck.positionTrusted),
    // NOT the action — so release-over-a-clock-placed-fireAt (manual action, untrusted arrival)
    // correctly REQUIRES confidence (closes the R6 hole), while a manual advance / 5a vamp-release
    // over a manually-placed bar fires unconditionally. Toggles come from gateRef (the §2 frozen-
    // tick fix), so the same chain is correct from the event handlers AND the motion interval.
    const { autoFireOn: afOn, armedFireAtEligible: elig } = gateRef.current;
    const opened = !shouldAutoFire(before) && shouldAutoFire(res.session);
    const confident = primaryReck.positionTrusted || clockConfidenceOk(primaryReck, opts.rung);
    if (afOn && elig && opened && confident) {
      const afterFire = dispatch(res.session, { kind: 'commit' }, Date.now());
      setOutcome(afterFire.outcome); // surface the COMMIT result, not the stale prior one
      const fired = afterFire.outcome === 'applied';
      // The chained commit is MACHINE-placed → 'autofire' stamp: flips positionTrusted=false
      // ONLY, leaving the trust + motion axes at the arrival's values (no double-count).
      const nextReck = fired
        ? reckonAfter(primaryReck, res.session.state.current, afterFire.session.state.current, 'autofire', now)
        : primaryReck;
      writeDriver(fired ? afterFire.session : res.session, nextReck);
      setArmedFireAtEligible(false); // fired (or attempted) → drop the bit
      // 3b fan-out, in mint order on the one socket: the primary leg, then the
      // chained auto-fire commit (both writer-gated purely in the binding).
      if (res.msg) feedRef.current({ kind: 'applied-msg', msg: res.msg });
      if (fired && afterFire.msg) feedRef.current({ kind: 'applied-msg', msg: afterFire.msg });
      return;
    }
    writeDriver(res.session, primaryReck);
    if (res.msg) feedRef.current({ kind: 'applied-msg', msg: res.msg });
  };

  // 5b chunk 2 (§3.1): one motion tick. Reads FRESH state from driverRef/cfgRef (never a
  // stale closure), writes driverRef synchronously before mirroring. Emits AT MOST ONE
  // clock-driven advance per tick and re-reads next tick — NEVER loops N advances (that
  // could skip a fireAt). ≥2 owed ⇒ the loop was suspended (tab sleep) ⇒ STALL → manual,
  // never fast-forward off a possibly-stale tempo. Song end / not-seeded / no-bpm / stalled
  // all idle the loop. NO auto-fire chain (clock arrivals defer in chunk 2, §5).
  const driveClockTick = () => {
    let { reckoning: r } = driverRef.current;
    const { session: s, stalled: st } = driverRef.current;
    const { bpm: b, barBeats: bb } = cfgRef.current;
    if (b == null || st) return; // manual rung (clockOn already gates the effect)
    if (!s || s.state.current === null) return; // not seeded — wait for the MD's "On the 1"
    if (s.state.vm.done) return; // belt-and-suspenders: never dispatch a no-op advance at song end
    const now = Date.now();
    // §4 tempo reconcile, IN-TICK (Codex R5 HIGH 2): atomically aligned with the motion baseline
    // the very same line reads. The motion baseline (motionBaselineAtMs / barsAtMotionBaseline) is
    // already correctly set by the seed via align / advance — only baselineTempoBpm is null at
    // first. So FIRST establishment merely RECORDS the tempo (does NOT re-zero, does NOT consume a
    // tick) and falls through to owed off the SAME r; a real CHANGE re-zeros the motion axis to now
    // (owed becomes 0) and returns, so the new period starts clean with no stale-baseline jump.
    if (r.baselineTempoBpm === null) {
      r = { ...r, baselineTempoBpm: b };
      driverRef.current = { session: s, reckoning: r, stalled: st };
    } else if (b !== r.baselineTempoBpm) {
      const based = rebaselineMotion(r, b, now);
      driverRef.current = { session: s, reckoning: based, stalled: st };
      setReckoning(based);
      return;
    }
    const owed = expectedClockBars(r, now, barMs(b, bb)) - r.barsSinceAnchor;
    if (owed <= 0) return; // not time for the next bar yet
    if (owed >= 2) {
      // suspended — freeze where we last legitimately were; the next align tap re-seeds + clears.
      driverRef.current = { session: s, reckoning: r, stalled: true };
      setStalled(true);
      return;
    }
    // owed === 1: emit EXACTLY ONE clock-driven advance (the reckoning's 4th current-writer), now
    // routed through the SAME rising-edge auto-fire chain as the manual gestures (5b chunk 3, §4 —
    // relaxes chunk 2's "clock arrivals DEFER auto-fire"). The chain stamps the primary leg 'clock'
    // (positionTrusted=false → the §5.2 confidence requirement falls out), does setOutcome + the
    // non-'applied' early-return, the rising-edge gate, the chained commit, and the driverRef write.
    // rung is provably 'static-bpm' here: past b!=null / !stalled (:346) / seeded (:347) / !done
    // (:348) / owed===1. writeDriver's stall-clear is MOOT — stalled is already false (the :346
    // guard returns before this when stalled), so the chunk-2 "must not clear a stall" intent holds.
    const res = dispatch(s, { kind: 'advance' }, now);
    applyWithAutoFire(s, res, { provenance: 'clock', rung: 'static-bpm' });
  };

  // The motion driver effect (§3). One interval, MD device only, set up ONCE per
  // [enabled, clockOn] (re-creating it per render would reset the timing baseline every
  // tick). driveClockTick reads only refs, so the stale closure is a non-issue and
  // session/reckoning/bpm are intentionally NOT deps. LAYOUT, not passive (Codex R6): the
  // CLEANUP must clear the interval in the SAME commit the MD toggles clock off / leaves MD
  // mode — a passive teardown leaves a window where a due tick fires after the clockOff/disable
  // commit but before the passive cleanup, advancing one spurious bar. A layout cleanup runs in
  // the commit, before the event loop can run that due timer, so the interval stops cleanly.
  useIsomorphicLayoutEffect(() => {
    if (!enabled || !clockOn) return;
    const id = setInterval(driveClockTick, CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, [enabled, clockOn]);

  const targets = useMemo<JumpTarget[]>(
    () => (compiled && cal ? armableTargets(compiled, cal) : []),
    [compiled, cal],
  );
  const redirects = useMemo<RedirectOption[]>(
    () => (compiled && session ? availableRedirects(compiled, session.state.vm) : []),
    [compiled, session],
  );
  // §4 — is there a next-section boundary ahead? Disables the cluster's "Next section"
  // arm option when there is none (vamping / already in the last section).
  const canArmNextSection = useMemo<boolean>(
    () =>
      compiled && cal && session
        ? nextSectionBoundaryBarId(compiled, cal, session.state.vm, session.state.current?.barId) !==
          undefined
        : false,
    [compiled, cal, session],
  );

  const state = session?.state ?? null;
  // 5b chunk 2: the rung readout (§2). Honest floor — 'manual' whenever the clock is off,
  // no tempo is stated, the loop stalled, or the song ended; 'static-bpm' when self-driving.
  const rung = computeStaticRung({ clockOn, bpm, stalled, done: state?.vm.done ?? false });

  return {
    active: session !== null,
    state,
    current: state?.current ?? null,
    armed: state?.armed ?? null,
    done: state?.vm.done ?? false,
    targets,
    redirects,
    autoFireOn,
    setAutoFire: setAutoFireOn,
    canArmNextSection,
    reckoning,
    clockOn,
    setClockOn,
    rung,
    stalled,
    // §3 — auto-fire is evaluated SYNCHRONOUSLY inside the advance action (NEVER a
    // deferred effect — the chunk-4 page-turn-parity lesson, D5). When the toggle is off
    // (or the gate unmet) this collapses to the verbatim chunk-4 advance.
    advance: () => {
      // Read the authoritative session (driverRef) so a manual tap can never race a clock
      // tick off stale committed state (§3.2).
      const s = driverRef.current.session;
      if (!s) return;
      applyWithAutoFire(s, dispatch(s, { kind: 'advance' }, Date.now()), { provenance: 'manual', rung });
    },
    // arm ALWAYS routes through resolveArm (the #101 forward-carry): the component
    // never hand-builds a directive. It forwards a STABLE IDENTITY (not the raw
    // target — don't-trust-the-object, insert-return §4.3) + the last-emitted bar
    // (currentBarId) so resolveArm can re-derive the target and bake the
    // insert-return leg at arm time (§4.1). fireAt is a STRUCTURAL choice (§3.1): the
    // real next emitted bar (default) or the next section head ahead — never a raw
    // count. An out-of-set exit, ambiguous identity, unknown bar, or absent boundary
    // yields null → no-op. Order matters (§3.1): resolve, reject FIRST, only THEN set
    // the eligibility bit — a rejected arm must not clobber the prior marker's bit.
    arm: (t, exit, fireAt = 'next-bar') => {
      const s = driverRef.current.session;
      if (!compiled || !cal || !s) return;
      const currentBarId = s.state.current?.barId;
      const fireBar =
        fireAt === 'next-section'
          ? nextSectionBoundaryBarId(compiled, cal, s.state.vm, currentBarId)
          : nextEmittedBarId(compiled, s.state.vm);
      if (!fireBar) return; // no such boundary ahead — nothing to arm against
      const id = { barId: t.barId, kind: t.kind, label: t.label };
      const armed = resolveArm(compiled, cal, id, exit, fireBar, currentBarId);
      if (!armed) return; // reject FIRST — no local-state mutation yet
      setArmedFireAtEligible(true); // only after the arm succeeds (§1/§3.1)
      run({ kind: 'arm', armed });
    },
    commit: () => {
      setArmedFireAtEligible(false); // marker fired/consumed
      run({ kind: 'commit' });
    },
    disarm: () => {
      setArmedFireAtEligible(false); // marker cancelled
      run({ kind: 'disarm' });
    },
    // redirect routes through the SAME edge-gated auto-fire chain as advance, and must
    // NOT clear the eligibility bit. The only redirect that OPENS the gate is `release`
    // (the §3.5 hold path): the gate refuses an armed marker while vm.holding != null;
    // release clears holding while the reducer keeps `current` parked on the fire bar, so
    // shouldAutoFire rises false→true on the release itself and the chain fires it THERE
    // (the next advance would step off the fire bar — see applyWithAutoFire). For a fire
    // bar still AHEAD (vamping an earlier section, release, advance forward into it),
    // release leaves `current` short of the fire bar → no edge here, marker fires on the
    // later arriving advance. A redirect that finds the gate ALREADY open (stale parked
    // marker) is NOT an edge → no fire, latch preserved (Codex R3 HIGH). The bit is never
    // cleared by a non-firing redirect, so auto-fire can't be silently disabled (Codex R1).
    redirect: (opt) => {
      const s = driverRef.current.session;
      if (!s) return;
      applyWithAutoFire(s, dispatch(s, { kind: 'redirect', directive: opt.directive }, Date.now()), {
        provenance: 'manual',
        rung,
      });
    },
    // §3 — the align / true-up tap. Two mechanics by state, both ending in a full manual
    // re-anchor: at the song head (current === null) it SEEDS bar 1 by dispatching the first
    // manual advance (the only way to place current on the shipped wire — reckonAfter('manual')
    // re-anchors onto bar 1); mid-song (current !== null) it re-zeros the timing baseline ONTO
    // the existing current with NO dispatch / seq / broadcast — purely MD-local (parent §5.1b/§9).
    align: () => {
      const s = driverRef.current.session;
      if (!s) return;
      if (s.state.current === null) {
        applyWithAutoFire(s, dispatch(s, { kind: 'advance' }, Date.now()), { provenance: 'manual', rung });
        return;
      }
      // Mid-song true-up: re-zero ONTO current, NO dispatch. alignReckoning always returns a
      // NEW object, so writeDriver also CLEARS a stall (§6 — an align resumes a stalled clock).
      const nextReck = alignReckoning(driverRef.current.reckoning, s.state.current, Date.now());
      writeDriver(s, nextReck);
    },
    outcome,
    // 5b chunk 4a: the shadow detector surface (drives nothing — §5).
    micStatus: detector.status,
    micError: detector.lastError,
    enableMicDetection,
    disableMicDetection,
    shadow,
    validationLog,
    clearValidationLog,
    // 3b chunk 4: the relay slice. Hard-coded OFF block when unconfigured, so a
    // stale facts mirror from a torn-down socket is unobservable (see the socket
    // effect's cleanup note).
    relay: relayOn
      ? {
          status: relayFactsState.phase === 'joining' ? 'connecting' : 'joined',
          role: relayFactsState.phase === 'writer' ? 'writer' : 'follower',
          canClaim: relayFactsState.canClaim,
          conductorLost: relayFactsState.conductorLost,
          activeSession: relayFactsState.activeSession,
          chartMismatch: relayFactsState.chartMismatch,
          requestClaim: () => feedRef.current({ kind: 'request-claim' }),
          releaseBaton: () => feedRef.current({ kind: 'release-baton' }),
        }
      : {
          status: 'off',
          role: 'local',
          canClaim: false,
          conductorLost: false,
          activeSession: null,
          chartMismatch: false,
          requestClaim: () => {},
          releaseBaton: () => {},
        },
  };
}
