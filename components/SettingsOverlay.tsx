'use client';

import type { ReactNode } from 'react';

// The show-page settings modal (design-single-backend §3.1, chunk 4).
//
// Extracted from the AI-tab host for the same reason every other piece here was:
// the host is a 6700-line component no harness can render, and the modal's own
// behaviour — dismiss on backdrop, DON'T dismiss on an inside click, dismiss on the
// Close control — is exactly the kind of small thing that breaks silently. Pulling it
// out makes those three rules testable (tests/settings-overlay.test.tsx).
//
// It renders as a sibling of the still-mounted host, never a navigation: that is what
// keeps restored composer text and the transcript alive while settings are open (§9
// T21). The host passes the shared `ByoaKeySettings` as children.

export function SettingsOverlay({
  onClose,
  children,
}: {
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Claude API key settings"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4"
      onClick={onClose}
    >
      {/* stopPropagation so a click INSIDE the panel does not bubble to the backdrop
          and dismiss the modal mid-edit — the classic modal footgun. */}
      <div
        className="w-full max-w-2xl my-8 bg-zinc-950 text-white rounded-lg p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold">Settings</h2>
          <button onClick={onClose} className="text-sm text-zinc-400 hover:text-white">
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
