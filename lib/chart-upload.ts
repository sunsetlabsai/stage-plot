import type { ChartCalibration } from './types';

// Shared chart-ADD path. BOTH add surfaces — the in-show ChartNavigator upload
// and (later) the library Manage-Charts modal — go through uploadChart() so no
// add path can skip overlay creation. This is the `triggerOverlayCreate` seam
// named in the converter/library designs.
//
// Until the converter route ships (chunk 2) /api/charts/convert does not exist;
// triggerOverlayCreate tolerates that (404 → null), so this chunk is a no-op
// overlay trigger with zero behavior change.

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
export type ConvertReason = 'exists' | 'unsupported_type' | 'too_large' | 'failed';

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

// Fire the auto-overlay converter for a freshly added/replaced chart. Non-fatal
// by design: any failure (route absent, vision error, timeout) returns null and
// the chart simply has no overlay (manual rail). Never throws.
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

// Upload (or replace) a chart, then fire overlay creation. Throws
// ChartUploadError on upload failure (the caller owns the chart-add); overlay
// creation failure is swallowed (the chart still uploaded).
export async function uploadChart(
  file: File,
  songTitle: string,
  role: string,
): Promise<{ chart: UploadedChart; overlay: ConvertResult | null }> {
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

  const chart = (await res.json()) as UploadedChart;
  const overlay = await triggerOverlayCreate(chart.id);
  return { chart, overlay };
}
