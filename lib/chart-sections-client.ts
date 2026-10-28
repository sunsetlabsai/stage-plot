// ── Track B anchors, client half (docs/design-common-roadmap.md §4.1) ──
//
// CLIENT ONLY. Reads section headers off the open document's pdf.js text layer and posts
// them to /api/charts/sections. Holds no keys; the route is the only writer, and it writes
// insert-only. Same split, and the same stale-bytes recovery, as `chart-measure-client`.

import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Chart } from './types';
import { findSectionHeaders, type HeaderPage, type HeaderTextItem, type SectionHeader, type SectionsRequest, type SectionsResult } from './chart-section-headers';
import { evictChartCache } from './chart-cache';
import { evictChartDoc, loadPdfDoc } from './pdf-viewer';

/** Every header in the document, or [] if the text layer cannot be read. Never throws. */
export async function readSectionHeaders(doc: PDFDocumentProxy): Promise<SectionHeader[]> {
  try {
    const pages: HeaderPage[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const text = await page.getTextContent();
      // The viewport the viewer renders through (rotation included), so marks land on text.
      const vp = page.getViewport({ scale: 1 });
      pages.push({
        page: p,
        viewport: { transform: [...vp.transform], width: vp.width, height: vp.height },
        items: text.items.filter((it): it is typeof it & HeaderTextItem => 'str' in it),
      });
    }
    return findSectionHeaders(pages);
  } catch {
    return [];
  }
}

/** The raw POST, exposing the status. `status` is 0 for a transport failure. */
export async function postSections(
  body: SectionsRequest,
): Promise<{ status: number; result: SectionsResult | null }> {
  try {
    const res = await fetch('/api/charts/sections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { status: res.status, result: null };
    return { status: res.status, result: (await res.json()) as SectionsResult };
  } catch {
    return { status: 0, result: null };
  }
}

const toBody = (chartId: string, sourceHash: string, headers: SectionHeader[]): SectionsRequest => ({
  chart_id: chartId,
  source_hash: sourceHash,
  sections: headers.map(({ page, x, y, label }) => ({ page, x, y, label })),
});

export interface MarkSectionsOutcome {
  result: SectionsResult | null;
  /** Set only when a hash mismatch forced a reload; the caller MUST adopt both. */
  reloaded?: { doc: PDFDocumentProxy; sourceHash: string };
}

/**
 * Write the headers the owner was offered. ONE retry on a 409 (the bytes on screen were a
 * stale cached copy): evict both caches, reload network-direct, re-read, re-post. A second
 * mismatch is surfaced, not retried — storage is changing under us.
 */
export async function markSections(args: {
  chart: Chart;
  chartId: string;
  sourceHash: string;
  headers: SectionHeader[];
  accessToken?: string;
}): Promise<MarkSectionsOutcome> {
  const { chart, chartId, sourceHash, headers, accessToken } = args;
  const first = await postSections(toBody(chartId, sourceHash, headers));
  if (first.status !== 409) return { result: first.result };

  await evictChartCache(chart);
  evictChartDoc(chart);
  const fresh = await loadPdfDoc(chart, accessToken, { bypassCache: true });
  if (!fresh) return { result: null };
  const reread = await readSectionHeaders(fresh.doc);
  const retry = await postSections(toBody(chartId, fresh.sourceHash, reread));
  if (retry.status === 409) return { result: null, reloaded: fresh };
  return { result: retry.result, reloaded: fresh };
}
