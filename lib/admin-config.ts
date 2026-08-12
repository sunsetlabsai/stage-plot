import { createClient, type RedisClientType } from 'redis';

const DISABLED_SENTINEL = '__DISABLED__';

let client: RedisClientType | null = null;

async function getRedis(): Promise<RedisClientType | null> {
  const url = process.env.REDIS_URL;
  if (!url) return null;

  if (client && client.isOpen) return client;

  try {
    client = createClient({ url });
    await client.connect();
    return client;
  } catch {
    client = null;
    return null;
  }
}

/**
 * The outcome of a config read, with the store's reachability preserved.
 *
 * `getAdminConfig` returns `null` for BOTH "nothing is set" and "the store was
 * unreachable and there is no env fallback" — and that conflation is the defect
 * design §4.1 exists to remove. In production (no `CLAUDE_TRYIT_KEY` in the
 * environment) a Redis outage therefore renders as *intentionally off*, which is
 * exactly the ambiguity that made "my account has no AI key" unanswerable.
 */
export type ConfigRead =
  | { status: 'ok'; value: string; source: 'redis' | 'env' }
  /** Store reachable, nothing set (or explicitly disabled). */
  | { status: 'none' }
  /** Store unreachable AND no usable env fallback. */
  | { status: 'error'; reason: string };

/**
 * Read an admin config value, preserving WHY there is no value.
 *
 * The ordering subtlety this must keep: a Redis failure with a valid env fallback
 * is still `ok`/`env`, never `error`. `error` means *no usable value and the store
 * was unreachable* — only that combination is ambiguous. (Design §0 invariant 3.)
 */
export async function readAdminConfig(key: string): Promise<ConfigRead> {
  let storeReachable = true;
  let reason = '';

  try {
    const redis = await getRedis();
    if (redis) {
      const value = await redis.get(`admin:${key}`);
      // The sentinel is a deliberate "off", and it suppresses the env fallback —
      // matching getAdminConfig's long-standing behavior. An operator who once
      // cleared the field in the UI must clear this key before CLAUDE_TRYIT_KEY
      // can take effect (design §6 gap 3 — the trap worth documenting).
      if (value === DISABLED_SENTINEL) return { status: 'none' };
      if (value) return { status: 'ok', value, source: 'redis' };
    } else {
      // No REDIS_URL configured at all. That is not an outage — env is the
      // intended source in that deployment, so it must not read as `error`.
      // Truthiness, not `=== undefined`, to match getRedis's own `if (!url)`:
      // REDIS_URL='' means unconfigured, and would otherwise report an outage.
      storeReachable = !process.env.REDIS_URL;
      if (!storeReachable) reason = 'Redis connection unavailable';
    }
  } catch (e) {
    storeReachable = false;
    reason = e instanceof Error ? e.message : 'Redis read failed';
  }

  const envValue = process.env[key.toUpperCase()];
  if (envValue) return { status: 'ok', value: envValue, source: 'env' };

  return storeReachable
    ? { status: 'none' }
    : { status: 'error', reason: reason || 'Key store unreachable' };
}

/**
 * Read an admin config value. Redis first, env var fallback.
 * Returns null if unconfigured or explicitly disabled.
 *
 * A thin wrapper over readAdminConfig — one lookup, two shapes (design §4.1).
 * Four other routes call this (agent/chat, charts/convert, charts/roadmap/parse,
 * admin/backfill-chart-overlays) and their behavior is unchanged: every non-`ok`
 * status still collapses to null here. Callers that need the distinction use
 * readAdminConfig directly.
 */
export async function getAdminConfig(key: string): Promise<string | null> {
  const read = await readAdminConfig(key);
  return read.status === 'ok' ? read.value : null;
}

/**
 * Write an admin config value to Redis.
 * Empty string stores DISABLED sentinel (prevents env var fallback).
 * Throws if Redis is unavailable (fail closed for admin writes).
 */
export async function setAdminConfig(key: string, value: string): Promise<void> {
  const redis = await getRedis();
  if (!redis) throw new Error('Redis not connected');

  await redis.set(`admin:${key}`, value || DISABLED_SENTINEL);
}

/**
 * Read all admin config values (masked for display).
 */
export async function getAllAdminConfig(): Promise<Record<string, { configured: boolean; masked: string }>> {
  const keys = ['google_client_id', 'google_client_secret', 'claude_tryit_key'] as const;
  const result: Record<string, { configured: boolean; masked: string }> = {};

  for (const key of keys) {
    const val = await getAdminConfig(key);
    result[key] = {
      configured: !!val,
      masked: val ? maskSecret(key, val) : '',
    };
  }
  return result;
}

function maskSecret(key: string, value: string): string {
  if (key === 'google_client_id') {
    return value.length > 20 ? `${value.slice(0, 15)}...${value.slice(-10)}` : value;
  }
  if (value.length <= 8) return '••••••••';
  return `${value.slice(0, 7)}...${value.slice(-4)}`;
}

/**
 * Check if Redis store is reachable.
 */
export async function isKvConnected(): Promise<boolean> {
  try {
    const redis = await getRedis();
    if (!redis) return false;
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}
