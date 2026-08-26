import { describe, it, expect, vi, beforeEach } from 'vitest';

// design-single-backend.md §3.3c — chunk 6, the other half of the ruling.
//
// Deleting `editor` must NOT delete the collaborator. §3.3c: "membership buys
// DISCOVERABILITY, not access" — a show_collaborators row is what places an
// invited show on the collaborator's dashboard. A change that removed the role
// by removing the membership would pass every rejection test in
// collaborator-view-only.test.ts.
//
// ★ THE SELECT STRING IS THE REAL FAILURE SURFACE. After migration 014 drops the
// column, a query that still asks for `role` does not return a null field — it
// ERRORS. `collabs` comes back null, `collaborating` renders empty, and every
// invited show silently vanishes from the dashboard. So this asserts the string
// PostgREST is actually handed, not just the shape of the response.

const captured = { collabSelect: '' };

vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'collaborator-1' } } }) },
    from: (table: string) => {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({ single: async () => ({ data: { owner_slug: 'bandmate' } }) }),
            in: async () => ({ data: [{ id: 'owner-1', owner_slug: 'the-owner' }] }),
          }),
        };
      }
      if (table === 'shows') {
        return {
          select: () => ({
            eq: () => ({ order: async () => ({ data: [] }) }),
          }),
        };
      }
      if (table === 'show_collaborators') {
        return {
          select: (cols: string) => {
            captured.collabSelect = cols;
            return {
              eq: async () => ({
                data: [{
                  show_id: 'show-1',
                  shows: {
                    id: 'show-1',
                    slug: 'friday-night',
                    name: 'Friday Night',
                    venue: 'The Fillmore',
                    show_date: '2026-09-01',
                    updated_at: '2026-08-25T00:00:00Z',
                    owner_id: 'owner-1',
                  },
                }],
              }),
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

vi.mock('@/lib/supabase-admin', () => ({ getSupabaseAdmin: () => ({}) }));

const { GET } = await import('@/app/api/shows/route');

beforeEach(() => {
  captured.collabSelect = '';
});

describe('§3.3c — the list route no longer asks for a column that will not exist', () => {
  it('does NOT select `role` from show_collaborators', async () => {
    await GET();

    expect(captured.collabSelect).not.toMatch(/\brole\b/);
  });

  it('POSITIVE CONTROL: it still selects the columns it does need', async () => {
    // Without this, the assertion above would also pass on a select string that
    // was empty, malformed, or never captured at all.
    await GET();

    expect(captured.collabSelect).toContain('show_id');
    expect(captured.collabSelect).toContain('shows(');
  });
});

describe('§3.3c — membership still buys discoverability', () => {
  it('still lists an invited show under `collaborating`', async () => {
    const res = await GET();
    const body = await res.json();

    expect(body.collaborating).toHaveLength(1);
    expect(body.collaborating[0]).toMatchObject({
      id: 'show-1',
      slug: 'friday-night',
      name: 'Friday Night',
      owner_slug: 'the-owner',
    });
  });

  it('no longer returns a `role` field on the collaborated show', async () => {
    // The dashboard rendered this as a visible `(editor)` / `(viewer)` badge.
    // With one legal value it conveyed nothing, so it goes rather than becoming
    // a constant label.
    const res = await GET();
    const body = await res.json();

    expect(body.collaborating[0]).not.toHaveProperty('role');
  });
});
