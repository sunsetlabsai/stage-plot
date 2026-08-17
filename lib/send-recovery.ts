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
 * `streamStarted` is set at the FIRST `reader.read()` chunk, before any SSE
 * parsing — not at the parse, and emphatically not `assistantText.length === 0`
 * (Codex R4 medium: a tool-only stream carries `content_block_start` /
 * `input_json_delta` with no text at all, and treating that as never-sent would
 * restore a message the model had already begun acting on).
 *
 * Chunk 4 scope: every failure reaching this point is a non-`ok` response,
 * because `route.ts` tests `anthropicRes.ok` BEFORE it streams and the client
 * throws before `getReader()`. The mid-stream-error case — where a stream opens
 * and then dies — is §5.2a.2, a separate work item (§5.2a.0 item 2).
 */
export function shouldRestoreComposer(streamStarted: boolean): boolean {
  return !streamStarted;
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
