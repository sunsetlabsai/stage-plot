import { NextRequest } from 'next/server';
import { createClient } from 'redis';
import { SYSTEM_PROMPT, TOOLS } from '@/lib/agent';
import { getAdminConfig } from '@/lib/admin-config';
import { parseContentLength } from '@/lib/http-headers';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MAX_BODY_SIZE = 100_000; // 100KB
const TRYIT_MODEL = 'claude-sonnet-4-6';
const BYOA_MODEL = 'claude-sonnet-4-6';
const TRYIT_MAX_TOKENS = 2048;
const BYOA_MAX_TOKENS = 4096;
const TRYIT_QUOTA = 10;
const QUOTA_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

// In-memory fallback when Redis is unavailable
const fallbackQuota = new Map<string, { count: number; resetAt: number }>();

function getClientIp(request: NextRequest): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

function consumeFallbackQuota(ip: string): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const ttl = QUOTA_TTL_SECONDS * 1000;
  let entry = fallbackQuota.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + ttl };
    fallbackQuota.set(ip, entry);
  }
  if (entry.count >= TRYIT_QUOTA) {
    return { allowed: false, remaining: 0 };
  }
  entry.count++;
  return { allowed: true, remaining: Math.max(0, TRYIT_QUOTA - entry.count) };
}

async function consumeTryitQuota(ip: string): Promise<{ allowed: boolean; remaining: number }> {
  const url = process.env.REDIS_URL;
  if (!url) return consumeFallbackQuota(ip);

  let client;
  try {
    client = createClient({ url });
    await client.connect();

    const key = `quota:${ip}`;
    const count = await client.incr(key);

    // Always set TTL — idempotent, ensures TTL is present even if a
    // prior EXPIRE failed. Isolated so EXPIRE failure doesn't discard
    // the successful INCR result.
    try {
      await client.expire(key, QUOTA_TTL_SECONDS);
    } catch {
      // TTL not set — key persists without expiry. Acceptable: worst
      // case is this IP's quota never resets, which is conservative.
    }

    await client.disconnect();

    if (count > TRYIT_QUOTA) {
      return { allowed: false, remaining: 0 };
    }
    return { allowed: true, remaining: Math.max(0, TRYIT_QUOTA - count) };
  } catch {
    try { await client?.disconnect(); } catch { /* ignore */ }
    // Redis unavailable — fall back to in-memory
    return consumeFallbackQuota(ip);
  }
}

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
  const serverKey = await getAdminConfig('claude_tryit_key');
  const ip = getClientIp(request);

  let apiKey: string;
  let model: string;
  let maxTokens: number;
  let tryitRemaining: number | null = null;

  if (clientKey) {
    // BYOA mode
    apiKey = clientKey;
    model = BYOA_MODEL;
    maxTokens = BYOA_MAX_TOKENS;
  } else if (serverKey) {
    // Try-it mode — every request costs quota, no bypass vectors
    const quota = await consumeTryitQuota(ip);
    if (!quota.allowed) {
      return Response.json(
        { error: 'Free messages used up. Enter your own Claude API key to continue.', tryitExhausted: true },
        { status: 429, headers: { 'X-Tryit-Remaining': '0' } },
      );
    }
    tryitRemaining = quota.remaining;
    apiKey = serverKey;
    model = TRYIT_MODEL;
    maxTokens = TRYIT_MAX_TOKENS;
  } else {
    return Response.json(
      { error: 'No API key provided and try-it mode is not available.' },
      { status: 401 },
    );
  }

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
      const status = anthropicRes.status === 401 ? 401 : 502;
      const msg = anthropicRes.status === 401
        ? 'Invalid API key. Check your key and try again.'
        : `Claude API error: ${errText}`;
      return Response.json({ error: msg }, { status });
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
