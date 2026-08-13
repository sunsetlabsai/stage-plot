import { NextRequest } from 'next/server';
import { checkRateLimit, PROBE_RATE_LIMIT_MAX } from '@/lib/admin-rate-limit';
import { resolveKeyMode, getClientIp, capabilitiesFrom } from '@/lib/agent-key';

// GET /api/agent/capabilities — design docs/design-ai-key-availability.md §4, chunk 2.
//
// This route exists so the AI tab can tell the user WHICH of four conditions it is in
// (§1: today all four render identically). It resolves capability through the same
// lib/agent-key.ts the sender uses, with consume: false — see below, it is the whole
// point of the route.

export async function GET(request: NextRequest) {
  const ip = getClientIp(request.headers);

  // A 429 is deliberately NOT one of §4's four states, and the client must not
  // collapse it into one. `rateLimited` is here so chunk 3 can distinguish "ask again
  // shortly" from "the key store is unreachable" — reporting a rate limit as an
  // outage would be the same class of lie as §1's original defect.
  if (!checkRateLimit(ip, 'agent-capabilities', PROBE_RATE_LIMIT_MAX)) {
    return Response.json(
      { error: 'Too many requests', rateLimited: true },
      { status: 429, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // consume: false is load-bearing, not a default. A tab-open must not cost a free
  // message (§4 hard requirement), so the probe cannot reuse the sender's path, which
  // INCRs unconditionally. §4 called for a `peekTryitQuota` sibling; chunk 1 built the
  // same behavior as a `consume` flag on one private quota() instead — see §12, one
  // implementation with two modes cannot drift from itself the way two siblings can.
  //
  // No client key is passed: the probe reports on TRY-IT availability. A caller with
  // their own key does not need it, and asking about their key here would put key
  // material on a route whose contract is that it carries none.
  const resolved = await resolveKeyMode(undefined, ip, { consume: false });
  const capabilities = capabilitiesFrom(resolved);

  if (!capabilities) {
    // Unreachable: byoa requires a client key and we passed none. Fail loud rather
    // than reporting a state we did not measure (§0 invariant 2).
    return Response.json(
      { error: 'Capability resolution returned a mode the probe cannot report' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // no-store per §4: a cached "available" would be worse than having no probe at all,
  // because the empty state it suppresses is the one the user needs to see.
  return Response.json(capabilities, { headers: { 'Cache-Control': 'no-store' } });
}
