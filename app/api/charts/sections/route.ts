import { NextRequest } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { hashPdfBytes, isValidCalibration } from '@/lib/chart-calibration';
import { LINEAR_SCHEMA_VERSION, schemaVersionToPersist, sniffPdf } from '@/lib/chart-converter';
import { toSectionAnchors, type SectionsReason, type SectionsResult } from '@/lib/chart-section-headers';
import type { ChartCalibration } from '@/lib/types';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;

function degrade(reason: SectionsReason): Response {
  return Response.json({ generated: false, reason } satisfies SectionsResult);
}

interface PostBody {
  chart_id?: unknown;
  source_hash?: unknown;
  sections?: unknown;
}

// POST /api/charts/sections — section anchors from the chart's own printed headers
// (docs/design-common-roadmap.md §4.1). The client reads the headers off the pdf.js
// text layer; this route writes them as a DRAFT, sections-only calibration that the
// owner then checks and verifies with the existing Calibrate → Verify.
//
// A separate route, not a branch of /api/charts/convert: that route's gate order is
// reasoned entirely around AI spend, and threading a no-spend exception through it is
// how a gate drifts. Nothing here spends — no key resolve, no VLM — so the overlay
// never-gates do not apply: a lyrics sheet (or a mislabeled one the measurement gated
// as `not_notation`) is exactly the chart this exists for.
//
// It reuses the convert route's write boundaries: owner-scoped (403), the client's hash
// checked against the authoritative stored bytes (409), every anchor validated, and
// generate-once on (chart_id, source_hash) via INSERT … ON CONFLICT DO NOTHING — so it
// can never overwrite an overlay, a draft or a verified calibration.
export async function POST(request: NextRequest) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const chartId = body.chart_id;
  if (typeof chartId !== 'string' || !UUID_RE.test(chartId)) {
    return Response.json({ error: 'valid chart_id is required' }, { status: 400 });
  }
  if (typeof body.source_hash !== 'string' || !HASH_RE.test(body.source_hash)) {
    return Response.json({ error: 'valid source_hash is required' }, { status: 400 });
  }
  const sections = toSectionAnchors(body.sections);
  if (!sections) {
    return Response.json({ error: 'invalid sections' }, { status: 400 });
  }

  // Owner check (RLS would also block; this yields a clean 403).
  const { data: chart } = await supabase
    .from('chart_library')
    .select('storage_path, source_spec')
    .eq('id', chartId)
    .eq('owner_id', user.id)
    .maybeSingle();
  if (!chart) {
    return Response.json({ error: 'Chart not found or permission denied' }, { status: 403 });
  }
  // A builder chart is born verified from the structure its owner authored; a machine
  // read of the PDF we rendered from it could only be worse.
  if (chart.source_spec != null) return degrade('authored');

  // The hash boundary, as in the convert route: the client read whatever bytes it had —
  // possibly a stale Cache-API copy — so its positions are admissible only if those bytes
  // ARE the stored object. 409 = recoverable; the client evicts and re-reads once.
  const admin = getSupabaseAdmin();
  const { data: blob, error: dlError } = await admin.storage
    .from('charts')
    .download(chart.storage_path);
  if (dlError || !blob) {
    return Response.json({ error: 'Could not read chart file' }, { status: 500 });
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (!sniffPdf(bytes)) return degrade('unsupported_type');
  const sourceHash = await hashPdfBytes(bytes);
  if (body.source_hash !== sourceHash) {
    return Response.json({ error: 'source_hash does not match stored bytes' }, { status: 409 });
  }

  const calibration: ChartCalibration = { schemaVersion: LINEAR_SCHEMA_VERSION, status: 'draft', sections };
  if (!isValidCalibration(calibration)) return degrade('failed');

  // Insert-or-skip. `.select()` returns the row IFF this call inserted it; an empty
  // RETURNING means a row for these bytes was already there (or a concurrent call won).
  const { data: inserted, error: insertError } = await supabase
    .from('chart_calibration')
    .upsert(
      {
        chart_id: chartId,
        source_hash: sourceHash,
        schema_version: schemaVersionToPersist(calibration),
        status: calibration.status,
        graph: { sections: calibration.sections },
      },
      { onConflict: 'chart_id,source_hash', ignoreDuplicates: true },
    )
    .select('chart_id');
  if (insertError) return degrade('failed');
  if (!inserted || inserted.length === 0) return degrade('exists');

  return Response.json({ generated: true } satisfies SectionsResult);
}
