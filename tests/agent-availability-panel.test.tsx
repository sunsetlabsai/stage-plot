// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AgentAvailabilityPanel } from '../components/AgentAvailabilityPanel';
import { resolveAvailability, type Probe } from '../lib/agent-availability';
import { TRYIT_QUOTA, type Capabilities } from '../lib/agent-key';

// Design docs/design-ai-key-availability.md §9 tests 9 and 12, plus §7's shared-quota
// line — and design-single-backend §9 T23 (the settings affordance replaces the inline
// key input). jsdom + RTL per the tests/setlist-bpm.test.tsx harness.
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
  const onOpenSettings = vi.fn();
  const availability = resolveAvailability({
    apiKey: over.apiKey ?? '',
    probe,
    sendRemaining: over.sendRemaining ?? null,
    sendExhausted: over.sendExhausted ?? false,
  });
  render(<AgentAvailabilityPanel availability={availability} onOpenSettings={onOpenSettings} />);
  return { availability, onOpenSettings };
}

/**
 * The load-bearing assertion of T23: there is no inline key input ANYWHERE in the
 * panel, in any state. A password input has no implicit textbox role, so this checks
 * both the old aria-label and every input element outright.
 */
const noInlineInput = () => {
  expect(screen.queryByLabelText('Claude API key')).toBeNull();
  expect(document.querySelector('input')).toBeNull();
};

describe('AgentAvailabilityPanel — state 5, unconfigured (§9 test 9, T23)', () => {
  const probe = caps({ tryit: 'unconfigured', tryitRemaining: null });

  it('renders the instructional panel with a Settings affordance and NO inline input', () => {
    const { onOpenSettings } = renderPanel(probe);

    expect(screen.getByText(/aren’t available on this deployment/i)).toBeTruthy();
    expect(screen.getByText(/Add your own Claude API key/i)).toBeTruthy();

    // T23: the affordance opens settings; it is NOT an inline input, and NOT a link
    // that would navigate away and destroy composer text.
    const affordance = screen.getByRole('button', { name: /api key in settings/i });
    fireEvent.click(affordance);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    noInlineInput();
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

  it('reaches settings WITHOUT navigating — the T21 data-loss guard', () => {
    // T21's failure mode is a navigation-based settings link: it would unmount the
    // show host and destroy the restored composer text. The affordance is a <button>
    // firing a callback, not an <a> to /dashboard/settings, so opening settings never
    // leaves the page. (The other half — the host renders the overlay as a sibling and
    // does not remount — is structural in page.tsx, unreachable from this harness.)
    renderPanel(probe);

    const affordance = screen.getByRole('button', { name: /api key in settings/i });
    expect(affordance.tagName).toBe('BUTTON');
    expect(affordance.getAttribute('href')).toBeNull();
    expect(screen.queryByRole('link', { name: /settings/i })).toBeNull();
  });
});

describe('AgentAvailabilityPanel — state 6, probe failed (T23)', () => {
  it('uses the softer lead but the same instruction as state 5, still no input', () => {
    renderPanel('error');

    expect(screen.getByText(/Couldn’t check AI availability/i)).toBeTruthy();
    expect(screen.getByText(/Add your own Claude API key/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /api key in settings/i })).toBeTruthy();
    noInlineInput();
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
    noInlineInput();
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

  it('routes "Add your own key" to the settings overlay, not an inline reveal', () => {
    const { onOpenSettings } = renderPanel(caps({ tryitRemaining: 7 }));

    fireEvent.click(screen.getByRole('button', { name: /add your own key/i }));

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});

describe('AgentAvailabilityPanel — state 2, probe in flight', () => {
  it('says it is checking, and neither claims nor denies a free trial', () => {
    renderPanel('loading');

    expect(screen.getByRole('status').textContent).toMatch(/Checking AI availability/i);
    expect(screen.queryByText(/try it free/i)).toBeNull();
    expect(screen.queryByText(/aren’t available/i)).toBeNull();
    // No affordance and no input: nothing has told the user they need a key yet.
    noInlineInput();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('AgentAvailabilityPanel — state 4, exhausted (§7, T23)', () => {
  it('offers the settings affordance and explains the quota is shared', () => {
    renderPanel(caps({ tryit: 'exhausted', tryitRemaining: 0 }));

    expect(screen.getByText(/Free messages used up/i)).toBeTruthy();
    // §7: without this line two testers in one room file two bug reports about a
    // quota neither of them individually spent.
    expect(screen.getByText(/shared across everyone on your network/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /api key in settings/i })).toBeTruthy();
    noInlineInput();
  });

  it('shows the same thing when a 429 arrives mid-session, without a re-probe', () => {
    renderPanel(caps({ tryitRemaining: 5 }), { sendExhausted: true });

    expect(screen.getByText(/Free messages used up/i)).toBeTruthy();
    expect(screen.queryByText(/5 free messages/i)).toBeNull();
  });
});

describe('AgentAvailabilityPanel — state 1, a key is in use', () => {
  it('keeps the overlay reachable to manage the key, and shows no try-it copy', () => {
    const { onOpenSettings } = renderPanel(caps({ tryit: 'unconfigured', tryitRemaining: null }), {
      apiKey: 'sk-ant-mine',
    });

    // No inline input, no key material rendered — management lives in the overlay now.
    noInlineInput();
    expect(screen.queryByText(/sk-ant-mine/)).toBeNull();
    // Try-it state is irrelevant to what a send will do, so it is not reported.
    expect(screen.queryByText(/free message/i)).toBeNull();
    expect(screen.queryByText(/aren’t available/i)).toBeNull();

    // But there IS a way to reach settings — a working key must still be removable
    // without leaving the show.
    fireEvent.click(screen.getByRole('button', { name: /manage key/i }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('treats an account key the probe found the same as a device key', () => {
    // §3.2: the account-aware probe reports `{ accountKey: true }`; the panel must read
    // that as state 1 — key in use, no affordance to ADD one — exactly like a device key.
    const { onOpenSettings } = renderPanel({ accountKey: true });

    expect(screen.getByText(/Using your Claude API key/i)).toBeTruthy();
    noInlineInput();
    expect(screen.queryByRole('button', { name: /add your/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /manage key/i }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});

describe('AgentAvailabilityPanel — rate-limited probe (Codex R1 medium, T23)', () => {
  it('renders the settings affordance, so a rate-limited venue is not stranded', () => {
    renderPanel('rateLimited');

    // The regression this pins: state 2 rendered "Checking AI availability…" and
    // offered no way out until the tab remounted.
    expect(screen.getByRole('button', { name: /api key in settings/i })).toBeInTheDocument();
    expect(screen.queryByText(/checking ai availability…/i)).toBeNull();
    noInlineInput();
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
