import { NextRequest } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import {
  canVerify,
  isPerformable,
  isValidCalibration,
  resolveRoadmap,
  upgradeCalibration,
  calibrationGetDisposition,
  calibrationGetResponse,
  CALIBRATION_SCHEMA_VERSION,
} from '@/lib/chart-calibration';
import type { CalibrationGetInput } from '@/lib/chart-calibration';
import type { Bar, ChartCalibration, RoadmapMarker, SectionAnchor, System } from '@/lib/types';

// A no-roadmap calibration is persisted at v2 so an old v2 build still serves it
// (rollback-safe). Only a roadmap-bearing payload is stamped at the current
// version and fenced from old readers by the GET version gate. See
// docs/design-nav-graph.md §8.
const LINEAR_SCHEMA_VERSION = 2;
function schemaVersionToPersist(cal: ChartCalibration): number {
  return (cal.roadmap?.length ?? 0) > 0 ? CALIBRATION_SCHEMA_VERSION : LINEAR_SCHEMA_VERSION;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;

// Reconstruct the client-facing ChartCalibration from a stored row. The status
// and schema_version columns are authoritative for querying; graph holds the
// section/system/bar/roadmap payload. Normalizes any known-old (v1/v2) row up to
// the in-memory v3 shape (the DB row is NOT rewritten, just the response). A
// genuinely-future row keeps its version so the GET gate can fail it closed.
function rowToCalibration(row: {
  schema_version: number;
  status: string;
  graph: { sections?: SectionAnchor[]; systems?: System[]; bars?: Bar[]; roadmap?: RoadmapMarker[] };
}): ChartCalibration {
  const raw: ChartCalibration = {
    schemaVersion: row.schema_version,
    status: row.status === 'verified' ? 'verified' : 'draft',
    sections: Array.isArray(row.graph?.sections) ? row.graph.sections : [],
    systems: Array.isArray(row.graph?.systems) ? row.graph.systems : undefined,
    bars: Array.isArray(row.graph?.bars) ? row.graph.bars : undefined,
    roadmap: Array.isArray(row.graph?.roadmap) ? row.graph.roadmap : undefined,
  };
  return upgradeCalibration(raw);
}

async function isOwnerOfChart(chartId: string): Promise<boolean> {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const { data } = await supabase
    .from('chart_library')
    .select('id')
    .eq('id', chartId)
    .eq('owner_id', user.id)
    .maybeSingle();
  return !!data;
}

// GET /api/charts/calibration?chart_id=&hash=
// Dual-audience by caller identity:
//   - Owner (authenticated, owns the chart) → returns any row, incl. drafts, for
//     the calibration editor.
//   - Everyone else (anonymous Perform reads on public shares) → the server
//     enforces the Perform boundary: only an isPerformable (verified + invariant)
//     row is returned; a draft is hidden behind the same 404 as a missing row, so
//     draft existence never leaks.
export async function GET(request: NextRequest) {
  const chartId = request.nextUrl.searchParams.get('chart_id');
  const hash = request.nextUrl.searchParams.get('hash');

  if (!chartId || !UUID_RE.test(chartId)) {
    return Response.json({ error: 'valid chart_id is required' }, { status: 400 });
  }
  if (!hash || !HASH_RE.test(hash)) {
    return Response.json({ error: 'valid hash is required' }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('chart_calibration')
    .select('schema_version, status, graph')
    .eq('chart_id', chartId)
    .eq('source_hash', hash)
    .maybeSingle();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  // The taxonomy decision lives in the pure `calibrationGetDisposition` (tested
  // without a Supabase harness). We feed it a DISCRIMINATED input built in the
  // route's required check order — schema → valid → performable — because
  // `isPerformable → canVerify → s.label.trim()` THROWS on a malformed row, so
  // `performable` must only be computed once schemaOk && valid both hold. The
  // disposition decides the status; the route only ever returns the calibration
  // on a 200, so the unusable graph is never served (fail-closed preserved).
  let input: CalibrationGetInput;
  let calibration: ChartCalibration | null = null;
  if (!data) {
    input = { hasRow: false };
  } else {
    calibration = rowToCalibration(data);
    // rowToCalibration upgrades known-old rows; anything still above the current
    // version is a future shape this build can't safely interpret.
    const schemaOk = calibration.schemaVersion === CALIBRATION_SCHEMA_VERSION;
    if (!schemaOk) {
      input = { hasRow: true, schemaOk: false, isOwner: await isOwnerOfChart(chartId) };
    } else if (!isValidCalibration(calibration)) {
      // Structurally invalid stored row (the hand-edited DB boundary).
      input = { hasRow: true, schemaOk: true, valid: false, isOwner: await isOwnerOfChart(chartId) };
    } else {
      // Only here — schemaOk && valid — is it safe to compute performability.
      const performable = isPerformable(calibration);
      // A performable row is served to anyone; ownership only matters for a draft.
      input = {
        hasRow: true,
        schemaOk: true,
        valid: true,
        performable,
        isOwner: performable ? false : await isOwnerOfChart(chartId),
      };
    }
  }

  const disposition = calibrationGetDisposition(input);
  const { status, body } = calibrationGetResponse(disposition, calibration);
  return Response.json(body, { status });
}

interface PutBody {
  chart_id?: string;
  source_hash?: string;
  calibration?: ChartCalibration;
}

// PUT /api/charts/calibration — upsert a calibration for a chart the caller owns.
// Auth + owner-only (RLS enforces; we also pre-check for a clean 403). Server
// guards the promotion invariant so a dishonest 'verified' payload is rejected.
export async function PUT(request: NextRequest) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  let body: PutBody;
  try {
    body = (await request.json()) as PutBody;
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const { chart_id: chartId, source_hash: hash, calibration } = body;

  if (!chartId || !UUID_RE.test(chartId)) {
    return Response.json({ error: 'valid chart_id is required' }, { status: 400 });
  }
  if (!hash || !HASH_RE.test(hash)) {
    return Response.json({ error: 'valid source_hash is required' }, { status: 400 });
  }
  if (!isValidCalibration(calibration)) {
    return Response.json({ error: 'invalid calibration payload' }, { status: 400 });
  }
  // Accept incoming schemaVersion ∈ {1, 2, 3}. (rowToCalibration normalizes on
  // read regardless; we must keep accepting v2 payloads from old tabs /
  // no-roadmap clients while supporting v3 roadmap payloads — §8 footgun.)
  if (![1, 2, CALIBRATION_SCHEMA_VERSION].includes(calibration.schemaVersion)) {
    return Response.json({ error: 'unsupported calibration schema version' }, { status: 400 });
  }
  // Fail closed: never persist a 'verified' calibration that breaks the
  // invariant. canVerify gates on both labeled sections AND a resolvable
  // roadmap — surface which one failed so the editor can show a useful message.
  if (calibration.status === 'verified' && !canVerify(calibration)) {
    let reason = 'cannot verify: every section needs a label';
    if ((calibration.roadmap?.length ?? 0) > 0) {
      const resolved = resolveRoadmap(calibration);
      if (!resolved.ok) reason = `cannot verify: roadmap does not resolve (${resolved.error.reason})`;
    }
    return Response.json({ error: reason }, { status: 400 });
  }

  // Ownership pre-check (RLS would also block, but this yields a clean 403).
  const { data: chart } = await supabase
    .from('chart_library')
    .select('id')
    .eq('id', chartId)
    .eq('owner_id', user.id)
    .maybeSingle();

  if (!chart) {
    return Response.json({ error: 'Chart not found or permission denied' }, { status: 403 });
  }

  // Normalize to the in-memory v3 shape (a v1 client payload gets systems/bars=[]).
  const toStore = upgradeCalibration(calibration);

  const { error } = await supabase
    .from('chart_calibration')
    .upsert(
      {
        chart_id: chartId,
        source_hash: hash,
        // Per-payload stamp: v3 only when a roadmap is present, else v2
        // (rollback-safe). The constant governs upgrade-on-read, not write. §8.
        schema_version: schemaVersionToPersist(toStore),
        status: toStore.status,
        graph: {
          sections: toStore.sections,
          systems: toStore.systems,
          bars: toStore.bars,
          roadmap: toStore.roadmap,
        },
      },
      { onConflict: 'chart_id,source_hash' },
    );

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ saved: true });
}
