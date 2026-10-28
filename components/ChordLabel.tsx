import type { ViewCell } from '@/lib/roadmap-view';
import { renderCell } from '@/lib/roadmap-view';
import { nnsSegments } from '@/lib/nns-quality';

/**
 * One chord as the builder preview shows it. Numbers draw the Nashville way (5⁷, 1△⁷,
 * 2–, 7°) from the SAME segments the saved PDF draws (lib/nns-quality.ts), so preview
 * and stage agree. Letters keep ordinary lead-sheet spelling.
 */
export function ChordLabel({ cell, mode, renderKey }: { cell: ViewCell; mode: 'numbers' | 'letters'; renderKey: string }) {
  if (mode === 'letters') return <>{renderCell(cell, mode, renderKey)}</>;
  const acc = cell.alter === -1 ? '♭' : cell.alter === 1 ? '♯' : '';
  return (
    <>
      {acc}
      {nnsSegments(cell).map((s, i) =>
        s.kind === 'triangle' ? (
          <span key={i}>△</span>
        ) : s.size === 'sup' ? (
          <sup key={i} className="text-[0.66em] leading-none">{s.text}</sup>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}
