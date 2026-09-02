import { describe, it, expect } from 'vitest';
import {
  LINEAR_SCHEMA_VERSION,
  MAX_PDF_BYTES,
  buildCalibrationFromVision,
  overlaySkipReason,
  schemaVersionToPersist,
  sniffPdf,
  type VisionChart,
} from '../lib/chart-converter';
import { CALIBRATION_SCHEMA_VERSION, isValidCalibration } from '../lib/chart-calibration';
import type { RoadmapMarker } from '../lib/types';

// A complete, valid vision payload (one page, one system, two bars).
function baseVision(): VisionChart {
  return {
    systems: [{ page: 1, yTop: 0.1, yBottom: 0.2, xStart: 0, xEnd: 1, confidence: 0.9 }],
    bars: [
      { systemIndex: 0, xStart: 0, xEnd: 0.5, confidence: 0.8 },
      { systemIndex: 0, xStart: 0.5, xEnd: 1 },
    ],
    sections: [{ page: 1, x: 0.05, y: 0.1, label: 'Verse', confidence: 0.7 }],
  };
}

describe('sniffPdf', () => {
  it('accepts the %PDF- magic bytes', () => {
    expect(sniffPdf(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]))).toBe(true);
  });

  it('rejects non-PDF leading bytes', () => {
    // PNG signature
    expect(sniffPdf(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe(false);
  });

  it('rejects a buffer shorter than the signature', () => {
    expect(sniffPdf(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBe(false);
  });

  it('exposes a positive byte cap', () => {
    expect(MAX_PDF_BYTES).toBeGreaterThan(0);
  });
});

describe('buildCalibrationFromVision — structure', () => {
  it('maps a valid payload to a draft calibration that passes the DB gate', () => {
    const cal = buildCalibrationFromVision(baseVision());
    expect(cal).not.toBeNull();
    expect(cal!.status).toBe('draft');
    expect(isValidCalibration(cal!)).toBe(true);
    expect(cal!.sections).toHaveLength(1);
    expect(cal!.systems).toHaveLength(1);
    expect(cal!.bars).toHaveLength(2);
  });

  it('carries finite confidences and drops out-of-range/absent ones', () => {
    const v = baseVision();
    v.systems[0].confidence = 1.5; // out of range → dropped
    const cal = buildCalibrationFromVision(v)!;
    expect(cal.systems![0].confidence).toBeUndefined();
    expect(cal.bars![0].confidence).toBe(0.8);
    expect(cal.bars![1].confidence).toBeUndefined();
    expect(cal.sections[0].confidence).toBe(0.7);
  });

  it('returns null when nothing usable is extracted', () => {
    expect(buildCalibrationFromVision({ systems: [], bars: [], sections: [] })).toBeNull();
  });

  it('sections alone (no systems) still yields a calibration', () => {
    const cal = buildCalibrationFromVision({
      systems: [],
      bars: [],
      sections: [{ page: 1, x: 0.1, y: 0.1, label: 'Intro' }],
    });
    expect(cal).not.toBeNull();
    expect(cal!.systems).toHaveLength(0);
    expect(cal!.sections).toHaveLength(1);
  });
});

describe('buildCalibrationFromVision — reading order', () => {
  it('orders systems by (page, yTop, xStart) and reassigns ids', () => {
    const cal = buildCalibrationFromVision({
      systems: [
        { page: 2, yTop: 0.1, yBottom: 0.2, xStart: 0, xEnd: 1 },
        { page: 1, yTop: 0.5, yBottom: 0.6, xStart: 0, xEnd: 1 },
        { page: 1, yTop: 0.1, yBottom: 0.2, xStart: 0, xEnd: 1 },
      ],
      bars: [],
      sections: [],
    })!;
    expect(cal.systems!.map((s) => [s.page, s.yTop])).toEqual([
      [1, 0.1],
      [1, 0.5],
      [2, 0.1],
    ]);
    expect(cal.systems!.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
  });

  it('numbers bars globally in reading order with absNumber = index + 1', () => {
    // Two systems out of order; bars reference them by ORIGINAL model index.
    const cal = buildCalibrationFromVision({
      systems: [
        { page: 1, yTop: 0.5, yBottom: 0.6, xStart: 0, xEnd: 1 }, // becomes s2
        { page: 1, yTop: 0.1, yBottom: 0.2, xStart: 0, xEnd: 1 }, // becomes s1
      ],
      bars: [
        { systemIndex: 0, xStart: 0, xEnd: 0.5 }, // in the lower (later) system
        { systemIndex: 1, xStart: 0.5, xEnd: 1 }, // in the upper (earlier) system
        { systemIndex: 1, xStart: 0, xEnd: 0.5 }, // upper system, first bar
      ],
      sections: [],
    })!;
    // Upper system (s1) bars come first, ordered by xStart, then lower (s2).
    expect(cal.bars!.map((b) => [b.systemId, b.xStart, b.absNumber])).toEqual([
      ['s1', 0, 1],
      ['s1', 0.5, 2],
      ['s2', 0, 3],
    ]);
  });
});

describe('buildCalibrationFromVision — bar binding', () => {
  it('drops a bar whose systemIndex points at no surviving system', () => {
    const cal = buildCalibrationFromVision({
      systems: [{ page: 1, yTop: 0.1, yBottom: 0.2, xStart: 0, xEnd: 1 }],
      bars: [{ systemIndex: 5, xStart: 0, xEnd: 0.5 }],
      sections: [],
    })!;
    expect(cal.bars).toHaveLength(0);
  });

  it('clamps a bar to its parent system x-bounds', () => {
    const cal = buildCalibrationFromVision({
      systems: [{ page: 1, yTop: 0.1, yBottom: 0.2, xStart: 0.2, xEnd: 0.8 }],
      bars: [{ systemIndex: 0, xStart: 0, xEnd: 1 }],
      sections: [],
    })!;
    expect(cal.bars![0].xStart).toBe(0.2);
    expect(cal.bars![0].xEnd).toBe(0.8);
  });

  it('drops a degenerate (zero/negative width) system or bar', () => {
    const cal = buildCalibrationFromVision({
      systems: [
        { page: 1, yTop: 0.1, yBottom: 0.1, xStart: 0, xEnd: 1 }, // zero height → dropped
        { page: 1, yTop: 0.2, yBottom: 0.3, xStart: 0, xEnd: 1 }, // kept
      ],
      bars: [{ systemIndex: 1, xStart: 0.6, xEnd: 0.6 }], // zero width → dropped
      sections: [],
    })!;
    expect(cal.systems).toHaveLength(1);
    expect(cal.bars).toHaveLength(0);
  });
});

describe('buildCalibrationFromVision — roadmap binding', () => {
  // Helper: one system, four bars, plus the given roadmap markers.
  function withRoadmap(roadmap: VisionChart['roadmap']): VisionChart {
    return {
      systems: [{ page: 1, yTop: 0.1, yBottom: 0.2, xStart: 0, xEnd: 1 }],
      bars: [
        { systemIndex: 0, xStart: 0, xEnd: 0.25 },
        { systemIndex: 0, xStart: 0.25, xEnd: 0.5 },
        { systemIndex: 0, xStart: 0.5, xEnd: 0.75 },
        { systemIndex: 0, xStart: 0.75, xEnd: 1 },
      ],
      sections: [],
      roadmap,
    };
  }

  function kinds(roadmap: RoadmapMarker[]): string[] {
    return roadmap.map((m) => m.kind);
  }

  it('binds a repeatEnd to its repeatStart', () => {
    const cal = buildCalibrationFromVision(
      withRoadmap([
        { kind: 'repeatStart', barIndex: 0 },
        { kind: 'repeatEnd', barIndex: 3, repeatStartBarIndex: 0, times: 2 },
      ]),
    )!;
    expect(cal.roadmap).toBeDefined();
    const start = cal.roadmap!.find((m) => m.kind === 'repeatStart')!;
    const end = cal.roadmap!.find((m) => m.kind === 'repeatEnd');
    expect(end).toBeDefined();
    if (end && end.kind === 'repeatEnd') {
      expect(end.repeatStartId).toBe(start.id);
      expect(end.times).toBe(2);
    }
    expect(isValidCalibration(cal)).toBe(true);
  });

  it('drops a repeatEnd whose repeatStart is missing (structurally unbindable)', () => {
    const cal = buildCalibrationFromVision(
      withRoadmap([{ kind: 'repeatEnd', barIndex: 3, repeatStartBarIndex: 0 }]),
    )!;
    expect(cal.roadmap ?? []).toHaveLength(0);
  });

  it('binds an ending bracket with barIds + numbers', () => {
    const cal = buildCalibrationFromVision(
      withRoadmap([
        { kind: 'repeatStart', barIndex: 0 },
        { kind: 'ending', repeatStartBarIndex: 0, barIndices: [2, 3], numbers: [1] },
      ]),
    )!;
    const ending = cal.roadmap!.find((m) => m.kind === 'ending');
    expect(ending).toBeDefined();
    if (ending && ending.kind === 'ending') {
      expect(ending.barIds).toHaveLength(2);
      expect(ending.numbers).toEqual([1]);
    }
  });

  it('drops an ending with empty barIds or numbers', () => {
    const cal = buildCalibrationFromVision(
      withRoadmap([
        { kind: 'repeatStart', barIndex: 0 },
        { kind: 'ending', repeatStartBarIndex: 0, barIndices: [], numbers: [1] },
      ]),
    )!;
    expect(cal.roadmap!.some((m) => m.kind === 'ending')).toBe(false);
  });

  it('DROPS (never narrows) an ending with a partially-unresolvable barIndices', () => {
    // bar index 99 does not exist; the whole ending must be rejected, not
    // silently shrunk into a one-bar ending over bar 2.
    const cal = buildCalibrationFromVision(
      withRoadmap([
        { kind: 'repeatStart', barIndex: 0 },
        { kind: 'ending', repeatStartBarIndex: 0, barIndices: [2, 99], numbers: [1] },
      ]),
    )!;
    expect(cal.roadmap!.some((m) => m.kind === 'ending')).toBe(false);
  });

  it('DROPS (never narrows) an ending with a partially-invalid numbers list', () => {
    // 0 is not a valid volta number; rejecting the marker avoids mutating which
    // pass it plays on ([1,0] must not become [1]).
    const cal = buildCalibrationFromVision(
      withRoadmap([
        { kind: 'repeatStart', barIndex: 0 },
        { kind: 'ending', repeatStartBarIndex: 0, barIndices: [2, 3], numbers: [1, 0] },
      ]),
    )!;
    expect(cal.roadmap!.some((m) => m.kind === 'ending')).toBe(false);
  });

  it('binds segno/coda/toCoda/fine to their bars', () => {
    const cal = buildCalibrationFromVision(
      withRoadmap([
        { kind: 'segno', barIndex: 0 },
        { kind: 'coda', barIndex: 3 },
        { kind: 'toCoda', barIndex: 1 },
        { kind: 'fine', barIndex: 2 },
      ]),
    )!;
    expect(kinds(cal.roadmap!).sort()).toEqual(['coda', 'fine', 'segno', 'toCoda']);
  });

  it('binds a valid D.S. al Coda jump and drops a malformed one', () => {
    const cal = buildCalibrationFromVision(
      withRoadmap([
        { kind: 'jump', barIndex: 3, from: 'segno', until: 'coda' },
        { kind: 'jump', barIndex: 2, from: 'bogus', until: 'coda' }, // bad from → dropped
      ]),
    )!;
    const jumps = cal.roadmap!.filter((m) => m.kind === 'jump');
    expect(jumps).toHaveLength(1);
    if (jumps[0].kind === 'jump') {
      expect(jumps[0].from).toBe('segno');
      expect(jumps[0].until).toBe('coda');
    }
  });

  it('drops an unknown marker kind', () => {
    const cal = buildCalibrationFromVision(
      withRoadmap([{ kind: 'mystery', barIndex: 0 }]),
    )!;
    expect(cal.roadmap ?? []).toHaveLength(0);
  });
});

describe('buildCalibrationFromVision — defensive input', () => {
  it('tolerates non-object / missing arrays', () => {
    // @ts-expect-error — exercising a non-object payload
    expect(buildCalibrationFromVision(null)).toBeNull();
    // @ts-expect-error — exercising a partial payload (missing arrays)
    expect(buildCalibrationFromVision({})).toBeNull();
  });

  it('skips a null / non-positive-page system entry', () => {
    const cal = buildCalibrationFromVision({
      // @ts-expect-error — exercising malformed entries the mapper must skip
      systems: [null, { page: 0, yTop: 0.1, yBottom: 0.2, xStart: 0, xEnd: 1 }],
      bars: [],
      sections: [{ page: 1, x: 0.1, y: 0.1, label: 'Intro' }],
    });
    expect(cal).not.toBeNull();
    expect(cal!.systems).toHaveLength(0);
  });

  it('skips a section missing a string label', () => {
    const cal = buildCalibrationFromVision({
      systems: [],
      bars: [],
      // @ts-expect-error — first section is missing a string label
      sections: [{ page: 1, x: 0.1, y: 0.1 }, { page: 1, x: 0.2, y: 0.2, label: 'Chorus' }],
    });
    expect(cal).not.toBeNull();
    expect(cal!.sections).toHaveLength(1);
    expect(cal!.sections[0].label).toBe('Chorus');
  });
});

describe('schemaVersionToPersist', () => {
  it('stamps a roadmap-bearing calibration at the current schema version', () => {
    const v = baseVision();
    v.roadmap = [{ kind: 'segno', barIndex: 0 }];
    const cal = buildCalibrationFromVision(v)!;
    expect(cal.roadmap && cal.roadmap.length).toBeGreaterThan(0);
    expect(schemaVersionToPersist(cal)).toBe(CALIBRATION_SCHEMA_VERSION);
  });

  it('stamps a no-roadmap calibration at the rollback-safe linear version', () => {
    const cal = buildCalibrationFromVision(baseVision())!;
    expect(cal.roadmap).toBeUndefined();
    expect(schemaVersionToPersist(cal)).toBe(LINEAR_SCHEMA_VERSION);
    expect(LINEAR_SCHEMA_VERSION).toBeLessThan(CALIBRATION_SCHEMA_VERSION);
  });
});

// ── Known-never gates (backlog-charting.md §Ruled 2026-09-02) ────────────────
// The predicate the "Build overlay" CTA and /api/charts/convert BOTH consult, so
// these cases pin the one rule rather than either call site's copy of it.
describe('overlaySkipReason', () => {
  it('a plain uploaded chart is convertible', () => {
    expect(overlaySkipReason({ role: 'guitar', hasSourceSpec: false })).toBeNull();
  });

  it('a builder chart is `authored` — the spec is already ground truth', () => {
    expect(overlaySkipReason({ role: 'guitar', hasSourceSpec: true })).toBe('authored');
  });

  it('a lyrics sheet is `lyrics` — no staves to measure', () => {
    expect(overlaySkipReason({ role: 'lyrics', hasSourceSpec: false })).toBe('lyrics');
  });

  it('role is CANONICALIZED, not compared raw — role is free text on the row', () => {
    // The live library holds "Lyrics" (folder-cased). A raw === would let every
    // one of those 342 sheets through the gate.
    for (const role of ['Lyrics', 'LYRICS', ' lyrics ', 'LyRiCs']) {
      expect(overlaySkipReason({ role, hasSourceSpec: false })).toBe('lyrics');
    }
  });

  it('`authored` wins over `lyrics` — it holds whatever the role says', () => {
    expect(overlaySkipReason({ role: 'Lyrics', hasSourceSpec: true })).toBe('authored');
  });

  it('an unrecognized role canonicalizes to `other` and stays convertible', () => {
    // 'trombone' → 'other'. Only the lyrics gate is a never; unknown is not.
    expect(overlaySkipReason({ role: 'trombone', hasSourceSpec: false })).toBeNull();
    expect(overlaySkipReason({ role: '', hasSourceSpec: false })).toBeNull();
  });
});
