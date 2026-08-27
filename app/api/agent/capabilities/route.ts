import { NextRequest } from 'next/server';
import { checkRateLimit, PROBE_RATE_LIMIT_MAX } from '@/lib/admin-rate-limit';
import { resolveTryitMode, getClientIp, capabilitiesFrom, hasAccountKey, type AccountKeyReport } from '@/lib/agent-key';
import { getSupabaseServer } from '@/lib/supabase-server';

// GET /api/agent/capabilities — design docs/design-ai-key-availability.md §4, chunk 2.
//
// This route exists so the AI tab can tell the user WHICH of four conditions it is in
// (§1: today all four render identically). It resolves capability through the same
// lib/agent-key.ts the sender uses, with consume: false — see below, it is the whole
// point of the route.

export async function GET(request: NextRequest) {
  const ip = getClientIp(request.headers);

  // The probe is account-aware (design-single-backend §3.2). A signed-in owner who
  // saved a key to their account (chunk 3) must see the show-page affordance drop,
  // exactly as /api/agent/chat resolves that key. Read the session first, the same
  // guarded way the chat route does: wrapped, because a probe must not acquire a hard
  // dependency on auth — an anonymous link-viewer has no session, and a Supabase auth
  // blip must degrade to "no account key" rather than fail the probe. For an anonymous
  // caller getUser() short-circuits locally (no cookie ⇒ no network), so this adds
  // nothing to the path the rate limiter below is protecting.
  let userId: string | null = null;
  try {
    const supabase = await getSupabaseServer();
    const { data: { user } } = await supabase.auth.getUser();
    userId = user?.id ?? null;
  } catch {
    userId = null;
  }

  // An account-key owner bypasses the rate limiter entirely, and BEFORE it counts a
  // token (Codex chunk-4 R1). The limiter guards the shared per-IP try-it quota; an
  // account-key request never touches that quota, so limiting it would strand a user
  // who holds a working key — reporting "no key" (via a 429 → rateLimited) at exactly
  // the person who has one. `hasAccountKey` is presence-only (a read of the caller's
  // own secret row, never the quota), and anonymous callers never reach it, so the
  // limiter still fully guards the try-it path below. Presence only — zero key material.
  if (userId && (await hasAccountKey(userId))) {
    const body: AccountKeyReport = { accountKey: true };
    return Response.json(body, { headers: { 'Cache-Control': 'no-store' } });
  }

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
  // message (§4 hard requirement), so the probe reads the quota rather than INCRing it.
  // §4 called for a `peekTryitQuota` sibling; chunk 1 built the same behavior as a
  // `consume` flag on one private quota() instead — one implementation with two modes
  // cannot drift from itself the way two siblings can.
  //
  // The account-key case was fully handled and returned above, so this is the try-it
  // path by definition — hence `resolveTryitMode`, whose `TryitKeyMode` return can
  // never be byoa. That is exactly why `capabilitiesFrom` has no byoa case to fake.
  const capabilities = capabilitiesFrom(await resolveTryitMode(ip, false));

  // no-store per §4: a cached "available" would be worse than having no probe at all,
  // because the empty state it suppresses is the one the user needs to see.
  return Response.json(capabilities, { headers: { 'Cache-Control': 'no-store' } });
}
