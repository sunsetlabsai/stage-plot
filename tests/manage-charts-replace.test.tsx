// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { Chart } from '../lib/types';

// ── Replace warns before it drops an overlay (uat-plan-v1 §2.4) ──────────────
// An overlay is keyed to the exact bytes it was built on (chart_id + source_hash), so
// replacing the file silently orphaned it. Replace now asks first — only when the chart
// actually HAS an overlay for its current file, so a chart without one is not nagged.

const loadPdfDoc = vi.fn();
const fetchChartBytes = vi.fn();
const renderPage = vi.fn();
vi.mock('../lib/pdf-viewer', () => ({
  loadPdfDoc: (...a: unknown[]) => loadPdfDoc(...a),
  renderPage: (...a: unknown[]) => renderPage(...a),
  fetchChartBytes: (...a: unknown[]) => fetchChartBytes(...a),
}));
const BYTES = new Uint8Array([37, 80, 68, 70]).buffer; // "%PDF"
const { hashPdfBytes } = await import('../lib/chart-calibration');
const { default: ManageChartsModal } = await import('../components/ManageChartsModal');
const { chartHasOverlay } = await import('../lib/chart-overlay-status');

const CHART: Chart = {
  role: 'Guitar', url: 'https://x/storage/v1/object/public/charts/u/s/g.pdf',
  fileId: '11111111-1111-4111-8111-111111111111', mimeType: 'application/pdf', label: 'g.pdf',
};
const HASH = await hashPdfBytes(BYTES);

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  loadPdfDoc.mockReset();
  loadPdfDoc.mockResolvedValue({ doc: { numPages: 1 }, sourceHash: HASH });
  fetchChartBytes.mockReset();
  fetchChartBytes.mockResolvedValue(BYTES);
  renderPage.mockReset();
  renderPage.mockResolvedValue(undefined);
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
  it('★ hashes the BYTES — never opens a PDF document (Codex R1: that filled the doc cache)', async () => {
    await chartHasOverlay(CHART);
    expect(fetchChartBytes).toHaveBeenCalled();
    expect(loadPdfDoc).not.toHaveBeenCalled();
  });
  it('unknown (unreadable file, failed request) is null, never a guess', async () => {
    fetchChartBytes.mockResolvedValue(null);
    expect(await chartHasOverlay(CHART)).toBe(null);
    fetchChartBytes.mockResolvedValue(BYTES);
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

  it('★ while the check is still running, Replace is held — it cannot skip the warning', async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => { resolve = r; }));
    const picker = filePickerClicks();
    renderModal();
    const btn = await screen.findByRole('button', { name: /Checking/ });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(btn);
    expect(picker).not.toHaveBeenCalled();
    resolve(new Response('{}', { status: 404 }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Replace' })).toBeTruthy());
  });

  it('★ a check that FAILED still warns — unknown is treated as "may have one"', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const picker = filePickerClicks();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderModal();
    const btn = await screen.findByRole('button', { name: 'Replace' });
    fireEvent.click(btn);
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/may have/i));
    expect(picker).not.toHaveBeenCalled();
  });
});

describe('ManageChartsModal — a new version of a chart is unchecked (Codex R2, #203)', () => {
  it('★ after the file changes, Replace is held again until THAT version is checked', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 404 })); // v1: no overlay
    const picker = filePickerClicks();
    const props = { songTitle: 'S', isOwner: true, onClose: vi.fn(), onChartsChanged: vi.fn() };
    const v1 = { ...CHART, modifiedTime: '2026-10-27T10:00:00.000Z' };
    const { rerender } = render(<ManageChartsModal {...props} charts={[v1]} />);
    await screen.findByRole('button', { name: 'Replace' });
    // The owner re-uploads the original file — its old overlay is live again by hash.
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => { resolve = r; }));
    const v2 = { ...CHART, modifiedTime: '2026-10-27T10:05:00.000Z' };
    rerender(<ManageChartsModal {...props} charts={[v2]} />);
    const btn = await screen.findByRole('button', { name: /Checking/ });
    fireEvent.click(btn);
    expect(picker).not.toHaveBeenCalled();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    resolve(new Response('{}', { status: 200 }));
    fireEvent.click(await screen.findByRole('button', { name: 'Replace' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/removes this chart's bar overlay/));
    expect(picker).not.toHaveBeenCalled();
  });
});

describe('ChartPreview — a page that fails to render', () => {
  it('★ says it could not load, rather than leaving an unhandled rejection', async () => {
    renderPage.mockRejectedValue(new Error('Transport destroyed'));
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByText('Could not load preview.');
  });
});
