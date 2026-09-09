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
    renderStrip: (xs, _tone, variant) => (
      <div
        data-testid={variant === 'mini' ? 'mini' : 'strip'}
        data-xs={xs ? xs.join(',') : 'none'}
      />
    ),
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

  it('asks which one for two candidates and "does this look right" for one', () => {
    const { unmount } = render(<ChartReviewSheet {...props()} />);
    expect(screen.getByText('Which one looks right?')).toBeTruthy();
    unmount();
    render(<ChartReviewSheet {...props({ candidates: [{ xs: [0.5, 1], sources: ['current'] }] })} />);
    expect(screen.getByText('Does this look right?')).toBeTruthy();
    expect(screen.getByText('Yes, 2 bars')).toBeTruthy();
  });

  it('★ every option is a PICTURE, not just a count', () => {
    // The finding this replaces: options read only "N bars", so two different 4-bar
    // geometries were indistinguishable and "Use this" committed something never seen.
    render(
      <ChartReviewSheet
        {...props({
          candidates: [
            { xs: [0.25, 0.5, 0.75, 1], sources: ['current'] },
            { xs: [0.1, 0.4, 0.6, 1], sources: ['printed'] },
          ],
        })}
      />,
    );
    // Two options that a count alone CANNOT tell apart — both say "4 bars".
    expect(screen.getAllByText('4 bars')).toHaveLength(2);
    const minis = screen.getAllByTestId('mini').map((n) => n.getAttribute('data-xs'));
    expect(minis).toEqual(['0.25,0.5,0.75,1', '0.1,0.4,0.6,1']);
    // And the one piece of provenance a non-reader can act on.
    expect(screen.getByText(/printed on your chart/)).toBeTruthy();
  });

  it('the full-size strip follows the selection, so the answer is visible before it commits', () => {
    render(<ChartReviewSheet {...props()} />);
    expect(screen.getByTestId('strip').getAttribute('data-xs')).toBe('none');
    fireEvent.click(screen.getByText('3 bars'));
    expect(screen.getByTestId('strip').getAttribute('data-xs')).toBe('0.33,0.66,1');
  });

  it('cannot commit until a candidate is picked, and previews it first', () => {
    const onConfirm = vi.fn();
    render(<ChartReviewSheet {...props({ onConfirm })} />);
    const use = screen.getByText('Use this') as HTMLButtonElement;
    expect(use.disabled).toBe(true);
    fireEvent.click(screen.getByText('4 bars'));
    expect((screen.getByText('Use this') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByText('Use this'));
    // Several candidates ⇒ full-size preview, exactly like the count path.
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByTestId('strip').getAttribute('data-xs')).toBe('0.25,0.5,0.75,1');
    fireEvent.click(screen.getByText('Keep 4 bars'));
    expect(onConfirm).toHaveBeenCalledWith([0.25, 0.5, 0.75, 1]);
  });

  it('a single candidate commits straight from the ask — it is already full size', () => {
    const onConfirm = vi.fn();
    render(
      <ChartReviewSheet
        {...props({ onConfirm, candidates: [{ xs: [0.5, 1], sources: ['current'] }] })}
      />,
    );
    expect(screen.getByTestId('strip').getAttribute('data-xs')).toBe('0.5,1');
    fireEvent.click(screen.getByText('Yes, 2 bars'));
    fireEvent.click(screen.getByText('Use this'));
    expect(onConfirm).toHaveBeenCalledWith([0.5, 1]);
  });

  it('backing out of a count and then picking a candidate previews the CANDIDATE', () => {
    // The two preview routes share a step. Without clearing the answered count, picking
    // a candidate afterwards would land on the stale count preview instead.
    const onConfirm = vi.fn();
    render(<ChartReviewSheet {...props({ onConfirm })} />);
    fireEvent.click(screen.getByText('None of these'));
    fireEvent.click(screen.getByText('5'));
    fireEvent.click(screen.getByText('Change count'));
    fireEvent.click(screen.getByText('Back'));
    fireEvent.click(screen.getByText('3 bars'));
    fireEvent.click(screen.getByText('Use this'));
    expect(screen.getByText('Keep 3 bars')).toBeTruthy();
    fireEvent.click(screen.getByText('Keep 3 bars'));
    expect(onConfirm).toHaveBeenCalledWith([0.33, 0.66, 1]);
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

describe('ChartReviewSheet — the words the owner actually sees', () => {
  // ★ THE BAN IS ENFORCED ON THE COMPONENT, NOT JUST THE COPY HELPERS (Codex L2, #184).
  // The old vocabulary test covered `surplusWarning`/`refusalMessage` only, so the
  // component's own literals went unchecked — and the UI test above it asserted the wrong
  // wording verbatim, which LOCKED THE BUG IN. Harvest what actually renders.
  //
  // `split` is on the list because it is what the CODE calls this thing. The principle is
  // "pick the picture"; a person who cannot read notation cannot be asked which
  // implementation noun looks right.
  const BANNED = [
    'measure', 'span', 'multirest', 'cluster', 'system', 'stave', 'staff',
    'split', 'verdict', 'geometry', 'calibrat',
  ];

  function harvest(container: HTMLElement): string {
    const labels = Array.from(container.querySelectorAll('[aria-label]'))
      .map((n) => n.getAttribute('aria-label') ?? '')
      .join(' ');
    return `${container.textContent ?? ''} ${labels}`.toLowerCase();
  }

  function check(container: HTMLElement, where: string) {
    const text = harvest(container);
    // POSITIVE CONTROL: an empty harvest would pass every ban vacuously.
    expect(text.length, `${where} rendered nothing to check`).toBeGreaterThan(20);
    for (const banned of BANNED) {
      expect(text, `"${banned}" leaked into the ${where} screen`).not.toContain(banned);
    }
  }

  it('never uses notation or engine vocabulary, on any screen', () => {
    const { container, unmount } = render(<ChartReviewSheet {...props()} />);
    check(container, 'ask');
    fireEvent.click(screen.getByText('4 bars'));
    fireEvent.click(screen.getByText('Use this'));
    check(container, 'candidate preview');
    fireEvent.click(screen.getByText('Back'));
    fireEvent.click(screen.getByText('None of these'));
    check(container, 'count');
    fireEvent.click(screen.getByText('4'));
    check(container, 'count preview');
    unmount();

    // The surplus warning and every refusal reason, in situ.
    const surplus = render(
      <ChartReviewSheet {...props({ onProposeCount: vi.fn(() => okCount([0.33, 0.66, 1], 1)) })} />,
    );
    fireEvent.click(screen.getByText('None of these'));
    fireEvent.click(screen.getByText('3'));
    check(surplus.container, 'surplus warning');
    surplus.unmount();

    for (const reason of ['insufficient-evidence', 'out-of-staff', 'degenerate-span', 'invalid-count'] as const) {
      const r = render(
        <ChartReviewSheet
          {...props({ onProposeCount: vi.fn((): CountOutcome => ({ kind: 'refused', reason, available: 2 })) })}
        />,
      );
      fireEvent.click(screen.getByText('None of these'));
      fireEvent.click(screen.getByText('5'));
      check(r.container, `refusal (${reason})`);
      r.unmount();
    }
  });

  it('the ban actually fires when a banned word comes back', () => {
    // POSITIVE CONTROL for the checker itself — a test that cannot fail is not a test.
    // This is the exact string the component used to render.
    const div = document.createElement('div');
    div.textContent = 'Which split looks right? Pick the one that matches your chart.';
    expect(() => check(div, 'synthetic')).toThrow(/"split" leaked/);
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
