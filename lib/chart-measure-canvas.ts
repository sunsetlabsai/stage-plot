// ── Chart measurement — the pdf.js geometry adapter (docs/design-chart-measurement.md) ──
//
// Turns a rendered PDF page into the page-space segments `lib/chart-measure.ts` consumes.
//
// CLIENT ONLY. This module touches `Path2D`, `DOMMatrix` and a 2D canvas context; it
// has no node fallback and must never be imported from a route handler. The pure
// pipeline lives in `lib/chart-measure.ts` and imports nothing — keep the split.
//
// ── Why a recording canvas ───────────────────────────────────────────────────
//
// Hand-rolling transform composition over pdf.js's operator list is a PROVEN TRAP: it
// produced content-dependent coordinate drift of 23-28pt varying by graphics context,
// wrong in ways that self-validation partially masked. Do not retry it.
//
// Instead we hand `page.render()` a Proxy-wrapped context that forwards every call —
// so rendering stays byte-correct — and records path geometry against the transform
// pdf.js ITSELF has set, read via `ctx.getTransform()` at paint time. The same code
// path that puts ink on screen produces the measurements, so coordinates are correct by
// construction rather than by re-derivation.
//
// Validated 2026-09-02 against the poppler reference implementation: 464/464 scored
// systems, identical no-staves classifications, and ZERO field diffs across all 87
// unique charts in the corpus. Four facts below are load-bearing and were each
// measured, not reasoned — changing any of them silently breaks the engine.

import type { PDFPageProxy } from 'pdfjs-dist';
import type { MeasuredSegment } from './chart-measure';

/**
 * ★ LOAD-BEARING, and not a rendering-quality knob.
 *
 * pdf.js clamps any stroke to at least one device pixel (`rescaleAndStroke`), so the
 * recovered page-space stroke width has a hard floor of `1 / RENDER_SCALE` points. The
 * barline filter discriminates thin barlines from note stems at ~0.1pt, on strokes as
 * narrow as 0.43pt. Measured across the corpus: scale 1 scores 439/464; scales 2, 3, 4
 * and 8 all score 464/464. 3 is the lowest with real margin (floor 0.33pt) and costs
 * 4.4M pixels for US Letter — the smallest raster the engine can be trusted on.
 *
 * Not yet measured on a real phone. If device profiling forces this down, 2 still
 * scores 464/464 but leaves only ~0.07pt of headroom on the narrowest corpus chart.
 */
export const RENDER_SCALE = 3;

/**
 * ★ LOAD-BEARING. The canvas must cover the viewport.
 *
 * A 1x1 canvas looks free — we only want the CTM, not the pixels — but pdf.js culls
 * paths against the canvas clip box, so shrinking the canvas silently DROPS geometry
 * (measured: three corpus charts regress). The render pass is a real cost; the only
 * lever on it is `RENDER_SCALE`.
 */

/** Curves whose control points lie on the chord are lines in disguise. */
const CHORD_MIN_LEN = 2;
const CHORD_MAX_DEVIATION = 0.8;

type Op = [string, ...number[]];
type Matrix = [number, number, number, number, number, number];

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/**
 * White ink on a white page is invisible BY DEFINITION: background washes, and the
 * knock-out boxes engravers paint behind rehearsal marks to erase the staff beneath.
 *
 * ★ Dropping these is load-bearing, not tidiness. Producers emit a page-covering white
 * wash that poppler folds into its own background and the reference implementation
 * therefore never saw. Left in, the wash's page-width edges become the longest rule on
 * the page, and the `STAFF_LEN_FRACTION` staff-candidate filter then rejects every real
 * staff line — zero staves on a perfectly good chart.
 */
function isWhite(style: string | CanvasGradient | CanvasPattern): boolean {
  if (typeof style !== 'string') return false;
  const s = style.trim().toLowerCase();
  return (
    s === '#fff' ||
    s === '#ffffff' ||
    s === 'white' ||
    /^rgba?\(\s*255\s*,\s*255\s*,\s*255\s*(,\s*1(\.0+)?\s*)?\)$/.test(s)
  );
}

/**
 * The second half of the wash test, and the reason the first half being colour-exact is
 * safe: a fill spanning the whole page is a wash whatever colour it is, because notation
 * never covers the page. This catches the off-white or tinted wash that `isWhite` would
 * miss without having to guess at a near-white threshold — and it cannot swallow
 * white-on-dark notation, which is not page-sized.
 *
 * Both halves were measured independently across the corpus at 464/464 with zero field
 * diffs; the union only ever drops more, and only shapes that cannot be notation.
 */
const PAGE_COVER_FRACTION = 0.98;

function coversPage(segments: MeasuredSegment[], pageW: number, pageH: number): boolean {
  if (segments.length === 0) return false;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of segments) {
    x0 = Math.min(x0, s.x0, s.x1);
    x1 = Math.max(x1, s.x0, s.x1);
    y0 = Math.min(y0, s.y0, s.y1);
    y1 = Math.max(y1, s.y0, s.y1);
  }
  return x1 - x0 >= PAGE_COVER_FRACTION * pageW && y1 - y0 >= PAGE_COVER_FRACTION * pageH;
}

/**
 * A `Path2D` that remembers its verbs.
 *
 * Modern pdf.js builds every path as a `Path2D` and never as ctx verbs, so this is
 * where geometry must be caught. There is no module-local alias for `Path2D` anywhere
 * in the pdf.js bundle — it resolves off the global at each `new` — which is what makes
 * swapping the global a complete interception rather than a partial one. pdf.js's one
 * `path instanceof Path2D` check passes, because the global IS this subclass.
 */
function createRecordingPath2D(Native: typeof Path2D) {
  return class RecordingPath2D extends Native {
    ops: Op[] = [];

    constructor(source?: Path2D | string) {
      super(source as Path2D);
      const src = source as { ops?: Op[] } | undefined;
      if (src?.ops) this.ops = src.ops.map((o) => [...o] as Op);
    }

    moveTo(x: number, y: number): void {
      this.ops.push(['M', x, y]);
      super.moveTo(x, y);
    }

    lineTo(x: number, y: number): void {
      this.ops.push(['L', x, y]);
      super.lineTo(x, y);
    }

    bezierCurveTo(a: number, b: number, c: number, d: number, e: number, f: number): void {
      this.ops.push(['C', a, b, c, d, e, f]);
      super.bezierCurveTo(a, b, c, d, e, f);
    }

    quadraticCurveTo(a: number, b: number, c: number, d: number): void {
      this.ops.push(['Q', a, b, c, d]);
      super.quadraticCurveTo(a, b, c, d);
    }

    closePath(): void {
      this.ops.push(['Z']);
      super.closePath();
    }

    rect(x: number, y: number, w: number, h: number): void {
      // recorded as explicit lines so a later addPath() can bake a general affine
      this.ops.push(['M', x, y], ['L', x + w, y], ['L', x + w, y + h], ['L', x, y + h], ['Z']);
      super.rect(x, y, w, h);
    }

    /**
     * ★ LOAD-BEARING. pdf.js copies paths through `addPath` at seven call sites —
     * pattern stroke and fill, the text clip, scaled glyph outlines, both `beginGroup`
     * bbox clips, and the stroke-rescaling hack. A shim that misses this silently drops
     * transformed strokes from the measurement stream.
     *
     * Resolution must BAKE the matrix into the destination's recorded ops rather than
     * hold a reference to the source, because `rescaleAndStroke` composes an inverse
     * scale into the path and a matching scale into the CTM. Pairing the paint-time CTM
     * with the resolved geometry of the path actually handed to `stroke()` makes that
     * display hack exactly transform-neutral; pairing it with the ORIGINAL path is off
     * by the rescale factor, which is largest precisely for hairlines — the staff lines.
     *
     * The matrix components are copied because pdf.js's rescale matrix is a MUTATED
     * MODULE SINGLETON: holding the object reads a later stroke's values.
     */
    addPath(source: Path2D, transform?: DOMMatrix2DInit): void {
      const t = transform as DOMMatrix | undefined;
      const m: Matrix = t
        ? [t.a ?? 1, t.b ?? 0, t.c ?? 0, t.d ?? 1, t.e ?? 0, t.f ?? 0]
        : [1, 0, 0, 1, 0, 0];
      const ops = (source as { ops?: Op[] }).ops;
      for (const op of ops ?? []) {
        if (op[0] === 'Z') {
          this.ops.push(['Z']);
          continue;
        }
        const out: Op = [op[0]];
        for (let i = 1; i < op.length; i += 2) {
          const [X, Y] = apply(m, op[i] as number, op[i + 1] as number);
          out.push(X, Y);
        }
        this.ops.push(out);
      }
      super.addPath(source, transform);
    }
  };
}

/**
 * Recorded verbs → page-space segments. `m` is the CTM at paint time; dividing by the
 * render scale returns device pixels to points.
 */
function opsToSegments(
  ops: Op[],
  m: Matrix,
  scale: number,
  strokeW: number | null,
  out: MeasuredSegment[],
): void {
  const P = (x: number, y: number): [number, number] => {
    const [dx, dy] = apply(m, x, y);
    return [dx / scale, dy / scale];
  };

  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let started = false;

  for (const op of ops) {
    const [kind] = op;
    if (kind === 'M') {
      cx = op[1] as number;
      cy = op[2] as number;
      sx = cx;
      sy = cy;
      started = true;
    } else if (kind === 'L') {
      const [x0, y0] = P(cx, cy);
      const [x1, y1] = P(op[1] as number, op[2] as number);
      out.push({ x0, y0, x1, y1, strokeW });
      cx = op[1] as number;
      cy = op[2] as number;
    } else if (kind === 'C' || kind === 'Q') {
      // A curve whose control points sit on its chord is a straight line drawn the long
      // way round — some engravers emit multirest H-bars exactly like this. Real slurs
      // and ties deviate far more and are dropped, which is what we want.
      let c1x: number;
      let c1y: number;
      let c2x: number;
      let c2y: number;
      let nx: number;
      let ny: number;
      if (kind === 'C') {
        [, c1x, c1y, c2x, c2y, nx, ny] = op as [string, number, number, number, number, number, number];
      } else {
        const [, qx, qy, ex, ey] = op as [string, number, number, number, number];
        c1x = cx + (2 / 3) * (qx - cx);
        c1y = cy + (2 / 3) * (qy - cy);
        c2x = ex + (2 / 3) * (qx - ex);
        c2y = ey + (2 / 3) * (qy - ey);
        nx = ex;
        ny = ey;
      }
      const [px0, py0] = P(cx, cy);
      const [px1, py1] = P(nx, ny);
      const dx = px1 - px0;
      const dy = py1 - py0;
      const len = Math.hypot(dx, dy);
      if (len > CHORD_MIN_LEN) {
        const dev = (qx: number, qy: number) => Math.abs(dx * (py0 - qy) - dy * (px0 - qx)) / len;
        const [a1x, a1y] = P(c1x, c1y);
        const [a2x, a2y] = P(c2x, c2y);
        if (dev(a1x, a1y) < CHORD_MAX_DEVIATION && dev(a2x, a2y) < CHORD_MAX_DEVIATION) {
          out.push({ x0: px0, y0: py0, x1: px1, y1: py1, strokeW });
        }
      }
      cx = nx;
      cy = ny;
    } else if (kind === 'Z') {
      if (started && (cx !== sx || cy !== sy)) {
        const [x0, y0] = P(cx, cy);
        const [x1, y1] = P(sx, sy);
        out.push({ x0, y0, x1, y1, strokeW });
      }
      cx = sx;
      cy = sy;
    }
  }
}

/** Paint that carries pixels rather than geometry — evidence the page is not pure vector. */
const OPAQUE_OPS = [
  'drawImage',
  'putImageData',
  'fillRect',
  'strokeRect',
  'fillText',
  'strokeText',
  'createPattern',
] as const;

export interface PageGeometry {
  segments: MeasuredSegment[];
  /** Counts of paint that produced no geometry, keyed by canvas op. */
  opaque: Record<string, number>;
  /**
   * Emitted when something about the paint deserves a caveat. A partial segment stream
   * scores as confidently as a full one, so an unobserved-paint warning means the page
   * must fall through to the VLM rather than be scored.
   *
   * ⚠ But NOT every warning means that, and B1's original blanket wording here ("any
   * warning means INCOMPLETE") was too strong: `anisotropic-ctm` is a PRECISION caveat —
   * the geometry *was* observed — and 4 corpus files carry it while validating 53/53
   * systems. The one predicate that decides this is `isGeometryComplete`
   * (`lib/chart-measure.ts`), which reads the OBSERVABILITY warnings and the opaque-op
   * counts as separate categories. Do not re-derive a completeness rule from this field.
   */
  warnings: string[];
}

interface RecordState {
  segments: MeasuredSegment[];
  warnings: Set<string>;
  opaque: Record<string, number>;
  scale: number;
  /** Page size in points, for the page-covering half of the wash test. */
  pageW: number;
  pageH: number;
}

function makeRecordingContext(
  raw: CanvasRenderingContext2D,
  Native: typeof Path2D,
  state: RecordState,
): CanvasRenderingContext2D {
  const bound = new Map<string | symbol, unknown>();

  const recordInto = (path: Path2D, strokeW: number | null, out: MeasuredSegment[]) => {
    const m = raw.getTransform();
    opsToSegments(
      ((path as { ops?: Op[] }).ops ?? []) as Op[],
      [m.a, m.b, m.c, m.d, m.e, m.f],
      state.scale,
      strokeW,
      out,
    );
  };
  const record = (path: Path2D, strokeW: number | null) =>
    recordInto(path, strokeW, state.segments);

  const handlers: Record<string, (...args: never[]) => unknown> = {
    stroke(path?: Path2D) {
      if (!(path instanceof Native)) {
        // pdf.js always passes an explicit Path2D; a bare stroke() would mean geometry
        // accumulated somewhere we never saw.
        state.warnings.add('stroke-without-path');
        return raw.stroke();
      }
      const m = raw.getTransform();
      const norm = Math.hypot(m.a, m.b);
      if (Math.abs(Math.hypot(m.c, m.d) - norm) > 1e-6) state.warnings.add('anisotropic-ctm');
      // Page-space stroke width. `rescaleAndStroke` overwrites ctx.lineWidth with a
      // display value, but width x |CTM| / scale recovers the true PDF width whenever
      // the one-device-pixel clamp did not fire — see RENDER_SCALE.
      record(path, (raw.lineWidth * norm) / state.scale);
      return raw.stroke(path);
    },

    fill(pathOrRule?: Path2D | CanvasFillRule, rule?: CanvasFillRule) {
      if (!(pathOrRule instanceof Native)) {
        state.warnings.add('fill-without-path');
        return pathOrRule === undefined ? raw.fill() : raw.fill(pathOrRule as CanvasFillRule);
      }
      // Filled shapes carry no stroke width; some engravers draw barlines as thin
      // filled rectangles, and the barline cluster filter admits width 0 for exactly
      // that reason.
      const got: MeasuredSegment[] = [];
      recordInto(pathOrRule, null, got);
      if (isWhite(raw.fillStyle) || coversPage(got, state.pageW, state.pageH)) {
        state.opaque.wash = (state.opaque.wash ?? 0) + 1;
      } else {
        state.segments.push(...got);
      }
      return rule === undefined ? raw.fill(pathOrRule) : raw.fill(pathOrRule, rule);
    },

    clip(pathOrRule?: Path2D | CanvasFillRule, rule?: CanvasFillRule) {
      // Clip paths are not ink. The reference implementation never saw them either.
      state.opaque.clip = (state.opaque.clip ?? 0) + 1;
      if (!(pathOrRule instanceof Native)) {
        return pathOrRule === undefined ? raw.clip() : raw.clip(pathOrRule as CanvasFillRule);
      }
      return rule === undefined ? raw.clip(pathOrRule) : raw.clip(pathOrRule, rule);
    },
  };

  for (const name of OPAQUE_OPS) {
    handlers[name] = (...args: never[]) => {
      state.opaque[name] = (state.opaque[name] ?? 0) + 1;
      return (raw[name] as (...a: never[]) => unknown)(...args);
    };
  }

  return new Proxy(raw, {
    get(target, prop) {
      const handler = handlers[prop as string];
      if (handler) return handler;
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      // Methods must be BOUND to the raw context — invoking one with the Proxy as
      // receiver throws "Illegal invocation" — and identity-stable, because pdf.js
      // stashes method references when it mirrors context operations.
      if (!bound.has(prop)) bound.set(prop, (value as (...a: never[]) => unknown).bind(target));
      return bound.get(prop);
    },
    set(target, prop, value) {
      Reflect.set(target, prop, value, target);
      return true;
    },
  }) as CanvasRenderingContext2D;
}

/**
 * Render one page through the recording shim and return its page-space geometry.
 *
 * Swaps `globalThis.Path2D` for the duration of the render and restores it afterwards,
 * so this must not run concurrently with another render on the same page — callers
 * measure pages in sequence.
 */
export async function extractPageGeometry(
  page: PDFPageProxy,
  scale: number = RENDER_SCALE,
): Promise<PageGeometry> {
  const Native = globalThis.Path2D;
  const Recording = createRecordingPath2D(Native);
  const viewport = page.getViewport({ scale });
  const state: RecordState = {
    segments: [],
    warnings: new Set(),
    opaque: {},
    scale,
    pageW: viewport.width / scale,
    pageH: viewport.height / scale,
  };
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const raw = canvas.getContext('2d', { alpha: false });
  if (!raw) return { segments: [], opaque: {}, warnings: ['no-2d-context'] };

  globalThis.Path2D = Recording as unknown as typeof Path2D;
  try {
    // ★ `canvas` MUST be null. It defaults to `canvasContext.canvas`, and a truthy
    // canvas makes pdf.js re-derive the context from it — silently discarding the proxy
    // and recording nothing at all. pdf.js's own types spell this out: "If the context
    // must absolutely be used to render the page, the canvas must be null."
    await page.render({
      canvasContext: makeRecordingContext(raw, Native, state),
      canvas: null,
      viewport,
    }).promise;
  } finally {
    globalThis.Path2D = Native;
    // Release the backing store rather than waiting for GC — at RENDER_SCALE a US
    // Letter page is ~4.4M pixels and a library sweep measures many pages in a row.
    canvas.width = 0;
    canvas.height = 0;
  }

  return { segments: state.segments, opaque: state.opaque, warnings: [...state.warnings] };
}
