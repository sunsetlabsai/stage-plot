import { describe, it, expect } from 'vitest';
import {
  resolveAvailability,
  canSendMessage,
  effectiveProbe,
  probeCapabilities,
  type Probe,
} from '../lib/agent-availability';
import { TRYIT_QUOTA, type Capabilities } from '../lib/agent-key';

// Design docs/design-ai-key-availability.md §5, chunk 3.
//
// §9's tests 10 and 11 are written against "the send control". The control itself is a
// `disabled={!canSend}` in page.tsx, which no harness can drive; the RULE is
// canSendMessage, and that is what these assert. The gap is declared in the PR rather
// than papered over — asserting the rule is not the same as asserting the button.

const caps = (over: Partial<Capabilities> = {}): Capabilities => ({
  tryit: 'available',
  tryitRemaining: TRYIT_QUOTA,
  quota: TRYIT_QUOTA,
  ...over,
});

const resolve = (over: {
  apiKey?: string;
  probe?: Probe;
  sendRemaining?: number | null;
  sendExhausted?: boolean;
} = {}) =>
  resolveAvailability({
    apiKey: '',
    probe: 'loading',
    sendRemaining: null,
    sendExhausted: false,
    ...over,
  });

describe('resolveAvailability — the six states (§5)', () => {
  it('state 1: a BYOA key wins outright, and says nothing about try-it', () => {
    // The send prefers Authorization unconditionally, so reporting try-it state here
    // would describe a path the request will not take.
    const a = resolve({ apiKey: 'sk-ant-mine', probe: caps({ tryit: 'unconfigured' }) });

    expect(a.state).toBe(1);
    expect(a.allowsSend).toBe(true);
    expect(a.lead).toBe('none');
    expect(a.remaining).toBe(null);
  });

  it('state 2: a probe in flight blocks sending and claims nothing', () => {
    const a = resolve({ probe: 'loading' });

    expect(a.state).toBe(2);
    expect(a.allowsSend).toBe(false);
    // The specific defect being prevented: no "try it free" before we know it is free.
    expect(a.lead).toBe('checking');
  });

  it('state 3: available reports the count and permits sending', () => {
    const a = resolve({ probe: caps({ tryitRemaining: 7 }) });

    expect(a.state).toBe(3);
    expect(a.allowsSend).toBe(true);
    expect(a.remaining).toBe(7);
    expect(a.lead).toBe('remaining');
  });

  it('state 4: exhausted blocks sending and expands the key field', () => {
    const a = resolve({ probe: caps({ tryit: 'exhausted', tryitRemaining: 0 }) });

    expect(a.state).toBe(4);
    expect(a.allowsSend).toBe(false);
    expect(a.showKeyField).toBe(true);
    expect(a.remaining).toBe(0);
  });

  it('state 5: unconfigured blocks sending — the state with no design before this', () => {
    const a = resolve({ probe: caps({ tryit: 'unconfigured', tryitRemaining: null }) });

    expect(a.state).toBe(5);
    expect(a.allowsSend).toBe(false);
    expect(a.showKeyField).toBe(true);
    expect(a.lead).toBe('unconfigured');
  });

  it('state 6: a FAILED probe reads as 5 for the user but stays a distinct state', () => {
    const a = resolve({ probe: 'error' });

    expect(a.state).toBe(6);
    expect(a.lead).toBe('checkFailed');
    // Same instruction, same blocked send — different diagnosis.
    expect(a.allowsSend).toBe(false);
    expect(a.showKeyField).toBe(true);
  });

  // "a probe REPORTING error is also 6" is DELETED with `tryit: 'error'`
  // (design-single-backend §3.2) — the probe has no store outage left to report.
  // State 6 itself is NOT gone: the test directly above still reaches it from a
  // probe that failed to answer, which is now its only producer.

  it('keeps 5 and 6 distinct in the DATA even though the user sees one thing', () => {
    const five = resolve({ probe: caps({ tryit: 'unconfigured', tryitRemaining: null }) });
    const six = resolve({ probe: 'error' });

    // Converging them in the UI is a copy decision; converging them in the data
    // throws away the only diagnostic that answers "is it off, or is it broken?".
    expect(five.state).not.toBe(six.state);
    expect(five.lead).not.toBe(six.lead);
    expect(five.showKeyField).toBe(six.showKeyField);
    expect(five.allowsSend).toBe(six.allowsSend);
  });

  it('treats a skipped probe as state 2, never as an answer', () => {
    // `skipped` means we never asked. Rendering it as unconfigured would invent a
    // measurement; rendering it as available would invite a failing send.
    const a = resolve({ probe: 'skipped' });

    expect(a.state).toBe(2);
    expect(a.allowsSend).toBe(false);
  });
});

describe('resolveAvailability — freshness precedence', () => {
  it('a 429 from a send outranks a probe that said available', () => {
    // Without this, spending the last message leaves the panel claiming messages
    // remain until the tab remounts.
    const a = resolve({ probe: caps({ tryitRemaining: 5 }), sendExhausted: true });

    expect(a.state).toBe(4);
    expect(a.remaining).toBe(0);
  });

  it("a send's remaining count outranks the probe's older snapshot", () => {
    const a = resolve({ probe: caps({ tryitRemaining: 50 }), sendRemaining: 3 });

    expect(a.remaining).toBe(3);
    expect(a.state).toBe(3);
  });

  it('falls back to the probe count when no send has reported yet', () => {
    const a = resolve({ probe: caps({ tryitRemaining: 11 }), sendRemaining: null });

    expect(a.remaining).toBe(11);
  });

  it('a BYOA key outranks even an exhausted send', () => {
    const a = resolve({ apiKey: 'sk-ant-mine', sendExhausted: true });

    expect(a.state).toBe(1);
    expect(a.allowsSend).toBe(true);
  });

  it('treats available-with-zero-left as exhausted, trusting the number over the label', () => {
    // The sender can produce this between mount and send. Offering a send we know
    // will 429 is the same false promise as advertising an unconfigured free trial.
    const a = resolve({ probe: caps({ tryit: 'available', tryitRemaining: 0 }) });

    expect(a.state).toBe(4);
    expect(a.allowsSend).toBe(false);
  });

  it('treats a send-reported zero as exhausted too', () => {
    const a = resolve({ probe: caps({ tryitRemaining: 50 }), sendRemaining: 0 });

    expect(a.state).toBe(4);
    expect(a.allowsSend).toBe(false);
  });
});

describe('canSendMessage — replaces page.tsx:5357 (§9 tests 10, 11 at rule level)', () => {
  const availability = (probe: Probe, apiKey = '') =>
    resolve({ probe, apiKey });

  it('is FALSE with no key and try-it unconfigured — the defect being fixed', () => {
    // The old predicate was `!!apiKey || !tryitExhausted`. tryitExhausted only flips
    // on a 429, and unconfigured 401s, so the old rule returned TRUE here forever and
    // the composer invited sends the app knew would fail.
    expect(
      canSendMessage({
        availability: availability(caps({ tryit: 'unconfigured', tryitRemaining: null })),
        streaming: false,
        hasPendingTools: false,
      }),
    ).toBe(false);
  });

  it('is FALSE while the probe is still in flight', () => {
    expect(
      canSendMessage({ availability: availability('loading'), streaming: false, hasPendingTools: false }),
    ).toBe(false);
  });

  it('is FALSE when the probe failed', () => {
    expect(
      canSendMessage({ availability: availability('error'), streaming: false, hasPendingTools: false }),
    ).toBe(false);
  });

  it('becomes TRUE once a key is entered, from the same unconfigured probe (test 11)', () => {
    const probe = caps({ tryit: 'unconfigured', tryitRemaining: null });

    expect(
      canSendMessage({ availability: availability(probe), streaming: false, hasPendingTools: false }),
    ).toBe(false);
    expect(
      canSendMessage({
        availability: availability(probe, 'sk-ant-mine'),
        streaming: false,
        hasPendingTools: false,
      }),
    ).toBe(true);
  });

  it('is TRUE when try-it is available', () => {
    expect(
      canSendMessage({ availability: availability(caps()), streaming: false, hasPendingTools: false }),
    ).toBe(true);
  });

  it('still blocks on streaming and on pending tools, as before', () => {
    const a = availability(caps());

    expect(canSendMessage({ availability: a, streaming: true, hasPendingTools: false })).toBe(false);
    expect(canSendMessage({ availability: a, streaming: false, hasPendingTools: true })).toBe(false);
  });

  it('does not consult the composer text, so typing cannot enable it (test 10)', () => {
    // canSendMessage takes no input string at all — the send BUTTON separately
    // requires non-empty text, but no amount of typing can unblock availability.
    const blocked = availability(caps({ tryit: 'unconfigured', tryitRemaining: null }));

    expect(Object.keys({ availability: blocked, streaming: false, hasPendingTools: false })).toEqual([
      'availability',
      'streaming',
      'hasPendingTools',
    ]);
    expect(canSendMessage({ availability: blocked, streaming: false, hasPendingTools: false })).toBe(false);
  });
});

describe('effectiveProbe — `skipped` is derived, never stored', () => {
  it('reports `skipped` while a key is held and nothing has been fetched', () => {
    expect(effectiveProbe('sk-ant-x', 'loading')).toBe('skipped');
  });

  it('RETURNS TO `loading` when the key is cleared, so the probe can finally run', () => {
    // Regression. Storing `skipped` in state stranded this user: the mount effect
    // wrote it, then refused to fetch because the value was no longer `loading`.
    // The composer sat disabled on "Checking AI availability…" permanently.
    expect(effectiveProbe('', 'loading')).toBe('loading');
    expect(resolveAvailability({
      apiKey: '',
      probe: effectiveProbe('', 'loading'),
      sendRemaining: null,
      sendExhausted: false,
    }).state).toBe(2);
  });

  it('never masks a result that WAS fetched, whether or not a key is held', () => {
    const measured = caps({ tryit: 'unconfigured', tryitRemaining: null });

    expect(effectiveProbe('sk-ant-x', 'error')).toBe('error');
    expect(effectiveProbe('sk-ant-x', measured)).toBe(measured);
    expect(effectiveProbe('', measured)).toBe(measured);
  });
});

describe('probe 429 — Codex R1 medium: state 2 was a dead end', () => {
  it('is state 6 and OFFERS THE KEY FIELD, never state 2', () => {
    // The defect: a 429 recorded nothing, the probe stayed 'loading', and state 2
    // hides the key field. A venue that tripped the shared-IP probe limit was left
    // on "Checking AI availability…" with no way to paste its own key.
    const a = resolve({ probe: 'rateLimited' });

    expect(a.state).toBe(6);
    expect(a.state).not.toBe(2);
    expect(a.showKeyField).toBe(true);
    expect(a.allowsSend).toBe(false);
  });

  it('says "not yet" rather than reusing the failed-probe lead', () => {
    // The route sends `rateLimited` specifically so this chunk can tell "ask again
    // shortly" apart from "the key store is unreachable". Collapsing them would
    // throw away a distinction chunk 2 built on purpose.
    const limited = resolve({ probe: 'rateLimited' });
    const failed = resolve({ probe: 'error' });

    expect(limited.lead).toBe('rateLimited');
    expect(failed.lead).toBe('checkFailed');
    expect(limited.lead).not.toBe(failed.lead);

    // Same affordances though — the user's way forward is identical.
    expect(limited.showKeyField).toBe(failed.showKeyField);
    expect(limited.allowsSend).toBe(failed.allowsSend);
    expect(limited.state).toBe(failed.state);
  });

  it('never claims a remaining count it did not measure', () => {
    expect(resolve({ probe: 'rateLimited' }).remaining).toBe(null);
  });

  it('blocks the composer, and a BYOA key still unblocks it', () => {
    expect(
      canSendMessage({
        availability: resolve({ probe: 'rateLimited' }),
        streaming: false,
        hasPendingTools: false,
      }),
    ).toBe(false);

    // The escape hatch actually works: paste a key and state 1 takes over.
    const withKey = resolve({ probe: 'rateLimited', apiKey: 'sk-ant-mine' });
    expect(withKey.state).toBe(1);
    expect(canSendMessage({ availability: withKey, streaming: false, hasPendingTools: false })).toBe(true);
  });
});

// Design docs/design-ai-key-availability.md §4 + issue #136, chunk 4.
//
// Codex R2 on chunk 3 logged the gap these close: `resolveAvailability` and the
// panel were well covered, but the three lines that PRODUCE a `FetchedProbe`
// lived in a page effect no harness can drive. A wrong branch there passes the
// whole suite while reintroducing the dead end chunk 3 exists to fix — probe
// stuck non-resolving ⇒ state 2 ⇒ composer disabled AND key field hidden.
describe('probeCapabilities — status → FetchedProbe (#136)', () => {
  const res = (status: number, body: unknown = {}): Response =>
    ({
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    }) as Response;

  it('returns the measured capabilities on 200', async () => {
    const body = caps();
    expect(await probeCapabilities(async () => res(200, body))).toEqual(body);
  });

  it('asks the capabilities route', async () => {
    const calls: string[] = [];
    await probeCapabilities(async (url) => {
      calls.push(String(url));
      return res(200, caps());
    });
    expect(calls).toEqual(['/api/agent/capabilities']);
  });

  it('maps 429 to rateLimited, NOT to error', async () => {
    // The distinction the route sends `rateLimited: true` for. Collapsing it
    // into `error` renders "the key store is unreachable" at a venue whose
    // shared IP merely tripped the 60/min probe limit.
    expect(await probeCapabilities(async () => res(429, { rateLimited: true }))).toBe('rateLimited');
  });

  it('maps a non-ok status to error', async () => {
    expect(await probeCapabilities(async () => res(500))).toBe('error');
  });

  it('resolves to error rather than rejecting when the fetch throws', async () => {
    // Offline. A rejection here would leave the caller's probe at 'loading'
    // forever — the exact strand this function's 429 branch exists to prevent —
    // because the page does `.then(setFetchedProbe)` with no catch of its own.
    await expect(
      probeCapabilities(async () => {
        throw new TypeError('Failed to fetch');
      }),
    ).resolves.toBe('error');
  });

  it('resolves to error when a 200 body is not JSON', async () => {
    const broken = {
      status: 200,
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    } as unknown as Response;
    expect(await probeCapabilities(async () => broken)).toBe('error');
  });
});

// Codex R1 medium on #140 — §5.1's clear-and-re-probe contract.
//
// The page's `handleClearKey` resets the probe to `loading`, but the probe is
// not the only input: send-derived quota state outranks it. These pin WHY the
// clear path must reset that state too. They assert the precedence rule, not the
// handler — the handler lives inside AgentChat and is unreachable from any
// harness here (the seam declared in the PR).
describe('clearing a rejected key — stale send state must not outrank a fresh probe', () => {
  const freshProbe = caps({ tryit: 'available', tryitRemaining: 7 });

  it('a stale exhausted flag overrides a probe that says try-it works', () => {
    // The hazard, stated as a fact about the rules: this is exactly what the
    // user would see after clearing a rejected key if the page kept the flag —
    // state 4, composer disabled, on a fresh measurement that said otherwise.
    const stale = resolve({ probe: freshProbe, sendExhausted: true });

    expect(stale.state).toBe(4);
    expect(stale.allowsSend).toBe(false);
  });

  it('a stale zero remaining does the same', () => {
    const stale = resolve({ probe: freshProbe, sendRemaining: 0 });

    expect(stale.state).toBe(4);
    expect(stale.allowsSend).toBe(false);
  });

  it('cleared to the reset values, the fresh probe is authoritative again', () => {
    // §5.1: "clearing re-runs the probe; if try-it is available the panel drops
    // straight into state 3 and the user continues with no key at all."
    const cleared = resolve({ probe: freshProbe, sendRemaining: null, sendExhausted: false });

    expect(cleared.state).toBe(3);
    expect(cleared.allowsSend).toBe(true);
    expect(cleared.remaining).toBe(7);
  });

  it('the precedence itself is correct and stays — it is not the bug', () => {
    // Spending the last free message must still update the panel without a
    // remount. The fix is to clear the stale value at the clear, NOT to demote
    // send state below the probe.
    const justSpent = resolve({ probe: caps({ tryitRemaining: 5 }), sendExhausted: true });

    expect(justSpent.state).toBe(4);
  });
});
