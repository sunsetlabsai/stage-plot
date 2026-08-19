// What to do with the composer and the transcript when a send fails.
//
// Design docs/design-ai-key-availability.md §5.2a.4, chunk 4.
//
// `sendMessage` clears the composer BEFORE the fetch and no path puts it back
// (Codex R3 high on v4). The restore rules live here rather than inside the
// 6700-line page component for the same reason the storage rules do: a
// predicate that cannot be exercised in isolation is one nobody can prove.

/**
 * §5.1: did the server reject the key we are holding?
 *
 * `/api/agent/chat` has exactly two 401s: Anthropic rejecting a supplied key
 * (`route.ts:104`), and try-it being unavailable when no key was supplied
 * (`route.ts:63-70`). The second cannot fire while we hold a key, because the
 * client only omits the `Authorization` header when `apiKey` is empty
 * (`page.tsx:5111`) and the route resolves to `byoa` whenever that header is
 * present. So "401 while holding a key" identifies the rejection without
 * matching on the error string, which is copy and will change.
 *
 * A predicate rather than an inline `&&` because the reasoning above is the
 * whole of §5.1's correctness, and an inline condition inside a 6700-line
 * component cannot be exercised by any test in this repo.
 */
export function isSavedKeyRejected(args: { status: number; hasKey: boolean }): boolean {
  return args.status === 401 && args.hasKey;
}

/** The shape these rules need from a transcript entry. */
export interface OptimisticMessage {
  role: string;
  content: string;
}

/**
 * Restore only when nothing was delivered.
 *
 * **The criterion is what reached the transcript, not when the first byte
 * arrived.** Chunk 4 keyed this on `streamStarted` (set at the first
 * `reader.read()`), which was right for chunk 4's scope — every failure that
 * could reach it was a non-`ok` response, so "bytes arrived" and "content
 * arrived" could not disagree. Item 2 makes them disagree: a stream can now
 * open, emit `message_start`, and die before any text or tool block completes.
 * Under the byte rule that committed an assistant turn whose entire content was
 * the red "This response was interrupted" line, and left the composer empty.
 *
 * **Why that was worth changing rather than tolerating** (Codex R1 on item 2
 * called it a UX preference and declined to block; Graham ruled to fold it):
 * the justification for not restoring was that the text is recoverable from the
 * §5.2a.3 prompt cache — and `readPrompts` currently has no production caller,
 * so during UAT the cache cannot hand anything back. The text does remain
 * visible in the transcript, so this was never data loss; it was a
 * select-copy-paste where one click will do.
 *
 * **Codex R4's medium still holds and is why `completedToolCalls` exists.** A
 * tool-only turn carries `content_block_start` / `input_json_delta` and no text
 * at all; `assistantText.length === 0` alone would restore a message the model
 * had already begun acting on. Counting completed tool calls draws the line the
 * bare boolean could not: tool-only-and-completed is delivered, nothing-at-all
 * is not.
 *
 * **A tool block still in flight counts as NOT delivered, deliberately.** It
 * never becomes a completed call, and `finalizeTurn` discards even *completed*
 * tool calls on a failed turn (§5.2a.2b) — so nothing from it survives into the
 * transcript. Treating it as delivered would strand the caller for the sake of
 * a proposal no one will ever see.
 *
 * `streamStarted` is gone as a parameter because it is now strictly implied: no
 * bytes read means no events reduced, which means `newStreamState()` — empty
 * text, no tool calls. Keeping it would have been a second source of truth for
 * one question.
 */
export function shouldRestoreComposer(arrived: {
  text: string;
  completedToolCalls: number;
}): boolean {
  return arrived.text.length === 0 && arrived.completedToolCalls === 0;
}

/**
 * Drop the optimistic user message that `sendMessage` appended.
 *
 * Nothing was delivered, so the transcript must not claim otherwise — a
 * restored composer PLUS a stranded transcript entry is the worst of both, and
 * it reads as though the message was sent twice.
 *
 * Removes the trailing entry only when it is the user message we are rolling
 * back. The naive version — drop the last element unconditionally — eats an
 * assistant message if this is ever called on a transcript that has moved on,
 * so the guard is the point rather than defensive noise.
 */
export function rollbackOptimisticSend<T extends OptimisticMessage>(
  messages: T[],
  userText: string,
): T[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user' || last.content !== userText) return messages;
  return messages.slice(0, -1);
}
