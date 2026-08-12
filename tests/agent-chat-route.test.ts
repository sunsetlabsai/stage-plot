import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    redis.store.set('admin:claude_tryit_key', 'sk-ant-server');
    const res = await post({ authorization: 'Bearer sk-ant-mine' });
    expect(res.status).toBe(200);
    expect(proxiedKey()).toBe('sk-ant-mine');
  });

  it('spends no try-it quota on a BYOA send', async () => {
    redis.store.set('admin:claude_tryit_key', 'sk-ant-server');
    await post({ authorization: 'Bearer sk-ant-mine' });
    expect(redis.incrCalls).toBe(0);
  });

  it('uses the BYOA token ceiling, not the try-it one', async () => {
    const { BYOA_MAX_TOKENS } = await import('../lib/agent-key');
    await post({ authorization: 'Bearer sk-ant-mine' });
    expect(proxiedBody().max_tokens).toBe(BYOA_MAX_TOKENS);
  });
});

describe('POST /api/agent/chat — try-it', () => {
  it('proxies the server key and decrements the quota once', async () => {
    redis.store.set('admin:claude_tryit_key', 'sk-ant-server');
    const res = await post();
    expect(res.status).toBe(200);
    expect(proxiedKey()).toBe('sk-ant-server');
    expect(redis.incrCalls).toBe(1);
  });

  it('uses the try-it token ceiling', async () => {
    redis.store.set('admin:claude_tryit_key', 'sk-ant-server');
    const { TRYIT_MAX_TOKENS } = await import('../lib/agent-key');
    await post();
    expect(proxiedBody().max_tokens).toBe(TRYIT_MAX_TOKENS);
  });

  it('429s with tryitExhausted once the allowance is spent', async () => {
    redis.store.set('admin:claude_tryit_key', 'sk-ant-server');
    const { TRYIT_QUOTA } = await import('../lib/agent-key');
    redis.store.set('quota:unknown', String(TRYIT_QUOTA));
    const res = await post();
    expect(res.status).toBe(429);
    const body = await res.json();
    // The client keys its exhausted state off this flag; losing it would silently
    // reopen the infinite-retry dead end §2 describes.
    expect(body.tryitExhausted).toBe(true);
    expect(res.headers.get('X-Tryit-Remaining')).toBe('0');
  });

  it('never calls Anthropic on an exhausted send', async () => {
    redis.store.set('admin:claude_tryit_key', 'sk-ant-server');
    const { TRYIT_QUOTA } = await import('../lib/agent-key');
    redis.store.set('quota:unknown', String(TRYIT_QUOTA));
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

  // The user-facing copy converges on the same 401, but the DATA must not — this is
  // the diagnostic that made "my account has no AI key" answerable (§0 invariant 2).
  it('401s when the store is unreachable, tagged error — distinct from unconfigured', async () => {
    redis.connectThrows = true;
    const res = await post();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.reason).toBe('error');
  });

  it('still works off the env var when the store is unreachable', async () => {
    redis.connectThrows = true;
    process.env.CLAUDE_TRYIT_KEY = 'sk-ant-env';
    const res = await post();
    expect(res.status).toBe(200);
    expect(proxiedKey()).toBe('sk-ant-env');
  });
});
