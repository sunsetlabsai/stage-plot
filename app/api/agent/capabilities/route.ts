import { NextRequest } from 'next/server';
import { checkRateLimit, PROBE_RATE_LIMIT_MAX } from '@/lib/admin-rate-limit';
import { resolveKeyMode, getClientIp, capabilitiesFrom } from '@/lib/agent-key';
import { getSupabaseServer } from '@/lib/supabase-server';

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

  // The probe is account-aware (design-single-backend §3.2). A signed-in owner who
  // saved a key to their account (chunk 3) must see the show-page affordance drop,
  // exactly as /api/agent/chat already resolves that key with the same userId. Read
  // the session the same guarded way the chat route does: wrapped, because a probe
  // must not acquire a hard dependency on auth — an anonymous link-viewer has no
  // session, and a Supabase auth blip must degrade to "no account key" (which for
  // this route is indistinguishable from anonymous) rather than fail the probe.
  let userId: string | null = null;
  try {
    const supabase = await getSupabaseServer();
    const { data: { user } } = await supabase.auth.getUser();
    userId = user?.id ?? null;
  } catch {
    userId = null;
  }

  // consume: false is load-bearing, not a default. A tab-open must not cost a free
  // message (§4 hard requirement), so the probe cannot reuse the sender's path, which
  // INCRs unconditionally. §4 called for a `peekTryitQuota` sibling; chunk 1 built the
  // same behavior as a `consume` flag on one private quota() instead — see §12, one
  // implementation with two modes cannot drift from itself the way two siblings can.
  //
  // Still no CLIENT key: the probe never carries key material. Passing the userId
  // lets `resolveKeyMode` consult the account-stored key, and `capabilitiesFrom`
  // reports its PRESENCE (`{ accountKey: true }`) without ever returning it.
  const resolved = await resolveKeyMode(undefined, ip, { consume: false }, userId);
  const capabilities = capabilitiesFrom(resolved);

  // no-store per §4: a cached "available" would be worse than having no probe at all,
  // because the empty state it suppresses is the one the user needs to see.
  return Response.json(capabilities, { headers: { 'Cache-Control': 'no-store' } });
}
