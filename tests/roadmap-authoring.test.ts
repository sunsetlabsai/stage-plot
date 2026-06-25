import { describe, it, expect } from 'vitest';
import {
  foldDraft,
  resolveRenderKey,
  tallyDraft,
  canonicalBarPattern,
  type AuthoringDraft,
  type ChordSpan,
  type StructureOp,
} from '../lib/roadmap-authoring';
import { validateRoadmapSpec, type ChordHit, type RoadmapSection } from '../lib/roadmap-spec';

const TS = { beats: 4, unit: 4 };

// A whole-bar span of `bars` bars on a single diatonic degree.
const span = (degree: number, bars: number, extra: Partial<ChordHit> = {}): ChordSpan => ({
  bar: [{ degree, ...extra }],
  bars,
});

const draft = (sections: AuthoringDraft['sections'], renderKey = 'D'): AuthoringDraft => ({
  timeSig: TS,
  renderKey,
  sections,
});

// Re-expand a folded section by INHERITANCE (the round-trip definition, §6): walk
// bars 1..N and inherit the previous bar's pattern wherever there's no change.
// Returns a per-bar canonical-pattern key array. Deliberately NOT specToView,
// which leaves unaddressed bars null.
function reexpand(sec: RoadmapSection): string[] {
  const byBar = new Map<number, ChordHit[]>();
  for (const ch of sec.changes ?? []) byBar.set(ch.bar, ch.chords);
  const out: string[] = [];
  let prev: ChordHit[] | null = null;
  for (let i = 1; i <= sec.bars; i += 1) {
    if (byBar.has(i)) prev = byBar.get(i)!;
    out.push(JSON.stringify(prev));
  }
  return out;
}

function ok(r: ReturnType<typeof foldDraft>) {
  if (!r.ok) throw new Error(`expected ok, got errors: ${r.errors.join('; ')}`);
  return r.spec;
}

describe('foldDraft — span expansion + sparse changes', () => {
  it('Σ span.bars == section.bars', () => {
    const spec = ok(foldDraft(draft([
      { id: 'verse-1', label: 'Verse', spans: [span(1, 2), span(4, 2), span(1, 2)] },
    ])));
    expect(spec.sections[0].bars).toBe(6);
  });

  it('emits a change only where the chord changes (sparse)', () => {
    const spec = ok(foldDraft(draft([
      { id: 'v', label: 'Verse', spans: [span(1, 2), span(4, 2), span(1, 2)] },
    ])));
    const changes = spec.sections[0].changes ?? [];
    expect(changes.map((c) => c.bar)).toEqual([1, 3, 5]);
    expect(changes.map((c) => c.chords[0].degree)).toEqual([1, 4, 1]);
  });

  it('coalesces nothing across a differing bar — three separate D spans survive', () => {
    // The reported failure: D G7 D G7 D … must not collapse to a vamp.
    const spec = ok(foldDraft(draft([
      {
        id: 'v',
        label: 'Verse',
        spans: [
          span(1, 2), span(4, 2, { quality: '7' }), span(1, 2), span(4, 2, { quality: '7' }),
          span(1, 2), span(2, 2), span(4, 2), span(1, 2, { quality: 'sus2' }),
        ],
      },
    ])));
    expect(spec.sections[0].bars).toBe(16);
    // distinct change bars (every 2 bars; the 1→4→1→4→1 front does NOT merge)
    expect((spec.sections[0].changes ?? []).map((c) => c.bar)).toEqual([1, 3, 5, 7, 9, 11, 13, 15]);
  });

  it('round-trips by inheritance (incl. a sustained multi-bar span)', () => {
    const spec = ok(foldDraft(draft([
      { id: 'v', label: 'Verse', spans: [span(1, 4), span(5, 1), span(1, 3)] },
    ])));
    const sec = spec.sections[0];
    const expected = [1, 1, 1, 1, 5, 1, 1, 1].map((d) =>
      JSON.stringify(canonicalBarPattern([{ degree: d }], TS.beats)));
    expect(reexpand(sec)).toEqual(expected);
  });

  it('produces a spec that passes validateRoadmapSpec', () => {
    const spec = ok(foldDraft(draft([
      { id: 'v', label: 'Verse', spans: [span(1, 2), span(4, 2)] },
    ])));
    expect(validateRoadmapSpec(spec).ok).toBe(true);
  });
});

describe('foldDraft — split bars (BarPattern canonical equality)', () => {
  it('two adjacent identical split bars coalesce and re-expand losslessly', () => {
    // "1 - 4 5" = degree 1 for 2 beats, then 4 and 5 for 1 each (uneven → explicit beats).
    const splitBar: ChordHit[] = [
      { degree: 1, beats: 2 }, { degree: 4, beats: 1 }, { degree: 5, beats: 1 },
    ];
    const spec = ok(foldDraft(draft([
      { id: 'v', label: 'Verse', spans: [{ bar: splitBar, bars: 2 }] },
    ])));
    const sec = spec.sections[0];
    expect(sec.bars).toBe(2);
    expect((sec.changes ?? []).map((c) => c.bar)).toEqual([1]); // bar 2 inherits
    const canon = JSON.stringify(canonicalBarPattern(splitBar, TS.beats));
    expect(reexpand(sec)).toEqual([canon, canon]);
  });

  it('whole-bar and even-division patterns store with beats omitted; uneven keeps explicit beats', () => {
    expect(canonicalBarPattern([{ degree: 1 }], 4)).toEqual([{ degree: 1 }]);
    expect(canonicalBarPattern([{ degree: 1 }, { degree: 4 }], 4)).toEqual([{ degree: 1 }, { degree: 4 }]);
    expect(canonicalBarPattern([{ degree: 1, beats: 3 }, { degree: 4, beats: 1 }], 4))
      .toEqual([{ degree: 1, beats: 3 }, { degree: 4, beats: 1 }]);
  });
});

describe('foldDraft — spliceBars (pre-op positions, no drift)', () => {
  // A 10-bar verse on degree 1, used as the splice substrate.
  const tenBars = (ops?: StructureOp[]) => draft([
    { id: 'v', label: 'Verse', spans: [span(1, 10)], ops },
  ]);

  it('two splices resolve on pre-op positions and do not drift', () => {
    // Delete 1 bar at 4, and insert 2 bars at 8 — positions are pre-op, so the
    // first splice must NOT renumber the second.
    const spec = ok(foldDraft(tenBars([
      { kind: 'spliceBars', at: 4, count: 1, insert: [] },
      { kind: 'spliceBars', at: 8, count: 0, insert: [span(5, 2)] },
    ])));
    // 10 - 1 deleted + 2 inserted = 11 bars
    expect(spec.sections[0].bars).toBe(11);
  });

  it('overlapping splice ranges are an error', () => {
    const r = foldDraft(tenBars([
      { kind: 'spliceBars', at: 3, count: 3, insert: [] }, // covers 3,4,5
      { kind: 'spliceBars', at: 5, count: 1, insert: [] }, // overlaps at 5
    ]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/overlapping splice/);
  });

  it('a splice that runs past the section is an error', () => {
    const r = foldDraft(tenBars([{ kind: 'spliceBars', at: 9, count: 5, insert: [] }]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/runs past/);
  });
});

describe('foldDraft — repeat ops', () => {
  it('attaches a repeat only when an op declares one', () => {
    const plain = ok(foldDraft(draft([
      { id: 'v', label: 'Verse', spans: [span(1, 2), span(4, 2)],
        ops: [{ kind: 'repeat', repeat: { kind: 'plain', times: 2 } }] },
    ])));
    expect(plain.sections[0].repeat).toEqual({ kind: 'plain', times: 2 });

    const none = ok(foldDraft(draft([
      { id: 'v', label: 'Verse', spans: [span(1, 2), span(1, 2)] }, // repeated pattern, NO op
    ])));
    expect(none.sections[0].repeat).toBeUndefined();
  });

  it('rejects more than one repeat op on a section', () => {
    const r = foldDraft(draft([
      { id: 'v', label: 'Verse', spans: [span(1, 2)],
        ops: [
          { kind: 'repeat', repeat: { kind: 'plain', times: 2 } },
          { kind: 'repeat', repeat: { kind: 'plain', times: 3 } },
        ] },
    ]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/at most one repeat/);
  });
});

describe('foldDraft — nav splice-mapping (the part Codex flagged)', () => {
  const navAt = (bar: number): StructureOp => ({ kind: 'nav', marker: 'segno', ref: { sectionId: 'v', bar } });

  it('a surviving nav identity re-indexes through a delete', () => {
    // nav at pre-op bar 8, delete 1 bar at 4 → identity 8 now sits at bar 7
    const spec = ok(foldDraft(draft([
      { id: 'v', label: 'Verse', spans: [span(1, 10)],
        ops: [{ kind: 'spliceBars', at: 4, count: 1, insert: [] }, navAt(8)] },
    ])));
    expect(spec.navigation?.segno).toEqual({ section: 0, bar: 7 });
  });

  it('a surviving nav identity re-indexes through an insert', () => {
    // nav at pre-op bar 8, insert 2 bars at 1 → identity 8 now sits at bar 10
    const spec = ok(foldDraft(draft([
      { id: 'v', label: 'Verse', spans: [span(1, 10)],
        ops: [{ kind: 'spliceBars', at: 1, count: 0, insert: [span(5, 2)] }, navAt(8)] },
    ])));
    expect(spec.navigation?.segno).toEqual({ section: 0, bar: 10 });
  });

  it('a nav ref to a spliced-away bar drops that nav block', () => {
    // delete bars 7,8,9; nav at 8 names a deleted identity → dropped
    const spec = ok(foldDraft(draft([
      { id: 'v', label: 'Verse', spans: [span(1, 10)],
        ops: [{ kind: 'spliceBars', at: 7, count: 3, insert: [] }, navAt(8)] },
    ])));
    expect(spec.navigation).toBeUndefined();
  });

  it('two splices do not drift the nav mapping', () => {
    // delete 1 at 2, delete 1 at 6 (pre-op); nav at 8 → -2 = bar 6
    const spec = ok(foldDraft(draft([
      { id: 'v', label: 'Verse', spans: [span(1, 10)],
        ops: [
          { kind: 'spliceBars', at: 2, count: 1, insert: [] },
          { kind: 'spliceBars', at: 6, count: 1, insert: [] },
          navAt(8),
        ] },
    ])));
    expect(spec.navigation?.segno).toEqual({ section: 0, bar: 6 });
  });
});

describe('foldDraft — section ids + nav resolution', () => {
  it('rejects a draft with duplicate section ids', () => {
    const r = foldDraft(draft([
      { id: 'v', label: 'Verse', spans: [span(1, 2)] },
      { id: 'v', label: 'Verse 2', spans: [span(4, 2)] },
    ]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/duplicate section id/);
  });

  it('drops a nav block whose sectionId matches no section', () => {
    const spec = ok(foldDraft(draft([
      { id: 'v', label: 'Verse', spans: [span(1, 4)],
        ops: [{ kind: 'nav', marker: 'coda', ref: { sectionId: 'ghost', bar: 1 } }] },
    ])));
    expect(spec.navigation).toBeUndefined();
  });

  it('keeps a surviving nav ref pointing at the right section after a reorder', () => {
    // segno keyed to "chorus" by id; chorus is the 2nd section → section index 1.
    const spec = ok(foldDraft(draft([
      { id: 'verse', label: 'Verse', spans: [span(1, 4)] },
      { id: 'chorus', label: 'Chorus', spans: [span(4, 4)],
        ops: [{ kind: 'nav', marker: 'segno', ref: { sectionId: 'chorus', bar: 2 } }] },
    ])));
    expect(spec.navigation?.segno).toEqual({ section: 1, bar: 2 });
  });

  it('lowers a navJump ref through the identity map', () => {
    const spec = ok(foldDraft(draft([
      { id: 'v', label: 'Verse', spans: [span(1, 8)],
        ops: [
          { kind: 'spliceBars', at: 2, count: 1, insert: [] },
          { kind: 'navJump', at: { sectionId: 'v', bar: 5 }, from: 'capo', until: 'end' },
        ] },
    ])));
    expect(spec.navigation?.jump).toEqual({ at: { section: 0, bar: 4 }, from: 'capo', until: 'end' });
  });
});

describe('resolveRenderKey — L0 precedence (sources 1 + 3, with 2 threaded)', () => {
  it('an explicit "in D" in the description wins over the UI-selected key', () => {
    expect(resolveRenderKey('Intro in D, then a verse', 'G')).toBe('D');
  });

  it('parses "key of Bb" and "G minor" and "in Dm"', () => {
    expect(resolveRenderKey('key of Bb')).toBe('Bb');
    expect(resolveRenderKey('a ballad in G minor')).toBe('Gm');
    expect(resolveRenderKey('verse in Dm')).toBe('Dm');
  });

  it('the UI key wins when the description states none', () => {
    expect(resolveRenderKey('eight bars then a chorus', 'F#')).toBe('F#');
  });

  it('defaults to C when neither is known', () => {
    expect(resolveRenderKey('eight bars then a chorus')).toBe('C');
  });

  it('does not mistake a non-key word for a key', () => {
    // "in Bridge" — B is a note letter but "ridge" is not a key suffix → no match.
    expect(resolveRenderKey('drop in Bridge after the chorus', 'A')).toBe('A');
  });
});

describe('tallyDraft — read-back', () => {
  it('renders per-section bar totals in letters from the SpanList', () => {
    const lines = tallyDraft(draft([
      { id: 'v', label: 'Verse', spans: [span(1, 2), span(4, 2, { quality: '7' }), span(1, 2)] },
    ], 'D'));
    expect(lines).toEqual(['Verse: 6 bars — D×2, G7×2, D×2']);
  });

  it('shows a single-bar span without a ×N multiplier', () => {
    const lines = tallyDraft(draft([
      { id: 'v', label: 'Verse', spans: [span(1, 1), span(5, 1)] },
    ], 'C'));
    expect(lines).toEqual(['Verse: 2 bars — C, G']);
  });
});
