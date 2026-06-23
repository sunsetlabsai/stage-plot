import { describe, it, expect } from 'vitest';
import {
  availableRoles,
  applyUploadedChart,
  removeChartById,
  updateSetlistCharts,
  suggestDuplicateTitle,
} from '../lib/chart-management';
import type { Chart, SetlistSong } from '../lib/types';

function chart(role: string, fileId: string): Chart {
  return { role, url: `https://x/${fileId}`, fileId, label: `${fileId}.pdf` };
}

describe('availableRoles', () => {
  it('returns the full allowlist when nothing is filled', () => {
    expect(availableRoles([])).toEqual(['guitar', 'lyrics', 'keys', 'bass', 'horns', 'drums', 'other']);
  });

  it('excludes filled roles', () => {
    const roles = availableRoles([chart('guitar', 'a'), chart('drums', 'b')]);
    expect(roles).not.toContain('guitar');
    expect(roles).not.toContain('drums');
    expect(roles).toContain('keys');
  });

  it('canonicalizes legacy/free-text roles before diffing', () => {
    // 'Guitar' (title case) and an unknown role → 'other'
    const roles = availableRoles([chart('Guitar', 'a'), chart('Conductor', 'b')]);
    expect(roles).not.toContain('guitar');
    expect(roles).not.toContain('other');
  });
});

describe('applyUploadedChart', () => {
  it('appends a chart for a new role', () => {
    const out = applyUploadedChart([chart('guitar', 'a')], chart('keys', 'b'));
    expect(out.map((c) => c.fileId)).toEqual(['a', 'b']);
  });

  it('replaces the chart of an existing canonical role', () => {
    const out = applyUploadedChart([chart('guitar', 'a')], chart('Guitar', 'a2'));
    expect(out).toHaveLength(1);
    expect(out[0].fileId).toBe('a2');
  });
});

describe('removeChartById', () => {
  it('drops the matching chart and leaves the rest', () => {
    const out = removeChartById([chart('guitar', 'a'), chart('keys', 'b')], 'a');
    expect(out.map((c) => c.fileId)).toEqual(['b']);
  });
});

describe('updateSetlistCharts', () => {
  function song(id: string, title: string, charts: Chart[] = []): SetlistSong {
    return { id, position: 0, title, lead: '', charts };
  }

  it('updates every row sharing the normalized title, not just one', () => {
    const setlist = [
      song('1', 'The Song'),
      song('2', 'Other'),
      song('3', 'the song!'), // same normalized key as row 1
    ];
    const out = updateSetlistCharts(setlist, 'Song', (cs) => [...cs, chart('guitar', 'g')]);
    expect(out[0].charts).toHaveLength(1);
    expect(out[1].charts).toEqual([]);
    expect(out[2].charts).toHaveLength(1);
  });

  it('no-ops on an unnormalizable title', () => {
    const setlist = [song('1', 'Real')];
    const out = updateSetlistCharts(setlist, '!!!', (cs) => [...cs, chart('guitar', 'g')]);
    expect(out).toEqual(setlist);
  });
});

describe('suggestDuplicateTitle', () => {
  it('appends (copy) when free', () => {
    expect(suggestDuplicateTitle('Song X', ['Song X'])).toBe('Song X (copy)');
  });

  it('increments when (copy) is taken (normalized compare)', () => {
    expect(suggestDuplicateTitle('Song X', ['Song X', 'song x (copy)'])).toBe('Song X (copy 2)');
  });
});
