import { describe, it, expect } from 'vitest';
import {
  CALIBRATION_SCHEMA_VERSION,
  emptyCalibration,
  sectionsInOrder,
  sectionsForPage,
  addSection,
  removeSection,
  relabelSection,
  moveSection,
  canVerify,
  verify,
  isPerformable,
  hashPdfBytes,
} from '../lib/chart-calibration';
import type { ChartCalibration } from '../lib/types';

function cal(over: Partial<ChartCalibration> = {}): ChartCalibration {
  return { ...emptyCalibration(), ...over };
}

describe('emptyCalibration', () => {
  it('is a draft section-chain at the current schema version', () => {
    const c = emptyCalibration();
    expect(c).toEqual({ schemaVersion: CALIBRATION_SCHEMA_VERSION, status: 'draft', sections: [] });
  });
});

describe('addSection', () => {
  it('appends a section with a fresh id and stays draft', () => {
    const c = addSection(emptyCalibration(), 1, 0.5, 0.25, 'Intro');
    expect(c.sections).toHaveLength(1);
    expect(c.sections[0]).toMatchObject({ page: 1, x: 0.5, y: 0.25, label: 'Intro' });
    expect(c.sections[0].id).toMatch(/[0-9a-f-]{36}/);
    expect(c.status).toBe('draft');
  });

  it('defaults a blank label and clamps coords into [0,1]', () => {
    const c = addSection(emptyCalibration(), 2, 1.4, -0.3);
    expect(c.sections[0]).toMatchObject({ x: 1, y: 0, label: '' });
  });

  it('resets a verified calibration back to draft (a change must be re-verified)', () => {
    const v = verify(addSection(emptyCalibration(), 1, 0.1, 0.1, 'A'));
    expect(v.status).toBe('verified');
    expect(addSection(v, 1, 0.2, 0.2, 'B').status).toBe('draft');
  });
});

describe('removeSection / relabelSection / moveSection', () => {
  const base = addSection(addSection(emptyCalibration(), 1, 0.1, 0.1, 'A'), 1, 0.2, 0.2, 'B');
  const idA = base.sections[0].id;

  it('removeSection drops by id and resets to draft', () => {
    const v = verify(base);
    const r = removeSection(v, idA);
    expect(r.sections.map((s) => s.label)).toEqual(['B']);
    expect(r.status).toBe('draft');
  });

  it('removeSection is a no-op (same ref) for an unknown id', () => {
    expect(removeSection(base, 'nope')).toBe(base);
  });

  it('relabelSection updates the label and resets to draft', () => {
    const r = relabelSection(verify(base), idA, 'Verse');
    expect(r.sections[0].label).toBe('Verse');
    expect(r.status).toBe('draft');
  });

  it('moveSection updates clamped coords and resets to draft', () => {
    const r = moveSection(verify(base), idA, 2, -1);
    expect(r.sections[0]).toMatchObject({ x: 1, y: 0 });
    expect(r.status).toBe('draft');
  });

  it('mutators are no-ops (same ref) for an unknown id', () => {
    expect(relabelSection(base, 'nope', 'x')).toBe(base);
    expect(moveSection(base, 'nope', 0.5, 0.5)).toBe(base);
  });
});

describe('sectionsInOrder / sectionsForPage', () => {
  it('orders by page, then y, then x', () => {
    let c = emptyCalibration();
    c = addSection(c, 2, 0.5, 0.1, 'P2-top');
    c = addSection(c, 1, 0.9, 0.8, 'P1-low-right');
    c = addSection(c, 1, 0.1, 0.8, 'P1-low-left');
    c = addSection(c, 1, 0.5, 0.2, 'P1-high');
    expect(sectionsInOrder(c).map((s) => s.label)).toEqual([
      'P1-high', 'P1-low-left', 'P1-low-right', 'P2-top',
    ]);
  });

  it('sectionsForPage filters to one page in top→bottom order', () => {
    let c = emptyCalibration();
    c = addSection(c, 1, 0.5, 0.8, 'low');
    c = addSection(c, 2, 0.5, 0.5, 'other-page');
    c = addSection(c, 1, 0.5, 0.2, 'high');
    expect(sectionsForPage(c, 1).map((s) => s.label)).toEqual(['high', 'low']);
    expect(sectionsForPage(c, 2).map((s) => s.label)).toEqual(['other-page']);
  });
});

describe('canVerify (fail-closed promotion invariant)', () => {
  it('is false for an empty calibration', () => {
    expect(canVerify(emptyCalibration())).toBe(false);
  });

  it('is false when any section has a blank/whitespace label', () => {
    let c = addSection(emptyCalibration(), 1, 0.1, 0.1, 'Intro');
    c = addSection(c, 1, 0.2, 0.2, '   ');
    expect(canVerify(c)).toBe(false);
  });

  it('is true when every section carries a non-blank label', () => {
    let c = addSection(emptyCalibration(), 1, 0.1, 0.1, 'Intro');
    c = addSection(c, 1, 0.2, 0.2, 'Chorus');
    expect(canVerify(c)).toBe(true);
  });
});

describe('verify / isPerformable', () => {
  it('verify promotes only when the invariant holds', () => {
    expect(verify(emptyCalibration()).status).toBe('draft');
    const ok = verify(addSection(emptyCalibration(), 1, 0.1, 0.1, 'A'));
    expect(ok.status).toBe('verified');
  });

  it('verify is a no-op (same ref) on an already-verified calibration', () => {
    const v = verify(addSection(emptyCalibration(), 1, 0.1, 0.1, 'A'));
    expect(verify(v)).toBe(v);
  });

  it('isPerformable gates on verified status', () => {
    const draft = addSection(emptyCalibration(), 1, 0.1, 0.1, 'A');
    expect(isPerformable(draft)).toBe(false);
    expect(isPerformable(verify(draft))).toBe(true);
  });

  it('isPerformable is false for a verified-but-empty calibration', () => {
    // Defensive: status alone never drives Perform without sections.
    expect(isPerformable(cal({ status: 'verified', sections: [] }))).toBe(false);
  });

  it('isPerformable fails closed on a verified payload that breaks the invariant', () => {
    // DB/hand-edited boundary: a 'verified' status carrying a blank-labeled
    // section must NOT drive the redline — re-checks canVerify, not the flag.
    const tampered = cal({
      status: 'verified',
      sections: [{ id: 'a', page: 1, x: 0.1, y: 0.1, label: '  ' }],
    });
    expect(isPerformable(tampered)).toBe(false);
  });
});

describe('hashPdfBytes', () => {
  it('is the sha256 hex of the bytes (stable, known vector)', async () => {
    // sha256("") = e3b0c442...
    const empty = await hashPdfBytes(new Uint8Array(0));
    expect(empty).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('matches between a Uint8Array view and its ArrayBuffer', async () => {
    const bytes = new TextEncoder().encode('chart-pdf-bytes');
    const fromView = await hashPdfBytes(bytes);
    const fromBuffer = await hashPdfBytes(bytes.buffer.slice(0));
    expect(fromView).toBe(fromBuffer);
    expect(fromView).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different content', async () => {
    const a = await hashPdfBytes(new TextEncoder().encode('a'));
    const b = await hashPdfBytes(new TextEncoder().encode('b'));
    expect(a).not.toBe(b);
  });
});
