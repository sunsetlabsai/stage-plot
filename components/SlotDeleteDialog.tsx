'use client';

import { useEffect } from 'react';

// The stage-slot delete prompt (UAT S8), shown only when inputs are linked to
// the slot. It replaced a window.confirm whose OK and Cancel BOTH deleted (OK
// kept the links, Cancel cleared them), so there was no way to back out. A
// native confirm has two buttons and this choice has three, hence a dialog.
//
// Extracted from the 7000-line show page for the same reason as SettingsOverlay:
// the page can't be rendered in a test, and "Cancel deletes nothing" is exactly
// the rule that broke silently (tests/slot-delete-dialog.test.tsx).
//
// Every way out that isn't one of the two delete buttons cancels: the Cancel
// button, a backdrop click, and Escape.

export function SlotDeleteDialog({
  slotName,
  linkedCount,
  onKeepLinks,
  onClearLinks,
  onCancel,
}: {
  slotName: string;
  linkedCount: number;
  onKeepLinks: () => void;
  onClearLinks: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const inputs = `${linkedCount} input${linkedCount === 1 ? '' : 's'}`;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Delete ${slotName}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onCancel}
    >
      <div
        className="bg-white rounded-xl shadow-2xl p-6 w-full max-w-sm mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-bold mb-2">Delete “{slotName}”?</h3>
        <p className="text-sm text-gray-600 mb-5">
          {inputs} {linkedCount === 1 ? 'is' : 'are'} linked to this slot.
        </p>
        <div className="flex flex-col gap-2">
          <button
            onClick={onKeepLinks}
            className="px-4 py-2 text-sm font-bold bg-black text-white rounded hover:bg-gray-800 transition-colors text-left"
          >
            Delete, keep the {inputs}{' '}
            <span className="block text-xs font-normal opacity-70">They are flagged so you can relink them.</span>
          </button>
          <button
            onClick={onClearLinks}
            className="px-4 py-2 text-sm font-bold bg-gray-100 text-gray-900 rounded hover:bg-gray-200 transition-colors border border-gray-300 text-left"
          >
            Delete, unlink the {inputs}{' '}
            <span className="block text-xs font-normal text-gray-500">They stay in the input list with no slot.</span>
          </button>
          <button
            autoFocus
            onClick={onCancel}
            className="px-4 py-2 text-sm font-bold text-gray-700 rounded hover:bg-gray-100 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
