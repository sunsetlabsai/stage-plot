'use client';

// ── Share button (chart viewer header + setlist header) ──────────────────────
// Icon-only (iPhone header crowding is a live complaint). Runs the tiered
// share from lib/share; the only UI of its own is the tier-3 "Link copied"
// chip (share-sheet tiers are self-evident) and a "Couldn't share" on total
// failure. `buildUrl` is called at click time so window.location is safe.

import { useEffect, useRef, useState } from 'react';
import { performShare } from '@/lib/share';

export default function ShareButton({
  title,
  buildUrl,
  getFile,
  className = '',
}: {
  title: string;
  buildUrl: () => string;
  getFile?: () => Promise<File | null>;
  className?: string;
}) {
  const [feedback, setFeedback] = useState<'copied' | 'failed' | null>(null);
  const [busy, setBusy] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const flash = (kind: 'copied' | 'failed') => {
    setFeedback(kind);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setFeedback(null), 2000);
  };

  const onShare = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const outcome = await performShare({ title, url: buildUrl(), getFile });
      if (outcome === 'clipboard') flash('copied');
      else if (outcome === 'failed') flash('failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`relative ${className}`}>
      <button
        type="button"
        onClick={onShare}
        disabled={busy}
        aria-label="Share"
        title="Share"
        className="w-8 h-7 flex items-center justify-center rounded bg-zinc-800 text-zinc-300 hover:text-white transition-colors disabled:opacity-50"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 12v7a2 2 0 002 2h12a2 2 0 002-2v-7M16 6l-4-4-4 4M12 2v13" />
        </svg>
      </button>
      {feedback && (
        <span
          role="status"
          className={`absolute top-full right-0 mt-1.5 px-2 py-1 rounded text-[10px] font-bold whitespace-nowrap z-50 ${
            feedback === 'copied' ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-300'
          }`}
        >
          {feedback === 'copied' ? 'Link copied' : "Couldn't share"}
        </span>
      )}
    </div>
  );
}
