// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import SetlistImportPreview, {
  type SetlistImportPreviewProps,
} from '../components/SetlistImportPreview';
import type { ImportDiff } from '../lib/setlist-import';

// Setlist import chunk 3 — the preview/diff gate (design §7).
//
// The merge SEMANTICS are pinned by tests/setlist-import.test.ts (chunk 1). What
// this file owes is the gate: that nothing destructive is one click away, that the
// copy the design REQUIRES to be present is present, and that intent is reported
// faithfully to the parent.
//
// Written against the chunk-1/chunk-2 lesson: every assertion has to distinguish
// the correct implementation from the plausible-wrong one. The load-bearing case is
// "Apply with removals armed does NOT call onApply on the first click" — an
// implementation that skips the confirmation passes a naive "onApply fires" test.

afterEach(cleanup);

const emptyDiff: ImportDiff = {
  matched: [],
  added: [],
  missing: [],
  removed: [],
  reordered: false,
};

function props(over: Partial<SetlistImportPreviewProps> = {}): SetlistImportPreviewProps {
  return {
    rowCount: 3,
    diff: emptyDiff,
    ignored: { bpm: false, artist: false },
    removeMissing: false,
    onToggleRemoveMissing: vi.fn(),
    onApply: vi.fn(),
    onCancel: vi.fn(),
    ...over,
  };
}

describe('SetlistImportPreview — summary', () => {
  it('names the row count read from the sheet', () => {
    render(<SetlistImportPreview {...props({ rowCount: 14 })} />);
    expect(screen.getByText(/Importing 14 songs from your sheet/)).toBeTruthy();
  });

  it('singularizes a one-row sheet', () => {
    render(<SetlistImportPreview {...props({ rowCount: 1 })} />);
    expect(screen.getByText(/Importing 1 song from your sheet/)).toBeTruthy();
  });

  it('reports matched and added counts, and promises charts and tempo are kept', () => {
    const diff: ImportDiff = {
      ...emptyDiff,
      matched: [
        { title: 'Ophelia', changes: [] },
        { title: 'The Weight', changes: [] },
      ],
      added: [{ title: 'Cripple Creek' }],
    };
    render(<SetlistImportPreview {...props({ diff })} />);
    expect(screen.getByText(/2 songs matched/)).toBeTruthy();
    expect(screen.getByText(/charts and tempo kept/)).toBeTruthy();
    expect(screen.getByText(/1 song added/)).toBeTruthy();
  });

  it('announces a reorder only when the merge actually reorders', () => {
    const { unmount } = render(<SetlistImportPreview {...props()} />);
    expect(screen.queryByText(/Order will change/)).toBeNull();
    unmount();
    render(<SetlistImportPreview {...props({ diff: { ...emptyDiff, reordered: true } })} />);
    expect(screen.getByText(/Order will change/)).toBeTruthy();
  });
});

describe('SetlistImportPreview — ignored columns (§6, §10)', () => {
  it('says BPM was found and will not be imported, only when the column is present', () => {
    const { unmount } = render(<SetlistImportPreview {...props()} />);
    expect(screen.queryByText(/BPM column found/)).toBeNull();
    unmount();
    render(<SetlistImportPreview {...props({ ignored: { bpm: true, artist: false } })} />);
    expect(screen.getByText(/BPM column found/)).toBeTruthy();
    expect(screen.getByText(/Tap Tempo/)).toBeTruthy();
  });

  it('says the same for artist, independently of bpm', () => {
    render(<SetlistImportPreview {...props({ ignored: { bpm: false, artist: true } })} />);
    expect(screen.getByText(/Artist column found/)).toBeTruthy();
    expect(screen.queryByText(/BPM column found/)).toBeNull();
  });
});

describe('SetlistImportPreview — details list', () => {
  it('renders a field change with an em-dash for a previously-empty value', () => {
    const diff: ImportDiff = {
      ...emptyDiff,
      matched: [{ title: 'Ophelia', changes: [{ field: 'key', to: 'Bb' }] }],
    };
    render(<SetlistImportPreview {...props({ diff })} />);
    expect(screen.getByText(/key: — → Bb/)).toBeTruthy();
  });

  it('shows the previous value when one existed', () => {
    const diff: ImportDiff = {
      ...emptyDiff,
      matched: [{ title: 'Ophelia', changes: [{ field: 'key', from: 'A', to: 'Bb' }] }],
    };
    render(<SetlistImportPreview {...props({ diff })} />);
    expect(screen.getByText(/key: A → Bb/)).toBeTruthy();
  });

  it('says "no changes" for a matched row the sheet did not alter', () => {
    const diff: ImportDiff = {
      ...emptyDiff,
      matched: [{ title: 'The Weight', changes: [] }],
    };
    render(<SetlistImportPreview {...props({ diff })} />);
    expect(screen.getByText(/no changes/)).toBeTruthy();
  });
});

describe('SetlistImportPreview — removal is opt-in (§4 rule 5, §7)', () => {
  const withMissing: ImportDiff = {
    ...emptyDiff,
    matched: [{ title: 'Ophelia', changes: [] }],
    missing: [
      { title: 'Old Intro', index: 3 },
      { title: 'Segue', index: 4 },
    ],
  };

  it('leaves the checkbox unchecked and labels absent rows as kept', () => {
    render(<SetlistImportPreview {...props({ diff: withMissing })} />);
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    // Both absent rows are listed, and both are labelled kept — asserting the
    // count matters, because showing only the first would also satisfy a
    // getByText and would silently hide a row from the user's decision.
    expect(screen.getAllByText(/Not in sheet/)).toHaveLength(2);
    expect(screen.getAllByText(/\(kept\)/)).toHaveLength(2);
    expect(screen.getByText('Old Intro')).toBeTruthy();
    expect(screen.getByText('Segue')).toBeTruthy();
  });

  it('names the count in the checkbox label', () => {
    render(<SetlistImportPreview {...props({ diff: withMissing })} />);
    expect(screen.getByText(/Also remove the 2 songs not in this sheet/)).toBeTruthy();
  });

  it('offers no checkbox at all when every existing song is in the sheet', () => {
    render(<SetlistImportPreview {...props()} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('reports the toggle upward rather than owning the mode itself', () => {
    const onToggleRemoveMissing = vi.fn();
    render(
      <SetlistImportPreview {...props({ diff: withMissing, onToggleRemoveMissing })} />,
    );
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onToggleRemoveMissing).toHaveBeenCalledWith(true);
  });

  it('re-labels absent rows as removals once removal is armed', () => {
    const removedDiff: ImportDiff = {
      ...emptyDiff,
      removed: [{ title: 'Old Intro', index: 3 }],
    };
    render(
      <SetlistImportPreview {...props({ diff: removedDiff, removeMissing: true })} />,
    );
    expect(screen.getByText(/Removing/)).toBeTruthy();
    expect(screen.queryByText(/\(kept\)/)).toBeNull();
  });

  // The design does not merely suggest this sentence — it requires it, because
  // "removed" reads as destructive and here the charts genuinely survive.
  it('REQUIRES the charts-survive reassurance whenever removal is armed', () => {
    const removedDiff: ImportDiff = {
      ...emptyDiff,
      removed: [{ title: 'Old Intro', index: 3 }],
    };
    const { unmount } = render(
      <SetlistImportPreview {...props({ diff: removedDiff, removeMissing: true })} />,
    );
    expect(screen.getByText(/charts stay in your chart library/)).toBeTruthy();
    unmount();
    // ...and does not show it when nothing is being removed, where it would be noise.
    render(<SetlistImportPreview {...props({ diff: withMissing })} />);
    expect(screen.queryByText(/charts stay in your chart library/)).toBeNull();
  });
});

describe('SetlistImportPreview — the apply gate', () => {
  const removedDiff: ImportDiff = {
    ...emptyDiff,
    removed: [
      { title: 'Old Intro', index: 3 },
      { title: 'Segue', index: 4 },
    ],
  };

  it('applies in one click when nothing is being removed', () => {
    const onApply = vi.fn();
    render(<SetlistImportPreview {...props({ onApply })} />);
    fireEvent.click(screen.getByText('Apply import'));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  // THE load-bearing assertion. An implementation that fires straight through
  // passes "onApply is called"; only asserting NOT-called on click 1 catches it.
  it('does NOT apply on the first click when removals are armed', () => {
    const onApply = vi.fn();
    render(
      <SetlistImportPreview
        {...props({ diff: removedDiff, removeMissing: true, onApply })}
      />,
    );
    fireEvent.click(screen.getByText('Apply import'));
    expect(onApply).not.toHaveBeenCalled();
  });

  it('names the count in the confirmation, then applies on the second click', () => {
    const onApply = vi.fn();
    render(
      <SetlistImportPreview
        {...props({ diff: removedDiff, removeMissing: true, onApply })}
      />,
    );
    fireEvent.click(screen.getByText('Apply import'));
    const confirm = screen.getByText('Yes — remove 2 songs and apply');
    expect(screen.getByRole('status').textContent).toMatch(/removes 2 songs/);
    fireEvent.click(confirm);
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  // A stale confirmation is the subtle failure: arm removal, click Apply once,
  // uncheck, re-check — a naive boolean would still be armed and the next single
  // click would destroy rows with no confirmation at all.
  it('disarms an armed confirmation when the removal mode is touched', () => {
    const onApply = vi.fn();
    const onToggleRemoveMissing = vi.fn();
    const { rerender } = render(
      <SetlistImportPreview
        {...props({
          diff: removedDiff,
          removeMissing: true,
          onApply,
          onToggleRemoveMissing,
        })}
      />,
    );
    fireEvent.click(screen.getByText('Apply import'));
    expect(screen.getByText('Yes — remove 2 songs and apply')).toBeTruthy();

    // Uncheck, then re-check — the parent drives removeMissing back to true.
    fireEvent.click(screen.getByRole('checkbox'));
    rerender(
      <SetlistImportPreview
        {...props({
          diff: removedDiff,
          removeMissing: true,
          onApply,
          onToggleRemoveMissing,
        })}
      />,
    );
    expect(screen.getByText('Apply import')).toBeTruthy();
    expect(screen.queryByText(/Yes — remove/)).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('cancels without ever applying', () => {
    const onApply = vi.fn();
    const onCancel = vi.fn();
    render(<SetlistImportPreview {...props({ diff: removedDiff, onApply, onCancel })} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('still cancels from the armed-confirmation state', () => {
    const onApply = vi.fn();
    const onCancel = vi.fn();
    render(
      <SetlistImportPreview
        {...props({ diff: removedDiff, removeMissing: true, onApply, onCancel })}
      />,
    );
    fireEvent.click(screen.getByText('Apply import'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });
});
