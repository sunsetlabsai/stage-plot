import { describe, it, expect } from 'vitest';
import { parseModelSpec } from '../lib/roadmap-parse';

// A minimal valid spec, as the model would emit it (compact JSON string).
const VALID = JSON.stringify({
  version: 1,
  timeSig: { beats: 4, unit: 4 },
  renderKey: 'G',
  sections: [{ id: 'intro', label: 'Intro', bars: 4 }],
});

describe('parseModelSpec — validator-gated parse of model output', () => {
  it('accepts a clean JSON spec and narrows it', () => {
    const r = parseModelSpec(VALID);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.renderKey).toBe('G');
      expect(r.spec.sections).toHaveLength(1);
    }
  });

  it('strips a ```json fence the model may add', () => {
    const fenced = '```json\n' + VALID + '\n```';
    const r = parseModelSpec(fenced);
    expect(r.ok).toBe(true);
  });

  it('strips a bare ``` fence too', () => {
    const r = parseModelSpec('```\n' + VALID + '\n```');
    expect(r.ok).toBe(true);
  });

  it('fails closed on empty output', () => {
    const r = parseModelSpec('   ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/empty/i);
  });

  it('fails closed on non-JSON output', () => {
    const r = parseModelSpec('Here is your roadmap! It has a verse and a chorus.');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/valid JSON/i);
  });

  it('fails closed when the JSON is not an object', () => {
    const r = parseModelSpec('42');
    expect(r.ok).toBe(false);
  });

  it('routes structurally-valid-but-wrong-version JSON through the validator', () => {
    const v2 = JSON.stringify({
      version: 2,
      timeSig: { beats: 4, unit: 4 },
      renderKey: 'G',
      sections: [{ id: 'intro', label: 'Intro', bars: 4 }],
    });
    const r = parseModelSpec(v2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/version/i);
  });

  it('catches a musically-invalid spec the model could hallucinate (volta pass gap)', () => {
    // Endings cover passes [1] and [3]; pass 2 is missing — the validator rejects
    // it, proving the FULL musical gate runs on model output, not just shape.
    const bad = JSON.stringify({
      version: 1,
      timeSig: { beats: 4, unit: 4 },
      renderKey: 'C',
      sections: [
        {
          id: 'chorus',
          label: 'Chorus',
          bars: 8,
          repeat: {
            kind: 'volta',
            endings: [
              { bars: { start: 7, count: 1 }, passes: [1] },
              { bars: { start: 8, count: 1 }, passes: [3] },
            ],
          },
        },
      ],
    });
    const r = parseModelSpec(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /cover 1\.\.|missing 2/i.test(e))).toBe(true);
  });

  it('returns every validator error at once (model gets a full repair list)', () => {
    const bad = JSON.stringify({
      version: 1,
      timeSig: { beats: 4, unit: 4 },
      renderKey: 'H', // invalid key
      sections: [{ id: 'x', label: 'X', bars: 0 }], // bars < 1
    });
    const r = parseModelSpec(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });
});
