'use client';

import { useState } from 'react';
import type { ImportDiff } from '@/lib/setlist-import';

// Setlist import — the preview/diff gate (design docs/design-setlist-import-merge.md §7).
//
// PURELY PRESENTATIONAL. It receives an already-computed ImportDiff and reports
// intent through callbacks; it never fetches, never merges, and never touches
// config. That is what makes the §7 requirements testable without rendering the
// 7000-line show page — the same split ConductorCluster uses.
//
// The invariant this component is responsible for (§0 rule 1, "import never
// destroys data the sheet did not mention") is enforced upstream by mergeSetlist.
// What THIS component owes is that a destructive option is never the default and
// never reachable in one click: `removeMissing` is owned by the parent and
// arrives false, and Apply-with-removals requires a second, count-naming
// confirmation before onApply fires at all.

export interface SetlistImportPreviewProps {
  /** Rows read from the sheet — the headline count. */
  rowCount: number;
  diff: ImportDiff;
  /** Recognized-but-not-imported columns present in the sheet (§6, §10). */
  ignored: { bpm: boolean; artist: boolean };
  removeMissing: boolean;
  onToggleRemoveMissing: (next: boolean) => void;
  onApply: () => void;
  onCancel: () => void;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "key: — → Bb" — an em-dash stands in for a previously-empty value. */
function changeLabel(field: string, from: string | undefined, to: string): string {
  return `${field}: ${from && from.length > 0 ? from : '—'} → ${to}`;
}

export default function SetlistImportPreview({
  rowCount,
  diff,
  ignored,
  removeMissing,
  onToggleRemoveMissing,
  onApply,
  onCancel,
}: SetlistImportPreviewProps) {
  // The second confirmation for a destructive apply. Ephemeral UI state, so it
  // lives here — but it is RESET whenever the checkbox is touched, so unchecking
  // and re-checking can never leave a stale "confirmed" bit armed behind a
  // now-different count.
  const [confirming, setConfirming] = useState(false);

  // Exactly one of these is populated by mergeSetlist: `missing` when rows are
  // kept, `removed` when they are dropped. Reading the union keeps the count
  // right under either mode without the component knowing which branch ran.
  const absent = removeMissing ? diff.removed : diff.missing;
  const destructive = removeMissing && absent.length > 0;

  const toggle = (next: boolean) => {
    setConfirming(false); // never carry a confirmation across a mode change
    onToggleRemoveMissing(next);
  };

  const apply = () => {
    if (destructive && !confirming) {
      setConfirming(true);
      return;
    }
    onApply();
  };

  return (
    <div
      className="mb-4 p-3 bg-gray-50 rounded-lg border border-gray-200"
      role="group"
      aria-label="Import preview"
    >
      <p className="text-sm font-bold text-gray-700 mb-2">
        Importing {plural(rowCount, 'song', 'songs')} from your sheet
      </p>

      <ul className="text-sm text-gray-600 space-y-0.5 mb-2">
        {diff.matched.length > 0 && (
          <li>
            {plural(diff.matched.length, 'song', 'songs')} matched — key/lead/notes
            updated, charts and tempo kept
          </li>
        )}
        {diff.added.length > 0 && <li>{plural(diff.added.length, 'song', 'songs')} added</li>}
        {diff.reordered && <li>Order will change</li>}
      </ul>

      {/* §6/§10: name what is being ignored and why, rather than silently
          dropping a column the user deliberately filled in. */}
      {ignored.bpm && (
        <p className="text-xs text-gray-500 mb-1">
          BPM column found — tempo is set with Tap Tempo and won&apos;t be imported.
        </p>
      )}
      {ignored.artist && (
        <p className="text-xs text-gray-500 mb-1">
          Artist column found — artist belongs to the song library and won&apos;t be
          imported here.
        </p>
      )}

      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-xs font-bold text-gray-400 uppercase hover:text-gray-600">
          Details
        </summary>
        <ul className="mt-2 ml-1 space-y-1">
          {diff.matched.map((m, i) => (
            <li key={`m${i}`} className="text-gray-600">
              <span className="text-gray-400 uppercase text-[10px] mr-2">Matched</span>
              <span className="font-medium">{m.title}</span>
              {m.changes.length === 0 ? (
                <span className="text-gray-400 ml-2">no changes</span>
              ) : (
                <span className="ml-2">
                  {m.changes.map((c) => changeLabel(c.field, c.from, c.to)).join('   ')}
                </span>
              )}
            </li>
          ))}
          {diff.added.map((a, i) => (
            <li key={`a${i}`} className="text-gray-600">
              <span className="text-gray-400 uppercase text-[10px] mr-2">Added</span>
              <span className="font-medium">{a.title}</span>
            </li>
          ))}
          {absent.map((s, i) => (
            <li key={`x${i}`} className={removeMissing ? 'text-red-600' : 'text-gray-600'}>
              <span className="uppercase text-[10px] mr-2 text-gray-400">
                {removeMissing ? 'Removing' : 'Not in sheet'}
              </span>
              <span className="font-medium">{s.title}</span>
              {!removeMissing && <span className="text-gray-400 ml-2">(kept)</span>}
            </li>
          ))}
        </ul>
      </details>

      {absent.length > 0 && (
        <label className="flex items-start gap-2 mt-3 text-sm text-gray-700">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={removeMissing}
            onChange={(e) => toggle(e.target.checked)}
          />
          <span>Also remove the {plural(absent.length, 'song', 'songs')} not in this sheet</span>
        </label>
      )}

      {/* The reassurance is REQUIRED whenever removal is armed (§7): "removed"
          reads as destructive and here it is not — charts are owned by the
          library, not the setlist row. */}
      {destructive && (
        <p className="text-xs text-gray-500 mt-1 ml-6">
          Their charts stay in your chart library and can be added back at any time.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 mt-3">
        <button
          className="px-4 py-1.5 text-xs font-bold bg-green-600 text-white rounded hover:bg-green-700 transition-colors whitespace-nowrap"
          onClick={apply}
        >
          {destructive && confirming
            ? `Yes — remove ${plural(absent.length, 'song', 'songs')} and apply`
            : 'Apply import'}
        </button>
        <button
          className="px-4 py-1.5 text-xs font-bold bg-white text-gray-700 border border-gray-300 rounded hover:bg-gray-50 transition-colors"
          onClick={onCancel}
        >
          Cancel
        </button>
        {destructive && confirming && (
          <span role="status" className="text-xs text-red-600">
            This removes {plural(absent.length, 'song', 'songs')} from the setlist.
          </span>
        )}
      </div>
    </div>
  );
}
