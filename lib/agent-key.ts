import { readAdminConfig } from './admin-config';
import { createClient } from 'redis';

// Capability resolution for the AI Show Designer — owned in ONE place.
//
// Design docs/design-ai-key-availability.md §4. This is a refactor of a working
// route, and it is justified by the drift it forecloses, not by tidiness:
// `fallbackQuota` below is a module-level Map. If the probe route and the send
// route each grew their own copy, they would count in DIFFERENT maps — so with
// Redis down the panel and the send would disagree about how many messages remain,
// in the exact scenario where the fallback is load-bearing. §9 test 8 pins it.

export const TRYIT_QUOTA = 50; // §7: raised from 10 for the UAT window
export const TRYIT_MODEL = 'claude-sonnet-4-6';
export const BYOA_MODEL = 'claude-sonnet-4-6';
export const TRYIT_MAX_TOKENS = 2048;
export const BYOA_MAX_TOKENS = 4096;
const QUOTA_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/** THE in-memory fallback, used when Redis is unavailable. Exactly one instance. */
const fallbackQuota = new Map<string, { count: number; resetAt: number }>();

/** Test-only: the fallback map is module state and would otherwise leak across specs. */
export function __resetFallbackQuota() {
  fallbackQuota.clear();
}

export type KeyMode =
  /** The caller supplied their own key; it wins unconditionally. */
  | { mode: 'byoa'; apiKey: string; model: string; maxTokens: number }
  | { mode: 'tryit'; apiKey: string; model: string; maxTokens: number; remaining: number }
  /** Try-it is configured but this IP has spent its allowance. */
  | { mode: 'exhausted' }
  /** No key available: the store was reachable and nothing is set. */
  | { mode: 'unconfigured' }
  /** No key available AND the store was unreachable — a different operator problem. */
  | { mode: 'error'; reason: string };

/**
 * Peek or consume the try-it quota for an IP.
 *
 * `consume: false` performs a plain GET — no INCR, no EXPIRE — because a tab-open
 * must not cost a free message (§4 hard requirement). This is why the probe cannot
 * reuse the consuming path.
 */
async function quota(ip: string, consume: boolean): Promise<{ allowed: boolean; remaining: number }> {
  const url = process.env.REDIS_URL;
  if (!url) return fallback(ip, consume);

  let client;
  try {
    client = createClient({ url });
    await client.connect();
    const key = `quota:${ip}`;

    if (!consume) {
      const raw = await client.get(key);
      await client.disconnect();
      const count = raw ? Number(raw) : 0;
      // A non-numeric value is treated as no usage rather than NaN-propagating.
      const used = Number.isSafeInteger(count) && count > 0 ? count : 0;
      const remaining = Math.max(0, TRYIT_QUOTA - used);
      return { allowed: remaining > 0, remaining };
    }

    const count = await client.incr(key);

    // Always set TTL — idempotent, ensures TTL is present even if a prior EXPIRE
    // failed. Isolated so EXPIRE failure doesn't discard the successful INCR.
    try {
      await client.expire(key, QUOTA_TTL_SECONDS);
    } catch {
      // TTL not set — key persists without expiry. Acceptable: worst case is this
      // IP's quota never resets, which is conservative.
    }

    await client.disconnect();

    if (count > TRYIT_QUOTA) return { allowed: false, remaining: 0 };
    return { allowed: true, remaining: Math.max(0, TRYIT_QUOTA - count) };
  } catch {
    try { await client?.disconnect(); } catch { /* ignore */ }
    return fallback(ip, consume);
  }
}

function fallback(ip: string, consume: boolean): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const ttl = QUOTA_TTL_SECONDS * 1000;
  let entry = fallbackQuota.get(ip);

  if (!entry || now > entry.resetAt) {
    // A peek must not create state either — report a fresh allowance without
    // writing, so probing an unseen IP does not seed the map.
    if (!consume) return { allowed: true, remaining: TRYIT_QUOTA };
    entry = { count: 0, resetAt: now + ttl };
    fallbackQuota.set(ip, entry);
  }

  if (!consume) {
    const remaining = Math.max(0, TRYIT_QUOTA - entry.count);
    return { allowed: remaining > 0, remaining };
  }

  if (entry.count >= TRYIT_QUOTA) return { allowed: false, remaining: 0 };
  entry.count++;
  return { allowed: true, remaining: Math.max(0, TRYIT_QUOTA - entry.count) };
}

/**
 * Resolve how a request to the agent should be authorized.
 *
 * BYOA wins over try-it unconditionally, matching the behavior this replaces.
 * `unconfigured` and `error` are propagated OUTWARD rather than flattened to "no
 * key" — the distinction §5 depends on is made here or not at all (§0 invariant 2).
 */
export async function resolveKeyMode(
  clientKey: string | undefined,
  ip: string,
  opts: { consume: boolean },
): Promise<KeyMode> {
  if (clientKey) {
    return { mode: 'byoa', apiKey: clientKey, model: BYOA_MODEL, maxTokens: BYOA_MAX_TOKENS };
  }

  const read = await readAdminConfig('claude_tryit_key');
  if (read.status === 'error') return { mode: 'error', reason: read.reason };
  if (read.status === 'none') return { mode: 'unconfigured' };

  const q = await quota(ip, opts.consume);
  if (!q.allowed) return { mode: 'exhausted' };

  return {
    mode: 'tryit',
    apiKey: read.value,
    model: TRYIT_MODEL,
    maxTokens: TRYIT_MAX_TOKENS,
    remaining: q.remaining,
  };
}

/** `x-forwarded-for`'s first hop, or 'unknown'. Shared so probe and send key alike. */
export function getClientIp(headers: Headers): string {
  return headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}
