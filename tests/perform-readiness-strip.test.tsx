// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import PerformReadinessStrip, {
  type PerformReadinessStripProps,
} from '../components/PerformReadinessStrip';
import type { PerformReadiness, PerformReadinessView } from '../lib/chart-calibration';

// ── Perform readiness strip (jsdom) ───────────────────────────────────────────
// PURE presentational (no session/PDF/validity), so every assertion is render +
// callback. Mirrors the chunk-4 ConductorCluster harness.

afterEach(cleanup);

function props(over: Partial<PerformReadinessStripProps> = {}): PerformReadinessStripProps {
  return {
    view: { phase: 'loading' },
    calibratable: true,
    onCalibrate: vi.fn(),
    skipReason: null,
    convertState: 'idle',
    onBuildOverlay: vi.fn(),
    ...over,
  };
}

const ready = (readiness: PerformReadiness): PerformReadinessView => ({ phase: 'ready', readiness });

describe('PerformReadinessStrip', () => {
  it('loading → renders nothing (no flash)', () => {
    const { container } = render(<PerformReadinessStrip {...props({ view: { phase: 'loading' } })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('bar-ready → renders nothing (transport already shows)', () => {
    const { container } = render(
      <PerformReadinessStrip {...props({ view: ready({ state: 'bar-ready' }) })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('load-error → the error line for BOTH calibratable and not, no button', () => {
    for (const calibratable of [true, false]) {
      cleanup();
      render(<PerformReadinessStrip {...props({ view: { phase: 'load-error' }, calibratable })} />);
      expect(screen.getByText("Couldn't load this chart.")).toBeInTheDocument();
      expect(screen.queryByRole('button')).toBeNull();
    }
  });

  it('unreadable → the honest message and NO innocent Calibrate CTA (D6)', () => {
    render(
      <PerformReadinessStrip {...props({ view: { phase: 'unreadable', reason: 'unsupported-schema' } })} />,
    );
    expect(screen.getByText(/newer version of the app/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Calibrate/ })).toBeNull();

    cleanup();
    render(<PerformReadinessStrip {...props({ view: { phase: 'unreadable', reason: 'invalid' } })} />);
    expect(screen.getByText(/corrupt/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('none → nothing for a non-calibratable viewer, gated or not', () => {
    // calibratable is the outer gate: a collaborator must never be offered a
    // build that would spend the OWNER's AI budget — and must not be told about a
    // gate on someone else's chart either.
    for (const skipReason of [null, 'authored', 'lyrics'] as const) {
      cleanup();
      const { container } = render(
        <PerformReadinessStrip
          {...props({ view: ready({ state: 'none' }), calibratable: false, skipReason })}
        />,
      );
      expect(container).toBeEmptyDOMElement();
    }
  });

  // ── Owner-demand overlay build (lazy conversion) ────────────────────────────
  it('none + no gate → "Build overlay" fires the BUILD callback, not Calibrate', () => {
    const onBuildOverlay = vi.fn();
    const onCalibrate = vi.fn();
    render(
      <PerformReadinessStrip
        {...props({ view: ready({ state: 'none' }), onBuildOverlay, onCalibrate })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Build overlay' }));
    expect(onBuildOverlay).toHaveBeenCalledTimes(1);
    expect(onCalibrate).not.toHaveBeenCalled();
  });

  // ── Gate disclosure ─────────────────────────────────────────────────────────
  // A never-gate that says nothing is indistinguishable from a bug. Each reason
  // gets its own line; both keep the hand-calibrate CTA, because gated means "we
  // won't spend AI on it", never "you can't set it up".
  for (const skipReason of ['authored', 'lyrics'] as const) {
    it(`none + ${skipReason} gate → discloses the reason, keeps the hand-calibrate CTA`, () => {
      const onCalibrate = vi.fn();
      const onBuildOverlay = vi.fn();
      render(
        <PerformReadinessStrip
          {...props({ view: ready({ state: 'none' }), skipReason, onCalibrate, onBuildOverlay })}
        />,
      );
      // Never the pre-disclosure copy, which said only that there was no overlay.
      expect(screen.queryByText(/No overlay for these bytes/)).toBeNull();
      expect(screen.queryByRole('button', { name: 'Build overlay' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Calibrate' }));
      expect(onCalibrate).toHaveBeenCalledWith('sections');
      expect(onBuildOverlay).not.toHaveBeenCalled();
    });
  }

  it('the two gates render DIFFERENT text — the point of threading the reason', () => {
    // Asserting each message in isolation would pass just as well if both reasons
    // produced identical copy, which is exactly the bug this PR removes.
    const textFor = (skipReason: 'authored' | 'lyrics') => {
      cleanup();
      const { container } = render(
        <PerformReadinessStrip {...props({ view: ready({ state: 'none' }), skipReason })} />,
      );
      return container.textContent ?? '';
    };
    const authored = textFor('authored');
    const lyrics = textFor('lyrics');
    expect(authored).not.toEqual(lyrics);
    expect(authored).toMatch(/Built in ShowRunr/);
    expect(lyrics).toMatch(/Lyrics sheet/);
  });

  it('a gate outranks convertState — a gated chart never shows build progress', () => {
    // convertState is owner-local and can be stale (an earlier build on another
    // chart). It must never make a gated chart look like it is converting.
    for (const convertState of ['running', 'error'] as const) {
      cleanup();
      render(
        <PerformReadinessStrip
          {...props({ view: ready({ state: 'none' }), skipReason: 'lyrics', convertState })}
        />,
      );
      expect(screen.getByText(/Lyrics sheet/)).toBeInTheDocument();
      expect(screen.queryByText(/Building overlay/)).toBeNull();
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    }
  });

  it('none + running → progress copy and NO button (the route has no cancel)', () => {
    render(
      <PerformReadinessStrip {...props({ view: ready({ state: 'none' }), convertState: 'running' })} />,
    );
    expect(screen.getByText(/Building overlay/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('none + error → honest copy + a retry that re-fires the build', () => {
    const onBuildOverlay = vi.fn();
    render(
      <PerformReadinessStrip
        {...props({ view: ready({ state: 'none' }), convertState: 'error', onBuildOverlay })}
      />,
    );
    expect(screen.getByText(/Couldn't build an overlay/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onBuildOverlay).toHaveBeenCalledTimes(1);
  });

  it('convertState is scoped to `none` — it never disturbs a state that HAS a map', () => {
    // A stale 'running'/'error' must not leak into the draft/verified copy: those
    // states already have a calibration, so building is not the next step.
    for (const convertState of ['running', 'error'] as const) {
      cleanup();
      const onCalibrate = vi.fn();
      render(
        <PerformReadinessStrip
          {...props({ view: ready({ state: 'verifiable' }), convertState, onCalibrate })}
        />,
      );
      expect(screen.getByText(/Draft — Verify to perform/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Calibrate' }));
      expect(onCalibrate).toHaveBeenCalledWith('sections');
    }
  });

  it('verifiable → "Draft — Verify to perform." + Calibrate→sections', () => {
    const onCalibrate = vi.fn();
    render(<PerformReadinessStrip {...props({ view: ready({ state: 'verifiable' }), onCalibrate })} />);
    expect(screen.getByText(/Draft — Verify to perform/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Calibrate' }));
    expect(onCalibrate).toHaveBeenCalledWith('sections');
  });

  it('unverifiable routes to the CORRECT tool per reason', () => {
    const cases: { reason: 'no-sections' | 'unlabeled-section' | 'roadmap-unresolved'; tool: string }[] = [
      { reason: 'no-sections', tool: 'sections' },
      { reason: 'unlabeled-section', tool: 'sections' },
      { reason: 'roadmap-unresolved', tool: 'roadmap' },
    ];
    for (const { reason, tool } of cases) {
      cleanup();
      const onCalibrate = vi.fn();
      render(
        <PerformReadinessStrip {...props({ view: ready({ state: 'unverifiable', reason }), onCalibrate })} />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Calibrate' }));
      expect(onCalibrate).toHaveBeenCalledWith(tool);
    }
  });

  it('section-only SPLIT — seek copy for all; "Add bars"→bars only when calibratable', () => {
    // Non-calibratable: seek copy, NO button.
    render(
      <PerformReadinessStrip {...props({ view: ready({ state: 'section-only' }), calibratable: false })} />,
    );
    expect(screen.getByText('Tap a section to seek.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();

    // Calibratable: seek copy + "Add bars" → bars.
    cleanup();
    const onCalibrate = vi.fn();
    render(
      <PerformReadinessStrip {...props({ view: ready({ state: 'section-only' }), onCalibrate })} />,
    );
    expect(screen.getByText(/Tap a section to seek/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add bars' }));
    expect(onCalibrate).toHaveBeenCalledWith('bars');
  });
});
