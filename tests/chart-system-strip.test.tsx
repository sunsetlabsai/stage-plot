// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { System } from '../lib/types';

// ── The strip's page raster is SHARED (chunk C3) ─────────────────────────────
//
// A sheet with three candidates mounts four strips of the same page: the full-size one
// plus a mini per option. Rasterizing that page four times on a phone, while the owner
// waits, is the cost the H2 fix would otherwise have added — so the claim in
// `ChartSystemStrip` that they share ONE render is checked here rather than asserted in
// a comment.
//
// jsdom has no Canvas2D, so `getContext('2d')` returns null and the draw is a no-op. That
// is fine: what this file is about is how many rasters get requested, which happens
// before any drawing.

const renderPageOffscreen = vi.fn();
vi.mock('../lib/pdf-viewer', () => ({
  renderPageOffscreen: (...args: unknown[]) => renderPageOffscreen(...args),
}));

const { ChartSystemStrip } = await import('../components/ChartSystemStrip');

function fakeRaster() {
  return { width: 1000, height: 1400 } as unknown as HTMLCanvasElement;
}

function doc(): PDFDocumentProxy {
  return { numPages: 3 } as unknown as PDFDocumentProxy;
}

function system(over: Partial<System> = {}): System {
  return {
    id: 'sysA', page: 2, yTop: 0.1, yBottom: 0.2, xStart: 0.05, xEnd: 0.95,
    verdict: 'validated', ...over,
  };
}

beforeEach(() => {
  renderPageOffscreen.mockReset();
  renderPageOffscreen.mockResolvedValue(fakeRaster());
  // jsdom logs a "not implemented" for every getContext call. Return null explicitly —
  // which is the branch the component already handles — so the run stays readable.
  HTMLCanvasElement.prototype.getContext = () => null;
});
afterEach(cleanup);

describe('ChartSystemStrip — the shared page raster', () => {
  it('★ four strips of one page cost ONE render, not four', async () => {
    const d = doc();
    const s = system();
    render(
      <>
        <ChartSystemStrip doc={d} system={s} xs={[0.5, 0.95]} />
        <ChartSystemStrip doc={d} system={s} xs={[0.5, 0.95]} variant="mini" />
        <ChartSystemStrip doc={d} system={s} xs={[0.3, 0.6, 0.95]} variant="mini" />
        <ChartSystemStrip doc={d} system={s} xs={null} variant="mini" />
      </>,
    );
    await waitFor(() => expect(renderPageOffscreen).toHaveBeenCalled());
    expect(renderPageOffscreen).toHaveBeenCalledTimes(1);
    expect(renderPageOffscreen.mock.calls[0][1]).toBe(2); // the SYSTEM's page, not the viewer's
  });

  it('a different page re-renders — the cache holds one page, not a page history', async () => {
    const d = doc();
    render(<ChartSystemStrip doc={d} system={system({ page: 2 })} xs={null} />);
    await waitFor(() => expect(renderPageOffscreen).toHaveBeenCalledTimes(1));
    cleanup();
    render(<ChartSystemStrip doc={d} system={system({ page: 3 })} xs={null} />);
    await waitFor(() => expect(renderPageOffscreen).toHaveBeenCalledTimes(2));
    expect(renderPageOffscreen.mock.calls[1][1]).toBe(3);
  });

  it('a rejecting render never escapes as an unhandled rejection', async () => {
    // `renderPageOffscreen` resolves null on failure by contract, but the shared promise
    // is awaited by every strip on screen — so a rejection would be handled by whichever
    // awaited first and go unhandled for the rest. Belt on top of the source fix.
    renderPageOffscreen.mockRejectedValue(new Error('worker destroyed'));
    const d = doc();
    const s = system();
    render(
      <>
        <ChartSystemStrip doc={d} system={s} xs={null} />
        <ChartSystemStrip doc={d} system={s} xs={null} variant="mini" />
      </>,
    );
    await waitFor(() => expect(renderPageOffscreen).toHaveBeenCalledTimes(1));
    // Give the shared promise a turn to settle; an unhandled rejection fails the run.
    await new Promise((r) => setTimeout(r, 0));
  });
});
