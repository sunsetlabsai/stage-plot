// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SettingsOverlay } from '../components/SettingsOverlay';

// design-single-backend §3.1, chunk 4 — the show-page settings modal mechanics.
//
// The host that opens this is untestable (the 6700-line AI page), so the modal's own
// three rules are pinned here instead: it shows its children, a backdrop click and the
// Close control dismiss it, and a click INSIDE the panel does NOT — the footgun that
// would dismiss the overlay mid-edit.

afterEach(cleanup);

describe('SettingsOverlay', () => {
  it('renders its children inside a modal dialog', () => {
    render(
      <SettingsOverlay onClose={vi.fn()}>
        <p>overlay body</p>
      </SettingsOverlay>,
    );

    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('overlay body')).toBeInTheDocument();
  });

  it('dismisses on a backdrop click', () => {
    const onClose = vi.fn();
    render(
      <SettingsOverlay onClose={onClose}>
        <p>body</p>
      </SettingsOverlay>,
    );

    fireEvent.click(screen.getByRole('dialog'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT dismiss on a click inside the panel — the mid-edit footgun', () => {
    const onClose = vi.fn();
    render(
      <SettingsOverlay onClose={onClose}>
        <p>body</p>
      </SettingsOverlay>,
    );

    // A click on the content bubbles to the panel, which stops it before the backdrop.
    fireEvent.click(screen.getByText('body'));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('dismisses on the Close control', () => {
    const onClose = vi.fn();
    render(
      <SettingsOverlay onClose={onClose}>
        <p>body</p>
      </SettingsOverlay>,
    );

    fireEvent.click(screen.getByRole('button', { name: /close/i }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
