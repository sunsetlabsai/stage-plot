// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { Chart } from '../lib/types';

// ── Replace warns before it drops an overlay (uat-plan-v1 §2.4) ──────────────
// An overlay is keyed to the exact bytes it was built on (chart_id + source_hash), so
// replacing the file silently orphaned it. Replace now asks first — only when the chart
// actually HAS an overlay for its current file, so a chart without one is not nagged.

const loadPdfDoc = vi.fn();
vi.mock('../lib/pdf-viewer', () => ({
  loadPdfDoc: (...a: unknown[]) => loadPdfDoc(...a),
  renderPage: vi.fn(),
  fetchChartBytes: vi.fn(async () => null),
}));
const { default: ManageChartsModal } = await import('../components/ManageChartsModal');
const { chartHasOverlay } = await import('../lib/chart-overlay-status');

const CHART: Chart = {
  role: 'Guitar', url: 'https://x/storage/v1/object/public/charts/u/s/g.pdf',
  fileId: '11111111-1111-4111-8111-111111111111', mimeType: 'application/pdf', label: 'g.pdf',
};
const HASH = 'a'.repeat(64);

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  loadPdfDoc.mockReset();
  loadPdfDoc.mockResolvedValue({ doc: {}, sourceHash: HASH });
  fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('chartHasOverlay', () => {
  it('asks the calibration door for THIS file\'s bytes', async () => {
    expect(await chartHasOverlay(CHART)).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`/api/charts/calibration?chart_id=${CHART.fileId}&hash=${HASH}`);
  });
  it('a 404 means no overlay', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 404 }));
    expect(await chartHasOverlay(CHART)).toBe(false);
  });
  it('unknown (unreadable file, failed request) is null, never a guess', async () => {
    loadPdfDoc.mockResolvedValue(null);
    expect(await chartHasOverlay(CHART)).toBe(null);
    loadPdfDoc.mockResolvedValue({ doc: {}, sourceHash: HASH });
    fetchMock.mockRejectedValue(new Error('offline'));
    expect(await chartHasOverlay(CHART)).toBe(null);
    fetchMock.mockResolvedValue(new Response('{}', { status: 500 }));
    expect(await chartHasOverlay(CHART)).toBe(null);
  });
});

function renderModal() {
  render(
    <ManageChartsModal songTitle="S" charts={[CHART]} isOwner onClose={vi.fn()} onChartsChanged={vi.fn()} />,
  );
}
const filePickerClicks = () => {
  const spy = vi.fn();
  HTMLInputElement.prototype.click = spy;
  return spy;
};

describe('ManageChartsModal — Replace', () => {
  it('★ a chart WITH an overlay asks first; Cancel opens no file picker', async () => {
    const picker = filePickerClicks();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderModal();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/overlay/i));
    expect(picker).not.toHaveBeenCalled();
  });

  it('confirming goes on to the file picker', async () => {
    const picker = filePickerClicks();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderModal();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    expect(picker).toHaveBeenCalled();
  });

  it('a chart with NO overlay replaces without asking', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 404 }));
    const picker = filePickerClicks();
    const confirm = vi.spyOn(window, 'confirm');
    renderModal();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    expect(confirm).not.toHaveBeenCalled();
    expect(picker).toHaveBeenCalled();
  });
});
