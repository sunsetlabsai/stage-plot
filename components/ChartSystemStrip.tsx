'use client';

import { useEffect, useRef } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { System } from '@/lib/types';
import { renderPageOffscreen } from '@/lib/pdf-viewer';

// ── One system, drawn as a picture (docs/design-chart-review-step.md §C3) ────
//
// The review sheet's whole premise is "pick the picture that looks right", so this is
// the load-bearing component: everything else is chrome around it.
//
// Rendered ON DEMAND, one system at a time. That is the answer to the frozen doc's
// open-Q3 — pre-rendering at conversion time would pay for every system of every chart
// to serve the handful ever opened, and the sheet only ever shows one.
//
// ★ Two sizes, ONE draw routine. The sheet shows the selected split full-size AND a mini
// of every option beside it (Codex H2, #184: options that read only "N bars" make two
// different 4-bar geometries indistinguishable, and "Use this" then commits a picture
// nobody saw). `variant` changes the frame and the stroke weight, never the geometry —
// the mini has to be the same crop with the same edges on it, or it is not a preview of
// the thing the full strip will show.

/** How far past the staff to crop, as a multiple of the band height. */
const PAD_FACTOR = 0.6;
/** Render scale for the crop. Matches the CV snap path's substrate. */
const STRIP_SCALE = 2.5;

/**
 * ONE page raster, shared by every strip on screen.
 *
 * A sheet with three candidates mounts four strips (the full one plus a mini per option),
 * all of the same page. Four independent `renderPageOffscreen` calls would rasterize the
 * same page four times, on a phone, while the owner waits. Keyed by document so it dies
 * with the doc, and holding exactly ONE page per document because the sheet is a
 * one-line-at-a-time surface — a second page means the owner moved on, and the previous
 * raster is dead weight.
 *
 * The stored promise NEVER rejects (`renderPageOffscreen` resolves null on failure), which
 * is what makes it safe to share: a rejection here would be handled by whichever consumer
 * happened to await first and go unhandled for the rest.
 */
const pageRasters = new WeakMap<
  PDFDocumentProxy,
  { key: string; raster: Promise<HTMLCanvasElement | null> }
>();

function sharedPageRaster(doc: PDFDocumentProxy, pageNum: number): Promise<HTMLCanvasElement | null> {
  const key = `${pageNum}@${STRIP_SCALE}`;
  const hit = pageRasters.get(doc);
  if (hit && hit.key === key) return hit.raster;
  const raster = renderPageOffscreen(doc, pageNum, STRIP_SCALE).catch(() => null);
  pageRasters.set(doc, { key, raster });
  return raster;
}

export interface ChartSystemStripProps {
  doc: PDFDocumentProxy | null;
  system: System;
  /** Split to draw over the crop — each entry a span's right edge, normalized page x. */
  xs: number[] | null;
  tone?: 'proposed' | 'confirmed';
  /** `mini` is the in-option preview: same crop, lighter frame, thinner marks. */
  variant?: 'full' | 'mini';
}

export function ChartSystemStrip({
  doc,
  system,
  xs,
  tone = 'proposed',
  variant = 'full',
}: ChartSystemStripProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    // ⚠ Teardown SUPPRESSES the paint; it does not cancel the render (Codex L1, #184
    // asked for the unhandled rejection, which is fixed at the source in
    // `renderPageOffscreen`). Cancellation is deliberately NOT added here: the raster is
    // shared with every other strip in the sheet, so a cancel on unmount would abort a
    // render its siblings are still awaiting. The work is bounded — one page — and it is
    // already in flight before any of them mount.
    let cancelled = false;
    (async () => {
      const canvas = ref.current;
      if (!canvas || !doc) return;
      // The SYSTEM's own page, not whatever the viewer is showing — the band rect is
      // normalized to that page (same reason the snap path renders it this way).
      const src = await sharedPageRaster(doc, system.page);
      if (cancelled || !src) return;

      // ⚠ The stored band is the STAFF'S OWN EXTENT, with no padding — it is the top and
      // bottom staff lines and nothing else. Cropping at exactly yTop/yBottom slices off
      // ledger lines, chord symbols and the measure numbers a human reads to orient
      // themselves. So pad OUTWARD here. (The CV snap path crops INWARD, which is right
      // for reading pixel darkness and wrong for showing a person their music.)
      const bandH = (system.yBottom - system.yTop) * src.height;
      const pad = bandH * PAD_FACTOR;
      const y0 = Math.max(0, Math.floor(system.yTop * src.height - pad));
      const y1 = Math.min(src.height, Math.ceil(system.yBottom * src.height + pad));
      const x0 = Math.max(0, Math.floor(system.xStart * src.width));
      const x1 = Math.min(src.width, Math.ceil(system.xEnd * src.width));
      const w = x1 - x0;
      const h = y1 - y0;
      if (w <= 0 || h <= 0) return;

      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // ⚠ pdf.js paints onto a TRANSPARENT canvas. Blitting the crop straight onto an
      // unpainted destination gives dark ink floating on nothing, which reads as a
      // rendering bug rather than as sheet music. Lay down paper first.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(src, x0, y0, w, h, 0, 0, w, h);

      if (xs && xs.length) {
        const span = system.xEnd - system.xStart;
        // Shade alternate spans so the COUNT is legible as regions, not just as ticks —
        // a person checking "is that four bars" is counting areas, not lines. The mini
        // shades HARDER: at option size the ticks alone are a few pixels apart and the
        // banding is what actually distinguishes one option's picture from another's.
        const shade = variant === 'mini' ? 0.16 : 0.1;
        ctx.fillStyle =
          tone === 'confirmed' ? `rgba(16,185,129,${shade})` : `rgba(245,158,11,${shade})`;
        let leftFrac = 0;
        xs.forEach((x, i) => {
          const rightFrac = (x - system.xStart) / span;
          if (i % 2 === 0) ctx.fillRect(leftFrac * w, 0, (rightFrac - leftFrac) * w, h);
          leftFrac = rightFrac;
        });
        ctx.strokeStyle = tone === 'confirmed' ? '#10b981' : '#f59e0b';
        ctx.lineWidth = Math.max(variant === 'mini' ? 3 : 2, w * (variant === 'mini' ? 0.005 : 0.003));
        ctx.lineCap = 'round';
        for (const x of xs) {
          const px = ((x - system.xStart) / span) * w;
          ctx.beginPath();
          ctx.moveTo(px, 2);
          ctx.lineTo(px, h - 2);
          ctx.stroke();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, system, xs, tone, variant]);

  return (
    <div
      className={
        variant === 'mini'
          ? 'rounded overflow-hidden border border-zinc-600 bg-white'
          : 'rounded-md overflow-hidden border border-zinc-700 bg-white'
      }
    >
      <canvas ref={ref} className="block w-full h-auto" aria-label="This line of the chart" />
    </div>
  );
}
