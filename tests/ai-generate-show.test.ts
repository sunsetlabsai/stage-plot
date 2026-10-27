import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { planChanges, planGenerateShow, replaceShowPrompt, describeProblems, notesReplacePrompt, validateNotes } from '@/lib/ai-ops';
import { SYSTEM_PROMPT, TOOLS } from '@/lib/agent';
import type { InputChannel, MonitorMix, StageSlot } from '@/lib/types';

// design-ai-op-contract §9.2 / §9.2a / §10.4 — `generate_show` replaces the
// three prompt-coordinated whole-list tools AND the client cascade. UAT plan
// B2: applying a stage-plot change regenerated every input from a keyword
// guess, rebuilt monitors with blank needs, and cut every input↔performer link.

const empty = () => ({
  stagePlot: [] as StageSlot[], inputs: [] as InputChannel[], monitors: [] as MonitorMix[],
  setlist: [{ id: 'song-1', position: 1, title: 'Opener', lead: 'Dee' }],
  notes: [{ label: 'Power', text: 'Two drops' }],
  showInfo: { bandName: 'The Band', eventDate: '2026-11-01', venue: 'Roxy' },
});

function populated() {
  return {
    ...empty(),
    stagePlot: [
      { id: 's-dee', name: 'Dee', pos: 'DSC', role: 'Lead Vox', mix: 1 },
      { id: 's-sam', name: 'Sam', pos: 'USC', role: 'Drums', mix: 2 },
    ] as StageSlot[],
    inputs: [
      { id: 'in-1', ch: 1, inst: 'Kick', mic: 'Beta 52', stand: 'Short boom', slotId: 's-sam' },
      { id: 'in-2', ch: 2, inst: 'Lead Vox', mic: 'Beta 58', stand: 'Straight', slotId: 's-dee' },
    ] as InputChannel[],
    monitors: [
      { id: 'm-1', mix: 1, name: 'Dee', needs: 'Vox loud' },
      { id: 'm-2', mix: 2, name: 'Sam', needs: 'Click' },
    ] as MonitorMix[],
  };
}

// A drummer with ONE input, deliberately: the deleted cascade expanded any
// "drum" role into a 7-piece kit, so a one-input result distinguishes "the
// model's list is the only writer" from "the cascade still runs".
const show = {
  stagePlot: [
    { tempId: 'new:ana', name: 'Ana', pos: 'DSC', role: 'Lead Vox', mix: 1, featured: true },
    { tempId: 'new:bo', name: 'Bo', pos: 'USC', role: 'Drums', mix: 2 },
  ],
  inputs: [
    { ch: 1, inst: 'Kick', mic: 'D6', stand: 'Short boom', slotId: 'new:bo' },
    { ch: 2, inst: 'Lead Vox', mic: 'SM58', stand: 'Straight', slotId: 'new:ana' },
    { ch: 3, inst: 'Playback', mic: 'DI', stand: '', slotId: null },
  ],
  monitors: [
    { mix: 1, name: 'Ana', needs: 'Vox, keys', type: 'IEM' },
    { mix: 2, name: 'Bo', needs: 'Click, bass' },
  ],
};

function omit(row: object, ...keys: string[]) {
  return Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));
}

/** The refusal sentence — and a failure if the plan was accepted. */
function why(r: { ok: boolean; problems?: { message: string }[] }): string {
  if (r.ok) throw new Error('expected a refusal, got ok');
  return describeProblems(r.problems!);
}

function ok<T>(r: T) {
  const res = r as { ok: boolean; problems?: { message: string }[] };
  if (!res.ok) throw new Error(describeProblems(res.problems!));
  return r as Extract<T, { ok: true }>;
}

describe('generate_show on an empty show (§10.4 14, 15)', () => {
  it('14. one call builds plot + inputs + monitors, with every performer input linked', () => {
    const { next } = ok(planGenerateShow(empty(), show));
    expect(next.stagePlot.map((s) => s.name)).toEqual(['Ana', 'Bo']);
    const bo = next.stagePlot.find((s) => s.name === 'Bo')!;
    const ana = next.stagePlot.find((s) => s.name === 'Ana')!;
    expect(next.inputs.map((i) => [i.inst, i.slotId])).toEqual([['Kick', bo.id], ['Lead Vox', ana.id], ['Playback', undefined]]);
    // null declares "no performer" and stores as no link — not a literal null.
    expect(next.inputs[2]).not.toHaveProperty('slotId');
    expect(JSON.stringify(next)).not.toContain('new:');
  });

  it('15. NO CASCADE: inputs and monitors are exactly what the model sent', () => {
    const { next } = ok(planGenerateShow(empty(), show));
    // The cascade would have made 7 drum channels and monitors with needs ''.
    expect(next.inputs).toHaveLength(3);
    expect(next.inputs.map((r) => omit(r, 'id', 'slotId'))).toEqual(show.inputs.map((r) => omit(r, 'slotId')));
    expect(next.monitors.map((r) => omit(r, 'id'))).toEqual(show.monitors);
  });

  it('15. the cascade and its preview twin are gone from the page', () => {
    const page = readFileSync('app/[owner]/[show]/page.tsx', 'utf8');
    expect(page).not.toMatch(/expandSlotToInputs/);
    expect(page).not.toMatch(/auto-generated/);
    expect(page).not.toMatch(/update_stage_plot|update_inputs|update_monitors|update_setlist/);
  });

  it('refuses a show whose references do not hold — the cascade used to paper over these', () => {
    const noMix = { ...show, monitors: [show.monitors[0]] };
    expect(why(planGenerateShow(empty(), noMix))).toMatch(/1 performer on Mix 2, which does not exist/);
    const ghost = { ...show, inputs: [{ ch: 1, inst: 'Gtr', mic: '', stand: '', slotId: 'new:ghost' }] };
    expect(why(planGenerateShow(empty(), ghost))).toMatch(/"new:ghost" refers to a new slot/);
    expect(why(planGenerateShow(empty(), { stagePlot: [] }))).toMatch(/needs inputs, monitors as lists/);
    const dupCh = { ...show, inputs: [show.inputs[0], { ...show.inputs[1], ch: 1 }] };
    expect(why(planGenerateShow(empty(), dupCh))).toMatch(/channel 1 is already in use/);
  });

  it('★ an input that OMITS slotId is refused — a forgotten link must not pass as "no performer" (Codex R1 on #195)', () => {
    // Codex's probe: Ana's slot exists, her vocal input simply leaves the link out.
    const forgot = { ...show, inputs: [show.inputs[0], { ch: 2, inst: 'Ana Vox', mic: 'SM58', stand: 'Straight' }, show.inputs[2]] };
    expect(why(planGenerateShow(empty(), forgot))).toBe(
      "This plan was refused because an input has no slotId (ch 2 Ana Vox) — give each its performer's tempId, or null if no performer owns it.",
    );
    // An explicit null is the declared opt-out, and is accepted.
    ok(planGenerateShow(empty(), show));
  });

  it('the preview makes a missing link visible in both directions', () => {
    const src = readFileSync('app/[owner]/[show]/page.tsx', 'utf8');
    const preview = src.slice(src.indexOf("case 'generate_show': {", src.indexOf('function ToolCallPreview(')));
    expect(preview).toMatch(/→ no performer/);
    expect(preview).toMatch(/\(no inputs\)/);
  });

  it('an id echoed from current_config into a generated row is refused, not trusted', () => {
    const echoed = { ...show, stagePlot: [{ ...show.stagePlot[0], id: 's-dee' }, show.stagePlot[1]] };
    expect(why(planGenerateShow(populated(), echoed))).toMatch(/identity belongs on the op/);
  });
});

describe('generate_show on a populated show — confirm and replace (§9.2a, §10.4 16–18)', () => {
  it('16. a populated show needs the distinct replace confirmation, naming the cost in rows', () => {
    expect(replaceShowPrompt(populated())).toBe(
      'Replace the whole show?\n\nThis discards 2 performers, 2 inputs and 2 monitor mixes and builds a new show from your description.\n\n' +
        'The setlist, charts, notes and show info are not touched.',
    );
    expect(replaceShowPrompt(empty())).toBeNull();
    // Any one list is content — a show with only monitors is not "empty".
    expect(replaceShowPrompt({ ...empty(), monitors: populated().monitors })).toMatch(/0 performers, 0 inputs and 2 monitor mixes/);
  });

  it('17. a replace discards plot/inputs/monitors and leaves setlist, notes and showInfo byte-identical', () => {
    const cfg = populated();
    const { next } = ok(planGenerateShow(cfg, show));
    expect(next.stagePlot.map((s) => s.name)).toEqual(['Ana', 'Bo']);
    expect(next.inputs.some((i) => i.id === 'in-1')).toBe(false);
    expect(next.monitors.map((m) => m.name)).toEqual(['Ana', 'Bo']);
    expect(next.setlist).toBe(cfg.setlist);
    expect(next.notes).toBe(cfg.notes);
    expect(next.showInfo).toBe(cfg.showInfo);
  });

  it('16/18. wiring: applyToolCall refuses, then confirms, BEFORE any status or config write; cancel returns', () => {
    const src = readFileSync('app/[owner]/[show]/page.tsx', 'utf8');
    const fn = src.slice(src.indexOf('function applyToolCall('), src.indexOf('function rejectToolCall('));
    const branch = fn.slice(fn.indexOf("if (tc.name === 'generate_show')"), fn.indexOf('const invalid = validateToolInput'));
    const plan = branch.indexOf('planGenerateShow(');
    const refuse = branch.indexOf("'refused'");
    const confirm = branch.indexOf('if (ask && !window.confirm(ask)) return;');
    const applied = branch.indexOf("'applied'");
    const write = branch.indexOf('updateConfig(');
    expect(plan).toBeGreaterThan(-1);
    expect(refuse).toBeGreaterThan(plan);
    expect(confirm).toBeGreaterThan(refuse);
    // 18: a cancel returns before the card leaves `pending` and before the config moves.
    expect(applied).toBeGreaterThan(confirm);
    expect(write).toBeGreaterThan(applied);
    // 17 at the write: only the three lists are swapped onto the LATEST config.
    expect(branch.slice(write)).toMatch(/updateConfig\(\(p\) => \(\{ \.\.\.p, stagePlot: plan\.next\.stagePlot, inputs: plan\.next\.inputs, monitors: plan\.next\.monitors \}\)\)/);
    // No state update inside another's updater (the StrictMode double-run).
    expect(fn).not.toMatch(/setMessages\(\(prev\) => \{[\s\S]*updateConfig\(/);
  });

  it('the card button for a replace never reads "Apply"', () => {
    const src = readFileSync('app/[owner]/[show]/page.tsx', 'utf8');
    expect(src).toMatch(/\{replacesContent\(tc\) \? 'Replace everything' : notesLost\(tc\) \? 'Replace notes' : 'Apply'\}/);
  });
});

describe('the tool set and prompt (§9.2)', () => {
  it('exactly three tools: generate_show + the two single-value writes; the AI cannot touch the setlist', () => {
    expect(TOOLS.map((t) => t.name)).toEqual(['generate_show', 'update_notes', 'update_show_info']);
  });

  it('the prompt no longer orders a cascade, names a removed tool, or teaches setlist conventions', () => {
    expect(SYSTEM_PROMPT).not.toMatch(/cascade/i);
    expect(SYSTEM_PROMPT).not.toMatch(/update_stage_plot|update_inputs|update_monitors|update_setlist/);
    expect(SYSTEM_PROMPT).not.toMatch(/SetlistSong/);
  });

  it('the prompt states the slot↔input coupling in BOTH directions (the spike finding, §3.3)', () => {
    expect(SYSTEM_PROMPT).toMatch(/travel together/);
    expect(SYSTEM_PROMPT).toMatch(/every person on the stage plot gets their inputs/);
    expect(SYSTEM_PROMPT).toMatch(/each of those inputs carries its performer's slotId/);
  });

  it('slots must carry a tempId; every input must carry slotId, null allowed (playback, talkback)', () => {
    const schema = (TOOLS[0] as unknown as { input_schema: { properties: Record<string, { items: { required: string[]; properties: Record<string, unknown> } }> } }).input_schema.properties;
    expect(schema.stagePlot.items.required).toContain('tempId');
    expect(schema.inputs.items.required).toContain('slotId');
    expect((schema.inputs.items.properties.slotId as { type: string[] }).type).toEqual(['string', 'null']);
    expect(schema.monitors.items.required).toEqual(['mix', 'name', 'needs']);
  });
});

describe('planChanges never mutates the caller, even on an id collision (Codex R2 NIT on #194)', () => {
  it('a mintId that collides with an existing row is refused; the frozen config is untouched', () => {
    const cfg = populated();
    cfg.inputs = [{ id: 'in-1', ch: 1, inst: 'Kick', mic: '', stand: '' }];
    for (const r of [...cfg.stagePlot, ...cfg.inputs, ...cfg.monitors]) Object.freeze(r);
    // Codex's probe: the minted id equals an existing row's, and an added row omits ch.
    const result = planChanges(cfg, [{ entity: 'inputs', action: 'add', values: { inst: 'X', mic: '', stand: '' } }], () => 'in-1');
    expect(why(result)).toMatch(/same id/);
    expect(cfg.inputs[0]).not.toHaveProperty('ch', 2);
  });
});

// update_notes is still a whole-list write and notes have no identity, so a
// model that sends only the note it was asked to add deletes every other one
// (Codex R1 on #195). Same rule as a show replace: name what is lost, confirm.
describe('update_notes never silently drops notes (Codex R1 on #195)', () => {
  const current = [{ label: 'Power', text: 'Two drops' }, { label: 'Stands', text: 'Bring 3 booms' }];

  it('★ "add a note" that sends only the new note names the notes it would remove', () => {
    expect(notesReplacePrompt(current, [{ label: 'Load-in', text: '5pm' }])).toBe(
      'Replace the general notes?\n\nThis removes or rewrites 2 existing notes:\n  • Power\n  • Stands',
    );
  });

  it('a list that keeps every existing note verbatim needs no confirm; an edited note counts as lost', () => {
    expect(notesReplacePrompt(current, [...current, { label: 'Load-in', text: '5pm' }])).toBeNull();
    expect(notesReplacePrompt(current, [{ label: 'Power', text: 'One drop' }, current[1]])).toMatch(/1 existing note:\n  • Power$/);
    expect(notesReplacePrompt([], [{ label: 'Load-in', text: '5pm' }])).toBeNull();
  });

  it('★ duplicates count: two identical notes kept as one is a loss (Codex R2 on #195)', () => {
    const power = { label: 'Power', text: 'Two drops' };
    expect(notesReplacePrompt([power, power], [power])).toMatch(/1 existing note:\n  • Power$/);
    expect(notesReplacePrompt([power, power], [power, { ...power }])).toBeNull();
    // One copy kept twice does not cover a different note that was dropped.
    expect(notesReplacePrompt([power, current[1]], [power, power])).toMatch(/1 existing note:\n  • Stands$/);
  });

  it('malformed notes are refused before they reach the config', () => {
    expect(validateNotes('Power: two drops')).toBe('notes must be a list');
    expect(validateNotes([{ label: 'Power' }])).toBe('note 1 needs a text label and text');
    expect(validateNotes(current)).toBeNull();
  });

  it('wiring: the confirm is asked after validation, before the status or config write; the card warns first', () => {
    const src = readFileSync('app/[owner]/[show]/page.tsx', 'utf8');
    const fn = src.slice(src.indexOf('function applyToolCall('), src.indexOf('function rejectToolCall('));
    const tail = fn.slice(fn.indexOf('const invalid = validateToolInput'));
    const confirm = tail.indexOf('notesReplacePrompt(configRef.current.notes');
    expect(confirm).toBeGreaterThan(tail.indexOf("'refused'"));
    expect(tail.slice(confirm)).toMatch(/^[^;]*;\s*if \(ask && !window\.confirm\(ask\)\) return;/);
    expect(confirm).toBeLessThan(tail.indexOf("setToolStatus(msgIdx, toolIdx, 'applied')"));
    expect(src).toMatch(/notesLost\(tc\) \? 'Replace notes' : 'Apply'/);
  });

  it('the prompt and tool description say the list is whole', () => {
    expect(SYSTEM_PROMPT).toMatch(/update_notes REPLACES the whole notes list/);
    expect(TOOLS.find((t) => t.name === 'update_notes')!.description).toMatch(/include every existing note you are keeping/);
  });
});
