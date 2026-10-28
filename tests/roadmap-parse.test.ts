import { describe, it, expect } from 'vitest';
import { parseModelDraft, parseGrammarDraft } from '../lib/roadmap-parse';

// The model now emits an AuthoringDraft (a per-span SpanList) — NOT a RoadmapSpec.
// parseModelDraft folds it deterministically, then gates it through
// validateRoadmapSpec, and always returns the read-back tally when the draft was
// parseable. renderKey is pinned by L0 and passed IN (never chosen by the model).

// A minimal valid draft, as the model would emit it (no renderKey field).
const DRAFT = JSON.stringify({
  timeSig: { beats: 4, unit: 4 },
  sections: [{ id: 'intro', label: 'Intro', spans: [{ bar: [{ degree: 1 }], bars: 4 }] }],
});

describe('parseModelDraft — fold + validate the model SpanList', () => {
  it('folds a clean draft to a spec, applies the pinned key, returns a tally', () => {
    const r = parseModelDraft(DRAFT, 'G');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.renderKey).toBe('G');          // L0 owns the key, not the model
      expect(r.spec.sections).toHaveLength(1);
      expect(r.spec.sections[0].bars).toBe(4);
      expect(r.tally.length).toBeGreaterThan(0);
    }
  });

  it('does NOT drop bars — the failing verse (8 spans × 2) folds to 16 bars', () => {
    // D G7 D G7 D E G Dsus2, each 2 bars, in key D. The OLD one-shot parse ate
    // half of this; with explicit per-span counts the fold keeps every bar.
    const verse = JSON.stringify({
      timeSig: { beats: 4, unit: 4 },
      sections: [
        {
          id: 'verse',
          label: 'Verse',
          spans: [
            { bar: [{ degree: 1 }], bars: 2 },
            { bar: [{ degree: 4, quality: '7' }], bars: 2 },
            { bar: [{ degree: 1 }], bars: 2 },
            { bar: [{ degree: 4, quality: '7' }], bars: 2 },
            { bar: [{ degree: 1 }], bars: 2 },
            { bar: [{ degree: 2 }], bars: 2 },
            { bar: [{ degree: 4 }], bars: 2 },
            { bar: [{ degree: 1, quality: 'sus2' }], bars: 2 },
          ],
        },
      ],
    });
    const r = parseModelDraft(verse, 'D');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.sections[0].bars).toBe(16);
      expect(r.tally[0]).toMatch(/Verse: 16 bars/);
    }
  });

  it('strips a ```json fence the model may add', () => {
    const r = parseModelDraft('```json\n' + DRAFT + '\n```', 'C');
    expect(r.ok).toBe(true);
  });

  it('strips a bare ``` fence too', () => {
    const r = parseModelDraft('```\n' + DRAFT + '\n```', 'C');
    expect(r.ok).toBe(true);
  });

  it('fails closed on empty output', () => {
    const r = parseModelDraft('   ', 'C');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/empty/i);
  });

  it('fails closed on non-JSON output', () => {
    const r = parseModelDraft('Here is your roadmap! It has a verse and a chorus.', 'C');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/valid JSON/i);
  });

  it('fails closed when the JSON is not a draft object', () => {
    const r = parseModelDraft('[1,2,3]', 'C');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/draft object/i);
  });

  it('surfaces a fold-stage structural error (duplicate section id) with a tally', () => {
    const dup = JSON.stringify({
      timeSig: { beats: 4, unit: 4 },
      sections: [
        { id: 'a', label: 'A', spans: [{ bar: [{ degree: 1 }], bars: 2 }] },
        { id: 'a', label: 'A2', spans: [{ bar: [{ degree: 1 }], bars: 2 }] },
      ],
    });
    const r = parseModelDraft(dup, 'C');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.join(' ')).toMatch(/duplicate section id/i);
      expect(r.tally && r.tally.length).toBeGreaterThan(0);
    }
  });

  it('still routes through the musical gate — a folded volta-gap dies at validate', () => {
    // foldDraft attaches the repeat verbatim; validateRoadmapSpec is the one
    // place volta passes (must cover 1..max) are checked. Proves the gate runs.
    const volta = JSON.stringify({
      timeSig: { beats: 4, unit: 4 },
      sections: [
        {
          id: 'chorus',
          label: 'Chorus',
          spans: [{ bar: [{ degree: 1 }], bars: 8 }],
          ops: [
            {
              kind: 'repeat',
              repeat: {
                kind: 'volta',
                endings: [
                  { bars: { start: 7, count: 1 }, passes: [1] },
                  { bars: { start: 8, count: 1 }, passes: [3] },
                ],
              },
            },
          ],
        },
      ],
    });
    const r = parseModelDraft(volta, 'C');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => /cover 1\.\.|missing 2/i.test(e))).toBe(true);
      expect(r.tally && r.tally.length).toBeGreaterThan(0);
    }
  });

  it('pins the passed renderKey onto the folded spec', () => {
    const r = parseModelDraft(DRAFT, 'Bb');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.renderKey).toBe('Bb');
  });
});

// parseGrammarDraft is the L1 transport gate: a description that the deterministic
// span-grammar transcribes whole → a folded+validated spec (NO model call); else
// null so the route falls to L2 (parseWithModel). It shares foldAndValidateDraft with the
// model path, so a grammar hit disposes identically.
describe('parseGrammarDraft — L1 deterministic path (skips the model)', () => {
  it('folds + validates the failing verse to 16 bars with the pinned key', () => {
    const r = parseGrammarDraft(
      'Verse: 2 bars D, 2 bars G7, 2 bars D, 2 bars G7, 2 bars D, 2 bars E, 2 bars G, 2 bars Dsus2',
      'D',
    );
    expect(r).not.toBeNull();
    if (r) {
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.spec.renderKey).toBe('D');
        expect(r.spec.sections[0].bars).toBe(16);
        expect(r.tally[0]).toMatch(/Verse: 16 bars/);
      }
    }
  });

  it('returns null for non-grammar prose (the model fallback handles it)', () => {
    expect(parseGrammarDraft('drop one bar of G and add a Bm7/Em/A tag', 'D')).toBeNull();
  });

  it('canonicalizes a chromatic root (C in D → ♭7) and folds+validates it', () => {
    const r = parseGrammarDraft('Verse: 2 bars D, 2 bars C', 'D');
    expect(r).not.toBeNull();
    if (r) {
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.spec.sections[0].bars).toBe(4);
    }
  });

  it('still returns null on a chromatic slash bass (root-only canonicalization)', () => {
    expect(parseGrammarDraft('Verse: 2 bars E/Eb', 'D')).toBeNull();
  });
  // UAT S14: number notation makes "4/4" a legal chord (IV over 4), so a leading
  // time signature was read as a bogus first bar, C/C in G.
  describe('a stated time signature is a time signature, not a bar (UAT S14)', () => {
    const only = (text: string) => {
      const r = parseGrammarDraft(text, 'G');
      if (!r || !r.ok) throw new Error(`no grammar hit for ${JSON.stringify(text)}`);
      return r.spec;
    };

    it('the reported repro: "4/4 in G, 4 bars G" is 4 bars of G in 4/4', () => {
      const spec = only('4/4 in G, 4 bars G');
      expect(spec.timeSig).toEqual({ beats: 4, unit: 4 });
      expect(spec.sections[0].bars).toBe(4);
      expect(spec.sections[0].changes).toEqual([{ bar: 1, chords: [{ degree: 1 }] }]);
    });

    it.each([
      ['3/4, 4 bars G', { beats: 3, unit: 4 }],
      ['6/8\nVerse: 4 bars G', { beats: 6, unit: 8 }],
      ['12/8 time, 4 bars G', { beats: 12, unit: 8 }],
      ['4 bars G in 3/4', { beats: 3, unit: 4 }],
      ['Verse: 4 bars G. 7/8 time', { beats: 7, unit: 8 }],
    ])('%j → %j, and the bars are untouched', (text, timeSig) => {
      const spec = only(text);
      expect(spec.timeSig).toEqual(timeSig);
      expect(spec.sections[0].bars).toBe(4);
    });

    it('a slash number chord mid-clause stays a chord (controls)', () => {
      // Same digits as a time signature, but in a span: IV over 4 is still a chord.
      const spec = only('Verse: 2 bars 1, 2 bars 4/4');
      expect(spec.timeSig).toEqual({ beats: 4, unit: 4 });
      expect(spec.sections[0].bars).toBe(4);
      expect(spec.sections[0].changes?.[1]).toEqual({ bar: 3, chords: [{ degree: 4, bass: 4 }] });
      // A leading one that is part of a span ("for 2 bars") is a chord too.
      expect(only('1/4 for 2 bars, 2 bars G').sections[0].changes?.[0]).toEqual({ bar: 1, chords: [{ degree: 1, bass: 4 }] });
    });

    // Codex R1 on #199: ordinary phrasings the first cut missed, each of which
    // parsed in 4/4 with a bogus slash-chord bar and returned before L2 could fix it.
    it.each([
      ['Time signature: 3/4, Verse: 4 bars G', { beats: 3, unit: 4 }],
      ['Time signature: 3/4. Verse: 4 bars G', { beats: 3, unit: 4 }],
      ['in G, 3/4, 4 bars G', { beats: 3, unit: 4 }],
      ['Meter: 6/8. 4 bars G', { beats: 6, unit: 8 }],
      ['Time: 7/8\nVerse: 4 bars G', { beats: 7, unit: 8 }],
    ])('labelled or after the key: %j → %j, 4 bars, no extra bar', (text, timeSig) => {
      const spec = only(text);
      expect(spec.timeSig).toEqual(timeSig);
      expect(spec.sections).toHaveLength(1);
      expect(spec.sections[0].bars).toBe(4);
    });

    it('a bare N/D anywhere else is ambiguous (chord or time signature) → defers to L2, never a guess', () => {
      expect(parseGrammarDraft('Verse: 1, 4, 3/4, 5', 'G')).toBeNull();
      expect(parseGrammarDraft('4 bars G, 3/4, 4 bars C', 'G')).toBeNull();
    });

    it('with no time signature stated, the default 4/4 is unchanged', () => {
      expect(only('in G, 4 bars G').timeSig).toEqual({ beats: 4, unit: 4 });
    });
  });
});

// ── The model is offered exactly the validator's vocabulary (#204) ───────────
describe('SYSTEM_PROMPT quality vocabulary', () => {
  it('★ lists every whitelisted quality, including 7sus2 / 7sus4', async () => {
    const { SYSTEM_PROMPT } = await import('../lib/roadmap-parse');
    const { QUALITY_WHITELIST } = await import('../lib/roadmap-spec');
    const m = SYSTEM_PROMPT.match(/"quality"\?: <one of ([^>]*)>/);
    expect(m).not.toBeNull();
    const offered = JSON.parse(`[${m![1]}]`) as string[];
    expect(new Set(offered)).toEqual(new Set(QUALITY_WHITELIST));
    expect(offered).toContain('7sus2');
    expect(offered).toContain('7sus4');
  });
});
