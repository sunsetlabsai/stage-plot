import { describe, it, expect } from 'vitest';
import { nnsSegments, normalizeQualityInput } from '../lib/nns-quality';
import { QUALITY_WHITELIST } from '../lib/roadmap-spec';
import { parseBarInput, parseLetterChord } from '../lib/roadmap-view';

// ── NNS display (backlog #204, ruled 2026-10-27) ─────────────────────────────
// Nashville convention, display only: 5⁷ · 1△⁷ · 2– · 7° · 7ø⁷. A dominant 7 used to
// print as "57", which reads as fifty-seven. Input stays plain text.

const show = (degree: number, quality: string, bass?: number) =>
  nnsSegments({ degree, quality, bass })
    .map((s) => (s.kind === 'triangle' ? '△' : s.size === 'sup' ? `^${s.text}` : s.text))
    .join('');

describe('nnsSegments', () => {
  it('★ a dominant 7 is a raised 7, never "57" at one size', () => {
    expect(show(5, '7')).toBe('5^7');
  });

  it('follows the NNS symbols', () => {
    expect(show(1, '')).toBe('1');
    expect(show(2, 'm')).toBe('2–');
    expect(show(2, 'm7')).toBe('2–^7');
    expect(show(1, 'maj7')).toBe('1△^7');
    expect(show(7, 'dim')).toBe('7°');
    expect(show(7, 'dim7')).toBe('7°^7');
    expect(show(7, 'm7b5')).toBe('7ø^7');
    expect(show(5, 'aug')).toBe('5+');
    expect(show(4, 'sus4')).toBe('4^sus4');
    expect(show(5, '7sus4')).toBe('5^7sus4');
    expect(show(6, '6')).toBe('6^6');
    expect(show(2, 'm6')).toBe('2–^6');
  });

  it('keeps the slash bass at full size after the quality', () => {
    expect(show(5, '7', 7)).toBe('5^7/7');
  });

  it('★ every whitelisted quality has a defined rendering (none falls through raw)', () => {
    for (const q of QUALITY_WHITELIST) {
      const segs = nnsSegments({ degree: 1, quality: q });
      const main = segs.filter((s) => s.kind === 'text' && s.size === 'main').map((s) => (s as { text: string }).text).join('');
      // Nothing but the degree, a dash, or a single symbol rides at full size.
      expect(main).toMatch(/^1(–|°|ø|\+)?$/);
    }
  });
});

describe('normalizeQualityInput — optional typed/pasted symbols', () => {
  it('maps the symbols onto the canonical qualities', () => {
    expect(normalizeQualityInput('△')).toBe('maj7');
    expect(normalizeQualityInput('△7')).toBe('maj7');
    expect(normalizeQualityInput('Δ7')).toBe('maj7');
    expect(normalizeQualityInput('°')).toBe('dim');
    expect(normalizeQualityInput('°7')).toBe('dim7');
    expect(normalizeQualityInput('ø')).toBe('m7b5');
    expect(normalizeQualityInput('ø7')).toBe('m7b5');
    expect(normalizeQualityInput('-')).toBe('m');
    expect(normalizeQualityInput('-7')).toBe('m7');
    expect(normalizeQualityInput('–6')).toBe('m6');
    expect(normalizeQualityInput('−7b5')).toBe('m7b5');
    expect(normalizeQualityInput('+')).toBe('aug');
  });
  it('leaves plain-text qualities alone', () => {
    for (const q of QUALITY_WHITELIST) expect(normalizeQualityInput(q)).toBe(q);
  });
});

describe('the bar grammar accepts the symbols', () => {
  const q = (raw: string) => {
    const r = parseBarInput(raw, 4);
    return r.ok ? r.cells.map((c) => c.quality) : r.error;
  };
  it('★ "2-" is a minor 2, typed the Nashville way', () => {
    expect(q('2-')).toEqual(['m']);
    expect(q('2-7')).toEqual(['m7']);
    expect(q('1△7')).toEqual(['maj7']);
    expect(q('7ø')).toEqual(['m7b5']);
    expect(q('7°')).toEqual(['dim']);
  });
  it('★ a standalone "-" is still a tie', () => {
    const r = parseBarInput('1 - - 4', 4);
    expect(r.ok && r.cells.map((c) => [c.degree, c.beats])).toEqual([[1, 3], [4, 1]]);
  });
  it('letters take the symbols too (B-7 in D)', () => {
    expect(parseLetterChord('B-7', 'D')).toEqual({ degree: 6, quality: 'm7' });
    expect(parseLetterChord('C#ø', 'D')).toEqual({ degree: 7, quality: 'm7b5' });
  });
});
