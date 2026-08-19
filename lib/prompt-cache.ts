// Where a sent prompt lives so it is never lost.
//
// Design docs/design-ai-key-availability.md §5.2a.3, chunk 4.
//
// §5.2 spent four review rounds deciding whether it was SAFE to restore a
// user's text after a failure — every answer traded losing their words against
// re-sending a turn that may have billed. Graham's ruling dissolved the trade:
// cache the prompt and the question stops being load-bearing. `streamStarted`
// still decides whether restoring is AUTOMATIC (see lib/send-recovery.ts), but
// it no longer decides whether the words survive.
//
// The store is INJECTED rather than closed over, and that is mandatory, not
// stylistic: under `@vitest-environment jsdom` in this repo `sessionStorage` is
// a bare `{}` with `getItem` undefined, so a module reaching for the global
// could not be tested at all. That is exactly why the BYOA key path shipped
// with zero coverage before #133.

/** The slice of the DOM Storage API these rules need — so tests can fake it. */
export type PromptStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * §5.2a.3: a ring, not unbounded growth. `sessionStorage` is small and a prompt
 * describing a full band can be long.
 */
export const PROMPT_CACHE_LIMIT = 10;

/**
 * Cached per show, so one show's prompts never surface in another.
 *
 * The owner/show pair is the same identity the route uses, which is what keeps
 * this aligned with what the user thinks of as "this show".
 */
export function promptCacheKey(owner: string, show: string): string {
  return `showrunr-prompts:${owner}/${show}`;
}

/**
 * Most recent first. Anything unparseable or not a string array reads as empty
 * — a corrupt cache must degrade to "no history", never throw into the send
 * path.
 */
export function readPrompts(store: PromptStore, owner: string, show: string): string[] {
  let raw: string | null;
  try {
    raw = store.getItem(promptCacheKey(owner, show));
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === 'string');
  } catch {
    return [];
  }
}

/**
 * Record a prompt at the moment it is sent.
 *
 * An exact repeat MOVES to most-recent rather than occupying a second slot —
 * re-asking the same thing is common and should not evict nine other prompts.
 *
 * **Best-effort by design.** A store that throws on `setItem` (Safari private
 * mode, quota exceeded) must not break sending. The cache is a safety net; a
 * net that takes the trapeze down with it is worse than none. This is the §5.2a
 * instance of the rule this project keeps re-learning: an error path must not
 * strand the caller.
 */
export function rememberPrompt(
  store: PromptStore,
  owner: string,
  show: string,
  prompt: string,
): void {
  if (!prompt) return;
  const existing = readPrompts(store, owner, show);
  const deduped = existing.filter((p) => p !== prompt);
  const next = [prompt, ...deduped].slice(0, PROMPT_CACHE_LIMIT);
  try {
    store.setItem(promptCacheKey(owner, show), JSON.stringify(next));
  } catch {
    // Deliberately swallowed — see the doc comment above.
  }
}
