import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// docs/design-version-checked-save.md §3.6 (Codex R2 + R3 on #201): POST /api/shows
// never creates a legacy show. A non-empty config.setlist with no setlist_songs has
// them derived server-side — sceneNote included — and takes the RPC path; an empty
// setlist takes the plain insert, created migrated.

const calls = {
  rpc: null as null | { fn: string; args: Record<string, unknown> },
  insert: null as null | Record<string, unknown>,
};

vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'owner-1' } } }) },
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        calls.insert = row;
        return { select: () => ({ single: async () => ({ data: { id: 'new', slug: 'x', updated_at: 't' }, error: null }) }) };
      },
    }),
  }),
}));

vi.mock('@/lib/supabase-admin', () => ({
  getSupabaseAdmin: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.rpc = { fn, args };
      return { data: { show_id: 'new', slug: 'x' }, error: null };
    },
  }),
}));

const { POST } = await import('@/app/api/shows/route');

function create(body: Record<string, unknown>) {
  return POST(new NextRequest('http://localhost/api/shows', { method: 'POST', body: JSON.stringify({ name: 'Gig', ...body }) }));
}

beforeEach(() => {
  calls.rpc = null;
  calls.insert = null;
});

describe('POST /api/shows never creates a legacy show (§3.6)', () => {
  it('derives setlist_songs from config.setlist — sceneNote included — and takes the RPC path', async () => {
    const res = await create({
      config: { setlist: [
        { title: 'Song A', key: 'G', lead: 'Sam', notes: 'n', sceneNote: 'lights down' },
        { title: 'Song B' },
      ] },
    });
    expect(res.status).toBe(201);
    expect(calls.insert).toBeNull();
    expect(calls.rpc?.fn).toBe('rpc_create_show_with_setlist');
    expect(calls.rpc?.args.p_setlist_songs).toEqual([
      { title: 'Song A', song_key: 'song a', key: 'G', lead: 'Sam', notes: 'n', scene_note: 'lights down' },
      { title: 'Song B', song_key: 'song b', key: null, lead: '', notes: '', scene_note: null },
    ]);
  });

  it('an unnormalizable derived title gets the same 400 an explicit one does', async () => {
    const res = await create({ config: { setlist: [{ title: '!!!' }] } });
    expect(res.status).toBe(400);
    expect(calls.rpc).toBeNull();
  });

  it('an empty setlist takes the plain insert, created migrated', async () => {
    const res = await create({ config: { setlist: [] } });
    expect(res.status).toBe(201);
    expect(calls.rpc).toBeNull();
    expect(calls.insert).toMatchObject({ setlist_migrated: true });
  });

  it('explicit setlist_songs still win over config.setlist', async () => {
    await create({ config: { setlist: [{ title: 'Ignored' }] }, setlist_songs: [{ title: 'Song C' }] });
    expect((calls.rpc?.args.p_setlist_songs as Array<{ title: string }>).map((s) => s.title)).toEqual(['Song C']);
  });
});
