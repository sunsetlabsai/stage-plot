import { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { getAdminConfig } from '@/lib/admin-config';
import { checkRateLimit, getIp, authenticate } from '@/lib/admin-rate-limit';
import { hashPdfBytes } from '@/lib/chart-calibration';
import {
  MAX_PDF_BYTES,
  buildCalibrationFromVision,
  schemaVersionToPersist,
  sniffPdf,
} from '@/lib/chart-converter';
import { extractChartVision, VISION_TIMEOUT_MS } from '@/lib/chart-vision';

// One vision call (≤ VISION_TIMEOUT_MS each) per un-calibrated chart, processed
// up to `limit` per request so a batch stays well under this ceiling. Call
// repeatedly (idempotent) until `more` is false.
export const maxDuration = 300;
export const runtime = 'nodejs';

const DEFAULT_LIMIT = 4;
const MAX_LIMIT = 5; // batch * VISION_TIMEOUT_MS must stay under maxDuration

type Admin = ReturnType<typeof getSupabaseAdmin>;

interface ChartRow {
  id: string;
  song_title: string;
  role: string;
  storage_path: string;
}

// `expensive` = a vision call was made (consumes the per-request budget); cheap
// pre-vision skips (already-exists / non-PDF / oversized / missing object) do not.
type Outcome =
  | { status: 'generated'; expensive: true }
  | { status: 'skipped'; reason: 'exists' | 'unsupported_type' | 'too_large'; expensive: boolean }
  | { status: 'failed'; reason: string; expensive: boolean };

// Mirrors the /api/charts/convert per-chart pipeline (download authoritative
// bytes → magic-byte sniff → size cap → hash → existence pre-check → vision →
// map → INSERT … ON CONFLICT DO NOTHING). Idempotent + edit-safe: never updates
// or deletes, so a re-run can't clobber a draft/verified overlay.
async function convertChart(admin: Admin, apiKey: string, chart: ChartRow): Promise<Outcome> {
  const { data: blob, error: dlError } = await admin.storage.from('charts').download(chart.storage_path);
  if (dlError || !blob) {
    return { status: 'failed', reason: `download error: ${dlError?.message ?? 'no object'}`, expensive: false };
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());

  if (!sniffPdf(bytes)) return { status: 'skipped', reason: 'unsupported_type', expensive: false };
  if (bytes.length > MAX_PDF_BYTES) return { status: 'skipped', reason: 'too_large', expensive: false };

  const sourceHash = await hashPdfBytes(bytes);
  const { data: existing } = await admin
    .from('chart_calibration')
    .select('chart_id')
    .eq('chart_id', chart.id)
    .eq('source_hash', sourceHash)
    .maybeSingle();
  if (existing) return { status: 'skipped', reason: 'exists', expensive: false };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);
  let vision;
  try {
    vision = await extractChartVision(bytes, apiKey, controller.signal);
  } catch (err) {
    if (err instanceof Anthropic.BadRequestError) return { status: 'skipped', reason: 'too_large', expensive: true };
    return { status: 'failed', reason: err instanceof Error ? err.message : 'vision error', expensive: true };
  } finally {
    clearTimeout(timer);
  }

  if (!vision) return { status: 'failed', reason: 'no structure extracted', expensive: true };
  const calibration = buildCalibrationFromVision(vision);
  if (!calibration) return { status: 'failed', reason: 'unmappable extraction', expensive: true };

  const { data: inserted, error: insertError } = await admin
    .from('chart_calibration')
    .upsert(
      {
        chart_id: chart.id,
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
  if (insertError) return { status: 'failed', reason: insertError.message, expensive: true };
  if (!inserted || inserted.length === 0) return { status: 'skipped', reason: 'exists', expensive: true };

  return { status: 'generated', expensive: true };
}

// POST /api/admin/backfill-chart-overlays — A2 one-time overlay backfill on prod.
// Ports the per-chart converter logic so it can run on Vercel (no local box).
// Auth: Authorization: Bearer <ADMIN_SECRET>.
// ?dry_run=true  → instant preview (counts only; no downloads, no vision, no writes).
// ?limit=<1..5>  → max vision calls this request (default 4); call again while `more`.
export async function POST(request: NextRequest) {
  const ip = getIp(request);
  if (!checkRateLimit(ip, 'backfill-chart-overlays')) {
    return Response.json({ error: 'Too many requests' }, { status: 429 });
  }
  if (!authenticate(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dryRun = request.nextUrl.searchParams.get('dry_run') === 'true';
  const limitParam = Number(request.nextUrl.searchParams.get('limit'));
  const limit = Number.isInteger(limitParam)
    ? Math.min(Math.max(limitParam, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const admin = getSupabaseAdmin();

  const { data: charts, error: chartsErr } = await admin
    .from('chart_library')
    .select('id, song_title, role, storage_path')
    .order('created_at', { ascending: true });
  if (chartsErr) {
    return Response.json({ error: 'Could not read chart_library', detail: chartsErr.message }, { status: 500 });
  }
  if (!charts || charts.length === 0) {
    return Response.json({ dry_run: dryRun, total_charts: 0, message: 'No charts in the library.' });
  }

  // Charts that already have ANY calibration row are skipped cheaply (no
  // download) so successive batches advance to the un-calibrated remainder.
  const { data: calRows, error: calErr } = await admin.from('chart_calibration').select('chart_id');
  if (calErr) {
    return Response.json({ error: 'Could not read chart_calibration', detail: calErr.message }, { status: 500 });
  }
  const calibrated = new Set((calRows ?? []).map((r) => r.chart_id as string));
  const needWork = (charts as ChartRow[]).filter((c) => !calibrated.has(c.id));

  // Dry run: counts only — instant, nothing fetched or written.
  if (dryRun) {
    return Response.json({
      dry_run: true,
      limit,
      total_charts: charts.length,
      already_calibrated: charts.length - needWork.length,
      need_work: needWork.length,
      would_process_this_batch: Math.min(needWork.length, limit),
    });
  }

  // Real run: spend the vision budget on the un-calibrated charts.
  const apiKey = await getAdminConfig('claude_tryit_key');
  if (!apiKey) {
    return Response.json(
      { error: 'No Anthropic key (admin:claude_tryit_key / CLAUDE_TRYIT_KEY) configured.' },
      { status: 412 },
    );
  }

  const tally = { generated: 0, skipped_exists: 0, skipped_unsupported: 0, skipped_too_large: 0, failed: 0 };
  const generatedCharts: string[] = [];
  const failures: Array<{ chart: string; reason: string }> = [];
  let budget = limit;
  let deferred = 0;

  for (const chart of needWork) {
    const label = `${chart.song_title} [${chart.role}]`;
    if (budget <= 0) {
      deferred++;
      continue;
    }
    const outcome = await convertChart(admin, apiKey, chart);
    if (outcome.expensive) budget--;

    if (outcome.status === 'generated') {
      tally.generated++;
      generatedCharts.push(label);
    } else if (outcome.status === 'skipped') {
      if (outcome.reason === 'exists') tally.skipped_exists++;
      else if (outcome.reason === 'unsupported_type') tally.skipped_unsupported++;
      else tally.skipped_too_large++;
    } else {
      tally.failed++;
      failures.push({ chart: label, reason: outcome.reason });
    }
  }

  return Response.json({
    dry_run: false,
    limit,
    total_charts: charts.length,
    already_calibrated: charts.length - needWork.length,
    ...tally,
    generated_charts: generatedCharts,
    failures,
    deferred,
    more: deferred > 0,
  });
}
