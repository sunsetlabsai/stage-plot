// ── The beat→slash rule — the ONE shared source both render paths call ─────────
// The rhythm strip (one slash per beat) is drawn by two independent renderers:
// the PDF (lib/roadmap-render.ts, server, pdf-lib) and the HTML preview
// (components/RoadmapBuilder.tsx). The design's anti-drift move is that the RULE
// deciding which beats get a slash lives HERE, pure and pdf-lib-free, so the two
// surfaces can never disagree about it — only the ink differs (vector strokes vs.
// a ╱ glyph), never the meaning.
//
// Returns one boolean per beat of the bar: `true` = draw a slash, `false` =
// SUPPRESS it because a HELD chord (the diamond / let-it-ring) covers that beat,
// and a slash would contradict the ring. A bar with no chords (inherited or empty)
// gets a FULL rhythm — every beat slashed — which is the default "play it again"
// continuation the preview already showed.
//
// Both call shapes carry the two fields this needs: RoadmapSpec `ChordHit`
// (`beats?`, `held?`) and the view bridge's `ViewCell` (`beats`, `held?`). Beat
// spans are integers that tile `timeSig.beats` EXACTLY — validateChords requires
// explicit beats to be all-or-none, integer, and sum to the bar; even division
// requires the bar to divide evenly — so this is exact whole-beat arithmetic with
// no fractional edges to sample. The Math.round is defensive only.
export function slashBeats(
  chords: ReadonlyArray<{ beats?: number; held?: boolean }> | null | undefined,
  beats: number,
): boolean[] {
  const n = Math.max(0, Math.floor(beats));
  const slots = new Array<boolean>(n).fill(true);
  if (n === 0 || !chords || chords.length === 0) return slots;

  // Explicit beats are all-or-none (validateChords); when none carry an explicit
  // span the bar is an even division across the chords.
  const even = chords.every((c) => c.beats == null);
  let cum = 0;
  for (const c of chords) {
    const span = even ? beats / chords.length : c.beats ?? 0;
    if (c.held) {
      const start = Math.round(cum);
      const end = Math.round(cum + span);
      for (let b = start; b < end && b < n; b += 1) slots[b] = false;
    }
    cum += span;
  }
  return slots;
}
