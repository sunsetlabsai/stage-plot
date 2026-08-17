import type { Capabilities } from './agent-key';

// Design docs/design-ai-key-availability.md §5, chunk 3.
//
// The AI tab's seven states resolved as ONE pure function, so the rules are testable
// without rendering a 6704-line page. §5's whole point is that today all four
// no-key conditions render identically; a predicate that cannot be exercised in
// isolation is how they got conflated in the first place.

/**
 * `'skipped'` is a chunk-3 addition to §5's `'loading' | Capabilities | 'error'`.
 *
 * §5 skips the probe entirely when a BYOA key is in localStorage, which left the
 * spec's type with no way to say so — the state would have sat at `'loading'`
 * forever, indistinguishable from a probe still in flight. In a design whose entire
 * subject is not conflating distinct conditions, that ambiguity is not one to
 * introduce. It also gives chunk 4 the signal it needs: clearing a stale key has to
 * start a probe that was never run, and `'skipped'` is what tells it so.
 */
/**
 * `'rateLimited'` is the probe's 429. The route sets `rateLimited: true` explicitly
 * "so chunk 3 can distinguish 'ask again shortly' from 'the key store is unreachable'"
 * — a contract chunk 2 built for this chunk to honour.
 *
 * Codex R1 medium: chunk 3 originally returned early on a 429 without recording
 * anything, which left the probe at `'loading'` forever. That renders state 2 — no
 * error, no key field, composer disabled — so a user behind a shared IP that trips the
 * 60/min probe limit could not even paste their own key until the tab remounted. An
 * error path that strands the caller is not a fix; that is the third instance of this
 * exact class in this project.
 */
export type Probe = 'skipped' | 'loading' | 'rateLimited' | 'error' | Capabilities;

/** What the probe fetch itself can return. `skipped` is not fetchable — see below. */
export type FetchedProbe = Exclude<Probe, 'skipped'>;

/**
 * `'skipped'` is DERIVED from "we hold a key and nothing has been fetched" — never
 * stored.
 *
 * Storing it stranded the user who cleared their key: the mount effect wrote
 * `'skipped'`, and its own "already resolved?" guard then refused to run the fetch,
 * leaving the composer disabled on `Checking AI availability…` permanently. Derived,
 * clearing the key returns the value to `'loading'` and the fetch runs. Chunk 4 reads
 * the same transition.
 */
export function effectiveProbe(apiKey: string, fetched: FetchedProbe): Probe {
  return apiKey && fetched === 'loading' ? 'skipped' : fetched;
}

/** Which lead copy the panel shows. Named, not booleans, so states cannot overlap. */
export type Lead =
  /** State 1 — a key is present; say nothing about try-it. */
  | 'none'
  /** State 2 — probe in flight. Deliberately silent: no error, and no free claim. */
  | 'checking'
  /** State 3 — try-it works. "N free messages remaining." */
  | 'remaining'
  /** State 4 — allowance spent. */
  | 'exhausted'
  /** State 5 — try-it is intentionally off. The state with no design before this. */
  | 'unconfigured'
  /** State 6 — we could not find out. Reads as 5 with a softer lead (§5). */
  | 'checkFailed'
  /**
   * State 6 via a 429 — we could not find out *yet*. Same affordances as
   * `checkFailed`, different copy: this one is worth asking about again, and saying
   * so is the whole reason the route bothers to send `rateLimited`.
   */
  | 'rateLimited';

export type Availability = {
  state: 1 | 2 | 3 | 4 | 5 | 6;
  /**
   * Whether availability permits sending. Does NOT include `streaming` or pending
   * tools — those are turn-level concerns, and folding them in here is what made the
   * old one-line `canSend` impossible to reason about. Compose with `canSendMessage`.
   */
  allowsSend: boolean;
  /** Key field visible and expanded, because entering a key is the way forward. */
  showKeyField: boolean;
  remaining: number | null;
  lead: Lead;
};

/**
 * Resolve the AI tab's state from the probe and what sends have since reported.
 *
 * Precedence, in order, each for a stated reason:
 *
 * 1. **A BYOA key wins outright.** `route.ts` prefers `Authorization`
 *    unconditionally, so try-it state is irrelevant to what will happen. Reporting
 *    on it would be describing a path the request will not take.
 * 2. **A 429 from a send beats the probe.** The probe is a snapshot from mount; a
 *    send that just exhausted the allowance is newer. Without this, spending the
 *    last message would leave the panel claiming messages remain until remount.
 * 3. **A send's remaining count beats the probe's**, same freshness argument. This
 *    is why the count is a parameter rather than read off the probe directly.
 */
export function resolveAvailability(args: {
  apiKey: string;
  probe: Probe;
  /** From `X-Tryit-Remaining` on a send, or null if no send has reported yet. */
  sendRemaining: number | null;
  /** Set by a 429 `tryitExhausted` response. */
  sendExhausted: boolean;
}): Availability {
  const { apiKey, probe, sendRemaining, sendExhausted } = args;

  // 1. BYOA.
  if (apiKey) {
    return { state: 1, allowsSend: true, showKeyField: false, remaining: null, lead: 'none' };
  }

  // 2. A send that hit the wall outranks a probe taken before it.
  if (sendExhausted) {
    return { state: 4, allowsSend: false, showKeyField: true, remaining: 0, lead: 'exhausted' };
  }

  if (probe === 'loading' || probe === 'skipped') {
    // State 2: disabled composer, no error, and crucially no "try it free" claim —
    // we do not yet know whether it is free, and guessing is the defect (§1).
    return { state: 2, allowsSend: false, showKeyField: false, remaining: null, lead: 'checking' };
  }

  if (probe === 'rateLimited') {
    // State 6, but never state 2: the key field MUST be offered. Rate limiting is
    // keyed on the forwarded IP, so a whole venue trips it together — exactly the
    // population that needs to fall back to its own key.
    return { state: 6, allowsSend: false, showKeyField: true, remaining: null, lead: 'rateLimited' };
  }

  if (probe === 'error') {
    // State 6 renders AS state 5 for the user, with a softer lead. The values stay
    // distinct in the data (§5, Codex R1 medium) — converging them in the UI is a
    // copy decision, converging them in the data throws away the diagnostic.
    return { state: 6, allowsSend: false, showKeyField: true, remaining: null, lead: 'checkFailed' };
  }

  switch (probe.tryit) {
    case 'unconfigured':
      return { state: 5, allowsSend: false, showKeyField: true, remaining: null, lead: 'unconfigured' };
    case 'error':
      // The probe answered, and its answer was "I could not tell." Same user-facing
      // treatment as a failed probe; still not the same value.
      return { state: 6, allowsSend: false, showKeyField: true, remaining: null, lead: 'checkFailed' };
    case 'exhausted':
      return { state: 4, allowsSend: false, showKeyField: true, remaining: 0, lead: 'exhausted' };
    case 'available': {
      // 3. Freshest count wins.
      const remaining = sendRemaining ?? probe.tryitRemaining;
      // An `available` probe with a zero count is a contradiction the sender can
      // produce between mount and send. Trust the number, not the label: offering a
      // send we know will 429 is the same false promise as state 5's "try it free".
      if (remaining !== null && remaining <= 0) {
        return { state: 4, allowsSend: false, showKeyField: true, remaining: 0, lead: 'exhausted' };
      }
      return { state: 3, allowsSend: true, showKeyField: false, remaining, lead: 'remaining' };
    }
  }
}

/**
 * The composer's enablement, replacing `canSend` at page.tsx:5357.
 *
 * The line it replaces was `!!apiKey || !tryitExhausted`, which is true whenever no
 * key is set and no 429 has arrived — and `tryitExhausted` only flips on a 429. With
 * try-it UNCONFIGURED the send 401s, so the flag never set and the composer stayed
 * enabled permanently, inviting sends the app already knew would fail. That is §1's
 * defect expressed as a predicate.
 */
export function canSendMessage(args: {
  availability: Availability;
  streaming: boolean;
  hasPendingTools: boolean;
}): boolean {
  return args.availability.allowsSend && !args.streaming && !args.hasPendingTools;
}

/**
 * Run the capability probe and map the response to a `FetchedProbe`.
 *
 * Extracted from the page effect in chunk 4 to close issue #136. Codex R2 on
 * chunk 3 logged the gap: `resolveAvailability` and the panel were well covered,
 * but the three lines that PRODUCE `'rateLimited'` were not, and a wrong branch
 * there would pass the whole suite while reintroducing the dead end chunk 3
 * exists to fix (probe stuck at `'loading'` ⇒ state 2 ⇒ composer disabled and
 * the key field hidden).
 *
 * `fetchFn` is injected for the same reason the storage modules inject their
 * store: `AgentChat` needs `useParams` + Supabase + a real page to render, so
 * the mapping could not otherwise be driven at all. With this it is exercised in
 * the node environment against a stub, leaving only `setFetchedProbe` wiring
 * uncovered.
 *
 * Never throws — every failure resolves to `'error'`, because a probe that
 * rejects would leave the caller's state at `'loading'` forever, which is the
 * precise defect this function's own 429 branch exists to prevent.
 */
export async function probeCapabilities(
  fetchFn: typeof fetch = fetch,
): Promise<FetchedProbe> {
  try {
    const res = await fetchFn('/api/agent/capabilities');
    // A 429 is NOT one of the four measured states. The route sends
    // `rateLimited: true` for exactly this, so it gets its own probe value
    // rather than being collapsed into one it did not measure.
    if (res.status === 429) return 'rateLimited';
    if (!res.ok) return 'error';
    return (await res.json()) as Capabilities;
  } catch {
    return 'error';
  }
}
