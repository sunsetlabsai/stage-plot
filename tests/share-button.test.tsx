// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import ShareButton from '../components/ShareButton';

// ── Chart-PDF share: the tiered navigator wrapper, exercised via the button ──
// Tier 1 = share the PDF file; 2 = share the deep link URL; 3 = clipboard copy
// with the "Link copied" chip. A user-cancelled sheet (AbortError) is a clean
// no-op — never a clipboard fallback.

afterEach(() => {
  cleanup();
  // jsdom's navigator has no share/canShare by default; remove what a test added.
  delete (navigator as { share?: unknown }).share;
  delete (navigator as { canShare?: unknown }).canShare;
  delete (navigator as { clipboard?: unknown }).clipboard;
});

function stubNavigator(props: Record<string, unknown>) {
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(navigator, key, { value, configurable: true, writable: true });
  }
}

const pdfFile = () => new File([new Uint8Array([1, 2, 3])], 'Song – Guitar.pdf', { type: 'application/pdf' });

describe('ShareButton', () => {
  it('tier 1: shares the PDF file when the device can', async () => {
    const share = vi.fn<(data: ShareData) => Promise<void>>(() => Promise.resolve());
    const writeText = vi.fn();
    stubNavigator({ share, canShare: vi.fn(() => true), clipboard: { writeText } });

    render(<ShareButton title="Song – Guitar" buildUrl={() => 'https://x.test/b/s?song=1&chart=Guitar'} getFile={async () => pdfFile()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    const data = share.mock.calls[0][0];
    expect(data.files).toHaveLength(1);
    expect(data.files![0].name).toBe('Song – Guitar.pdf');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('tier 2: a failed bytes fetch degrades to sharing the deep link', async () => {
    const share = vi.fn<(data: ShareData) => Promise<void>>(() => Promise.resolve());
    stubNavigator({ share, canShare: vi.fn(() => true) });

    render(<ShareButton title="Song – Guitar" buildUrl={() => 'https://x.test/b/s?song=1&chart=Guitar'} getFile={async () => null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(share.mock.calls[0][0]).toEqual({ title: 'Song – Guitar', url: 'https://x.test/b/s?song=1&chart=Guitar' });
  });

  it('tier 2: show-level share (no getFile) shares the bare URL', async () => {
    const share = vi.fn<(data: ShareData) => Promise<void>>(() => Promise.resolve());
    stubNavigator({ share });

    render(<ShareButton title="Fall Tour" buildUrl={() => 'https://x.test/b/s'} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(share.mock.calls[0][0]).toEqual({ title: 'Fall Tour', url: 'https://x.test/b/s' });
  });

  it('tier 3: no Web Share → copies the link and shows "Link copied"', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    stubNavigator({ clipboard: { writeText } });

    render(<ShareButton title="Fall Tour" buildUrl={() => 'https://x.test/b/s'} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://x.test/b/s'));
    expect(await screen.findByRole('status')).toHaveTextContent('Link copied');
  });

  it('a user-cancelled share sheet is a clean no-op — no clipboard, no chip', async () => {
    const share = vi.fn(() => Promise.reject(new DOMException('cancelled', 'AbortError')));
    const writeText = vi.fn();
    stubNavigator({ share, clipboard: { writeText } });

    render(<ShareButton title="Fall Tour" buildUrl={() => 'https://x.test/b/s'} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));

    // Let the rejected share settle, then assert nothing else fired.
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share' })).not.toBeDisabled());
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a non-abort share failure falls through to the clipboard', async () => {
    const share = vi.fn(() => Promise.reject(new TypeError('nope')));
    const writeText = vi.fn(() => Promise.resolve());
    stubNavigator({ share, clipboard: { writeText } });

    render(<ShareButton title="Fall Tour" buildUrl={() => 'https://x.test/b/s'} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://x.test/b/s'));
    expect(await screen.findByRole('status')).toHaveTextContent('Link copied');
  });

  it('total failure (clipboard also throws) surfaces "Couldn\'t share"', async () => {
    stubNavigator({ clipboard: { writeText: vi.fn(() => Promise.reject(new Error('denied'))) } });

    render(<ShareButton title="Fall Tour" buildUrl={() => 'https://x.test/b/s'} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));

    expect(await screen.findByRole('status')).toHaveTextContent("Couldn't share");
  });
});
