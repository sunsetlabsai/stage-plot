// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import ConductorCluster, { type ConductorClusterProps } from '../components/ConductorCluster';
import type { JumpTarget, RedirectOption } from '../lib/conductor-targets';

// ── Conductor authority, chunk 4: the MD control cluster (jsdom) ──────────────
// The FIRST jsdom test in the repo — the pure-lib suite stays node (vitest.config
// default); this file opts into a DOM via the docblock above. ConductorCluster is
// PURE presentational (no session/PDF/validity), so every assertion is render +
// callback — exactly the surface §3 specifies.

afterEach(cleanup);

const target = (barId: string, label: string, exitOptions: JumpTarget['exitOptions'] = []): JumpTarget => ({
  barId,
  label,
  kind: 'bar',
  exitOptions,
});

// A complete prop set with no-op handlers; each test overrides what it asserts on.
function props(over: Partial<ConductorClusterProps> = {}): ConductorClusterProps {
  return {
    active: true,
    readout: null,
    armedSummary: null,
    targets: [],
    redirects: [],
    canAdvance: true,
    canArm: true,
    ignored: false,
    autoFire: false,
    clockOn: false,
    rung: 'manual',
    stalled: false,
    holding: false,
    canArmNextSection: false,
    onAdvance: vi.fn(),
    onAlign: vi.fn(),
    onArm: vi.fn(),
    onCommit: vi.fn(),
    onDisarm: vi.fn(),
    onRedirect: vi.fn(),
    onToggleAutoFire: vi.fn(),
    onToggleClock: vi.fn(),
    onStop: vi.fn(),
    ...over,
  };
}

describe('ConductorCluster', () => {
  it('renders the "Local MD mode" header and fires onStop from Exit', () => {
    const onStop = vi.fn();
    render(<ConductorCluster {...props({ onStop })} />);
    expect(screen.getByText('Local MD mode')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Exit' }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it('shows the Starting… placeholder while inactive (no transport rendered)', () => {
    render(<ConductorCluster {...props({ active: false })} />);
    expect(screen.getByText(/Starting/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Advance/ })).toBeNull();
  });

  it('prompts "Tap Advance to begin" before the first emitted bar', () => {
    render(<ConductorCluster {...props({ readout: null })} />);
    expect(screen.getByText('Tap Advance to begin')).toBeInTheDocument();
  });

  it('renders the bar readout (absNumber + passLabel) when one is supplied', () => {
    render(<ConductorCluster {...props({ readout: { absNumber: 12, passLabel: 'Pass 2' } })} />);
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText(/Pass 2/)).toBeInTheDocument();
  });

  it('fires onAdvance, and disables Advance at song end (canAdvance=false)', () => {
    const onAdvance = vi.fn();
    const { rerender } = render(<ConductorCluster {...props({ onAdvance })} />);
    const btn = screen.getByRole('button', { name: /Advance/ });
    fireEvent.click(btn);
    expect(onAdvance).toHaveBeenCalledOnce();
    rerender(<ConductorCluster {...props({ onAdvance, canAdvance: false })} />);
    expect(screen.getByRole('button', { name: /Advance/ })).toBeDisabled();
  });

  it('fires onAlign for "On the 1", and disables it at song end (canAdvance=false)', () => {
    const onAlign = vi.fn();
    const { rerender } = render(<ConductorCluster {...props({ onAlign })} />);
    fireEvent.click(screen.getByRole('button', { name: /On the 1/ }));
    expect(onAlign).toHaveBeenCalledOnce();
    rerender(<ConductorCluster {...props({ onAlign, canAdvance: false })} />);
    expect(screen.getByRole('button', { name: /On the 1/ })).toBeDisabled();
  });

  it('disables "Arm change…" at song end (canArm=false)', () => {
    render(<ConductorCluster {...props({ canArm: false })} />);
    expect(screen.getByRole('button', { name: /Arm change/ })).toBeDisabled();
  });

  it('opens the target picker and fires onArm with the chosen target (no exit)', () => {
    const onArm = vi.fn();
    render(<ConductorCluster {...props({ onArm, targets: [target('b3', 'Coda')] })} />);
    fireEvent.click(screen.getByRole('button', { name: /Arm change/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Coda' }));
    expect(onArm).toHaveBeenCalledTimes(1);
    // chunk 5: arm now carries a structural fireAt (default 'next-bar'); no exit chosen.
    expect(onArm).toHaveBeenCalledWith(expect.objectContaining({ barId: 'b3' }), undefined, 'next-bar');
    expect(onArm.mock.calls[0][1]).toBeUndefined();
  });

  it('renders a per-exit button and fires onArm with the exit kind', () => {
    const onArm = vi.fn();
    render(<ConductorCluster {...props({ onArm, targets: [target('b3', 'Coda', ['alCoda'])] })} />);
    fireEvent.click(screen.getByRole('button', { name: /Arm change/ }));
    fireEvent.click(screen.getByRole('button', { name: 'al Coda' }));
    expect(onArm).toHaveBeenCalledWith(expect.objectContaining({ barId: 'b3' }), 'alCoda', 'next-bar');
  });

  it('renders the armed badge and fires onCommit / onDisarm from Go / Cancel', () => {
    const onCommit = vi.fn();
    const onDisarm = vi.fn();
    render(
      <ConductorCluster
        {...props({ onCommit, onDisarm, armedSummary: { targetLabel: 'Coda', fireAtLabel: '17' } })}
      />,
    );
    expect(screen.getByText('Coda')).toBeInTheDocument();
    expect(screen.getByText(/17/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onCommit).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onDisarm).toHaveBeenCalledOnce();
  });

  it('renders exactly the supplied redirects and fires onRedirect with the option', () => {
    const onRedirect = vi.fn();
    const redirects: RedirectOption[] = [
      { label: 'Another round', directive: { kind: 'anotherRound', repeatStartId: 'R' } },
      { label: 'Vamp (hold)', directive: { kind: 'hold', repeatStartId: 'R' } },
    ];
    render(<ConductorCluster {...props({ onRedirect, redirects })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Another round' }));
    expect(onRedirect).toHaveBeenCalledWith(redirects[0]);
    expect(screen.getByRole('button', { name: 'Vamp (hold)' })).toBeInTheDocument();
  });

  it('surfaces a dead tap honestly via the ignored affordance', () => {
    const { rerender } = render(<ConductorCluster {...props({ ignored: false })} />);
    expect(screen.queryByText(/Not available right now/)).toBeNull();
    rerender(<ConductorCluster {...props({ ignored: true })} />);
    expect(screen.getByText(/Not available right now/)).toBeInTheDocument();
  });

  // ── chunk 5: auto-fire toggle + hold-aware copy + fire-at selector (§4) ──────
  it('renders the auto-fire toggle reflecting state and flips onToggleAutoFire', () => {
    const onToggleAutoFire = vi.fn();
    const { rerender } = render(<ConductorCluster {...props({ autoFire: false, onToggleAutoFire })} />);
    const off = screen.getByRole('button', { name: /Auto-fire off/ });
    expect(off).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(off);
    expect(onToggleAutoFire).toHaveBeenCalledOnce();
    rerender(<ConductorCluster {...props({ autoFire: true, onToggleAutoFire })} />);
    expect(screen.getByRole('button', { name: /Auto-fire on/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('armed-summary copy: auto-fire OFF shows "@ bar N · tap Go"', () => {
    render(
      <ConductorCluster
        {...props({ autoFire: false, armedSummary: { targetLabel: 'Chorus', fireAtLabel: '24' } })}
      />,
    );
    expect(screen.getByText(/@ bar 24 · tap Go/)).toBeInTheDocument();
  });

  it('armed-summary copy: auto-fire ON, not holding shows "fires at bar N"', () => {
    render(
      <ConductorCluster
        {...props({
          autoFire: true,
          holding: false,
          armedSummary: { targetLabel: 'Chorus', fireAtLabel: '24' },
        })}
      />,
    );
    expect(screen.getByText(/fires at bar 24/)).toBeInTheDocument();
  });

  it('armed-summary copy: auto-fire ON, holding shows "release to fire"', () => {
    render(
      <ConductorCluster
        {...props({
          autoFire: true,
          holding: true,
          armedSummary: { targetLabel: 'Chorus', fireAtLabel: '24' },
        })}
      />,
    );
    expect(screen.getByText(/release to fire/)).toBeInTheDocument();
  });

  it('Go and Disarm are always present regardless of the auto-fire toggle', () => {
    render(
      <ConductorCluster
        {...props({ autoFire: true, armedSummary: { targetLabel: 'Chorus', fireAtLabel: '24' } })}
      />,
    );
    expect(screen.getByRole('button', { name: 'Go' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('disables the "Next section" fire-at option when no boundary is ahead', () => {
    render(<ConductorCluster {...props({ canArmNextSection: false, targets: [target('b3', 'Coda')] })} />);
    fireEvent.click(screen.getByRole('button', { name: /Arm change/ }));
    expect(screen.getByRole('button', { name: 'Next section' })).toBeDisabled();
  });

  it('arms with fireAt="next-section" when that boundary is chosen', () => {
    const onArm = vi.fn();
    render(
      <ConductorCluster
        {...props({ onArm, canArmNextSection: true, targets: [target('b3', 'Coda')] })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Arm change/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Next section' }));
    fireEvent.click(screen.getByRole('button', { name: 'Coda' }));
    expect(onArm).toHaveBeenCalledWith(expect.objectContaining({ barId: 'b3' }), undefined, 'next-section');
  });

  // ── 5b chunk 2: the Clock toggle + rung readout + stall notice (§7) ──────────
  it('renders the Clock toggle reflecting state and flips onToggleClock', () => {
    const onToggleClock = vi.fn();
    const { rerender } = render(<ConductorCluster {...props({ clockOn: false, onToggleClock })} />);
    const off = screen.getByRole('button', { name: /Clock off/ });
    expect(off).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(off);
    expect(onToggleClock).toHaveBeenCalledOnce();
    rerender(<ConductorCluster {...props({ clockOn: true, onToggleClock })} />);
    expect(screen.getByRole('button', { name: /Clock on/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('hides the rung readout while the clock is off, shows it when on', () => {
    const { rerender } = render(<ConductorCluster {...props({ clockOn: false, rung: 'manual' })} />);
    expect(screen.queryByText('manual')).toBeNull();
    expect(screen.queryByText('fixed tempo')).toBeNull();
    rerender(<ConductorCluster {...props({ clockOn: true, rung: 'static-bpm' })} />);
    expect(screen.getByText('fixed tempo')).toBeInTheDocument();
  });

  it('reads out "manual" when the clock is on but the rung fell back', () => {
    render(<ConductorCluster {...props({ clockOn: true, rung: 'manual' })} />);
    expect(screen.getByText('manual')).toBeInTheDocument();
    expect(screen.queryByText('fixed tempo')).toBeNull();
  });

  it('surfaces the stall notice only when stalled', () => {
    const { rerender } = render(<ConductorCluster {...props({ stalled: false })} />);
    expect(screen.queryByText(/Clock paused/)).toBeNull();
    rerender(<ConductorCluster {...props({ stalled: true })} />);
    expect(screen.getByText(/Clock paused/)).toBeInTheDocument();
  });
});
