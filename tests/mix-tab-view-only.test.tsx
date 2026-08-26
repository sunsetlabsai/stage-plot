// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MixTab } from '../app/[owner]/[show]/page';
import type { BandConfig, SetlistSong } from '../lib/types';

// design-single-backend.md §3.3c — "the show UI exposes no edit affordance to a
// collaborator". Codex R2 HIGH on chunk 6.
//
// THE DEFECT THIS PINS: chunk 6 gated which TABS render (lib/show-tabs) and then
// assumed the surviving tabs were read-only. Mix is not. It is handed a live
// `onReorder` callback into updateConfig, and its Reorder button was ungated —
// so a collaborator could drag the run order into a new sequence. useShow blocks
// persistence, which made this invisible in every server-side test.
//
// ★ The second half is subtler and is the reason `reordering` is DERIVED rather
// than reset: `reorderMode` is component state, and MixTab does not remount when
// /[owner]/[show] changes params. An owner who leaves Mix in reorder mode and
// opens a show they only collaborate on keeps the drag table. Same trap as
// `tab`, one component deeper.

afterEach(cleanup);

function song(over: Partial<SetlistSong> = {}): SetlistSong {
  return { id: 'r1', position: 1, title: 'Song', lead: 'Alex', bpm: null, ...over };
}

// No `as BandConfig` cast: the first draft of this fixture had `notes: ''` and a
// handful of invented fields, and the cast silenced the type error until the
// render blew up at runtime. Left unannotated-but-typed so the shape is checked.
function band(over: Partial<BandConfig> = {}): BandConfig {
  return {
    slug: 'my-show',
    name: 'The Band',
    lineup: '4-Piece Band',
    stagePlot: [],
    inputs: [],
    monitors: [],
    notes: [],
    setlist: [song({ id: 'r1', position: 1 }), song({ id: 'r2', position: 2, title: 'Second' })],
    ...over,
  };
}

function props(over: Record<string, unknown> = {}) {
  return {
    band: band(),
    setlist: band().setlist ?? [],
    printSections: { stagePlot: true, inputList: true, monitorMixes: true, notes: true, setlist: true },
    showInfo: { bandName: 'The Band', eventDate: '2026-09-01', venue: 'The Venue' },
    isOffline: false,
    slug: 'my-show',
    owner: 'owner',
    isOwner: true,
    onReorder: vi.fn(),
    ...over,
  };
}

describe('MixTab — a collaborator gets no reorder affordance', () => {
  it('does NOT render the Reorder button for a non-owner', () => {
    render(<MixTab {...props({ isOwner: false })} />);

    expect(screen.queryByRole('button', { name: /reorder/i })).toBeNull();
  });

  it('COUNTEREXAMPLE: the owner still gets it', () => {
    // ★ Without this, deleting the button outright — or gating it on something
    // always-false — passes the assertion above and reads as a fix.
    render(<MixTab {...props({ isOwner: true })} />);

    expect(screen.queryByRole('button', { name: /reorder/i })).not.toBeNull();
  });

  it('still renders the run order itself to a collaborator', () => {
    // View ONLY, not shut out. §3.3c keeps membership precisely so an invited
    // show stays readable — a fix that hid the setlist would be a different bug.
    render(<MixTab {...props({ isOwner: false })} />);

    // queryAll, not query: the title appears in more than one section of the
    // Mix sheet, and the single-match form throws on that rather than passing.
    expect(screen.queryAllByText('Second').length).toBeGreaterThan(0);
  });
});

describe('MixTab — reorder mode cannot survive into a collaborator view', () => {
  // The drag handle (☰) renders only inside the reorder table, so its presence
  // is the observable form of "this viewer is in reorder mode".
  const HANDLE = '☰';
  const handles = () => screen.queryAllByText(HANDLE).length;

  it('drops reorder mode when the SAME instance switches to a non-owner show', () => {
    // ★ THE ACTUAL DEFECT. Asserting that a freshly-mounted non-owner sees no
    // drag handles proves nothing — reorderMode starts false, so that passes
    // with or without the fix. The bug needs the state to already be true:
    // /[owner]/[show] re-renders on a param change instead of remounting, so
    // reorderMode carries across. rerender() reproduces exactly that.
    const { rerender } = render(<MixTab {...props({ isOwner: true })} />);

    fireEvent.click(screen.getByRole('button', { name: /reorder/i }));
    // POSITIVE CONTROL: without this the assertion below could pass because the
    // table never opened, not because ownership closed it.
    expect(handles()).toBeGreaterThan(0);

    rerender(<MixTab {...props({ isOwner: false })} />);

    expect(handles()).toBe(0);
    expect(screen.queryByRole('button', { name: /reorder/i })).toBeNull();
  });

  it('COUNTEREXAMPLE: an owner moving between their OWN shows keeps reorder mode', () => {
    // A fix that reset on every re-render would yank the owner out of reorder
    // mode mid-drag and still pass the test above.
    const { rerender } = render(<MixTab {...props({ isOwner: true })} />);

    fireEvent.click(screen.getByRole('button', { name: /reorder/i }));
    rerender(<MixTab {...props({ isOwner: true })} />);

    expect(handles()).toBeGreaterThan(0);
  });

  it('does not call onReorder during a non-owner render', () => {
    const onReorder = vi.fn();
    render(<MixTab {...props({ isOwner: false, onReorder })} />);

    expect(onReorder).not.toHaveBeenCalled();
  });
});
