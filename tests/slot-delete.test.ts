import { describe, it, expect } from 'vitest';
import { deleteStageSlot, withStableIds } from '../lib/setlist';
import type { InputChannel, StageSlot } from '../lib/types';

// UAT S8: the slot delete used to be decided by a window.confirm whose two
// buttons both deleted. The delete itself now lives here, by slot id.

const slot = (id: string, name = id): StageSlot => ({ id, name, pos: 'MSC', role: 'Vox', mix: 1 });
const input = (id: string, slotId?: string): InputChannel => ({ id, ch: 1, inst: id, mic: '', stand: '', slotId });

function show() {
  return {
    stagePlot: [slot('a'), slot('b')],
    inputs: [input('i1', 'a'), input('i2', 'a'), input('i3', 'b'), input('i4')],
  };
}

describe('deleteStageSlot', () => {
  it('removes only the slot with that id', () => {
    expect(deleteStageSlot(show(), 'a', 'keep').stagePlot.map((s) => s.id)).toEqual(['b']);
  });

  it("'keep' leaves the linked inputs' slotId dangling, so the normalizer flags them", () => {
    const out = deleteStageSlot(show(), 'a', 'keep');
    expect(out.inputs).toEqual(show().inputs);
    // The flag is the normalizer's job, not this helper's — pin that it happens.
    const flagged = withStableIds({ ...out, monitors: [], notes: [], setlist: [] }).inputs;
    expect(flagged.filter((i) => i.needsReview).map((i) => i.id)).toEqual(['i1', 'i2']);
  });

  it("'clear' unlinks the linked inputs but keeps them in the list", () => {
    const out = deleteStageSlot(show(), 'a', 'clear');
    expect(out.inputs.map((i) => [i.id, i.slotId ?? null])).toEqual([
      ['i1', null], ['i2', null], ['i3', 'b'], ['i4', null],
    ]);
    expect(out.inputs.some((i) => i.needsReview)).toBe(false);
  });

  it('never touches inputs linked to another slot', () => {
    for (const mode of ['keep', 'clear'] as const) {
      expect(deleteStageSlot(show(), 'a', mode).inputs.find((i) => i.id === 'i3')!.slotId).toBe('b');
    }
  });

  it('an id that is gone (row deleted meanwhile) deletes nothing', () => {
    const out = deleteStageSlot(show(), 'zzz', 'clear');
    expect(out.stagePlot).toHaveLength(2);
    expect(out.inputs).toEqual(show().inputs);
  });
});
