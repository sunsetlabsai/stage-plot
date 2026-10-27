import { describe, it, expect } from 'vitest';
import { importShowPrompt, restoreImportUndo, type ImportUndo } from '../lib/import-undo';
import type { SetlistSong } from '../lib/types';

// UAT S7: Config → Import Show replaced the whole show with no confirm or undo.

type Cfg = Parameters<typeof importShowPrompt>[0] & { showInfo: { bandName: string; showName?: string } };

function song(title: string): SetlistSong {
  return { id: title, position: 1, title, lead: '', bpm: null };
}

function cfg(over: Partial<Cfg> = {}): Cfg {
  return { showInfo: { bandName: 'Band', showName: 'Band', eventDate: '', venue: '' }, stagePlot: [], inputs: [], monitors: [], notes: [], setlist: [], ...over };
}

describe('restoreImportUndo', () => {
  it('a show undo restores the whole snapshot, not just the setlist', () => {
    const before = cfg({ showInfo: { bandName: 'Before', eventDate: '', venue: '' }, setlist: [song('A')] });
    const after = cfg({ showInfo: { bandName: 'Imported', eventDate: '', venue: '' }, setlist: [song('B')] });
    expect(restoreImportUndo(after, { kind: 'show', config: before })).toBe(before);
  });

  it('a setlist undo restores only the setlist and keeps every other field', () => {
    const prev = cfg({ showInfo: { bandName: 'Edited', eventDate: '', venue: '' }, setlist: [song('New')] });
    const undo: ImportUndo<Cfg> = { kind: 'setlist', setlist: [song('Old')] };
    const out = restoreImportUndo(prev, undo);
    expect(out.setlist.map((s) => s.title)).toEqual(['Old']);
    expect(out.showInfo.bandName).toBe('Edited');
  });
});

describe('importShowPrompt', () => {
  it('asks nothing when the show has nothing to lose', () => {
    expect(importShowPrompt(cfg(), 'x.yaml')).toBeNull();
  });

  it('a fresh show (band and show name from the create dialog, nothing else) asks nothing', () => {
    expect(importShowPrompt(cfg({ showInfo: { bandName: 'The Band', showName: 'The Band', eventDate: '', venue: '' } }), 'x.yaml')).toBeNull();
  });

  it('asks when only the venue, or only the date, is filled in (Codex R1 on #198)', () => {
    expect(importShowPrompt(cfg({ showInfo: { bandName: 'Band', eventDate: '', venue: 'The Fillmore' } }), 'x.yaml')).not.toBeNull();
    expect(importShowPrompt(cfg({ showInfo: { bandName: 'Band', eventDate: '2026-11-01', venue: '' } }), 'x.yaml')).not.toBeNull();
  });

  it('asks when ANY list has content — a setlist alone, or notes alone, is enough', () => {
    expect(importShowPrompt(cfg({ setlist: [song('A')] }), 'x.yaml')).not.toBeNull();
    expect(importShowPrompt(cfg({ notes: [{ label: 'Load-in', text: '5pm' }] }), 'x.yaml')).not.toBeNull();
  });

  it('names the file, counts what is discarded, and says how long undo lasts', () => {
    const p = importShowPrompt(cfg({ setlist: [song('A'), song('B')] }), 'gig.yaml')!;
    expect(p).toContain('“gig.yaml”');
    expect(p).toContain('0 performers, 0 inputs, 0 monitor mixes, 2 songs, 0 notes and the show info');
    expect(p).toContain('until your next edit or tab change');
  });

  it('uses the singular for one', () => {
    expect(importShowPrompt(cfg({ setlist: [song('A')] }), 'x')).toContain('1 song,');
  });
});
