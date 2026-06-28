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
import { initSession, dispatch, type ConductorSession } from './conductor-session';
import {
  armableTargets,
  availableRedirects,
  resolveArm,
  nextEmittedBarId,
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
  advance: () => void;
  arm: (t: JumpTarget, exit?: ExitPolicy['kind']) => void;
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

  // (Re)initialize the session on identity change. programHash is async, so init
  // happens in the resolve callback — naturally deferred (no sync setState-in-effect).
  // The disabled/teardown branch defers its reset to a microtask for the same lint
  // rule (mirrors the cross-chart reset idiom in page.tsx). A `cancelled` guard drops
  // a stale async if cal/identity changed under it.
  useEffect(() => {
    let cancelled = false;
    if (!enabled || !compiled || !cal) {
      Promise.resolve().then(() => {
        if (!cancelled) setSession(null);
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

  const state = session?.state ?? null;

  return {
    active: session !== null,
    state,
    current: state?.current ?? null,
    armed: state?.armed ?? null,
    done: state?.vm.done ?? false,
    targets,
    redirects,
    advance: () => run({ kind: 'advance' }),
    // arm ALWAYS routes through resolveArm (the #101 forward-carry): the component
    // never hand-builds a directive. fireAt defaults to the real next emitted bar;
    // an out-of-set exit or an unknown bar yields null → no-op.
    arm: (t, exit) => {
      if (!compiled || !cal || !session) return;
      const fireAt = nextEmittedBarId(compiled, session.state.vm);
      if (!fireAt) return; // song end — nothing to arm against
      const armed = resolveArm(compiled, cal, t.barId, exit, fireAt);
      if (!armed) return;
      run({ kind: 'arm', armed });
    },
    commit: () => run({ kind: 'commit' }),
    disarm: () => run({ kind: 'disarm' }),
    redirect: (opt) => run({ kind: 'redirect', directive: opt.directive }),
    outcome,
  };
}
