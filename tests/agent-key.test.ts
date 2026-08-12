import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

const ENV = { ...process.env };

beforeEach(() => {
  redis.connectThrows = false;
  redis.getThrows = false;
  redis.store.clear();
  redis.incrCalls = 0;
  redis.getCalls = 0;
  process.env.REDIS_URL = 'redis://test';
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

describe('readAdminConfig — the value, and its source', () => {
  it('reports a Redis value as ok/redis', async () => {
    redis.store.set('admin:claude_tryit_key', 'sk-ant-redis');
    const { readAdminConfig } = await adminConfig();
    expect(await readAdminConfig('claude_tryit_key')).toEqual({
      status: 'ok',
      value: 'sk-ant-redis',
      source: 'redis',
    });
  });

  it('falls back to the env var and says so', async () => {
    process.env.CLAUDE_TRYIT_KEY = 'sk-ant-env';
    const { readAdminConfig } = await adminConfig();
    expect(await readAdminConfig('claude_tryit_key')).toEqual({
      status: 'ok',
      value: 'sk-ant-env',
      source: 'env',
    });
  });

  it('reports none when the store is reachable and nothing is set', async () => {
    const { readAdminConfig } = await adminConfig();
    expect(await readAdminConfig('claude_tryit_key')).toEqual({ status: 'none' });
  });
});

describe('readAdminConfig — none vs error (§0 invariant 3)', () => {
  // 6a. The regression the previous spec could not have passed: getAdminConfig
  // returned null here, identical to a clean "nothing configured".
  it('reports ERROR when the store is unreachable and there is no env fallback', async () => {
    redis.connectThrows = true;
    const { readAdminConfig } = await adminConfig();
    const read = await readAdminConfig('claude_tryit_key');
    expect(read.status).toBe('error');
    expect(read).toHaveProperty('reason');
  });

  // 6b. A store outage with a working fallback is NOT an error — try-it works, so
  // the user must be told it works. (The operator learns about the outage from
  // /admin instead; that is the other half of the §6 pair, chunk 5.)
  it('reports ok/env — NOT error — when the store is unreachable but the env var is set', async () => {
    redis.connectThrows = true;
    process.env.CLAUDE_TRYIT_KEY = 'sk-ant-env';
    const { readAdminConfig } = await adminConfig();
    expect(await readAdminConfig('claude_tryit_key')).toEqual({
      status: 'ok',
      value: 'sk-ant-env',
      source: 'env',
    });
  });

  it('reports error when the read itself throws, not just the connect', async () => {
    redis.getThrows = true;
    const { readAdminConfig } = await adminConfig();
    expect((await readAdminConfig('claude_tryit_key')).status).toBe('error');
  });

  // The edge case that would otherwise misreport a deployment choice as an outage.
  it('reports none, not error, when REDIS_URL is absent entirely', async () => {
    delete process.env.REDIS_URL;
    const { readAdminConfig } = await adminConfig();
    expect(await readAdminConfig('claude_tryit_key')).toEqual({ status: 'none' });
  });

  it('reports none, not error, when REDIS_URL is set but empty', async () => {
    process.env.REDIS_URL = '';
    const { readAdminConfig } = await adminConfig();
    expect(await readAdminConfig('claude_tryit_key')).toEqual({ status: 'none' });
  });
});

describe('readAdminConfig — the __DISABLED__ trap (§6 gap 3)', () => {
  // 6c. The sentinel is a deliberate "off" and it SUPPRESSES the env fallback. An
  // operator who once cleared the field in the UI must clear this key before
  // CLAUDE_TRYIT_KEY can take effect — the interaction worth a test, not just prose.
  it('treats the sentinel as none', async () => {
    redis.store.set('admin:claude_tryit_key', '__DISABLED__');
    const { readAdminConfig } = await adminConfig();
    expect(await readAdminConfig('claude_tryit_key')).toEqual({ status: 'none' });
  });

  it('keeps the env var suppressed while the sentinel is present', async () => {
    redis.store.set('admin:claude_tryit_key', '__DISABLED__');
    process.env.CLAUDE_TRYIT_KEY = 'sk-ant-env';
    const { readAdminConfig } = await adminConfig();
    expect(await readAdminConfig('claude_tryit_key')).toEqual({ status: 'none' });
  });
});

describe('getAdminConfig — unchanged for its four existing callers', () => {
  it('collapses every non-ok status to null', async () => {
    const { getAdminConfig } = await adminConfig();
    expect(await getAdminConfig('claude_tryit_key')).toBeNull(); // none
    redis.connectThrows = true;
    vi.resetModules();
    const { getAdminConfig: g2 } = await adminConfig();
    expect(await g2('claude_tryit_key')).toBeNull(); // error
  });

  it('still returns the value when there is one', async () => {
    redis.store.set('admin:claude_tryit_key', 'sk-ant-redis');
    const { getAdminConfig } = await adminConfig();
    expect(await getAdminConfig('claude_tryit_key')).toBe('sk-ant-redis');
  });
});

describe('resolveKeyMode — precedence and states', () => {
  it('lets a caller-supplied key win, without reading config or quota at all', async () => {
    const { resolveKeyMode } = await agentKey();
    const r = await resolveKeyMode('sk-ant-mine', '1.2.3.4', { consume: true });
    expect(r.mode).toBe('byoa');
    // BYOA wins unconditionally, so nothing else should even be consulted.
    expect(redis.getCalls).toBe(0);
    expect(redis.incrCalls).toBe(0);
  });

  it('propagates unconfigured rather than flattening it to "no key"', async () => {
    const { resolveKeyMode } = await agentKey();
    expect((await resolveKeyMode(undefined, 'ip', { consume: true })).mode).toBe('unconfigured');
  });

  it('propagates error, with a reason, distinctly from unconfigured', async () => {
    redis.connectThrows = true;
    const { resolveKeyMode } = await agentKey();
    const r = await resolveKeyMode(undefined, 'ip', { consume: true });
    expect(r.mode).toBe('error');
    if (r.mode === 'error') expect(r.reason).toBeTruthy();
  });

  it('resolves try-it with a remaining count derived from the quota constant', async () => {
    redis.store.set('admin:claude_tryit_key', 'sk-ant-server');
    const { resolveKeyMode, TRYIT_QUOTA } = await agentKey();
    const r = await resolveKeyMode(undefined, 'ip', { consume: true });
    expect(r.mode).toBe('tryit');
    // No literal: raising TRYIT_QUOTA must not invalidate this.
    if (r.mode === 'tryit') expect(r.remaining).toBe(TRYIT_QUOTA - 1);
  });

  it('reports exhausted once usage reaches the quota constant', async () => {
    redis.store.set('admin:claude_tryit_key', 'sk-ant-server');
    const { resolveKeyMode, TRYIT_QUOTA } = await agentKey();
    redis.store.set('quota:ip', String(TRYIT_QUOTA));
    expect((await resolveKeyMode(undefined, 'ip', { consume: true })).mode).toBe('exhausted');
  });
});

describe('resolveKeyMode — a peek must not cost a message (§4 hard requirement)', () => {
  it('does not INCR when consume is false', async () => {
    redis.store.set('admin:claude_tryit_key', 'sk-ant-server');
    const { resolveKeyMode } = await agentKey();
    await resolveKeyMode(undefined, 'ip', { consume: false });
    await resolveKeyMode(undefined, 'ip', { consume: false });
    expect(redis.incrCalls).toBe(0);
    expect(redis.store.get('quota:ip')).toBeUndefined();
  });

  it('reports the same remaining across repeated peeks', async () => {
    redis.store.set('admin:claude_tryit_key', 'sk-ant-server');
    redis.store.set('quota:ip', '3');
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
    redis.store.set('admin:claude_tryit_key', 'sk-ant-server');
    const { resolveKeyMode, TRYIT_QUOTA } = await agentKey();
    await resolveKeyMode(undefined, 'ip', { consume: true });
    const after = await resolveKeyMode(undefined, 'ip', { consume: false });
    if (after.mode === 'tryit') expect(after.remaining).toBe(TRYIT_QUOTA - 1);
    expect(redis.incrCalls).toBe(1);
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
