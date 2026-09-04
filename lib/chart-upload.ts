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
// 'not_notation' is the THIRD never-gate, and the only one that cannot be decided from
// the row: it needs the measurement engine to look inside the PDF and find zero staves
// in geometry it could fully observe (a mislabeled upload — a lyrics sheet filed as
// 'guitar'). The client measures and the route enforces, same shape as the other two.
export type ConvertReason =
  | 'exists'
  | 'unsupported_type'
  | 'too_large'
  | 'failed'
  | 'authored'
  | 'lyrics'
  | 'not_notation';

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

// What the caller should do next with a convert result. Pure, so the reasoning
// below is pinned by tests rather than buried in an async tail in page.tsx.
export type BuildOverlayStep = 'refetch' | 'failed';

/**
 * Map a convert outcome to the next step.
 *
 * ⚠ `exists` is NOT a failure, and reading it as one was a real bug (caught in
 * review of PR #169). The client's calibration GET 404s at LOAD time; the
 * convert fires later, on a click, and anything can insert a row for
 * (chart_id, hash) in between — another tab or device, the admin backfill, or
 * THIS client's own previous build whose post-build refetch failed transiently.
 * That last one made the error self-sustaining: every retry returned `exists`
 * and re-errored, while a perfectly good overlay for the bytes on screen sat in
 * the DB, reachable only by reloading the page.
 *
 * Whether an existing row describes the bytes we are RENDERING is a question
 * only the hash-addressed GET can answer — it is keyed on the hash of the bytes
 * this client loaded, so a row built for different bytes 404s there and fails
 * correctly. So `exists` defers to that one authority instead of guessing here.
 */
export function buildOverlayStep(result: ConvertResult | null): BuildOverlayStep {
  if (!result) return 'failed'; // transport failure / non-ok HTTP
  if (result.generated) return 'refetch';
  return result.reason === 'exists' ? 'refetch' : 'failed';
}

// Fire the overlay converter for a chart, ON OWNER DEMAND. Non-fatal by design:
// any failure (vision error, timeout, transport) returns null and the chart
// simply has no overlay (manual rail). Never throws — the caller renders the
// null as "couldn't build one", never as a broken chart.
export async function triggerOverlayCreate(chartId: string): Promise<ConvertResult | null> {
  const { result } = await postConvert({ chart_id: chartId });
  return result;
}

// What the convert route accepts. `measured` and `source_hash` are NOT independently
// optional: `measured` present ⟹ `source_hash` REQUIRED, because a measured payload
// with no hash cannot clear the route's hash boundary and the server must reject the
// pair rather than commit unverified client geometry. Both stay optional only for the
// legacy no-measurement request above, which is what a client that cannot measure sends.
export interface ConvertRequest {
  chart_id: string;
  source_hash?: string;
  measured?: unknown;
}

/**
 * The raw POST, exposing the STATUS as well as the body.
 *
 * `triggerOverlayCreate` collapses every non-ok to `null`, which is right for the legacy
 * call — there is nothing to do about a 500 but degrade. The measured path needs more:
 * a 409 means "you measured stale bytes", which is recoverable exactly once, by evicting
 * and re-measuring. Collapsing it to null would turn a recoverable mismatch into a dead
 * "couldn't build an overlay".
 *
 * `status` is 0 for a transport failure (no response at all).
 */
export async function postConvert(
  body: ConvertRequest,
): Promise<{ status: number; result: ConvertResult | null }> {
  try {
    const res = await fetch('/api/charts/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { status: res.status, result: null };
    return { status: res.status, result: (await res.json()) as ConvertResult };
  } catch {
    return { status: 0, result: null };
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
