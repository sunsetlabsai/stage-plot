import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SYSTEM_PROMPT, TOOLS } from '@/lib/agent';
import { OP_ACTIONS, OP_ENTITIES } from '@/lib/ai-ops';

// design-ai-op-contract §13 step 4 — `apply_changes` wired, the diff card (§7).
// The contract itself (`planChanges`) and the card's text (`summaryLines`) are
// pinned in tests/ai-ops.test.ts; this file pins the tool, the prompt, and the
// page seam that connects them.

const page = readFileSync('app/[owner]/[show]/page.tsx', 'utf8');

describe('the tool set (§3.1, §9.2)', () => {
  it('four tools: one create, ONE edit, two single-value writes — nothing touches the setlist', () => {
    expect(TOOLS.map((t) => t.name)).toEqual(['generate_show', 'apply_changes', 'update_notes', 'update_show_info']);
  });

  it('the apply_changes schema enumerates exactly the entities and actions planChanges accepts', () => {
    const items = (TOOLS[1] as unknown as { input_schema: { properties: { ops: { items: { properties: Record<string, { enum?: string[] }>; required: string[] } } }; required: string[] } }).input_schema;
    expect(items.required).toEqual(['ops']);
    const op = items.properties.ops.items;
    // One definition: a drift between schema and validator would invite ops the app refuses.
    expect(op.properties.entity.enum).toEqual([...OP_ENTITIES]);
    expect(op.properties.action.enum).toEqual([...OP_ACTIONS]);
    expect(op.required).toEqual(['entity', 'action']);
    expect(Object.keys(op.properties)).toEqual(['entity', 'action', 'id', 'tempId', 'values']);
  });
});

describe('the prompt (§3, §4, the spike)', () => {
  it('routes edits to apply_changes and drops the interim "not available yet" rule', () => {
    expect(SYSTEM_PROMPT).toMatch(/If the show already has content, change it with apply_changes/);
    expect(SYSTEM_PROMPT).not.toMatch(/not available yet/);
  });

  it('states the slot↔input coupling for removing AND adding (the C1 finding)', () => {
    expect(SYSTEM_PROMPT).toMatch(/removing a performer means removing both, and adding a performer usually means adding both/);
  });

  it('guards spike case C2: an existing performer keeps their slot', () => {
    expect(SYSTEM_PROMPT).toMatch(/must carry that performer's EXISTING slotId — do not create a second stage slot/);
  });

  it('§4: ambiguity is answered with a question', () => {
    expect(SYSTEM_PROMPT).toMatch(/ambiguous about WHICH existing rows it affects, or about whether a person is new or already on the stage plot, ASK rather than guess/);
  });

  it('tells the model the two things planChanges refuses that it cannot infer: renumbers and the new: prefix', () => {
    expect(SYSTEM_PROMPT).toMatch(/Never change an existing monitor's mix number/);
    expect(SYSTEM_PROMPT).toMatch(/A tempId MUST start with "new:"/);
  });
});

describe('the page seam (§5.4, §6, §7)', () => {
  const fn = page.slice(page.indexOf('function applyToolCall('), page.indexOf('function rejectToolCall('));
  const branch = fn.slice(fn.indexOf("if (tc.name === 'apply_changes')"), fn.indexOf('const invalid = validateToolInput'));

  it('plans once, refuses before any write, then writes only the three lists onto the LATEST config', () => {
    const plan = branch.indexOf('planChanges(configRef.current, tc.input.ops)');
    const refused = branch.indexOf("'refused'");
    const applied = branch.indexOf("'applied'");
    const write = branch.indexOf('updateConfig(');
    expect(plan).toBeGreaterThan(-1);
    expect(refused).toBeGreaterThan(plan);
    expect(applied).toBeGreaterThan(refused);
    expect(write).toBeGreaterThan(applied);
    expect(branch.slice(write)).toMatch(/updateConfig\(\(p\) => \(\{ \.\.\.p, stagePlot: plan\.next\.stagePlot, inputs: plan\.next\.inputs, monitors: plan\.next\.monitors \}\)\)/);
    expect(branch.match(/planChanges\(/g)).toHaveLength(1);
  });

  it('the approved diff is stored on the call, from the same plan apply used', () => {
    expect(branch).toMatch(/setToolStatus\(msgIdx, toolIdx, 'applied', undefined, summaryLines\(plan\.summary, configRef\.current, plan\.next\)\)/);
  });

  it('a pending card renders the diff from planChanges — never the raw ops', () => {
    expect(page).toMatch(/tc\.status === 'pending' \? \(\s*<ChangesPreview config=\{config\} ops=\{tc\.input\.ops\} \/>/);
    const preview = page.slice(page.indexOf('function ChangesPreview('), page.indexOf('function SummaryList('));
    expect(preview).toMatch(/planChanges\(config, ops\)/);
    expect(preview).toMatch(/summaryLines\(plan\.summary, config, plan\.next\)/);
    expect(preview).not.toMatch(/JSON\.stringify/);
  });
});

describe('the generate_show card uses the same formatter (Codex R2 class on #196)', () => {
  it('a pending generate_show renders planGenerateShow → summaryLines, not a hand-picked field list', () => {
    expect(page).toMatch(/tc\.name === 'generate_show' && tc\.status === 'pending' \? \(\s*<GeneratePreview config=\{config\} input=\{tc\.input\} \/>/);
    const preview = page.slice(page.indexOf('function GeneratePreview('), page.indexOf('function SummaryList('));
    expect(preview).toMatch(/planGenerateShow\(config, input\)/);
    expect(preview).toMatch(/summaryLines\(plan\.summary, config, plan\.next\)/);
  });
});
