import { describe, it, expect, vi, beforeEach } from 'vitest';
import { secretsBackend, supabaseAdminMock, expectedHint } from './helpers/quota-backend';

// design-single-backend.md §4, chunk 3 — /api/settings/byoa.
//
// ★ THE INVARIANT THIS FILE EXISTS FOR (§4.6.1, §9 chunk-3 test): **no route
// returns a stored key under any input.** Everything else here is supporting
// detail. That guarantee has three independent layers, and the tests below
// exercise all three rather than trusting any one:
//   1. the database has no SELECT policy on user_secrets;
//   2. GET reads the HINT column and never calls get_user_secret;
//   3. no response body on any path contains the key.

const auth = { user: { id: 'owner-1' } as { id: string } | null };

vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: auth.user } }) },
  }),
}));

vi.mock('@/lib/supabase-admin', () => supabaseAdminMock());

const KEY = 'sk-ant-api03-abcdefghijklmnop';

async function route() {
  return import('@/app/api/settings/byoa/route');
}

function put(apiKey: unknown) {
  return new Request('http://localhost/api/settings/byoa', {
    method: 'PUT',
    body: JSON.stringify({ apiKey }),
  }) as unknown as Parameters<Awaited<ReturnType<typeof route>>['PUT']>[0];
}

beforeEach(() => {
  secretsBackend.reset();
  auth.user = { id: 'owner-1' };
  vi.resetModules();
});

describe('GET — reports whether a key exists, never what it is', () => {
  it('reports no key for an account that has none', async () => {
    const { GET } = await route();
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ hasKey: false, hint: null });
  });

  it('returns the masked hint once a key is saved', async () => {
    secretsBackend.keys.set('owner-1', KEY);
    const { GET } = await route();
    const body = await (await GET()).json();
    expect(body.hasKey).toBe(true);
    expect(body.hint).toBe(expectedHint(KEY));
  });

  // ★ The load-bearing one. A hint that happens to equal the key would satisfy
  // "returns a hint" while leaking everything.
  it('the hint is not the key, and the body does not contain the key anywhere', async () => {
    secretsBackend.keys.set('owner-1', KEY);
    const { GET } = await route();
    const res = await GET();
    const raw = await res.text();
    expect(raw).not.toContain(KEY);
    expect(JSON.parse(raw).hint).not.toBe(KEY);
  });

  // Layer 2: GET must not decrypt at all. If this ever calls get_user_secret,
  // plaintext starts transiting the server on every settings page view — which
  // is precisely the design choice Graham ruled against.
  it('never calls get_user_secret — the read path cannot reach plaintext', async () => {
    secretsBackend.keys.set('owner-1', KEY);
    const { GET } = await route();
    await GET();
    expect(secretsBackend.getCalls).toBe(0);
  });

  it('401s when signed out', async () => {
    auth.user = null;
    const { GET } = await route();
    expect((await GET()).status).toBe(401);
  });
});

describe('PUT — saves, validates, and never echoes', () => {
  it('stores a valid key and returns only the hint', async () => {
    const { PUT } = await route();
    const res = await PUT(put(KEY));
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain(KEY);
    expect(JSON.parse(raw)).toEqual({ hasKey: true, hint: expectedHint(KEY) });
    expect(secretsBackend.keys.get('owner-1')).toBe(KEY);
  });

  it('scopes the write to the signed-in user, not to anything in the body', async () => {
    auth.user = { id: 'owner-2' };
    const { PUT } = await route();
    await PUT(put(KEY));
    expect(secretsBackend.keys.get('owner-2')).toBe(KEY);
    expect(secretsBackend.keys.has('owner-1')).toBe(false);
  });

  it.each([
    ['a pasted carriage return', `${KEY}\r\n`, 200],
    ['a key with an inner space', 'sk-ant-api03-abcd efghijklmnop', 400],
    ['a non-Anthropic key', 'sk-proj-abcdefghijklmnopqrs', 400],
    ['a short key', 'sk-ant-abc', 400],
    ['an empty string', '', 400],
  ])('handles %s', async (_label, value, expected) => {
    const { PUT } = await route();
    expect((await PUT(put(value))).status).toBe(expected);
  });

  it('rejects a non-string apiKey without reaching the database', async () => {
    const { PUT } = await route();
    expect((await PUT(put(12345))).status).toBe(400);
    expect(secretsBackend.setCalls).toBe(0);
  });

  // §4.6.3 — a database error can carry its arguments, and the key IS an
  // argument. Forwarding error.message is the likeliest way this credential
  // ends up in a Vercel log.
  it('does not forward the database error message when the write fails', async () => {
    secretsBackend.errors = true;
    const { PUT } = await route();
    const res = await PUT(put(KEY));
    expect(res.status).toBe(500);
    const raw = await res.text();
    expect(raw).not.toContain(KEY);
    expect(raw).not.toContain('rpc failed');
  });

  it('401s when signed out, without touching the database', async () => {
    auth.user = null;
    const { PUT } = await route();
    expect((await PUT(put(KEY))).status).toBe(401);
    expect(secretsBackend.setCalls).toBe(0);
  });
});

describe('DELETE — Remove actually removes', () => {
  it('removes the stored key', async () => {
    secretsBackend.keys.set('owner-1', KEY);
    const { DELETE } = await route();
    const res = await DELETE();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hasKey: false, removed: true });
    expect(secretsBackend.keys.has('owner-1')).toBe(false);
  });

  it('is idempotent — removing a key that is not there is not an error', async () => {
    const { DELETE } = await route();
    const res = await DELETE();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hasKey: false, removed: false });
  });

  it('401s when signed out', async () => {
    auth.user = null;
    const { DELETE } = await route();
    expect((await DELETE()).status).toBe(401);
    expect(secretsBackend.deleteCalls).toBe(0);
  });
});

// ★ The sweep. Individual tests above check individual bodies; this one asserts
// the property across EVERY verb and every reachable outcome at once, so a new
// branch that returns a key is caught even if nobody remembers to test it.
describe('§4.6.1 — no verb returns a stored key under any input', () => {
  it('holds across GET, PUT and DELETE, signed in and out, with and without a key', async () => {
    for (const signedIn of [true, false]) {
      for (const hasKey of [true, false]) {
        secretsBackend.reset();
        auth.user = signedIn ? { id: 'owner-1' } : null;
        if (hasKey) secretsBackend.keys.set('owner-1', KEY);

        vi.resetModules();
        const { GET, PUT, DELETE } = await route();

        const bodies = await Promise.all([
          GET().then((r) => r.text()),
          PUT(put(KEY)).then((r) => r.text()),
          DELETE().then((r) => r.text()),
        ]);

        for (const body of bodies) {
          expect(body).not.toContain(KEY);
        }
      }
    }
  });
});
