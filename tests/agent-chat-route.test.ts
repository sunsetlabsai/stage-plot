import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { quotaBackend, secretsBackend, supabaseAdminMock } from './helpers/quota-backend';

import { NextRequest } from 'next/server';

// Design §9 test 14 — the send path verified BEHAVIORALLY, not by byte-equivalence
// with the code it replaced. Byte-equivalence would just freeze the old shape,
// including the config read §4.1 deliberately changes.
//
// This route had ZERO tests before chunk 1, so the extraction had no safety net at
// all: a green suite proved nothing about it. These assert the observable contract —
// which key is proxied, which model, which status, which headers.

const redis = {
  connectThrows: false,
  store: new Map<string, string>(),
  incrCalls: 0,
};


// Quota moved off Redis onto two Supabase RPCs (chunk 2).
vi.mock('@/lib/supabase-admin', () => supabaseAdminMock());

// Chunk 3: a keyless send now resolves the session to look for an ACCOUNT key
// (§4.5). These cases are anonymous try-it traffic, so getUser returns nobody.
//
// ⚠ This mock is load-bearing, not scaffolding. The route wraps the lookup in
// try/catch so an auth outage cannot 500 an anonymous send — which means that
// WITHOUT this mock these tests would still pass, via the catch, while proving
// nothing about the path they claim to cover. `sessionUser` lets a test opt
// into a signed-in caller instead.
const session: { user: { id: string } | null; throws: boolean } = { user: null, throws: false };

vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: async () => {
    if (session.throws) throw new Error('auth unreachable');
    return {
      auth: { getUser: async () => ({ data: { user: session.user } }) },
    };
  },
}));

vi.mock('redis', () => ({
  createClient: () => ({
    isOpen: true,
    connect: async () => {
      if (redis.connectThrows) throw new Error('ECONNREFUSED');
    },
    get: async (k: string) => redis.store.get(k) ?? null,
    set: async (k: string, v: string) => {
      redis.store.set(k, v);
    },
    incr: async (k: string) => {
      redis.incrCalls++;
      const n = Number(redis.store.get(k) ?? 0) + 1;
      redis.store.set(k, String(n));
      return n;
    },
    expire: async () => 1,
    ping: async () => 'PONG',
    disconnect: async () => undefined,
  }),
}));

const ENV = { ...process.env };
let sent: { url: string; init: RequestInit } | null = null;

/** A minimal Anthropic streaming response — enough for the route to hand back a body. */
function anthropicOk() {
  return new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('event: message_stop\ndata: {}\n\n'));
        c.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

beforeEach(() => {
  redis.connectThrows = false;
  redis.store.clear();
  redis.incrCalls = 0;
  quotaBackend.reset();
  secretsBackend.reset();
  session.user = null;
  session.throws = false;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
  sent = null;
  process.env.REDIS_URL = 'redis://test';
  delete process.env.CLAUDE_TRYIT_KEY;
  vi.resetModules();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    sent = { url, init };
    return anthropicOk();
  }));
});

afterEach(() => {
  process.env = { ...ENV };
  vi.unstubAllGlobals();
});

const post = async (headers: Record<string, string> = {}) => {
  const { POST } = await import('../app/api/agent/chat/route');
  const req = new NextRequest('http://localhost/api/agent/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  return POST(req);
};

const proxiedKey = () =>
  (sent?.init.headers as Record<string, string> | undefined)?.['x-api-key'];
const proxiedBody = () => JSON.parse(String(sent?.init.body));

describe('POST /api/agent/chat — BYOA wins over try-it', () => {
  it('proxies the caller key even when a server key is configured', async () => {
    process.env.CLAUDE_TRYIT_KEY = 'sk-ant-server';
    const res = await post({ authorization: 'Bearer sk-ant-mine' });
    expect(res.status).toBe(200);
    expect(proxiedKey()).toBe('sk-ant-mine');
  });

  it('spends no try-it quota on a BYOA send', async () => {
    process.env.CLAUDE_TRYIT_KEY = 'sk-ant-server';
    await post({ authorization: 'Bearer sk-ant-mine' });
    expect(quotaBackend.incrCalls).toBe(0);
  });

  it('uses the BYOA token ceiling, not the try-it one', async () => {
    const { BYOA_MAX_TOKENS } = await import('../lib/agent-key');
    await post({ authorization: 'Bearer sk-ant-mine' });
    expect(proxiedBody().max_tokens).toBe(BYOA_MAX_TOKENS);
  });
});

describe('POST /api/agent/chat — try-it', () => {
  it('proxies the server key and decrements the quota once', async () => {
    process.env.CLAUDE_TRYIT_KEY = 'sk-ant-server';
    const res = await post();
    expect(res.status).toBe(200);
    expect(proxiedKey()).toBe('sk-ant-server');
    expect(quotaBackend.incrCalls).toBe(1);
  });

  it('uses the try-it token ceiling', async () => {
    process.env.CLAUDE_TRYIT_KEY = 'sk-ant-server';
    const { TRYIT_MAX_TOKENS } = await import('../lib/agent-key');
    await post();
    expect(proxiedBody().max_tokens).toBe(TRYIT_MAX_TOKENS);
  });

  // Codex R1 residual note on #131: the SUCCESS-path header was unasserted, so a
  // regression dropping it would not have failed anything. The client reads this to
  // show its remaining count, and losing it degrades silently — the exact class of
  // "works until someone looks" defect this design exists to remove.
  it('reports the remaining count on a successful try-it send', async () => {
    process.env.CLAUDE_TRYIT_KEY = 'sk-ant-server';
    const { TRYIT_QUOTA } = await import('../lib/agent-key');
    const res = await post();
    expect(res.headers.get('X-Tryit-Remaining')).toBe(String(TRYIT_QUOTA - 1));
  });

  it('omits the remaining header on a BYOA send, which has no quota', async () => {
    const res = await post({ authorization: 'Bearer sk-ant-mine' });
    expect(res.headers.get('X-Tryit-Remaining')).toBeNull();
  });

  it('429s with tryitExhausted once the allowance is spent', async () => {
    process.env.CLAUDE_TRYIT_KEY = 'sk-ant-server';
    const { TRYIT_QUOTA } = await import('../lib/agent-key');
    quotaBackend.seed('unknown', TRYIT_QUOTA);
    const res = await post();
    expect(res.status).toBe(429);
    const body = await res.json();
    // The client keys its exhausted state off this flag; losing it would silently
    // reopen the infinite-retry dead end §2 describes.
    expect(body.tryitExhausted).toBe(true);
    expect(res.headers.get('X-Tryit-Remaining')).toBe('0');
  });

  it('never calls Anthropic on an exhausted send', async () => {
    process.env.CLAUDE_TRYIT_KEY = 'sk-ant-server';
    const { TRYIT_QUOTA } = await import('../lib/agent-key');
    quotaBackend.seed('unknown', TRYIT_QUOTA);
    await post();
    expect(sent).toBeNull();
  });
});

describe('POST /api/agent/chat — no key available', () => {
  it('401s when nothing is configured, tagged unconfigured', async () => {
    const res = await post();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.reason).toBe('unconfigured');
  });

  // The `reason: 'error'` counterpart is DELETED (design-single-backend §3.2).
  // It distinguished "no key AND the store was unreachable" from "no key", and
  // config no longer has a store to be unreachable. What survives is the rule
  // that an unreachable Redis must not change the answer at all.
  it('401s as unconfigured — not error — when Redis is unreachable', async () => {
    redis.connectThrows = true;
    const res = await post();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.reason).toBe('unconfigured');
  });

  it('still works off the env var when the store is unreachable', async () => {
    redis.connectThrows = true;
    process.env.CLAUDE_TRYIT_KEY = 'sk-ant-env';
    const res = await post();
    expect(res.status).toBe(200);
    expect(proxiedKey()).toBe('sk-ant-env');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Chunk 3 — the account-stored key reaches the send path (§4.5).
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/agent/chat — the account key', () => {
  it('proxies a signed-in user\'s stored key instead of spending the try-it quota', async () => {
    session.user = { id: 'owner-1' };
    secretsBackend.keys.set('owner-1', 'sk-ant-account-stored');
    process.env.CLAUDE_TRYIT_KEY = 'sk-ant-shared';

    const res = await post();
    expect(res.status).toBe(200);
    expect(proxiedKey()).toBe('sk-ant-account-stored');
    // The whole point: BYOA does not consume the shared allowance.
    expect(quotaBackend.calls).toBe(0);
  });

  it('spends the try-it quota when the signed-in user has stored no key', async () => {
    session.user = { id: 'owner-nokey' };
    process.env.CLAUDE_TRYIT_KEY = 'sk-ant-shared';

    const res = await post();
    expect(res.status).toBe(200);
    expect(proxiedKey()).toBe('sk-ant-shared');
    expect(quotaBackend.calls).toBeGreaterThan(0);
  });

  // ★ THE REGRESSION GUARD. Before chunk 3 this route touched no session at
  // all, so an anonymous free message could not be broken by an auth problem.
  // Resolving the session unguarded would hand every keyless send a new way to
  // 500 — for users who are not signed in and never needed to be.
  it('still serves an anonymous send when session resolution throws', async () => {
    session.throws = true;
    process.env.CLAUDE_TRYIT_KEY = 'sk-ant-shared';

    const res = await post();
    expect(res.status).toBe(200);
    expect(proxiedKey()).toBe('sk-ant-shared');
  });

  it('does not resolve a session at all when the request brings its own key', async () => {
    session.throws = true; // would blow up if consulted
    const res = await post({ authorization: 'Bearer sk-ant-device' });
    expect(res.status).toBe(200);
    expect(proxiedKey()).toBe('sk-ant-device');
    expect(secretsBackend.calls).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// design-account-key-recovery §3 — the server names the rejected key's source.
//
// Three of the route's 401s look alike on the wire (a rejected key says "Invalid
// API key"); only a BYOA rejection is the user's to fix. `keyReject` carries the
// distinction so the client shows the right recovery — and NEVER for the shared
// try-it key or the unconfigured case, which the user cannot fix.
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/agent/chat — keyReject on a rejected key', () => {
  /** Make Anthropic reject whatever key the route proxies. */
  function anthropicRejects() {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      sent = { url, init };
      return new Response('{"error":{"type":"authentication_error"}}', { status: 401 });
    }));
  }

  it('tags a rejected DEVICE key with keyReject: "device"', async () => {
    anthropicRejects();
    const res = await post({ authorization: 'Bearer sk-ant-device-bad' });
    expect(res.status).toBe(401);
    expect((await res.json()).keyReject).toBe('device');
  });

  it('tags a rejected ACCOUNT key with keyReject: "account"', async () => {
    anthropicRejects();
    session.user = { id: 'owner-bad' };
    secretsBackend.keys.set('owner-bad', 'sk-ant-account-bad');

    const res = await post();
    expect(res.status).toBe(401);
    expect((await res.json()).keyReject).toBe('account');
  });

  it('does NOT tag a rejected shared try-it key — a platform fault, not the user\'s', async () => {
    anthropicRejects();
    process.env.CLAUDE_TRYIT_KEY = 'sk-ant-shared-bad';

    const res = await post();
    expect(res.status).toBe(401);
    // Byte-identical error to a BYOA rejection, but the user holds no key to fix, so
    // the client must get no banner signal.
    expect((await res.json()).keyReject).toBeUndefined();
  });

  it('the unconfigured 401 (no key at all) also carries no keyReject', async () => {
    const res = await post();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.reason).toBe('unconfigured');
    expect(body.keyReject).toBeUndefined();
  });

  it('carries no key material in the keyReject 401 body', async () => {
    anthropicRejects();
    const res = await post({ authorization: 'Bearer sk-ant-device-SECRETVALUE-1234' });
    const raw = await res.text();

    expect(res.status).toBe(401);
    expect(raw).not.toContain('sk-ant-device-SECRETVALUE-1234');
    expect(raw).not.toContain('SECRETVALUE');
    expect(JSON.parse(raw).keyReject).toBe('device');
  });
});
