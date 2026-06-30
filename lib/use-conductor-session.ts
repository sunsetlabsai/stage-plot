import { useEffect, useMemo, useState } from 'react';
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
  advance: () => void;
  arm: (t: JumpTarget, exit?: ExitPolicy['kind'], fireAt?: 'next-bar' | 'next-section') => void;
  commit: () => void;
  disarm: () => void;
  redirect: (opt: RedirectOption) => void;
  outcome: ReduceOutcome['status'] | null;
}

export function useConductorSession(args: UseConductorArgs): ConductorSurface {
  const { enabled, sessionId, songRef, cal } = args;

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
  // §1/§3.1 arm-time forward reachability of the fire bar. Invariantly true in 5a (the
  // walk that picked the fire bar IS the proof), kept to honour the frozen contract
  // `if (armedFireAtEligible && shouldAutoFire(...))` and stays load-bearing in 5b. Set
  // true only AFTER an arm succeeds; cleared on commit/disarm/redirect/identity change.
  const [armedFireAtEligible, setArmedFireAtEligible] = useState(false);

  // (Re)initialize the session on identity change. programHash is async, so init
  // happens in the resolve callback — naturally deferred (no sync setState-in-effect).
  // The disabled/teardown branch defers its reset to a microtask for the same lint
  // rule (mirrors the cross-chart reset idiom in page.tsx). A `cancelled` guard drops
  // a stale async if cal/identity changed under it.
  useEffect(() => {
    let cancelled = false;
    // Identity changed — drop any prior arm-eligibility bit alongside the session
    // reset. Deferred (not synchronous-in-effect) for the same lint rule the
    // setSession resets below follow. (Harmless even if it lagged: shouldAutoFire
    // guards on `armed`, and a fresh session is always unarmed.)
    if (!enabled || !compiled || !cal) {
      Promise.resolve().then(() => {
        if (!cancelled) {
          setSession(null);
          setArmedFireAtEligible(false);
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
      setSession(initSession(sessionId, songRef, hash, compiled, Date.now()));
      setArmedFireAtEligible(false);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, compiled, cal, sessionId, songRef]);

  // Mint + apply through the pure controller; record the outcome so a dead tap
  // (`ignored`) surfaces honestly, and replace the session only when state advanced.
  const run = (payload: ConductorPayload) => {
    if (!session) return;
    const res = dispatch(session, payload, Date.now());
    setOutcome(res.outcome);
    if (res.outcome === 'applied') setSession(res.session);
  };

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
    // §3 — auto-fire is evaluated SYNCHRONOUSLY inside the advance action (NEVER a
    // deferred effect — the chunk-4 page-turn-parity lesson, D5). Two pure dispatches
    // chained on their returned sessions, a SINGLE setSession. When the toggle is off
    // this collapses to the verbatim chunk-4 advance.
    advance: () => {
      if (!session) return;
      const afterAdvance = dispatch(session, { kind: 'advance' }, Date.now());
      setOutcome(afterAdvance.outcome);
      if (afterAdvance.outcome !== 'applied') return;
      if (autoFireOn && armedFireAtEligible && shouldAutoFire(afterAdvance.session)) {
        const afterFire = dispatch(afterAdvance.session, { kind: 'commit' }, Date.now());
        setOutcome(afterFire.outcome); // surface the COMMIT result, not the stale advance one
        setSession(afterFire.outcome === 'applied' ? afterFire.session : afterAdvance.session);
        setArmedFireAtEligible(false); // fired (or attempted) → drop the bit
        return;
      }
      setSession(afterAdvance.session);
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
      if (!compiled || !cal || !session) return;
      const currentBarId = session.state.current?.barId;
      const fireBar =
        fireAt === 'next-section'
          ? nextSectionBoundaryBarId(compiled, cal, session.state.vm, currentBarId)
          : nextEmittedBarId(compiled, session.state.vm);
      if (!fireBar) return; // no such boundary ahead — nothing to arm against
      const id = { barId: t.barId, kind: t.kind, label: t.label };
      const armed = resolveArm(compiled, cal, id, exit, fireBar, currentBarId);
      if (!armed) return; // reject FIRST — no local-state mutation yet
      setArmedFireAtEligible(true); // only after the arm succeeds (§1/§3.1)
      run({ kind: 'arm', armed });
    },
    commit: () => {
      setArmedFireAtEligible(false);
      run({ kind: 'commit' });
    },
    disarm: () => {
      setArmedFireAtEligible(false);
      run({ kind: 'disarm' });
    },
    redirect: (opt) => {
      setArmedFireAtEligible(false);
      run({ kind: 'redirect', directive: opt.directive });
    },
    outcome,
  };
}
