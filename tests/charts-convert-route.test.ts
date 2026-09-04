import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── B2b: the convert route's measured extension ──────────────────────────────
//
// docs/design-chart-measurement.md §Payload and route extension. The route is where the
// owner's AI budget is actually spent and where the one insert-only calibration write
// lives, so these tests assert the ORDER and the REFUSALS, not just the happy path:
//
//   hash → (gate) → vision UNCONDITIONALLY → branch on roadmap → validate → insert-only
//
// The two things a green suite must not be able to hide: a gated chart that still paid
// for vision, and a measured payload committed against bytes it never measured.

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // "%PDF-1.7"

const state = {
  visionCalls: 0,
  /** What the model "sees". Roadmap non-empty ⇒ today's path must win. */
  roadmap: [] as unknown[],
  inserted: null as null | Record<string, unknown>,
  existingRow: null as null | { chart_id: string },
  role: 'guitar',
  sourceSpec: null as unknown,
};

vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'owner-1' } } }) },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { storage_path: 'owner-1/x.pdf', role: state.role, source_spec: state.sourceSpec },
            }),
          }),
        }),
      }),
      upsert: (row: Record<string, unknown>) => {
        state.inserted = row;
        return { select: async () => ({ data: [{ chart_id: row.chart_id }], error: null }) };
      },
    }),
  }),
}));

vi.mock('@/lib/supabase-admin', () => ({
  getSupabaseAdmin: () => ({
    storage: {
      from: () => ({ download: async () => ({ data: new Blob([PDF as BlobPart]), error: null }) }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.existingRow }) }) }),
      }),
    }),
  }),
}));

vi.mock('@/lib/admin-config', () => ({ getAdminConfig: async () => 'sk-test' }));

vi.mock('@/lib/chart-vision', () => ({
  VISION_TIMEOUT_MS: 50_000,
  extractChartVision: async () => {
    state.visionCalls++;
    return {
      // Deliberately DIFFERENT geometry from the measured payload, so which one got
      // installed is decidable from the stored row rather than by inspection.
      systems: [{ page: 1, yTop: 0.5, yBottom: 0.6, xStart: 0.2, xEnd: 0.8 }],
      bars: [{ systemIndex: 0, xStart: 0.2, xEnd: 0.8 }],
      sections: [{ page: 1, x: 0.05, y: 0.05, label: 'Intro' }],
      roadmap: state.roadmap,
    };
  },
}));

const { POST } = await import('@/app/api/charts/convert/route');
const { hashPdfBytes } = await import('@/lib/chart-calibration');

const CHART_ID = '11111111-2222-4333-8444-555555555555';
const REAL_HASH = await hashPdfBytes(PDF);

function post(body: unknown) {
  return POST(
    new NextRequest('http://localhost/api/charts/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

/** A measured payload the engine could plausibly have produced. */
function measured(over: Partial<{ classification: string; complete: boolean }> = {}) {
  return {
    pages: [{ pageNumber: 1, classification: over.classification ?? 'notation', complete: over.complete ?? true }],
    systems: [{ id: 's1', page: 1, yTop: 0.1, yBottom: 0.2, xStart: 0.1, xEnd: 0.9, verdict: 'validated' }],
    bars: [
      { id: 'b1', systemId: 's1', xStart: 0.1, xEnd: 0.5, absNumber: 1, sectionId: null },
      { id: 'b2', systemId: 's1', xStart: 0.5, xEnd: 0.9, absNumber: 2, sectionId: null, measures: 4 },
    ],
  };
}

const graph = () => (state.inserted!.graph as { systems: { yTop: number }[]; bars: { measures?: number }[] });

beforeEach(() => {
  state.visionCalls = 0;
  state.roadmap = [];
  state.inserted = null;
  state.existingRow = null;
  state.role = 'guitar';
  state.sourceSpec = null;
});

describe('the legacy request is untouched', () => {
  it('{ chart_id } alone still takes today\'s vision path and writes VLM geometry', async () => {
    // This is exactly what triggerOverlayCreate posts today. If B2b changed anything
    // here, every client that cannot measure would have broken.
    const res = await post({ chart_id: CHART_ID });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ generated: true });
    expect(state.visionCalls).toBe(1);
    expect(graph().systems[0].yTop).toBe(0.5); // the VLM's, not the engine's
  });
});

describe('the two optional fields are not independently optional', () => {
  it('measured with NO source_hash is a 400, not a silent commit', async () => {
    const res = await post({ chart_id: CHART_ID, measured: measured() });
    expect(res.status).toBe(400);
    expect(state.visionCalls).toBe(0);
    expect(state.inserted).toBeNull();
  });

  it('a malformed measured payload is a 400', async () => {
    const res = await post({ chart_id: CHART_ID, source_hash: REAL_HASH, measured: { pages: [] } });
    expect(res.status).toBe(400);
    expect(state.inserted).toBeNull();
  });

  it('★ a source_hash for bytes we did not store is a 409 — before any AI spend', async () => {
    // The client may have measured a stale Cache-API copy. Stale geometry must never be
    // insertable under the current hash: that is what makes "an overlay applies only to
    // the bytes it was built for" true for machine writes.
    const res = await post({ chart_id: CHART_ID, source_hash: 'deadbeef', measured: measured() });
    expect(res.status).toBe(409);
    expect(state.visionCalls).toBe(0);
    expect(state.inserted).toBeNull();
  });

  it('a source_hash WITHOUT measured is ignored, exactly as before', async () => {
    const res = await post({ chart_id: CHART_ID, source_hash: 'deadbeef' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ generated: true });
  });
});

describe('the zero-staves never-gate', () => {
  it('★ refuses BEFORE the vision call — the gate exists to save the call', async () => {
    const res = await post({
      chart_id: CHART_ID,
      source_hash: REAL_HASH,
      measured: measured({ classification: 'not-notation' }),
    });
    expect(await res.json()).toEqual({ generated: false, reason: 'not_notation' });
    expect(state.visionCalls).toBe(0);
    expect(state.inserted).toBeNull();
  });

  it('★ NEGATIVE CONTROL — the same page with incomplete geometry is NOT gated', async () => {
    // Evidence of absence vs absence of evidence. This one must reach the VLM.
    const res = await post({
      chart_id: CHART_ID,
      source_hash: REAL_HASH,
      measured: measured({ classification: 'not-notation', complete: false }),
    });
    expect(await res.json()).toMatchObject({ generated: true });
    expect(state.visionCalls).toBe(1);
  });

  it('an existing row still wins over the gate — a fact beats a policy', async () => {
    state.existingRow = { chart_id: CHART_ID };
    const res = await post({
      chart_id: CHART_ID,
      source_hash: REAL_HASH,
      measured: measured({ classification: 'not-notation' }),
    });
    expect(await res.json()).toEqual({ generated: false, reason: 'exists' });
  });

  it('the row-level gates still fire first, with no download or measurement', async () => {
    state.role = 'Lyrics';
    expect(await (await post({ chart_id: CHART_ID })).json()).toEqual({
      generated: false,
      reason: 'lyrics',
    });
  });
});

describe('the roadmap-presence branch', () => {
  it('empty roadmap ⇒ measured geometry is installed beside the VLM sections', async () => {
    const res = await post({ chart_id: CHART_ID, source_hash: REAL_HASH, measured: measured() });
    expect(res.status).toBe(200);
    expect(state.visionCalls).toBe(1); // unconditional: it supplies the sections
    expect(graph().systems[0].yTop).toBe(0.1); // the engine's
    expect(graph().bars).toHaveLength(2);
    expect(graph().bars[1].measures).toBe(4); // the multirest count survives the write
    expect((state.inserted!.graph as { sections: unknown[] }).sections).toHaveLength(1);
  });

  it('★ non-empty roadmap ⇒ the measurement is DISCARDED for today\'s path', async () => {
    // Roadmap markers bind through the VLM's own bar indices. Installing measured bars
    // underneath would either fail to resolve or bind a repeat to the wrong bar and pass
    // validation — the worse failure. So the whole VLM calibration wins, unchanged.
    state.roadmap = [
      { kind: 'repeatStart', barIndex: 0 },
      { kind: 'repeatEnd', barIndex: 0, repeatStartBarIndex: 0 },
    ];
    const res = await post({ chart_id: CHART_ID, source_hash: REAL_HASH, measured: measured() });
    expect(res.status).toBe(200);
    expect(graph().systems[0].yTop).toBe(0.5); // the VLM's
    expect(graph().bars).toHaveLength(1);
    expect(graph().bars[0].measures).toBeUndefined();
  });

  it('a fallback-disposition payload takes today\'s path too', async () => {
    const res = await post({
      chart_id: CHART_ID,
      source_hash: REAL_HASH,
      measured: measured({ complete: false }),
    });
    expect(res.status).toBe(200);
    expect(graph().systems[0].yTop).toBe(0.5);
  });
});
