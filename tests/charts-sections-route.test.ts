import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';
import { NextRequest } from 'next/server';

// ── Track B anchors: POST /api/charts/sections (docs/design-common-roadmap.md §4.1) ──
//
// The route writes a DRAFT sections-only calibration from headers the client read. What a
// green suite must not be able to hide: a write against bytes the client never read, a
// write over an existing row, a write on someone else's chart, any AI spend, and a
// payload whose malformed half is silently dropped.

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // "%PDF-1.7"

const state = {
  owned: true,
  role: 'lyrics',
  sourceSpec: null as unknown,
  bytes: PDF,
  inserted: null as null | Record<string, unknown>,
  /** Empty RETURNING = a row for (chart, hash) already existed. */
  conflict: false,
  user: { id: 'owner-1' } as { id: string } | null,
};

vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: state.owned
                ? { storage_path: 'owner-1/x.pdf', role: state.role, source_spec: state.sourceSpec }
                : null,
            }),
          }),
        }),
      }),
      upsert: (row: Record<string, unknown>, opts: Record<string, unknown>) => {
        expect(opts).toEqual({ onConflict: 'chart_id,source_hash', ignoreDuplicates: true });
        if (!state.conflict) state.inserted = row;
        return {
          select: async () => ({ data: state.conflict ? [] : [{ chart_id: row.chart_id }], error: null }),
        };
      },
    }),
  }),
}));

vi.mock('@/lib/supabase-admin', () => ({
  getSupabaseAdmin: () => ({
    storage: {
      from: () => ({ download: async () => ({ data: new Blob([state.bytes as BlobPart]), error: null }) }),
    },
  }),
}));

// Spend tripwires: the route must never touch the key resolver or the vision call.
const spend = { key: 0, vision: 0 };
vi.mock('@/lib/agent-key', () => ({
  resolveChartKey: async () => {
    spend.key++;
    return { mode: 'unconfigured' };
  },
}));
vi.mock('@/lib/chart-vision', () => ({
  VISION_TIMEOUT_MS: 1,
  extractChartVision: async () => {
    spend.vision++;
    return null;
  },
}));

const { POST } = await import('@/app/api/charts/sections/route');
const { hashPdfBytes } = await import('@/lib/chart-calibration');

const CHART_ID = '11111111-2222-4333-8444-555555555555';
const REAL_HASH = await hashPdfBytes(PDF);
const HEADERS = [
  { page: 1, x: 0.1, y: 0.05, label: 'INTRO' },
  { page: 1, x: 0.1, y: 0.3, label: 'VERSE 1' },
  { page: 2, x: 0.1, y: 0.1, label: 'CHORUS' },
];

function post(body: unknown) {
  return POST(
    new NextRequest('http://localhost/api/charts/sections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}
const good = (over: Record<string, unknown> = {}) => ({
  chart_id: CHART_ID,
  source_hash: REAL_HASH,
  sections: HEADERS,
  ...over,
});

beforeEach(() => {
  state.owned = true;
  state.role = 'lyrics';
  state.sourceSpec = null;
  state.bytes = PDF;
  state.inserted = null;
  state.conflict = false;
  state.user = { id: 'owner-1' };
  spend.key = 0;
  spend.vision = 0;
});

describe('POST /api/charts/sections', () => {
  it('writes a DRAFT, sections-only calibration on a lyrics sheet (the never-gates do not apply)', async () => {
    const res = await post(good());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ generated: true });
    expect(state.inserted).toMatchObject({
      chart_id: CHART_ID,
      source_hash: REAL_HASH,
      schema_version: 2,
      status: 'draft',
    });
    const graph = state.inserted!.graph as Record<string, unknown>;
    // Sections only: no systems, no bars, no roadmap.
    expect(Object.keys(graph)).toEqual(['sections']);
    expect(graph.sections).toEqual([
      { id: 'h1', page: 1, x: 0.1, y: 0.05, label: 'INTRO' },
      { id: 'h2', page: 1, x: 0.1, y: 0.3, label: 'VERSE 1' },
      { id: 'h3', page: 2, x: 0.1, y: 0.1, label: 'CHORUS' },
    ]);
  });

  it('works on a notation-filed chart too (a mislabeled sheet the measurement gated)', async () => {
    state.role = 'guitar';
    expect(await (await post(good())).json()).toEqual({ generated: true });
  });

  it('never spends: no key resolve, no vision call, on any path', async () => {
    await post(good());
    state.conflict = true;
    await post(good());
    await post(good({ source_hash: 'f'.repeat(64) }));
    expect(spend).toEqual({ key: 0, vision: 0 });
  });

  it('401 when signed out', async () => {
    state.user = null;
    expect((await post(good())).status).toBe(401);
  });

  it("403 on someone else's chart, and writes nothing", async () => {
    state.owned = false;
    expect((await post(good())).status).toBe(403);
    expect(state.inserted).toBeNull();
  });

  it('409 when the client read different bytes than storage holds, and writes nothing', async () => {
    const res = await post(good({ source_hash: 'a'.repeat(64) }));
    expect(res.status).toBe(409);
    expect(state.inserted).toBeNull();
  });

  it('generate-once: an existing row for these bytes is never overwritten', async () => {
    state.conflict = true;
    expect(await (await post(good())).json()).toEqual({ generated: false, reason: 'exists' });
    expect(state.inserted).toBeNull();
  });

  it('refuses a builder chart (born verified already)', async () => {
    state.sourceSpec = { sections: [] };
    expect(await (await post(good())).json()).toEqual({ generated: false, reason: 'authored' });
    expect(state.inserted).toBeNull();
  });

  it('refuses non-PDF bytes', async () => {
    state.bytes = new Uint8Array([1, 2, 3, 4, 5]);
    expect(await (await post(good())).json()).toEqual({ generated: false, reason: 'unsupported_type' });
  });

  it.each([
    ['bad chart id', { chart_id: 'nope' }],
    ['missing hash', { source_hash: undefined }],
    ['short hash', { source_hash: 'abc' }],
    ['sections not an array', { sections: 'INTRO' }],
    ['fewer than two headers', { sections: HEADERS.slice(0, 1) }],
    ['a blank label', { sections: [...HEADERS, { page: 1, x: 0.1, y: 0.9, label: '   ' }] }],
    ['x out of range', { sections: [...HEADERS, { page: 1, x: 1.2, y: 0.9, label: 'OUT' }] }],
    ['page 0', { sections: [...HEADERS, { page: 0, x: 0.1, y: 0.9, label: 'OUT' }] }],
    ['a non-object', { sections: [...HEADERS, null] }],
    ['a huge label', { sections: [...HEADERS, { page: 1, x: 0.1, y: 0.9, label: 'x'.repeat(81) }] }],
  ])('400 on %s — all or nothing, never a partial write', async (_name, over) => {
    expect((await post(good(over))).status).toBe(400);
    expect(state.inserted).toBeNull();
  });

  it('400 on malformed JSON', async () => {
    expect((await post('{')).status).toBe(400);
  });

  it('trims labels and assigns ids server-side (client ids are ignored)', async () => {
    await post(good({ sections: HEADERS.map((h, i) => ({ ...h, id: `evil-${i}`, label: ` ${h.label} ` })) }));
    const sections = (state.inserted!.graph as { sections: { id: string; label: string }[] }).sections;
    expect(sections.map((s) => s.id)).toEqual(['h1', 'h2', 'h3']);
    expect(sections.map((s) => s.label)).toEqual(['INTRO', 'VERSE 1', 'CHORUS']);
  });
});
