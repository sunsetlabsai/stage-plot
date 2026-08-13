import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { TRYIT_QUOTA } from '../lib/agent-key';
import { PROBE_RATE_LIMIT_MAX } from '../lib/admin-rate-limit';

// Design docs/design-ai-key-availability.md §9 tests 1–6, 6a–6d and 8, chunk 2.
//
// Every count and ceiling below is read from the imported constant, never written as a
// literal (§4, Codex R2 medium): §7 raises TRYIT_QUOTA to 50, and a test with 10 baked
// into it would have gone green while disagreeing with the sender.

const KEY_IN_STORE = 'sk-ant-redis-SUPERSECRET-aaaa';
const KEY_IN_ENV = 'sk-ant-env-ALSOSECRET-bbbb';

const redis = {
  connectThrows: false,
  store: new Map<string, string>(),
  incrCalls: 0,
  expireCalls: 0,
  /**
   * Every key passed to GET. Codex R1 non-blocking, and correct: asserting the quota
   * key was not created/INCRed/EXPIREd could not detect a wasted READ, because a GET
   * creates nothing. "Never touches the quota store" has to include reads.
   */
  getKeys: [] as string[],
  /**
   * Keys whose GET throws, with connect still succeeding. Needed because
   * `connectThrows` makes a quota-read assertion VACUOUS — nothing can record a read
   * that dies at connect, so the test would pass whether or not the code read quota.
   */
  getThrowsFor: new Set<string>(),
};

/** Quota keys read this test — the assertion Codex's note asked for. */
const quotaReads = () => redis.getKeys.filter((k) => k.startsWith('quota:'));

vi.mock('redis', () => ({
  createClient: () => ({
    isOpen: true,
    connect: async () => {
      if (redis.connectThrows) throw new Error('ECONNREFUSED');
    },
    get: async (k: string) => {
      redis.getKeys.push(k);
      if (redis.getThrowsFor.has(k)) throw new Error(`read failed: ${k}`);
      return redis.store.get(k) ?? null;
    },
    set: async (k: string, v: string) => {
      redis.store.set(k, v);
    },
    incr: async (k: string) => {
      redis.incrCalls++;
      const n = Number(redis.store.get(k) ?? 0) + 1;
      redis.store.set(k, String(n));
      return n;
    },
    expire: async () => {
      redis.expireCalls++;
      return 1;
    },
    ping: async () => 'PONG',
    disconnect: async () => undefined,
  }),
}));

const ENV = { ...process.env };
const IP = '203.0.113.7';

beforeEach(() => {
  redis.connectThrows = false;
  redis.store.clear();
  redis.incrCalls = 0;
  redis.expireCalls = 0;
  redis.getKeys = [];
  redis.getThrowsFor.clear();
  process.env.REDIS_URL = 'redis://test';
  delete process.env.CLAUDE_TRYIT_KEY;
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ENV };
  vi.unstubAllGlobals();
  vi.doUnmock('@/lib/agent-key');
});

/** Configure try-it as it is in production: the key lives in Redis, not the env. */
function keyInStore() {
  redis.store.set('admin:claude_tryit_key', KEY_IN_STORE);
}

const probe = async (ip: string = IP) => {
  const { GET } = await import('../app/api/agent/capabilities/route');
  const req = new NextRequest('http://localhost/api/agent/capabilities', {
    headers: { 'x-forwarded-for': ip },
  });
  return GET(req);
};

const send = async (ip: string = IP) => {
  const { POST } = await import('../app/api/agent/chat/route');
  const req = new NextRequest('http://localhost/api/agent/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  return POST(req);
};

/** A minimal Anthropic streaming response, so a send in test 8 completes. */
function stubAnthropic() {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('event: message_stop\ndata: {}\n\n'));
          c.close();
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ),
  ));
}

describe('GET /api/agent/capabilities — the four states (§9 tests 1–3)', () => {
  it('reports unconfigured, and never touches the quota store (test 1)', async () => {
    const res = await probe();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tryit: 'unconfigured',
      tryitRemaining: null,
      quota: TRYIT_QUOTA,
    });
    // The assertion that matters: with no key there is nothing to meter, so the
    // quota key must not be READ, written or expired. The read half is the one the
    // other three cannot cover — a GET creates no key, so §4's "do not touch the
    // store" would have passed while the route round-tripped to Redis for nothing.
    expect(quotaReads()).toEqual([]);
    expect(redis.store.has(`quota:${IP}`)).toBe(false);
    expect(redis.incrCalls).toBe(0);
    expect(redis.expireCalls).toBe(0);
  });

  it('does not read the quota store on error either', async () => {
    // Same rule one branch over: §4 says do not touch the store for BOTH none and
    // error. Deliberately NOT using connectThrows — with connect broken, no read can
    // be recorded at all, so the assertion would hold vacuously and pass against a
    // route that read quota first. Here the store is reachable and only the CONFIG
    // read fails, which is the one arrangement where a wasted quota read is visible.
    redis.getThrowsFor.add('admin:claude_tryit_key');

    expect((await (await probe()).json()).tryit).toBe('error');
    expect(quotaReads()).toEqual([]);
    expect(redis.incrCalls).toBe(0);
  });

  it('DOES read the quota store once a key resolves, proving the assertion has teeth', async () => {
    // Without this, the two tests above would also pass against a route that never
    // consulted the quota store at all.
    keyInStore();

    await probe();

    expect(quotaReads()).toEqual([`quota:${IP}`]);
  });

  it('reports available with remaining reflecting an existing count (test 2)', async () => {
    keyInStore();
    redis.store.set(`quota:${IP}`, '3');

    const body = await (await probe()).json();

    expect(body.tryit).toBe('available');
    expect(body.tryitRemaining).toBe(TRYIT_QUOTA - 3);
  });

  it('reports exhausted once usage reaches the quota constant (test 3)', async () => {
    keyInStore();
    redis.store.set(`quota:${IP}`, String(TRYIT_QUOTA));

    const body = await (await probe()).json();

    expect(body.tryit).toBe('exhausted');
    expect(body.tryitRemaining).toBe(0);
  });

  it('reports exhausted past the quota too, never a negative remaining', async () => {
    keyInStore();
    redis.store.set(`quota:${IP}`, String(TRYIT_QUOTA + 5));

    const body = await (await probe()).json();

    expect(body.tryit).toBe('exhausted');
    expect(body.tryitRemaining).toBe(0);
  });

  it('serializes quota from the constant in every state (test 6d)', async () => {
    // Walked across states so a hard-coded literal cannot hide in one branch.
    const unconfigured = await (await probe()).json();
    keyInStore();
    vi.resetModules();
    const available = await (await probe()).json();

    expect(unconfigured.quota).toBe(TRYIT_QUOTA);
    expect(available.quota).toBe(TRYIT_QUOTA);
  });
});

describe('GET /api/agent/capabilities — the probe carries no key material (§9 test 4)', () => {
  it('leaks neither the key, its prefix nor its length, in any state', async () => {
    keyInStore();
    process.env.CLAUDE_TRYIT_KEY = KEY_IN_ENV;

    for (const count of ['0', String(TRYIT_QUOTA)]) {
      redis.store.set(`quota:${IP}`, count);
      vi.resetModules();
      const res = await probe();
      const raw = await res.text();

      expect(raw).not.toContain(KEY_IN_STORE);
      expect(raw).not.toContain(KEY_IN_ENV);
      expect(raw).not.toContain('SUPERSECRET');
      expect(raw).not.toContain('ALSOSECRET');
      expect(raw).not.toContain('sk-ant');
      // Length is a leak too — §4 forbids the length as explicitly as the value.
      expect(raw).not.toContain(String(KEY_IN_STORE.length));
      // Whatever it does carry is exactly the documented three fields.
      expect(Object.keys(JSON.parse(raw)).sort()).toEqual([
        'quota',
        'tryit',
        'tryitRemaining',
      ]);
    }
  });
});

describe('GET /api/agent/capabilities — a probe must not cost a message (§9 test 5)', () => {
  it('does not increment: probing twice leaves the count untouched', async () => {
    keyInStore();
    redis.store.set(`quota:${IP}`, '4');

    const first = await (await probe()).json();
    const second = await (await probe()).json();

    expect(first.tryitRemaining).toBe(TRYIT_QUOTA - 4);
    expect(second.tryitRemaining).toBe(TRYIT_QUOTA - 4);
    expect(redis.store.get(`quota:${IP}`)).toBe('4');
    expect(redis.incrCalls).toBe(0);
    // A peek must not set a TTL either — that would silently extend an allowance.
    expect(redis.expireCalls).toBe(0);
  });

  it('does not seed a quota key for an IP that has never sent (test 5)', async () => {
    keyInStore();

    const body = await (await probe('198.51.100.22')).json();

    expect(body.tryit).toBe('available');
    expect(body.tryitRemaining).toBe(TRYIT_QUOTA);
    expect(redis.store.has('quota:198.51.100.22')).toBe(false);
  });
});

describe('GET /api/agent/capabilities — §4.1 status-aware read (§9 tests 6, 6a–6c)', () => {
  it('reports error, NOT unconfigured, when the store is unreachable with no env fallback (6a)', async () => {
    redis.connectThrows = true;

    const body = await (await probe()).json();

    // This is the regression the v2 spec could not have passed: getAdminConfig
    // swallowed the outage and returned null, identical to "nothing configured".
    expect(body.tryit).toBe('error');
    expect(body.tryitRemaining).toBe(null);
  });

  it('reports available when the store is unreachable but the env var is set (6b)', async () => {
    redis.connectThrows = true;
    process.env.CLAUDE_TRYIT_KEY = KEY_IN_ENV;

    const body = await (await probe()).json();

    // A store outage with a working fallback is not an error for the USER. §6 gap 1
    // is the coupled half: /admin has to report the outage independently.
    expect(body.tryit).toBe('available');
    expect(body.tryitRemaining).toBe(TRYIT_QUOTA);
  });

  it('returns a usable answer over the in-memory fallback, not a 500 (test 6)', async () => {
    redis.connectThrows = true;
    process.env.CLAUDE_TRYIT_KEY = KEY_IN_ENV;

    const res = await probe();

    expect(res.status).toBe(200);
    expect((await res.json()).tryit).toBe('available');
  });

  it('treats the __DISABLED__ sentinel as unconfigured, keeping the env var suppressed (6c)', async () => {
    redis.store.set('admin:claude_tryit_key', '__DISABLED__');
    process.env.CLAUDE_TRYIT_KEY = KEY_IN_ENV;

    const body = await (await probe()).json();

    expect(body.tryit).toBe('unconfigured');
    expect(body.tryitRemaining).toBe(null);
  });

  it('reports unconfigured, not error, when REDIS_URL is absent entirely', async () => {
    delete process.env.REDIS_URL;

    const body = await (await probe()).json();

    // No Redis configured is a deployment CHOICE, not an outage. Reporting it as
    // error would send an operator hunting a store that was never meant to exist.
    expect(body.tryit).toBe('unconfigured');
  });
});

describe('GET /api/agent/capabilities — probe and send share ONE counter (§9 test 8)', () => {
  it('sees the send it followed, with Redis unavailable, decrementing by exactly 1', async () => {
    // The point of the §4 extraction. If either route re-declared its own
    // fallbackQuota they would count in different maps, and with Redis down the
    // panel and the send would disagree in the one scenario where it is load-bearing.
    redis.connectThrows = true;
    process.env.CLAUDE_TRYIT_KEY = KEY_IN_ENV;
    stubAnthropic();

    const before = (await (await probe()).json()).tryitRemaining;
    const sendRes = await send();
    const after = (await (await probe()).json()).tryitRemaining;

    expect(sendRes.status).toBe(200);
    expect(before).toBe(TRYIT_QUOTA);
    expect(after).toBe(TRYIT_QUOTA - 1);
  });

  it('agrees with the header the send itself reported', async () => {
    redis.connectThrows = true;
    process.env.CLAUDE_TRYIT_KEY = KEY_IN_ENV;
    stubAnthropic();

    const sendRes = await send();
    const fromHeader = Number(sendRes.headers.get('X-Tryit-Remaining'));
    const fromProbe = (await (await probe()).json()).tryitRemaining;

    // Two surfaces, one counter — the disagreement this test forbids is the one a
    // user would actually notice.
    expect(fromProbe).toBe(fromHeader);
  });
});

describe('GET /api/agent/capabilities — caching and rate limiting (§4)', () => {
  it('is no-store, because a cached "available" hides the empty state', async () => {
    keyInStore();

    expect((await probe()).headers.get('Cache-Control')).toBe('no-store');
  });

  it('admits a full band behind one NAT before limiting', async () => {
    keyInStore();
    const { GET } = await import('../app/api/agent/capabilities/route');
    const req = () =>
      new NextRequest('http://localhost/api/agent/capabilities', {
        headers: { 'x-forwarded-for': IP },
      });

    for (let i = 0; i < PROBE_RATE_LIMIT_MAX; i++) {
      expect((await GET(req())).status).toBe(200);
    }

    expect((await GET(req())).status).toBe(429);
  });

  it('does NOT dress a rate limit up as one of the four states', async () => {
    keyInStore();
    const { GET } = await import('../app/api/agent/capabilities/route');
    const req = () =>
      new NextRequest('http://localhost/api/agent/capabilities', {
        headers: { 'x-forwarded-for': IP },
      });
    for (let i = 0; i < PROBE_RATE_LIMIT_MAX; i++) await GET(req());

    const limited = await GET(req());
    const body = await limited.json();

    // The whole reason the ceiling was raised and this field exists: if a 429 were
    // reported as `error`, "you reloaded too fast" would render as a key-store
    // outage, and a tester would file a bug against an outage that never happened.
    expect(limited.status).toBe(429);
    expect(body.rateLimited).toBe(true);
    expect(body.tryit).toBeUndefined();
    expect(limited.headers.get('Cache-Control')).toBe('no-store');
  });

  it('limits per IP, so one hammering client cannot lock out the venue', async () => {
    keyInStore();
    const { GET } = await import('../app/api/agent/capabilities/route');
    const at = (ip: string) =>
      new NextRequest('http://localhost/api/agent/capabilities', {
        headers: { 'x-forwarded-for': ip },
      });
    for (let i = 0; i <= PROBE_RATE_LIMIT_MAX; i++) await GET(at(IP));

    expect((await GET(at('198.51.100.99'))).status).toBe(200);
  });
});

describe('GET /api/agent/capabilities — the unreportable mode fails loud', () => {
  it('500s rather than inventing a try-it state, if resolution returns byoa', async () => {
    // Unreachable through the route (it passes no client key), which is exactly why
    // it is worth pinning: the tempting alternative is a default branch that reports
    // some state we did not measure.
    vi.doMock('@/lib/agent-key', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../lib/agent-key')>();
      return {
        ...actual,
        resolveKeyMode: async () => ({
          mode: 'byoa' as const,
          apiKey: KEY_IN_ENV,
          model: 'm',
          maxTokens: 1,
        }),
      };
    });

    const res = await probe();
    const raw = await res.text();

    expect(res.status).toBe(500);
    expect(raw).not.toContain(KEY_IN_ENV);
    expect(JSON.parse(raw).tryit).toBeUndefined();
  });
});
