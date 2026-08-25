import { NextRequest } from 'next/server';

const RATE_LIMIT_WINDOW = 60_000; // 1 minute
const RATE_LIMIT_MAX = 5;
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

/**
 * Ceiling for the unauthenticated capability probe (design §4 "Rate limiting").
 *
 * The default 5/min was tuned for the five ADMIN callers of checkRateLimit — all
 * authenticated, all hand-invoked. `GET /api/agent/capabilities` is the first
 * unauthenticated caller and it fires on every AI-tab mount, so 5 is wrong for it in
 * a way that matters: a 429 is not one of the four states §4 defines, so the client
 * would have to render a rate limit as *something else* — almost certainly the
 * store-unreachable state. That turns "you reloaded six times" into a reported
 * outage, which is precisely the misreporting this design exists to remove.
 *
 * 60/min: one Redis GET per request and no secret in the response, so the limit is
 * only an amplification bound. It has to clear a whole band behind one venue NAT
 * (§7) opening the app at once, plus React's development double-invoke.
 */
export const PROBE_RATE_LIMIT_MAX = 60;

export function getIp(request: NextRequest): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

export function checkRateLimit(
  ip: string,
  bucket: string = 'default',
  max: number = RATE_LIMIT_MAX,
): boolean {
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  let entry = rateLimitMap.get(key);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
    rateLimitMap.set(key, entry);
  }
  entry.count++;
  return entry.count <= max;
}
