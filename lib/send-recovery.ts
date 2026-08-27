// What to do with the composer and the transcript when a send fails.
//
// Design docs/design-ai-key-availability.md §5.2a.4, chunk 4.
//
// `sendMessage` clears the composer BEFORE the fetch and no path puts it back
// (Codex R3 high on v4). The restore rules live here rather than inside the
// 6700-line page component for the same reason the storage rules do: a
// predicate that cannot be exercised in isolation is one nobody can prove.

/** Which BYOA backend a rejected key came from — the server's `keyReject` enum. */
export type KeyRejectSource = 'device' | 'account';

/**
 * §5.1 / design-account-key-recovery §3: which key did the server say Anthropic
 * rejected — or none?
 *
 * The client cannot infer this from what it sent. `/api/agent/chat` returns 401 in
 * THREE cases, two of them byte-identical on the wire: a rejected **BYOA** key
 * (device OR account), a rejected shared **try-it** key, and **unconfigured** (no
 * key at all). Only the first is the user's to fix. An earlier version keyed on
 * "401 while we hold a key," but chunk 3 broke its premise: the route now resolves a
 * BYOA key from the session `userId` with **no `Authorization` header**, so "no
 * header" no longer means "no key," and a headerless send can still be a real key
 * rejection.
 *
 * So the SERVER names the source. It sets `keyReject: 'device' | 'account'` on the
 * 401 exactly when it rejected a BYOA key, and omits it for the try-it and
 * unconfigured 401s. This reads that machine field (an enum the client switches on,
 * not response copy) and returns the source, or null when the 401 is not a
 * user-fixable key rejection.
 *
 * A function rather than an inline check because this is the whole of §5.1's
 * correctness and an inline condition inside a 6700-line component cannot be
 * exercised by any test in this repo.
 */
export function rejectedKeySource(args: { status: number; keyReject?: unknown }): KeyRejectSource | null {
  if (args.status !== 401) return null;
  return args.keyReject === 'device' || args.keyReject === 'account' ? args.keyReject : null;
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
