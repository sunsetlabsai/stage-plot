// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import ManageChartsModal from '../components/ManageChartsModal';
import type { Chart } from '../lib/types';

// Chart export (reuse the show-mode Share). ManageChartsModal is the editor
// "summary" surface: every chart row gets a Share, and the preview pane (detail)
// gets one for the selected chart. Share is a READ affordance like Preview — it
// is NOT owner-gated, so a view-only collaborator can still share a chart out.
// ShareButton's own behavior (tiers, navigator.share) is covered by
// share-button.test.tsx; here we only pin placement + the non-gating.

const CHARTS: Chart[] = [
  { role: 'Guitar', url: 'https://x/storage/v1/object/public/charts/u/song/guitar/h.pdf', fileId: 'g1', mimeType: 'application/pdf', label: 'song-guitar.pdf' },
  { role: 'Bass', url: 'https://x/storage/v1/object/public/charts/u/song/bass/h.pdf', fileId: 'b1', mimeType: 'application/pdf', label: 'song-bass.pdf' },
];

function renderModal(isOwner: boolean) {
  render(
    <ManageChartsModal
      songTitle="9 to 5"
      charts={CHARTS}
      isOwner={isOwner}
      onClose={vi.fn()}
      onChartsChanged={vi.fn()}
    />,
  );
}

afterEach(cleanup);

describe('ManageChartsModal — Share on every chart (summary + detail)', () => {
  it('renders one Share on each chart row', () => {
    renderModal(true);
    // No preview selected yet → exactly one Share per row, none from the pane.
    expect(screen.getAllByRole('button', { name: 'Share' })).toHaveLength(CHARTS.length);
  });

  it('offers Share to a non-owner too — it is a read affordance, not owner-gated', () => {
    renderModal(false);
    // Edit/Replace/Delete are gone for a viewer; Share and Preview remain.
    expect(screen.getAllByRole('button', { name: 'Share' })).toHaveLength(CHARTS.length);
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('adds a Share in the preview pane when a chart is selected (detail)', () => {
    renderModal(true);
    // Selecting a chart mounts the preview pane, which carries its own Share →
    // row Shares (2) + pane Share (1).
    fireEvent.click(screen.getAllByRole('button', { name: 'Preview' })[0]);
    expect(screen.getAllByRole('button', { name: 'Share' })).toHaveLength(CHARTS.length + 1);
  });
});
