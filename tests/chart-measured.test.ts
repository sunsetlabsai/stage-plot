import { describe, it, expect } from 'vitest';
import {
  isGeometryComplete,
  type MeasuredSystem,
  type PageMeasurement,
  type ProvisionalVerdict,
} from '../lib/chart-measure';
import {
  buildMeasuredPayload,
  installMeasured,
  isValidMeasuredPayload,
  measuredDisposition,
  type MeasuredPageResult,
  type MeasuredPayload,
} from '../lib/chart-measured';
import { CHART_VERDICTS, isValidCalibration, barsInOrder } from '../lib/chart-calibration';

// ── B2b: the client↔server measured contract ─────────────────────────────────
//
// Two rules govern every assertion in this file, and both exist because the same
// mistake has now been made five times on this subsystem:
//
//   1. The ASSERTION MUST BE THE SAME SHAPE AS THE PREDICATE. Completeness and
//      classification are PER PAGE, so every test that means to exercise them varies
//      pages against each other rather than folding them into a total first.
//   2. A test that cannot fail is not a test. Each gate below has a NEGATIVE CONTROL —
//      the neighbouring input that must NOT produce the same answer.

const PAGE = { W: 612, H: 792 };

function sys(over: Partial<MeasuredSystem> = {}): MeasuredSystem {
  return {
    yTop: 100,
    yBot: 140,
    x0: 61.2, // 0.1 of width
    x1: 550.8, // 0.9 of width
    barlines: [],
    spans: 2,
    bars: [
      { xStart: 61.2, xEnd: 306 },
      { xStart: 306, xEnd: 550.8 },
    ],
    printedNumber: 1,
    multirests: [],
    expectedSpans: 2,
    verdict: 'validated',
    ...over,
  };
}

function page(over: Partial<PageMeasurement> = {}): PageMeasurement {
  return {
    pageNumber: 1,
    pageWidth: PAGE.W,
    pageHeight: PAGE.H,
    classification: 'notation',
    staffCount: 1,
    systems: [sys()],
    ...over,
  };
}

const complete = (m: PageMeasurement): MeasuredPageResult => ({ measurement: m, complete: true });

// ── The geometry-completeness precondition (per PAGE) ────────────────────────

describe('isGeometryComplete — the never-gate safety rule', () => {
  it('accepts the shape every clean corpus page has: one background fillRect, text, clip, wash', () => {
    // Σ opaque is 4 here and NON-ZERO on 87 of 87 corpus files. Gating on the aggregate
    // would disable the never-gate entirely — the categories are the point.
    expect(
      isGeometryComplete({ warnings: [], opaque: { fillRect: 1, fillText: 220, clip: 9, wash: 1 } }),
    ).toBe(true);
  });

  it('refuses when the shim saw paint it could not observe', () => {
    for (const w of ['stroke-without-path', 'fill-without-path', 'no-2d-context']) {
      expect(isGeometryComplete({ warnings: [w], opaque: { fillRect: 1 } })).toBe(false);
    }
  });

  it('★ NEGATIVE CONTROL — anisotropic-ctm is a PRECISION caveat and must NOT open the gate', () => {
    // B1's blanket "any warning means INCOMPLETE" is what this corrects. Measured: 4
    // corpus files carry this warning and validate 53/53 systems between them; treating
    // it as incomplete would route clean charts to the VLM for no reason.
    expect(isGeometryComplete({ warnings: ['anisotropic-ctm'], opaque: { fillRect: 1 } })).toBe(true);
  });

  it('refuses on any pixel-carrying op — each one alone', () => {
    for (const op of ['drawImage', 'putImageData', 'createPattern', 'strokeRect']) {
      expect(isGeometryComplete({ warnings: [], opaque: { fillRect: 1, [op]: 1 } })).toBe(false);
    }
  });

  it('★ fillRect is BOUNDED, not excluded: 0 and 1 pass, 2 fails', () => {
    // 0 passing is deliberate and is the acknowledged fail-OPEN direction — no
    // count-based clause can close it, which is why the harness ASSERTS ===1 per page
    // every run instead of reasoning about it here.
    expect(isGeometryComplete({ warnings: [], opaque: {} })).toBe(true);
    expect(isGeometryComplete({ warnings: [], opaque: { fillRect: 1 } })).toBe(true);
    expect(isGeometryComplete({ warnings: [], opaque: { fillRect: 2 } })).toBe(false);
  });
});

// ── The per-page fold ────────────────────────────────────────────────────────

function reports(...pages: { classification: 'notation' | 'not-notation' | 'raster'; complete: boolean }[]): MeasuredPayload {
  return {
    pages: pages.map((p, i) => ({ pageNumber: i + 1, ...p })),
    systems: [{ id: 's1', page: 1, yTop: 0.1, yBottom: 0.2, xStart: 0.1, xEnd: 0.9 }],
    bars: [],
  };
}

describe('measuredDisposition — gate on evidence of ABSENCE', () => {
  it('gates a chart whose every page is not-notation in fully observed geometry', () => {
    expect(measuredDisposition(reports(
      { classification: 'not-notation', complete: true },
      { classification: 'not-notation', complete: true },
    ))).toBe('gated');
  });

  it('★ NEGATIVE CONTROL — one incomplete page is enough to withhold the gate', () => {
    // Absence of EVIDENCE. The gate is unappealable, so a page we could not fully
    // observe must route to the VLM, never refuse the chart forever.
    expect(measuredDisposition(reports(
      { classification: 'not-notation', complete: true },
      { classification: 'not-notation', complete: false },
    ))).toBe('fallback');
  });

  it('★ NEGATIVE CONTROL — a mixed chart is neither gated nor measured', () => {
    // The assertion is the same shape as the predicate: these two pages disagree, and a
    // chart-level "mostly not-notation" fold would have gated a chart with real staves.
    expect(measuredDisposition(reports(
      { classification: 'not-notation', complete: true },
      { classification: 'notation', complete: true },
    ))).toBe('fallback');
    expect(measuredDisposition(reports(
      { classification: 'notation', complete: true },
      { classification: 'raster', complete: true },
    ))).toBe('fallback');
  });

  it('measures a chart that is notation throughout and fully observed', () => {
    expect(measuredDisposition(reports(
      { classification: 'notation', complete: true },
      { classification: 'notation', complete: true },
    ))).toBe('measured');
  });

  it('never measures a notation chart with an unobserved page', () => {
    expect(measuredDisposition(reports({ classification: 'notation', complete: false }))).toBe('fallback');
  });

  it('falls back rather than committing an empty measurement', () => {
    expect(measuredDisposition({ pages: [], systems: [], bars: [] })).toBe('fallback');
    expect(measuredDisposition({
      pages: [{ pageNumber: 1, classification: 'notation', complete: true }],
      systems: [],
      bars: [],
    })).toBe('fallback');
  });
});

// ── Engine output → payload ──────────────────────────────────────────────────

describe('buildMeasuredPayload', () => {
  it('normalizes to [0,1] against the page EXTENT', () => {
    const p = buildMeasuredPayload([complete(page())])!;
    expect(p.systems[0].xStart).toBeCloseTo(0.1, 6);
    expect(p.systems[0].xEnd).toBeCloseTo(0.9, 6);
    expect(p.systems[0].yTop).toBeCloseTo(100 / 792, 6);
    expect(p.systems[0].yBottom).toBeCloseTo(140 / 792, 6);
    expect(p.bars[0].xStart).toBeCloseTo(0.1, 6);
    expect(p.bars[1].xEnd).toBeCloseTo(0.9, 6);
  });

  it('assigns absNumber dense over VISIBLE bars in reading order, across pages', () => {
    const p = buildMeasuredPayload([
      complete(page({ pageNumber: 1, systems: [sys({ yTop: 100, yBot: 140 }), sys({ yTop: 300, yBot: 340 })] })),
      complete(page({ pageNumber: 2, systems: [sys()] })),
    ])!;
    expect(p.bars.map((b) => b.absNumber)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(p.systems.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    // The order the payload emits must be the order isValidCalibration re-derives.
    const cal = installMeasured([], p);
    expect(barsInOrder(cal).map((b) => b.absNumber)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('carries the engine verdict per system', () => {
    const p = buildMeasuredPayload([
      complete(page({ systems: [sys({ verdict: 'unscored', expectedSpans: null })] })),
    ])!;
    expect(p.systems[0].verdict).toBe('unscored');
  });

  it('clamps a barline drawn past the staff into its parent system', () => {
    // A hair over the staff rule end would otherwise fail isValidCalibration's
    // "bar fits inside its system" check and throw away the whole measurement.
    const p = buildMeasuredPayload([
      complete(page({
        systems: [sys({ bars: [{ xStart: 61.2, xEnd: 306 }, { xStart: 306, xEnd: 560 }] })],
      })),
    ])!;
    expect(p.bars[1].xEnd).toBeCloseTo(0.9, 6);
    expect(isValidCalibration(installMeasured([], p))).toBe(true);
  });

  it('returns null on geometry it cannot express as a calibration', () => {
    expect(buildMeasuredPayload([complete(page({ pageWidth: 0 }))])).toBeNull();
    expect(buildMeasuredPayload([complete(page({ systems: [sys({ x0: 300, x1: 300 })] }))])).toBeNull();
  });
});

// ── Multirests: one visible bar, N musical measures ──────────────────────────

describe('Bar.measures — attribution, not arithmetic', () => {
  it('attaches the count to the ONE bar the H-bar sits in', () => {
    const p = buildMeasuredPayload([
      complete(page({
        systems: [sys({
          spans: 2,
          multirests: [{ count: 4, xStart: 320, xEnd: 540 }],
          // printed delta 5 over 2 visible spans: expectedSpans = 5 - 3 = 2 ✓
          expectedSpans: 2,
          verdict: 'validated',
        })],
      })),
    ])!;
    expect(p.bars[0].measures).toBeUndefined(); // absent ⇒ 1, no field for the common case
    expect(p.bars[1].measures).toBe(4);
    expect(p.systems[0].verdict).toBe('validated');
  });

  it('★ NEGATIVE CONTROL — an unplaceable multirest demotes the system and writes NO count', () => {
    // The sum check is invariant under mis-assignment, so it cannot catch this; only
    // position can. Rather than guess a bar, we decline to assert a musical count.
    const p = buildMeasuredPayload([
      complete(page({
        systems: [sys({ multirests: [{ count: 4, xStart: 570, xEnd: 600 }], expectedSpans: 2 })],
      })),
    ])!;
    expect(p.bars.every((b) => b.measures === undefined)).toBe(true);
    expect(p.systems[0].verdict).toBe('uncertain');
  });

  it('★ NEGATIVE CONTROL — two multirests landing in one bar is a disagreement, not a merge', () => {
    const p = buildMeasuredPayload([
      complete(page({
        systems: [sys({
          bars: [{ xStart: 61.2, xEnd: 306 }, { xStart: 306, xEnd: 550.8 }],
          multirests: [
            { count: 4, xStart: 320, xEnd: 400 },
            { count: 3, xStart: 420, xEnd: 500 },
          ],
        })],
      })),
    ])!;
    expect(p.systems[0].verdict).toBe('uncertain');
    expect(p.bars.every((b) => b.measures === undefined)).toBe(true);
  });

  it('★ the consistency guard fires when a count contradicts the printed delta', () => {
    // DOCTORED input, deliberately: for real engine output on a `validated` system this
    // identity holds by construction (Σ measures = spans + Σ(count−1) = expectedSpans +
    // Σ(count−1) = delta), so the only way to prove the check has teeth is to feed it an
    // inconsistency. expectedSpans 3 ⇒ delta 3 + 3 = 6, while Σ measures = 1 + 4 = 5.
    // That mismatch is the signature of a dropped or duplicated count.
    const p = buildMeasuredPayload([
      complete(page({
        systems: [sys({
          multirests: [{ count: 4, xStart: 320, xEnd: 540 }],
          expectedSpans: 3, // ⇒ delta 6, but Σ measures = 1 + 4 = 5
          verdict: 'validated',
        })],
      })),
    ])!;
    expect(p.systems[0].verdict).toBe('uncertain');
    expect(p.bars.every((b) => b.measures === undefined)).toBe(true);
  });

  it('does not evaluate the invariant on an unscored system', () => {
    // Undefined, not violated. A check that fires on absent evidence is the same
    // mistake the never-gate's safety rule exists to prevent.
    const p = buildMeasuredPayload([
      complete(page({
        systems: [sys({
          multirests: [{ count: 4, xStart: 320, xEnd: 540 }],
          expectedSpans: null,
          verdict: 'unscored',
        })],
      })),
    ])!;
    expect(p.systems[0].verdict).toBe('unscored');
    expect(p.bars[1].measures).toBe(4);
  });

  it('leaves absNumber dense over visible bars — multirests do not advance it', () => {
    const p = buildMeasuredPayload([
      complete(page({ systems: [sys({ multirests: [{ count: 4, xStart: 320, xEnd: 540 }] })] })),
    ])!;
    expect(p.bars.map((b) => b.absNumber)).toEqual([1, 2]);
  });
});

// ── The untrusted boundary ───────────────────────────────────────────────────

describe('isValidMeasuredPayload', () => {
  const good = (): MeasuredPayload => buildMeasuredPayload([complete(page())])!;

  it('accepts what the engine produces', () => {
    expect(isValidMeasuredPayload(good())).toBe(true);
  });

  it('rejects junk, a missing page list, and an out-of-order one', () => {
    expect(isValidMeasuredPayload(null)).toBe(false);
    expect(isValidMeasuredPayload({ systems: [], bars: [] })).toBe(false);
    expect(isValidMeasuredPayload({ ...good(), pages: [] })).toBe(false);
    expect(isValidMeasuredPayload({
      ...good(),
      pages: [{ pageNumber: 2, classification: 'notation', complete: true }],
    })).toBe(false);
  });

  it('rejects an unknown classification or a non-boolean completeness', () => {
    expect(isValidMeasuredPayload({
      ...good(),
      pages: [{ pageNumber: 1, classification: 'lyrics', complete: true }],
    })).toBe(false);
    expect(isValidMeasuredPayload({
      ...good(),
      pages: [{ pageNumber: 1, classification: 'notation', complete: 'yes' }],
    })).toBe(false);
  });

  it('rejects an unknown verdict and a non-integer measures count', () => {
    const p = good();
    expect(isValidMeasuredPayload({
      ...p,
      systems: [{ ...p.systems[0], verdict: 'probably-fine' }],
    })).toBe(false);
    for (const bad of [0, 1.5, -1, '2']) {
      expect(isValidMeasuredPayload({ ...p, bars: [{ ...p.bars[0], measures: bad }] })).toBe(false);
    }
  });
});

// ── Install ──────────────────────────────────────────────────────────────────

describe('installMeasured', () => {
  const sections = [{ id: 'sec1', page: 1, x: 0.1, y: 0.1, label: 'Intro', confidence: 0.8 }];

  it('installs measured geometry beside the VLM sections and validates', () => {
    const cal = installMeasured(sections, buildMeasuredPayload([complete(page())])!);
    expect(isValidCalibration(cal)).toBe(true);
    expect(cal.status).toBe('draft');
    expect(cal.sections).toEqual(sections); // semantics untouched — measurement is geometry
    expect(cal.bars).toHaveLength(2);
  });

  it('never installs a roadmap — measured bars cannot carry VLM bar bindings', () => {
    const cal = installMeasured(sections, buildMeasuredPayload([complete(page())])!);
    expect(cal.roadmap).toBeUndefined();
  });

  it('survives the DB boundary with a multirest count on board', () => {
    const cal = installMeasured(
      sections,
      buildMeasuredPayload([
        complete(page({ systems: [sys({ multirests: [{ count: 4, xStart: 320, xEnd: 540 }] })] })),
      ])!,
    );
    expect(isValidCalibration(cal)).toBe(true);
    expect(cal.bars?.[1].measures).toBe(4);
  });
});

// ── The two verdict declarations must not drift ──────────────────────────────

describe('verdict vocabulary', () => {
  it('every verdict the engine can emit is one the DB boundary accepts', () => {
    // `lib/chart-measure.ts` declares its own union because it imports nothing by
    // design. That is a deliberate duplicate, so it gets a test rather than a comment.
    const engine: ProvisionalVerdict[] = ['validated', 'uncertain', 'unscored'];
    for (const v of engine) expect(CHART_VERDICTS).toContain(v);
  });

  it('the DB vocabulary is the full five, including the two only the server can assign', () => {
    expect([...CHART_VERDICTS].sort()).toEqual(
      ['corroborated', 'estimated', 'uncertain', 'unscored', 'validated'],
    );
  });
});
