import { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { getAdminConfig } from '@/lib/admin-config';
import { hashPdfBytes, isValidCalibration } from '@/lib/chart-calibration';
import {
  MAX_PDF_BYTES,
  buildCalibrationFromVision,
  overlaySkipReason,
  schemaVersionToPersist,
  sniffPdf,
} from '@/lib/chart-converter';
import {
  installMeasured,
  isValidMeasuredPayload,
  measuredDisposition,
  type MeasuredPayload,
} from '@/lib/chart-measured';
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
  source_hash?: unknown;
  measured?: unknown;
}

// POST /api/charts/convert — the overlay generator, fired ON OWNER DEMAND (it
// is no longer an upload side-effect: backlog-charting.md §Ruled 2026-09-02).
// Vision-first: send the PDF
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

  // 1a. The measured payload, if this client could measure (design-chart-measurement.md
  //     §Payload and route extension). A request with NO `measured` behaves exactly as it
  //     does today, all the way down — that is the legacy path `triggerOverlayCreate`
  //     posts, and nothing below may change for it.
  //
  //     ⚠ The two optional fields are NOT independently optional: `measured` present ⟹
  //     `source_hash` REQUIRED. A measured payload with no hash cannot clear the hash
  //     boundary in step 4b, so the pair is a 400 rather than a silent commit of
  //     unverified client geometry.
  let measured: MeasuredPayload | null = null;
  if (body.measured !== undefined) {
    if (typeof body.source_hash !== 'string' || body.source_hash.length === 0) {
      return Response.json(
        { error: 'source_hash is required when measured is present' },
        { status: 400 },
      );
    }
    if (!isValidMeasuredPayload(body.measured)) {
      return Response.json({ error: 'invalid measured payload' }, { status: 400 });
    }
    measured = body.measured;
  }

  // 1b. Owner check (RLS would also block; this yields a clean 403) + storage path.
  //     `role` / `source_spec` come back for the known-never gates in 1c.
  const { data: chart } = await supabase
    .from('chart_library')
    .select('storage_path, role, source_spec')
    .eq('id', chartId)
    .eq('owner_id', user.id)
    .maybeSingle();
  if (!chart) {
    return Response.json({ error: 'Chart not found or permission denied' }, { status: 403 });
  }

  // 1c. Known-never gates, BEFORE any download or vision call — the whole point
  //     is to save the call (backlog-charting.md §Ruled 2026-09-02). The client
  //     suppresses the "Build overlay" CTA on the same rule, so reaching here
  //     means a direct POST; the shared predicate is what keeps the two honest.
  const skip = overlaySkipReason({
    role: typeof chart.role === 'string' ? chart.role : '',
    hasSourceSpec: chart.source_spec != null,
  });
  if (skip) return degrade(skip);

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

  // 4b. The hash boundary. The client measured whatever bytes it had — possibly a stale
  //     Cache-API copy, since the viewer reads cache-first — so its geometry is only
  //     admissible if those bytes ARE the authoritative object we just downloaded.
  //     Rejecting here is what keeps "an overlay applies only to the bytes it was built
  //     for" true for machine writes as well as human ones. 409, not 400: it is a
  //     recoverable conflict, and the client recovers by evicting and re-measuring ONCE.
  if (measured && body.source_hash !== sourceHash) {
    return Response.json({ error: 'source_hash does not match stored bytes' }, { status: 409 });
  }

  // 5. Pre-check: a row for this (chart, hash) already exists → generate-once no-op.
  //    (Cheap short-circuit; the ON CONFLICT below is the race-safe guarantee.)
  const { data: existing } = await admin
    .from('chart_calibration')
    .select('chart_id')
    .eq('chart_id', chartId)
    .eq('source_hash', sourceHash)
    .maybeSingle();
  if (existing) return degrade('exists');

  // 5b. The THIRD never-gate, and the only one that needs to see inside the PDF: zero
  //     staves on every page, in geometry the engine could FULLY observe. A mislabeled
  //     upload — a lyrics sheet filed as 'guitar' — reaches here past the row-level
  //     gates, and this is where it stops.
  //
  //     Placed before the key resolve and the vision call because a never-gate means NO
  //     VLM and no overlay; a gate that fires after the call it exists to save would be
  //     pointless. It sits AFTER the exists check on purpose: an existing row is a fact
  //     and the client can use it, while the gate is a policy about future spend.
  //
  //     Evidence of ABSENCE, never absence of evidence — `measuredDisposition` gates only
  //     when every page was both classified `not-notation` AND fully observed. Raster
  //     pages and incomplete geometry fall through to the VLM instead.
  if (measured && measuredDisposition(measured) === 'gated') return degrade('not_notation');

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
    // Log the real cause before degrading — 'failed' on the manual rail otherwise
    // hides auth/model-access/timeout errors completely.
    console.error('[charts/convert] vision extract failed', err);
    // An over-limit PDF (too many pages for the vision API) surfaces as a 400 →
    // too_large; anything else (timeout, transport, auth) is a generic failure.
    if (err instanceof Anthropic.BadRequestError) return degrade('too_large');
    return degrade('failed');
  } finally {
    clearTimeout(timer);
  }

  // 8. Map + validate. null = nothing usable extracted → degrade to manual rail.
  //    This runs for a measured request too, and it must: the VLM supplies the SECTIONS
  //    either way (`canVerify` needs at least one labeled section, so a measurement-only
  //    calibration would leave the owner unable to Perform — measurement replaces VLM
  //    geometry, not VLM semantics), and its roadmap is the discriminator step 8b
  //    branches on. If vision produced nothing usable we still degrade exactly as today:
  //    there is no section source, and nothing to branch on.
  if (!vision) return degrade('failed');
  const visionCal = buildCalibrationFromVision(vision);
  if (!visionCal) return degrade('failed');

  // 8b. Branch on ROADMAP PRESENCE (§The roadmap is NOT separable semantics).
  //
  //     Roadmap markers bind through the VLM's OWN bar indices — the vision prompt
  //     defines every ref as an index into the model's `bars[]`, and the converter
  //     resolves them through a map built from those same bars. Install measured bars
  //     underneath and that map describes nothing: the roadmap would either fail to
  //     resolve or, worse, bind a repeat to the wrong bar and pass validation. So a chart
  //     with printed repeats keeps today's estimated geometry until ordinal rebinding is
  //     built (backlogged with that cost attached), and everything else gets exact
  //     geometry. A scope predicate, not a second implementation.
  //
  //     The discriminator is the BUILT calibration's roadmap, not the raw model output:
  //     structurally-unbindable markers are dropped before this point and are never
  //     persisted, so a chart whose only markers were dropped has no roadmap to protect.
  //
  //     Ordering note: the client measures BEFORE the server ever calls the VLM, so a
  //     discarded measurement costs client CPU and never AI spend.
  const useMeasured =
    measured !== null &&
    measuredDisposition(measured) === 'measured' &&
    (visionCal.roadmap?.length ?? 0) === 0;
  const calibration = useMeasured ? installMeasured(visionCal.sections, measured!) : visionCal;

  // 8c. Client geometry is DATA, never trusted computation: the merged result faces the
  //     same DB-boundary gate as any other payload, including the verdict enum check and
  //     the dense-absNumber invariant. (`visionCal` has already passed it inside the
  //     converter; re-running it is cheap and keeps ONE gate in front of the insert.)
  if (!isValidCalibration(calibration)) return degrade('failed');

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
