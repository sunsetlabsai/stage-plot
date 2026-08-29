import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { RoadmapSpec } from '../lib/roadmap-spec';

// PR B — persist the prompt (design-roadmap-prompt-persistence.md). These pin the
// two doors: the SAVE route threads source_prompt into the save_builder_chart RPC
// (trimmed, null when blank), and the READ door returns it (null for legacy rows).
// No existing test touched either route, so the wiring ships with its own net.

// A minimal spec that passes validate → render → parity → calibration gates.
const SPEC: RoadmapSpec = {
  version: 1,
  timeSig: { beats: 4, unit: 4 },
  renderKey: 'G',
  barsPerLine: 4,
  sections: [
    { id: 'intro', label: 'Intro', bars: 4, changes: [{ bar: 1, chords: [{ degree: 1 }] }] },
    { id: 'verse', label: 'Verse', bars: 8 },
  ],
};

// ── Captured RPC / query state ────────────────────────────────────────────────
const rpc = { name: null as string | null, args: null as Record<string, unknown> | null };
let readRow: Record<string, unknown> | null = null;

vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
  }),
}));

vi.mock('@/lib/supabase-admin', () => ({
  getSupabaseAdmin: () => ({
    // songs.artist lookup (save route) → no credit
    // chart_library read (read door) → the row under test
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: table === 'songs' ? null : readRow }) }),
          maybeSingle: async () => ({ data: readRow }),
        }),
      }),
    }),
    storage: { from: () => ({ upload: async () => ({ error: null }), remove: async () => ({ error: null }) }) },
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpc.name = name;
      rpc.args = args;
      return { data: { chart_id: 'chart-1', old_storage_path: null }, error: null };
    },
  }),
}));

const { POST } = await import('@/app/api/charts/roadmap/save/route');
const { GET } = await import('@/app/api/charts/roadmap/[chartId]/route');

function saveRequest(body: unknown) {
  return new NextRequest('http://localhost/api/charts/roadmap/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  rpc.name = null;
  rpc.args = null;
  readRow = null;
});

describe('save route — threads source_prompt into save_builder_chart', () => {
  it('passes the trimmed prompt to the RPC', async () => {
    const res = await POST(saveRequest({ spec: SPEC, song_title: '9 to 5', role: 'guitar', source_prompt: '  in G, 12-bar  ' }));
    expect(res.status).toBe(201);
    expect(rpc.name).toBe('save_builder_chart');
    expect(rpc.args?.p_source_prompt).toBe('in G, 12-bar');
  });

  it('stores null when the prompt is absent or blank', async () => {
    await POST(saveRequest({ spec: SPEC, song_title: '9 to 5', role: 'guitar' }));
    expect(rpc.args?.p_source_prompt).toBeNull();

    await POST(saveRequest({ spec: SPEC, song_title: '9 to 5', role: 'guitar', source_prompt: '   ' }));
    expect(rpc.args?.p_source_prompt).toBeNull();
  });
});

describe('read door — returns source_prompt for the builder to seed the refine box', () => {
  async function read() {
    const res = await GET(new NextRequest('http://localhost/api/charts/roadmap/chart-1'), {
      params: Promise.resolve({ chartId: 'chart-1' }),
    });
    return { status: res.status, body: await res.json() };
  }

  it('returns the stored prompt', async () => {
    readRow = { id: 'chart-1', owner_id: 'user-1', role: 'guitar', song_title: '9 to 5', song_key: '9-to-5', updated_at: 't', source_spec: SPEC, source_prompt: 'in G, 12-bar' };
    const { status, body } = await read();
    expect(status).toBe(200);
    expect(body.source_prompt).toBe('in G, 12-bar');
  });

  it('returns null for a legacy row with no prompt', async () => {
    readRow = { id: 'chart-1', owner_id: 'user-1', role: 'guitar', song_title: '9 to 5', song_key: '9-to-5', updated_at: 't', source_spec: SPEC, source_prompt: null };
    const { status, body } = await read();
    expect(status).toBe(200);
    expect(body.source_prompt).toBeNull();
  });
});
