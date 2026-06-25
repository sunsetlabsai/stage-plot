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
// null so parseRoadmapSpec falls to L2. It shares foldAndValidateDraft with the
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

  it('returns null on a chromatic chord so L2 / Gap-1 can take it', () => {
    expect(parseGrammarDraft('Verse: 2 bars D, 2 bars C', 'D')).toBeNull();
  });
});
