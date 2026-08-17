// What the transcript hands back to Claude, and what it hands to the composer.
//
// Design docs/design-ai-key-availability.md §5.2a.2b, work item 2.
//
// Lifted verbatim out of `AgentChat.buildApiMessages` (page.tsx) so the
// failed-turn exclusion rule is assertable. §9 test 13l requires asserting the
// FULL message array — "the partial text is absent" passes under a
// plausible-wrong fix that drops the text and leaves the `tool_use` block, which
// is the malformed-request case — and there was no way to reach the function to
// assert anything at all while it was a closure over component state.

import type { StreamToolCall } from './agent-stream';

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: StreamToolCall[];
  /** Set by a mid-stream failure. See `buildApiMessages`. */
  failed?: boolean;
}

export type ApiMessage = { role: string; content: unknown };

/**
 * Replay the transcript as Anthropic message history.
 *
 * **§5.2a.2b — a `failed` turn is excluded entirely**, both its assistant blocks
 * and any `tool_result` derived from them. Codex R1 medium on #137 found the
 * gap: this function replays every assistant message as canonical context, so a
 * failed half-turn would be handed back as though it had completed, and the
 * model would continue from something it never actually said.
 *
 * Excluded rather than truncated, for two reasons:
 *   1. Half a sentence sent as a completed assistant message invites the model
 *      to treat it as deliberate.
 *   2. A replayed `tool_use` without its `tool_result` is a malformed request.
 *      The `tool_result` is only emitted once a call leaves `pending`, so
 *      keeping a failed turn produces exactly that dangling pair.
 *
 * Dropping an assistant turn can leave two consecutive `user` messages. That is
 * valid — the Messages API combines consecutive same-role messages into one
 * turn — and it is the honest shape: the user asked, and nothing came back.
 */
export function buildApiMessages(messages: HistoryMessage[]): ApiMessage[] {
  const apiMsgs: ApiMessage[] = [];
  for (const msg of messages) {
    if (msg.failed) continue;

    if (msg.role === 'user') {
      apiMsgs.push({ role: 'user', content: msg.content });
      continue;
    }

    const blocks: Array<Record<string, unknown>> = [];
    if (msg.content) blocks.push({ type: 'text', text: msg.content });
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
      }
    }
    apiMsgs.push({
      role: 'assistant',
      content: blocks.length === 1 && blocks[0].type === 'text' ? msg.content : blocks,
    });

    // Tool results, once the user has resolved them.
    if (msg.toolCalls?.some((tc) => tc.status !== 'pending')) {
      const resultBlocks: Array<Record<string, unknown>> = [];
      for (const tc of msg.toolCalls) {
        if (tc.status === 'applied') {
          resultBlocks.push({ type: 'tool_result', tool_use_id: tc.id, content: `Applied. ${tc.name} updated successfully.` });
        } else if (tc.status === 'rejected') {
          resultBlocks.push({ type: 'tool_result', tool_use_id: tc.id, content: 'Rejected by user.', is_error: true });
        }
      }
      if (resultBlocks.length > 0) {
        apiMsgs.push({ role: 'user', content: resultBlocks });
      }
    }
  }
  return apiMsgs;
}

/**
 * Is the composer gated behind an approve/reject decision?
 *
 * Feeds `canSendMessage`. Extracted alongside `buildApiMessages` because §9's
 * test 13m is precisely the interaction between the two: after a mid-stream
 * error that arrives *after* a tool block completed, this must be false. A
 * failed turn carries no tool calls (`finalizeTurn` discards them), so the rule
 * holds through the data rather than through a special case here.
 */
export function hasPendingTools(messages: HistoryMessage[]): boolean {
  return messages.some((m) => m.toolCalls?.some((tc) => tc.status === 'pending'));
}
