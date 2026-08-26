import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

// Legacy redirect map — frozen at migration time (only 3 pre-existing shows)
const LEGACY_REDIRECTS: Record<string, string> = {
  'woof-camp-afterglow-sleazzy-top': '/graham/woof-camp-afterglow-sleazzy-top',
  'nicholson-ranch':                 '/graham/nicholson-ranch',
  'fernandos-party':                 '/fernando/fernandos-party',
};

// Reserved first-segment paths that cannot be owner slugs
const RESERVED_PATHS = new Set([
  'dashboard', 'sign-in', 'sign-out', 'claim', 'api', 'admin',
  'about', 'help', 'pricing', 'terms', 'privacy', 'settings',
  'new', 'import', 'export',
]);

// Paths exempt from the profile-check redirect (prevents redirect loops)
const PROFILE_CHECK_EXEMPT = new Set([
  '/claim', '/sign-in', '/sign-out',
]);

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });
  const pathname = request.nextUrl.pathname;

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Refresh session if expired
  await supabase.auth.getUser();

  // ── Legacy single-segment slug redirects ────────────────────────────
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 1) {
    const segment = segments[0];
    if (!RESERVED_PATHS.has(segment) && LEGACY_REDIRECTS[segment]) {
      const url = request.nextUrl.clone();
      url.pathname = LEGACY_REDIRECTS[segment];
      return NextResponse.redirect(url, 301);
    }
  }

  // ── Protect /dashboard, its children, and /library ──────────────────────
  //
  // ⚠ PREFIX, not equality. This was `pathname === '/dashboard'`, which meant
  // the guard covered exactly one path and nothing beneath it. Chunk 3 added
  // the first /dashboard CHILD — /dashboard/settings, the signed-in owner's own
  // account surface — and a signed-out direct load rendered it. The API behind
  // it still 401s, so no key was exposed, but the page is an account-key UI
  // shown to someone with no account, and the "owner's own account" boundary
  // is supposed to be enforced here rather than left to each route.
  //
  // Written as a prefix so the NEXT /dashboard child is protected by default
  // instead of depending on whoever adds it noticing this block.
  if (pathname === '/dashboard' || pathname.startsWith('/dashboard/') || pathname === '/library') {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      const url = request.nextUrl.clone();
      url.pathname = '/sign-in';
      // Return them where they were going, not to a hardcoded /dashboard —
      // INCLUDING the query string. Path-only would have quietly dropped it,
      // which is the difference between honouring the claim this comment makes
      // and merely appearing to.
      //
      // Both parts are server-derived and same-origin by construction, so this
      // cannot carry the off-origin payloads lib/safe-redirect.ts exists for.
      url.searchParams.set('redirect', pathname + request.nextUrl.search);
      return NextResponse.redirect(url);
    }
  }

  // ── Profile check — redirect to /claim if no profile exists ─────────
  const skipProfileCheck =
    PROFILE_CHECK_EXEMPT.has(pathname) || pathname.startsWith('/api/');

  if (!skipProfileCheck) {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('id')
        .eq('id', user.id)
        .single();

      if (!profile) {
        const url = request.nextUrl.clone();
        url.pathname = '/claim';
        return NextResponse.redirect(url);
      }
    }
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|sw.js|manifest|icons|api).*)',
  ],
};
