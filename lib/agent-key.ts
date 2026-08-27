import { createHmac } from 'node:crypto';
import { readAdminConfig } from './admin-config';
import { getSupabaseAdmin } from './supabase-admin';

// Capability resolution for the AI Show Designer — owned in ONE place.
//
// Design docs/design-ai-key-availability.md §4. This is a refactor of a working
// route, and it is justified by the drift it forecloses, not by tidiness:
// `fallbackQuota` below is a module-level Map. If the probe route and the send
// route each grew their own copy, they would count in DIFFERENT maps — so with
// Redis down the panel and the send would disagree about how many messages remain,
// in the exact scenario where the fallback is load-bearing. §9 test 8 pins it.

export const TRYIT_QUOTA = 50; // §7: raised from 10 for the UAT window
export const TRYIT_MAX_TOKENS = 2048;
export const BYOA_MAX_TOKENS = 4096;

// ── Agent model, configurable at runtime ───────────────────────────────────
//
// Graham, 2026-08-20: "We don't WANT to be wed to a single model version.
// Shouldn't this be easy/flexible enough to change?" It was two hardcoded
// constants, which also sat against the standing no-hardcoding rule.
//
// design-ai-op-contract §8 turns that into a design criterion rather than a
// preference: the op contract must be drivable by whatever model we point at,
// so the model has to be a value, not a deploy.

/** Used when nothing is configured, and whenever a configured value is unusable. */
export const DEFAULT_AGENT_MODEL = 'claude-sonnet-4-6';

/**
 * Environment variables, read synchronously. **No I/O on this path — see below.**
 *
 * The argument below was written against Redis. The quota backend is now Supabase
 * and it survives the swap unchanged, because it never depended on *which* store —
 * only on there being a network hop. The test it cites is the invariant, not a
 * Redis artifact: **no I/O on the BYOA path.** Keep it, whatever the backend is.
 *
 * > ★ The first cut of this resolved through `readAdminConfig` (Redis, then env),
 * > which would have allowed changing the model with no deploy at all. An
 * > existing test killed it, and the test was right:
 * >
 * > ```
 * > expect(redis.getCalls).toBe(0);
 * > // "BYOA wins unconditionally, so nothing else should even be consulted"
 * > ```
 * >
 * > **BYOA is the escape hatch that works when server-side config is broken.**
 * > `resolveKeyMode` returns on that branch before touching Redis precisely so a
 * > user with their own key is never subject to our infrastructure. Resolving the
 * > model through Redis puts a network round-trip — and, during an outage, a
 * > connect timeout — on exactly that path. A 60s cache does not save the first
 * > call, so the stall would recur once per minute per process.
 * >
 * > **That trades reliability for convenience on the most reliability-sensitive
 * > path in the app, to change a value that changes maybe monthly.** Env vars
 * > cost nothing, need no I/O, and still remove the code change. The Redis half —
 * > true no-deploy switching — is a costed follow-up, not something to smuggle in
 * > here (see the PR body).
 */
export const BYOA_MODEL_ENV = 'AGENT_MODEL_BYOA';
export const TRYIT_MODEL_ENV = 'AGENT_MODEL_TRYIT';
export const VISION_MODEL_ENV = 'AGENT_MODEL_VISION';
export const ROADMAP_MODEL_ENV = 'AGENT_MODEL_ROADMAP';

/**
 * Is this usable as a model id?
 *
 * **Deliberately shape-agnostic — NO `claude-` prefix check.** The entire point
 * is not being wed to a naming convention, and a prefix rule would re-couple us
 * to one, breaking the day a model family is named differently. This catches
 * what actually goes wrong when a human edits a config value: an empty value, a
 * pasted line with whitespace, or a runaway string.
 */
function isUsableModelId(value: string): boolean {
  return value.length > 0 && value.length <= 100 && !/\s/.test(value);
}

/**
 * Resolve the model for an env var, falling back to `DEFAULT_AGENT_MODEL`.
 *
 * Synchronous and allocation-free: no I/O, so it adds nothing to any request
 * path and cannot introduce a failure mode of its own.
 *
 * **A misconfigured value must never break the AI.** An unset, blank or
 * malformed value falls back — so the worst outcome of a fat-fingered env var is
 * that we keep serving the default, not that every request 404s on a bad id.
 */
export function resolveAgentModel(envVar: string): string {
  const configured = (process.env[envVar] ?? '').trim();
  return isUsableModelId(configured) ? configured : DEFAULT_AGENT_MODEL;
}
// The quota window. Fixed, not sliding — a deliberate acceptance carried over
// from the Redis retirement: `increment_tryit` resets window_start when the row
// ages out, so an IP gets TRYIT_QUOTA per 30-day window rather than per rolling
// 30 days. Cheaper to reason about and matches what the RPC already did.
const QUOTA_WINDOW_DAYS = 30;

// Derived, not restated: the in-memory fallback must never disagree with the
// RPCs about how long a window is.
const QUOTA_TTL_SECONDS = QUOTA_WINDOW_DAYS * 24 * 60 * 60;

/**
 * Postgres `insufficient_privilege`. The only error class quota() treats as
 * permanent rather than transient — see the fail-closed branch below.
 */
const PG_INSUFFICIENT_PRIVILEGE = '42501';

/** THE in-memory fallback, used when Redis is unavailable. Exactly one instance. */
const fallbackQuota = new Map<string, { count: number; resetAt: number }>();

/** Test-only: the fallback map is module state and would otherwise leak across specs. */
export function __resetFallbackQuota() {
  fallbackQuota.clear();
}

export type KeyMode =
  /** The caller supplied their own key; it wins unconditionally. */
  | { mode: 'byoa'; apiKey: string; model: string; maxTokens: number }
  | { mode: 'tryit'; apiKey: string; model: string; maxTokens: number; remaining: number }
  /** Try-it is configured but this IP has spent its allowance. */
  | { mode: 'exhausted' }
  /** No key available: nothing is set. */
  | { mode: 'unconfigured' };

// `mode: 'error'` was DELETED with the Redis config client (design-single-backend
// §3.2). It meant "no key AND the store was unreachable" — a state the only
// producer, readAdminConfig, can no longer reach now that config resolves from
// process.env. It does not come back with the chunk-2 quota move either: §5.4
// keeps `fallbackQuota` as the degradation path, so an unreachable database
// falls back rather than erroring.
//
// The USER-facing state 6 survives untouched: agent-availability still reaches
// it from a failed probe fetch (`probe === 'error'`). What is gone is the
// server's claim to have measured an outage it can no longer observe.

/**
 * Peek or consume the try-it quota for an IP.
 *
 * `consume: false` performs a plain GET — no INCR, no EXPIRE — because a tab-open
 * must not cost a free message (§4 hard requirement). This is why the probe cannot
 * reuse the consuming path.
 */
async function quota(ip: string, consume: boolean): Promise<{ allowed: boolean; remaining: number }> {
  // Same guard shape as the REDIS_URL check this replaces: no backend configured
  // is a fallback, not an error. getSupabaseAdmin() asserts both are set.
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return fallback(ip, consume);
  }

  try {
    const ipHash = hashIp(ip);
    const supabase = getSupabaseAdmin();

    // Two RPCs, one shape: both return the IP's message count within the current
    // window. `increment_tryit` writes and returns the post-increment count;
    // `peek_tryit` reads and returns the current one. The allowed/remaining
    // arithmetic below is therefore identical — only the cap comparison differs,
    // because a consume that lands ON the cap has spent the last message whereas
    // a peek at the cap has not.
    const { data, error } = consume
      ? await supabase.rpc('increment_tryit', {
          p_ip_hash: ipHash,
          p_limit: TRYIT_QUOTA,
          p_window_days: QUOTA_WINDOW_DAYS,
        })
      : await supabase.rpc('peek_tryit', {
          p_ip_hash: ipHash,
          p_window_days: QUOTA_WINDOW_DAYS,
        });

    // An RPC error is an unreachable backend, which is what fallback() is for.
    // Failing OPEN here is deliberate and matches the Redis path: a database
    // blip must not lock every try-it user out mid-session.
    //
    // The ONE exception is insufficient_privilege. Every other error class is
    // plausibly transient; 42501 is not. It means the grants are wrong, which
    // is permanent, affects every caller, and would turn "degrade during an
    // outage" into a silent, total quota bypass that nothing ever recovers
    // from. Graham ruled 2026-08-25: fail CLOSED on 42501 only.
    //
    // Deliberately NOT extended to 42883 (undefined_function). That is exactly
    // the window between merging this PR and applying migration 013, and
    // failing closed there converts a merge-ordering cushion into a hard
    // outage for every try-it user.
    if (error) {
      const failClosed = error.code === PG_INSUFFICIENT_PRIVILEGE;
      console.error(
        failClosed
          ? '[quota] RPC not permitted — failing CLOSED. Check grants in migration 013.'
          : '[quota] RPC failed — falling back to in-memory counter.',
        {
          rpc: consume ? 'increment_tryit' : 'peek_tryit',
          code: error.code,
          message: error.message,
        },
      );
      if (failClosed) return { allowed: false, remaining: 0 };
      return fallback(ip, consume);
    }

    // A null/non-numeric return is treated as no usage rather than NaN-propagating.
    const count = typeof data === 'number' && Number.isSafeInteger(data) && data > 0 ? data : 0;

    if (consume) {
      if (count > TRYIT_QUOTA) return { allowed: false, remaining: 0 };
      return { allowed: true, remaining: Math.max(0, TRYIT_QUOTA - count) };
    }

    const remaining = Math.max(0, TRYIT_QUOTA - count);
    return { allowed: remaining > 0, remaining };
  } catch {
    return fallback(ip, consume);
  }
}

/**
 * IP → `tryit_quota.ip_hash`.
 *
 * The column has always been named for a hash; the Redis path keyed on the raw
 * IP because a Redis key is not a stored record. A row in Postgres is, so the
 * raw address does not go in.
 *
 * HMAC-SHA256 keyed on SUPABASE_SERVICE_ROLE_KEY, not a bare digest. Bare
 * SHA-256 is only obfuscation: the IPv4 space is small enough to enumerate, so
 * anyone with a dump can recover every address. The keyed construction makes
 * that infeasible without also holding the service-role secret — and by then
 * the hashes are the least of the problem.
 *
 * Keyed on an EXISTING required secret rather than a new IP_HASH_SALT var, and
 * that is the whole point: a dedicated salt var would introduce a fresh silent
 * failure mode, where forgetting it rehashes every IP and resets all quotas.
 * SUPABASE_SERVICE_ROLE_KEY cannot be absent here — quota() has already
 * returned via fallback() at the guard above if it is, so this is never
 * reached with an empty key. Graham ruled 2026-08-25.
 *
 * Consequence, accepted: rotating the service-role key re-keys every hash and
 * resets all outstanding quotas. Rollout does the same, once.
 *
 * `getClientIp` yields 'unknown' when the header is absent, so all header-less
 * callers share one bucket. That was equally true of the Redis key; preserved
 * rather than changed, because fixing it is a quota-policy decision, not a
 * storage-backend one.
 */
function hashIp(ip: string): string {
  return createHmac('sha256', process.env.SUPABASE_SERVICE_ROLE_KEY!).update(ip).digest('hex');
}

function fallback(ip: string, consume: boolean): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const ttl = QUOTA_TTL_SECONDS * 1000;
  let entry = fallbackQuota.get(ip);

  if (!entry || now > entry.resetAt) {
    // A peek must not create state either — report a fresh allowance without
    // writing, so probing an unseen IP does not seed the map.
    if (!consume) return { allowed: true, remaining: TRYIT_QUOTA };
    entry = { count: 0, resetAt: now + ttl };
    fallbackQuota.set(ip, entry);
  }

  if (!consume) {
    const remaining = Math.max(0, TRYIT_QUOTA - entry.count);
    return { allowed: remaining > 0, remaining };
  }

  if (entry.count >= TRYIT_QUOTA) return { allowed: false, remaining: 0 };
  entry.count++;
  return { allowed: true, remaining: Math.max(0, TRYIT_QUOTA - entry.count) };
}

/**
 * Read this account's stored BYOA key (§4.5's "Save to my account").
 *
 * Returns null for "no key" AND for "could not tell" — the caller treats both
 * the same, falling through to try-it. Failing OPEN matches `quota()`'s
 * reasoning: a database blip must degrade, not lock a user out mid-session.
 * There is no fail-closed exception here because, unlike the quota, an
 * unavailable account key cannot be used to BYPASS anything.
 *
 * `get_user_secret` is the only path in the system that returns plaintext, so
 * nothing here logs `data` — only whether a key was found.
 */
async function readAccountKey(userId: string): Promise<string | null> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }

  try {
    const { data, error } = await getSupabaseAdmin().rpc('get_user_secret', {
      p_user_id: userId,
    });

    if (error) {
      console.error('[agent-key] get_user_secret failed — falling through to try-it.', {
        code: error.code,
        message: error.message,
      });
      return null;
    }

    return typeof data === 'string' && data.length > 0 ? data : null;
  } catch (e) {
    console.error('[agent-key] get_user_secret threw — falling through to try-it.', {
      message: e instanceof Error ? e.message : 'unknown',
    });
    return null;
  }
}

/**
 * Resolve how a request to the agent should be authorized.
 *
 * BYOA wins over try-it unconditionally, matching the behavior this replaces.
 * `unconfigured` and `error` are propagated OUTWARD rather than flattened to "no
 * key" — the distinction §5 depends on is made here or not at all (§0 invariant 2).
 *
 * ★ Precedence between the two BYOA backends — Graham's ruling 2026-08-26:
 * the DEVICE key wins over the ACCOUNT key. Both can exist at once (saving to
 * the account does not reach into another browser's localStorage), so this is a
 * real decision, not a theoretical one. Device-first keeps the property §4.4
 * cares about: a request that carries its own key resolves without touching
 * Supabase at all, so BYOA still works for that user during a database outage.
 *
 * `userId` is optional and callers pass it only when there is no client key —
 * see `app/api/agent/chat/route.ts`. That is what stops an anonymous try-it
 * request paying for a session lookup it cannot use.
 */
export async function resolveKeyMode(
  clientKey: string | undefined,
  ip: string,
  opts: { consume: boolean },
  userId?: string | null,
): Promise<KeyMode> {
  if (clientKey) {
    // Synchronous env read — this branch still consults NOTHING external, which
    // is the property `agent-key.test.ts` pins with `expect(redis.getCalls).toBe(0)`.
    return {
      mode: 'byoa',
      apiKey: clientKey,
      model: resolveAgentModel(BYOA_MODEL_ENV),
      maxTokens: BYOA_MAX_TOKENS,
    };
  }

  if (userId) {
    const accountKey = await readAccountKey(userId);
    if (accountKey) {
      return {
        mode: 'byoa',
        apiKey: accountKey,
        model: resolveAgentModel(BYOA_MODEL_ENV),
        maxTokens: BYOA_MAX_TOKENS,
      };
    }
  }

  const read = await readAdminConfig('claude_tryit_key');
  if (read.status === 'none') return { mode: 'unconfigured' };

  const q = await quota(ip, opts.consume);
  if (!q.allowed) return { mode: 'exhausted' };

  return {
    mode: 'tryit',
    apiKey: read.value,
    model: resolveAgentModel(TRYIT_MODEL_ENV),
    maxTokens: TRYIT_MAX_TOKENS,
    remaining: q.remaining,
  };
}

/** `x-forwarded-for`'s first hop, or 'unknown'. Shared so probe and send key alike. */
export function getClientIp(headers: Headers): string {
  return headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

/**
 * The `GET /api/agent/capabilities` response body (§4).
 *
 * Declared here rather than in the route because §5's `AgentChat` consumes the same
 * shape — the probe and its only reader resolve the contract through ONE definition,
 * for the same drift reason `fallbackQuota` lives here.
 */
export type Capabilities = {
  tryit: 'available' | 'exhausted' | 'unconfigured';
  /** null unless tryit is available or exhausted — §4 forbids inventing a count. */
  tryitRemaining: number | null;
  /** Always serialized from TRYIT_QUOTA, never a literal (§4, Codex R2 medium). */
  quota: number;
};

/**
 * The probe's account-key signal (design-single-backend §3.2).
 *
 * PRESENCE only — never the key, its length or its prefix. It exists so the show
 * page can drop the inline key affordance for a signed-in owner whose account
 * already carries a key (chunk 3), matching what `/api/agent/chat` already does.
 * The `{ accountKey: true }` payload is the whole body; there is no field that
 * could carry key material, by construction.
 */
export type AccountKeyReport = { accountKey: true };

/**
 * Project a resolved KeyMode onto the probe's wire shape.
 *
 * The probe passes no client key, so a `byoa` result here means a stored ACCOUNT
 * key was resolved for the authenticated user (§3.2) — a real, measured state, not
 * a programming error. It is reported as PRESENCE alone (`{ accountKey: true }`):
 * there is no path from here to a response carrying the key, its length or its
 * prefix (§4 hard requirement, §9 test 4). The try-it enum, when that is what
 * resolved, is likewise the whole payload.
 */
export function capabilitiesFrom(resolved: KeyMode): Capabilities | AccountKeyReport {
  switch (resolved.mode) {
    case 'byoa':
      return { accountKey: true };
    case 'unconfigured':
      return { tryit: 'unconfigured', tryitRemaining: null, quota: TRYIT_QUOTA };
    case 'exhausted':
      return { tryit: 'exhausted', tryitRemaining: 0, quota: TRYIT_QUOTA };
    case 'tryit':
      return { tryit: 'available', tryitRemaining: resolved.remaining, quota: TRYIT_QUOTA };
  }
}
