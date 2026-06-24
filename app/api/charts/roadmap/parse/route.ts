import { NextRequest } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getAdminConfig } from '@/lib/admin-config';
import { parseRoadmapSpec, PARSE_TIMEOUT_MS } from '@/lib/roadmap-parse';

// The Anthropic call (PARSE_TIMEOUT_MS = 50s) is aborted comfortably under this
// ceiling so the route returns a clean error rather than a platform 504.
export const maxDuration = 60;
export const runtime = 'nodejs';

const MAX_DESCRIPTION_CHARS = 8_000;

interface PostBody {
  description?: string;
}

// POST /api/charts/roadmap/parse — AI parse boundary (PARSE-ONLY). Natural-language
// song description → a validator-gated RoadmapSpec. Rendering the PDF + the
// born-verified ChartCalibration is the caller's separate step (renderRoadmap,
// chunk 1) so the AI seam and the deterministic renderer stay independently
// testable. The model proposes; validateRoadmapSpec disposes — an invalid spec
// is returned as { ok:false, errors } (200), never persisted. RBAC: authed only.
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

  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (!description) {
    return Response.json({ error: 'description is required' }, { status: 400 });
  }
  if (description.length > MAX_DESCRIPTION_CHARS) {
    return Response.json({ error: 'description is too long' }, { status: 400 });
  }

  // Resolve the Anthropic key from the SAME source as the converter/agent routes
  // (Redis admin:claude_tryit_key, env fallback) — no separate env needed.
  const apiKey = await getAdminConfig('claude_tryit_key');
  if (!apiKey) {
    return Response.json({ error: 'Parser is not configured' }, { status: 503 });
  }

  // Abort under maxDuration so a slow model returns a clean 502 rather than a 504.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PARSE_TIMEOUT_MS);
  try {
    const result = await parseRoadmapSpec(description, apiKey, controller.signal);
    return Response.json(result);
  } catch {
    return Response.json({ error: 'Parser is temporarily unavailable' }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
