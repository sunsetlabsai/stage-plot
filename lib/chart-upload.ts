import type { ChartCalibration } from './types';

// Shared chart-ADD path. Both add surfaces (the library Manage-Charts modal and
// the in-show ChartNavigator) go through uploadChart().
//
// ⚠ Upload STORES BYTES AND STOPS (backlog-charting.md §Ruled 2026-09-02).
// Conversion used to fire from here on every add; it no longer does. An overlay
// only earns its cost when the chart is actually going to be conducted, so
// `triggerOverlayCreate` is now called on OWNER DEMAND — from the perform
// readiness strip, where the owner is looking at a chart that can't perform yet.
// Do not re-attach it to the upload path: eager conversion spends the owner's AI
// budget on charts nobody will conduct, and creates review debt on top.

// The chart_library row the upload route returns (plus a derived public URL).
export interface UploadedChart {
  id: string;
  song_key: string;
  role: string;
  file_name: string;
  storage_path: string;
  mime_type: string;
  file_size: number;
  updated_at: string;
  url: string;
}

// Why an overlay was/wasn't generated (mirrors the convert route contract).
// 'authored' | 'lyrics' are the known-never gates (see lib/chart-converter.ts
// `overlaySkipReason`): the client suppresses the CTA for these, so they only
// reach a caller that POSTed the route directly.
export type ConvertReason =
  | 'exists'
  | 'unsupported_type'
  | 'too_large'
  | 'failed'
  | 'authored'
  | 'lyrics';

export interface ConvertResult {
  generated: boolean;
  calibration?: ChartCalibration;
  reason?: ConvertReason;
}

// Carries the HTTP status so callers can tailor messaging (e.g. 401 → sign in).
export class ChartUploadError extends Error {
  status: number;
  constructor(status: number, message?: string) {
    super(message ?? 'Chart upload failed');
    this.name = 'ChartUploadError';
    this.status = status;
  }
}

// Fire the overlay converter for a chart, ON OWNER DEMAND. Non-fatal by design:
// any failure (vision error, timeout, transport) returns null and the chart
// simply has no overlay (manual rail). Never throws — the caller renders the
// null as "couldn't build one", never as a broken chart.
export async function triggerOverlayCreate(chartId: string): Promise<ConvertResult | null> {
  try {
    const res = await fetch('/api/charts/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chart_id: chartId }),
    });
    if (!res.ok) return null;
    return (await res.json()) as ConvertResult;
  } catch {
    return null;
  }
}

// Upload (or replace) a chart. Stores bytes and stops — no overlay creation
// (see the header note). Throws ChartUploadError on upload failure; the caller
// owns the chart-add.
export async function uploadChart(
  file: File,
  songTitle: string,
  role: string,
): Promise<UploadedChart> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('song_title', songTitle);
  formData.append('role', role);

  let res: Response;
  try {
    res = await fetch('/api/charts/upload', { method: 'POST', body: formData });
  } catch {
    throw new ChartUploadError(0, 'network error');
  }

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ChartUploadError(res.status, err.error);
  }

  return (await res.json()) as UploadedChart;
}
