import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// middleware.ts's signed-in guard, driven behaviourally.
//
// ★ WHY THIS FILE EXISTS. The guard was written as
// `pathname === '/dashboard' || pathname === '/library'` — exact equality. That
// was correct for exactly as long as /dashboard had no children. Chunk 3 added
// the first one, /dashboard/settings, and a signed-out direct load rendered the
// account-key UI to someone with no account. Found by Codex, confirmed by
// driving the middleware here rather than by reading it.
//
// The API behind that page still 401s, so no key was ever exposed. The defect
// is the boundary: "the signed-in owner's own account" is supposed to be
// enforced in middleware, not re-implemented per route.
//
// ★ THE ASSERTION THAT MATTERS is the CHILD path, not /dashboard itself.
// /dashboard passed under the old code and passes under the new — testing only
// that would have gone green against the bug. A guard test whose inputs omit
// the one shape that broke it is theatre.

const session: { user: { id: string } | null } = { user: null };

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: session.user } }) },
    from: () => ({
      select: () => ({
        eq: () => ({ single: async () => ({ data: { id: 'profile-1' } }) }),
      }),
    }),
  }),
}));

async function visit(pathname: string) {
  const { middleware } = await import('../middleware');
  return middleware(new NextRequest(`https://showrunr.ai${pathname}`));
}

beforeEach(() => {
  session.user = null;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-test';
  vi.resetModules();
});

describe('middleware — signed-out visitors are kept out of /dashboard and its children', () => {
  it.each([
    ['/dashboard', 'the parent, which the old equality check already covered'],
    ['/dashboard/settings', '★ the child that the old equality check did NOT cover'],
    ['/library', 'the other guarded surface'],
  ])('redirects %s to sign-in (%s)', async (pathname) => {
    const res = await visit(pathname);
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/sign-in');
  });

  // Returning them to a hardcoded /dashboard silently discards where they were
  // actually going, which on a bookmarked /dashboard/settings looks like the
  // link is broken.
  it('preserves the intended destination rather than hardcoding /dashboard', async () => {
    const res = await visit('/dashboard/settings');
    const location = new URL(res.headers.get('location')!);
    expect(location.searchParams.get('redirect')).toBe('/dashboard/settings');
  });

  // The redirect param is server-derived here, so it cannot carry the
  // off-origin payloads lib/safe-redirect.ts exists to defeat. Pinned anyway:
  // this is the value that gets handed to that guard downstream.
  it('the redirect param is always a same-origin absolute path', async () => {
    for (const p of ['/dashboard', '/dashboard/settings', '/library']) {
      const res = await visit(p);
      const redirect = new URL(res.headers.get('location')!).searchParams.get('redirect')!;
      expect(redirect.startsWith('/')).toBe(true);
      expect(redirect.startsWith('//')).toBe(false);
      expect(redirect).not.toMatch(/^\/[\\\t\r\n]/);
    }
  });
});

describe('middleware — a signed-in owner is let through', () => {
  it.each(['/dashboard', '/dashboard/settings', '/library'])(
    'does not redirect %s when signed in with a profile',
    async (pathname) => {
      session.user = { id: 'owner-1' };
      const res = await visit(pathname);
      // NextResponse.next() — passed through, not redirected.
      expect(res.status).toBe(200);
      expect(res.headers.get('location')).toBeNull();
    },
  );
});
