// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import RelayQrOverlay from '../components/RelayQrOverlay';

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
