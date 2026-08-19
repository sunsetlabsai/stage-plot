import { describe, it, expect } from 'vitest';
import { shouldRestoreComposer, rollbackOptimisticSend, isSavedKeyRejected } from '@/lib/send-recovery';

// Design docs/design-ai-key-availability.md §9 tests 13a–13d and 13c-i/ii/iii,
// chunk 4. The predicate and the transcript surgery are tested here because
// `sendMessage` lives inside a 6700-line component that no harness can drive.

describe('13a/13b — restore when nothing was delivered', () => {
  it('restores when the stream never started', () => {
    expect(shouldRestoreComposer(false)).toBe(true);
  });

  it('does not restore once the stream has started', () => {
    expect(shouldRestoreComposer(true)).toBe(false);
  });
});

describe('13c-i/ii — the predicate is the flag, not the text', () => {
  // These pin the REASON the flag exists. A tool-only stream carries
  // content_block_start / input_json_delta and no text at all, so an
  // implementation using `assistantText.length === 0` would restore a message
  // the model had already begun acting on (Codex R4 medium). The flag knows the
  // difference; a text-length check cannot.
  it('a started stream that produced no text is still not restored', () => {
    const streamStarted = true; // tool-only turn: bytes arrived, assistantText === ''
    expect(shouldRestoreComposer(streamStarted)).toBe(false);
  });

  it('a started stream that produced only unparseable bytes is not restored', () => {
    const streamStarted = true; // garbage SSE: read happened, parse yielded nothing
    expect(shouldRestoreComposer(streamStarted)).toBe(false);
  });
});

describe('13b — the optimistic transcript entry is dropped', () => {
  it('removes the trailing user message being rolled back', () => {
    const messages = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'a reply' },
      { role: 'user', content: 'the failed one' },
    ];
    expect(rollbackOptimisticSend(messages, 'the failed one')).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'a reply' },
    ]);
  });

  it('leaves the transcript alone when the last entry is an assistant message', () => {
    // The naive implementation drops the last element unconditionally, which
    // eats a reply. This is the test that separates the two.
    const messages = [
      { role: 'user', content: 'the failed one' },
      { role: 'assistant', content: 'a reply that did arrive' },
    ];
    expect(rollbackOptimisticSend(messages, 'the failed one')).toEqual(messages);
  });

  it('leaves the transcript alone when the trailing user text does not match', () => {
    const messages = [{ role: 'user', content: 'something else entirely' }];
    expect(rollbackOptimisticSend(messages, 'the failed one')).toEqual(messages);
  });

  it('handles an empty transcript without throwing', () => {
    expect(rollbackOptimisticSend([], 'anything')).toEqual([]);
  });

  it('does not mutate the array it was given', () => {
    const messages = [{ role: 'user', content: 'the failed one' }];
    const result = rollbackOptimisticSend(messages, 'the failed one');
    expect(messages).toHaveLength(1);
    expect(result).toHaveLength(0);
  });
});

describe('13 — §5.1 stale-key detection', () => {
  it('a 401 while holding a key is a rejection of that key', () => {
    expect(isSavedKeyRejected({ status: 401, hasKey: true })).toBe(true);
  });

  it('a 401 with NO key is the try-it-unavailable 401, not a rejection', () => {
    // The collision that would put "Clear saved key" in front of a user who has
    // no key to clear. It cannot happen in the route, and it must not happen
    // here either.
    expect(isSavedKeyRejected({ status: 401, hasKey: false })).toBe(false);
  });

  it('does not fire on the other failure statuses', () => {
    // 429 is quota exhaustion and 502 is an upstream/proxy fault. Offering to
    // clear a working key on either one destroys a good credential and sends
    // the user hunting for a problem that is not theirs.
    for (const status of [429, 500, 502, 503]) {
      expect(isSavedKeyRejected({ status, hasKey: true })).toBe(false);
    }
  });
});
