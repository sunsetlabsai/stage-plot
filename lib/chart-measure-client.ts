// ── The client half of the split contract (docs/design-chart-measurement.md) ──
//
// CLIENT ONLY — it drives the pdf.js recording shim. The rule the whole design turns on:
// this module MEASURES and POSTS. It holds no keys and it writes nothing. The convert
// route is the only insert-only calibration writer, and the browser must never gain
// overwrite power by riding the calibration PUT (that path is the human editing flow).

import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Chart } from './types';
import { measurePage, toPositionedText, isGeometryComplete } from './chart-measure';
import { extractPageGeometry } from './chart-measure-canvas';
import { buildMeasuredPayload, type MeasuredPageResult, type MeasuredPayload } from './chart-measured';
import { evictChartCache } from './chart-cache';
import { evictChartDoc, loadPdfDoc } from './pdf-viewer';
import { postConvert, type ConvertResult } from './chart-upload';

/**
 * Measure every page of an already-loaded document.
 *
 * Returns `null` if anything at all goes wrong — a measurement failure is never fatal:
 * the caller posts the legacy request and the chart takes today's whole-chart VLM path,
 * exactly as it does now.
 */
export async function measureDocument(doc: PDFDocumentProxy): Promise<MeasuredPayload | null> {
  try {
    const pages: MeasuredPageResult[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const geo = await extractPageGeometry(page);
      const text = await page.getTextContent();

      // ★ Two DIFFERENT quantities from one array, deliberately not the same expression.
      //
      // `textFlipY` is the baseline text is flipped against, and it stays B1's RAW
      // `view[3]` — i.e. it carries B1's assumption of a MediaBox origin at (0,0).
      // "Correcting" it would move measured output on a shifted-origin page, and corpus
      // parity is the engine's gate. (Measured: origin is (0,0) on all 115 corpus pages,
      // so the two agree there — this is about not exporting a silent assumption.)
      //
      // The page DIMENSIONS must be honest, because bar geometry normalizes against
      // them and a wrong denominator puts every bar in the wrong place. pdf.js view
      // dimensions are the box's EXTENT, not its far corner.
      const [vx0, vy0, vx1, vy1] = page.view;
      const measurement = measurePage(
        geo.segments,
        toPositionedText(text.items as { str: string; transform: number[] }[], vy1),
        { number: p, width: vx1 - vx0, height: vy1 - vy0 },
      );

      // PER PAGE. `isGeometryComplete` is a per-page predicate and the payload carries
      // its answer per page, all the way to the fold in `measuredDisposition` — a
      // chart-level "was everything complete" boolean computed here would be the wrong
      // shape and would hide exactly the mixed pages the fold exists to catch.
      pages.push({ measurement, complete: isGeometryComplete(geo) });
    }
    return buildMeasuredPayload(pages);
  } catch {
    return null;
  }
}

export interface OverlayBuildOutcome {
  result: ConvertResult | null;
  /**
   * Set only when a hash mismatch forced a reload: the fresh document and the hash the
   * overlay was actually built for. The caller MUST adopt both — an overlay applies only
   * to the bytes it was built for, so continuing to render the stale document while
   * fetching a calibration keyed to the new hash is the one thing this whole hash
   * boundary exists to prevent.
   */
  reloaded?: { doc: PDFDocumentProxy; sourceHash: string };
}

/**
 * Build an overlay for a chart the viewer already has open: measure it here, let the
 * server pay for the VLM, commit once.
 *
 * The hash the client sends is computed from the bytes it MEASURED; the server re-hashes
 * the authoritative storage object and rejects a mismatch. The mismatch is not
 * hypothetical: `fetchChartBytes` reads the Cache API before it considers any URL, so the
 * measured bytes may be a stale offline copy — which is why the recovery evicts BOTH
 * caches (Cache API and the in-memory doc map) before re-fetching, and why a
 * version-stamped URL alone would loop on the same stale bytes forever.
 *
 * ONE retry, then surface. A second mismatch means storage is changing under us, and
 * retrying forever would hide that behind a spinner.
 */
export async function buildOverlayWithMeasurement(args: {
  chart: Chart;
  chartId: string;
  doc: PDFDocumentProxy | null;
  sourceHash: string;
  accessToken?: string;
}): Promise<OverlayBuildOutcome> {
  const { chart, chartId, doc, sourceHash, accessToken } = args;

  const measured = doc ? await measureDocument(doc) : null;
  if (!measured) {
    // No measurement (no document, an engine throw, or geometry we cannot express as a
    // calibration) ⇒ the legacy request, byte-for-byte what this app posts today.
    return { result: (await postConvert({ chart_id: chartId })).result };
  }

  const first = await postConvert({ chart_id: chartId, source_hash: sourceHash, measured });
  if (first.status !== 409) return { result: first.result };

  // Stale bytes. Drop every cached copy, re-load network-direct, re-measure, re-submit.
  await evictChartCache(chart);
  evictChartDoc(chart);
  const fresh = await loadPdfDoc(chart, accessToken, { bypassCache: true });
  if (!fresh) return { result: null };

  const remeasured = await measureDocument(fresh.doc);
  const retry = await postConvert(
    remeasured
      ? { chart_id: chartId, source_hash: fresh.sourceHash, measured: remeasured }
      : { chart_id: chartId },
  );
  // A second mismatch is surfaced, not retried.
  if (retry.status === 409) return { result: null, reloaded: fresh };
  return { result: retry.result, reloaded: fresh };
}
