import { describe, it, expect } from 'vitest';
import {
  foldDraft,
  resolveRenderKey,
  tallyDraft,
  canonicalBarPattern,
  parseDescription,
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

  it('rejects two ops declaring the same nav marker (would silently collapse on lower)', () => {
    const r = foldDraft(draft([
      { id: 'v', label: 'Verse', spans: [span(1, 8)],
        ops: [
          { kind: 'nav', marker: 'segno', ref: { sectionId: 'v', bar: 2 } },
          { kind: 'nav', marker: 'segno', ref: { sectionId: 'v', bar: 6 } },
        ] },
    ]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/conflicting navigation.*segno/);
  });

  it('rejects two navJump ops', () => {
    const r = foldDraft(draft([
      { id: 'v', label: 'Verse', spans: [span(1, 8)],
        ops: [
          { kind: 'navJump', at: { sectionId: 'v', bar: 2 }, from: 'capo', until: 'end' },
          { kind: 'navJump', at: { sectionId: 'v', bar: 5 }, from: 'capo', until: 'end' },
        ] },
    ]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/conflicting navigation.*navJump/);
  });

  it('reports the conflict even when one duplicate ref would have dropped', () => {
    // one coda resolves, the other names a ghost section — still a declared conflict
    const r = foldDraft(draft([
      { id: 'v', label: 'Verse', spans: [span(1, 8)],
        ops: [
          { kind: 'nav', marker: 'coda', ref: { sectionId: 'v', bar: 4 } },
          { kind: 'nav', marker: 'coda', ref: { sectionId: 'ghost', bar: 1 } },
        ] },
    ]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/conflicting navigation.*coda/);
  });

  it('allows distinct nav markers together', () => {
    const spec = ok(foldDraft(draft([
      { id: 'v', label: 'Verse', spans: [span(1, 8)],
        ops: [
          { kind: 'nav', marker: 'segno', ref: { sectionId: 'v', bar: 2 } },
          { kind: 'nav', marker: 'coda', ref: { sectionId: 'v', bar: 6 } },
        ] },
    ])));
    expect(spec.navigation?.segno).toEqual({ section: 0, bar: 2 });
    expect(spec.navigation?.coda).toEqual({ section: 0, bar: 6 });
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

describe('parseDescription — L1 deterministic span-grammar', () => {
  function hit(desc: string, key = 'D'): AuthoringDraft {
    const d = parseDescription(desc, key);
    if (!d) throw new Error(`expected a grammar hit for: ${desc}`);
    return d;
  }

  it('parses the failing verse to 8 spans / 16 bars — never a collapsed vamp', () => {
    const d = hit('Verse: 2 bars D, 2 bars G7, 2 bars D, 2 bars G7, 2 bars D, 2 bars E, 2 bars G, 2 bars Dsus2');
    expect(d.sections).toHaveLength(1);
    const v = d.sections[0];
    expect(v.label).toBe('Verse');
    expect(v.spans).toHaveLength(8);
    expect(v.spans.reduce((n, s) => n + s.bars, 0)).toBe(16);
    // In key D: D=1, G7=4/7, E=2, G=4, Dsus2=1sus2.
    expect(v.spans.map((s) => s.bar)).toEqual([
      [{ degree: 1 }], [{ degree: 4, quality: '7' }], [{ degree: 1 }], [{ degree: 4, quality: '7' }],
      [{ degree: 1 }], [{ degree: 2 }], [{ degree: 4 }], [{ degree: 1, quality: 'sus2' }],
    ]);
  });

  it('folds + validates the failing verse to 16 bars (the headline no-drop guarantee)', () => {
    const spec = ok(foldDraft(hit('Verse: 2 bars D, 2 bars G7, 2 bars D, 2 bars G7, 2 bars D, 2 bars E, 2 bars G, 2 bars Dsus2')));
    expect(spec.sections[0].bars).toBe(16);
    expect(validateRoadmapSpec(spec).ok).toBe(true);
  });

  it('a bare comma list = 1 bar per chord — five spans, not a collapsed vamp', () => {
    const d = hit('D, G7, D, G7, D');
    expect(d.sections[0].spans).toHaveLength(5);
    expect(d.sections[0].spans.every((s) => s.bars === 1)).toBe(true);
  });

  it('DEFERS an ambiguous whitespace chord list — never guesses split-bar vs N-bars (Codex R1)', () => {
    // "D G7 D G7" has no comma/period AND no "-" tie: a single even-split bar or
    // four 1-bar spans? L1 must NOT guess (parseBarInput would read it as one bar) —
    // it defers the whole description to L2.
    expect(parseDescription('Verse: D G7 D G7', 'D')).toBeNull();
    expect(parseDescription('2 bars D G7', 'D')).toBeNull();
  });

  it('ACCEPTS an explicitly tied split bar (the "-" signal is unambiguous, one bar)', () => {
    const d = hit('1 - 4 5'); // 1 (2 beats) | 4 | 5 — clearly ONE bar
    expect(d.sections[0].spans).toHaveLength(1);
    expect(d.sections[0].spans[0].bars).toBe(1);
    expect(d.sections[0].spans[0].bar).toHaveLength(3);
  });

  it('accepts all three count forms', () => {
    expect(hit('4 bars D').sections[0].spans[0]).toEqual({ bar: [{ degree: 1 }], bars: 4 });
    expect(hit('4 bars of D').sections[0].spans[0]).toEqual({ bar: [{ degree: 1 }], bars: 4 });
    expect(hit('D for 4 bars').sections[0].spans[0]).toEqual({ bar: [{ degree: 1 }], bars: 4 });
    expect(hit('1 bar D').sections[0].spans[0]).toEqual({ bar: [{ degree: 1 }], bars: 1 });
  });

  it('splits multiple labelled sections (inline, comma-bounded header)', () => {
    const d = hit('Verse: 2 bars D, 2 bars G7. Chorus: 4 bars A');
    expect(d.sections.map((s) => s.label)).toEqual(['Verse', 'Chorus']);
    expect(d.sections[0].spans).toHaveLength(2);
    expect(d.sections[1].spans).toEqual([{ bar: [{ degree: 5 }], bars: 4 }]); // A = 5 of D
  });

  it('dedupes repeated labels into unique stable ids', () => {
    const d = hit('Verse: 2 bars D. Verse: 2 bars G7');
    expect(d.sections.map((s) => s.id)).toEqual(['verse', 'verse-2']);
  });

  it('an unlabelled description folds into one default section', () => {
    const d = hit('2 bars D, 2 bars G7');
    expect(d.sections).toHaveLength(1);
    expect(d.sections[0].label).toBe('Section');
  });

  it('strips a leading key statement so it is not mistaken for span prose', () => {
    const d = hit('In D. Verse: 2 bars D, 2 bars G7');
    expect(d.sections.map((s) => s.label)).toEqual(['Verse']);
    expect(d.sections[0].spans).toHaveLength(2);
  });

  it('parses split-bar patterns through the same tie grammar (1 - 4 5)', () => {
    const d = hit('2 bars 1 - 4 5');
    // Uneven split (2,1,1) → canonical all-or-none explicit beats.
    expect(d.sections[0].spans[0]).toEqual({
      bar: [{ degree: 1, beats: 2 }, { degree: 4, beats: 1 }, { degree: 5, beats: 1 }],
      bars: 2,
    });
  });

  it('the key decides letter degrees (A in D = 5, A in G = 2)', () => {
    expect(hit('4 bars A', 'D').sections[0].spans[0].bar).toEqual([{ degree: 5 }]);
    expect(hit('4 bars A', 'G').sections[0].spans[0].bar).toEqual([{ degree: 2 }]);
  });

  it('canonicalizes a chromatic root in the grammar (C in D → ♭7), never rounding it', () => {
    // C is ♭7 in D; Gap-1 spells it {degree:7, alter:-1} (prefer-flat-upper-neighbor).
    const d = hit('Verse: 2 bars D, 2 bars C', 'D');
    expect(d.sections[0].spans[1].bar).toEqual([{ degree: 7, alter: -1 }]);
  });

  it('still defers a chromatic SLASH BASS to L2 (root-only canonicalization for v1)', () => {
    expect(parseDescription('Verse: 2 bars E/Eb', 'D')).toBeNull();
  });

  it('returns null for non-grammar prose (falls through to L2)', () => {
    expect(parseDescription('drop one bar of G and add a tag', 'D')).toBeNull();
    expect(parseDescription('the verse is kind of bluesy', 'D')).toBeNull();
  });

  it('returns null when content precedes the first header (never silently dropped)', () => {
    // "4 bars D" sits before the Verse header (a "." boundary) — we won't guess it
    // is its own section, so the whole description defers to L2.
    expect(parseDescription('4 bars D. Verse: 2 bars G7', 'D')).toBeNull();
  });

  it('returns null on empty / whitespace input', () => {
    expect(parseDescription('   ', 'D')).toBeNull();
  });
});

// ── L0 key resolution: spelled accidentals + the Review-toolbar override ─────
// Both fixes come from the same UAT report: a chart of "9 to 5" that is in F# was
// authored in F, and neither the prose nor the toolbar could say otherwise.
describe('resolveRenderKey — spelled accidentals', () => {
  it('reads a spelled sharp/flat, not just the symbol', () => {
    expect(resolveRenderKey('9 to 5, in F sharp. 4-bar intro.')).toBe('F#');
    expect(resolveRenderKey('key of B flat, medium swing')).toBe('Bb');
    expect(resolveRenderKey('in F Sharp minor')).toBe('F#m');
    expect(resolveRenderKey('E flat major throughout')).toBe('Eb');
  });

  it('still reads the symbol forms, fused or unicode', () => {
    expect(resolveRenderKey('in F#')).toBe('F#');
    expect(resolveRenderKey('key of Bb')).toBe('Bb');
    expect(resolveRenderKey('in F♯')).toBe('F#');
    expect(resolveRenderKey('in E♭ minor')).toBe('Ebm');
  });

  it('does NOT swallow a following word that merely starts with b or a sharp/flat lookalike', () => {
    // The reason the symbol and spelled forms are separate alternatives: allowing
    // whitespace before a bare `b` turns "in B bars" into Bb.
    expect(resolveRenderKey('in B bars of four')).toBe('B');
    expect(resolveRenderKey('in D flatten the 7th')).toBe('D');
  });

  it('the old silent misparses are gone — neither "in F sharp" nor "in F#" resolves to F', () => {
    expect(resolveRenderKey('in F sharp')).not.toBe('F');
    expect(resolveRenderKey('in F#')).not.toBe('F');
  });

  it('keeps a sharp that ENDS the phrase — the pre-existing backtrack bug', () => {
    // Found while testing the spelled-accidental fix, and present in main all along:
    // the trailing \\b could not match after `#` at end-of-input, so the regex
    // backtracked to the shorter "in F" and dropped the sharp. Only sharps, and only
    // at the end of the phrase — `b` is a word char so flats always worked, and a
    // following mode word restored the boundary. A semitone, lost in silence.
    expect(resolveRenderKey('in F#')).toBe('F#');
    expect(resolveRenderKey('key of F#')).toBe('F#');
    expect(resolveRenderKey('in C#m')).toBe('C#m');
    // The cases that always worked, pinned so a future fix can't trade one for the other.
    expect(resolveRenderKey('in F# major')).toBe('F#');
    expect(resolveRenderKey('in Bb')).toBe('Bb');
  });

  it('does NOT read a CHORD as a key — a digit may not end the key statement', () => {
    // The first pass at the sharp fix used `(?![A-Za-z])`, which let a digit terminate
    // the match, so chord prose pinned L0: "in Am7" -> Am, "in F2" -> F, "in Bb2" -> Bb.
    // `\\b` had rejected these by accident; `(?!\\w)` rejects them on purpose.
    // The uiKey must survive untouched in every one of them.
    expect(resolveRenderKey('verse in Am7, chorus in Dm7', 'G')).toBe('G');
    expect(resolveRenderKey('vamp in F2', 'G')).toBe('G');
    expect(resolveRenderKey('riff in Bb2', 'G')).toBe('G');
    expect(resolveRenderKey('turnaround in G7', 'D')).toBe('D');
    // With no uiKey they must fall to the C default, not to a phantom key.
    expect(resolveRenderKey('verse in Am7')).toBe('C');
  });

  it('does NOT drop an accidental symbol to make a shorter match succeed', () => {
    // Same shape as the F# backtrack, reached from the other side and present in main:
    // `#` is not a word character, so a lookahead naming only `\\w` (and `\\b` before it)
    // is happy to end the match at "C" with the `#` still sitting there — "in C#m7"
    // resolved to C. A semitone out, silently, again.
    expect(resolveRenderKey('in C#m7', 'A')).toBe('A');
    expect(resolveRenderKey('in E♭9', 'G')).toBe('G');
    // NOT "vamp on F#7" — Codex R2 caught that one passing for the wrong reason:
    // "on" is not a key keyword, so it never reached the guard at all. Use the "in"
    // form so the assertion can only pass if the accidental-drop guard is doing it.
    expect(resolveRenderKey('in F#7', 'G')).toBe('G');
    // Positive control for the line above: the same prefix WITHOUT the trailing digit
    // must still resolve, so this pair fails if the guard ever over-rejects.
    expect(resolveRenderKey('in F#', 'G')).toBe('F#');
  });

  it('reads a spelled accidental after ANY dash, not just the ASCII hyphen', () => {
    // Smart punctuation makes en/em dashes routine — anything that retypes a hyphen
    // produces one — so they must separate a key token exactly as the hyphen does.
    expect(resolveRenderKey('in F-sharp', 'G')).toBe('F#');
    expect(resolveRenderKey('in F–sharp', 'G')).toBe('F#');   // en dash
    expect(resolveRenderKey('in F—sharp', 'G')).toBe('F#');   // em dash
    expect(resolveRenderKey('key of B–flat', 'G')).toBe('Bb');
    expect(resolveRenderKey('in F-sharp minor', 'G')).toBe('F#m');
    expect(resolveRenderKey('in D-major', 'G')).toBe('D');
    expect(resolveRenderKey('in D-minor', 'G')).toBe('Dm');
  });

  it('fails CLOSED on a token continuation rather than resolving the bare note', () => {
    // The one signature every round of this bug shared: the author wrote a longer key
    // token and the engine accepted a shorter one. Falling back to the uiKey is visible
    // and correctable; a confidently-printed wrong key is not.
    expect(resolveRenderKey('in G-string', 'A')).toBe('A');
    expect(resolveRenderKey('in G–string', 'A')).toBe('A');
    expect(resolveRenderKey('in D-ish somewhere', 'A')).toBe('A');
    expect(resolveRenderKey('in Bb-based riff', 'A')).toBe('A');
    expect(resolveRenderKey('in F.sharp', 'G')).toBe('G');          // dot is not a separator
    expect(resolveRenderKey("in G's register", 'A')).toBe('A');     // possessive, not a key
    expect(resolveRenderKey('in G’s register', 'A')).toBe('A');
    expect(resolveRenderKey('in D/F#', 'G')).toBe('G');             // a chord, not a key
  });

  it('still parses every real ENDING — the whitelist must not cost the true forms', () => {
    expect(resolveRenderKey('in F#')).toBe('F#');
    expect(resolveRenderKey('in F#, medium swing')).toBe('F#');
    expect(resolveRenderKey('in Bb. 8-bar verse.')).toBe('Bb');     // sentence period
    expect(resolveRenderKey('in Dm, then the bridge')).toBe('Dm');
    expect(resolveRenderKey('in F sharp')).toBe('F#');
    expect(resolveRenderKey('(in F#) medium swing')).toBe('F#');
    expect(resolveRenderKey('in F#; then the bridge')).toBe('F#');
    expect(resolveRenderKey('tempo 120\nin F#\n8-bar verse')).toBe('F#');
    expect(resolveRenderKey('in D / 8-bar verse', 'G')).toBe('D');  // space, not the slash
    // Prose hyphens well clear of the key are untouched.
    expect(resolveRenderKey('bars 1-4 in D', 'G')).toBe('D');
    expect(resolveRenderKey('8-bar verse, in F#', 'G')).toBe('F#');
  });

  // ★ The test that exists so there is no round five.
  //
  // Five times this was fixed by naming one more character that must not follow a key,
  // and five times review or UAT found the next one — because "characters that may not
  // follow a key" is the whole of Unicode minus a few, discoverable only one bug report
  // at a time. END is now a WHITELIST, which is closed, so it can be asserted by
  // EXHAUSTION instead of by the cases someone happened to imagine.
  it('sweeps every BMP punctuation/space codepoint: the terminator set is exactly the whitelist', () => {
    const EXPECTED = new Set([...',;:!?)]}"”']);
    const shortens: string[] = [];
    const leaks: string[] = [];
    let swept = 0;

    for (let cp = 0x20; cp <= 0xffff; cp += 1) {
      const c = String.fromCharCode(cp);
      if (/\w/.test(c)) continue;                    // a word char cannot be a separator
      if (!/[\p{P}\p{S}\p{Z}]/u.test(c)) continue;   // punctuation, symbols, separators
      swept += 1;
      const allowed = /\s/.test(c) || EXPECTED.has(c); // whitespace is a boundary by definition
      const code = `U+${cp.toString(16).padStart(4, '0')}`;

      // Does this character end a key statement, letting "in F<c>sharp" resolve to F?
      if (resolveRenderKey(`in F${c}sharp`, 'G') === 'F') {
        shortens.push(c);
        if (!allowed) leaks.push(`${code} in F${c}sharp -> F`);
      }
      // A non-terminator must never yield the bare note by any route.
      if (!allowed) {
        if (resolveRenderKey(`in G${c}string`, 'A') === 'G') leaks.push(`${code} in G${c}string -> G`);
        if (resolveRenderKey(`key of B${c}flat`, 'G') === 'B') leaks.push(`${code} key of B${c}flat -> B`);
      }
      // Whitespace can't be policed by the `in F<c>sharp` probe above: "in F sharp"
      // forms the SPELLED accidental (F#), so that probe never exercises a space AS a
      // terminator. Prove it directly with a non-accidental follower — every swept
      // whitespace char must end the note at F. (Codex R4 #2: the equality claim
      // overstated the whitespace direction; this makes it measured, not assumed.)
      if (/\s/.test(c) && resolveRenderKey(`in F${c}verse`, 'G') !== 'F') {
        leaks.push(`${code} whitespace did not terminate: in F${c}verse`);
      }
    }

    expect(swept).toBeGreaterThan(4000);            // the sweep actually swept
    expect(leaks).toEqual([]);                      // nothing outside the whitelist shortens
    // ...and the reverse: every intended terminator still works, so a future tightening
    // can't silently stop a stated key from resolving at all.
    const nonWs = shortens.filter((c) => !/\s/.test(c)).sort();
    expect(new Set(nonWs)).toEqual(EXPECTED);
  });

  // A sweep that cannot fail is the "green for the wrong reason" trap wearing a costume
  // (Codex R2 caught exactly that in an earlier version of these tests). This pins that
  // the sweep's own probe strings DO catch a grammar known to be broken: the pre-fix
  // blacklist accepted an en dash, so the probe string must expose it.
  it('the sweep is capable of failing — positive control on the old blacklist grammar', () => {
    const OLD = /(?:[Kk]ey of|\b[Ii]n)\s+([A-G])(?:(#|♯|b|♭)|[\s-]+([Ss]harp|[Ff]lat)\b)?(m)?(?:[\s-]+(minor|min|major|maj))?(?![\w#♯♭-])/;
    for (const sep of ['–', '—', '.', "'"]) {
      const m = `in F${sep}sharp`.match(OLD);
      expect(m?.[1]).toBe('F');        // the old grammar really did shorten here
      expect(m?.[3]).toBeUndefined();  // and really did drop the spelled accidental
    }
    // The shipped grammar must disagree with the old one on every one of them.
    for (const sep of ['–', '—']) expect(resolveRenderKey(`in F${sep}sharp`, 'G')).toBe('F#');
    for (const sep of ['.', "'"]) expect(resolveRenderKey(`in F${sep}sharp`, 'G')).toBe('G');
  });
});

describe('resolveRenderKey — precedence', () => {
  it('a stated key outranks the Compose hint (the §4.1 default, unchanged)', () => {
    expect(resolveRenderKey('in F. 8-bar verse.', 'F#')).toBe('F');
  });

  it('the Compose hint is used when the prose states no key', () => {
    expect(resolveRenderKey('8-bar verse, 8-bar chorus.', 'F#')).toBe('F#');
  });

  it('an OVERRIDE outranks a stated key — the Review toolbar', () => {
    expect(resolveRenderKey('in F. 8-bar verse.', 'F#', { override: true })).toBe('F#');
  });

  it('an override falls back to the stated key when the override value is junk', () => {
    // Fail safe: an unusable override must not silently become C.
    expect(resolveRenderKey('in F. 8-bar verse.', 'H', { override: true })).toBe('F');
    expect(resolveRenderKey('8-bar verse.', '', { override: true })).toBe('C');
  });
});
