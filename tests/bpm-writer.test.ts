import { describe, it, expect, vi } from 'vitest';
import { createBpmWriter } from '../lib/bpm-writer';

// ── UX polish §3: the guarded canonical-BPM write path ───────────────────────
// Codex BUILD R1+R2 on the naive fire-per-emit PUT: (1) a failed PUT must not
// leave optimistic state visible while the DB keeps the old tempo; (2) ordering
// must hold END TO END — client-side abort can't stop a request the server has
// already received, so the writer SERIALIZES: one in-flight PUT per song, newer
// intents coalesce and are sent only after the prior request settles. Failure of
// the final settled write (nothing newer queued) reverts to the last ACKed bpm.

/** A put whose resolution the test controls, capturing each call in order. */
function makePut() {
  const calls: { songId: string; bpm: number | null; resolve: (ok: boolean) => void; reject: (e: unknown) => void }[] = [];
  const put = (songId: string, bpm: number | null) =>
    new Promise<boolean>((resolve, reject) => {
      calls.push({ songId, bpm, resolve, reject });
    });
  return { put, calls };
}

function makeWriter(current: number | null = 120) {
  const { put, calls } = makePut();
  const patch = vi.fn<(songId: string, bpm: number | null) => void>();
  const writer = createBpmWriter({ put, getCurrent: () => current, patch });
  return { writer, calls, patch };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createBpmWriter', () => {
  it('patches optimistically and keeps the value on success', async () => {
    const { writer, calls, patch } = makeWriter(120);
    const w = writer('s1', 130);
    expect(patch).toHaveBeenCalledWith('s1', 130); // before the response
    calls[0].resolve(true);
    await w;
    expect(patch).toHaveBeenCalledTimes(1); // no revert
  });

  it('reverts to the pre-write bpm when the PUT returns !ok', async () => {
    const { writer, calls, patch } = makeWriter(120);
    const w = writer('s1', 130);
    calls[0].resolve(false);
    await w;
    expect(patch.mock.calls).toEqual([['s1', 130], ['s1', 120]]);
  });

  it('reverts (and does not throw) when the fetch rejects', async () => {
    const { writer, calls, patch } = makeWriter(120);
    const w = writer('s1', null); // clearing to manual
    calls[0].reject(new TypeError('network down'));
    await expect(w).resolves.toBeUndefined();
    expect(patch.mock.calls).toEqual([['s1', null], ['s1', 120]]);
  });

  it('serializes: a second write is NOT sent until the first settles', async () => {
    const { writer, calls, patch } = makeWriter(120);
    void writer('s1', 130);
    void writer('s1', 140);
    expect(calls).toHaveLength(1); // 140 queued, not raced — server sees order
    calls[0].resolve(true);
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1].bpm).toBe(140);
    calls[1].resolve(true);
    await flush();
    // Optimistic 130, optimistic 140 — no further patches after both ACK.
    expect(patch.mock.calls).toEqual([['s1', 130], ['s1', 140]]);
  });

  it('coalesces: three quick writes send first + latest only', async () => {
    const { writer, calls } = makeWriter(120);
    void writer('s1', 130);
    void writer('s1', 135);
    void writer('s1', 140);
    calls[0].resolve(true);
    await flush();
    calls[1]?.resolve(true);
    await flush();
    expect(calls.map((c) => c.bpm)).toEqual([130, 140]); // 135 coalesced away
  });

  it('an intermediate failure with a newer intent queued does not revert', async () => {
    const { writer, calls, patch } = makeWriter(120);
    void writer('s1', 130);
    void writer('s1', 140);
    calls[0].resolve(false); // older write fails, but 140 owns the outcome
    await flush();
    calls[1].resolve(true);
    await flush();
    expect(patch.mock.calls).toEqual([['s1', 130], ['s1', 140]]); // no revert patch
  });

  it('confirmed tempo advances: a later failure reverts to the last ACKed bpm, not the seed', async () => {
    const { writer, calls, patch } = makeWriter(120);
    const w1 = writer('s1', 130);
    calls[0].resolve(true); // 130 acknowledged
    await w1;
    const w2 = writer('s1', 140);
    calls[1].resolve(false);
    await w2;
    expect(patch.mock.calls).toEqual([['s1', 130], ['s1', 140], ['s1', 130]]);
  });

  it('final failure at the end of a coalesced chain reverts to the last ACKed bpm', async () => {
    const { writer, calls, patch } = makeWriter(120);
    void writer('s1', 130);
    void writer('s1', 140);
    calls[0].resolve(true); // 130 ACKed mid-chain
    await flush();
    calls[1].resolve(false); // latest intent fails, nothing newer queued
    await flush();
    expect(patch.mock.calls).toEqual([['s1', 130], ['s1', 140], ['s1', 130]]);
  });

  it('writes made after a settled chain start a new request (chain does not wedge)', async () => {
    const { writer, calls } = makeWriter(120);
    const w1 = writer('s1', 130);
    calls[0].resolve(true);
    await w1;
    void writer('s1', 140);
    expect(calls).toHaveLength(2); // sent immediately — no stale "running" latch
    calls[1].resolve(true);
  });

  it('tracks songs independently (no cross-song serialization)', async () => {
    const { writer, calls, patch } = makeWriter(100);
    const w1 = writer('s1', 130);
    const w2 = writer('s2', 90);
    expect(calls).toHaveLength(2); // different songs run concurrently
    calls[0].resolve(true);
    calls[1].resolve(false);
    await Promise.all([w1, w2]);
    expect(patch.mock.calls).toEqual([['s1', 130], ['s2', 90], ['s2', 100]]);
  });
});
