// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SlotDeleteDialog } from '../components/SlotDeleteDialog';

// UAT S8. THE DEFECT THIS PINS: both buttons of the old prompt deleted. Every
// exit that is not one of the two delete buttons must call onCancel ONLY.

afterEach(cleanup);

function setup(linkedCount = 2) {
  const fns = { onKeepLinks: vi.fn(), onClearLinks: vi.fn(), onCancel: vi.fn() };
  render(<SlotDeleteDialog slotName="Keys" linkedCount={linkedCount} {...fns} />);
  return fns;
}

function only(fns: ReturnType<typeof setup>, which: keyof ReturnType<typeof setup>) {
  for (const [k, fn] of Object.entries(fns)) expect(fn).toHaveBeenCalledTimes(k === which ? 1 : 0);
}

describe('SlotDeleteDialog', () => {
  it('Cancel deletes nothing', () => {
    const fns = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    only(fns, 'onCancel');
  });

  it('a backdrop click cancels; a click inside the panel does nothing', () => {
    const fns = setup();
    fireEvent.click(screen.getByText(/linked to this slot/));
    for (const fn of Object.values(fns)) expect(fn).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('dialog'));
    only(fns, 'onCancel');
  });

  it('Escape cancels', () => {
    const fns = setup();
    fireEvent.keyDown(window, { key: 'Escape' });
    only(fns, 'onCancel');
  });

  it('Cancel has focus, so Enter on open is not a delete', () => {
    setup();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('the two delete buttons each do their own thing', () => {
    let fns = setup();
    fireEvent.click(screen.getByRole('button', { name: /keep the 2 inputs/ }));
    only(fns, 'onKeepLinks');
    cleanup();
    fns = setup();
    fireEvent.click(screen.getByRole('button', { name: /unlink the 2 inputs/ }));
    only(fns, 'onClearLinks');
  });

  it('names the slot and the count, singular for one', () => {
    setup(1);
    expect(screen.getByText('Delete “Keys”?')).toBeTruthy();
    expect(screen.getByText('1 input is linked to this slot.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /keep the 1 input\b/ })).toBeTruthy();
  });
});
