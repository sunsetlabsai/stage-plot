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
          select: () => ({
            single: async () => {
              db.userScopedWrite = true;
              return db.rls === 'deny'
                ? { data: null, error: { message: 'new row violates row-level security policy for table "shows"' } }
                : { data: { updated_at: '2026-08-25T00:00:00Z', slug: 'my-show' }, error: null };
            },
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
            single: async () => ({
              data: db.showExists ? { owner_id: db.ownerId } : null,
            }),
            in: async () => ({ data: [] }),
            eq: () => ({ single: async () => ({ data: null }) }),
          }),
          in: async () => ({ data: [] }),
        }),
      };
    },
    rpc: async () => {
      db.rpcCalled = true;
      return { data: { updated_at: '2026-08-25T00:00:00Z', slug: 'my-show' }, error: null };
    },
  }),
}));

const { PUT } = await import('@/app/api/shows/update/route');

function updateRequest() {
  return new NextRequest('http://localhost/api/shows/update', {
    method: 'PUT',
    body: JSON.stringify({
      id: 'show-1',
      config: { showInfo: { showName: 'Friday Night' } },
      // `entries` present → the service-role path, where the guard lives.
      entries: [],
    }),
  });
}

beforeEach(() => {
  db.ownerId = 'owner-1';
  db.showExists = true;
  db.rpcCalled = false;
  db.userScopedWrite = false;
  db.rls = 'allow';
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

  function legacyRequest() {
    return new NextRequest('http://localhost/api/shows/update', {
      method: 'PUT',
      body: JSON.stringify({
        id: 'show-1',
        config: { showInfo: { showName: 'Friday Night' } },
        // no `entries` → legacy path
      }),
    });
  }

  it('routes the write through the USER-SCOPED client, never the service role', async () => {
    currentUserId = 'collaborator-1';
    db.rls = 'deny';

    await PUT(legacyRequest());

    expect(db.userScopedWrite).toBe(true);
    // The service-role client must not appear on this path at all.
    expect(db.rpcCalled).toBe(false);
  });

  it('surfaces an RLS denial as 403 rather than a silent success', async () => {
    // Post-014, a collaborator's legacy write is refused by row-level security.
    // The route must report that, not swallow it — §1.1's rule that the app
    // never claims a save it did not achieve.
    currentUserId = 'collaborator-1';
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
