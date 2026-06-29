import type { Bar, ChartCalibration, SectionAnchor } from './types';
import { barsInOrder } from './chart-calibration';
import { normalizeLabel } from './song-structure';
import {
  type CompiledRoadmap,
  type VMState,
  type ExitPolicy,
  type Directive,
  stepVM,
  applyOverride,
} from './roadmap-vm';
import type { Armed } from './conductor-state';

// ── Conductor authority, chunk 4: the armable-target + redirect enumerators ───
//
// (design-conductor-chunk4.md §2 / §3 / §5). Pure helpers that own VALIDITY so the
// React UI never has to: which jumpTo targets are armable (with target-aware exit
// options), which immediate redirects actually do something against the current VM
// state, where the default fire marker lands, and whether a placement is
// auto-fire-eligible. Every id is LOCAL (the MD's own ChartCalibration); the
// canonical SongStructure layer is a 3b cross-chart concern (design §0 / D0).

// An armable jumpTo target — a finite, enumerable LOCAL chart position (parent
// locked: "redirect = jump to an EXISTING node; overlay, never edit").
export interface JumpTarget {
  barId: string; // the Armed.directive.barId (a LOCAL bar id)
  label: string; // human label for the picker + telegraph badge
  kind: 'segno' | 'coda' | 'fine' | 'section' | 'repeatStart' | 'bar';
  // target-aware exit eligibility: which of alCoda/alFine are MEANINGFUL from THIS
  // target ([] = none). Computed here so the UI never recomputes it.
  exitOptions: ExitPolicy['kind'][];
}

// An applicable immediate redirect (the chunk-3 reducer admits + seq-burns any
// redirect, so the PURE layer — not React discipline — must enumerate only the
// ones that are not a reducer no-op; design §5 / Codex R2 High-2).
export interface RedirectOption {
  label: string;
  directive: Directive;
}

// alCoda iff a To-Coda EXISTS at or after the target's bar position; alFine iff a
// Fine likewise. Existential over the Map/Set (a program may carry several
// To-Codas / a Fine; compileRoadmap does not reject multiples) — design §2.
function exitOptionsFor(compiled: CompiledRoadmap, barId: string): ExitPolicy['kind'][] {
  const pos = compiled.barPos.get(barId);
  if (pos === undefined) return [];
  const out: ExitPolicy['kind'][] = [];
  for (const p of compiled.toCodaAt.keys()) {
    if (p >= pos) {
      out.push('alCoda');
      break;
    }
  }
  for (const p of compiled.fineAt) {
    if (p >= pos) {
      out.push('alFine');
      break;
    }
  }
  return out;
}

// 1-based occurrence index of each section among same-normalized-label siblings,
// plus the per-label total — so a label only carries an ordinal when it repeats
// ("Chorus 1"/"Chorus 2", but a lone "Bridge" stays "Bridge"). `sectionOrdinals`
// in song-structure.ts is private, so recompute locally over the exported
// `normalizeLabel` (design §2 / Codex R2 Low).
function sectionLabelInfo(sections: SectionAnchor[]): { ordinal: Map<string, number>; total: Map<string, number> } {
  const total = new Map<string, number>();
  for (const s of sections) {
    const k = normalizeLabel(s.label);
    total.set(k, (total.get(k) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const ordinal = new Map<string, number>();
  for (const s of sections) {
    const k = normalizeLabel(s.label);
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    ordinal.set(s.id, n);
  }
  return { ordinal, total };
}

// Enumerate legal jumpTo targets from the MD's LOCAL chart. Named landmarks first
// (the calls an MD actually makes), then section heads, then repeat starts, then
// plain bars (de-emphasized, deduped against the above). `compiled.barPos` is the
// validity oracle — every emitted target is a present local bar.
export function armableTargets(compiled: CompiledRoadmap, cal: ChartCalibration): JumpTarget[] {
  const ordered = barsInOrder(cal); // the VM's TRAVERSAL order (NOT min absNumber)
  const barById = new Map<string, Bar>(ordered.map((b) => [b.id, b]));
  const markers = cal.roadmap ?? [];
  const targets: JumpTarget[] = [];
  const push = (barId: string, label: string, kind: JumpTarget['kind']) => {
    if (!compiled.barPos.has(barId)) return;
    targets.push({ barId, label, kind, exitOptions: exitOptionsFor(compiled, barId) });
  };

  // Named landmarks first: Coda, Segno, Fine (from the local roadmap markers).
  const coda = markers.find((m) => m.kind === 'coda');
  if (coda) push(coda.barId, 'Coda', 'coda');
  const segno = markers.find((m) => m.kind === 'segno');
  if (segno) push(segno.barId, 'Segno', 'segno');
  const fine = markers.find((m) => m.kind === 'fine');
  if (fine) push(fine.barId, 'Fine', 'fine');

  // Section heads — each SectionAnchor's first bar in TRAVERSAL order (the same
  // order compileRoadmap runs on), labelled + ordinal'd locally.
  const { ordinal, total } = sectionLabelInfo(cal.sections);
  for (const sec of cal.sections) {
    const head = ordered.find((b) => b.sectionId === sec.id);
    if (!head) continue;
    const repeats = (total.get(normalizeLabel(sec.label)) ?? 0) > 1;
    const label = repeats ? `${sec.label} ${ordinal.get(sec.id)}` : sec.label;
    push(head.id, label, 'section');
  }

  // Repeat starts (back-jump landmarks).
  for (const rs of compiled.repeatStarts) {
    const bar = barById.get(rs.barId);
    const label = bar ? `Repeat (m. ${bar.absNumber})` : 'Repeat';
    push(rs.barId, label, 'repeatStart');
  }

  // Plain bars — available but de-emphasized; deduped against the named targets
  // above so a bar is never listed twice. A linear/section-less chart yields these
  // only (no crash on absent sections).
  const used = new Set(targets.map((t) => t.barId));
  for (const b of ordered) {
    if (used.has(b.id)) continue;
    push(b.id, `Bar ${b.absNumber}`, 'bar');
  }

  return targets;
}

// Structural VMState equality — both operands always share the SAME key sets here
// (applyOverride only mutates existing keys, never adds/removes), so a record-wise
// scalar compare is exact. Used to enforce the "no seq for zero STATE change" rule.
function sameRecord<T>(a: Record<string, T>, b: Record<string, T>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}
function sameVM(a: VMState, b: VMState): boolean {
  return (
    a.cursor === b.cursor &&
    a.holding === b.holding &&
    a.done === b.done &&
    a.flags.toCodaFired === b.flags.toCodaFired &&
    a.flags.alFineActive === b.flags.alFineActive &&
    a.flags.alCodaArmed === b.flags.alCodaArmed &&
    sameRecord(a.completedPasses, b.completedPasses) &&
    sameRecord(a.fired, b.fired) &&
    sameRecord(a.passCount, b.passCount)
  );
}

// Enumerate ONLY directives that actually MOVE this vm (design §5). The guarantee is
// "won't silently burn a seq for zero STATE change," NOT "guaranteed musically
// audible." Candidates are SEMANTICALLY scoped first — anotherRound/hold only for a
// REAL repeat (times > 1 OR an ending group; a lone/cosmetic repeatStart is inert),
// release per repeat, resetJump per jump — then the AUTHORITATIVE no-op filter drops
// any whose applyOverride leaves the vm byte-identical. That filter (not the
// per-candidate scoping) owns the seq-burn guarantee: it also closes the case Codex
// found where an ending group with max pass 1 compiles to times === 1, so
// anotherRound clamps completedPasses to t-1 === 0 and changes nothing.
export function availableRedirects(compiled: CompiledRoadmap, vm: VMState): RedirectOption[] {
  const candidates: RedirectOption[] = [];

  for (const rs of compiled.repeatStarts) {
    const real = (compiled.times.get(rs.id) ?? 0) > 1 || compiled.endingStartsByRepeat.has(rs.id);
    if (real) {
      candidates.push({ label: 'Another round', directive: { kind: 'anotherRound', repeatStartId: rs.id } });
      candidates.push({ label: 'Vamp (hold)', directive: { kind: 'hold', repeatStartId: rs.id } });
    }
    // release is musically meaningful only for the held repeat; the no-op filter
    // below is what actually enforces that (applyOverride release on an unheld
    // repeat returns the vm unchanged).
    candidates.push({ label: 'Release vamp', directive: { kind: 'release', repeatStartId: rs.id } });
  }

  // resetJump re-arms an already-fired D.S./D.C. — "Re-arm jump" (NOT "Reset", which
  // misreads as resetting playback; design §5 Low). The no-op filter keeps only the
  // jumps that have actually fired.
  for (const j of compiled.jumps) {
    candidates.push({ label: 'Re-arm jump', directive: { kind: 'resetJump', jumpId: j.id } });
  }

  return candidates.filter((c) => !sameVM(vm, applyOverride(compiled, vm, c.directive)));
}

// The REAL next emitted bar (the natural "next downbeat" telegraph default) — a
// pure stepVM PEEK, NOT `compiled.bars[vm.cursor]`: vm.cursor is only the next
// CANDIDATE index, and stepVM's Rule-1 volta-entry-select skips a pass-excluded
// ending span before recording a bar (roadmap-vm.ts:396-418), so the raw-cursor bar
// can be one the VM will skip (design §3 / Codex R5 High). undefined at song end.
export function nextEmittedBarId(compiled: CompiledRoadmap, vm: VMState): string | undefined {
  return stepVM(compiled, vm).transition?.barId;
}

// A FORWARD-POSITION check anchored to the REAL next emitted bar (design §3). Used
// at arm/re-tap time to flag an auto-fire-INELIGIBLE placement (a fireAt the
// playhead never reaches again would be a dead marker for chunk-5 auto-fire). The
// floor is the PEEKED next-emit position, NOT raw vm.cursor: a pass-excluded volta
// bar that stepVM skips sits at pos < nextEmitPos and is correctly ineligible; the
// default fireAt (= the peek) is eligible by construction (pos === nextEmitPos).
//
// SCOPE/HONESTY (Codex R5 Med): this is a forward-POSITION heuristic, NOT a
// full-traversal reachability proof (repeats/jumps/Coda/Fine can revisit or skip
// bars). It is sufficient for chunk 4 (advisory display) and is the floor chunk-5
// auto-fire ANDs with the §3.5 confidence gate; chunk 5 may upgrade it to a bounded
// VM walk without changing this signature.
export function fireAtEligible(compiled: CompiledRoadmap, vm: VMState, fireAt: string): boolean {
  const peek = stepVM(compiled, vm).transition;
  if (!peek) return false; // song end / walks off the end — no next emitted bar
  const nextEmitPos = compiled.barPos.get(peek.barId);
  const pos = compiled.barPos.get(fireAt);
  if (nextEmitPos === undefined || pos === undefined) return false;
  return pos >= nextEmitPos;
}

// ── Insert-and-return: resolve the return leg for a backward SECTION call ──────
// (design-conductor-insert-return.md §2/§3). Returns the bare positions the VM
// needs, or null when the call is forward / not a section / has no anchor / has no
// successor (caller then emits a plain continue-from-target jumpTo). The whole
// JumpTarget is passed so we can gate on `kind` (D9): coda/segno/fine/repeatStart/
// plain-bar backward jumps stay continue-from-target. `currentBarId` is the
// LAST-EMITTED bar (NOT vm.cursor-1 — after a back-jump the cursor sits elsewhere);
// it pins both the direction test and the anchor lookup.
export function resolveInsertReturn(
  compiled: CompiledRoadmap,
  cal: ChartCalibration,
  target: JumpTarget,
  currentBarId: string | undefined,
): { afterPos: number; returnBarId: string } | null {
  if (target.kind !== 'section') return null; // D9 — section-only

  const targetPos = compiled.barPos.get(target.barId);
  const curPos = currentBarId ? compiled.barPos.get(currentBarId) : undefined;
  if (targetPos === undefined || curPos === undefined) return null;
  if (targetPos >= curPos) return null; // forward → no return (D1)

  const ordered = barsInOrder(cal); // == compiled.bars order (compile runs on this)

  // CONTIGUITY is required on BOTH sides (Codex build review R1/R2 HIGH). The live
  // model permits null/interleaved sectionId membership (chart-calibration.ts does
  // not require contiguous ownership, canVerify never checks it), so a conductable
  // chart may carry e.g. Intro:b1,b2 / null:b3 / Intro:b4, or a disjoint anchor run
  // (Verse:b3 … Verse:b5). Either side being non-contiguous makes "the section" /
  // "its successor" ambiguous, so we fail closed → resolveArm bakes NO return →
  // plain continue-from-target jumpTo (the safe pre-feature behavior).

  // Anchor = the section of the currently-playing bar; must be a single contiguous
  // run so its successor is unambiguous. (Non-contiguous anchor: a first-occurrence
  // successor would point BEHIND the live playhead — the R2 case.)
  const anchorSectionId = ordered[curPos]?.sectionId;
  if (anchorSectionId == null) return null; // section-less anchor (D8)
  const anchorRun = sectionRun(ordered, anchorSectionId);
  if (!anchorRun) return null; // non-contiguous anchor → fail closed
  const successor = successorSectionHead(ordered, anchorRun.end);
  if (!successor) return null; // anchor is the last section, or its successor is unclean

  // Target = the inserted section; afterPos is the END of its contiguous run.
  const targetSectionId = ordered[targetPos]?.sectionId;
  if (targetSectionId == null) return null;
  const targetRun = sectionRun(ordered, targetSectionId);
  if (!targetRun) return null; // non-contiguous target → fail closed (no tail-skip)
  return { afterPos: targetRun.end, returnBarId: successor.id };
}

// The single contiguous run [start,end] of bars owning `sectionId`, or null when
// the section is non-contiguous (reappears after a gap) or absent. Insert-return
// supports CONTIGUOUS section ownership only and fails closed otherwise.
function sectionRun(ordered: Bar[], sectionId: string): { start: number; end: number } | null {
  let start = -1;
  let end = -1;
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i].sectionId !== sectionId) continue;
    if (start < 0) {
      start = i;
      end = i;
    } else if (i === end + 1) {
      end = i;
    } else {
      return null; // a gap then a reappearance → non-contiguous
    }
  }
  return start < 0 ? null : { start, end };
}

// The anchor's successor section head: the FIRST non-null-section bar strictly
// after the anchor run's end (skipping inter-section null bars). It must be that
// section's FIRST occurrence (a clean head); a later occurrence of an already-seen
// section (a repeating/non-contiguous successor) is ambiguous → undefined (fail
// closed). undefined also when nothing follows (anchor is the last section).
function successorSectionHead(ordered: Bar[], anchorEnd: number): Bar | undefined {
  const firstOf = new Map<string, number>();
  ordered.forEach((b, i) => {
    if (b.sectionId != null && !firstOf.has(b.sectionId)) firstOf.set(b.sectionId, i);
  });
  for (let i = anchorEnd + 1; i < ordered.length; i++) {
    const sid = ordered[i].sectionId;
    if (sid == null) continue; // skip inter-section null bars
    return firstOf.get(sid) === i ? ordered[i] : undefined; // clean head, else fail closed
  }
  return undefined;
}

// Re-resolve an arm request in the PURE layer and mint the Armed marker (design §2
// / Codex R3 High-3, R4 High-3, R5). The controller must NOT trust the passed
// target object: a stale/spoofed envelope can carry a bad barId AND a spoofed
// exitOptions. So re-derive the authoritative target from a fresh
// armableTargets(compiled, cal) by a STABLE IDENTITY { barId, kind, label } —
// armableTargets legally emits several targets for ONE bar (Coda + a section head
// + Repeat-all can co-sit on bar 1), and `kind` now decides whether a return is
// baked, so matching on barId alone would pick an arbitrary one:
//   • fireAt is not a present local bar     → null (validity at the fire end);
//   • no match OR an ambiguous match        → null (never guess — stale/spoofed);
//   • keep `exit` ONLY if it is in the RECOMPUTED target's exitOptions;
//   • bake the insert-return leg via resolveInsertReturn against the RE-DERIVED
//     target — but ONLY when no `exit` was REQUESTED (the `exit` ARG, not the kept
//     one: a stale/dropped exit still suppresses the default return — §4.2/§4.3/D10).
export function resolveArm(
  compiled: CompiledRoadmap,
  cal: ChartCalibration,
  id: { barId: string; kind: JumpTarget['kind']; label: string },
  exit: ExitPolicy['kind'] | undefined,
  fireAt: string,
  currentBarId: string | undefined,
): Armed | null {
  if (!compiled.barPos.has(fireAt)) return null;
  const matches = armableTargets(compiled, cal).filter(
    (t) => t.barId === id.barId && t.kind === id.kind && t.label === id.label,
  );
  if (matches.length !== 1) return null; // no match OR ambiguous → reject
  const target = matches[0];

  const keepExit = exit !== undefined && target.exitOptions.includes(exit) ? exit : undefined;
  const ret =
    exit === undefined && target.kind === 'section'
      ? resolveInsertReturn(compiled, cal, target, currentBarId)
      : null;

  const directive: Extract<Directive, { kind: 'jumpTo' }> = { kind: 'jumpTo', barId: id.barId };
  if (keepExit) directive.exit = { kind: keepExit };
  if (ret) directive.return = ret;
  return { fireAt, directive };
}
