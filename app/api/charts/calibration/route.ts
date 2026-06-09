import { NextRequest } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { canVerify, CALIBRATION_SCHEMA_VERSION } from '@/lib/chart-calibration';
import type { ChartCalibration, SectionAnchor } from '@/lib/types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;

// Reconstruct the client-facing ChartCalibration from a stored row. The status
// and schema_version columns are authoritative for querying; graph holds the
// section payload (and, later, nav/temporal — kept extensible).
function rowToCalibration(row: {
  schema_version: number;
  status: string;
  graph: { sections?: SectionAnchor[] };
}): ChartCalibration {
  return {
    schemaVersion: row.schema_version,
    status: row.status === 'verified' ? 'verified' : 'draft',
    sections: Array.isArray(row.graph?.sections) ? row.graph.sections : [],
  };
}

// GET /api/charts/calibration?chart_id=&hash=
// Public read for Perform mode (anonymous show shares), via the service-role
// client — consistent with charts themselves being served from public storage
// URLs. Returns the single (chart_id, source_hash) row, or 404.
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
  if (!data) {
    return Response.json({ error: 'No calibration for this chart + hash' }, { status: 404 });
  }

  return Response.json({ calibration: rowToCalibration(data) });
}

interface PutBody {
  chart_id?: string;
  source_hash?: string;
  calibration?: ChartCalibration;
}

function isValidCalibration(c: unknown): c is ChartCalibration {
  if (!c || typeof c !== 'object') return false;
  const cal = c as Record<string, unknown>;
  if (cal.status !== 'draft' && cal.status !== 'verified') return false;
  if (typeof cal.schemaVersion !== 'number') return false;
  if (!Array.isArray(cal.sections)) return false;
  return (cal.sections as unknown[]).every((s) => {
    if (!s || typeof s !== 'object') return false;
    const a = s as Record<string, unknown>;
    return (
      typeof a.id === 'string' &&
      typeof a.page === 'number' &&
      typeof a.x === 'number' &&
      typeof a.y === 'number' &&
      typeof a.label === 'string'
    );
  });
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

  const body = (await request.json()) as PutBody;
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
  if (calibration.schemaVersion !== CALIBRATION_SCHEMA_VERSION) {
    return Response.json({ error: 'unsupported calibration schema version' }, { status: 400 });
  }
  // Fail closed: never persist a 'verified' calibration that breaks the invariant.
  if (calibration.status === 'verified' && !canVerify(calibration)) {
    return Response.json({ error: 'cannot verify: every section needs a label' }, { status: 400 });
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

  const { error } = await supabase
    .from('chart_calibration')
    .upsert(
      {
        chart_id: chartId,
        source_hash: hash,
        schema_version: calibration.schemaVersion,
        status: calibration.status,
        graph: { sections: calibration.sections },
      },
      { onConflict: 'chart_id,source_hash' },
    );

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ saved: true });
}
