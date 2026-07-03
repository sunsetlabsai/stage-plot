// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import RelayQrOverlay, { RelayConnectingOverlay } from '../components/RelayQrOverlay';

// ── Conductor 3b chunk 5: the QR overlay (design-conductor-3b §3 D1/D3) ───────
// The QR encodes the join URL; the 4-char large-type code is the can't-scan
// fallback — so a QR render FAILURE must still leave a joinable overlay.

vi.mock('qrcode', () => ({
  default: {
    toDataURL: vi.fn((url: string) =>
      url.includes('fail') ? Promise.reject(new Error('no qr')) : Promise.resolve('data:image/png;base64,QQ==')),
  },
}));

afterEach(cleanup);

describe('RelayQrOverlay', () => {
  it('renders the QR image for the join URL plus the large-type code', async () => {
    render(<RelayQrOverlay joinUrl="https://x.test/g/s?join=AB7X" code="AB7X" onClose={vi.fn()} />);
    expect(screen.getByText('AB7X')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('img')).toBeInTheDocument());
    expect(screen.getByText('or enter room code')).toBeInTheDocument();
  });

  it('QR failure degrades to the code-only overlay — still joinable', async () => {
    render(<RelayQrOverlay joinUrl="https://x.test/fail?join=AB7X" code="AB7X" onClose={vi.fn()} />);
    expect(screen.getByText('AB7X')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('room code')).toBeInTheDocument());
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('dismisses from the backdrop, Done, but NOT from the card body', () => {
    const onClose = vi.fn();
    render(<RelayQrOverlay joinUrl="https://x.test/g/s?join=AB7X" code="AB7X" onClose={onClose} />);
    fireEvent.click(screen.getByText('AB7X')); // inside the card — swallowed
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('dialog')); // the backdrop itself
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

// ── Cloud-relay UAT fix: the go-live INTERIM (create in flight, no code yet) ──
// A synthesized click right after the "Go live" tap can land on the freshly
// mounted backdrop — so the interim must NEVER dismiss from a backdrop tap
// (that was the silent "nothing happens" failure). Hide is the only door out,
// and the cluster's connecting chip re-opens it.
describe('RelayConnectingOverlay', () => {
  it('shows the honest connecting interim', () => {
    render(<RelayConnectingOverlay onHide={vi.fn()} />);
    expect(screen.getByText(/getting a room code/)).toBeInTheDocument();
  });

  it('does NOT dismiss from a backdrop or card tap — only from Hide', () => {
    const onHide = vi.fn();
    render(<RelayConnectingOverlay onHide={onHide} />);
    fireEvent.click(screen.getByRole('dialog')); // backdrop — swallowed
    fireEvent.click(screen.getByText(/getting a room code/)); // card — swallowed
    expect(onHide).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(onHide).toHaveBeenCalledTimes(1);
  });
});
