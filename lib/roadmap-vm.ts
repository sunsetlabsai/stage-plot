import type { RoadmapMarker } from './types';

// ── Conductor authority, chunk 2: the resumable roadmap VM core ──────────────
//
// (design-conductor-authority.md §3.1). The musical traversal semantics, turned
// inside-out from `resolveRoadmap`'s run-to-completion walk into a RESUMABLE
// stepper: compile once → init state → step one transition at a time → apply MD
// overrides. The same rules drive the batch resolve (resolveRoadmap now delegates
// here) and the live conductor VM, so there is ONE source of truth for the
// subtle repeat/volta/jump semantics.
//
// This module is canonical-agnostic: it operates on an ordered list of bars (any
// `{ id }`) + a RoadmapMarker[] keyed by bar id. A chart calibration and a
// song-scoped SongStructure both reduce to exactly that, so the VM runs over
// either unchanged (design §3.1 — "resolveRoadmap is already pure over
// (bars, markers)").
//
// VMState is the serializable wire snapshot (design §6 ConductorState.cursor):
// plain Records only, no Maps, so the MD can broadcast it verbatim. CompiledRoadmap
// is derived (recomputed from the roadmap) and never travels — Maps are fine there.

export interface TraversalStep {
  barId: string;
  pass: number;
}

export interface RoadmapError {
  markerIds: string[];
  reason: string;
}

// Termination backstop (multiplicative for nesting + additive for jumps), used
// only by the batch runner (live stepping is MD-bounded, never auto-capped).
const ROADMAP_TERMINATION_K = 8;

type M<K extends RoadmapMarker['kind']> = Extract<RoadmapMarker, { kind: K }>;

interface EndingSpan {
  marker: M<'ending'>;
  repeatStartId: string;
  startPos: number;
  lastPos: number;
}

// The compiled program: validated + indexed roadmap. Derived from (bars, markers);
// recomputed, never serialized.
export interface CompiledRoadmap {
  bars: { id: string }[];
  barPos: Map<string, number>;
  // No markers ⇒ linear playback (clean back-compat). When set, the index maps
  // below are empty and stepVM walks straight through.
  linear: boolean;
  repeatStarts: M<'repeatStart'>[];
  repeatStartById: Map<string, M<'repeatStart'>>;
  jumps: M<'jump'>[];
  times: Map<string, number>;
  endingStartAt: Map<number, EndingSpan>;
  endingEndAt: Map<number, EndingSpan>;
  endingStartsByRepeat: Map<string, number[]>;
  groupLastPosByRepeat: Map<string, number>;
  repeatEndAt: Map<number, M<'repeatEnd'>>;
  jumpAt: Map<number, M<'jump'>>;
  toCodaAt: Map<number, M<'toCoda'>>;
  fineAt: Set<number>;
  segno: M<'segno'> | undefined;
  coda: M<'coda'> | undefined;
  cap: number;
}

export type CompileResult =
  | { ok: true; compiled: CompiledRoadmap }
  | { ok: false; error: RoadmapError };

// The live VM state — the serializable snapshot the MD owns and broadcasts.
export interface VMState {
  cursor: number;                          // bar position index (into compiled.bars)
  completedPasses: Record<string, number>; // repeatStartId → passes finished
  fired: Record<string, boolean>;          // jumpId → has fired (at most once)
  flags: { toCodaFired: boolean; alFineActive: boolean; alCodaArmed: boolean };
  passCount: Record<string, number>;       // barId → entry count (the `pass` number)
  // §3.3 vamp hold: repeatStartId being looped body-only (exit-increment
  // suppressed) until release; null = not holding.
  holding: string | null;
  done: boolean;
}

// ── MD overrides (design §3.2 / §3.3) ────────────────────────────────────────
// A directive replaces the NEXT step's state. The governing invariant (§3.3): a
// redirect may only set VM state the resolver can already reach on its own — so
// the overlay stays mechanically consistent with the default walk.
export type ExitPolicy = { kind: 'alCoda' } | { kind: 'alFine' };

export type Directive =
  // "Another round" — re-enter a repeat for one more full pass. Clamp the
  // target's completedPasses to times-1 (the natural "one pass from exit" state):
  // the next forward pass yields k=times → final ending / body-once → exits.
  | { kind: 'anotherRound'; repeatStartId: string }
  // Indefinite vamp: loop the repeat body-only (suppress the exit-increment).
  | { kind: 'hold'; repeatStartId: string }
  // Release the vamp: clamp to times-1 so the next exit takes the final ending.
  | { kind: 'release'; repeatStartId: string }
  // Skip to a bar; leave counters as-is. exit arms the al-Coda/al-Fine path.
  | { kind: 'jumpTo'; barId: string; exit?: ExitPolicy }
  // Re-arm an already-fired D.S./D.C. (a redirect before it is otherwise inert).
  | { kind: 'resetJump'; jumpId: string };

// ── Compile: validate + index (design §3.1, the resolver's first phase) ───────
// All structural error returns live here (the live stepper assumes a valid
// program). Pure over (bars, markers).
export function compileRoadmap(bars: { id: string }[], markers: RoadmapMarker[]): CompileResult {
  const barPos = new Map<string, number>();
  bars.forEach((b, i) => barPos.set(b.id, i));

  const err = (markerIds: string[], reason: string): CompileResult => ({
    ok: false,
    error: { markerIds, reason },
  });

  // Degenerate case: no roadmap ⇒ linear playback.
  if (markers.length === 0) {
    return {
      ok: true,
      compiled: {
        bars,
        barPos,
        linear: true,
        repeatStarts: [],
        repeatStartById: new Map(),
        jumps: [],
        times: new Map(),
        endingStartAt: new Map(),
        endingEndAt: new Map(),
        endingStartsByRepeat: new Map(),
        groupLastPosByRepeat: new Map(),
        repeatEndAt: new Map(),
        jumpAt: new Map(),
        toCodaAt: new Map(),
        fineAt: new Set(),
        segno: undefined,
        coda: undefined,
        cap: bars.length + ROADMAP_TERMINATION_K,
      },
    };
  }

  // Marker buckets.
  const repeatStarts = markers.filter((m): m is M<'repeatStart'> => m.kind === 'repeatStart');
  const repeatEnds = markers.filter((m): m is M<'repeatEnd'> => m.kind === 'repeatEnd');
  const endings = markers.filter((m): m is M<'ending'> => m.kind === 'ending');
  const segnos = markers.filter((m): m is M<'segno'> => m.kind === 'segno');
  const codas = markers.filter((m): m is M<'coda'> => m.kind === 'coda');
  const fines = markers.filter((m): m is M<'fine'> => m.kind === 'fine');
  const toCodas = markers.filter((m): m is M<'toCoda'> => m.kind === 'toCoda');
  const jumps = markers.filter((m): m is M<'jump'> => m.kind === 'jump');

  // Defensive FK guard (the resolver also runs on hand-edited DB rows). §5 #7.
  const repeatStartById = new Map(repeatStarts.map((m) => [m.id, m]));
  for (const m of markers) {
    if (m.kind === 'ending') {
      if (!m.barIds.every((b) => barPos.has(b))) return err([m.id], 'ending references a missing bar');
    } else if (!barPos.has(m.barId)) {
      return err([m.id], `${m.kind} references a missing bar`);
    }
    if ((m.kind === 'repeatEnd' || m.kind === 'ending') && !repeatStartById.has(m.repeatStartId)) {
      return err([m.id], `${m.kind} is not bound to a repeatStart`);
    }
  }

  // §5 — no two same-kind markers may share a bar (the walk keys actions by bar
  // position; a duplicate would silently overwrite the first).
  const byKindBar = new Map<string, string[]>();
  for (const m of markers) {
    if (m.kind === 'ending') continue;
    const key = `${m.kind}\u0000${m.barId}`;
    const arr = byKindBar.get(key) ?? [];
    arr.push(m.id);
    byKindBar.set(key, arr);
  }
  for (const [key, ids] of byKindBar) {
    if (ids.length > 1) {
      return err(ids, `duplicate ${key.split('\u0000')[0]} markers on the same bar`);
    }
  }

  // §5 #2 — at most one segno/coda/fine.
  if (segnos.length > 1) return err(segnos.map((m) => m.id), 'multiple Segno markers');
  if (codas.length > 1) return err(codas.map((m) => m.id), 'multiple Coda markers');
  if (fines.length > 1) return err(fines.map((m) => m.id), 'multiple Fine markers');

  // §5 #1 — jump / Coda resolvability.
  for (const j of jumps) {
    if (j.from === 'segno' && segnos.length === 0) return err([j.id], 'D.S. has no Segno');
    if (j.until === 'fine' && fines.length === 0) return err([j.id], 'al Fine has no Fine');
    if (j.until === 'coda' && codas.length === 0) return err([j.id], 'al Coda has no Coda');
    if (j.until === 'coda' && toCodas.length === 0) return err([j.id], 'al Coda has no To Coda');
  }
  for (const tc of toCodas) {
    if (codas.length === 0) return err([tc.id], 'To Coda has no Coda');
  }

  // Per-repeat structure: times, span ordering (#5), ending ranges (#6),
  // partition (#3), mixed expression (#4).
  const times = new Map<string, number>();
  const endingSpansByRepeat = new Map<string, EndingSpan[]>();

  for (const R of repeatStarts) {
    const rPos = barPos.get(R.barId)!;
    const boundEnds = repeatEnds.filter((m) => m.repeatStartId === R.id);
    const boundEndings = endings.filter((m) => m.repeatStartId === R.id);

    // §5 #4 — a repeat is expressed EITHER plain OR as voltas, never both.
    if (boundEnds.length > 0 && boundEndings.length > 0) {
      return err([R.id, ...boundEnds.map((m) => m.id), ...boundEndings.map((m) => m.id)],
        'repeat has both a plain repeatEnd and volta endings');
    }
    // Two :| for one |: makes the back-jump ambiguous.
    if (boundEnds.length > 1) {
      return err([R.id, ...boundEnds.map((m) => m.id)], 'repeat has multiple repeatEnd markers');
    }

    if (boundEndings.length > 0) {
      // §5 #5 — every volta bar must come after the repeatStart.
      for (const e of boundEndings) {
        for (const b of e.barIds) {
          if (barPos.get(b)! <= rPos) return err([R.id, e.id], 'volta ending precedes its repeatStart');
        }
      }
      // §5 #6 — each ending's bars contiguous in reading order.
      const spans: EndingSpan[] = [];
      for (const e of boundEndings) {
        const positions = e.barIds.map((b) => barPos.get(b)!).sort((a, b) => a - b);
        const unique = new Set(positions);
        if (unique.size !== positions.length) return err([e.id], 'ending has duplicate bars');
        if (positions[positions.length - 1] - positions[0] !== positions.length - 1) {
          return err([e.id], 'ending bars are not contiguous');
        }
        spans.push({ marker: e, repeatStartId: R.id, startPos: positions[0], lastPos: positions[positions.length - 1] });
      }
      // §5 #6 — endings sorted, non-overlapping, no shared bar.
      spans.sort((a, b) => a.startPos - b.startPos);
      for (let i = 1; i < spans.length; i++) {
        if (spans[i].startPos <= spans[i - 1].lastPos) {
          return err([spans[i - 1].marker.id, spans[i].marker.id], 'endings overlap or share a bar');
        }
      }
      // §5 #3 — passes partition 1..max with no gap/overlap.
      const all = boundEndings.flatMap((e) => e.numbers);
      const seen = new Set<number>();
      for (const n of all) {
        if (seen.has(n)) return err(boundEndings.map((e) => e.id), 'volta passes overlap');
        seen.add(n);
      }
      const max = Math.max(...all);
      for (let n = 1; n <= max; n++) {
        if (!seen.has(n)) return err(boundEndings.map((e) => e.id), 'volta passes do not partition 1..max');
      }
      times.set(R.id, max);
      endingSpansByRepeat.set(R.id, spans);
    } else if (boundEnds.length === 1) {
      const e = boundEnds[0];
      // §5 #5 — repeatEnd must come after its repeatStart.
      if (barPos.get(e.barId)! <= rPos) return err([R.id, e.id], 'repeatEnd precedes its repeatStart');
      times.set(R.id, e.times ?? 2);
    } else {
      // Lone repeatStart — cosmetic no-op (never a back-jump target).
      times.set(R.id, 1);
    }
  }

  // Walk lookups.
  const segno = segnos[0];
  const coda = codas[0];
  const endingStartAt = new Map<number, EndingSpan>();
  const endingEndAt = new Map<number, EndingSpan>();
  const endingStartsByRepeat = new Map<string, number[]>();
  const groupLastPosByRepeat = new Map<string, number>();
  for (const [rsId, spans] of endingSpansByRepeat) {
    for (const span of spans) {
      endingStartAt.set(span.startPos, span);
      endingEndAt.set(span.lastPos, span);
    }
    endingStartsByRepeat.set(rsId, spans.map((s) => s.startPos).sort((a, b) => a - b));
    groupLastPosByRepeat.set(rsId, Math.max(...spans.map((s) => s.lastPos)));
  }
  const repeatEndAt = new Map<number, M<'repeatEnd'>>();
  for (const e of repeatEnds) repeatEndAt.set(barPos.get(e.barId)!, e);
  const jumpAt = new Map<number, M<'jump'>>();
  for (const j of jumps) jumpAt.set(barPos.get(j.barId)!, j);
  const toCodaAt = new Map<number, M<'toCoda'>>();
  for (const tc of toCodas) toCodaAt.set(barPos.get(tc.barId)!, tc);
  const fineAt = new Set<number>(fines.map((f) => barPos.get(f.barId)!));

  // §4 termination backstop.
  let timesProduct = 1;
  for (const t of times.values()) timesProduct *= t;
  const cap = bars.length * timesProduct * (jumps.length + 1) + ROADMAP_TERMINATION_K;

  return {
    ok: true,
    compiled: {
      bars,
      barPos,
      linear: false,
      repeatStarts,
      repeatStartById,
      jumps,
      times,
      endingStartAt,
      endingEndAt,
      endingStartsByRepeat,
      groupLastPosByRepeat,
      repeatEndAt,
      jumpAt,
      toCodaAt,
      fineAt,
      segno,
      coda,
      cap,
    },
  };
}

// ── Init: the starting VM state (mirrors resolveRoadmap's walk-state seed) ────
export function initVM(compiled: CompiledRoadmap): VMState {
  const completedPasses: Record<string, number> = {};
  for (const R of compiled.repeatStarts) completedPasses[R.id] = 0;
  const fired: Record<string, boolean> = {};
  for (const j of compiled.jumps) fired[j.id] = false;
  return {
    cursor: 0,
    completedPasses,
    fired,
    flags: { toCodaFired: false, alFineActive: false, alCodaArmed: false },
    passCount: {},
    holding: null,
    done: compiled.bars.length === 0,
  };
}

function cloneState(s: VMState): VMState {
  return {
    cursor: s.cursor,
    completedPasses: { ...s.completedPasses },
    fired: { ...s.fired },
    flags: { ...s.flags },
    passCount: { ...s.passCount },
    holding: s.holding,
    done: s.done,
  };
}

// Nested-reset on back-jump: replay inner repeats on each outer pass (§4).
// Mutates `s.completedPasses` for repeats nested between the target and trigger.
function backJump(compiled: CompiledRoadmap, s: VMState, rsId: string, triggerPos: number): number {
  const target = compiled.barPos.get(compiled.repeatStartById.get(rsId)!.barId)!;
  for (const R of compiled.repeatStarts) {
    if (R.id === rsId) continue;
    const sp = compiled.barPos.get(R.barId)!;
    if (sp > target && sp <= triggerPos) s.completedPasses[R.id] = 0;
  }
  return target;
}

// The end (last) bar position of a repeat's body: the volta group's last bar, or
// the plain repeatEnd, or (lone repeatStart) its own bar. Used to scope a
// re-enter's descendant nested-reset.
function repeatEndPos(compiled: CompiledRoadmap, rsId: string): number {
  const grp = compiled.groupLastPosByRepeat.get(rsId);
  if (grp !== undefined) return grp;
  for (const [pos, re] of compiled.repeatEndAt) {
    if (re.repeatStartId === rsId) return pos;
  }
  return compiled.barPos.get(compiled.repeatStartById.get(rsId)!.barId)!;
}

// ── Step: produce the next transition (one iteration of the resolver walk) ────
// Returns the next recorded bar plus the repositioned state. No transition +
// state.done ⇒ the traversal is complete. Pure: never mutates the input.
export function stepVM(compiled: CompiledRoadmap, stateIn: VMState): { transition?: TraversalStep; state: VMState } {
  if (stateIn.done) return { state: stateIn };
  const s = cloneState(stateIn);

  if (compiled.linear) {
    if (s.cursor >= compiled.bars.length) {
      s.done = true;
      return { state: s };
    }
    const bar = compiled.bars[s.cursor];
    const pass = (s.passCount[bar.id] ?? 0) + 1;
    s.passCount[bar.id] = pass;
    s.cursor++;
    if (s.cursor >= compiled.bars.length) s.done = true;
    return { transition: { barId: bar.id, pass }, state: s };
  }

  // Rule 1 — volta entry-select. Skip an ending whose numbers exclude the
  // current pass; fall through to the next ending (or past the group).
  while (s.cursor < compiled.bars.length) {
    const startSpan = compiled.endingStartAt.get(s.cursor);
    if (startSpan) {
      // §3.3 vamp: while holding this repeat, do NOT enter the ending group —
      // loop the body only (back-jump to the repeat start), keeping the band
      // BEFORE the endings until release. (Plain repeats have no ending group;
      // their hold is handled at the repeatEnd edge below.)
      if (s.holding === startSpan.repeatStartId) {
        s.cursor = backJump(compiled, s, startSpan.repeatStartId, s.cursor);
        continue;
      }
      const k = (s.completedPasses[startSpan.repeatStartId] ?? 0) + 1;
      if (!startSpan.marker.numbers.includes(k)) {
        const starts = compiled.endingStartsByRepeat.get(startSpan.repeatStartId)!;
        const next = starts.find((p) => p > s.cursor);
        s.cursor = next ?? compiled.groupLastPosByRepeat.get(startSpan.repeatStartId)! + 1;
        continue;
      }
    }
    break;
  }
  if (s.cursor >= compiled.bars.length) {
    s.done = true;
    return { state: s };
  }

  // Record the bar.
  const bar = compiled.bars[s.cursor];
  const pass = (s.passCount[bar.id] ?? 0) + 1;
  s.passCount[bar.id] = pass;
  const transition: TraversalStep = { barId: bar.id, pass };

  // End-edge rules, in priority order. `handled` ⇒ cursor already repositioned.
  let handled = false;

  // Rule 2a — exit of a taken volta (back-jump point). If a vamp hold was placed
  // mid-ending (after the band already entered it), loop instead of exiting
  // (suppress the increment); subsequent body passes are intercepted before the
  // ending group by Rule 1 above (§3.3).
  const exitSpan = compiled.endingEndAt.get(s.cursor);
  if (exitSpan) {
    const R = exitSpan.repeatStartId;
    if (s.holding === R) {
      s.cursor = backJump(compiled, s, R, s.cursor);
      handled = true;
    } else {
      s.completedPasses[R] = (s.completedPasses[R] ?? 0) + 1;
      if (s.completedPasses[R] < compiled.times.get(R)!) {
        s.cursor = backJump(compiled, s, R, s.cursor);
        handled = true;
      }
    }
  }

  // Rule 2b — plain repeatEnd. Same vamp-hold suppression.
  if (!handled) {
    const re = compiled.repeatEndAt.get(s.cursor);
    if (re) {
      const R = re.repeatStartId;
      if (s.holding === R) {
        s.cursor = backJump(compiled, s, R, s.cursor);
        handled = true;
      } else {
        s.completedPasses[R] = (s.completedPasses[R] ?? 0) + 1;
        if (s.completedPasses[R] < compiled.times.get(R)!) {
          s.cursor = backJump(compiled, s, R, s.cursor);
          handled = true;
        }
      }
    }
  }

  // Rule 3 — jump (D.C./D.S.), fires at most once.
  if (!handled) {
    const j = compiled.jumpAt.get(s.cursor);
    if (j && !s.fired[j.id]) {
      s.fired[j.id] = true;
      if (j.until === 'fine') s.flags.alFineActive = true;
      if (j.until === 'coda') s.flags.alCodaArmed = true;
      s.cursor = j.from === 'capo' ? 0 : compiled.barPos.get(compiled.segno!.barId)!;
      handled = true;
    }
  }

  // Rule 4 — To Coda (only once an al Coda jump has armed it).
  if (!handled && s.flags.alCodaArmed && !s.flags.toCodaFired) {
    const tc = compiled.toCodaAt.get(s.cursor);
    if (tc) {
      s.flags.toCodaFired = true;
      s.cursor = compiled.barPos.get(compiled.coda!.barId)!;
      handled = true;
    }
  }

  // Rule 5 — Fine (only once an al Fine jump has activated it). Stop after this bar.
  if (!handled && s.flags.alFineActive && compiled.fineAt.has(s.cursor)) {
    s.done = true;
    return { transition, state: s };
  }

  // Rule 6 — advance.
  if (!handled) {
    s.cursor++;
    if (s.cursor >= compiled.bars.length) s.done = true;
  }

  return { transition, state: s };
}

// ── applyOverride: the MD redirect (design §3.3 counter policy) ───────────────
// Pure: returns a new state. Unknown targets are no-ops (a stale/corrupt
// directive must never crash the live VM). Idempotency under (epoch, seq) is the
// state-machine layer's job (chunk 3); this is just the state delta.
export function applyOverride(compiled: CompiledRoadmap, stateIn: VMState, directive: Directive): VMState {
  const s = cloneState(stateIn);
  switch (directive.kind) {
    case 'anotherRound': {
      const rs = compiled.repeatStartById.get(directive.repeatStartId);
      const t = compiled.times.get(directive.repeatStartId);
      if (!rs || t === undefined) return s;
      const targetPos = compiled.barPos.get(rs.barId)!;
      s.cursor = targetPos;
      // Clamp to the natural "one pass from exit" state: the next forward pass
      // yields k=times → final ending / body-once → exits. (Holding at `times`
      // would skip the whole ending group — wrong; §3.3.)
      s.completedPasses[directive.repeatStartId] = t - 1;
      // Reset descendant (nested) repeats to 0, mirroring backJump's nested-reset.
      // Do NOT touch `fired` D.S./D.C. flags or sibling counters.
      const endPos = repeatEndPos(compiled, directive.repeatStartId);
      for (const R of compiled.repeatStarts) {
        if (R.id === directive.repeatStartId) continue;
        const sp = compiled.barPos.get(R.barId)!;
        if (sp > targetPos && sp <= endPos) s.completedPasses[R.id] = 0;
      }
      s.done = false;
      return s;
    }
    case 'hold': {
      s.holding = directive.repeatStartId;
      return s;
    }
    case 'release': {
      // Release applies ONLY to the repeat currently being vamped — a stale or
      // accidental release of an unheld repeat must not clamp its counter (which
      // would make a future traversal take the final ending / exit early).
      if (s.holding !== directive.repeatStartId) return s;
      s.holding = null;
      // Clamp so the next exit takes the final ending (§3.3).
      const t = compiled.times.get(directive.repeatStartId);
      if (t !== undefined) s.completedPasses[directive.repeatStartId] = t - 1;
      return s;
    }
    case 'jumpTo': {
      const pos = compiled.barPos.get(directive.barId);
      if (pos === undefined) return s;
      s.cursor = pos;
      s.done = false;
      // Leave repeat counters as-is. exit arms the al-Coda/al-Fine out (§3.3); a
      // redirect landing before an already-`fired` jump stays inert by default
      // (Rule 3 won't re-fire) unless an explicit resetJump precedes it.
      // alCoda starts a FRESH al-Coda path: also clear toCodaFired so Rule 4
      // (alCodaArmed && !toCodaFired) takes To Coda again even after a prior fire.
      if (directive.exit?.kind === 'alCoda') {
        s.flags.alCodaArmed = true;
        s.flags.toCodaFired = false;
      }
      if (directive.exit?.kind === 'alFine') s.flags.alFineActive = true;
      return s;
    }
    case 'resetJump': {
      if (directive.jumpId in s.fired) s.fired[directive.jumpId] = false;
      return s;
    }
  }
}
