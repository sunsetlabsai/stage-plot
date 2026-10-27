import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { planChanges, describeProblems, type Problem } from '@/lib/ai-ops';
import { POSITIONS } from '@/lib/setlist';
import { TOOLS } from '@/lib/agent';
import type { InputChannel, MonitorMix, StageSlot } from '@/lib/types';

// design-ai-op-contract §5 — `planChanges`, the decidable core of the op
// contract. §10.2's house rule: every test distinguishes the correct
// implementation from the plausible-wrong one, which is named in the comment.

function band() {
  const stagePlot: StageSlot[] = [
    { id: 's-dee', name: 'Dee', pos: 'DSC', role: 'Lead Vox', mix: 1, featured: true },
    { id: 's-tom', name: 'Tomás', pos: 'USL', role: 'Guitar', mix: 2, power: true },
    { id: 's-priya', name: 'Priya', pos: 'USR', role: 'Guitar 2', mix: 2, power: true },
    { id: 's-sam', name: 'Sam', pos: 'USC', role: 'Drums', mix: 3 },
    { id: 's-ray', name: 'Ray', pos: 'DSR', role: 'Bass', mix: 3 },
  ];
  const inputs: InputChannel[] = [
    { id: 'in-1', ch: 1, inst: 'Kick', mic: 'Beta 52', stand: 'Short boom', slotId: 's-sam' },
    { id: 'in-2', ch: 2, inst: 'Snare', mic: 'SM57', stand: 'Short boom', slotId: 's-sam' },
    { id: 'in-3', ch: 3, inst: 'Bass', mic: 'DI', stand: '', slotId: 's-ray' },
    { id: 'in-4', ch: 4, inst: 'Guitar 1', mic: 'SM57', stand: 'Short boom', slotId: 's-tom' },
    { id: 'in-5', ch: 5, inst: 'Guitar 2', mic: 'SM57', stand: 'Short boom', slotId: 's-priya' },
    { id: 'in-6', ch: 6, inst: 'Lead Vox', mic: 'Beta 58', stand: 'Straight', notes: 'Dee', slotId: 's-dee' },
  ];
  const monitors: MonitorMix[] = [
    { id: 'm-1', mix: 1, name: 'Dee', needs: 'Vox, keys', type: 'Wedge' },
    { id: 'm-2', mix: 2, name: 'Tomás, Priya', needs: 'Guitars', type: 'Wedge' },
    { id: 'm-3', mix: 3, name: 'Rhythm', needs: 'Kick, bass', type: 'Wedge' },
  ];
  // setlist/notes ride along untouched: planChanges must preserve them.
  return { stagePlot, inputs, monitors, setlist: [{ id: 'song-1', position: 1, title: 'Opener', lead: 'Dee' }], notes: [] };
}

function seqIds() {
  let n = 0;
  return () => `minted-${++n}`;
}

function refused(result: ReturnType<typeof planChanges>): Problem[] {
  if (result.ok) throw new Error('expected a refusal, got ok');
  return result.problems;
}

function accepted<C>(result: ReturnType<typeof planChanges<C & ReturnType<typeof band>>>) {
  if (!result.ok) throw new Error(`expected ok, got: ${describeProblems(result.problems)}`);
  return result;
}

const byId = <T extends { id?: string }>(rows: T[], id: string) => rows.find((r) => r.id === id);

describe('planChanges — merge and identity (§10.2 1–3)', () => {
  it('1. patch merges: named fields change, unnamed fields on the same row are byte-identical', () => {
    const cfg = band();
    const { next } = accepted(planChanges(cfg, [{ entity: 'inputs', action: 'patch', id: 'in-1', values: { mic: 'Beta 91' } }]));
    // Plausible-wrong: replace the row with `values` — loses inst/stand/slotId.
    expect(byId(next.inputs, 'in-1')).toEqual({ ...cfg.inputs[0], mic: 'Beta 91' });
  });

  it('2. a row no op names is byte-identical — and keeps its object identity', () => {
    const cfg = band();
    const { next } = accepted(planChanges(cfg, [{ entity: 'inputs', action: 'patch', id: 'in-1', values: { mic: 'Beta 91' } }]));
    expect(next.inputs.slice(1)).toEqual(cfg.inputs.slice(1));
    expect(next.stagePlot).toEqual(cfg.stagePlot);
    expect(next.monitors).toEqual(cfg.monitors);
    expect(next.setlist).toBe(cfg.setlist);
  });

  it('3. an unknown id refuses and NOTHING is applied — not "the rest applied" (O2 + O4)', () => {
    const cfg = band();
    const snapshot = structuredClone(cfg);
    const problems = refused(
      planChanges(cfg, [
        { entity: 'inputs', action: 'patch', id: 'in-1', values: { mic: 'Beta 91' } },
        { entity: 'inputs', action: 'remove', id: 'in-99' },
      ]),
    );
    expect(problems.map((p) => p.message)).toEqual(['there is no input with id "in-99"']);
    expect(problems[0].op).toBe(1);
    expect(cfg).toEqual(snapshot); // input never mutated
  });

  it('refuses the structural mistakes: add with an id, patch with no values, remove with values, id inside values', () => {
    const cases: [unknown, RegExp][] = [
      [{ entity: 'inputs', action: 'add', id: 'x', values: { ch: 9, inst: '', mic: '', stand: '' } }, /carries an id/],
      [{ entity: 'inputs', action: 'patch', id: 'in-1', values: {} }, /no fields to apply/],
      [{ entity: 'inputs', action: 'patch', id: 'in-1' }, /has no values/],
      [{ entity: 'inputs', action: 'remove', id: 'in-1', values: { mic: 'x' } }, /names the row and nothing else/],
      // A values.id would let a patch rewrite the row's own identity and orphan every reference (§5.3).
      [{ entity: 'stagePlot', action: 'patch', id: 's-dee', values: { id: 's-new' } }, /identity belongs on the op/],
      [{ entity: 'stagePlot', action: 'patch', id: 's-dee', tempId: 'new:x', values: { name: 'D' } }, /only an add may/],
      [{ entity: 'setlist', action: 'remove', id: 'song-1' }, /unknown entity/],
      [{ entity: 'inputs', action: 'replace', id: 'in-1' }, /unknown action/],
      ['remove in-1', /not an object/],
    ];
    for (const [op, re] of cases) {
      const problems = refused(planChanges(band(), [op]));
      expect(problems[0].message, JSON.stringify(op)).toMatch(re);
    }
    expect(refused(planChanges(band(), []))[0].message).toMatch(/no changes/);
    expect(refused(planChanges(band(), { ops: [] }))[0].message).toMatch(/no changes/);
  });
});

describe('planChanges — tempId (§3.3, §10.2 4–5)', () => {
  const addTwoSingers = [
    { entity: 'stagePlot', action: 'add', tempId: 'new:alicia', values: { name: 'Alicia', pos: 'DSL', role: 'BGV', mix: 1 } },
    { entity: 'stagePlot', action: 'add', tempId: 'new:wes', values: { name: 'Wes', pos: 'DSL', role: 'BGV', mix: 1 } },
    { entity: 'inputs', action: 'add', values: { inst: 'Alicia Vox', mic: 'SM58', stand: 'Tall boom', slotId: 'new:alicia' } },
    { entity: 'inputs', action: 'add', values: { inst: 'Wes Vox', mic: 'SM58', stand: 'Tall boom', slotId: 'new:wes' } },
  ];

  it('4. resolves to the minted slot id, and no "new:" string survives into the config', () => {
    const { next } = accepted(planChanges(band(), addTwoSingers, seqIds()));
    const alicia = next.stagePlot.find((s) => s.name === 'Alicia')!;
    const wes = next.stagePlot.find((s) => s.name === 'Wes')!;
    expect(next.inputs.find((i) => i.inst === 'Alicia Vox')!.slotId).toBe(alicia.id);
    expect(next.inputs.find((i) => i.inst === 'Wes Vox')!.slotId).toBe(wes.id);
    expect(alicia.id).not.toBe(wes.id);
    expect(JSON.stringify(next)).not.toContain('new:');
    expect(JSON.stringify(next)).not.toContain('tempId');
  });

  it('resolves regardless of op order — the input may come before the slot it references', () => {
    const reordered = [addTwoSingers[2], addTwoSingers[0], addTwoSingers[3], addTwoSingers[1]];
    const { next } = accepted(planChanges(band(), reordered, seqIds()));
    // Plausible-wrong: resolve sequentially, so the first input sees no "new:alicia" yet.
    expect(next.inputs.find((i) => i.inst === 'Alicia Vox')!.slotId).toBe(next.stagePlot.find((s) => s.name === 'Alicia')!.id);
  });

  it('a patch or remove may target a row created earlier in the same batch by its tempId', () => {
    const { next } = accepted(
      planChanges(band(), [addTwoSingers[0], { entity: 'stagePlot', action: 'patch', id: 'new:alicia', values: { pos: 'DSR' } }], seqIds()),
    );
    expect(next.stagePlot.find((s) => s.name === 'Alicia')!.pos).toBe('DSR');
  });

  it('5. a "new:" reference with no matching tempId refuses', () => {
    const problems = refused(planChanges(band(), [addTwoSingers[0], addTwoSingers[3]]));
    expect(problems[0].message).toMatch(/"new:wes" refers to a new slot that no op in this plan creates/);
  });

  it('a tempId without the "new:" prefix, and a duplicate tempId, both refuse', () => {
    const bad = { ...addTwoSingers[0], tempId: 'alicia' };
    expect(refused(planChanges(band(), [bad]))[0].message).toMatch(/must start with "new:"/);
    // Plausible-wrong: accept a bare "s-dee" as a tempId, which would collide with a real id.
    expect(refused(planChanges(band(), [{ ...addTwoSingers[0], tempId: 's-dee' }]))[0].message).toMatch(/must start with "new:"/);
    expect(refused(planChanges(band(), [{ ...addTwoSingers[0], tempId: 'new:' }]))[0].message).toMatch(/must start with "new:"/);
    expect(refused(planChanges(band(), [addTwoSingers[0], addTwoSingers[0]]))[0].message).toMatch(/used by more than one add/);
  });
});

describe('planChanges — post-batch references (§5.2, §10.2 6–7)', () => {
  it('6. removing a monitor AND re-pointing its performers in the same batch is accepted', () => {
    const { next } = accepted(
      planChanges(band(), [
        { entity: 'monitors', action: 'remove', id: 'm-2' },
        { entity: 'stagePlot', action: 'patch', id: 's-tom', values: { mix: 3 } },
        { entity: 'stagePlot', action: 'patch', id: 's-priya', values: { mix: 3 } },
      ]),
    );
    // Plausible-wrong: evaluate per op against the pre-batch state, which refuses op 1.
    expect(next.monitors.map((m) => m.mix)).toEqual([1, 3]);
  });

  it('7. removing a monitor and leaving performers on it refuses, naming the count', () => {
    const problems = refused(planChanges(band(), [{ entity: 'monitors', action: 'remove', id: 'm-2' }]));
    expect(problems.map((p) => p.message)).toEqual([
      'it would leave 2 performers pointing at Mix 2, which it removes — move them to another mix in the same plan',
    ]);
  });

  it('removing a performer but not their inputs refuses (the slot and its inputs travel together)', () => {
    const problems = refused(planChanges(band(), [{ entity: 'stagePlot', action: 'remove', id: 's-priya' }]));
    expect(problems[0].message).toBe(
      'it removes Priya but leaves an input linked to them (ch 5 Guitar 2) — remove or re-link it in the same plan',
    );
    // Case A of the spike: remove both — accepted.
    accepted(planChanges(band(), [
      { entity: 'stagePlot', action: 'remove', id: 's-priya' },
      { entity: 'inputs', action: 'remove', id: 'in-5' },
    ]));
  });

  it('a slotId naming no slot refuses', () => {
    const problems = refused(planChanges(band(), [{ entity: 'inputs', action: 'patch', id: 'in-1', values: { slotId: 's-ghost' } }]));
    expect(problems[0].message).toBe('input ch 1 links to a stage-plot slot that does not exist');
  });

  it('C2: an existing performer gains a mic — one input carrying their EXISTING slotId, no new slot', () => {
    const { next, summary } = accepted(
      planChanges(band(), [{ entity: 'inputs', action: 'add', values: { inst: 'Ray BGV', mic: 'SM58', stand: 'Tall boom', slotId: 's-ray' } }]),
    );
    expect(next.stagePlot).toHaveLength(5);
    expect(next.inputs.at(-1)!.slotId).toBe('s-ray');
    expect(summary.stagePlot.added).toEqual([]);
  });

  it("the user's PRE-EXISTING orphans and dangling links never block an unrelated plan", () => {
    const cfg = band();
    cfg.stagePlot[3] = { ...cfg.stagePlot[3], mix: 7 }; // Sam on a deleted Mix 7
    cfg.inputs[2] = { ...cfg.inputs[2], slotId: 's-gone', needsReview: true }; // flagged dangling link
    // Plausible-wrong: check every post-batch row, so the user's existing data refuses an edit to Dee.
    accepted(planChanges(cfg, [{ entity: 'inputs', action: 'patch', id: 'in-6', values: { mic: 'KSM9' } }]));
    // Even a patch to the orphaned row itself, when it leaves the reference alone.
    accepted(planChanges(cfg, [{ entity: 'stagePlot', action: 'patch', id: 's-sam', values: { name: 'Samantha' } }]));
    accepted(planChanges(cfg, [{ entity: 'inputs', action: 'patch', id: 'in-3', values: { mic: 'DI box' } }]));
  });

  it('linking an input clears its review flag, as the manual relink does; null unlinks', () => {
    const cfg = band();
    cfg.inputs[2] = { ...cfg.inputs[2], slotId: 's-gone', needsReview: true };
    const { next } = accepted(planChanges(cfg, [{ entity: 'inputs', action: 'patch', id: 'in-3', values: { slotId: 's-ray' } }]));
    expect(byId(next.inputs, 'in-3')).toMatchObject({ slotId: 's-ray', needsReview: false });

    // An unflagged row gains no flag — a phantom `needsReview: false` would show on the card.
    const relinked = accepted(planChanges(band(), [{ entity: 'inputs', action: 'patch', id: 'in-6', values: { slotId: 's-ray' } }]));
    expect(byId(relinked.next.inputs, 'in-6')).not.toHaveProperty('needsReview');
    expect(relinked.summary.inputs.patched[0].changes.map((c) => c.field)).toEqual(['slotId']);
    const added = accepted(planChanges(band(), [{ entity: 'inputs', action: 'add', values: { inst: 'BGV', mic: 'SM58', stand: '', slotId: 's-ray' } }]));
    expect(added.next.inputs.at(-1)).not.toHaveProperty('needsReview');

    const unlinked = accepted(planChanges(band(), [{ entity: 'inputs', action: 'patch', id: 'in-6', values: { slotId: null } }])).next;
    expect(byId(unlinked.inputs, 'in-6')).not.toHaveProperty('slotId');
  });

  it('null on a REQUIRED field is refused by the shape check, not silently deleted', () => {
    const problems = refused(planChanges(band(), [{ entity: 'monitors', action: 'patch', id: 'm-1', values: { needs: null } }]));
    expect(problems[0].message).toBe('Mix 1 (Dee) is missing "needs"');
  });
});

describe('planChanges — mix numbers are aux numbers (design-core-path-tier1 §3.6)', () => {
  it('a patch that changes a monitor\'s mix is refused as a renumber — even a consistent swap', () => {
    // Every post-batch reference still resolves after a 1↔2 swap, so the doc's
    // post-batch rule alone would ACCEPT it and silently put Dee on the
    // guitarists' wedge. That is the hole Codex R1 caught on #193.
    const problems = refused(
      planChanges(band(), [
        { entity: 'monitors', action: 'patch', id: 'm-1', values: { mix: 2 } },
        { entity: 'monitors', action: 'patch', id: 'm-2', values: { mix: 1 } },
      ]),
    );
    expect(problems[0].message).toBe('it changes Mix 1 to Mix 2 — renumber a mix in the Monitor Mixes table, which moves its performers with it');
  });

  it('a patch that re-sends the SAME mix number is not a renumber', () => {
    accepted(planChanges(band(), [{ entity: 'monitors', action: 'patch', id: 'm-1', values: { mix: 1, type: 'IEM' } }]));
  });

  it('an added mix colliding with an existing number refuses; a legacy duplicate the plan does not touch does not', () => {
    expect(refused(planChanges(band(), [{ entity: 'monitors', action: 'add', values: { mix: 2, name: 'X', needs: '' } }]))[0].message).toBe('Mix 2 already exists');
    const cfg = band();
    cfg.monitors.push({ id: 'm-1b', mix: 1, name: 'Dup', needs: '' }); // saved before B3's nextMixNumber
    accepted(planChanges(cfg, [{ entity: 'monitors', action: 'patch', id: 'm-1', values: { type: 'IEM' } }]));
  });

  it('a mix added at an orphaned number names the performers who rejoin it on the card', () => {
    const cfg = band();
    cfg.monitors = cfg.monitors.filter((m) => m.mix !== 3); // Sam + Ray orphaned on 3
    const { summary } = accepted(planChanges(cfg, [{ entity: 'monitors', action: 'add', values: { mix: 3, name: 'Rhythm', needs: '' } }]));
    expect(summary.joins).toEqual([{ mix: 3, names: ['USC — Sam', 'DSR — Ray'] }]);
    // An add at a fresh number joins nobody.
    expect(accepted(planChanges(band(), [{ entity: 'monitors', action: 'add', values: { mix: 4, name: 'Keys', needs: '' } }])).summary.joins).toEqual([]);
  });

  it('an add omitting mix skips orphaned numbers, like "+ Add Mix"', () => {
    const cfg = band();
    cfg.stagePlot[0] = { ...cfg.stagePlot[0], mix: 7 }; // orphan on 7
    const { next } = accepted(planChanges(cfg, [{ entity: 'monitors', action: 'add', values: { name: 'Keys', needs: '' } }]));
    // Plausible-wrong: max(monitors)+1 = 4. Correct: past the orphan too, so Dee is not silently re-attached.
    expect(next.monitors.at(-1)!.mix).toBe(8);
  });
});

describe('planChanges — positional numbers (§3.5, §10.2 8)', () => {
  it('8. an input add omitting ch gets max+1; two such adds get consecutive numbers', () => {
    const { next } = accepted(
      planChanges(band(), [
        { entity: 'inputs', action: 'add', values: { inst: 'Keys L', mic: 'DI', stand: '' } },
        { entity: 'inputs', action: 'add', values: { inst: 'Keys R', mic: 'DI', stand: '' } },
      ]),
    );
    expect(next.inputs.slice(-2).map((i) => i.ch)).toEqual([7, 8]);
  });

  it('auto numbers never take one a LATER explicit op claims', () => {
    const { next } = accepted(
      planChanges(band(), [
        { entity: 'inputs', action: 'add', values: { inst: 'Auto', mic: '', stand: '' } },
        { entity: 'inputs', action: 'add', values: { ch: 7, inst: 'Explicit', mic: '', stand: '' } },
      ]),
    );
    expect(next.inputs.find((i) => i.inst === 'Auto')!.ch).toBe(8);
  });

  it('8. a colliding explicit ch refuses; moving a ch onto a free number is fine', () => {
    expect(refused(planChanges(band(), [{ entity: 'inputs', action: 'add', values: { ch: 3, inst: 'X', mic: '', stand: '' } }]))[0].message).toBe('channel 3 is already in use');
    expect(refused(planChanges(band(), [{ entity: 'inputs', action: 'patch', id: 'in-1', values: { ch: 2 } }]))[0].message).toBe('channel 2 is already in use');
    accepted(planChanges(band(), [{ entity: 'inputs', action: 'patch', id: 'in-1', values: { ch: 12 } }]));
  });
});

describe('planChanges — unknown fields (§5.2, §10.2 9)', () => {
  it('9. an unknown field is dropped with a warning — NOT refused', () => {
    const { next, summary } = accepted(
      planChanges(band(), [{ entity: 'inputs', action: 'patch', id: 'in-1', values: { mic: 'Beta 91', phantom: true } }]),
    );
    expect(byId(next.inputs, 'in-1')).not.toHaveProperty('phantom');
    expect(summary.warnings).toEqual(['Ignored "phantom" — inputs have no such field.']);
  });
});

describe('planChanges — ChangeSummary (§7, §10.2 10)', () => {
  it('10. counts match what apply actually changed', () => {
    const { next, summary } = accepted(
      planChanges(band(), [
        { entity: 'stagePlot', action: 'remove', id: 's-priya' },
        { entity: 'inputs', action: 'remove', id: 'in-5' },
        { entity: 'monitors', action: 'patch', id: 'm-1', values: { type: 'IEM' } },
        { entity: 'monitors', action: 'patch', id: 'm-2', values: { type: 'IEM', name: 'Tomás' } },
        { entity: 'inputs', action: 'add', values: { inst: 'Keys', mic: 'DI', stand: '' } },
      ]),
    );
    const cfg = band();
    expect(summary.stagePlot.removed).toEqual(['USR — Priya']);
    expect(summary.inputs.removed).toEqual(['ch 5 Guitar 2']);
    expect(summary.inputs.added).toEqual(['ch 7 Keys']);
    expect(summary.monitors.patched).toEqual([
      { label: 'Mix 1 (Dee)', changes: [{ field: 'type', from: 'Wedge', to: 'IEM' }] },
      { label: 'Mix 2 (Tomás, Priya)', changes: [{ field: 'name', from: 'Tomás, Priya', to: 'Tomás' }, { field: 'type', from: 'Wedge', to: 'IEM' }] },
    ]);
    // The summary is a diff of config→next, so its counts ARE apply's counts.
    expect(cfg.stagePlot.length - summary.stagePlot.removed.length + summary.stagePlot.added.length).toBe(next.stagePlot.length);
    expect(cfg.inputs.length - summary.inputs.removed.length + summary.inputs.added.length).toBe(next.inputs.length);
  });

  it('a patch that re-sends current values shows as no change, not as a patch', () => {
    const { summary } = accepted(planChanges(band(), [{ entity: 'inputs', action: 'patch', id: 'in-1', values: { mic: 'Beta 52' } }]));
    expect(summary.inputs.patched).toEqual([]);
  });
});

describe('planChanges — value domains (§5.3, §10.2 10a–10f)', () => {
  const addSlot = (values: Record<string, unknown>) => planChanges(band(), [{ entity: 'stagePlot', action: 'add', values: { name: 'X', role: '', mix: 0, pos: 'DSC', ...values } }]);

  it('10a. pos "PIT" is refused, "DSC" accepted — POSITIONS, not StagePosition', () => {
    expect(refused(addSlot({ pos: 'PIT' }))[0].message).toMatch(/invalid pos: "PIT" \(must be one of USR, USC/);
    accepted(addSlot({ pos: 'DSC' }));
  });

  it('10b. a patch to a slot on mix 0 succeeds, and 0 is not a dangling reference', () => {
    const cfg = band();
    cfg.stagePlot[0] = { ...cfg.stagePlot[0], mix: 0 };
    accepted(planChanges(cfg, [{ entity: 'stagePlot', action: 'patch', id: 's-dee', values: { role: 'Lead Vox, Acoustic' } }]));
    accepted(addSlot({ mix: 0 }));
  });

  it('10c. mix 3 with no monitor 3 after the batch is refused — 10b exempts 0 ONLY', () => {
    const cfg = band();
    expect(refused(planChanges(cfg, [{ entity: 'stagePlot', action: 'patch', id: 's-dee', values: { mix: 9 } }]))[0].message).toBe(
      'it would put 1 performer on Mix 9, which does not exist — add that mix in the same plan',
    );
    expect(refused(addSlot({ mix: -1 }))[0].message).toMatch(/invalid mix/);
  });

  it('10d. a monitor add omitting needs is refused; needs "" is accepted', () => {
    expect(refused(planChanges(band(), [{ entity: 'monitors', action: 'add', values: { mix: 4, name: 'Keys' } }]))[0].message).toBe('Mix 4 (Keys) is missing "needs"');
    accepted(planChanges(band(), [{ entity: 'monitors', action: 'add', values: { mix: 4, name: 'Keys', needs: '' } }]));
  });

  it("10e. a patch on a row whose strings are '' succeeds — nothing must be non-empty", () => {
    const cfg = band();
    cfg.stagePlot.push({ id: 's-blank', name: '', pos: 'MSC', role: '', mix: 0 });
    cfg.inputs.push({ id: 'in-blank', ch: 9, inst: '', mic: '', stand: '', notes: '' });
    cfg.monitors.push({ id: 'm-blank', mix: 4, name: '', needs: '' });
    accepted(
      planChanges(cfg, [
        { entity: 'stagePlot', action: 'patch', id: 's-blank', values: { power: true } },
        { entity: 'inputs', action: 'patch', id: 'in-blank', values: { mic: 'SM58' } },
        { entity: 'monitors', action: 'patch', id: 'm-blank', values: { type: 'IEM' } },
      ]),
    );
  });

  it('wrong types are refused on the merged row', () => {
    expect(refused(planChanges(band(), [{ entity: 'inputs', action: 'patch', id: 'in-1', values: { ch: 1.5 } }]))[0].message).toMatch(/invalid ch/);
    expect(refused(planChanges(band(), [{ entity: 'stagePlot', action: 'patch', id: 's-dee', values: { featured: 'yes' } }]))[0].message).toMatch(/invalid featured/);
    expect(refused(planChanges(band(), [{ entity: 'inputs', action: 'add', values: { inst: 'X', mic: '' } }]))[0].message).toBe('ch 7 X is missing "stand"');
  });

  it('10f. POSITIONS has one definition — the editor and the AI tool schema import it', () => {
    const page = readFileSync('app/[owner]/[show]/page.tsx', 'utf8');
    expect(page).not.toMatch(/const POSITIONS\b/);
    expect(page).toMatch(/\bPOSITIONS\b[^;]*\} from '@\/lib\/setlist'/);
    const agent = readFileSync('lib/agent.ts', 'utf8');
    expect(agent).not.toMatch(/\['USR', 'USC'/);
    const posEnums = JSON.stringify(TOOLS).match(/"enum":\["USR"[^\]]*\]/g) ?? [];
    expect(posEnums.length).toBeGreaterThan(0);
    for (const e of posEnums) expect(e).toBe(`"enum":${JSON.stringify(POSITIONS)}`);
  });
});

describe('planChanges — totality', () => {
  it('a config with an id-less row is refused rather than mis-addressed', () => {
    const cfg = band();
    delete cfg.inputs[0].id;
    expect(refused(planChanges(cfg, [{ entity: 'inputs', action: 'patch', id: 'in-2', values: { mic: 'x' } }]))[0].message).toMatch(/rows without ids/);
  });

  it('describeProblems joins distinct messages into one sentence', () => {
    expect(describeProblems([{ message: 'a' }, { message: 'b' }, { message: 'a' }])).toBe('This plan was refused because a; b.');
  });
});
