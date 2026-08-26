import { createHmac } from 'node:crypto';

// In-memory stand-in for the try-it quota backend (chunk 2).
//
// Lives in ONE place for the same reason `fallbackQuota` does: three suites
// (agent-key, agent-capabilities, agent-chat-route) assert on quota behaviour,
// and if each grew its own mock they would drift apart from the SQL and from
// each other — and a green suite would stop meaning anything.
//
// The two functions below mirror `increment_tryit` (001_initial_schema.sql) and
// `peek_tryit` (013_peek_tryit.sql) exactly, INCLUDING the fixed-window reset.
// If the SQL changes, change it here in the same commit.

type Row = { count: number; windowStart: number };

const DAY_MS = 24 * 60 * 60 * 1000;

export const quotaBackend = {
  rows: new Map<string, Row>(),
  incrCalls: 0,
  peekCalls: 0,
  /** Backend unreachable: `.rpc()` rejects. Must degrade to fallback(), not throw. */
  throws: false,
  /** Backend reachable but the call failed: `{data: null, error}`. Same requirement. */
  errors: false,
  /**
   * Postgres SQLSTATE returned alongside `errors`. Defaults to a transient class
   * so the existing degrade-to-fallback tests keep their meaning; set '42501' to
   * exercise the fail-CLOSED branch.
   */
  errorCode: '08006',

  reset() {
    this.rows.clear();
    this.incrCalls = 0;
    this.peekCalls = 0;
    this.throws = false;
    this.errors = false;
    this.errorCode = '08006';
  },

  /** Total RPC calls. The BYOA path must leave this at 0 — no I/O on that branch. */
  get calls() {
    return this.incrCalls + this.peekCalls;
  },

  /**
   * Seed usage for a RAW ip, hashing it the way lib/agent-key does. Tests name
   * IPs, not digests; keeping the hash on this side is what lets them stay
   * readable while still exercising the real key derivation.
   */
  seed(ip: string, count: number, ageDays = 0) {
    this.rows.set(hash(ip), { count, windowStart: Date.now() - ageDays * DAY_MS });
  },

  /** Current count for a raw ip, after window expiry — what the DB would hold. */
  countFor(ip: string, windowDays = 30): number {
    const row = this.rows.get(hash(ip));
    if (!row) return 0;
    return row.windowStart < Date.now() - windowDays * DAY_MS ? 0 : row.count;
  },
};

// Mirrors lib/agent-key.ts's hashIp: HMAC keyed on the service-role secret, NOT
// a bare digest. Read from process.env at call time, not module load — the
// suites set the var in beforeEach, and capturing it at import would key every
// seed with `undefined` and silently miss every row.
function hash(ip: string): string {
  return createHmac('sha256', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').update(ip).digest('hex');
}

/**
 * In-memory stand-in for the account-stored BYOA key (chunk 3).
 *
 * Mirrors `set_user_secret` / `get_user_secret` / `delete_user_secret` from
 * `015_user_secrets_vault.sql`, including the length guard and the hint
 * derivation. Same rule as the quota mock above: **if the SQL changes, change
 * this in the same commit**, or the suite starts certifying fiction.
 *
 * It lives beside the quota backend rather than in its own file because both
 * are reached through the SAME `@/lib/supabase-admin` mock — two factories
 * would mean two `vi.mock` calls fighting over one module.
 */
export const secretsBackend = {
  /** userId -> plaintext key. The DB stores a vault id; the mock stores the value. */
  keys: new Map<string, string>(),
  getCalls: 0,
  setCalls: 0,
  deleteCalls: 0,
  /** RPC rejects outright. `readAccountKey` must fall through, not throw. */
  throws: false,
  /** RPC returns `{data: null, error}`. Same requirement. */
  errors: false,
  errorCode: '08006',

  reset() {
    this.keys.clear();
    this.getCalls = 0;
    this.setCalls = 0;
    this.deleteCalls = 0;
    this.throws = false;
    this.errors = false;
    this.errorCode = '08006';
  },

  /** Total secret RPCs. The DEVICE-key branch must leave this at 0 (§4.4). */
  get calls() {
    return this.getCalls + this.setCalls + this.deleteCalls;
  },
};

/** Mirrors the hint derivation in `set_user_secret`. */
export function expectedHint(key: string): string {
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}

/**
 * Factory for `vi.mock('@/lib/supabase-admin', () => supabaseAdminMock())`.
 *
 * Only `.rpc()` and a narrow `.from().select().eq().maybeSingle()` chain are
 * implemented — those are the only surfaces the code touches, and a mock that
 * answered more than the code calls would be asserting fiction.
 */
export function supabaseAdminMock() {
  return {
    getSupabaseAdmin: () => ({
      // Used by GET /api/settings/byoa, which reads the HINT column only and
      // never the key. Modelled explicitly so a test can prove the read path
      // has no way to reach a secret even if it wanted one.
      from: (table: string) => {
        if (table !== 'user_secrets') throw new Error(`unexpected table: ${table}`);
        return {
          select: (columns: string) => {
            if (/key|secret/.test(columns.replace('key_hint', ''))) {
              throw new Error(`settings read asked for a secret column: ${columns}`);
            }
            return {
              eq: (_col: string, userId: string) => ({
                maybeSingle: async () => {
                  if (secretsBackend.errors) {
                    return { data: null, error: { message: 'read failed', code: secretsBackend.errorCode } };
                  }
                  const key = secretsBackend.keys.get(userId);
                  return {
                    data: key ? { key_hint: expectedHint(key), updated_at: '2026-08-26T00:00:00Z' } : null,
                    error: null,
                  };
                },
              }),
            };
          },
        };
      },

      rpc: async (fn: string, args: Record<string, unknown>) => {
        // Counted BEFORE the failure branches, so a failing RPC is still an
        // observable attempt. Counting after would make `calls === 0` ambiguous
        // between "never tried" and "tried and blew up" — and the BYOA
        // no-I/O assertion depends on that distinction being sharp.
        if (fn === 'peek_tryit') quotaBackend.peekCalls++;
        else if (fn === 'increment_tryit') quotaBackend.incrCalls++;
        else if (fn === 'get_user_secret' || fn === 'set_user_secret' || fn === 'delete_user_secret') {
          if (fn === 'get_user_secret') secretsBackend.getCalls++;
          if (fn === 'set_user_secret') secretsBackend.setCalls++;
          if (fn === 'delete_user_secret') secretsBackend.deleteCalls++;

          if (secretsBackend.throws) throw new Error('ECONNREFUSED');
          if (secretsBackend.errors) {
            return { data: null, error: { message: 'rpc failed', code: secretsBackend.errorCode } };
          }

          const userId = args.p_user_id as string;

          if (fn === 'get_user_secret') {
            return { data: secretsBackend.keys.get(userId) ?? null, error: null };
          }
          if (fn === 'set_user_secret') {
            const key = args.p_key as string;
            // Mirrors the SQL's `length(p_key) < 20` guard.
            if (!key || key.length < 20) {
              return { data: null, error: { message: 'key is too short to store safely', code: 'P0001' } };
            }
            secretsBackend.keys.set(userId, key);
            return { data: expectedHint(key), error: null };
          }
          // delete_user_secret
          const had = secretsBackend.keys.delete(userId);
          return { data: had, error: null };
        } else throw new Error(`unexpected rpc: ${fn}`);

        if (quotaBackend.throws) throw new Error('ECONNREFUSED');
        if (quotaBackend.errors) {
          return { data: null, error: { message: 'rpc failed', code: quotaBackend.errorCode } };
        }

        const ipHash = args.p_ip_hash as string;
        const windowDays = args.p_window_days as number;
        const now = Date.now();
        const row = quotaBackend.rows.get(ipHash);
        const aged = row ? row.windowStart < now - windowDays * DAY_MS : false;

        if (fn === 'peek_tryit') {
          // Reads only. An unseen IP must not be written here, or the "a probe
          // must not cost a message" guarantee would be untested.
          return { data: !row || aged ? 0 : row.count, error: null };
        }

        // increment_tryit — the only remaining case: peek returned above, and an
        // unrecognised fn threw before we got here.
        const next: Row =
          !row || aged ? { count: 1, windowStart: now } : { count: row.count + 1, windowStart: row.windowStart };
        quotaBackend.rows.set(ipHash, next);
        return { data: next.count, error: null };
      },
    }),
  };
}
