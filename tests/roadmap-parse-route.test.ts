import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// UAT S15 / design-ai-key-availability §13: the roadmap parse route answered every
// request with 503 "Parser is not configured" when the platform key was unset —
// even for text the no-AI grammar transcribes whole — and never used the owner's
// own key. Now: grammar first with no key at all; then the AI tab's resolver; and
// each key failure says what it is, with a reason the client turns into a Settings link.

const state = {
  key: { mode: 'unconfigured' } as Record<string, unknown>,
  keyCalls: 0,
  modelCalls: [] as string[],
  modelError: null as unknown,
};

vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'owner-1' } } }) } }),
}));

vi.mock('@/lib/agent-key', async (orig) => ({
  ...(await orig<typeof import('@/lib/agent-key')>()),
  resolveChartKey: async () => {
    state.keyCalls++;
    return state.key;
  },
}));

vi.mock('@/lib/roadmap-parse', async (orig) => ({
  ...(await orig<typeof import('@/lib/roadmap-parse')>()),
  parseWithModel: async (_d: string, _k: string, apiKey: string) => {
    state.modelCalls.push(apiKey);
    if (state.modelError) throw state.modelError;
    return { ok: false, errors: ['model ran'] };
  },
}));

const { POST } = await import('@/app/api/charts/roadmap/parse/route');
const Anthropic = (await import('@anthropic-ai/sdk')).default;
const { CHART_KEY_COPY } = await import('@/lib/chart-key-copy');

const GRAMMAR = 'Verse: 2 bars D, 2 bars G7';
const PROSE = 'a slow blues with a turnaround, the usual stuff';

function post(description: string) {
  return POST(
    new NextRequest('http://localhost/api/charts/roadmap/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description, key: 'D' }),
    }),
  );
}

beforeEach(() => {
  state.key = { mode: 'unconfigured' };
  state.keyCalls = 0;
  state.modelCalls = [];
  state.modelError = null;
});

describe('the grammar needs no key (UAT S15)', () => {
  it('a grammar-able description parses with NO key configured, and never asks for one', async () => {
    const res = await post(GRAMMAR);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(state.keyCalls).toBe(0); // no resolver ⇒ no try-it quota spent
    expect(state.modelCalls).toHaveLength(0);
  });
});

describe('a grammar miss resolves a key like the AI tab (§13.4)', () => {
  it('unconfigured ⇒ 503 with the Settings copy and reason no_key — not "Parser is not configured"', async () => {
    const res = await post(PROSE);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: CHART_KEY_COPY.parse.unconfigured, reason: 'no_key' });
    expect(state.modelCalls).toHaveLength(0);
  });

  it('try-it used up ⇒ 429, reason no_key', async () => {
    state.key = { mode: 'exhausted' };
    const res = await post(PROSE);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: CHART_KEY_COPY.parse.exhausted, reason: 'no_key' });
  });

  it("the owner's key is the one the model is called with", async () => {
    state.key = { mode: 'byoa', source: 'device', apiKey: 'sk-mine', model: 'm', maxTokens: 1 };
    const res = await post(PROSE);
    expect(res.status).toBe(200);
    expect(state.modelCalls).toEqual(['sk-mine']);
  });

  it("the owner's own key rejected ⇒ 401, reason key_rejected", async () => {
    state.key = { mode: 'byoa', source: 'account', apiKey: 'sk-bad', model: 'm', maxTokens: 1 };
    state.modelError = new Anthropic.AuthenticationError(401, { type: 'error' }, 'invalid x-api-key', new Headers());
    const res = await post(PROSE);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: CHART_KEY_COPY.parse.rejected, reason: 'key_rejected' });
  });

  it('the PLATFORM key rejected stays a generic 502 — ours to fix, so no Settings link', async () => {
    state.key = { mode: 'tryit', apiKey: 'sk-platform', model: 'm', maxTokens: 1, remaining: 3 };
    state.modelError = new Anthropic.AuthenticationError(401, { type: 'error' }, 'invalid x-api-key', new Headers());
    const res = await post(PROSE);
    expect(res.status).toBe(502);
    expect((await res.json()).reason).toBeUndefined();
  });
});
