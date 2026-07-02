// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import RelayStrip, { type RelayStripProps } from '../components/RelayStrip';

// ── Conductor 3b chunk 5: the follower strip (design-conductor-3b §10-5) ──────
// PURE presentational, one state at a time, honesty-first priority:
// connecting → conductor-lost (+ in-place confirm) → waiting → chart mismatch
// → mirroring. No transport controls ever (chunk-4 hard gate: one writer).

afterEach(cleanup);

function props(over: Partial<RelayStripProps> = {}): RelayStripProps {
  return {
    status: 'joined',
    conductorLost: false,
    conductorLabel: null,
    canClaim: false,
    waiting: false,
    chartMismatch: false,
    songTitle: null,
    readout: null,
    onTakeBaton: vi.fn(),
    onLeave: vi.fn(),
    ...over,
  };
}

describe('RelayStrip', () => {
  it('shows the connecting state with Leave, and Leave fires', () => {
    const onLeave = vi.fn();
    render(<RelayStrip {...props({ status: 'connecting', onLeave })} />);
    expect(screen.getByText(/Joining the room/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(onLeave).toHaveBeenCalledOnce();
  });

  it('mirroring: attributes the conductor by relay label, never an invented name', () => {
    const { rerender } = render(<RelayStrip {...props({ conductorLabel: 'Rachel' })} />);
    expect(screen.getByText('Rachel')).toBeInTheDocument();
    expect(screen.getByText(/is conducting/)).toBeInTheDocument();
    // Label unknown (frame not yet arrived) → the honest generic line.
    rerender(<RelayStrip {...props({ conductorLabel: null })} />);
    expect(screen.getByText('Following the conductor')).toBeInTheDocument();
  });

  it('mirroring: renders the song title and bar readout when supplied', () => {
    render(
      <RelayStrip
        {...props({ conductorLabel: 'Rachel', songTitle: 'Opener', readout: { absNumber: 17, passLabel: 'Pass 2' } })}
      />,
    );
    expect(screen.getByText(/Opener/)).toBeInTheDocument();
    expect(screen.getByText('17')).toBeInTheDocument();
    expect(screen.getByText(/Pass 2/)).toBeInTheDocument();
  });

  it('waiting: says so, and offers "Conduct from here" only when claimable', () => {
    const onTakeBaton = vi.fn();
    const { rerender } = render(<RelayStrip {...props({ waiting: true, canClaim: false, onTakeBaton })} />);
    expect(screen.getByText(/waiting for a conductor/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Conduct from here' })).toBeNull();
    rerender(<RelayStrip {...props({ waiting: true, canClaim: true, onTakeBaton })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Conduct from here' }));
    expect(onTakeBaton).toHaveBeenCalledOnce();
  });

  it('chart mismatch: names the room chart when it can, generic when it cannot', () => {
    const { rerender } = render(<RelayStrip {...props({ chartMismatch: true, songTitle: 'Ballad' })} />);
    expect(screen.getByText('Ballad')).toBeInTheDocument();
    expect(screen.getByText(/not on this device/)).toBeInTheDocument();
    rerender(<RelayStrip {...props({ chartMismatch: true, songTitle: null })} />);
    expect(screen.getByText(/a different chart/)).toBeInTheDocument();
  });

  it('conductor-lost outranks waiting/mismatch and gates the take-baton door on canClaim', () => {
    const { rerender } = render(
      <RelayStrip {...props({ conductorLost: true, waiting: true, chartMismatch: true, canClaim: false })} />,
    );
    expect(screen.getByText(/Conductor lost/)).toBeInTheDocument();
    expect(screen.queryByText(/waiting for a conductor/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Take the baton' })).toBeNull();
    rerender(<RelayStrip {...props({ conductorLost: true, canClaim: true })} />);
    expect(screen.getByRole('button', { name: 'Take the baton' })).toBeInTheDocument();
  });

  it('take-baton is an in-place two-tap confirm (no modal mid-song)', () => {
    const onTakeBaton = vi.fn();
    render(<RelayStrip {...props({ conductorLost: true, canClaim: true, onTakeBaton })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Take the baton' }));
    expect(onTakeBaton).not.toHaveBeenCalled(); // first tap only arms
    expect(screen.getByText(/Take over as conductor/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Take it' }));
    expect(onTakeBaton).toHaveBeenCalledOnce();
  });

  it('Cancel disarms the confirm without claiming', () => {
    const onTakeBaton = vi.fn();
    render(<RelayStrip {...props({ conductorLost: true, canClaim: true, onTakeBaton })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Take the baton' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onTakeBaton).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Take the baton' })).toBeInTheDocument();
  });

  it('a resolved lost-state clears a pending confirm — it cannot pre-arm a LATER orphan', () => {
    const { rerender } = render(<RelayStrip {...props({ conductorLost: true, canClaim: true })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Take the baton' }));
    expect(screen.getByText(/Take over as conductor/)).toBeInTheDocument();
    // The relay's writer frame lands: lost resolves…
    rerender(<RelayStrip {...props({ conductorLost: false, conductorLabel: 'Rachel' })} />);
    expect(screen.getByText(/is conducting/)).toBeInTheDocument();
    // …and a SECOND orphan starts from the unarmed state.
    rerender(<RelayStrip {...props({ conductorLost: true, canClaim: true })} />);
    expect(screen.queryByText(/Take over as conductor/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Take the baton' })).toBeInTheDocument();
  });

  it('never renders transport controls in any state (the wire is the one writer)', () => {
    for (const p of [
      props(),
      props({ status: 'connecting' }),
      props({ conductorLost: true, canClaim: true }),
      props({ waiting: true, canClaim: true }),
      props({ chartMismatch: true }),
    ]) {
      const { unmount } = render(<RelayStrip {...p} />);
      expect(screen.queryByRole('button', { name: /Advance/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /bar/ })).toBeNull();
      unmount();
    }
  });
});
