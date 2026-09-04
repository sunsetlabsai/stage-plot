import { describe, it, expect } from 'vitest';
import { buildOverlayStep } from '../lib/chart-upload';

// ── buildOverlayStep ─────────────────────────────────────────────────────────
// The convert-outcome → next-step decision for the owner-demand overlay build.
// Extracted from page.tsx's async tail precisely so the `exists` reasoning is
// pinned here (it was wrong once — see the regression case below).

describe('buildOverlayStep', () => {
  it('a fresh generation refetches', () => {
    expect(buildOverlayStep({ generated: true })).toBe('refetch');
  });

  it('null (transport failure / non-ok HTTP) fails', () => {
    expect(buildOverlayStep(null)).toBe('failed');
  });

  it('every real degrade reason fails', () => {
    for (const reason of ['unsupported_type', 'too_large', 'failed', 'authored', 'lyrics'] as const) {
      expect(buildOverlayStep({ generated: false, reason })).toBe('failed');
    }
  });

  // ★ REGRESSION (PR #169 review). `exists` was read as "the row is for OTHER
  // bytes, so we're on a stale cache" — but the calibration GET 404s at LOAD
  // time and the convert fires later on a click, so anything can insert in
  // between: another tab, the admin backfill, or this client's own previous
  // build whose refetch failed. Treating it as terminal made the error
  // SELF-SUSTAINING — every retry returned `exists` and re-errored while a good
  // overlay for the bytes on screen sat in the DB, escapable only by reloading.
  it('`exists` refetches — it is not a failure, and treating it as one wedged retry', () => {
    expect(buildOverlayStep({ generated: false, reason: 'exists' })).toBe('refetch');
  });

  it('`exists` does NOT weaken hash discipline — it defers, it does not adopt', () => {
    // The step says only "go ask the hash-addressed GET". That GET is keyed on
    // the hash of the bytes THIS client loaded, so a row built for different
    // bytes 404s there and fails correctly. The decision of whether an existing
    // overlay applies is never made here.
    expect(buildOverlayStep({ generated: false, reason: 'exists' })).not.toBe('failed');
    // Same step for both — the caller cannot branch on who inserted the row,
    // which is the point: one authority decides, not two guessing.
    expect(buildOverlayStep({ generated: false, reason: 'exists' })).toBe(
      buildOverlayStep({ generated: true }),
    );
  });
});

// ── B2b: the measured never-gate must degrade SAFELY if a caller forgets it ──
describe('buildOverlayStep — not_notation', () => {
  it('maps to `failed`, never `refetch`', () => {
    // page.tsx handles 'not_notation' explicitly, ahead of this call, and shows the
    // gated line. This asserts the fallback if some future caller does not: a gate means
    // NO row was written, so refetching would 404 and report a load error instead. An
    // unhandled gate must land on the honest dead-stop, not on a phantom fetch.
    expect(buildOverlayStep({ generated: false, reason: 'not_notation' })).toBe('failed');
  });
});
