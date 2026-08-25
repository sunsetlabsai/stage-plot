import { createHash } from 'node:crypto';

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

  reset() {
    this.rows.clear();
    this.incrCalls = 0;
    this.peekCalls = 0;
    this.throws = false;
    this.errors = false;
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

function hash(ip: string): string {
  return createHash('sha256').update(ip).digest('hex');
}

/**
 * Factory for `vi.mock('@/lib/supabase-admin', () => supabaseAdminMock())`.
 *
 * Only `.rpc()` is implemented — it is the only surface `quota()` touches, and a
 * mock that answered more than the code calls would be asserting fiction.
 */
export function supabaseAdminMock() {
  return {
    getSupabaseAdmin: () => ({
      rpc: async (fn: string, args: Record<string, unknown>) => {
        // Counted BEFORE the failure branches, so a failing RPC is still an
        // observable attempt. Counting after would make `calls === 0` ambiguous
        // between "never tried" and "tried and blew up" — and the BYOA
        // no-I/O assertion depends on that distinction being sharp.
        if (fn === 'peek_tryit') quotaBackend.peekCalls++;
        else if (fn === 'increment_tryit') quotaBackend.incrCalls++;
        else throw new Error(`unexpected rpc: ${fn}`);

        if (quotaBackend.throws) throw new Error('ECONNREFUSED');
        if (quotaBackend.errors) {
          return { data: null, error: { message: 'rpc failed' } };
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
