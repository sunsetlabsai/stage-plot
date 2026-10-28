import { describe, it, expect, vi } from 'vitest';

// ── pdf.js render lock (Codex R3 follow-up, #184) ────────────────────────────
// `extractPageGeometry` swaps `globalThis.Path2D` for the length of a render. Any other
// pdf.js render running across that window builds its glyphs and lines from the recording
// class and paints nothing: the review sheet's strip, rendered at the same moment the
// sheet re-measures the page, came out as blank paper (measured in a real browser,
// 2026-10-27). Renders share; the swap is exclusive.

async function freshLock() {
  vi.resetModules();
  return import('../lib/render-lock');
}
const tick = () => new Promise((r) => setTimeout(r, 0));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('render lock', () => {
  it('★ an exclusive section waits for renders already in flight', async () => {
    const { sharedRender, exclusiveRender } = await freshLock();
    const log: string[] = [];
    const r = deferred();
    const a = sharedRender(async () => { log.push('render start'); await r.promise; log.push('render end'); });
    const b = exclusiveRender(async () => { log.push('swap'); });
    await tick();
    expect(log).toEqual(['render start']);
    r.resolve();
    await Promise.all([a, b]);
    expect(log).toEqual(['render start', 'render end', 'swap']);
  });

  it('★ a render that starts during an exclusive section waits for it to finish', async () => {
    const { sharedRender, exclusiveRender } = await freshLock();
    const log: string[] = [];
    const x = deferred();
    const b = exclusiveRender(async () => { log.push('swap start'); await x.promise; log.push('swap end'); });
    await tick();
    const a = sharedRender(async () => { log.push('render'); });
    await tick();
    expect(log).toEqual(['swap start']);
    x.resolve();
    await Promise.all([a, b]);
    expect(log).toEqual(['swap start', 'swap end', 'render']);
  });

  it('renders run alongside each other', async () => {
    const { sharedRender } = await freshLock();
    const r = deferred();
    let running = 0, peak = 0;
    const one = () => sharedRender(async () => { running++; peak = Math.max(peak, running); await r.promise; running--; });
    const all = Promise.all([one(), one(), one()]);
    await tick();
    r.resolve();
    await all;
    expect(peak).toBe(3);
  });

  it('exclusive sections never overlap each other', async () => {
    const { exclusiveRender } = await freshLock();
    let running = 0, peak = 0;
    const one = () => exclusiveRender(async () => { running++; peak = Math.max(peak, running); await tick(); running--; });
    await Promise.all([one(), one(), one()]);
    expect(peak).toBe(1);
  });

  it('a throw releases the lock and still reaches the caller', async () => {
    const { sharedRender, exclusiveRender } = await freshLock();
    await expect(exclusiveRender(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(sharedRender(async () => { throw new Error('bang'); })).rejects.toThrow('bang');
    await expect(exclusiveRender(async () => 7)).resolves.toBe(7);
    await expect(sharedRender(async () => 8)).resolves.toBe(8);
  });
});
