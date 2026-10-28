// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';

// ── Every pdf.js render site takes the render lock (Codex R3 follow-up, #184) ──
// The lock itself is tested in render-lock.test.ts; this checks it is actually TAKEN —
// a lock that one call site forgets is the bug it exists to stop.

vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: vi.fn() }));

const lock = await import('../lib/render-lock');
const { renderPageOffscreen, renderPage } = await import('../lib/pdf-viewer');
const { extractPageGeometry } = await import('../lib/chart-measure-canvas');

const tick = () => new Promise((r) => setTimeout(r, 0));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
function fakePage(render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }))) {
  return {
    render,
    getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale }),
  };
}
function fakeDoc(page: ReturnType<typeof fakePage>) {
  return { numPages: 1, getPage: vi.fn(async () => page) } as unknown as PDFDocumentProxy;
}

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = (() => ({
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  (globalThis as { Path2D?: unknown }).Path2D ??= class {};
});

describe('render sites hold the lock', () => {
  it('★ the strip raster does not start while the page is being measured', async () => {
    const page = fakePage();
    const held = deferred();
    const x = lock.exclusiveRender(() => held.promise);
    const r = renderPageOffscreen(fakeDoc(page), 1, 2.5);
    await tick();
    expect(page.render).not.toHaveBeenCalled();
    held.resolve();
    await Promise.all([x, r]);
    expect(page.render).toHaveBeenCalledTimes(1);
  });

  it('★ measuring does not swap Path2D while another render is in flight', async () => {
    const native = globalThis.Path2D;
    const inFlight = deferred();
    const r = lock.sharedRender(() => inFlight.promise);
    const page = fakePage();
    const m = extractPageGeometry(page as never, 3);
    await tick();
    expect(page.render).not.toHaveBeenCalled();
    expect(globalThis.Path2D).toBe(native);
    inFlight.resolve();
    await Promise.all([r, m]);
    expect(page.render).toHaveBeenCalledTimes(1);
    expect(globalThis.Path2D).toBe(native); // restored
  });

  it('★ two measurements queued together leave the NATIVE Path2D behind', async () => {
    const native = globalThis.Path2D;
    const first = deferred();
    const pageA = fakePage(vi.fn(() => ({ promise: first.promise, cancel: vi.fn() })));
    const pageB = fakePage();
    const a = extractPageGeometry(pageA as never, 3);
    await tick();
    const b = extractPageGeometry(pageB as never, 3); // queued while A holds the swap
    await tick();
    first.resolve();
    await Promise.all([a, b]);
    expect(globalThis.Path2D).toBe(native);
  });

  it('★ a viewer render queued behind the lock does not paint after a newer one', async () => {
    const container = document.createElement('div');
    const canvas = document.createElement('canvas');
    container.appendChild(canvas);
    const pageA = fakePage();
    const pageB = fakePage();
    const doc = {
      numPages: 2,
      getPage: vi.fn(async (n: number) => (n === 1 ? pageA : pageB)),
    } as unknown as PDFDocumentProxy;
    const held = deferred();
    const x = lock.exclusiveRender(() => held.promise);
    const a = renderPage(doc, 1, canvas);
    await tick();
    const b = renderPage(doc, 2, canvas);
    await tick();
    held.resolve();
    await Promise.all([x, a, b]);
    expect(pageA.render).not.toHaveBeenCalled();
    expect(pageB.render).toHaveBeenCalledTimes(1);
  });
});
