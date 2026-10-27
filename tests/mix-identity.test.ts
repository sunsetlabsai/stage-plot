import { describe, it, expect } from 'vitest';
import * as setlist from '@/lib/setlist';
import {
  renumberMix,
  validateMonitors,
  nextMixNumber,
  isOrphanedMix,
  performersOnMix,
  sortMonitorsByMix,
  renumberMixPrompt,
  deleteMixPrompt,
} from '@/lib/setlist';
import type { StageSlot, MonitorMix, StagePosition } from '@/lib/types';

// design-core-path-tier1 §3 — mix identity. UAT plan B3.
//
// THE DEFECT: `StageSlot.mix` points at `MonitorMix.mix` BY VALUE, and both
// reorder (`moveMonitor`) and delete rewrote `mix = i + 1` across the monitor
// list while leaving every slot untouched. Delete Mix 2 of [1, 2, 3] and the
// performer on Mix 3 now reads "MIX 3" for a wedge that is somebody else's —
// on the printed rider, with nothing flagged anywhere.
//
// Each rule below is paired with the plausible-wrong implementation it must
// distinguish (§4 house rule).

function slot(name: string, mix: number, pos: StagePosition = 'DSC'): StageSlot {
  return { id: `s-${name}`, name, pos, role: '', mix };
}
function mon(mix: number, name = `M${mix}`): MonitorMix {
  return { id: `m-${mix}`, mix, name, needs: '' };
}
function config(monitors: MonitorMix[], stagePlot: StageSlot[]) {
  return { monitors, stagePlot, inputs: [], notes: [] };
}

describe('renumberMix — the one deliberate path (§4 tests 12, 13)', () => {
  it('12: 3 → 5 moves the monitor AND every slot on 3, and nothing else', () => {
    const before = config([mon(1), mon(3)], [slot('Ann', 3), slot('Bo', 1), slot('Cy', 3), slot('Di', 0)]);
    const r = renumberMix(before, 3, 5);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.monitors.map((m) => m.mix)).toEqual([1, 5]);
    expect(r.config.stagePlot.map((s) => s.mix)).toEqual([5, 1, 5, 0]);
    // Identity rides along — the row is the same mix, renumbered, not a new one.
    expect(r.config.monitors[1].id).toBe('m-3');
  });

  it('12 (distinguishing): a monitor-only renumber is the shipped bug', () => {
    // The plausible-wrong fix edits the monitor row and forgets the slots —
    // which is exactly moveMonitor. Pin that slots on OTHER mixes are untouched
    // and slots on `from` are not left behind.
    const r = renumberMix(config([mon(3), mon(4)], [slot('Ann', 3), slot('Bo', 4)]), 3, 9);
    if (!r.ok) throw new Error(r.reason);
    expect(r.config.stagePlot.find((s) => s.name === 'Ann')!.mix).toBe(9);
    expect(r.config.stagePlot.find((s) => s.name === 'Bo')!.mix).toBe(4);
    expect(r.config.stagePlot.some((s) => s.mix === 3)).toBe(false);
  });

  it('13: rejects a collision with a live mix, mutating nothing', () => {
    const before = config([mon(1), mon(2)], [slot('Ann', 1), slot('Bo', 2)]);
    const snapshot = JSON.stringify(before);
    const r = renumberMix(before, 1, 2);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/mix 2 already exists/i);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it.each([0, -1, 2.5, NaN])('13: rejects non-positive / non-integer target %s', (to) => {
    const before = config([mon(1)], [slot('Ann', 1)]);
    const snapshot = JSON.stringify(before);
    const r = renumberMix(before, 1, to);

    expect(r.ok).toBe(false);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('rejects a source that is not a live mix — an orphan number cannot be "renumbered"', () => {
    const r = renumberMix(config([mon(1)], [slot('Ann', 7)]), 7, 8);
    expect(r.ok).toBe(false);
  });

  it('to === from is a successful no-op, not a collision with itself', () => {
    const before = config([mon(4)], [slot('Ann', 4)]);
    const r = renumberMix(before, 4, 4);
    expect(r).toEqual({ ok: true, config: before });
  });

  it('a target that only an ORPHAN points at is allowed — the orphans join (and the prompt says so)', () => {
    // Mix 7 was deleted; Cy still points at it. Renumbering 3 → 7 re-attaches Cy.
    // That is correct routing (Cy WAS on aux 7), but it must not be silent.
    const plot = [slot('Ann', 3), slot('Cy', 7)];
    const r = renumberMix(config([mon(3)], plot), 3, 7);
    expect(r.ok).toBe(true);

    const prompt = renumberMixPrompt(plot, 3, 7)!;
    expect(prompt).toContain('DSC — Ann');
    expect(prompt).toMatch(/removed Mix 7[\s\S]*join/);
    expect(prompt).toContain('DSC — Cy');
  });
});

describe('delete orphans, it does not cascade (§4 test 14)', () => {
  it('14: deleting Mix 2 leaves every stagePlot[].mix untouched — the regression test', () => {
    // The page's delete is `monitors.filter(m => m.id !== id)`. This pins the
    // CONTRACT that delete must satisfy: the surviving numbers do not move, so
    // the performer on Mix 3 is still on Mix 3, and the one on 2 is an orphan.
    const monitors = [mon(1), mon(2), mon(3)];
    const plot = [slot('Ann', 1), slot('Bo', 2), slot('Cy', 3)];
    const after = monitors.filter((m) => m.id !== 'm-2');

    expect(after.map((m) => m.mix)).toEqual([1, 3]);
    expect(plot.map((s) => s.mix)).toEqual([1, 2, 3]);
    expect(isOrphanedMix(2, after)).toBe(true);
    expect(isOrphanedMix(3, after)).toBe(false);
  });

  it('14 (source contract): the page delete handler no longer renumbers', async () => {
    // The handler is inline in page.tsx and not drivable from here, so pin its
    // shape: the old `.map((mon, i) => ({ ...mon, mix: i + 1 }))` must be gone
    // from the WHOLE page, not just this handler.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('app/[owner]/[show]/page.tsx', 'utf8');
    expect(src).not.toMatch(/mix:\s*i\s*\+\s*1/);
    expect(src).not.toMatch(/mix:\s*p\.monitors\.length\s*\+\s*1/);
  });

  it('the delete prompt names everyone left flagged, and is skipped when nobody is', () => {
    const plot = [slot('Ann', 2, 'USL'), slot('', 2, 'USL'), slot('Cy', 3)];
    const prompt = deleteMixPrompt(plot, 2)!;

    expect(prompt).toMatch(/2 performers are on Mix 2/);
    expect(prompt).toContain('USL — Ann');
    // A blank name uses the same "Occupant n" label as every other surface.
    expect(prompt).toContain('USL — Occupant 2');
    expect(prompt).not.toContain('Cy');
    expect(deleteMixPrompt(plot, 9)).toBeNull();
  });
});

describe('orphan detection (§4 test 15)', () => {
  it('flags a slot whose mix matches no monitor, and not one that does', () => {
    const monitors = [mon(1), mon(3)];
    expect(isOrphanedMix(2, monitors)).toBe(true);
    expect(isOrphanedMix(3, monitors)).toBe(false);
  });

  it('mix 0 is the "no monitor" sentinel — never an orphan, even with no monitors', () => {
    // Distinguishing case: a naive `!monitors.some(m => m.mix === mix)` flags
    // every unassigned performer the moment the monitor list is empty.
    expect(isOrphanedMix(0, [])).toBe(false);
    expect(isOrphanedMix(0, [mon(1)])).toBe(false);
  });

  it('performersOnMix(…, 0) is empty — unassigned slots are not "on" a mix', () => {
    expect(performersOnMix([slot('Ann', 0)], 0)).toEqual([]);
  });
});

describe('validateMonitors (§4 test 16)', () => {
  it('accepts sparse numbering [1, 2, 5]', () => {
    expect(validateMonitors([mon(1), mon(2), mon(5)])).toBeNull();
  });

  it('rejects a duplicate', () => {
    expect(validateMonitors([mon(1), mon(2), mon(1)])).toMatch(/mix 1 appears more than once/);
  });

  it.each([0, -3, 1.5, '2', undefined])('rejects mix %s', (mix) => {
    // '2' is the AI-path case: tool input is untyped JSON, and a string "2"
    // would never match a slot's numeric 2.
    expect(validateMonitors([{ mix }])).not.toBeNull();
  });
});

describe('nextMixNumber — add seeds max + 1 (§4 test 17)', () => {
  it('17: after [1, 2, 5] yields 6, not 4', () => {
    expect(nextMixNumber([mon(1), mon(2), mon(5)])).toBe(6);
  });

  it('empty list yields 1', () => {
    expect(nextMixNumber([])).toBe(1);
  });

  it('skips past ORPHANED slot mixes, so a blank new mix never adopts their performers', () => {
    // Mix 7 deleted, Cy still on 7. max(monitors)+1 alone would walk 6 → 7 on
    // the next two adds and silently put Cy on an empty, unnamed mix.
    expect(nextMixNumber([mon(1), mon(5)], [slot('Cy', 7)])).toBe(8);
  });
});

describe('moveMonitor is gone (§4 test 18)', () => {
  it('18: the export no longer exists, so its deletion cannot be quietly reverted', () => {
    expect('moveMonitor' in setlist).toBe(false);
  });

  it('moveInput stays — `ch` is referenced by nothing, which is why input reorder is safe', () => {
    expect(typeof setlist.moveInput).toBe('function');
  });
});

describe('sortMonitorsByMix — rows render in aux order', () => {
  it('sorts by number without mutating the input', () => {
    const list = [mon(5), mon(1), mon(3)];
    expect(sortMonitorsByMix(list).map((m) => m.mix)).toEqual([1, 3, 5]);
    expect(list.map((m) => m.mix)).toEqual([5, 1, 3]);
  });
});
