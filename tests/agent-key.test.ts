import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { quotaBackend, supabaseAdminMock } from './helpers/quota-backend';

// Design docs/design-ai-key-availability.md §4/§4.1, chunk 1.
//
// This is the FIRST test coverage the agent key/quota path has ever had — before
// this, the send route and lib/admin-config were entirely untested, so a green
// suite said nothing about them.
//
// Two things are being pinned. First, that a config read preserves WHY there is no
// value: `none` (store reachable, nothing set) must stay distinct from `error`
// (store unreachable, no fallback), because collapsing them is what made a Redis
// outage render as "intentionally off". Second, that probe and send share ONE
// fallback counter — the entire reason capability resolution was extracted.

const redis = {
  connectThrows: false,
  getThrows: false,
  store: new Map<string, string>(),
  incrCalls: 0,
  getCalls: 0,
};

vi.mock('redis', () => ({
  createClient: () => ({
    isOpen: true,
    connect: async () => {
      if (redis.connectThrows) throw new Error('ECONNREFUSED');
    },
    get: async (k: string) => {
      redis.getCalls++;
      if (redis.getThrows) throw new Error('read failed');
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
    expire: async () => 1,
    ping: async () => 'PONG',
    disconnect: async () => undefined,
  }),
}));

// Quota moved off Redis onto two Supabase RPCs (chunk 2). The `redis` mock above
// stays only to keep the admin-config assertions honest — those prove config does
// not consult a store, and a test that mocks nothing proves nothing.
vi.mock('@/lib/supabase-admin', () => supabaseAdminMock());

const ENV = { ...process.env };

beforeEach(() => {
  redis.connectThrows = false;
  redis.getThrows = false;
  redis.store.clear();
  redis.incrCalls = 0;
  redis.getCalls = 0;
  quotaBackend.reset();
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
  delete process.env.CLAUDE_TRYIT_KEY;
  // admin-config caches its client at module scope and agent-key's fallback map is
  // module state; both must be fresh per test or results leak across cases.
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ENV };
});

const adminConfig = () => import('../lib/admin-config');
const agentKey = () => import('../lib/agent-key');

describe('readAdminConfig — env only (design-single-backend §3.2)', () => {
  it('reports the env var as ok/env', async () => {
    process.env.CLAUDE_TRYIT_KEY = 'sk-ant-env';
    const { readAdminConfig } = await adminConfig();
    expect(await readAdminConfig('claude_tryit_key')).toEqual({
      status: 'ok',
      value: 'sk-ant-env',
      source: 'env',
    });
  });

  it('reports none when the env var is unset', async () => {
    const { readAdminConfig } = await adminConfig();
    expect(await readAdminConfig('claude_tryit_key')).toEqual({ status: 'none' });
  });

  it('reports none when the env var is set but empty', async () => {
    process.env.CLAUDE_TRYIT_KEY = '';
    const { readAdminConfig } = await adminConfig();
    expect(await readAdminConfig('claude_tryit_key')).toEqual({ status: 'none' });
  });

  // ★ The counterexample to "we just renamed the source". A REDIS_URL pointing at
  // a store holding a value must now change nothing: the value is not read, and
  // the outage that used to produce `error` is not observed. Without this, a
  // half-finished strip that still consulted Redis first would pass every test
  // above by falling through to env.
  it('ignores Redis entirely — a reachable store with a value does not win, and an outage is not an error', async () => {
    redis.store.set('admin:claude_tryit_key', 'sk-ant-redis');
    process.env.CLAUDE_TRYIT_KEY = 'sk-ant-env';
    const { readAdminConfig } = await adminConfig();
    expect(await readAdminConfig('claude_tryit_key')).toEqual({
      status: 'ok',
      value: 'sk-ant-env',
      source: 'env',
    });
    expect(redis.getCalls).toBe(0);

    redis.connectThrows = true;
    delete process.env.CLAUDE_TRYIT_KEY;
    vi.resetModules();
    const { readAdminConfig: r2 } = await adminConfig();
    expect(await r2('claude_tryit_key')).toEqual({ status: 'none' });
  });

  // The __DISABLED__ sentinel died with the client. Its regression test died with
  // it — there is no write path that could set it — but the TRAP it caused was a
  // stored value suppressing the env fallback, so pin that it cannot recur.
  it('does not let a leftover __DISABLED__ in Redis suppress the env var', async () => {
    redis.store.set('admin:claude_tryit_key', '__DISABLED__');
    process.env.CLAUDE_TRYIT_KEY = 'sk-ant-env';
    const { readAdminConfig } = await adminConfig();
    expect(await readAdminConfig('claude_tryit_key')).toEqual({
      status: 'ok',
      value: 'sk-ant-env',
      source: 'env',
    });
  });
});

describe('getAdminConfig — unchanged for its callers', () => {
  it('collapses none to null', async () => {
    const { getAdminConfig } = await adminConfig();
    expect(await getAdminConfig('claude_tryit_key')).toBeNull();
  });

  it('still returns the value when there is one', async () => {
    process.env.CLAUDE_TRYIT_KEY = 'sk-ant-env';
    const { getAdminConfig } = await adminConfig();
    expect(await getAdminConfig('claude_tryit_key')).toBe('sk-ant-env');
  });
});

describe('resolveKeyMode — precedence and states', () => {
  it('lets a caller-supplied key win, without reading config or quota at all', async () => {
    const { resolveKeyMode } = await agentKey();
    const r = await resolveKeyMode('sk-ant-mine', '1.2.3.4', { consume: true });
    expect(r.mode).toBe('byoa');
    // BYOA wins unconditionally, so nothing else should even be consulted.
    expect(redis.getCalls).toBe(0);
    // The invariant that outlived Redis: NO I/O on the BYOA branch, whatever
    // the quota backend happens to be.
    expect(quotaBackend.calls).toBe(0);
  });

  it('propagates unconfigured rather than flattening it to "no key"', async () => {
    const { resolveKeyMode } = await agentKey();
    expect((await resolveKeyMode(undefined, 'ip', { consume: true })).mode).toBe('unconfigured');
  });

  it('resolves try-it with a remaining count derived from the quota constant', async () => {
    process.env.CLAUDE_TRYIT_KEY = 'sk-ant-server';
    const { resolveKeyMode, TRYIT_QUOTA } = await agentKey();
    const r = await resolveKeyMode(undefined, 'ip', { consume: true });
    expect(r.mode).toBe('tryit');
    // No literal: raising TRYIT_QUOTA must not invalidate this.
    if (r.mode === 'tryit') expect(r.remaining).toBe(TRYIT_QUOTA - 1);
  });

  it('reports exhausted once usage reaches the quota constant', async () => {
    process.env.CLAUDE_TRYIT_KEY = 'sk-ant-server';
    const { resolveKeyMode, TRYIT_QUOTA } = await agentKey();
    quotaBackend.seed('ip', TRYIT_QUOTA);
    expect((await resolveKeyMode(undefined, 'ip', { consume: true })).mode).toBe('exhausted');
  });
});

describe('resolveKeyMode — a peek must not cost a message (§4 hard requirement)', () => {
  it('does not INCR when consume is false', async () => {
    process.env.CLAUDE_TRYIT_KEY = 'sk-ant-server';
    const { resolveKeyMode } = await agentKey();
    await resolveKeyMode(undefined, 'ip', { consume: false });
    await resolveKeyMode(undefined, 'ip', { consume: false });
    expect(quotaBackend.incrCalls).toBe(0);
    expect(quotaBackend.peekCalls).toBe(2);
    // A peek on an unseen IP must not seed a row.
    expect(quotaBackend.countFor('ip')).toBe(0);
  });

  it('reports the same remaining across repeated peeks', async () => {
    process.env.CLAUDE_TRYIT_KEY = 'sk-ant-server';
    quotaBackend.seed('ip', 3);
    const { resolveKeyMode, TRYIT_QUOTA } = await agentKey();
    const a = await resolveKeyMode(undefined, 'ip', { consume: false });
    const b = await resolveKeyMode(undefined, 'ip', { consume: false });
    if (a.mode === 'tryit' && b.mode === 'tryit') {
      expect(a.remaining).toBe(TRYIT_QUOTA - 3);
      expect(b.remaining).toBe(TRYIT_QUOTA - 3);
    } else {
      throw new Error('expected try-it mode');
    }
  });

  it('consume decrements exactly once', async () => {
    process.env.CLAUDE_TRYIT_KEY = 'sk-ant-server';
    const { resolveKeyMode, TRYIT_QUOTA } = await agentKey();
    await resolveKeyMode(undefined, 'ip', { consume: true });
    const after = await resolveKeyMode(undefined, 'ip', { consume: false });
    if (after.mode === 'tryit') expect(after.remaining).toBe(TRYIT_QUOTA - 1);
    expect(quotaBackend.incrCalls).toBe(1);
  });
});

// ── Chunk 2: the Supabase quota backend ────────────────────────────────────
//
// New surface, so new coverage. The window and degradation cases below were
// untestable under Redis (TTL expiry is not observable in a fake) and are
// exactly where a quota backend goes wrong: silently locking users out.
describe('quota — Supabase backend (chunk 2)', () => {
  const tryit = async () => {
    process.env.CLAUDE_TRYIT_KEY = 'sk-ant-server';
    return agentKey();
  };

  // Graham ruled 2026-08-25: keyed HMAC, not a bare digest — an unsalted sha256
  // of an IPv4 is enumerable from a dump. Keyed on the ALREADY-required
  // service-role secret, so there is no new env var whose absence would
  // silently rehash every IP and reset every quota.
  it('keys the row by HMAC — not the raw IP, and not an unsalted sha256', async () => {
    const { resolveKeyMode } = await tryit();
    await resolveKeyMode(undefined, '198.51.100.7', { consume: true });
    const keys = [...quotaBackend.rows.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain('198.51.100.7');
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
    // THE counterexample. Without this line the assertions above pass on the
    // exact bare-sha256 construction that was ruled insufficient — both are
    // 64 hex chars and neither contains the address.
    expect(keys[0]).not.toBe(createHash('sha256').update('198.51.100.7').digest('hex'));
    expect(keys[0]).toBe(createHmac('sha256', 'service-role-test').update('198.51.100.7').digest('hex'));
  });

  it('re-keys when the service-role secret rotates — the accepted quota reset', async () => {
    const { resolveKeyMode, TRYIT_QUOTA } = await tryit();
    quotaBackend.seed('ip', TRYIT_QUOTA);
    expect((await resolveKeyMode(undefined, 'ip', { consume: true })).mode).toBe('exhausted');

    process.env.SUPABASE_SERVICE_ROLE_KEY = 'rotated-secret';
    // Same IP, new key: the seeded row is unreachable, so the quota resets
    // rather than the lookup erroring. Documented consequence, not a bug.
    expect((await resolveKeyMode(undefined, 'ip', { consume: true })).mode).toBe('tryit');
  });

  it('treats a window-expired row as fresh allowance on peek', async () => {
    const { resolveKeyMode, TRYIT_QUOTA } = await tryit();
    quotaBackend.seed('ip', TRYIT_QUOTA, 31); // spent, but 31 days ago
    const r = await resolveKeyMode(undefined, 'ip', { consume: false });
    expect(r.mode).toBe('tryit');
    if (r.mode === 'tryit') expect(r.remaining).toBe(TRYIT_QUOTA);
  });

  it('resets the count on consume once the window has aged out', async () => {
    const { resolveKeyMode, TRYIT_QUOTA } = await tryit();
    quotaBackend.seed('ip', TRYIT_QUOTA, 31);
    const r = await resolveKeyMode(undefined, 'ip', { consume: true });
    expect(r.mode).toBe('tryit');
    if (r.mode === 'tryit') expect(r.remaining).toBe(TRYIT_QUOTA - 1);
    expect(quotaBackend.countFor('ip')).toBe(1);
  });

  it('still counts a row inside the window', async () => {
    const { resolveKeyMode, TRYIT_QUOTA } = await tryit();
    quotaBackend.seed('ip', TRYIT_QUOTA, 29); // 29 days: window not yet over
    expect((await resolveKeyMode(undefined, 'ip', { consume: true })).mode).toBe('exhausted');
  });

  it('falls back rather than locking out when the RPC returns a transient error', async () => {
    const { resolveKeyMode, TRYIT_QUOTA } = await tryit();
    quotaBackend.errors = true;
    quotaBackend.errorCode = '08006'; // connection_failure — plausibly a blip
    const r = await resolveKeyMode(undefined, 'ip', { consume: true });
    expect(r.mode).toBe('tryit');
    if (r.mode === 'tryit') expect(r.remaining).toBe(TRYIT_QUOTA - 1);
  });

  // Graham's ruling, 2026-08-25. 42501 means the grants are wrong: permanent,
  // total, and silent if it fell back. Everything else stays fail-open.
  it('fails CLOSED on 42501 rather than falling back', async () => {
    const { resolveKeyMode } = await tryit();
    quotaBackend.errors = true;
    quotaBackend.errorCode = '42501'; // insufficient_privilege
    expect((await resolveKeyMode(undefined, 'ip', { consume: true })).mode).toBe('exhausted');
  });

  it('fails CLOSED on 42501 for a peek too, not just a consume', async () => {
    const { resolveKeyMode } = await tryit();
    quotaBackend.errors = true;
    quotaBackend.errorCode = '42501';
    expect((await resolveKeyMode(undefined, 'ip', { consume: false })).mode).toBe('exhausted');
  });

  // The counterexample that would prove fail-closed was written too broadly:
  // 42883 is exactly the state between merging and applying migration 013, and
  // it MUST still degrade or that window becomes a total outage.
  it('still falls back on 42883 — a missing RPC is a deploy-ordering gap, not a bypass', async () => {
    const { resolveKeyMode, TRYIT_QUOTA } = await tryit();
    quotaBackend.errors = true;
    quotaBackend.errorCode = '42883'; // undefined_function
    const r = await resolveKeyMode(undefined, 'ip', { consume: true });
    expect(r.mode).toBe('tryit');
    if (r.mode === 'tryit') expect(r.remaining).toBe(TRYIT_QUOTA - 1);
  });

  it('falls back rather than throwing when the backend is unreachable', async () => {
    const { resolveKeyMode } = await tryit();
    quotaBackend.throws = true;
    await expect(resolveKeyMode(undefined, 'ip', { consume: true })).resolves.toMatchObject({
      mode: 'tryit',
    });
  });

  it('falls back when the backend is not configured at all', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { resolveKeyMode } = await tryit();
    const r = await resolveKeyMode(undefined, 'ip', { consume: true });
    expect(r.mode).toBe('tryit');
    // Nothing was attempted — an absent backend is not an unreachable one.
    expect(quotaBackend.calls).toBe(0);
  });
});

// Test 8 — the whole reason capability resolution was extracted into one module.
// If probe and send each declared their own fallbackQuota they would count in
// DIFFERENT maps, and with Redis down the panel and the send would disagree about
// how many messages remain — in the exact scenario where the fallback matters.
describe('the in-memory fallback is ONE counter shared by peek and consume', () => {
  it('sees a consumed message on the next peek, with Redis unavailable', async () => {
    redis.connectThrows = true;
    process.env.CLAUDE_TRYIT_KEY = 'sk-ant-env'; // so config resolves ok/env
    const { resolveKeyMode, TRYIT_QUOTA } = await agentKey();

    const before = await resolveKeyMode(undefined, 'ip', { consume: false });
    if (before.mode === 'tryit') expect(before.remaining).toBe(TRYIT_QUOTA);

    await resolveKeyMode(undefined, 'ip', { consume: true });

    const after = await resolveKeyMode(undefined, 'ip', { consume: false });
    // Exactly 1, not 0 (separate maps) and not 2 (peek consuming too).
    if (after.mode === 'tryit') expect(after.remaining).toBe(TRYIT_QUOTA - 1);
    else throw new Error('expected try-it mode');
  });

  it('does not seed the fallback map on a peek for an unseen IP', async () => {
    redis.connectThrows = true;
    process.env.CLAUDE_TRYIT_KEY = 'sk-ant-env';
    const { resolveKeyMode, TRYIT_QUOTA } = await agentKey();
    await resolveKeyMode(undefined, 'never-seen', { consume: false });
    // If the peek had written an entry, the first real send would still report a
    // full allowance — which is right — but a peek that mutates shared state is
    // how the two paths drift. Assert the allowance is untouched after a peek.
    const r = await resolveKeyMode(undefined, 'never-seen', { consume: true });
    if (r.mode === 'tryit') expect(r.remaining).toBe(TRYIT_QUOTA - 1);
    else throw new Error('expected try-it mode');
  });

  it('keeps counters per IP', async () => {
    redis.connectThrows = true;
    process.env.CLAUDE_TRYIT_KEY = 'sk-ant-env';
    const { resolveKeyMode, TRYIT_QUOTA } = await agentKey();
    await resolveKeyMode(undefined, 'a', { consume: true });
    await resolveKeyMode(undefined, 'a', { consume: true });
    const b = await resolveKeyMode(undefined, 'b', { consume: false });
    if (b.mode === 'tryit') expect(b.remaining).toBe(TRYIT_QUOTA);
    else throw new Error('expected try-it mode');
  });
});

describe('getClientIp', () => {
  it('takes the first hop of x-forwarded-for', () => {
    // Static import is fine here — no module state involved.
    return agentKey().then(({ getClientIp }) => {
      expect(getClientIp(new Headers({ 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }))).toBe('9.9.9.9');
      expect(getClientIp(new Headers())).toBe('unknown');
    });
  });
});
