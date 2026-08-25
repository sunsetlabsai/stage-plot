import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// design-single-backend §3.3a, §3.3b, §9 — chunk 1, the /admin re-auth.
//
// ★ WHY THE ACCEPT CASES ARE NOT OPTIONAL.
// The `authenticate()` this replaces returned false the moment ADMIN_SECRET was
// unset. A route whose re-auth was simply FORGOTTEN therefore fails closed and
// looks fine — no error, no alarm, just a permanently 401ing admin tool. A
// suite of rejection cases passes against that route. Only proving the correct
// identity is ACCEPTED distinguishes "re-authed" from "silently dead", so every
// route below is exercised from both sides.
//
// §3.3b re-auths FOUR consumers and §9 requires each one covered — a test over
// `settings` alone would read as complete while leaving three unproven.
// `settings` PUT was deleted rather than re-authed (§3: no store, no write
// path), so this is seven cases, not eight; a test at the bottom pins that the
// verb is actually gone rather than merely untested.

const session = { email: undefined as string | undefined, throws: false };

vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: async () => {
    if (session.throws) throw new Error('auth server unreachable');
    return {
      auth: {
        getUser: async () => ({
          data: { user: session.email ? { id: 'u1', email: session.email } : null },
        }),
      },
    };
  },
}));

// The service-role client must never be reached by a rejected call. Every method
// here records, so an auth bypass shows up as work done rather than as a status
// code that happened to be wrong.
const serviceRoleCalls: string[] = [];
const recordingBuilder = (): Record<string, unknown> =>
  new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'then') return undefined; // not a thenable
        serviceRoleCalls.push(String(prop));
        return () => recordingBuilder();
      },
    },
  );

vi.mock('@/lib/supabase-admin', () => ({
  getSupabaseAdmin: () => {
    serviceRoleCalls.push('getSupabaseAdmin');
    return {
      from: () => recordingBuilder(),
      auth: { admin: { listUsers: async () => ({ data: { users: [] } }) } },
      storage: { from: () => recordingBuilder() },
    };
  },
}));

const ADMIN = 'graham@sunsetlabs.ai';
const ENV = { ...process.env };

beforeEach(() => {
  session.email = undefined;
  session.throws = false;
  serviceRoleCalls.length = 0;
  process.env.PLATFORM_ADMIN_EMAIL = ADMIN;
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ENV };
});

/**
 * Each route with a UNIQUE rate-limit bucket per case.
 *
 * `checkRateLimit` holds a module-scoped Map and the routes key it by IP, so
 * reusing one IP across 7 routes x 4 cases would trip the 5/min limit and turn
 * accept cases into 429s — a green-looking suite proving nothing.
 */
let ipCounter = 0;
const nextIp = () => `10.0.0.${++ipCounter % 250}-${ipCounter}`;

type RouteCase = {
  name: string;
  /** Invoke the route's handler with a fresh IP. */
  call: () => Promise<Response>;
};

const ROUTES: RouteCase[] = [
  {
    name: 'GET /api/admin/settings',
    call: async () => {
      const { GET } = await import('@/app/api/admin/settings/route');
      return GET(req('http://localhost/api/admin/settings'));
    },
  },
  {
    name: 'GET /api/admin/owners',
    call: async () => {
      const { GET } = await import('@/app/api/admin/owners/route');
      return GET(req('http://localhost/api/admin/owners'));
    },
  },
  {
    name: 'POST /api/admin/migrate-setlists',
    call: async () => {
      const { POST } = await import('@/app/api/admin/migrate-setlists/route');
      return POST(req('http://localhost/api/admin/migrate-setlists?dry_run=true', 'POST'));
    },
  },
  {
    name: 'POST /api/admin/backfill-chart-overlays',
    call: async () => {
      const { POST } = await import('@/app/api/admin/backfill-chart-overlays/route');
      return POST(req('http://localhost/api/admin/backfill-chart-overlays?dry_run=true', 'POST'));
    },
  },
];

function req(url: string, method = 'GET') {
  return new NextRequest(url, { method, headers: { 'x-forwarded-for': nextIp() } });
}

describe.each(ROUTES)('$name — the super-admin boundary', ({ call }) => {
  it('REJECTS an unauthenticated caller', async () => {
    session.email = undefined;
    const res = await call();
    expect(res.status).toBe(401);
    expect(serviceRoleCalls).toEqual([]);
  });

  it('REJECTS a signed-in account that is not the platform admin', async () => {
    // The distinguishing case. A guard that only checks "is anyone signed in?"
    // passes every no-session test above and fails only here — and every owner
    // on the platform is a signed-in account.
    session.email = 'someone.else@example.com';
    const res = await call();
    expect(res.status).toBe(401);
    expect(serviceRoleCalls).toEqual([]);
  });

  it('REJECTS the right identity when PLATFORM_ADMIN_EMAIL is unset — fails CLOSED', async () => {
    // §3.3a rule 3. An unset variable must never mean "everyone is admin"; the
    // session here is the genuine super-admin and must still be turned away.
    delete process.env.PLATFORM_ADMIN_EMAIL;
    session.email = ADMIN;
    const res = await call();
    expect(res.status).toBe(401);
    expect(serviceRoleCalls).toEqual([]);
  });

  it('REJECTS when PLATFORM_ADMIN_EMAIL is set but empty', async () => {
    // '' is falsy but present — a distinct deployment mistake from unset, and
    // `''.trim().toLowerCase() === ''` would match a session with no email if
    // the emptiness check were dropped.
    process.env.PLATFORM_ADMIN_EMAIL = '   ';
    session.email = ADMIN;
    expect((await call()).status).toBe(401);
  });

  it('ACCEPTS the platform admin — proves the route is re-authed, not silently dead', async () => {
    session.email = ADMIN;
    const res = await call();
    expect(res.status).not.toBe(401);
  });

  it('ACCEPTS the platform admin case-insensitively, with surrounding whitespace', async () => {
    // §3.3a rule 2. Graham writes the owner address mixed-case; a bare `===`
    // against a lowercased session email fails depending on which side drifts.
    session.email = `  ${ADMIN.toUpperCase()} `;
    const res = await call();
    expect(res.status).not.toBe(401);
  });
});

describe('requirePlatformAdmin — the shared boundary itself', () => {
  const subject = () => import('@/lib/admin-auth');

  it('fails closed when the auth call throws', async () => {
    // An unreachable auth server is not an authorisation. Without this, a
    // try/catch added later "for robustness" could swallow the failure open.
    session.throws = true;
    const { requirePlatformAdmin } = await subject();
    expect((await requirePlatformAdmin())?.status).toBe(401);
  });

  it('returns null — not a Response — for the platform admin', async () => {
    session.email = ADMIN;
    const { requirePlatformAdmin } = await subject();
    expect(await requirePlatformAdmin()).toBeNull();
  });

  it('rejects a session with no email even when one is signed in', async () => {
    // Supabase permits phone-only accounts, so `user` present does not imply
    // `user.email` present. Comparing `undefined` loosely would be a bypass.
    session.email = '';
    const { requirePlatformAdmin } = await subject();
    expect((await requirePlatformAdmin())?.status).toBe(401);
  });

  it('does not disclose the admin address in the rejection body', async () => {
    session.email = 'nobody@example.com';
    const { requirePlatformAdmin } = await subject();
    const body = await (await requirePlatformAdmin())!.json();
    expect(JSON.stringify(body)).not.toContain('sunsetlabs');
    expect(body).toEqual({ error: 'Unauthorized' });
  });
});

describe('ADMIN_SECRET is retired, not merely unused', () => {
  it('no longer authorises anything, even when set to the value a caller sends', async () => {
    // The retirement is the point of the chunk. If the old bearer path survived
    // anywhere, this is the request that would find it.
    process.env.ADMIN_SECRET = 'the-old-secret';
    session.email = undefined;
    const { GET } = await import('@/app/api/admin/owners/route');
    const res = await GET(
      new NextRequest('http://localhost/api/admin/owners', {
        headers: { 'x-forwarded-for': nextIp(), authorization: 'Bearer the-old-secret' },
      }),
    );
    expect(res.status).toBe(401);
    expect(serviceRoleCalls).toEqual([]);
  });

  it('exports no `authenticate` from lib/admin-rate-limit', async () => {
    const mod = await import('@/lib/admin-rate-limit');
    expect('authenticate' in mod).toBe(false);
  });
});

describe('PUT /api/admin/settings is DELETED, not left dead', () => {
  it('exports no PUT handler', async () => {
    // §3 removed the write path; a re-authed verb with nothing to write would be
    // the silently-dead pattern in a new place. Asserted rather than assumed,
    // because "the tests do not call PUT" and "PUT does not exist" look the same
    // in a green run.
    const mod = await import('@/app/api/admin/settings/route');
    expect('PUT' in mod).toBe(false);
    expect('GET' in mod).toBe(true);
  });
});
