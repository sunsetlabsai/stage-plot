import { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { getSupabaseServer } from '@/lib/supabase-server';
import { resolveChartKey } from '@/lib/agent-key';
import { parseWithoutModel, parseWithModel, PARSE_TIMEOUT_MS } from '@/lib/roadmap-parse';
import { CHART_KEY_COPY } from '@/lib/chart-key-copy';

// The Anthropic call (PARSE_TIMEOUT_MS = 50s) is aborted comfortably under this
// ceiling so the route returns a clean error rather than a platform 504.
export const maxDuration = 60;
export const runtime = 'nodejs';

const MAX_DESCRIPTION_CHARS = 8_000;

interface PostBody {
  description?: string;
  key?: string;        // the key the calling surface is showing (L0 source 2)
  keyOverride?: boolean; // true = Review toolbar (outranks a key stated in the prose)
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

  // L0 source 2: the optional Compose key selector. resolveRenderKey ignores an
  // invalid value (and an explicit key in the description still outranks it).
  const uiKey = typeof body.key === 'string' && body.key.trim() ? body.key.trim() : undefined;
  const keyOverride = body.keyOverride === true;

  // L1 first, before any key (UAT S15): a description the grammar transcribes
  // whole needs no model, so it is never refused for a missing key and never
  // spends try-it quota.
  const { renderKey, grammar } = parseWithoutModel(description, uiKey, keyOverride);
  if (grammar) return Response.json(grammar);

  // L2 needs a key, resolved like the AI tab's (design-ai-key-availability §13.4).
  // No manual mode exists to degrade into (§13.3), so a missing key is an honest,
  // actionable error rather than "Parser is not configured" (§13.5).
  const resolved = await resolveChartKey(request, user.id);
  if (resolved.mode === 'unconfigured') {
    return Response.json({ error: CHART_KEY_COPY.parse.unconfigured, reason: 'no_key' }, { status: 503 });
  }
  if (resolved.mode === 'exhausted') {
    return Response.json({ error: CHART_KEY_COPY.parse.exhausted, reason: 'no_key' }, { status: 429 });
  }

  // Abort under maxDuration so a slow model returns a clean 502 rather than a 504.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PARSE_TIMEOUT_MS);
  try {
    const result = await parseWithModel(description, renderKey, resolved.apiKey, controller.signal);
    return Response.json(result);
  } catch (err) {
    // Log the real cause — the user-facing message is deliberately generic, but a
    // silent catch is what turned a plain model-access 403 into an undebuggable 502.
    // The thrown Anthropic error carries status/type, never the key or request body.
    console.error('[charts/roadmap/parse] parse failed', err);
    // The user's OWN key rejected is theirs to fix, so say so. A rejected platform
    // key is ours: the generic 502 below, with the cause in the log.
    if (resolved.mode === 'byoa' && err instanceof Anthropic.AuthenticationError) {
      return Response.json({ error: CHART_KEY_COPY.parse.rejected, reason: 'key_rejected' }, { status: 401 });
    }
    return Response.json({ error: 'Parser is temporarily unavailable' }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
