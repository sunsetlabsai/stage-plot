import { describe, it, expect, vi } from 'vitest';
import { createBpmWriter } from '../lib/bpm-writer';

// ── UX polish §3: the guarded canonical-BPM write path ───────────────────────
// Codex BUILD HIGHs on a3b29b3: (1) a failed PUT must not leave optimistic state
// visible while the DB keeps the old tempo; (2) out-of-order responses must not
// patch an older bpm last. The writer answers with optimistic patch +
// latest-request-wins (abort) + revert-to-last-confirmed on failure.

/** A put whose resolution the test controls, capturing each call + its signal. */
function makePut() {
  const calls: { bpm: number | null; signal: AbortSignal; resolve: (ok: boolean) => void; reject: (e: unknown) => void }[] = [];
  const put = (_songId: string, bpm: number | null, signal: AbortSignal) =>
    new Promise<boolean>((resolve, reject) => {
      calls.push({ bpm, signal, resolve, reject });
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

  it('latest write wins: aborts the in-flight PUT and ignores its late outcome', async () => {
    const { writer, calls, patch } = makeWriter(120);
    const w1 = writer('s1', 130);
    const w2 = writer('s1', 140);
    expect(calls[0].signal.aborted).toBe(true); // superseded request cancelled
    calls[1].resolve(true); // newer write lands first
    await w2;
    calls[0].resolve(true); // older response straggles in late…
    await w1;
    await flush();
    // …and changes nothing: optimistic 130, optimistic 140, no further patches.
    expect(patch.mock.calls).toEqual([['s1', 130], ['s1', 140]]);
  });

  it('a superseded FAILURE does not revert over the newer write', async () => {
    const { writer, calls, patch } = makeWriter(120);
    const w1 = writer('s1', 130);
    const w2 = writer('s1', 140);
    calls[0].reject(new DOMException('aborted', 'AbortError'));
    await w1;
    calls[1].resolve(true);
    await w2;
    expect(patch.mock.calls).toEqual([['s1', 130], ['s1', 140]]);
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

  it('tracks songs independently', async () => {
    const { writer, calls, patch } = makeWriter(100);
    const w1 = writer('s1', 130);
    const w2 = writer('s2', 90);
    expect(calls[0].signal.aborted).toBe(false); // different song — no abort
    calls[0].resolve(true);
    calls[1].resolve(false);
    await Promise.all([w1, w2]);
    expect(patch.mock.calls).toEqual([['s1', 130], ['s2', 90], ['s2', 100]]);
  });
});
