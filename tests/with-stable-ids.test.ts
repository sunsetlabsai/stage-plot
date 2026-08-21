import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withStableIds } from '@/lib/setlist';
import type { StageSlot, InputChannel, MonitorMix, SetlistSong } from '@/lib/types';

// design-ai-op-contract §9.4 — the manual-path id bug.
//
// THE DEFECT: the mutation sites ran `ensureStageSlotIds` alone, which normalizes
// STAGE SLOTS ONLY. So every setlist row arriving via CSV/sheet import — and every
// input and monitor created at those sites — landed with `id: undefined`, against
// 12 `.id!` dereferences in the page (React keys and useSortable ids). Broken keys
// and dead drag-and-drop, with no AI involved.
//
// The normalizers were never the problem; they work. The WIRING was the problem —
// the wrong one was being called. That is why these tests assert on all four
// entities at once: a fix that covers slots and nothing else is exactly the bug.

function config(over: Partial<{
  stagePlot: StageSlot[]; inputs: InputChannel[]; monitors: MonitorMix[]; setlist: SetlistSong[];
}> = {}) {
  return {
    stagePlot: [] as StageSlot[],
    inputs: [] as InputChannel[],
    monitors: [] as MonitorMix[],
    setlist: [] as SetlistSong[],
    ...over,
  };
}

describe('withStableIds — every entity, not just slots', () => {
  it('★ mints ids for setlist, inputs and monitors, not only stage slots', () => {
    // The distinguishing case. `ensureStageSlotIds` alone passes any assertion
    // about stagePlot and leaves the other three undefined — which is the shipped
    // defect. Asserting all four is what separates the fix from the bug.
    const out = withStableIds(config({
      stagePlot: [{ name: 'Dee', pos: 'USL', role: 'Bass', mix: 1 }],
      inputs: [{ ch: 1, inst: 'Bass DI', mic: 'DI', stand: 'None' }],
      monitors: [{ mix: 1, name: 'Dee', needs: 'Bass, vocal' }],
      setlist: [{ position: 1, title: 'Wonderwall', lead: 'Renee' }],
    }));

    expect(out.stagePlot[0].id).toBeTruthy();
    expect(out.inputs[0].id).toBeTruthy();
    expect(out.monitors[0].id).toBeTruthy();
    expect(out.setlist[0].id).toBeTruthy();
  });

  it('★ an imported setlist row gets an id — the reported symptom', () => {
    // applyImportMerge's exact shape: rows arrive from CSV/sheet with no id, and
    // the page keys on `song.id!` and drags on `useSortable({id: song.id!})`.
    const out = withStableIds(config({
      setlist: [
        { position: 1, title: 'Song A', lead: 'Renee' },
        { position: 2, title: 'Song B', lead: 'Renee' },
      ],
    }));

    const ids = out.setlist.map((s) => s.id);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(2); // distinct — a shared id breaks React keys too
  });

  it('is ref-stable when every row already has an id', () => {
    // Load-bearing: this runs on EVERY mutation, including per-keystroke edits.
    // If it returned a new object each time, it would churn React state forever.
    const stable = config({
      stagePlot: [{ id: 's1', name: 'Dee', pos: 'USL', role: 'Bass', mix: 1 }],
      inputs: [{ id: 'i1', ch: 1, inst: 'Bass DI', mic: 'DI', stand: 'None', slotId: 's1' }],
      monitors: [{ id: 'm1', mix: 1, name: 'Dee', needs: '' }],
      setlist: [{ id: 'g1', position: 1, title: 'Song A', lead: 'Renee' }],
    });

    expect(withStableIds(stable)).toBe(stable); // identity, not deep-equality
  });

  it('preserves ids that already exist rather than re-minting them', () => {
    // A re-mint would silently break every slotId pointing at the old value.
    const out = withStableIds(config({
      stagePlot: [{ id: 'keep-me', name: 'Dee', pos: 'USL', role: 'Bass', mix: 1 }],
      inputs: [{ id: 'keep-too', ch: 1, inst: 'Bass DI', mic: 'DI', stand: 'None', slotId: 'keep-me' }],
    }));

    expect(out.stagePlot[0].id).toBe('keep-me');
    expect(out.inputs[0].id).toBe('keep-too');
    expect(out.inputs[0].slotId).toBe('keep-me'); // the link survives normalization
  });

  it('★ a DANGLING slotId is flagged, and its value preserved for repair', () => {
    // Written from the code, not from the comment: a dangling link keeps its
    // slotId and only sets needsReview, so a human can still see what it pointed
    // at. Only a COLLIDING id gets cleared (next test). Conflating the two is
    // easy and would silently discard repairable data.
    const out = withStableIds(config({
      stagePlot: [{ name: 'Dee', pos: 'USL', role: 'Bass', mix: 1 }],
      inputs: [{ ch: 1, inst: 'Bass DI', mic: 'DI', stand: 'None', slotId: 'points-at-nothing' }],
    }));

    expect(out.inputs[0].id).toBeTruthy();                   // still normalized
    expect(out.inputs[0].slotId).toBe('points-at-nothing');  // preserved, NOT cleared
    expect(out.inputs[0].needsReview).toBe(true);            // but flagged
  });

  it('★ a COLLIDING slot id clears the link, and slot ids are minted first', () => {
    // Two slots sharing an id: the duplicate is re-minted, and any input pointing
    // at the now-ambiguous value has its slotId CLEARED (it cannot be resolved).
    // This is the case the ordering exists for — input normalization must run on
    // top of the cleared state, not before it.
    const out = withStableIds(config({
      stagePlot: [
        { id: 'dupe', name: 'Dee', pos: 'USL', role: 'Bass', mix: 1 },
        { id: 'dupe', name: 'Tomás', pos: 'MSR', role: 'Guitar', mix: 2 },
      ],
      inputs: [{ ch: 1, inst: 'Bass DI', mic: 'DI', stand: 'None', slotId: 'dupe' }],
    }));

    expect(out.stagePlot[0].id).not.toBe(out.stagePlot[1].id); // de-duped
    expect(out.inputs[0].slotId).toBeUndefined();              // ambiguous ⇒ cleared
    expect(out.inputs[0].needsReview).toBe(true);
    expect(out.inputs[0].id).toBeTruthy();                     // minted after the clear
  });

  it('★ WIRING GUARD: the page calls no normalizer directly', () => {
    // Everything above pins what withStableIds DOES. None of it pins that the
    // mutation sites CALL it — and the wiring is the entire bug: the normalizers
    // always worked, the wrong one was being invoked.
    //
    // The page is a 6,700-line client component with no test harness in this repo
    // (the documented jsdom gap), so this asserts against the source instead.
    // Crude, but it fails on the exact regression: someone reaching for
    // `ensureStageSlotIds` at a mutation site again. All four normalizers belong
    // to withStableIds now; the page should only ever call the composite.
    const src = readFileSync(
      join(process.cwd(), 'app/[owner]/[show]/page.tsx'),
      'utf8',
    );

    for (const normalizer of [
      'ensureStageSlotIds(',
      'ensureSetlistSongIds(',
      'ensureInputIds(',
      'ensureMonitorIds(',
    ]) {
      expect(src, `${normalizer} called directly in page.tsx — use withStableIds`)
        .not.toContain(normalizer);
    }
    expect(src).toContain('withStableIds('); // and it does use the composite
  });

  it('★ de-dupes setlist, input and monitor ids — not just slots (Codex R1 medium)', () => {
    // The first version's comment claimed de-dupe "across every entity" while
    // only slots got it: ensure*Ids keeps an existing id verbatim, duplicate or
    // not. A duplicate id breaks React keys and drag identity exactly as a
    // missing one does, so this is the same defect the helper exists to prevent.
    const out = withStableIds(config({
      setlist: [
        { id: 'same', position: 1, title: 'A', lead: 'R' },
        { id: 'same', position: 2, title: 'B', lead: 'R' },
      ],
      inputs: [
        { id: 'dupe', ch: 1, inst: 'Kick', mic: 'Beta 52', stand: 'Short' },
        { id: 'dupe', ch: 2, inst: 'Snare', mic: 'SM57', stand: 'Short' },
      ],
      monitors: [
        { id: 'clash', mix: 1, name: 'A', needs: '' },
        { id: 'clash', mix: 2, name: 'B', needs: '' },
      ],
    }));

    expect(out.setlist[0].id).not.toBe(out.setlist[1].id);
    expect(out.inputs[0].id).not.toBe(out.inputs[1].id);
    expect(out.monitors[0].id).not.toBe(out.monitors[1].id);
    // The FIRST occurrence keeps its id; only the later collision is re-minted,
    // so a stable row does not churn just because a duplicate appeared after it.
    expect(out.setlist[0].id).toBe('same');
    expect(out.inputs[0].id).toBe('dupe');
    expect(out.monitors[0].id).toBe('clash');
  });

  it('de-duping does not disturb the rest of the row', () => {
    const out = withStableIds(config({
      inputs: [
        { id: 'dupe', ch: 1, inst: 'Kick', mic: 'Beta 52', stand: 'Short' },
        { id: 'dupe', ch: 2, inst: 'Snare', mic: 'SM57', stand: 'Short', slotId: 'x' },
      ],
      stagePlot: [{ id: 'x', name: 'Marcus', pos: 'USC', role: 'Drums', mix: 1 }],
    }));

    expect(out.inputs[1]).toMatchObject({ ch: 2, inst: 'Snare', mic: 'SM57', slotId: 'x' });
  });

  it('leaves non-id fields untouched', () => {
    const out = withStableIds(config({
      setlist: [{ position: 1, title: 'Wonderwall', lead: 'Renee', key: 'Eb', notes: 'capo 2' }],
    }));

    expect(out.setlist[0]).toMatchObject({
      position: 1, title: 'Wonderwall', lead: 'Renee', key: 'Eb', notes: 'capo 2',
    });
  });
});
