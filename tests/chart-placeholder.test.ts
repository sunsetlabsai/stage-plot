import { describe, it, expect } from 'vitest';
import { isPlaceholderCounts, countPdfContent, chordTokens } from '../lib/chart-placeholder';

// ── Placeholder PDFs are not charts (backlog #204, Graham 2026-10-27) ────────
// A title-and-key page ("Love Shack / C") is a stand-in for a chart that was never
// uploaded. Measured on the 87-chart corpus: each of the 17 placeholders inks exactly one
// filled box (4 segments) beside 2–7 words; no real chart comes close.

describe('isPlaceholderCounts', () => {
  it('★ a title + key page is a placeholder', () => {
    expect(isPlaceholderCounts({ words: 3, segments: 4, images: 0, chords: 1 })).toBe(true);
    expect(isPlaceholderCounts({ words: 7, segments: 4, images: 0, chords: 1 })).toBe(true);
  });
  it('★ the smallest real chart in the corpus is not', () => {
    expect(isPlaceholderCounts({ words: 92, segments: 91, images: 0, chords: 8 })).toBe(false);
  });
  it('a scan is not a placeholder — it is a chart we cannot read as vectors', () => {
    expect(isPlaceholderCounts({ words: 0, segments: 0, images: 1, chords: 0 })).toBe(false);
  });
  // Codex R1 (#207): a one-page chart — title, one four-bar staff, chords A D E A — had 6
  // words and ONE constructPath op, because pdf.js packs a whole drawing into one op. It
  // inks 5 staff lines + 5 barlines = 10 segments.
  it('★ a tiny real chart (one staff, four bars, six words) is NOT a placeholder', () => {
    expect(isPlaceholderCounts({ words: 6, segments: 10, images: 0, chords: 4 })).toBe(false);
  });
  it('drawn content alone disqualifies it (a chart with its text as outlines)', () => {
    expect(isPlaceholderCounts({ words: 2, segments: 40, images: 0, chords: 0 })).toBe(false);
  });
  it('a chords-over-lyrics sheet is not', () => {
    expect(isPlaceholderCounts({ words: 154, segments: 0, images: 0, chords: 8 })).toBe(false);
  });
});

// Codex R2 (#207): "Blues / Verse: A D E A / Chorus: F#m D E A" is a real text-only chart
// with 11 words and no ink. Word counts cannot tell it from "Love Shack / C"; chords can.
describe('chordTokens — what a placeholder lacks', () => {
  it('★ a title + key carries one chord-like token (the key)', () => {
    expect(chordTokens(['Love Shack', 'C'])).toBe(1);
    expect(chordTokens(['Dancing Queen', 'A'])).toBe(1);
    expect(chordTokens(['I Will Survive', 'Am'])).toBe(1);
  });
  it('★ the smallest text-only chart carries many (Codex R2)', () => {
    expect(chordTokens(['Blues', 'Verse: A D E A', 'Chorus: F#m D E A'])).toBe(8);
    expect(isPlaceholderCounts({ words: 11, segments: 0, images: 0, chords: 8 })).toBe(false);
  });
  it('reads Nashville numbers and slash chords too', () => {
    expect(chordTokens(['1 4 5- 1', '2m7 5/7 1△7'])).toBe(7);
    expect(chordTokens(['Bb7 Ebmaj7 F/A G#dim C#ø'])).toBe(5);
  });
  it('ordinary words are not chords', () => {
    expect(chordTokens(['Dancing Each Bad Add Be Got To Be Real'])).toBe(0);
  });
});

describe('countPdfContent', () => {
  // pdf.js 5 shape: constructPath args = [paintOp, [Float32Array path data], bbox], where the
  // data interleaves draw codes (0 moveTo·2, 1 lineTo·2, 2 curveTo·6, 3 quadTo·4, 4 close).
  const OPS = { constructPath: 91, endPath: 28, fill: 22, stroke: 20, paintImageXObject: 85 };
  const path = (paint: number, data: number[]) => [paint, [Float32Array.from(data)], Float32Array.from([0, 0, 1, 1])];
  const rect = [0, 72, 505, 1, 540, 505, 1, 540, 720, 1, 72, 720, 4];
  const page = (text: string[], fns: number[], args: unknown[]) => ({
    getTextContent: async () => ({ items: text.map((str) => ({ str })) }),
    getOperatorList: async () => ({ fnArray: fns, argsArray: args }),
  });
  const doc = (...pages: ReturnType<typeof page>[]) => ({ numPages: pages.length, getPage: async (n: number) => pages[n - 1] });

  it('★ the corpus placeholder: a clip (inks nothing) + one filled box = 4 segments', async () => {
    const d = doc(page(['Love Shack', 'C'], [91, 91], [path(28, rect), path(22, rect)]));
    expect(await countPdfContent(d as never, OPS as never)).toEqual({ words: 3, segments: 4, images: 0, chords: 1 });
  });

  it('★ ONE path op carrying a whole staff counts every segment (Codex R1)', async () => {
    const lines: number[] = [];
    for (let i = 0; i < 10; i++) lines.push(0, 10, 100 + i, 1, 500, 100 + i);
    const d = doc(page(['Song', 'A', 'D', 'E', 'A', 'x'], [91], [path(20, lines)]));
    const c = await countPdfContent(d as never, OPS as never);
    expect(c.segments).toBe(10);
    expect(isPlaceholderCounts(c)).toBe(false);
  });

  it('sums across pages and counts images', async () => {
    const d = doc(page(['a'], [91], [path(22, rect)]), page(['b'], [85], [[]]));
    expect(await countPdfContent(d as never, OPS as never)).toEqual({ words: 2, segments: 4, images: 1, chords: 0 });
  });

  it('★ an unrecognised path encoding fails toward "chart", never "placeholder"', async () => {
    const d = doc(page(['Love Shack', 'C'], [91], [[22, 'not-the-v5-shape']]));
    const c = await countPdfContent(d as never, OPS as never);
    expect(isPlaceholderCounts(c)).toBe(false);
  });
});
