import { getSupabaseServer } from '@/lib/supabase-server';

/**
 * The platform super-admin boundary (design-single-backend §3.3a, §3.3b).
 *
 * ONE implementation for all four `/api/admin/*` routes. The shared bearer
 * secret it replaces had the same shape in four places; §3.3b rules that the
 * check is "normative and identical in all four", so per-route variation is a
 * defect, not a convenience.
 *
 * Every rule below is an auth rule, not a style choice:
 * - `getUser()`, never `getSession()` — `getSession()` returns the cookie's
 *   contents without revalidating them against the auth server.
 * - The email comes from the SERVER-side session, never from the request body,
 *   a header, or a JWT the browser decoded.
 * - Both sides trimmed and lowercased. The super-admin address is written
 *   mixed-case in the design; a bare `===` fails open or closed depending on
 *   which side drifts, and neither is acceptable.
 * - FAIL CLOSED on every missing input — unset `PLATFORM_ADMIN_EMAIL`, no
 *   session, no email on the session, or a thrown auth call. An unset variable
 *   must never mean "everyone is admin".
 *
 * Returns the 401 to send, or `null` when the caller is the super-admin:
 *
 *     const denied = await requirePlatformAdmin();
 *     if (denied) return denied;
 *
 * Callers must invoke this BEFORE any service-role work.
 */
export async function requirePlatformAdmin(): Promise<Response | null> {
  const expected = process.env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
  if (!expected) return unauthorized();

  let actual: string | undefined;
  try {
    const supabase = await getSupabaseServer();
    const { data } = await supabase.auth.getUser();
    actual = data?.user?.email?.trim().toLowerCase();
  } catch {
    // An unreachable auth server is not an authorisation.
    return unauthorized();
  }

  if (!actual) return unauthorized();
  return actual === expected ? null : unauthorized();
}

/**
 * Deliberately indistinguishable across every rejection reason. "no such admin
 * configured" and "you are not that admin" are the same response, so the route
 * does not confirm the super-admin's address to an unauthenticated caller.
 */
function unauthorized(): Response {
  return Response.json({ error: 'Unauthorized' }, { status: 401 });
}
