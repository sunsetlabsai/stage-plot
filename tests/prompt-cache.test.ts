import { describe, it, expect } from 'vitest';
import {
  PROMPT_CACHE_LIMIT,
  promptCacheKey,
  readPrompts,
  rememberPrompt,
  type PromptStore,
} from '@/lib/prompt-cache';

// Design docs/design-ai-key-availability.md §9 tests 13e–13h, chunk 4.
//
// Node environment ON PURPOSE. Under jsdom in this repo `sessionStorage` is a
// bare `{}` with `getItem` undefined, so none of this could run there — which is
// exactly why lib/prompt-cache.ts takes an injected store.

function fakeStore(initial: Record<string, string> = {}): PromptStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => { data[k] = v; },
    removeItem: (k: string) => { delete data[k]; },
  };
}

/** A store whose writes always fail — Safari private mode, quota exceeded. */
function throwingStore(): PromptStore {
  return {
    getItem: () => null,
    setItem: () => { throw new Error('QuotaExceededError'); },
    removeItem: () => {},
  };
}

describe('13e — round-trip and the ring', () => {
  it('reads back what was written', () => {
    const store = fakeStore();
    rememberPrompt(store, 'graham', 'my-show', 'four-piece rock band');
    expect(readPrompts(store, 'graham', 'my-show')).toEqual(['four-piece rock band']);
  });

  it('keeps exactly the newest PROMPT_CACHE_LIMIT, most recent first', () => {
    const store = fakeStore();
    for (let i = 1; i <= PROMPT_CACHE_LIMIT + 1; i++) {
      rememberPrompt(store, 'graham', 'my-show', `prompt ${i}`);
    }

    // Assert the FULL array, not just the length: a ring that evicts the wrong
    // end has the right size and the wrong contents.
    const expected = Array.from({ length: PROMPT_CACHE_LIMIT }, (_, i) => `prompt ${PROMPT_CACHE_LIMIT + 1 - i}`);
    expect(readPrompts(store, 'graham', 'my-show')).toEqual(expected);
    expect(readPrompts(store, 'graham', 'my-show')).not.toContain('prompt 1');
  });

  it('reads empty for a show that has never been written', () => {
    expect(readPrompts(fakeStore(), 'graham', 'untouched')).toEqual([]);
  });
});

describe('13f — prompts are scoped per show', () => {
  it('does not leak a prompt from one show into another', () => {
    const store = fakeStore();
    rememberPrompt(store, 'graham', 'show-a', 'A-only prompt');

    expect(readPrompts(store, 'graham', 'show-b')).toEqual([]);
    expect(readPrompts(store, 'other-owner', 'show-a')).toEqual([]);
    expect(readPrompts(store, 'graham', 'show-a')).toEqual(['A-only prompt']);
  });

  it('derives distinct keys per owner and show', () => {
    expect(promptCacheKey('graham', 'show-a')).not.toBe(promptCacheKey('graham', 'show-b'));
    expect(promptCacheKey('graham', 'show-a')).not.toBe(promptCacheKey('other', 'show-a'));
  });
});

describe('13g — exact repeats de-duplicate and move to most-recent', () => {
  it('does not occupy two slots, and promotes the repeat', () => {
    const store = fakeStore();
    rememberPrompt(store, 'graham', 'my-show', 'same prompt');
    rememberPrompt(store, 'graham', 'my-show', 'different prompt');
    rememberPrompt(store, 'graham', 'my-show', 'same prompt');

    // Distinguishes de-dup-and-promote from "skip the write if already present",
    // which would leave 'different prompt' at the front.
    expect(readPrompts(store, 'graham', 'my-show')).toEqual(['same prompt', 'different prompt']);
  });
});

describe('13h — the cache is best-effort and never breaks sending', () => {
  it('swallows a store that throws on write', () => {
    expect(() => rememberPrompt(throwingStore(), 'graham', 'my-show', 'a prompt')).not.toThrow();
  });

  it('degrades a corrupt cache to empty rather than throwing', () => {
    const store = fakeStore({ [promptCacheKey('graham', 'my-show')]: '{not json' });
    expect(readPrompts(store, 'graham', 'my-show')).toEqual([]);
  });

  it('ignores a cached value that is not an array of strings', () => {
    const store = fakeStore({ [promptCacheKey('graham', 'my-show')]: '{"prompt":"x"}' });
    expect(readPrompts(store, 'graham', 'my-show')).toEqual([]);
  });

  it('filters non-string entries out of a partially-corrupt array', () => {
    const store = fakeStore({ [promptCacheKey('graham', 'my-show')]: '["good", 42, null, "also good"]' });
    expect(readPrompts(store, 'graham', 'my-show')).toEqual(['good', 'also good']);
  });

  it('writing an empty prompt is a no-op, not an empty slot', () => {
    const store = fakeStore();
    rememberPrompt(store, 'graham', 'my-show', 'real prompt');
    rememberPrompt(store, 'graham', 'my-show', '');
    expect(readPrompts(store, 'graham', 'my-show')).toEqual(['real prompt']);
  });
});
