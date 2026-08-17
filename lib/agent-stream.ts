// What the assistant's SSE stream means, as a pure reduction.
//
// Design docs/design-ai-key-availability.md §5.2a.2 + §5.2a.2b, work item 2.
//
// The parse loop lived inside `AgentChat`, which is declared in a 6700-line
// client component that no harness in this repo can render. §9's tests 13i, 13j,
// 13l and 13m are all written against that loop's behaviour, so none of them
// could have been written at all. Lifting the event→state rules out is what
// makes them assertable — the same move chunk 4 made for the restore predicate
// and #136 made for the probe.
//
// The page keeps the read loop, the decoder and the setState calls. Only the
// rules live here.

/** A tool call as the transcript holds it. */
export interface StreamToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: 'pending' | 'applied' | 'rejected';
}

export interface StreamState {
  /** Assistant text accumulated so far. Kept on failure — it was delivered. */
  text: string;
  /** Completed tool calls. Discarded on failure, per §5.2a.2b. */
  toolCalls: StreamToolCall[];
  /** The tool block currently being streamed, if any. */
  currentTool: { id: string; name: string; json: string } | null;
  /** An `error` event arrived, or the connection died mid-flight. */
  failed: boolean;
  /** What to show the user. Null until something fails. */
  errorMessage: string | null;
}

/**
 * A factory, not a frozen constant: `StreamState` is replaced wholesale by the
 * reducer, but returning one shared object would still let a caller that mutates
 * it in place poison the next stream.
 */
export function newStreamState(): StreamState {
  return { text: '', toolCalls: [], currentTool: null, failed: false, errorMessage: null };
}

/**
 * Split a decoded buffer into complete SSE `data:` payloads.
 *
 * Returns the trailing partial line as `rest` so the caller can prepend it to
 * the next chunk — a JSON object split across two reads is the normal case, not
 * an edge case.
 *
 * `[DONE]` and any non-`data:` line (SSE comments, `event:` lines, keep-alive
 * blanks) are dropped here rather than in the reducer, so the reducer only ever
 * sees things that claim to be events.
 */
export function splitSseData(buffer: string): { payloads: string[]; rest: string } {
  const lines = buffer.split('\n');
  const rest = lines.pop() ?? '';
  const payloads: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6);
    if (data === '[DONE]') continue;
    payloads.push(data);
  }
  return { payloads, rest };
}

/**
 * Parse one payload. Unparseable lines yield `null` and are skipped by the
 * caller — a malformed frame must not abort a stream that is otherwise fine.
 */
export function parseSseEvent(payload: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Apply one event. Pure: returns a new state, never mutates the one given.
 *
 * ## The error event
 *
 * **Verified against Anthropic's streaming docs, not assumed** (the rule this
 * project earned the hard way after inventing a vendor API):
 *
 * ```
 * event: error
 * data: {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}
 * ```
 *
 * The old loop handled `content_block_start` / `_delta` / `_stop` and nothing
 * else, so this parsed as JSON, matched no branch, and fell through. The loop
 * then ended normally and committed the partial text **with no error surfaced** —
 * a stream that died mid-flight was indistinguishable from Claude choosing to
 * stop. Fourth instance in this project of an error path silent about the state
 * it strands the caller in. The signal was already in the stream; we were
 * throwing it away.
 */
export function reduceStreamEvent(state: StreamState, event: Record<string, unknown>): StreamState {
  const type = event.type;

  if (type === 'error') {
    const err = event.error as { message?: unknown } | undefined;
    const message = typeof err?.message === 'string' && err.message ? err.message : 'The response stopped unexpectedly.';
    // Marked, not thrown. The partial content was delivered and billed; §5.2a.4
    // row 2 keeps it in the transcript and does NOT restore the composer.
    return { ...state, failed: true, errorMessage: message };
  }

  if (type === 'content_block_start') {
    const block = event.content_block as { type?: unknown; id?: unknown; name?: unknown } | undefined;
    if (block?.type !== 'tool_use') return state;
    return {
      ...state,
      currentTool: { id: String(block.id ?? ''), name: String(block.name ?? ''), json: '' },
    };
  }

  if (type === 'content_block_delta') {
    const delta = event.delta as { type?: unknown; text?: unknown; partial_json?: unknown } | undefined;
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      return { ...state, text: state.text + delta.text };
    }
    if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string' && state.currentTool) {
      return { ...state, currentTool: { ...state.currentTool, json: state.currentTool.json + delta.partial_json } };
    }
    return state;
  }

  if (type === 'content_block_stop') {
    if (!state.currentTool) return state;
    let input: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(state.currentTool.json);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        input = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed tool JSON — drop the call, keep the stream. Matches the
      // behaviour the loop already had.
    }
    if (input === null) return { ...state, currentTool: null };
    return {
      ...state,
      toolCalls: [...state.toolCalls, { id: state.currentTool.id, name: state.currentTool.name, input, status: 'pending' }],
      currentTool: null,
    };
  }

  return state;
}

/** The assistant turn as it goes into the transcript. */
export interface FinalizedTurn {
  role: 'assistant';
  content: string;
  toolCalls?: StreamToolCall[];
  failed?: true;
}

/**
 * Commit the turn.
 *
 * **§5.2a.2b: a failed turn's tool calls are DISCARDED, not left pending.**
 * Tool calls are pushed at `content_block_stop`, so a stream that finishes a
 * tool block and *then* errors leaves a pending call behind — and `hasPendingTools`
 * feeds `canSend`, so the composer would lock behind "Apply or reject pending
 * changes first" for a turn the model never finished proposing. That is this
 * document's own defect class, and keeping a failed turn is what creates it.
 *
 * The accepted trade, stated: a tool call that DID complete before the error is
 * thrown away rather than offered. Applying half a plan is worse than re-asking.
 */
export function finalizeTurn(state: StreamState): FinalizedTurn {
  if (state.failed) {
    return { role: 'assistant', content: state.text, failed: true };
  }
  return {
    role: 'assistant',
    content: state.text,
    toolCalls: state.toolCalls.length > 0 ? state.toolCalls : undefined,
  };
}
