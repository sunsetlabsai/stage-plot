// ── Cloud relay S2: rate limiting (pure, time-injected) ──────────────────────
//
// (design-relay-cloud.md §3 S2.) Token buckets, keyed by grain (IP or conn).
// Pure so every grain is unit-testable with a fake clock; the socket binding
// (server.ts) owns which key/bucket guards which action. A drained bucket IS
// the temporary ban — refill is the parole.

export class TokenBucket {
  private tokens: number;
  private lastAt: number;

  constructor(
    private readonly capacity: number,     // burst
    private readonly refillPerMs: number,  // sustained rate
    now: number,
  ) {
    this.tokens = capacity;
    this.lastAt = now;
  }

  take(now: number): boolean {
    const elapsed = Math.max(0, now - this.lastAt);
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastAt = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  // Full again = no memory worth keeping (prune eligibility).
  isFull(now: number): boolean {
    return Math.min(this.capacity, this.tokens + Math.max(0, now - this.lastAt) * this.refillPerMs) >= this.capacity;
  }
}

// A bucket per key (per-IP grains), with pruning so a scan of strangers can't
// grow the map forever: full buckets carry no state and are dropped.
export class BucketMap {
  private buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
  ) {}

  take(key: string, now: number): boolean {
    let b = this.buckets.get(key);
    if (!b) {
      b = new TokenBucket(this.capacity, this.refillPerMs, now);
      this.buckets.set(key, b);
    }
    return b.take(now);
  }

  prune(now: number): void {
    for (const [k, b] of this.buckets) if (b.isFull(now)) this.buckets.delete(k);
  }

  get size(): number {
    return this.buckets.size;
  }
}

// Defaults (design-relay-cloud.md §8 Q2 — tune at UAT):
export const HELLO_RATE = { capacity: 20, refillPerMs: 10 / 60_000 };   // 10/min, burst 20, per IP
export const CREATE_RATE = { capacity: 5, refillPerMs: 3 / 60_000 };    // 3/min, burst 5, per IP
export const FRAME_RATE = { capacity: 30, refillPerMs: 30 / 1_000 };    // 30/s, per conn (pre-admission included)
export const MAX_CONNS_PER_IP = 20;
