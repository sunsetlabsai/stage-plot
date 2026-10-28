import { describe, it, expect } from 'vitest';
import { isPlaceholderCounts, countPdfContent } from '../lib/chart-placeholder';

// ── Placeholder PDFs are not charts (backlog #204, Graham 2026-10-27) ────────
// A title-and-key page ("Love Shack / C") is a stand-in for a chart that was never
// uploaded. Measured on the 87-chart corpus: the 17 placeholders have 2–7 words, exactly
// 2 drawing paths and no images; the nearest real chart has 92 words and 91 paths.

describe('isPlaceholderCounts', () => {
  it('★ a title + key page is a placeholder', () => {
    expect(isPlaceholderCounts({ words: 3, paths: 2, images: 0 })).toBe(true);
    expect(isPlaceholderCounts({ words: 7, paths: 2, images: 0 })).toBe(true);
  });
  it('★ the smallest real chart in the corpus is not', () => {
    expect(isPlaceholderCounts({ words: 92, paths: 91, images: 0 })).toBe(false);
  });
  it('a scan is not a placeholder — it is a chart we cannot read as vectors', () => {
    expect(isPlaceholderCounts({ words: 0, paths: 0, images: 1 })).toBe(false);
  });
  it('drawn content alone disqualifies it (a chart with its text as outlines)', () => {
    expect(isPlaceholderCounts({ words: 2, paths: 40, images: 0 })).toBe(false);
  });
  it('a chords-over-lyrics sheet is not', () => {
    expect(isPlaceholderCounts({ words: 154, paths: 0, images: 0 })).toBe(false);
  });
});

describe('countPdfContent', () => {
  const OPS = { constructPath: 1, paintImageXObject: 2, paintInlineImageXObject: 3 };
  const page = (text: string[], fns: number[]) => ({
    getTextContent: async () => ({ items: text.map((str) => ({ str })) }),
    getOperatorList: async () => ({ fnArray: fns }),
  });
  it('sums words, paths and images across every page', async () => {
    const pages = [page(['Love Shack', 'C'], [1, 1, 9]), page(['x'], [2, 3, 1])];
    const doc = { numPages: 2, getPage: async (n: number) => pages[n - 1] };
    expect(await countPdfContent(doc as never, OPS as never)).toEqual({ words: 4, paths: 3, images: 2 });
  });
});
