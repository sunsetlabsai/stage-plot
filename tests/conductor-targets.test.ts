import { describe, it, expect } from 'vitest';
import {
  armableTargets,
  availableRedirects,
  nextEmittedBarId,
  fireAtEligible,
  resolveArm,
  resolveInsertReturn,
} from '../lib/conductor-targets';
import { compileRoadmap, initVM, type CompiledRoadmap, type VMState } from '../lib/roadmap-vm';
import { barsInOrder } from '../lib/chart-calibration';
import type { ChartCalibration, SectionAnchor, RoadmapMarker } from '../lib/types';

// ── Fixture builders ─────────────────────────────────────────────────────────
// A LOCAL ChartCalibration: one system, bars left→right (xStart = index), so
// barsInOrder() == the declared order and absNumber = index+1.
function makeCal(
  bars: { id: string; sectionId?: string | null }[],
  sections: SectionAnchor[] = [],
  roadmap: RoadmapMarker[] = [],
): ChartCalibration {
  const systemId = 'sys1';
  return {
    schemaVersion: 3,
    status: 'verified',
    sections,
    systems: [{ id: systemId, page: 1, yTop: 0, yBottom: 0.2, xStart: 0, xEnd: 1 }],
    bars: bars.map((b, i) => ({
      id: b.id,
      systemId,
      xStart: i / bars.length,
      xEnd: (i + 1) / bars.length,
      absNumber: i + 1,
      sectionId: b.sectionId ?? null,
    })),
    roadmap,
  };
}

function compileCal(cal: ChartCalibration): CompiledRoadmap {
  const c = compileRoadmap(barsInOrder(cal), cal.roadmap ?? []);
  if (!c.ok) throw new Error(`compile failed: ${c.error.reason}`);
  return c.compiled;
}

const sec = (id: string, label: string): SectionAnchor => ({ id, page: 1, x: 0, y: 0, label });
const segno = (id: string, barId: string): RoadmapMarker => ({ id, kind: 'segno', barId, edge: 'start' });
const coda = (id: string, barId: string): RoadmapMarker => ({ id, kind: 'coda', barId, edge: 'start' });
const fine = (id: string, barId: string): RoadmapMarker => ({ id, kind: 'fine', barId, edge: 'end' });
const toCoda = (id: string, barId: string): RoadmapMarker => ({ id, kind: 'toCoda', barId, edge: 'end' });
const dc = (id: string, barId: string): RoadmapMarker =>
  ({ id, kind: 'jump', barId, edge: 'end', from: 'capo', until: 'end' });
const rstart = (id: string, barId: string): RoadmapMarker => ({ id, kind: 'repeatStart', barId, edge: 'start' });
const ending = (id: string, repeatStartId: string, barIds: string[], numbers: number[]): RoadmapMarker =>
  ({ id, kind: 'ending', repeatStartId, barIds, numbers });

const byId = <T extends { barId: string }>(ts: T[], id: string) => ts.find((t) => t.barId === id);

// ── armableTargets: landmark ordering, section heads, dedup ───────────────────
describe('armableTargets', () => {
  // b1..b7; Intro@b1, Verse@b3, Verse@b5 (repeated → ordinals); segno/coda/fine
  // on NON-section-head bars; b7 unsectioned (a plain bar).
  const cal = makeCal(
    [
      { id: 'b1', sectionId: 'sI' },
      { id: 'b2', sectionId: 'sI' },
      { id: 'b3', sectionId: 'sV1' },
      { id: 'b4', sectionId: 'sV1' },
      { id: 'b5', sectionId: 'sV2' },
      { id: 'b6', sectionId: 'sV2' },
      { id: 'b7', sectionId: null },
    ],
    [sec('sI', 'Intro'), sec('sV1', 'Verse'), sec('sV2', 'Verse')],
    [segno('S', 'b2'), coda('C', 'b4'), fine('F', 'b6')],
  );
  const compiled = compileCal(cal);
  const targets = armableTargets(compiled, cal);

  it('lists named landmarks FIRST, in Coda → Segno → Fine order', () => {
    expect(targets[0]).toMatchObject({ barId: 'b4', kind: 'coda', label: 'Coda' });
    expect(targets[1]).toMatchObject({ barId: 'b2', kind: 'segno', label: 'Segno' });
    expect(targets[2]).toMatchObject({ barId: 'b6', kind: 'fine', label: 'Fine' });
  });

  it('ordinals a repeated section label but leaves a lone label bare', () => {
    expect(byId(targets, 'b1')).toMatchObject({ kind: 'section', label: 'Intro' });
    expect(byId(targets, 'b3')).toMatchObject({ kind: 'section', label: 'Verse 1' });
    expect(byId(targets, 'b5')).toMatchObject({ kind: 'section', label: 'Verse 2' });
  });

  it('a section head is listed once (not also re-emitted as a plain bar)', () => {
    expect(targets.filter((t) => t.barId === 'b1')).toHaveLength(1);
    expect(byId(targets, 'b1')!.kind).toBe('section');
  });

  it('an unsectioned, non-landmark bar surfaces as a de-emphasized plain bar', () => {
    expect(byId(targets, 'b7')).toMatchObject({ kind: 'bar', label: 'Bar 7' });
  });

  it('every emitted target is a present local bar', () => {
    for (const t of targets) expect(compiled.barPos.has(t.barId)).toBe(true);
  });

  it('a linear/section-less chart yields plain bars only and does not crash', () => {
    const linear = makeCal([{ id: 'x1' }, { id: 'x2' }]);
    const ts = armableTargets(compileCal(linear), linear);
    expect(ts).toEqual([
      { barId: 'x1', label: 'Bar 1', kind: 'bar', exitOptions: [] },
      { barId: 'x2', label: 'Bar 2', kind: 'bar', exitOptions: [] },
    ]);
  });
});

// ── exitOptions: existential over toCoda (alCoda) / fine (alFine) ─────────────
describe('exitOptions (target-aware exit eligibility)', () => {
  it('alFine iff a Fine exists at/after the target; [] past it', () => {
    const cal = makeCal([{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }], [], [fine('F', 'b2')]);
    const ts = armableTargets(compileCal(cal), cal);
    expect(byId(ts, 'b1')!.exitOptions).toEqual(['alFine']); // pos0, fine@pos1
    expect(byId(ts, 'b2')!.exitOptions).toEqual(['alFine']); // pos1 === fine pos1
    expect(byId(ts, 'b3')!.exitOptions).toEqual([]); // pos2 past the fine
  });

  it('alCoda iff a To-Coda exists at/after the target; [] past it', () => {
    const cal = makeCal(
      [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }, { id: 'b4' }],
      [],
      [coda('C', 'b4'), toCoda('TC', 'b2')],
    );
    const ts = armableTargets(compileCal(cal), cal);
    expect(byId(ts, 'b1')!.exitOptions).toEqual(['alCoda']); // pos0, toCoda@pos1
    expect(byId(ts, 'b3')!.exitOptions).toEqual([]); // pos2 past the toCoda
  });
});

// ── availableRedirects: only NON-no-op directives against THIS vm ─────────────
describe('availableRedirects', () => {
  // A REAL repeat (volta group ⇒ times=2, ending starts present).
  const realCal = makeCal(
    [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }, { id: 'b4' }],
    [],
    [rstart('R', 'b1'), ending('E1', 'R', ['b3'], [1]), ending('E2', 'R', ['b4'], [2])],
  );
  const real = compileCal(realCal);

  it('offers anotherRound + hold for a real repeat at rest', () => {
    const opts = availableRedirects(real, initVM(real));
    expect(opts.map((o) => o.label)).toEqual(['Another round', 'Vamp (hold)']);
  });

  it('swaps hold→release for the currently-held repeat (no seq-burning re-hold)', () => {
    const held: VMState = { ...initVM(real), holding: 'R' };
    const opts = availableRedirects(real, held);
    expect(opts.map((o) => o.label)).toEqual(['Another round', 'Release vamp']);
  });

  it('excludes a lone/cosmetic repeatStart (anotherRound would be inert)', () => {
    const loneCal = makeCal([{ id: 'b1' }, { id: 'b2' }], [], [rstart('R', 'b1')]);
    expect(availableRedirects(compileCal(loneCal), initVM(compileCal(loneCal)))).toEqual([]);
  });

  it('drops a no-op anotherRound (max-pass-1 ending group ⇒ times===1, clamp is inert)', () => {
    // compileRoadmap accepts an ending group whose only pass is [1] → times === 1,
    // yet endingStartsByRepeat.has(R) is true. anotherRound clamps completedPasses to
    // t-1 === 0 (unchanged) and parks the cursor on the already-current repeat start,
    // so against the initial VM it changes NOTHING and must NOT be offered (Codex).
    const cal = makeCal([{ id: 'b1' }, { id: 'b2' }], [], [rstart('R', 'b1'), ending('E', 'R', ['b2'], [1])]);
    const c = compileCal(cal);
    expect(c.times.get('R')).toBe(1); // the trap: a "real" ending group at times === 1
    const labels = availableRedirects(c, initVM(c)).map((o) => o.label);
    expect(labels).not.toContain('Another round'); // no-op filtered out
    expect(labels).toEqual(['Vamp (hold)']); // hold (null→R) is the only real delta
  });

  it('offers Re-arm jump ONLY once the D.C./D.S. has fired', () => {
    const jCal = makeCal([{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }], [], [dc('J', 'b3')]);
    const c = compileCal(jCal);
    expect(availableRedirects(c, initVM(c))).toEqual([]); // not yet fired
    const fired: VMState = { ...initVM(c), fired: { J: true } };
    expect(availableRedirects(c, fired)).toEqual([{ label: 'Re-arm jump', directive: { kind: 'resetJump', jumpId: 'J' } }]);
  });
});

// ── nextEmittedBarId / fireAtEligible: the stepVM-PEEK invariant (R5) ─────────
describe('nextEmittedBarId / fireAtEligible', () => {
  const linear = compileCal(makeCal([{ id: 'b1' }, { id: 'b2' }]));

  it('peeks the real next emitted bar at the song head', () => {
    expect(nextEmittedBarId(linear, initVM(linear))).toBe('b1');
  });

  it('is undefined at song end (walks off the end)', () => {
    const done: VMState = { ...initVM(linear), done: true };
    expect(nextEmittedBarId(linear, done)).toBeUndefined();
    expect(fireAtEligible(linear, done, 'b1')).toBe(false);
  });

  // R5 regression: vm.cursor is the next CANDIDATE index, NOT the next emitted
  // bar. On pass 2, stepVM's Rule-1 skips the pass-1-only ending (b3) and emits
  // b4. The peek-anchored floor must reflect that — NOT the raw cursor bar.
  it('anchors to the PEEK, not raw cursor, across a pass-excluded volta', () => {
    const vmCal = makeCal(
      [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }, { id: 'b4' }],
      [],
      [rstart('R', 'b1'), ending('E1', 'R', ['b3'], [1]), ending('E2', 'R', ['b4'], [2])],
    );
    const c = compileCal(vmCal);
    // cursor sits on b3 (pos 2) but pass 2 excludes the [1] ending → stepVM skips to b4.
    const vm: VMState = { ...initVM(c), cursor: 2, completedPasses: { R: 1 } };
    expect(nextEmittedBarId(c, vm)).toBe('b4'); // NOT the skipped b3
    expect(fireAtEligible(c, vm, 'b3')).toBe(false); // pos 2 < peek pos 3 — ineligible
    expect(fireAtEligible(c, vm, 'b4')).toBe(true); // pos 3 === peek pos 3 — eligible
    expect(fireAtEligible(c, vm, 'b1')).toBe(false); // behind the peek
  });
});

// ── resolveArm: re-resolve in the PURE layer, never trust the passed object ───
describe('resolveArm', () => {
  const cal = makeCal(
    [
      { id: 'b1' },
      { id: 'b2', sectionId: 'sV' },
      { id: 'b3' },
      { id: 'b4' },
      { id: 'b5' },
      { id: 'b6' },
    ],
    [sec('sV', 'Verse')],
    [segno('S', 'b2'), fine('F', 'b5')],
  );
  const compiled = compileCal(cal);

  // Identity helpers for this fixture. b2 carries TWO targets (Segno + the Verse
  // section head) — matching by barId alone would be ambiguous, so every call
  // forwards the stable { barId, kind, label } identity.
  const segnoB2 = { barId: 'b2', kind: 'segno' as const, label: 'Segno' };
  const bar6 = { barId: 'b6', kind: 'bar' as const, label: 'Bar 6' };

  it('mints an Armed for a present target + present fireAt', () => {
    // A segno target (kind !== 'section') never bakes a return leg.
    expect(resolveArm(compiled, cal, segnoB2, undefined, 'b1', undefined)).toEqual({
      fireAt: 'b1',
      directive: { kind: 'jumpTo', barId: 'b2' },
    });
  });

  it('returns null for an unknown target barId (no Armed minted)', () => {
    expect(resolveArm(compiled, cal, { barId: 'nope', kind: 'bar', label: 'Bar X' }, undefined, 'b1', undefined)).toBeNull();
  });

  it('returns null for an identity whose kind does not match any target (no guess)', () => {
    // b2 exists, but no target with barId b2 + kind 'coda' → reject, never pick a sibling.
    expect(resolveArm(compiled, cal, { barId: 'b2', kind: 'coda', label: 'Coda' }, undefined, 'b1', undefined)).toBeNull();
  });

  it('returns null for a fireAt that is not a present local bar', () => {
    expect(resolveArm(compiled, cal, segnoB2, undefined, 'nope', undefined)).toBeNull();
  });

  it('keeps exit only if in the RECOMPUTED exitOptions', () => {
    // Segno@b2 (pos1) sits before Fine@b5 (pos4) → alFine is meaningful.
    expect(resolveArm(compiled, cal, segnoB2, 'alFine', 'b1', undefined)).toEqual({
      fireAt: 'b1',
      directive: { kind: 'jumpTo', barId: 'b2', exit: { kind: 'alFine' } },
    });
  });

  it('DROPS a spoofed exit absent from the recomputed target options', () => {
    // b6 (pos5) is past the Fine (pos4) → exitOptions [] → alFine dropped.
    expect(resolveArm(compiled, cal, bar6, 'alFine', 'b1', undefined)).toEqual({
      fireAt: 'b1',
      directive: { kind: 'jumpTo', barId: 'b6' },
    });
  });
});

// ── resolveInsertReturn + resolveArm return-baking (insert-and-return) ─────────
describe('insert-and-return', () => {
  // Intro(b1,b2) → Verse(b3,b4) → Chorus(b5,b6). A backward SECTION call inserts
  // the target section once, then returns to the anchor section's successor head.
  const cal = makeCal(
    [
      { id: 'b1', sectionId: 'sI' },
      { id: 'b2', sectionId: 'sI' },
      { id: 'b3', sectionId: 'sV' },
      { id: 'b4', sectionId: 'sV' },
      { id: 'b5', sectionId: 'sC' },
      { id: 'b6', sectionId: 'sC' },
    ],
    [sec('sI', 'Intro'), sec('sV', 'Verse'), sec('sC', 'Chorus')],
  );
  const compiled = compileCal(cal);
  const introTarget = byId(armableTargets(compiled, cal), 'b1')!; // Intro section head

  it('backward SECTION call → returns to the anchor section successor head', () => {
    // Playing in Verse (last-emitted b3 ⇒ anchor = Verse), call back to Intro (b1):
    // after Intro's last bar (b2, pos1) return to the Verse SUCCESSOR head = Chorus (b5).
    expect(resolveInsertReturn(compiled, cal, introTarget, 'b3')).toEqual({
      afterPos: 1,
      returnBarId: 'b5',
    });
  });

  it('forward call → null (continue-from-target, no return)', () => {
    const chorusTarget = byId(armableTargets(compiled, cal), 'b5')!;
    expect(resolveInsertReturn(compiled, cal, chorusTarget, 'b3')).toBeNull();
  });

  it('non-section target → null (D9 section-only)', () => {
    const barTarget = byId(
      armableTargets(compiled, cal).filter((t) => t.kind === 'bar'),
      'b4',
    )!;
    expect(resolveInsertReturn(compiled, cal, barTarget, 'b5')).toBeNull();
  });

  it('anchor in the LAST section → null (no successor)', () => {
    // Last-emitted b5 is in Chorus (the final section) → no successor head.
    expect(resolveInsertReturn(compiled, cal, introTarget, 'b5')).toBeNull();
  });

  it('resolveArm bakes the return leg for a backward section call (no exit)', () => {
    const id = { barId: 'b1', kind: 'section' as const, label: 'Intro' };
    // Playing in Verse (last-emitted b3 ⇒ anchor = Verse), fire at next bar b4. After
    // Intro plays once (last bar b2, pos1) return to the Verse successor = Chorus (b5).
    expect(resolveArm(compiled, cal, id, undefined, 'b4', 'b3')).toEqual({
      fireAt: 'b4',
      directive: { kind: 'jumpTo', barId: 'b1', return: { afterPos: 1, returnBarId: 'b5' } },
    });
  });

  it('exit XOR return: a REQUESTED exit suppresses the default return', () => {
    // Add a Fine after Intro so alFine is a real option from b1.
    const calF = makeCal(
      [
        { id: 'b1', sectionId: 'sI' },
        { id: 'b2', sectionId: 'sI' },
        { id: 'b3', sectionId: 'sV' },
        { id: 'b4', sectionId: 'sV' },
        { id: 'b5', sectionId: 'sC' },
        { id: 'b6', sectionId: 'sC' },
      ],
      [sec('sI', 'Intro'), sec('sV', 'Verse'), sec('sC', 'Chorus')],
      [fine('F', 'b6')],
    );
    const cF = compileCal(calF);
    const id = { barId: 'b1', kind: 'section' as const, label: 'Intro' };
    expect(resolveArm(cF, calF, id, 'alFine', 'b4', 'b3')).toEqual({
      fireAt: 'b4',
      directive: { kind: 'jumpTo', barId: 'b1', exit: { kind: 'alFine' } },
    });
  });

  it('NON-CONTIGUOUS target section → fail closed (null), no silent tail-skip', () => {
    // Intro is split by a null-section bar: Intro(b1) / null(b2) / Intro(b3) / Verse(b4,b5).
    // A backward Intro insert from Verse must NOT bake a return after b1 (which would
    // skip b3). resolveInsertReturn fails closed → resolveArm emits a plain jumpTo.
    const split = makeCal(
      [
        { id: 'b1', sectionId: 'sI' },
        { id: 'b2', sectionId: null },
        { id: 'b3', sectionId: 'sI' },
        { id: 'b4', sectionId: 'sV' },
        { id: 'b5', sectionId: 'sV' },
      ],
      [sec('sI', 'Intro'), sec('sV', 'Verse')],
    );
    const cSplit = compileCal(split);
    const introHead = byId(armableTargets(cSplit, split), 'b1')!; // section head = first Intro bar
    expect(resolveInsertReturn(cSplit, split, introHead, 'b4')).toBeNull();
    // …and the full arm path degrades to a plain continue-from-target jumpTo.
    const id = { barId: 'b1', kind: 'section' as const, label: 'Intro' };
    expect(resolveArm(cSplit, split, id, undefined, 'b5', 'b4')).toEqual({
      fireAt: 'b5',
      directive: { kind: 'jumpTo', barId: 'b1' },
    });
  });

  it('exit XOR return: a DROPPED (out-of-set) exit still suppresses the return', () => {
    // No Fine in this chart → alFine drops out, but because an exit was REQUESTED
    // the default return is still suppressed (keys on the exit ARG, not keepExit).
    const id = { barId: 'b1', kind: 'section' as const, label: 'Intro' };
    expect(resolveArm(compiled, cal, id, 'alFine', 'b4', 'b3')).toEqual({
      fireAt: 'b4',
      directive: { kind: 'jumpTo', barId: 'b1' },
    });
  });
});
