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
    convertible: true,
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

  it('none → nothing for a non-calibratable viewer, convertible or not', () => {
    // calibratable is the outer gate: a collaborator must never be offered a
    // build that would spend the OWNER's AI budget.
    for (const convertible of [true, false]) {
      cleanup();
      const { container } = render(
        <PerformReadinessStrip
          {...props({ view: ready({ state: 'none' }), calibratable: false, convertible })}
        />,
      );
      expect(container).toBeEmptyDOMElement();
    }
  });

  // ── Owner-demand overlay build (lazy conversion) ────────────────────────────
  it('none + convertible → "Build overlay" fires the BUILD callback, not Calibrate', () => {
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

  it('none + NOT convertible → the hand-calibrate CTA (gated ≠ unusable)', () => {
    // A lyrics sheet / builder chart: we decline to spend AI, but the owner can
    // still set it up by hand.
    const onCalibrate = vi.fn();
    const onBuildOverlay = vi.fn();
    render(
      <PerformReadinessStrip
        {...props({ view: ready({ state: 'none' }), convertible: false, onCalibrate, onBuildOverlay })}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Build overlay' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Calibrate' }));
    expect(onCalibrate).toHaveBeenCalledWith('sections');
    expect(onBuildOverlay).not.toHaveBeenCalled();
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
