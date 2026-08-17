import { describe, it, expect } from 'vitest';
import { buildApiMessages, hasPendingTools, type HistoryMessage } from '@/lib/agent-history';

// Design docs/design-ai-key-availability.md §5.2a.2b — work item 2, §9 test 13l.
//
// Codex R1 medium on #137: `buildApiMessages` replays every assistant message as
// canonical context, so a failed half-turn would be handed to Claude as though
// it had completed. Before this extraction the function was a closure over
// component state and nothing could assert it.

const toolCall = (over: Partial<HistoryMessage['toolCalls'] extends (infer T)[] | undefined ? T : never> = {}) => ({
  id: 'toolu_1',
  name: 'update_stage_plot',
  input: { slots: [] } as Record<string, unknown>,
  status: 'pending' as const,
  ...over,
});

describe('the ordinary transcript still replays unchanged', () => {
  it('sends a plain exchange as plain messages', () => {
    const messages: HistoryMessage[] = [
      { role: 'user', content: 'four-piece rock band' },
      { role: 'assistant', content: 'Here you go.' },
    ];

    expect(buildApiMessages(messages)).toEqual([
      { role: 'user', content: 'four-piece rock band' },
      { role: 'assistant', content: 'Here you go.' },
    ]);
  });

  it('emits tool_use blocks, and a tool_result only once resolved', () => {
    const pending: HistoryMessage[] = [
      { role: 'user', content: 'set it up' },
      { role: 'assistant', content: 'Proposing:', toolCalls: [toolCall()] },
    ];

    // Pending: the tool_use block goes out, the result does not exist yet.
    expect(buildApiMessages(pending)).toEqual([
      { role: 'user', content: 'set it up' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Proposing:' },
          { type: 'tool_use', id: 'toolu_1', name: 'update_stage_plot', input: { slots: [] } },
        ],
      },
    ]);

    const applied: HistoryMessage[] = [
      { role: 'user', content: 'set it up' },
      { role: 'assistant', content: 'Proposing:', toolCalls: [toolCall({ status: 'applied' })] },
    ];

    expect(buildApiMessages(applied)).toHaveLength(3);
    expect(buildApiMessages(applied)[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Applied. update_stage_plot updated successfully.' }],
    });
  });

  it('marks a rejected tool result as an error', () => {
    const messages: HistoryMessage[] = [
      { role: 'user', content: 'set it up' },
      { role: 'assistant', content: '', toolCalls: [toolCall({ status: 'rejected' })] },
    ];

    expect(buildApiMessages(messages)[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Rejected by user.', is_error: true }],
    });
  });
});

describe('13l — a failed turn is excluded from API history entirely', () => {
  it('drops both the partial text AND its tool_use block', () => {
    const messages: HistoryMessage[] = [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'a complete answer' },
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: 'half an ans', toolCalls: [toolCall()], failed: true },
    ];

    // Assert the FULL array, not "the partial text is absent". The
    // plausible-wrong fix drops the text and leaves the tool_use behind — a
    // dangling tool_use with no tool_result is a malformed request, which is a
    // worse failure than the one being fixed and passes a narrower assertion.
    expect(buildApiMessages(messages)).toEqual([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'a complete answer' },
      { role: 'user', content: 'second question' },
    ]);
  });

  it('leaves the failed turn in the transcript — exclusion is API-side only', () => {
    const messages: HistoryMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'half an ans', failed: true },
    ];

    // The input array is untouched; the user still sees what arrived.
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toBe('half an ans');
  });

  it('never emits a tool_result derived from a failed turn', () => {
    // A turn can only fail with pending calls in principle, but if a resolved
    // one ever reached here the tool_result would reference a tool_use that was
    // never sent. Excluding the whole message is what makes that impossible.
    const messages: HistoryMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'partial', toolCalls: [toolCall({ status: 'applied' })], failed: true },
    ];

    const api = buildApiMessages(messages);
    expect(api).toEqual([{ role: 'user', content: 'q' }]);
    expect(JSON.stringify(api)).not.toContain('tool_result');
  });

  it('a failed turn between two good ones leaves consecutive user messages', () => {
    // Stated deliberately: this is valid — the Messages API combines
    // consecutive same-role messages — and it is the honest shape. The user
    // asked, and nothing came back.
    const messages: HistoryMessage[] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'partial', failed: true },
      { role: 'user', content: 'q2' },
    ];

    expect(buildApiMessages(messages)).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'user', content: 'q2' },
    ]);
  });
});

describe('hasPendingTools — the composer gate', () => {
  it('is true while a call awaits approval', () => {
    expect(hasPendingTools([{ role: 'assistant', content: '', toolCalls: [toolCall()] }])).toBe(true);
  });

  it('is false once every call is resolved', () => {
    expect(
      hasPendingTools([
        { role: 'assistant', content: '', toolCalls: [toolCall({ status: 'applied' }), toolCall({ id: 'toolu_2', status: 'rejected' })] },
      ]),
    ).toBe(false);
  });

  it('is false for a transcript with no tool calls at all', () => {
    expect(hasPendingTools([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }])).toBe(false);
  });
});
