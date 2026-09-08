// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ChartReviewSheet, type ChartReviewSheetProps } from '../components/ChartReviewSheet';
import type { CountOutcome } from '../lib/chart-review-sheet';

// ── The review sheet (jsdom) ─────────────────────────────────────────────────
// PURE presentational — props in, callbacks out, no PDF and no calibration. The
// assertions that matter are the two the frozen design turns on: nothing commits
// without the owner seeing the picture, and leaving never writes.

afterEach(cleanup);

const okCount = (xs: number[], surplus = 0): CountOutcome => ({ kind: 'ok', xs, surplus });

function props(over: Partial<ChartReviewSheetProps> = {}): ChartReviewSheetProps {
  return {
    lineNumber: 7,
    queueTotal: 3,
    queueIndex: 0,
    flagged: true,
    candidates: [
      { xs: [0.25, 0.5, 0.75, 1], sources: ['measured'] },
      { xs: [0.33, 0.66, 1], sources: ['current'] },
    ],
    renderStrip: (xs) => <div data-testid="strip" data-xs={xs ? xs.join(',') : 'none'} />,
    countChoices: [3, 4, 5, 6, 7],
    onProposeCount: vi.fn(() => okCount([0.25, 0.5, 0.75, 1])),
    onConfirm: vi.fn(),
    onDismiss: vi.fn(),
    onOpenCalibrate: vi.fn(),
    ...over,
  };
}

describe('ChartReviewSheet — the ask', () => {
  it('names the line and its place in the queue when the machine flagged it', () => {
    render(<ChartReviewSheet {...props()} />);
    expect(screen.getByText('Line 7')).toBeTruthy();
    expect(screen.getByText('1 of 3 to check')).toBeTruthy();
    expect(screen.getByText(/didn't check out/)).toBeTruthy();
  });

  it('says the owner opened it when nothing flagged it', () => {
    render(<ChartReviewSheet {...props({ flagged: false, queueTotal: null, queueIndex: null })} />);
    expect(screen.getByText('you opened this')).toBeTruthy();
    expect(screen.getByText(/Nothing flagged this line/)).toBeTruthy();
  });

  it('asks "which split" for two candidates and "does this look right" for one', () => {
    const { unmount } = render(<ChartReviewSheet {...props()} />);
    expect(screen.getByText('Which split looks right?')).toBeTruthy();
    unmount();
    render(<ChartReviewSheet {...props({ candidates: [{ xs: [0.5, 1], sources: ['current'] }] })} />);
    expect(screen.getByText('Does this look right?')).toBeTruthy();
    expect(screen.getByText('Yes, 2 bars')).toBeTruthy();
  });

  it('cannot commit until a candidate is picked', () => {
    const onConfirm = vi.fn();
    render(<ChartReviewSheet {...props({ onConfirm })} />);
    const use = screen.getByText('Use this') as HTMLButtonElement;
    expect(use.disabled).toBe(true);
    fireEvent.click(screen.getByText('4 bars'));
    expect((screen.getByText('Use this') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByText('Use this'));
    expect(onConfirm).toHaveBeenCalledWith([0.25, 0.5, 0.75, 1]);
  });

  it('leaving writes nothing', () => {
    const onConfirm = vi.fn();
    const onDismiss = vi.fn();
    render(<ChartReviewSheet {...props({ onConfirm, onDismiss })} />);
    fireEvent.click(screen.getByText('Later'));
    expect(onDismiss).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('ChartReviewSheet — the count', () => {
  it('"None of these" leads to the count, and the strip shows no split there', () => {
    render(<ChartReviewSheet {...props()} />);
    fireEvent.click(screen.getByText('None of these'));
    expect(screen.getByText('How many bars?')).toBeTruthy();
    expect(screen.getByTestId('strip').getAttribute('data-xs')).toBe('none');
  });

  it('★ a count NEVER commits directly — it previews first', () => {
    // The measurement says an undercount is accepted by the geometry every time and
    // nothing downstream can catch it, so this step is the only remaining check.
    const onConfirm = vi.fn();
    const onProposeCount = vi.fn(() => okCount([0.25, 0.5, 0.75, 1]));
    render(<ChartReviewSheet {...props({ onConfirm, onProposeCount })} />);
    fireEvent.click(screen.getByText('None of these'));
    fireEvent.click(screen.getByText('4'));
    expect(onProposeCount).toHaveBeenCalledWith(4);
    expect(onConfirm).not.toHaveBeenCalled(); // <-- the whole point
    expect(screen.getByText(/what 4 bars gives you/)).toBeTruthy();
    expect(screen.getByTestId('strip').getAttribute('data-xs')).toBe('0.25,0.5,0.75,1');
  });

  it('commits only on the explicit confirm, with the proposed split', () => {
    const onConfirm = vi.fn();
    render(<ChartReviewSheet {...props({ onConfirm })} />);
    fireEvent.click(screen.getByText('None of these'));
    fireEvent.click(screen.getByText('4'));
    fireEvent.click(screen.getByText('Keep 4'));
    expect(onConfirm).toHaveBeenCalledWith([0.25, 0.5, 0.75, 1]);
  });

  it('shows the surplus warning when barlines are left unused', () => {
    const onProposeCount = vi.fn(() => okCount([0.33, 0.66, 1], 1));
    render(<ChartReviewSheet {...props({ onProposeCount })} />);
    fireEvent.click(screen.getByText('None of these'));
    fireEvent.click(screen.getByText('3'));
    expect(screen.getByText(/We can see 4 barlines in this line, not 3/)).toBeTruthy();
  });

  it('warns but does NOT block — the owner may be right', () => {
    const onConfirm = vi.fn();
    const onProposeCount = vi.fn(() => okCount([0.33, 0.66, 1], 1));
    render(<ChartReviewSheet {...props({ onConfirm, onProposeCount })} />);
    fireEvent.click(screen.getByText('None of these'));
    fireEvent.click(screen.getByText('3'));
    fireEvent.click(screen.getByText('Keep 3'));
    expect(onConfirm).toHaveBeenCalledWith([0.33, 0.66, 1]);
  });

  it('says nothing alarming when the count uses every barline', () => {
    render(<ChartReviewSheet {...props()} />);
    fireEvent.click(screen.getByText('None of these'));
    fireEvent.click(screen.getByText('4'));
    expect(screen.queryByText(/We can see/)).toBeNull();
    expect(screen.getByText(/kept exactly as given/)).toBeTruthy();
  });

  it('can go back and change the count without committing', () => {
    const onConfirm = vi.fn();
    render(<ChartReviewSheet {...props({ onConfirm })} />);
    fireEvent.click(screen.getByText('None of these'));
    fireEvent.click(screen.getByText('4'));
    fireEvent.click(screen.getByText('Change count'));
    expect(screen.getByText('How many bars?')).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('ChartReviewSheet — refusal', () => {
  const refused = (): CountOutcome => ({
    kind: 'refused', reason: 'insufficient-evidence', available: 2,
  });

  it('explains, offers the hand-off, and never commits', () => {
    const onConfirm = vi.fn();
    const onOpenCalibrate = vi.fn();
    render(
      <ChartReviewSheet
        {...props({ onConfirm, onOpenCalibrate, onProposeCount: vi.fn(refused) })}
      />,
    );
    fireEvent.click(screen.getByText('None of these'));
    fireEvent.click(screen.getByText('5'));
    expect(screen.getByText(/only see 2 barlines/)).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Set them by hand'));
    expect(onOpenCalibrate).toHaveBeenCalledWith(5); // the count is carried over
  });

  it('skipping a refused line writes nothing', () => {
    const onConfirm = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ChartReviewSheet
        {...props({ onConfirm, onDismiss, onProposeCount: vi.fn(refused) })}
      />,
    );
    fireEvent.click(screen.getByText('None of these'));
    fireEvent.click(screen.getByText('5'));
    fireEvent.click(screen.getByText('Skip this line'));
    expect(onDismiss).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
