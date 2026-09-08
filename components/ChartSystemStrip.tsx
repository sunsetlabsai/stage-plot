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

/** How far past the staff to crop, as a multiple of the band height. */
const PAD_FACTOR = 0.6;
/** Render scale for the crop. Matches the CV snap path's substrate. */
const STRIP_SCALE = 2.5;

export interface ChartSystemStripProps {
  doc: PDFDocumentProxy | null;
  system: System;
  /** Split to draw over the crop — each entry a span's right edge, normalized page x. */
  xs: number[] | null;
  tone?: 'proposed' | 'confirmed';
}

export function ChartSystemStrip({ doc, system, xs, tone = 'proposed' }: ChartSystemStripProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const canvas = ref.current;
      if (!canvas || !doc) return;
      // The SYSTEM's own page, not whatever the viewer is showing — the band rect is
      // normalized to that page (same reason the snap path renders it this way).
      const src = await renderPageOffscreen(doc, system.page, STRIP_SCALE);
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
        // a person checking "is that four bars" is counting areas, not lines.
        ctx.fillStyle = tone === 'confirmed' ? 'rgba(16,185,129,0.10)' : 'rgba(245,158,11,0.10)';
        let leftFrac = 0;
        xs.forEach((x, i) => {
          const rightFrac = (x - system.xStart) / span;
          if (i % 2 === 0) ctx.fillRect(leftFrac * w, 0, (rightFrac - leftFrac) * w, h);
          leftFrac = rightFrac;
        });
        ctx.strokeStyle = tone === 'confirmed' ? '#10b981' : '#f59e0b';
        ctx.lineWidth = Math.max(2, w * 0.003);
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
  }, [doc, system, xs, tone]);

  return (
    <div className="rounded-md overflow-hidden border border-zinc-700 bg-white">
      <canvas ref={ref} className="block w-full h-auto" aria-label="This line of the chart" />
    </div>
  );
}
