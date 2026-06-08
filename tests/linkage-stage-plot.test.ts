import { describe, it, expect } from 'vitest';
import { groupByPos, countLinkedInputs, slotLabel, slotOptionsForInputs, blockIndexOf } from '../lib/setlist';
import type { StageSlot, InputChannel } from '../lib/types';

function slot(over: Partial<StageSlot> = {}): StageSlot {
  return { name: 'X', pos: 'USC', role: 'role', mix: 1, ...over };
}
function input(over: Partial<InputChannel> = {}): InputChannel {
  return { ch: 1, inst: 'inst', mic: 'mic', stand: 'stand', ...over };
}

describe('groupByPos', () => {
  it('groups slots by position', () => {
    const m = groupByPos([
      slot({ id: 'a', pos: 'USC' }),
      slot({ id: 'b', pos: 'MSR' }),
      slot({ id: 'c', pos: 'USC' }),
    ]);
    expect(m.get('USC')!.map((s) => s.id)).toEqual(['a', 'c']);
    expect(m.get('MSR')!.map((s) => s.id)).toEqual(['b']);
    expect(m.has('DSL')).toBe(false);
  });

  it('preserves stable insertion (array) order within a block', () => {
    const m = groupByPos([
      slot({ id: 'strings', pos: 'MSR', name: 'Strings', mix: 5 }),
      slot({ id: 'brass', pos: 'MSR', name: 'Brass', mix: 6 }),
    ]);
    // Order follows array order, NOT mix number or name.
    expect(m.get('MSR')!.map((s) => s.name)).toEqual(['Strings', 'Brass']);
  });

  it('returns an empty map for no slots', () => {
    expect(groupByPos([]).size).toBe(0);
  });
});

describe('countLinkedInputs', () => {
  it('counts inputs whose slotId matches (shared-mix ×n badge)', () => {
    const inputs = [
      input({ slotId: 'drums' }),
      input({ slotId: 'drums' }),
      input({ slotId: 'keys' }),
      input({}),
    ];
    expect(countLinkedInputs('drums', inputs)).toBe(2);
    expect(countLinkedInputs('keys', inputs)).toBe(1);
    expect(countLinkedInputs('nobody', inputs)).toBe(0);
  });

  it('returns 0 for an undefined slotId', () => {
    expect(countLinkedInputs(undefined, [input({ slotId: 'x' })])).toBe(0);
  });
});

describe('slotLabel', () => {
  it('uses the slot name when present', () => {
    expect(slotLabel(slot({ name: 'Riddim' }), 0)).toBe('Riddim');
  });

  it('falls back to Occupant {n} (1-based block index) when name is blank', () => {
    expect(slotLabel(slot({ name: '' }), 0)).toBe('Occupant 1');
    expect(slotLabel(slot({ name: '   ' }), 1)).toBe('Occupant 2');
  });
});

describe('blockIndexOf', () => {
  it('counts only preceding occupants of the same block', () => {
    const slots = [
      slot({ pos: 'USC' }), // 0 → USC #0
      slot({ pos: 'MSR' }), // 1 → MSR #0
      slot({ pos: 'USC' }), // 2 → USC #1
      slot({ pos: 'USC' }), // 3 → USC #2
    ];
    expect(blockIndexOf(slots, 0)).toBe(0);
    expect(blockIndexOf(slots, 1)).toBe(0);
    expect(blockIndexOf(slots, 2)).toBe(1);
    expect(blockIndexOf(slots, 3)).toBe(2);
  });
});

describe('slotOptionsForInputs', () => {
  it('emits one TLA — label option per slot with an id, in block array order', () => {
    const opts = slotOptionsForInputs([
      slot({ id: 'd', pos: 'USC', name: 'Drums' }),
      slot({ id: 's', pos: 'MSR', name: 'Strings' }),
      slot({ id: 'b', pos: 'MSR', name: 'Brass' }),
    ]);
    expect(opts).toEqual([
      { id: 'd', label: 'USC — Drums' },
      { id: 's', label: 'MSR — Strings' },
      { id: 'b', label: 'MSR — Brass' },
    ]);
  });

  it('uses the Occupant {n} fallback label for blank-name slots within a block', () => {
    const opts = slotOptionsForInputs([
      slot({ id: 'a', pos: 'USC', name: '' }),
      slot({ id: 'b', pos: 'USC', name: '' }),
    ]);
    expect(opts).toEqual([
      { id: 'a', label: 'USC — Occupant 1' },
      { id: 'b', label: 'USC — Occupant 2' },
    ]);
  });

  it('skips slots that have no id (not yet linkable)', () => {
    const opts = slotOptionsForInputs([slot({ pos: 'USC', name: 'X' }), slot({ id: 'y', pos: 'USL', name: 'Y' })]);
    expect(opts).toEqual([{ id: 'y', label: 'USL — Y' }]);
  });
});
