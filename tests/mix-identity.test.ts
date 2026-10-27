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
  deleteMonitor,
  addMonitor,
  validateMonitorReplace,
  monitorReplacePrompt,
} from '@/lib/setlist';
import { serializeShow, deserializeShow } from '@/lib/show-file';
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
  it('14: deleteMonitor(Mix 2) leaves every stagePlot[].mix AND every surviving number untouched', () => {
    // Runs the function the page's delete handler calls, not a local stand-in
    // (Codex R1 on #193: the first version tested its own filter).
    const before = config([mon(1), mon(2), mon(3)], [slot('Ann', 1), slot('Bo', 2), slot('Cy', 3)]);
    const after = deleteMonitor(before, 'm-2');

    expect(after.monitors.map((m) => m.mix)).toEqual([1, 3]);
    expect(after.stagePlot).toBe(before.stagePlot);
    expect(isOrphanedMix(2, after.monitors)).toBe(true);
    expect(isOrphanedMix(3, after.monitors)).toBe(false);
  });

  it('14 (wiring): the page deletes and adds through the lib functions, and renumbers nowhere', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('app/[owner]/[show]/page.tsx', 'utf8');
    expect(src).toContain('updateConfig((p) => deleteMonitor(p, mon.id!))');
    expect(src).toContain('updateConfig(addMonitor)');
    // Any spelling of the old rewrite, `mix: <anything> + 1`, in the page.
    expect(src).not.toMatch(/\bmix:\s*[\w.]+\s*\+\s*1\b/);
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

describe('addMonitor', () => {
  it('appends a blank mix at nextMixNumber, leaving existing rows and slots alone', () => {
    const before = config([mon(1), mon(5)], [slot('Cy', 7)]);
    const after = addMonitor(before);
    expect(after.monitors.map((m) => m.mix)).toEqual([1, 5, 8]);
    expect(after.monitors[2]).toMatchObject({ name: '', needs: '' });
    expect(after.stagePlot).toBe(before.stagePlot);
  });
});

describe('validateMonitorReplace — the AI update_monitors apply (Codex R1 #1 on #193)', () => {
  const current = [mon(1, 'Ann'), mon(2, 'Bo')];

  it('★ refuses a swap that keeps the ids — the probe that passed validateMonitors alone', () => {
    const incoming = [{ id: 'm-1', mix: 2, name: 'Ann', needs: '' }, { id: 'm-2', mix: 1, name: 'Bo', needs: '' }];
    expect(validateMonitors(incoming)).toBeNull(); // the gap: unique and positive
    expect(validateMonitorReplace(current, incoming)).toMatch(/changes Mix 1 to Mix 2/);
  });

  it('refuses moving one id-carrying row to a fresh number', () => {
    expect(validateMonitorReplace(current, [{ id: 'm-1', mix: 9 }, { id: 'm-2', mix: 2 }])).toMatch(/Mix 1 to Mix 9/);
  });

  it('COUNTEREXAMPLE: same ids at the same numbers, edited names/needs — accepted', () => {
    expect(validateMonitorReplace(current, [
      { id: 'm-1', mix: 1, name: 'Ann (IEM)', needs: 'vox' },
      { id: 'm-2', mix: 2, name: 'Bo', needs: 'keys' },
    ])).toBeNull();
  });

  it('COUNTEREXAMPLE: adding, dropping, and id-less rows are accepted (the number is the identity)', () => {
    expect(validateMonitorReplace(current, [{ id: 'm-1', mix: 1 }, { mix: 3 }])).toBeNull();
    expect(validateMonitorReplace(current, [{ mix: 2 }, { mix: 1 }])).toBeNull();
    expect(validateMonitorReplace(current, [{ id: 'new', mix: 4 }])).toBeNull();
  });

  it('still refuses duplicates', () => {
    expect(validateMonitorReplace(current, [{ mix: 1 }, { mix: 1 }])).toMatch(/appears more than once/);
  });
});

describe('show import refuses invalid mix numbers (Codex R1 #2 on #193)', () => {
  const base = {
    showInfo: { bandName: 'B', eventDate: '', venue: '' },
    stagePlot: [{ name: 'Ann', pos: 'DSC', role: '', mix: 1 }],
    inputs: [], notes: [], setlist: [],
  };

  it('★ JSON: two different rows both numbered Mix 1 are rejected', () => {
    const json = JSON.stringify({ ...base, monitors: [{ mix: 1, name: 'A', needs: '' }, { mix: 1, name: 'B', needs: '' }] });
    expect(() => deserializeShow(json, 'show.json')).toThrow(/monitor mixes: mix 1 appears more than once/);
  });

  it('★ YAML: the same duplicate is rejected', () => {
    const yaml = serializeShow({ ...base, monitors: [mon(1, 'A'), { ...mon(1, 'B'), id: 'x' }] } as never);
    expect(() => deserializeShow(yaml, 'show.showrunr.yaml')).toThrow(/mix 1 appears more than once/);
  });

  it('COUNTEREXAMPLE: sparse, unique numbering imports in both formats', () => {
    const monitors = [mon(1), mon(2), mon(5)];
    const json = JSON.stringify({ ...base, monitors });
    expect(deserializeShow(json, 'show.json').monitors.map((m) => m.mix)).toEqual([1, 2, 5]);
    const yaml = serializeShow({ ...base, monitors } as never);
    expect(deserializeShow(yaml, 'show.showrunr.yaml').monitors.map((m) => m.mix)).toEqual([1, 2, 5]);
  });
});

describe('monitorReplacePrompt — an AI apply that revives an orphaned number (Codex R2 on #193)', () => {
  it('★ Codex probe: Mix 1 live, Cy on deleted Mix 7, id-less [1, 7] → the prompt names Cy', () => {
    const plot = [slot('Ann', 1), slot('Cy', 7, 'USR')];
    const prompt = monitorReplacePrompt(plot, [mon(1)], [{ mix: 1 }, { mix: 7 }]);
    expect(prompt).toMatch(/removed Mix 7, so they join the new Mix 7/);
    expect(prompt).toContain('USR — Cy');
    expect(prompt).not.toContain('Ann');
  });

  it('COUNTEREXAMPLE: a new number nobody points at needs no prompt', () => {
    expect(monitorReplacePrompt([slot('Ann', 1), slot('Cy', 7)], [mon(1)], [{ mix: 1 }, { mix: 2 }])).toBeNull();
  });

  it('COUNTEREXAMPLE: re-emitting live mixes is not a revival', () => {
    expect(monitorReplacePrompt([slot('Ann', 1)], [mon(1)], [{ mix: 1 }])).toBeNull();
  });

  it('mix 0 (unassigned) is never revived', () => {
    expect(monitorReplacePrompt([slot('Di', 0)], [], [{ mix: 0 }])).toBeNull();
  });

  it('wiring: applyToolCall asks BEFORE the setMessages updater, and returns on cancel', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('app/[owner]/[show]/page.tsx', 'utf8');
    const fn = src.slice(src.indexOf('function applyToolCall('));
    const ask = fn.indexOf('monitorReplacePrompt(');
    expect(ask).toBeGreaterThan(-1);
    expect(ask).toBeLessThan(fn.indexOf('setMessages((prev)'));
    expect(fn.slice(ask, fn.indexOf('setMessages((prev)'))).toMatch(/!window\.confirm\(prompt\)\) return;/);
  });
});
