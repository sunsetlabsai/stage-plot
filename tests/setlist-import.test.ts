import { describe, it, expect } from 'vitest';
import {
  parseCsv,
  mapHeaders,
  parseRows,
  mergeSetlist,
  MissingTitleColumnError,
  type ImportedRow,
} from '../lib/setlist-import';
import type { SetlistSong } from '../lib/types';

// Design: docs/design-setlist-import-merge.md §9.
//
// Ordering tests pin the FULL output array, exactly — not "the new row is not at
// position 1", not a length check, not a spot-check of one index. The v3 design
// blocker was a worked example that disagreed with its own rule, and a test that
// asserts less than the whole array would not have caught it.

/** Deterministic id minter — what makes the round-trip test an exact deep-equal. */
function counter() {
  let n = 0;
  return () => `new-${n++}`;
}

/** Terse setlist builder. Positions are 1-based and dense, as stored. */
function setlist(
  ...songs: (Partial<SetlistSong> & { title: string })[]
): SetlistSong[] {
  return songs.map((s, i) => ({
    id: s.id ?? `id-${s.title.toLowerCase().replace(/\W+/g, '-')}`,
    position: i + 1,
    lead: s.lead ?? '',
    ...s,
  }));
}

const titles = (songs: SetlistSong[]) => songs.map((s) => s.title);
const positions = (songs: SetlistSong[]) => songs.map((s) => s.position);
const dense = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

function rows(...specs: (string | ImportedRow)[]): ImportedRow[] {
  return specs.map((s) => (typeof s === 'string' ? { title: s } : s));
}

// ── parseCsv ─────────────────────────────────────────────────────────────────

describe('parseCsv', () => {
  it('keeps commas inside quoted fields', () => {
    expect(parseCsv('a,"b,c",d')).toEqual([['a', 'b,c', 'd']]);
  });

  it('unescapes doubled quotes', () => {
    expect(parseCsv('"say ""hi""",x')).toEqual([['say "hi"', 'x']]);
  });

  it('handles CRLF line endings', () => {
    expect(parseCsv('a,b\r\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('does not emit a phantom row for a trailing newline', () => {
    expect(parseCsv('a,b\n')).toEqual([['a', 'b']]);
  });

  it('keeps the partial field from an unterminated quote at EOF', () => {
    expect(parseCsv('a,"b')).toEqual([['a', 'b']]);
  });
});

// ── mapHeaders ───────────────────────────────────────────────────────────────

describe('mapHeaders', () => {
  it('binds title correctly when "Song Key" sits left of "Title"', () => {
    // The precedence bug: findIndex(h => h.includes('song')) binds "Song Key"
    // as the title column. Exact-before-substring is what fixes it.
    const f = mapHeaders(['Song Key', 'Title', 'Lead']);
    expect(f.title).toBe(1);
    expect(f.key).toBe(0);
  });

  it('binds "Scene Note" and "Notes" separately', () => {
    const f = mapHeaders(['Title', 'Notes', 'Scene Note']);
    expect(f.notes).toBe(1);
    expect(f.sceneNote).toBe(2);
  });

  it('binds "#" to position but not "Number of takes"', () => {
    const f = mapHeaders(['#', 'Title', 'Number of takes']);
    expect(f.position).toBe(0);
    const g = mapHeaders(['Title', 'Number of takes']);
    expect(g.position).toBeUndefined();
  });

  it('throws when there is no title column', () => {
    expect(() => mapHeaders(['Lead', 'Notes'])).toThrow(MissingTitleColumnError);
  });

  it('ignores casing and surrounding whitespace', () => {
    const f = mapHeaders(['  TITLE  ', ' Key ']);
    expect(f.title).toBe(0);
    expect(f.key).toBe(1);
  });

  it('does NOT bind a "Keys" column to key (exact-match-only guard)', () => {
    // "Keys" in a band's sheet is at least as likely to mean the keyboard
    // player's part. Mis-binding writes instrument names into the musical key.
    const f = mapHeaders(['Title', 'Keys']);
    expect(f.key).toBeUndefined();
  });

  it('binds a "Key" column to key', () => {
    expect(mapHeaders(['Title', 'Key']).key).toBe(1);
  });

  it('binds "Song Key" to key, not title', () => {
    const f = mapHeaders(['Song Key', 'Song']);
    expect(f.key).toBe(0);
    expect(f.title).toBe(1);
  });

  it('recognizes bpm and artist so they cannot be mis-bound', () => {
    const f = mapHeaders(['Title', 'BPM', 'Artist']);
    expect(f.bpm).toBe(1);
    expect(f.artist).toBe(2);
  });

  it('never binds one column index to two fields', () => {
    const f = mapHeaders(['Title', 'Scene Note']);
    const bound = Object.values(f);
    expect(new Set(bound).size).toBe(bound.length);
  });
});

// ── parseRows ────────────────────────────────────────────────────────────────

describe('parseRows', () => {
  const F = { title: 0, key: 1, lead: 2 };

  it('drops blank-title rows', () => {
    const out = parseRows([['A', 'C', ''], ['   ', 'D', ''], ['B', '', '']], F);
    expect(out.map((r) => r.title)).toEqual(['A', 'B']);
  });

  it('omits empty cells rather than storing empty strings', () => {
    const [row] = parseRows([['A', '', '']], F);
    expect(row).toEqual({ title: 'A' });
  });

  it('never lets a non-numeric # become NaN anywhere in the output', () => {
    // Number('four') is NaN and used to land straight in `position`
    // (app/api/sheet/route.ts:50).
    const out = parseRows([['four', 'A'], ['2', 'B']], { title: 1, position: 0 });
    expect(out).toEqual([{ title: 'A' }, { title: 'B' }]);
    expect(JSON.stringify(out)).not.toContain('NaN');
  });

  // §4 — sheet order is defined here and nowhere else.

  it('3a. sorts by # when every row has one: [B(#=2), A(#=1)] → [A, B]', () => {
    const out = parseRows([['2', 'B'], ['1', 'A']], { title: 1, position: 0 });
    expect(out.map((r) => r.title)).toEqual(['A', 'B']);
  });

  it('3c. no # column ⇒ identity (physical order preserved exactly)', () => {
    const out = parseRows([['C'], ['A'], ['B']], { title: 0 });
    expect(out.map((r) => r.title)).toEqual(['C', 'A', 'B']);
  });

  it('3d. duplicate # values keep physical order between them', () => {
    const out = parseRows(
      [['1', 'B'], ['1', 'A'], ['2', 'C']],
      { title: 1, position: 0 },
    );
    expect(out.map((r) => r.title)).toEqual(['B', 'A', 'C']);
  });

  it('3e. partial # ⇒ physical order, asserted exactly', () => {
    // The incomplete column is ignored, not partially honored. v5 promised an
    // interleave that compared 1-based # values against 0-based indices and had
    // no definite order to specify.
    const out = parseRows(
      [['', 'A'], ['1', 'B'], ['', 'C']],
      { title: 1, position: 0 },
    );
    expect(out.map((r) => r.title)).toEqual(['A', 'B', 'C']);
  });

  it('3f. one bad cell makes an otherwise-numbered column incomplete', () => {
    const out = parseRows(
      [['2', 'B'], ['four', 'A'], ['1', 'C']],
      { title: 1, position: 0 },
    );
    expect(out.map((r) => r.title)).toEqual(['B', 'A', 'C']);
  });
});

// ── mergeSetlist ─────────────────────────────────────────────────────────────

describe('mergeSetlist', () => {
  const merge = (
    existing: SetlistSong[],
    incoming: ImportedRow[],
    removeMissing = false,
  ) => mergeSetlist(existing, incoming, { newId: counter(), removeMissing });

  it('1. an exact-title match preserves id, songId, charts and bpm', () => {
    const existing = setlist({
      title: 'Ophelia',
      id: 'keep-me',
      songId: 'song-1',
      bpm: 120,
      charts: [{ role: 'guitar' } as never],
    });
    const { merged } = merge(existing, rows({ title: 'Ophelia', key: 'Bb' }));
    expect(merged[0]).toMatchObject({
      id: 'keep-me',
      songId: 'song-1',
      bpm: 120,
      key: 'Bb',
    });
    expect(merged[0].charts).toEqual([{ role: 'guitar' }]);
  });

  it('2. "The Weight" in the sheet matches "Weight" in the setlist', () => {
    // The §3 regression guard: import and save must agree on song identity, or
    // the row is added as new and then collapses at save into a duplicate.
    const existing = setlist({ title: 'Weight', id: 'w' });
    const { merged, diff } = merge(existing, rows({ title: 'The Weight', key: 'A' }));
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('w');
    expect(diff.added).toHaveLength(0);
  });

  it('3. a blank sheet cell does not clear an existing value', () => {
    const existing = setlist({ title: 'A', key: 'Bb', lead: 'Rachel', notes: 'keep' });
    const { merged } = merge(existing, rows({ title: 'A', key: '' }));
    expect(merged[0]).toMatchObject({ key: 'Bb', lead: 'Rachel', notes: 'keep' });
  });

  it('4. duplicate titles pair first-to-first and do not cross-assign', () => {
    const existing = setlist(
      { title: 'Intro', id: 'i1', notes: 'first' },
      { title: 'Intro', id: 'i2', notes: 'second' },
    );
    const { merged } = merge(
      existing,
      rows({ title: 'Intro', key: 'C' }, { title: 'Intro', key: 'D' }),
    );
    expect(merged.map((s) => [s.id, s.key, s.notes])).toEqual([
      ['i1', 'C', 'first'],
      ['i2', 'D', 'second'],
    ]);
  });

  it('5. reordering the sheet reorders the setlist and renumbers densely', () => {
    const existing = setlist({ title: 'A' }, { title: 'B' }, { title: 'C' });
    const { merged, diff } = merge(
      existing,
      rows('C', 'A', 'B'),
      true,
    );
    expect(titles(merged)).toEqual(['C', 'A', 'B']);
    expect(positions(merged)).toEqual(dense(3));
    expect(diff.reordered).toBe(true);
  });

  it('6. removeMissing false keeps an absent row and reports it in diff.missing', () => {
    const existing = setlist({ title: 'A' }, { title: 'Old Intro' });
    const { merged, diff } = merge(existing, rows('A'));
    expect(titles(merged)).toEqual(['A', 'Old Intro']);
    expect(diff.missing.map((m) => m.title)).toEqual(['Old Intro']);
    expect(diff.removed).toHaveLength(0);
  });

  it('7. removeMissing true drops it and reports it in diff.removed', () => {
    const existing = setlist({ title: 'A' }, { title: 'Old Intro' });
    const { merged, diff } = merge(existing, rows('A'), true);
    expect(titles(merged)).toEqual(['A']);
    expect(diff.removed.map((m) => m.title)).toEqual(['Old Intro']);
    expect(diff.missing).toHaveLength(0);
  });

  // §4 rule 5a — kept rows hold their index, incoming fill the remaining slots.
  // Every one of these asserts the FULL array plus dense 1..n positions.

  const ABCDE = () =>
    setlist({ title: 'A' }, { title: 'B' }, { title: 'C' }, { title: 'D' }, { title: 'E' });

  it('7a. partial sheet [C] → [A,B,C,D,E] — C holds index 2, nothing else moves', () => {
    const { merged, diff } = merge(ABCDE(), rows('C'));
    expect(titles(merged)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(positions(merged)).toEqual(dense(5));
    expect(diff.reordered).toBe(false);
  });

  it('7b. subset reorder [C,A] → [C,B,A,D,E]', () => {
    const { merged } = merge(ABCDE(), rows('C', 'A'));
    expect(titles(merged)).toEqual(['C', 'B', 'A', 'D', 'E']);
    expect(positions(merged)).toEqual(dense(5));
  });

  it('7c. [C,NEW] → [A,B,C,D,E,NEW] — the v3 blocker, frozen', () => {
    // v3 printed [A,B,C,NEW,E]: length 5 against 6 rows, silently dropping D
    // and moving E. Assert the whole array, not just NEW's index.
    const { merged } = merge(ABCDE(), rows('C', 'NEW'));
    expect(titles(merged)).toEqual(['A', 'B', 'C', 'D', 'E', 'NEW']);
    expect(positions(merged)).toEqual(dense(6));
  });

  it('7d. a full sheet degenerates to pure sheet order', () => {
    const { merged } = merge(ABCDE(), rows('E', 'D', 'C', 'B', 'A'));
    expect(titles(merged)).toEqual(['E', 'D', 'C', 'B', 'A']);
    expect(positions(merged)).toEqual(dense(5));
  });

  it('7e. interleave: [NEW,C] → [A,B,NEW,D,E,C]', () => {
    // Incoming rows fill free slots {2,5} in sheet order, so C lands AFTER NEW
    // despite being listed second. The price of "nothing you didn't mention
    // moves" — pinned so it can only change deliberately.
    const { merged } = merge(ABCDE(), rows('NEW', 'C'));
    expect(titles(merged)).toEqual(['A', 'B', 'NEW', 'D', 'E', 'C']);
    expect(positions(merged)).toEqual(dense(6));
  });

  it('7f. no holes, exact fit — over many random shapes', () => {
    const pool = ['A', 'B', 'C', 'D', 'E', 'F'];
    for (let seed = 0; seed < 60; seed++) {
      const existing = setlist(...pool.slice(0, (seed % 5) + 2).map((t) => ({ title: t })));
      const overlap = existing.slice(0, seed % (existing.length + 1)).map((s) => s.title);
      const fresh = Array.from({ length: seed % 3 }, (_, i) => `N${seed}-${i}`);
      const incoming = rows(...overlap, ...fresh);

      const { merged } = merge(existing, incoming);

      expect(merged).toHaveLength(existing.length + fresh.length);
      expect(merged.every((s) => s !== undefined)).toBe(true);
      expect(positions(merged)).toEqual(dense(merged.length));

      // Kept rows sit at their original index.
      const keptTitles = existing.map((s) => s.title).filter((t) => !overlap.includes(t));
      for (const t of keptTitles) {
        expect(merged[existing.findIndex((s) => s.title === t)].title).toBe(t);
      }
      // Incoming rows appear in sheet order among themselves.
      const incomingOrder = merged
        .map((s) => s.title)
        .filter((t) => overlap.includes(t) || fresh.includes(t));
      expect(incomingOrder).toEqual([...overlap, ...fresh]);
    }
  });

  it('7f-i. the slot-fit invariant is enforced, not just asserted in prose', () => {
    // Invariant 4 (free slots === incoming rows) was stated in a comment and
    // held only by arithmetic. Both failure directions were silent: an overflow
    // extended the array via slots[slots.length], and a leftover hole was
    // dropped by the filter. Found by walking §0 against the module, not by a
    // failing test — so this asserts the guard exists rather than the bug.
    const merged = mergeSetlist(
      setlist({ title: 'A' }, { title: 'B' }),
      rows('A', 'NEW'),
      { newId: counter(), removeMissing: false },
    ).merged;
    expect(merged).toHaveLength(3);
    expect(merged.every((s) => s && typeof s.title === 'string')).toBe(true);
    expect(positions(merged)).toEqual(dense(3));
  });

  it('7g. duplicate titles × held slots', () => {
    const existing = setlist(
      { title: 'Intro', id: 'i1' },
      { title: 'A', id: 'a' },
      { title: 'Intro', id: 'i2' },
      { title: 'B', id: 'b' },
    );
    const { merged } = merge(existing, rows({ title: 'Intro', key: 'C' }));
    expect(titles(merged)).toEqual(['Intro', 'A', 'Intro', 'B']);
    expect(merged.map((s) => s.id)).toEqual(['i1', 'a', 'i2', 'b']);
    expect(merged[0].key).toBe('C');
    expect(merged[2].key).toBeUndefined();
  });

  it('8. a title that normalizes to empty never matches anything', () => {
    const existing = setlist({ title: '???', id: 'junk' });
    const { merged, diff } = merge(existing, rows('???'));
    expect(diff.added).toHaveLength(1);
    expect(diff.missing.map((m) => m.title)).toEqual(['???']);
    expect(merged).toHaveLength(2);
  });

  it('9. round-trip: merging a setlist with its own export is an exact no-op', () => {
    const existing = setlist(
      { title: 'A', key: 'Bb', lead: 'Rachel', notes: 'n', songId: 's1', bpm: 100 },
      { title: 'B', lead: 'Graham' },
    );
    const exported: ImportedRow[] = existing.map((s) => ({
      title: s.title,
      ...(s.key ? { key: s.key } : {}),
      ...(s.lead ? { lead: s.lead } : {}),
      ...(s.notes ? { notes: s.notes } : {}),
    }));
    const { merged, diff } = merge(existing, exported);
    expect(merged).toEqual(existing);
    expect(diff.added).toHaveLength(0);
    expect(diff.missing).toHaveLength(0);
    expect(diff.reordered).toBe(false);
    expect(diff.matched.every((m) => m.changes.length === 0)).toBe(true);
  });

  it('10. a sheet BPM column never appears in the merged output', () => {
    // BPM has no persistence path from the setlist save (design §10), so an
    // imported tempo would render, then vanish on reload — a phantom write.
    const existing = setlist({ title: 'A', bpm: 90 });
    const incoming = [{ title: 'A', bpm: 200 } as unknown as ImportedRow];
    const { merged } = merge(existing, incoming);
    expect(merged[0].bpm).toBe(90);
  });

  it('does not mutate the arrays or rows it was given', () => {
    const existing = setlist({ title: 'A', key: 'Bb' }, { title: 'B' });
    const snapshot = structuredClone(existing);
    merge(existing, rows({ title: 'A', key: 'C' }, 'NEW'));
    expect(existing).toEqual(snapshot);
  });

  it('mints ids only for genuinely new rows, via the injected newId', () => {
    const existing = setlist({ title: 'A', id: 'keep' });
    const { merged } = merge(existing, rows('A', 'NEW1', 'NEW2'));
    expect(merged.map((s) => s.id)).toEqual(['keep', 'new-0', 'new-1']);
  });

  it('reports field-level changes for the preview, and none for a no-op', () => {
    const existing = setlist({ title: 'Ophelia', lead: 'Rachel' });
    const { diff } = merge(
      existing,
      rows({ title: 'Ophelia', key: 'Bb', lead: 'Rachel' }),
    );
    expect(diff.matched[0].changes).toEqual([
      { field: 'key', from: undefined, to: 'Bb' },
    ]);
  });

  it('does not report a reorder when only fields changed', () => {
    const existing = setlist({ title: 'A' }, { title: 'B' });
    const { diff } = merge(existing, rows({ title: 'A', key: 'C' }, 'B'));
    expect(diff.reordered).toBe(false);
  });

  it('does not report a reorder merely because rows were removed', () => {
    const existing = setlist({ title: 'A' }, { title: 'B' }, { title: 'C' });
    const { diff } = merge(existing, rows('A', 'C'), true);
    expect(diff.reordered).toBe(false);
  });

  it('handles an empty existing setlist as a pure add', () => {
    const { merged, diff } = merge([], rows('A', 'B'));
    expect(titles(merged)).toEqual(['A', 'B']);
    expect(positions(merged)).toEqual(dense(2));
    expect(diff.added).toHaveLength(2);
  });

  it('handles an empty sheet without destroying the setlist', () => {
    // The default path must never be destructive — invariant 1.
    const existing = setlist({ title: 'A' }, { title: 'B' });
    const { merged, diff } = merge(existing, []);
    expect(merged).toEqual(existing);
    expect(diff.missing).toHaveLength(2);
  });

  it('never persists artist, even when the sheet supplies it', () => {
    const existing = setlist({ title: 'A' });
    const { merged } = merge(existing, rows({ title: 'A', artist: 'The Band' }));
    expect(JSON.stringify(merged)).not.toContain('The Band');
  });
});
