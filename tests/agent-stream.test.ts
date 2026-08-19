import { describe, it, expect } from 'vitest';
import {
  newStreamState,
  splitSseData,
  parseSseEvent,
  reduceStreamEvent,
  finalizeTurn,
  arrivedFrom,
  type StreamState,
} from '@/lib/agent-stream';
import { shouldRestoreComposer } from '@/lib/send-recovery';
import { hasPendingTools } from '@/lib/agent-history';

// Design docs/design-ai-key-availability.md §5.2a.2 + §5.2a.2b — work item 2.
//
// §9's tests 13i, 13j and 13m are written against the SSE parse loop, which
// lived inside a 6700-line client component. These assert the rules the loop now
// delegates to.

/** Drive a whole stream the way the page does: split, parse, reduce. */
function runStream(chunks: string[]): StreamState {
  let state = newStreamState();
  let buffer = '';
  for (const chunk of chunks) {
    buffer += chunk;
    const { payloads, rest } = splitSseData(buffer);
    buffer = rest;
    for (const payload of payloads) {
      const event = parseSseEvent(payload);
      if (!event) continue;
      state = reduceStreamEvent(state, event);
    }
  }
  return state;
}

const textDelta = (text: string) =>
  `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n`;

const toolStart = (id: string, name: string) =>
  `data: ${JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id, name } })}\n`;

const toolJson = (partial_json: string) =>
  `data: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json } })}\n`;

const blockStop = () => `data: ${JSON.stringify({ type: 'content_block_stop', index: 1 })}\n`;

// Verified against Anthropic's streaming docs, not assumed:
//   event: error
//   data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}
const errorEvent = (message = 'Overloaded', type = 'overloaded_error') =>
  `data: ${JSON.stringify({ type: 'error', error: { type, message } })}\n`;

describe('the happy path still works', () => {
  it('accumulates text', () => {
    const state = runStream([textDelta('Four-piece '), textDelta('rock band.')]);

    expect(state.text).toBe('Four-piece rock band.');
    expect(state.failed).toBe(false);
    expect(finalizeTurn(state)).toEqual({ role: 'assistant', content: 'Four-piece rock band.' });
  });

  it('collects a completed tool call as pending', () => {
    const state = runStream([
      toolStart('toolu_1', 'update_stage_plot'),
      toolJson('{"slots":'),
      toolJson('[]}'),
      blockStop(),
    ]);

    expect(finalizeTurn(state).toolCalls).toEqual([
      { id: 'toolu_1', name: 'update_stage_plot', input: { slots: [] }, status: 'pending' },
    ]);
  });

  it('reassembles a JSON object split across two reads', () => {
    // The normal case, not an edge case: a chunk boundary lands mid-line. The
    // old loop handled this with `lines.pop()`; splitSseData has to keep doing it.
    const whole = textDelta('hello');
    const state = runStream([whole.slice(0, 20), whole.slice(20)]);

    expect(state.text).toBe('hello');
  });

  it('ignores [DONE], event: lines, and keep-alive blanks', () => {
    const state = runStream(['event: content_block_delta\n', textDelta('x'), '\n', 'data: [DONE]\n']);

    expect(state.text).toBe('x');
  });

  it('skips a malformed tool payload rather than aborting the stream', () => {
    const state = runStream([
      toolStart('toolu_1', 'update_stage_plot'),
      toolJson('{not json'),
      blockStop(),
      textDelta('carrying on'),
    ]);

    expect(state.toolCalls).toEqual([]);
    expect(state.text).toBe('carrying on');
    expect(state.failed).toBe(false);
  });
});

describe('13i — a mid-stream error surfaces AND keeps the partial content', () => {
  it('records the error and does not discard the text that arrived', () => {
    const state = runStream([textDelta('Here is your stage pl'), errorEvent()]);

    // BOTH halves. Asserting the text alone passes against the UNFIXED code —
    // today the loop ends silently and commits the partial with no error — so
    // this is the assertion that distinguishes the fix from the defect.
    expect(state.failed).toBe(true);
    expect(state.errorMessage).toBe('Overloaded');
    expect(state.text).toBe('Here is your stage pl');
    expect(finalizeTurn(state)).toEqual({
      role: 'assistant',
      content: 'Here is your stage pl',
      failed: true,
    });
  });

  it('falls back to plain copy when the error carries no message', () => {
    const state = runStream([`data: ${JSON.stringify({ type: 'error', error: {} })}\n`]);

    expect(state.failed).toBe(true);
    expect(state.errorMessage).toBeTruthy();
  });

  it('an unrecognised event type is not treated as a failure', () => {
    // The bug this section fixes was an unhandled event falling through
    // silently. The fix must not overcorrect into "anything unknown is fatal" —
    // the API adds event types and the docs say to tolerate them.
    const state = runStream([
      `data: ${JSON.stringify({ type: 'message_start', message: {} })}\n`,
      textDelta('fine'),
      `data: ${JSON.stringify({ type: 'ping' })}\n`,
    ]);

    expect(state.failed).toBe(false);
    expect(state.text).toBe('fine');
  });
});

describe('13j — a mid-stream error is NOT the pre-stream case', () => {
  it('keeps the transcript entry and leaves the composer alone', () => {
    const state = runStream([textDelta('partial'), errorEvent()]);

    // It was delivered and billed (§5.2a.4 row 2). The turn stays.
    expect(finalizeTurn(state).content).toBe('partial');
    // And the composer is not refilled — text reached the transcript. Asserted
    // through arrivedFrom so this tracks the real call site, not a hand-built
    // boolean that could drift from it.
    expect(shouldRestoreComposer(arrivedFrom(state))).toBe(false);
  });
});

describe('13m — a failed turn does not lock the composer', () => {
  it('discards tool calls that completed before the error', () => {
    const state = runStream([
      toolStart('toolu_1', 'update_stage_plot'),
      toolJson('{"slots":[]}'),
      blockStop(),
      errorEvent('Internal server error', 'api_error'),
    ]);

    // The call really did complete — the reducer holds it...
    expect(state.toolCalls).toHaveLength(1);
    // ...and finalizing a FAILED turn throws it away, which is the whole rule.
    const turn = finalizeTurn(state);
    expect(turn.toolCalls).toBeUndefined();

    // The consequence that matters: no pending call, so canSend is not gated
    // behind approve/reject for a turn the model never finished proposing.
    expect(hasPendingTools([turn])).toBe(false);
  });

  it('keeps tool calls when the same stream SUCCEEDS', () => {
    // Separates the discard rule from "finalizeTurn drops tool calls".
    const state = runStream([toolStart('toolu_1', 'update_inputs'), toolJson('{"inputs":[]}'), blockStop()]);

    expect(finalizeTurn(state).toolCalls).toHaveLength(1);
    expect(hasPendingTools([finalizeTurn(state)])).toBe(true);
  });
});

describe('the reducer is pure', () => {
  it('does not mutate the state it was given', () => {
    const state = newStreamState();
    const next = reduceStreamEvent(state, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } });

    expect(state.text).toBe('');
    expect(next.text).toBe('hi');
    expect(next).not.toBe(state);
  });

  it('hands out a fresh state each time, so one stream cannot poison the next', () => {
    const a = newStreamState();
    a.text = 'leaked';
    expect(newStreamState().text).toBe('');
  });

  it('rejects payloads that parse to something other than an object', () => {
    expect(parseSseEvent('"a string"')).toBeNull();
    expect(parseSseEvent('[1,2]')).toBeNull();
    expect(parseSseEvent('{not json')).toBeNull();
  });
});

// Item 2, Codex R1 fold: `arrivedFrom` is the single definition of "what
// reached the transcript", shared by both failure paths so they cannot drift.
describe('arrivedFrom — the restore decision has one source of truth', () => {
  it('reports nothing arrived for a fresh state', () => {
    expect(arrivedFrom(newStreamState())).toEqual({ text: '', completedToolCalls: 0 });
    expect(shouldRestoreComposer(arrivedFrom(newStreamState()))).toBe(true);
  });

  it('counts completed tool calls, so a tool-only turn is delivered', () => {
    const state: StreamState = {
      ...newStreamState(),
      toolCalls: [{ id: 't1', name: 'set_bpm', input: {}, status: 'pending' }],
    };
    expect(arrivedFrom(state)).toEqual({ text: '', completedToolCalls: 1 });
    expect(shouldRestoreComposer(arrivedFrom(state))).toBe(false);
  });

  it('EXCLUDES an in-flight tool block — it never completed, so nothing survives', () => {
    const state: StreamState = {
      ...newStreamState(),
      currentTool: { id: 't1', name: 'set_bpm', json: '{"bpm":12' },
    };
    expect(arrivedFrom(state)).toEqual({ text: '', completedToolCalls: 0 });
    expect(shouldRestoreComposer(arrivedFrom(state))).toBe(true);
  });

  it('a failed turn that delivered text is NOT restored — the text is kept and marked', () => {
    const state: StreamState = { ...newStreamState(), text: 'half an ans', failed: true };
    expect(shouldRestoreComposer(arrivedFrom(state))).toBe(false);
    expect(finalizeTurn(state)).toEqual({ role: 'assistant', content: 'half an ans', failed: true });
  });
});
