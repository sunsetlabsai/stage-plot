import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChartCalibration } from './types';
import { barsInOrder, type TraversalStep } from './chart-calibration';
import { compileRoadmap, type CompiledRoadmap, type ExitPolicy } from './roadmap-vm';
import {
  programHash as computeProgramHash,
  type ConductorState,
  type ConductorPayload,
  type ReduceOutcome,
  type Armed,
} from './conductor-state';
import { initSession, dispatch, shouldAutoFire, type ConductorSession } from './conductor-session';
import {
  initReckoning,
  reckonAfter,
  alignReckoning,
  computeStaticRung,
  rebaselineMotion,
  expectedClockBars,
  type ClockReckoning,
  type ClockRung,
} from './conductor-clock';
import { barMs, DEFAULT_BAR_BEATS } from './tempo';
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
}

export function useConductorSession(args: UseConductorArgs): ConductorSurface {
  const { enabled, sessionId, songRef, cal } = args;
  // 5b chunk 2: normalize the tempo source (undefined legacy/inline song ⇒ null) and the
  // bar length (timeSig not exposed to Perform yet ⇒ 4/4 default).
  const bpm = args.bpm ?? null;
  const barBeats = args.barBeats ?? DEFAULT_BAR_BEATS;

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
      const next = initSession(sessionId, songRef, hash, compiled, Date.now());
      driverRef.current = { session: next, reckoning: fresh, stalled: false };
      setSession(next);
      setArmedFireAtEligible(false);
      setReckoning(fresh);
      setStalled(false);
      setClockOn(false);
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
  const applyWithAutoFire = (before: ConductorSession, res: ReturnType<typeof dispatch>) => {
    setOutcome(res.outcome);
    if (res.outcome !== 'applied') return;
    // Invariant (P) threads a SINGLE composed reckoning so the chained auto-fire commit
    // stacks atop the primary leg, written through driverRef in one transaction (no
    // read-after-set hazard). The auto-fire DECISION is byte-for-byte the frozen 5a rising-
    // edge logic — chunk 2 only changes WHERE the reckoning is read/written (driverRef, the
    // §3.2 invariant), not WHETHER it fires. The primary leg is 'manual' for BOTH callers:
    // advance() IS a manual position gesture; redirect()'s leg never moves current (:223) so
    // reckonAfter no-ops it ("a redirect does NOT re-anchor", for free — §2.3).
    const now = Date.now();
    const opened = !shouldAutoFire(before) && shouldAutoFire(res.session);
    if (autoFireOn && armedFireAtEligible && opened) {
      const afterFire = dispatch(res.session, { kind: 'commit' }, Date.now());
      setOutcome(afterFire.outcome); // surface the COMMIT result, not the stale prior one
      const fired = afterFire.outcome === 'applied';
      const manual = reckonAfter(
        driverRef.current.reckoning,
        before.state.current,
        res.session.state.current,
        'manual',
        now,
      );
      // The chained commit is MACHINE-placed → 'autofire' stamp: flips positionTrusted=false
      // ONLY, leaving the trust + motion axes at the manual arrival's values (no double-count).
      const nextReck = fired
        ? reckonAfter(manual, res.session.state.current, afterFire.session.state.current, 'autofire', now)
        : manual;
      writeDriver(fired ? afterFire.session : res.session, nextReck);
      setArmedFireAtEligible(false); // fired (or attempted) → drop the bit
      return;
    }
    const nextReck = reckonAfter(
      driverRef.current.reckoning,
      before.state.current,
      res.session.state.current,
      'manual',
      now,
    );
    writeDriver(res.session, nextReck);
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
    // owed === 1: emit EXACTLY ONE clock-driven advance (the reckoning's 4th current-writer).
    const res = dispatch(s, { kind: 'advance' }, now);
    setOutcome(res.outcome);
    if (res.outcome !== 'applied') return; // a genuinely ignored dispatch — re-evaluate next tick
    const nextReck = reckonAfter(r, s.state.current, res.session.state.current, 'clock', now);
    // Write driverRef DIRECTLY (not writeDriver): a clock advance must NOT clear a stall.
    driverRef.current = { session: res.session, reckoning: nextReck, stalled: st };
    setSession(res.session);
    setReckoning(nextReck);
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
      applyWithAutoFire(s, dispatch(s, { kind: 'advance' }, Date.now()));
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
      applyWithAutoFire(s, dispatch(s, { kind: 'redirect', directive: opt.directive }, Date.now()));
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
        applyWithAutoFire(s, dispatch(s, { kind: 'advance' }, Date.now()));
        return;
      }
      // Mid-song true-up: re-zero ONTO current, NO dispatch. alignReckoning always returns a
      // NEW object, so writeDriver also CLEARS a stall (§6 — an align resumes a stalled clock).
      const nextReck = alignReckoning(driverRef.current.reckoning, s.state.current, Date.now());
      writeDriver(s, nextReck);
    },
    outcome,
  };
}
