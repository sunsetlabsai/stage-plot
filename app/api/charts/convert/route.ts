import { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { getAdminConfig } from '@/lib/admin-config';
import { hashPdfBytes } from '@/lib/chart-calibration';
import {
  MAX_PDF_BYTES,
  buildCalibrationFromVision,
  schemaVersionToPersist,
  sniffPdf,
} from '@/lib/chart-converter';
import { extractChartVision, VISION_TIMEOUT_MS } from '@/lib/chart-vision';
import type { ConvertReason, ConvertResult } from '@/lib/chart-upload';

// The Anthropic call (VISION_TIMEOUT_MS = 50s) is aborted comfortably under this
// ceiling so the route always returns a typed degrade rather than a platform 504.
export const maxDuration = 60;
export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Typed degrade: a non-error outcome the client can act on (manual rail / re-add).
// Always 200 so the seam's triggerOverlayCreate gets the reason rather than null.
function degrade(reason: ConvertReason): Response {
  return Response.json({ generated: false, reason } satisfies ConvertResult);
}

interface PostBody {
  chart_id?: string;
}

// POST /api/charts/convert — auto-overlay generator. Vision-first: send the PDF
// to Claude as a document block, map the structured JSON to a DRAFT
// ChartCalibration, and persist it once under (chart_id, source_hash). Idempotent
// and edit-safe: the INSERT … ON CONFLICT DO NOTHING is the real generate-once
// guard, so a re-add (or a race) never clobbers an existing draft/verified row.
// Never auto-verifies. RBAC: owner-scoped write.
export async function POST(request: NextRequest) {
  // 1. Auth.
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
  if (!chartId || !UUID_RE.test(chartId)) {
    return Response.json({ error: 'valid chart_id is required' }, { status: 400 });
  }

  // 1b. Owner check (RLS would also block; this yields a clean 403) + storage path.
  const { data: chart } = await supabase
    .from('chart_library')
    .select('storage_path')
    .eq('id', chartId)
    .eq('owner_id', user.id)
    .maybeSingle();
  if (!chart) {
    return Response.json({ error: 'Chart not found or permission denied' }, { status: 403 });
  }

  // 2. Fetch bytes from the AUTHORITATIVE storage object (service-role download,
  //    not the CDN) so the hash matches what the viewer computes on the same bytes.
  const admin = getSupabaseAdmin();
  const { data: blob, error: dlError } = await admin.storage
    .from('charts')
    .download(chart.storage_path);
  if (dlError || !blob) {
    return Response.json({ error: 'Could not read chart file' }, { status: 500 });
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());

  // 3. Classify by magic bytes (never the claimed MIME). v1 is PDF-only.
  if (!sniffPdf(bytes)) return degrade('unsupported_type');

  // 3b. Size cap — oversized PDFs skip vision and degrade to manual.
  if (bytes.length > MAX_PDF_BYTES) return degrade('too_large');

  // 4. Hash the fetched object (parity with the viewer's source_hash).
  const sourceHash = await hashPdfBytes(bytes);

  // 5. Pre-check: a row for this (chart, hash) already exists → generate-once no-op.
  //    (Cheap short-circuit; the ON CONFLICT below is the race-safe guarantee.)
  const { data: existing } = await admin
    .from('chart_calibration')
    .select('chart_id')
    .eq('chart_id', chartId)
    .eq('source_hash', sourceHash)
    .maybeSingle();
  if (existing) return degrade('exists');

  // 6. Resolve the Anthropic key from the SAME source as the agent-assist route
  //    (Redis admin:claude_tryit_key, env CLAUDE_TRYIT_KEY fallback) so the
  //    converter reuses the already-provisioned platform key — no separate
  //    ANTHROPIC_API_KEY env needed. (Per-owner BYOA resolves here later.)
  //    Unconfigured key ⟹ degrade to manual, never error.
  const apiKey = await getAdminConfig('claude_tryit_key');
  if (!apiKey) return degrade('failed');

  // 7. Vision extract, aborted under maxDuration so we degrade rather than 504.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);
  let vision;
  try {
    vision = await extractChartVision(bytes, apiKey, controller.signal);
  } catch (err) {
    // An over-limit PDF (too many pages for the vision API) surfaces as a 400 →
    // too_large; anything else (timeout, transport, auth) is a generic failure.
    if (err instanceof Anthropic.BadRequestError) return degrade('too_large');
    return degrade('failed');
  } finally {
    clearTimeout(timer);
  }

  // 8. Map + validate. null = nothing usable extracted → degrade to manual rail.
  if (!vision) return degrade('failed');
  const calibration = buildCalibrationFromVision(vision);
  if (!calibration) return degrade('failed');

  // 9. Persist (the real guard): INSERT … ON CONFLICT (chart_id, source_hash) DO
  //    NOTHING RETURNING *. ignoreDuplicates makes the upsert a pure insert-or-skip;
  //    .select() returns the row IFF this call inserted it. RLS enforces owner write.
  const { data: inserted, error: insertError } = await supabase
    .from('chart_calibration')
    .upsert(
      {
        chart_id: chartId,
        source_hash: sourceHash,
        schema_version: schemaVersionToPersist(calibration),
        status: calibration.status,
        graph: {
          sections: calibration.sections,
          systems: calibration.systems,
          bars: calibration.bars,
          roadmap: calibration.roadmap,
        },
      },
      { onConflict: 'chart_id,source_hash', ignoreDuplicates: true },
    )
    .select('chart_id');

  if (insertError) return degrade('failed');

  // Empty RETURNING = a concurrent call won the insert; treat as already-present.
  if (!inserted || inserted.length === 0) return degrade('exists');

  return Response.json({ generated: true, calibration } satisfies ConvertResult);
}
