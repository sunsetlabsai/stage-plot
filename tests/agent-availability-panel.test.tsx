// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AgentAvailabilityPanel } from '../components/AgentAvailabilityPanel';
import { resolveAvailability, type Probe } from '../lib/agent-availability';
import { TRYIT_QUOTA, type Capabilities } from '../lib/agent-key';

// Design docs/design-ai-key-availability.md §9 tests 9 and 12, plus §7's shared-quota
// line. jsdom + RTL per the tests/setlist-bpm.test.tsx harness.
//
// Availability is resolved by the real function rather than hand-built, so a panel that
// renders correctly against an impossible Availability cannot pass.

afterEach(cleanup);

const caps = (over: Partial<Capabilities> = {}): Capabilities => ({
  tryit: 'available',
  tryitRemaining: TRYIT_QUOTA,
  quota: TRYIT_QUOTA,
  ...over,
});

function renderPanel(
  probe: Probe,
  over: { apiKey?: string; sendRemaining?: number | null; sendExhausted?: boolean } = {},
) {
  const handlers = {
    onApiKeyChange: vi.fn(),
    onRememberChange: vi.fn(),
    onRevealKey: vi.fn(),
    onClearKey: vi.fn(),
  };
  const availability = resolveAvailability({
    apiKey: over.apiKey ?? '',
    probe,
    sendRemaining: over.sendRemaining ?? null,
    sendExhausted: over.sendExhausted ?? false,
  });
  render(
    <AgentAvailabilityPanel
      availability={availability}
      apiKey={over.apiKey ?? ''}
      rememberKey={false}
      showKey={false}
      {...handlers}
    />,
  );
  return { availability, ...handlers };
}

const keyInput = () => screen.queryByLabelText('Claude API key') as HTMLInputElement | null;

describe('AgentAvailabilityPanel — state 5, unconfigured (§9 test 9)', () => {
  const probe = caps({ tryit: 'unconfigured', tryitRemaining: null });

  it('renders the instructional panel with an enabled, visible key input', () => {
    renderPanel(probe);

    expect(screen.getByText(/aren’t available on this deployment/i)).toBeTruthy();
    expect(screen.getByText(/Paste your own Claude API key/i)).toBeTruthy();
    const input = keyInput();
    expect(input).toBeTruthy();
    expect(input!.disabled).toBe(false);
  });

  it('never claims a free trial in the state where there is none', () => {
    renderPanel(probe);

    // The old copy said "Try it free" under exactly this condition. The invariant is
    // that nothing OFFERS free messages — state 5's own copy does mention them, to say
    // they are unavailable, so the assertion has to be about the offer, not the words.
    expect(screen.queryByText(/try it free/i)).toBeNull();
    expect(screen.queryByText(/free messages? remaining/i)).toBeNull();
    expect(screen.queryByText(/for unlimited use/i)).toBeNull();
  });

  it('offers a route to a key rather than a dead end', () => {
    renderPanel(probe);

    const link = screen.getByText(/Get a key/i) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toContain('console.anthropic.com');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('reports typing straight back to the owner of the key state', () => {
    const { onApiKeyChange } = renderPanel(probe);

    fireEvent.change(keyInput()!, { target: { value: 'sk-ant-typed' } });

    expect(onApiKeyChange).toHaveBeenCalledWith('sk-ant-typed');
  });
});

describe('AgentAvailabilityPanel — state 6, probe failed', () => {
  it('uses the softer lead but the same instruction as state 5', () => {
    renderPanel('error');

    expect(screen.getByText(/Couldn’t check AI availability/i)).toBeTruthy();
    expect(screen.getByText(/Paste your own Claude API key/i)).toBeTruthy();
    expect(keyInput()).toBeTruthy();
  });

  it('does not assert try-it is off, because we did not find that out', () => {
    renderPanel('error');

    expect(screen.queryByText(/aren’t available on this deployment/i)).toBeNull();
    expect(screen.queryByText(/try it free/i)).toBeNull();
  });
});

describe('AgentAvailabilityPanel — state 3, available (§9 test 12)', () => {
  it('renders the remaining count on FIRST PAINT, with no send having happened', () => {
    // The count previously appeared only after a send returned X-Tryit-Remaining, so
    // a fresh tab showed nothing and the user could not tell try-it was working.
    renderPanel(caps({ tryitRemaining: 7 }));

    expect(screen.getByText(/7 free messages remaining/i)).toBeTruthy();
    expect(keyInput()).toBeNull();
  });

  it('singularizes the last message', () => {
    renderPanel(caps({ tryitRemaining: 1 }));

    expect(screen.getByText(/1 free message remaining/i)).toBeTruthy();
    expect(screen.queryByText(/1 free messages/i)).toBeNull();
  });

  it('prefers the count a send just reported over the probe snapshot', () => {
    renderPanel(caps({ tryitRemaining: 50 }), { sendRemaining: 2 });

    expect(screen.getByText(/2 free messages remaining/i)).toBeTruthy();
    expect(screen.queryByText(/50 free/i)).toBeNull();
  });
});

describe('AgentAvailabilityPanel — state 2, probe in flight', () => {
  it('says it is checking, and neither claims nor denies a free trial', () => {
    renderPanel('loading');

    expect(screen.getByRole('status').textContent).toMatch(/Checking AI availability/i);
    expect(screen.queryByText(/try it free/i)).toBeNull();
    expect(screen.queryByText(/aren’t available/i)).toBeNull();
    // No key field: nothing has told the user they need one yet.
    expect(keyInput()).toBeNull();
  });
});

describe('AgentAvailabilityPanel — state 4, exhausted (§7)', () => {
  it('expands the key field and explains the quota is shared', () => {
    renderPanel(caps({ tryit: 'exhausted', tryitRemaining: 0 }));

    expect(screen.getByText(/Free messages used up/i)).toBeTruthy();
    // §7: without this line two testers in one room file two bug reports about a
    // quota neither of them individually spent.
    expect(screen.getByText(/shared across everyone on your network/i)).toBeTruthy();
    expect(keyInput()).toBeTruthy();
  });

  it('shows the same thing when a 429 arrives mid-session, without a re-probe', () => {
    renderPanel(caps({ tryitRemaining: 5 }), { sendExhausted: true });

    expect(screen.getByText(/Free messages used up/i)).toBeTruthy();
    expect(screen.queryByText(/5 free messages/i)).toBeNull();
  });
});

describe('AgentAvailabilityPanel — state 1, BYOA key present', () => {
  it('shows the key field with Clear, and no try-it copy at all', () => {
    renderPanel(caps({ tryit: 'unconfigured', tryitRemaining: null }), { apiKey: 'sk-ant-mine' });

    expect(keyInput()!.value).toBe('sk-ant-mine');
    expect(screen.getByText('Clear')).toBeTruthy();
    // Try-it state is irrelevant to what a send will do, so it is not reported.
    expect(screen.queryByText(/free message/i)).toBeNull();
    expect(screen.queryByText(/aren’t available/i)).toBeNull();
    expect(screen.queryByText(/Couldn’t check/i)).toBeNull();
  });

  it('hides Clear when there is no key to clear', () => {
    renderPanel(caps({ tryit: 'unconfigured', tryitRemaining: null }));

    expect(screen.queryByText('Clear')).toBeNull();
  });

  it('routes Clear to the handler rather than clearing storage itself', () => {
    const { onClearKey } = renderPanel(caps(), { apiKey: 'sk-ant-mine' });

    fireEvent.click(screen.getByText('Clear'));

    expect(onClearKey).toHaveBeenCalled();
  });
});

describe('AgentAvailabilityPanel — rate-limited probe (Codex R1 medium)', () => {
  it('renders the key field, so a rate-limited venue is not stranded', () => {
    renderPanel('rateLimited');

    // The regression this pins: state 2 rendered "Checking AI availability…" and
    // hid the input entirely, leaving no way out until the tab remounted.
    expect(screen.getByLabelText('Claude API key')).toBeInTheDocument();
    expect(screen.queryByText(/checking ai availability…/i)).toBeNull();
  });

  it('tells the user to try again rather than implying an outage', () => {
    renderPanel('rateLimited');

    expect(screen.getByText(/try again shortly/i)).toBeInTheDocument();
  });

  it('reads differently from a failed probe', () => {
    renderPanel('rateLimited');
    const limited = screen.getByText(/couldn’t check ai availability/i).textContent;
    cleanup();

    renderPanel('error');
    const failed = screen.getByText(/couldn’t check ai availability/i).textContent;

    expect(limited).not.toBe(failed);
  });

  it('never advertises free messages it could not measure', () => {
    renderPanel('rateLimited');

    expect(screen.queryByText(/try it free/i)).toBeNull();
    expect(screen.queryByText(/messages remaining/i)).toBeNull();
  });
});
