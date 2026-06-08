import { describe, it, expect } from 'vitest';
import { ensureStageSlotIds } from '../lib/setlist';
import type { StageSlot, InputChannel } from '../lib/types';

function slot(over: Partial<StageSlot> = {}): StageSlot {
  return { name: 'X', pos: 'USC', role: 'role', mix: 1, ...over };
}
function input(over: Partial<InputChannel> = {}): InputChannel {
  return { ch: 1, inst: 'inst', mic: 'mic', stand: 'stand', ...over };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('ensureStageSlotIds: minting', () => {
  it('mints a UUID for slots missing an id and reports dirty', () => {
    const { config, dirty } = ensureStageSlotIds({
      stagePlot: [slot(), slot()],
      inputs: [],
    });
    expect(dirty).toBe(true);
    expect(config.stagePlot[0].id).toMatch(UUID_RE);
    expect(config.stagePlot[1].id).toMatch(UUID_RE);
    expect(config.stagePlot[0].id).not.toBe(config.stagePlot[1].id);
  });

  it('is idempotent / not dirty when all slots already have ids and links resolve', () => {
    const a = slot({ id: 'a' });
    const b = slot({ id: 'b' });
    const inp = input({ slotId: 'a' });
    const before = { stagePlot: [a, b], inputs: [inp] };
    const { config, dirty, ambiguousInputs } = ensureStageSlotIds(before);
    expect(dirty).toBe(false);
    expect(ambiguousInputs).toEqual([]);
    // unchanged ⇒ same references (no needless re-render churn)
    expect(config).toBe(before);
    expect(config.stagePlot[0]).toBe(a);
    expect(config.inputs[0]).toBe(inp);
  });

  it('preserves an existing id while minting only the missing one', () => {
    const a = slot({ id: 'keep-me' });
    const { config } = ensureStageSlotIds({ stagePlot: [a, slot()], inputs: [] });
    expect(config.stagePlot[0].id).toBe('keep-me');
    expect(config.stagePlot[1].id).toMatch(UUID_RE);
  });
});

describe('ensureStageSlotIds: de-dupe collisions', () => {
  it('keeps first occurrence id and re-mints the collision', () => {
    const { config, dirty } = ensureStageSlotIds({
      stagePlot: [slot({ id: 'dup' }), slot({ id: 'dup' })],
      inputs: [],
    });
    expect(dirty).toBe(true);
    expect(config.stagePlot[0].id).toBe('dup');
    expect(config.stagePlot[1].id).not.toBe('dup');
    expect(config.stagePlot[1].id).toMatch(UUID_RE);
  });

  it('flags an input pointing at a de-duped id as ambiguous: clears slotId + needsReview', () => {
    const inp = input({ slotId: 'dup' });
    const { config, dirty, ambiguousInputs } = ensureStageSlotIds({
      stagePlot: [slot({ id: 'dup' }), slot({ id: 'dup' })],
      inputs: [inp],
    });
    expect(dirty).toBe(true);
    expect(config.inputs[0].slotId).toBeUndefined();
    expect(config.inputs[0].needsReview).toBe(true);
    expect(ambiguousInputs).toHaveLength(1);
    expect(ambiguousInputs[0]).toBe(config.inputs[0]);
  });
});

describe('ensureStageSlotIds: dangling links', () => {
  it('flags a dangling slotId (no matching slot) with needsReview but keeps the slotId', () => {
    const { config, dirty } = ensureStageSlotIds({
      stagePlot: [slot({ id: 'a' })],
      inputs: [input({ slotId: 'gone' })],
    });
    expect(dirty).toBe(true);
    expect(config.inputs[0].slotId).toBe('gone');
    expect(config.inputs[0].needsReview).toBe(true);
  });

  it('does not re-flag (or re-dirty) an already-flagged dangling input', () => {
    const inp = input({ slotId: 'gone', needsReview: true });
    const before = { stagePlot: [slot({ id: 'a' })], inputs: [inp] };
    const { config, dirty } = ensureStageSlotIds(before);
    expect(dirty).toBe(false);
    expect(config.inputs[0]).toBe(inp);
  });

  it('leaves a resolvable slotId untouched', () => {
    const inp = input({ slotId: 'a' });
    const { config, dirty } = ensureStageSlotIds({
      stagePlot: [slot({ id: 'a' })],
      inputs: [inp],
    });
    expect(dirty).toBe(false);
    expect(config.inputs[0]).toBe(inp);
    expect(config.inputs[0].needsReview).toBeUndefined();
  });

  it('ignores inputs with no slotId', () => {
    const { dirty, ambiguousInputs } = ensureStageSlotIds({
      stagePlot: [slot({ id: 'a' })],
      inputs: [input(), input()],
    });
    expect(dirty).toBe(false);
    expect(ambiguousInputs).toEqual([]);
  });
});

describe('ensureStageSlotIds: extra config fields preserved', () => {
  it('passes through unrelated config keys when dirty', () => {
    const { config } = ensureStageSlotIds({
      stagePlot: [slot()],
      inputs: [],
      monitors: [{ mix: 1, name: 'm', needs: 'n' }],
    });
    expect(config.monitors).toEqual([{ mix: 1, name: 'm', needs: 'n' }]);
  });
});
