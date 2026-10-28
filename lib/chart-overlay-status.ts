import type { Chart } from './types';
import { loadPdfDoc } from './pdf-viewer';

/**
 * Whether this chart has a bar overlay for the file it holds NOW (uat-plan-v1 §2.4).
 *
 * An overlay is keyed to the exact bytes it was built on (chart_id + source_hash), so the
 * only honest question is "is there a row for THESE bytes" — hash the current file and ask
 * the calibration read door, which shows an owner drafts as well as verified rows.
 *
 * `null` = could not tell (file unreadable, request failed). Callers treat that as "don't
 * warn": a guess either way would be wrong half the time, and Replace already worked
 * without a warning before this existed.
 */
export async function chartHasOverlay(chart: Chart): Promise<boolean | null> {
  if (!chart.fileId) return null;
  try {
    const loaded = await loadPdfDoc(chart);
    if (!loaded) return null;
    const res = await fetch(
      `/api/charts/calibration?chart_id=${encodeURIComponent(chart.fileId)}&hash=${encodeURIComponent(loaded.sourceHash)}`,
    );
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    return null;
  } catch {
    return null;
  }
}
