import type { Chart } from './types';
import { fetchChartBytes } from './pdf-viewer';
import { hashPdfBytes } from './chart-calibration';

/**
 * Whether this chart has a bar overlay for the file it holds NOW (uat-plan-v1 §2.4).
 *
 * An overlay is keyed to the exact bytes it was built on (chart_id + source_hash), so the
 * only honest question is "is there a row for THESE bytes" — hash the current file and ask
 * the calibration read door, which shows an owner drafts as well as verified rows.
 *
 * `null` = could not tell (file unreadable, request failed). Callers treat that as "may
 * have one" and still warn: an unwarned Replace is the loss this exists to prevent.
 */
export async function chartHasOverlay(chart: Chart): Promise<boolean | null> {
  if (!chart.fileId) return null;
  try {
    // Hash the BYTES; never open a PDF document. Opening one per chart filled the
    // five-document cache and evicted a document an open preview still held (Codex R1,
    // #203). This is the same hash `loadPdfDoc` keys calibration on.
    const bytes = await fetchChartBytes(chart);
    if (!bytes) return null;
    const hash = await hashPdfBytes(bytes);
    const res = await fetch(
      `/api/charts/calibration?chart_id=${encodeURIComponent(chart.fileId)}&hash=${encodeURIComponent(hash)}`,
    );
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    return null;
  } catch {
    return null;
  }
}
