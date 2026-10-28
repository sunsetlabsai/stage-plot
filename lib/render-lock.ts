// ── pdf.js render lock ───────────────────────────────────────────────────────
//
// `extractPageGeometry` (lib/chart-measure-canvas.ts) swaps `globalThis.Path2D` for a
// recording class for the length of one render — that swap is load-bearing and must stay.
// Any OTHER pdf.js render running across that window builds its glyphs and lines from the
// recording class and paints nothing. Measured in a real browser (2026-10-27): the review
// sheet re-measures a page at the moment its strip rasterizes the same page, and every
// strip came out as blank paper with the split drawn over it.
//
// So: ordinary renders SHARE the lock and run alongside each other; the swap holds it
// EXCLUSIVELY, after in-flight renders finish and before any new one starts. Exclusive
// sections run one at a time, in order; once one holds the lock, new renders wait.

let readers = 0;
let drained: (() => void) | null = null;
/** Settles when the current exclusive holder (and every one queued before it) is done. */
let writerTail: Promise<void> = Promise.resolve();
let writerActive = false;

/** Run an ordinary pdf.js render. Waits out any exclusive section, then runs alongside other renders. */
export async function sharedRender<T>(fn: () => Promise<T>): Promise<T> {
  while (writerActive) await writerTail;
  readers++;
  try {
    return await fn();
  } finally {
    readers--;
    if (readers === 0 && drained) {
      const d = drained;
      drained = null;
      d();
    }
  }
}

/** Run with no other pdf.js render in flight — for the `Path2D` swap. */
export async function exclusiveRender<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const prev = writerTail;
  writerTail = prev.then(() => gate);
  await prev;
  writerActive = true;
  try {
    if (readers > 0) await new Promise<void>((r) => (drained = r));
    return await fn();
  } finally {
    writerActive = false;
    release();
  }
}
