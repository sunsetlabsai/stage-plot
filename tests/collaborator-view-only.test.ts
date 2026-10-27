import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// design-single-backend.md §3.3c — chunk 6. Collaborators are VIEW ONLY and the
// `editor` role is deleted.
//
// ★ WHY THESE ARE ROUTE TESTS AND NOT RLS TESTS. `PUT /api/shows/update`'s
// entries path authorizes through `getSupabaseAdmin()` — the SERVICE ROLE, which
// bypasses row-level security entirely. Dropping the "Editor update" grant in
// migration 014 does NOT close this path; the route's own owner check is the
// control. So the guard is asserted where it actually lives.
//
// ★ The method is PUT, not POST (app/api/shows/update/route.ts:21). Named because
// a test written against the wrong verb passes for the wrong reason: the route
// 405s and a "not 200" assertion still goes green.

const db = {
  ownerId: 'owner-1',
  showExists: true,
  rpcCalled: false,
  userScopedWrite: false,
  /** What RLS says about the user-scoped write. 'deny' mimics post-014 for a collaborator. */
  rls: 'allow' as 'allow' | 'deny',
  /** The show's current version; a save whose base differs is stale. */
  version: '2026-08-25T00:00:00.123456+00:00',
  rpcArgs: null as Record<string, unknown> | null,
  legacyBase: null as string | null,
};

let currentUserId = 'owner-1';

vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: currentUserId } } }) },
    // The LEGACY write path. Deliberately user-scoped: RLS is its control, and
    // after migration 014 the only surviving UPDATE grant on `shows` is
    // "Owner update".
    from: () => ({
      update: () => ({
        eq: () => ({
          // design-version-checked-save §3.3: the version-checked update.
          eq: (_col: string, base: string) => ({
            select: () => ({
              maybeSingle: async () => {
                db.userScopedWrite = true;
                db.legacyBase = base;
                if (db.rls === 'deny') {
                  return { data: null, error: { message: 'new row violates row-level security policy for table "shows"' } };
                }
                // Zero rows when the version moved.
                return base === db.version
                  ? { data: { updated_at: '2026-08-25T00:00:01Z', slug: 'my-show' }, error: null }
                  : { data: null, error: null };
              },
            }),
          }),
        }),
      }),
    }),
  }),
}));

vi.mock('@/lib/supabase-admin', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      // ★ The collaborator branch is GONE. If the route ever reads
      // show_collaborators again this throws rather than silently returning a
      // mock row — the guard must not grow a membership escape hatch back.
      if (table === 'show_collaborators') {
        throw new Error('shows/update must not read show_collaborators (§3.3c)');
      }
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: db.showExists ? { owner_id: db.ownerId } : null,
            }),
            in: async () => ({ data: [] }),
            eq: () => ({ single: async () => ({ data: null }) }),
          }),
          in: async () => ({ data: [] }),
        }),
      };
    },
    rpc: async (_fn: string, args: Record<string, unknown>) => {
      db.rpcCalled = true;
      db.rpcArgs = args;
      // rpc_save_show raises PT409 when the base is stale (migration 018).
      if (args.p_base_updated_at !== db.version) {
        return { data: null, error: { code: 'PT409', message: 'show changed since ...' } };
      }
      return { data: { updated_at: '2026-08-25T00:00:01Z', slug: 'my-show' }, error: null };
    },
  }),
}));

const { PUT } = await import('@/app/api/shows/update/route');

function updateRequest(base: string | undefined = db.version) {
  return new NextRequest('http://localhost/api/shows/update', {
    method: 'PUT',
    body: JSON.stringify({
      id: 'show-1',
      config: { showInfo: { showName: 'Friday Night' } },
      // `entries` present → the service-role path, where the guard lives.
      entries: [],
      base_updated_at: base,
    }),
  });
}

beforeEach(() => {
  db.ownerId = 'owner-1';
  db.showExists = true;
  db.rpcCalled = false;
  db.userScopedWrite = false;
  db.rls = 'allow';
  db.rpcArgs = null;
  db.legacyBase = null;
});

describe('§3.3c — a collaborator cannot write', () => {
  it('REJECTS a non-owner with 403 on PUT /api/shows/update', async () => {
    currentUserId = 'collaborator-1';

    const res = await PUT(updateRequest());

    expect(res.status).toBe(403);
    // The save must not have happened, not merely have been reported as denied.
    expect(db.rpcCalled).toBe(false);
  });

  it('rejects the non-owner WITHOUT consulting show_collaborators at all', async () => {
    // ★ The distinguishing case. Before chunk 6 a non-owner was looked up in
    // show_collaborators and admitted if `role === 'editor'`. The mock throws on
    // that table, so a route that still performs the lookup fails here even
    // though the status code it eventually returns would be identical.
    currentUserId = 'collaborator-1';

    await expect(PUT(updateRequest())).resolves.toBeDefined();
  });
});

describe('§3.3c — the counterexample: the owner still can', () => {
  it('ACCEPTS the owner with 200 on PUT /api/shows/update', async () => {
    // ★ THE COUNTEREXAMPLE TEST. A change that over-deletes — collapsing the
    // guard to an unconditional 403, or breaking the helper in 014 — passes
    // every rejection test above and fails only here. Without it,
    // over-deletion reads as success.
    currentUserId = 'owner-1';

    const res = await PUT(updateRequest());

    expect(res.status).toBe(200);
    expect(db.rpcCalled).toBe(true);
  });
});

describe('§3.3c — the LEGACY path stays user-scoped, so RLS is its control', () => {
  // Codex R1 medium: every test above sends `entries`, which exercises only the
  // service-role path. The route has a SECOND write path at the bottom
  // (no `entries` → direct `.update()` through the user-scoped client), and it
  // is closed by a different mechanism: migration 014 dropping "Editor update",
  // leaving only "Owner update".
  //
  // ★ That split is load-bearing and easy to destroy silently. If someone
  // "simplified" the legacy branch to use the admin client, it would bypass RLS
  // and reopen non-owner writes — with no owner check anywhere on that path,
  // before OR after 014 — and every other test here would still pass.

  // design-version-checked-save §3.3 adds an explicit ownership check BEFORE
  // either path, so a collaborator is now refused 403 before the legacy write is
  // attempted; RLS stays the write's own control underneath it.

  function legacyRequest(base: string | undefined = db.version) {
    return new NextRequest('http://localhost/api/shows/update', {
      method: 'PUT',
      body: JSON.stringify({
        id: 'show-1',
        config: { showInfo: { showName: 'Friday Night' } },
        // no `entries` → legacy path
        base_updated_at: base,
      }),
    });
  }

  it('routes the write through the USER-SCOPED client, never the service role', async () => {
    currentUserId = 'owner-1';

    await PUT(legacyRequest());

    expect(db.userScopedWrite).toBe(true);
    // The service-role client must not WRITE on this path (it only reads ownership).
    expect(db.rpcCalled).toBe(false);
  });

  it('refuses a collaborator 403 before the legacy write is even attempted', async () => {
    currentUserId = 'collaborator-1';
    db.rls = 'allow'; // even if RLS were somehow to allow it

    const res = await PUT(legacyRequest());

    expect(res.status).toBe(403);
    expect(db.userScopedWrite).toBe(false);
  });

  it('surfaces an RLS denial as 403 rather than a silent success', async () => {
    // The route must report a refused write, not swallow it — §1.1's rule that
    // the app never claims a save it did not achieve.
    currentUserId = 'owner-1';
    db.rls = 'deny';

    const res = await PUT(legacyRequest());

    expect(res.status).toBe(403);
  });

  it('COUNTEREXAMPLE: the owner still succeeds on the legacy path', async () => {
    // Without this, closing the legacy path to EVERYONE reads as success.
    currentUserId = 'owner-1';
    db.rls = 'allow';

    const res = await PUT(legacyRequest());

    expect(res.status).toBe(200);
    expect(db.userScopedWrite).toBe(true);
  });
});

describe('§3.3c — a missing show is still a 404, not a 403', () => {
  it('distinguishes "not found" from "not authorized" for the owner', async () => {
    // Guards that collapse to a blanket 403 would swallow this distinction.
    currentUserId = 'owner-1';
    db.showExists = false;

    const res = await PUT(updateRequest());

    expect(res.status).toBe(404);
  });
});

describe('design-version-checked-save §3.4 — the version contract', () => {
  it('428 when the request carries no base (an old bundle), and nothing is written', async () => {
    currentUserId = 'owner-1';

    // Built by hand: updateRequest(undefined) would take the default base.
    const res = await PUT(new NextRequest('http://localhost/api/shows/update', {
      method: 'PUT',
      body: JSON.stringify({ id: 'show-1', config: { showInfo: {} }, entries: [] }),
    }));

    expect(res.status).toBe(428);
    // Q6: the reload recovers the edit, so the copy must NOT tell them to redo it.
    const { error } = await res.json();
    expect(error).toMatch(/Reload/);
    expect(error).not.toMatch(/make it again/i);
    expect(db.rpcCalled).toBe(false);
    expect(db.userScopedWrite).toBe(false);
  });

  it('passes the base to rpc_save_show VERBATIM — never through Date', async () => {
    currentUserId = 'owner-1';

    const res = await PUT(updateRequest());

    expect(res.status).toBe(200);
    // Microseconds survive: a Date round-trip would cut .123456 to .123.
    expect(db.rpcArgs?.p_base_updated_at).toBe('2026-08-25T00:00:00.123456+00:00');
  });

  it('409 { conflict: true } when rpc_save_show raises PT409 (stale base)', async () => {
    currentUserId = 'owner-1';

    const res = await PUT(updateRequest('2026-08-24T00:00:00+00:00'));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ conflict: true });
  });

  it('legacy path: zero rows at a stale base is a 409, not a silent success', async () => {
    currentUserId = 'owner-1';

    const legacy = new NextRequest('http://localhost/api/shows/update', {
      method: 'PUT',
      body: JSON.stringify({ id: 'show-1', config: { showInfo: {} }, base_updated_at: 'stale' }),
    });
    const res = await PUT(legacy);

    expect(db.legacyBase).toBe('stale');
    expect(res.status).toBe(409);
  });

  it('a collaborator at the MATCHING version is still 403 (owner check before either path)', async () => {
    currentUserId = 'collaborator-1';

    const res = await PUT(updateRequest());

    expect(res.status).toBe(403);
    expect(db.rpcCalled).toBe(false);
  });
});
