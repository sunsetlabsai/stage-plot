import { describe, it, expect } from 'vitest';
import { serializeShow, deserializeShow } from '@/lib/show-file';
import { MONITOR_TYPES } from '@/lib/setlist';
import { TOOLS } from '@/lib/agent';
import type { MonitorMix } from '@/lib/types';

// design-ai-op-contract §3.4 — MonitorMix.type.
//
// Graham approved this on the condition that it was not "a mountain of work",
// and the scoping said YAML round-trips it "free by construction" because
// serializeShow spreads (`{id, ...rest}`) rather than enumerating fields.
//
// ★ That was a CLAIM, and claims about code get tested rather than trusted —
// especially a claim used to argue that a change was cheap enough to approve.

function config(monitors: MonitorMix[]) {
  return {
    showInfo: { bandName: 'Loosely Covered', eventDate: '', venue: '' },
    stagePlot: [],
    inputs: [],
    monitors,
    notes: [],
    setlist: [],
  };
}

describe('MonitorMix.type — YAML round-trip', () => {
  it('★ survives serialize → deserialize without any change to show-file.ts', () => {
    // The whole "cheap enough to approve" argument rests on this.
    const out = deserializeShow(
      serializeShow(config([
        { id: 'm1', mix: 1, name: 'Marcus', needs: 'Kick, bass', type: 'IEM' },
      ])),
      'show.showrunr.yaml',
    );

    expect(out.monitors[0].type).toBe('IEM');
  });

  it('★ a value outside MONITOR_TYPES round-trips too — free text, not an enum', () => {
    // The distinguishing case. An enum-backed implementation passes the test
    // above and silently drops or rejects this one, which is exactly the
    // side-fill/hybrid rig the free-text decision exists for.
    const out = deserializeShow(
      serializeShow(config([
        { id: 'm1', mix: 1, name: 'Horns', needs: 'Everything', type: 'Side-fill + IEM hybrid' },
      ])),
      'show.showrunr.yaml',
    );

    expect(out.monitors[0].type).toBe('Side-fill + IEM hybrid');
  });

  it('a legacy mix with no type stays absent — not the string "undefined"', () => {
    // Optional field ⇒ no migration. The failure mode being guarded is a
    // round-trip that stringifies undefined and renders "undefined" as a chip.
    const out = deserializeShow(
      serializeShow(config([{ id: 'm1', mix: 1, name: 'Marcus', needs: 'Kick' }])),
      'show.showrunr.yaml',
    );

    expect(out.monitors[0].type).toBeUndefined();
    expect(out.monitors[0]).not.toHaveProperty('type', 'undefined');
  });

  it('does not disturb the other monitor fields', () => {
    const out = deserializeShow(
      serializeShow(config([{ id: 'm1', mix: 2, name: 'Dee', needs: 'Bass, vox', type: 'Wedge' }])),
      'show.showrunr.yaml',
    );

    expect(out.monitors[0]).toMatchObject({ mix: 2, name: 'Dee', needs: 'Bass, vox' });
  });
});

describe('MonitorMix.type — contract surfaces', () => {
  it('the AI can set it: update_monitors exposes type, and does NOT require it', () => {
    const tool = TOOLS.find((t) => t.name === 'update_monitors');
    const items = (tool as unknown as {
      input_schema: { properties: { monitors: { items: { properties: Record<string, unknown>; required: string[] } } } };
    }).input_schema.properties.monitors.items;

    expect(items.properties).toHaveProperty('type');
    // Required would force the model to invent a value for every mix, which is
    // the opposite of "omit if the user has not said".
    expect(items.required).not.toContain('type');
  });

  it('MONITOR_TYPES suggests without constraining', () => {
    expect(MONITOR_TYPES).toContain('Wedge');
    expect(MONITOR_TYPES).toContain('IEM');
    // Pinned by name so removing a suggestion is a deliberate act, not a drift.
    expect([...MONITOR_TYPES]).toEqual(['Wedge', 'IEM', 'Side-fill', 'Drum fill', 'None']);
  });
});
