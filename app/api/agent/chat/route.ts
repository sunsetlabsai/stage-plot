import { NextRequest } from 'next/server';
import { SYSTEM_PROMPT, TOOLS } from '@/lib/agent';
import { parseContentLength } from '@/lib/http-headers';
import { resolveKeyMode, getClientIp } from '@/lib/agent-key';
import { getSupabaseServer } from '@/lib/supabase-server';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MAX_BODY_SIZE = 100_000; // 100KB

// Quota accounting, the fallback map, model/token constants and the BYOA-wins
// precedence all live in lib/agent-key.ts so this route and the capabilities probe
// resolve capability through ONE implementation (design §4). Nothing about the
// observable send behavior changes here — §9 test 14 asserts that behaviorally
// rather than by byte-equivalence, because §4.1 deliberately changes the config
// read inside it.

export async function POST(request: NextRequest) {
  // Size check. A malformed Content-Length is refused rather than coerced: the old
  // parseInt read a numeric prefix, so '1e9' became 1 and slipped under the limit.
  //
  // Reachability, measured (Codex, raw local Node HTTP probe): prefix-malformed
  // values are rejected by Node's parser before they get here, but an all-digit
  // unsafe integer like 9007199254740992 DOES arrive. So this 400 is a real, live
  // branch — and for that one case it replaces what parseInt would have made a 413.
  // Accepted deliberately: it still fails closed, and any such value is ~11 orders
  // of magnitude past MAX_BODY_SIZE, so no honest client is being turned away.
  const contentLength = parseContentLength(request.headers.get('content-length'));
  if (contentLength.kind === 'invalid') {
    return Response.json({ error: 'Malformed Content-Length' }, { status: 400 });
  }
  if (contentLength.kind === 'bytes' && contentLength.bytes > MAX_BODY_SIZE) {
    return Response.json({ error: 'Request too large' }, { status: 413 });
  }

  let body: { messages: Array<{ role: string; content: unknown }>; currentConfig: unknown; configHash: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.messages || !Array.isArray(body.messages)) {
    return Response.json({ error: 'Missing messages array' }, { status: 400 });
  }

  // Determine auth mode
  const clientKey = request.headers.get('authorization')?.replace('Bearer ', '');
  const ip = getClientIp(request.headers);

  // The account-stored key (§4.5) is only consulted when the request did not
  // bring its own. Two reasons, both deliberate:
  //   1. Device-first precedence — Graham's ruling 2026-08-26.
  //   2. This route serves ANONYMOUS try-it traffic. getUser() is a network
  //      call to Supabase auth, so resolving it unconditionally would put a
  //      round trip in front of every free message to answer a question that
  //      request cannot use.
  //
  // Wrapped because this route must not acquire a hard dependency on auth.
  // Before chunk 3 a try-it send touched no session at all; resolving one
  // unguarded would mean a Supabase auth blip — or any caller outside a request
  // scope — turns a working free message into a 500 for someone who never
  // needed to be signed in. Failing to identify a user means exactly one thing
  // here: no account key. That is anonymous, not broken.
  let userId: string | null = null;
  if (!clientKey) {
    try {
      const supabase = await getSupabaseServer();
      const { data: { user } } = await supabase.auth.getUser();
      userId = user?.id ?? null;
    } catch {
      userId = null;
    }
  }

  const resolved = await resolveKeyMode(clientKey, ip, { consume: true }, userId);

  if (resolved.mode === 'exhausted') {
    return Response.json(
      {
        error: 'Free messages used up. Enter your own Claude API key to continue.',
        tryitExhausted: true,
      },
      { status: 429, headers: { 'X-Tryit-Remaining': '0' } },
    );
  }

  // `reason` is still carried so the 401's cause survives in logs. It no longer
  // has a sibling: `mode: 'error'` retired with the Redis config client
  // (design-single-backend §3.2) because config cannot fail to resolve.
  if (resolved.mode === 'unconfigured') {
    return Response.json(
      {
        error: 'No API key provided and try-it mode is not available.',
        reason: resolved.mode,
      },
      { status: 401 },
    );
  }

  const apiKey = resolved.apiKey;
  const model = resolved.model;
  const maxTokens = resolved.maxTokens;
  const tryitRemaining = resolved.mode === 'tryit' ? resolved.remaining : null;

  // Build system prompt with current config context
  const systemWithConfig = body.currentConfig
    ? `${SYSTEM_PROMPT}\n\n<current_config>\n${JSON.stringify(body.currentConfig, null, 2)}\n</current_config>`
    : SYSTEM_PROMPT;

  // Proxy to Claude API with streaming
  try {
    const anthropicRes = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: systemWithConfig,
        tools: TOOLS,
        messages: body.messages,
        stream: true,
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      if (anthropicRes.status === 401) {
        // Anthropic rejected the key we used. If it was a BYOA key, tell the client
        // WHICH backend so recovery points at the right place (design-account-key-
        // recovery §3): `keyReject` is set ONLY for byoa — a rejected shared try-it
        // key is a platform fault the user cannot fix, so it carries no keyReject,
        // exactly like the unconfigured 401. The field is a two-value enum derived
        // from `resolved.source`, never the key, its length or its prefix.
        const body: { error: string; keyReject?: 'device' | 'account' } = {
          error: 'Invalid API key. Check your key and try again.',
        };
        if (resolved.mode === 'byoa') body.keyReject = resolved.source;
        return Response.json(body, { status: 401 });
      }
      return Response.json({ error: `Claude API error: ${errText}` }, { status: 502 });
    }

    // Stream the response through
    const responseHeaders: Record<string, string> = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    };
    if (tryitRemaining !== null) {
      responseHeaders['X-Tryit-Remaining'] = String(tryitRemaining);
    }

    return new Response(anthropicRes.body, { headers: responseHeaders });
  } catch (e) {
    return Response.json(
      { error: `Proxy error: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }
}
