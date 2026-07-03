'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

// ── Conductor 3b chunk 5: the QR overlay (design-conductor-3b §3 D1/D3) ───────
//
// Shown from the LIVE cluster's room chip (and on go-live). The QR encodes the
// show URL + join code (locked Q1); the 4-char code in large type is the
// can't-scan fallback. Dismissable anywhere — conducting is never blocked
// behind it.

export interface RelayQrOverlayProps {
  joinUrl: string;
  code: string;
  onClose: () => void;
}

// The go-live INTERIM state: the create is in flight, no room code yet. Unlike
// the QR overlay this does NOT dismiss on a backdrop tap — the tap that
// submitted "Go live" can land a synthesized click on the freshly-mounted
// backdrop and silently kill the dialog (the UAT "nothing happens" failure).
// The explicit Hide button is the only dismissal; the cluster's connecting
// chip re-opens it, so hiding is never a dead end.
export function RelayConnectingOverlay({ onHide }: { onHide: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center"
      role="dialog"
      aria-label="Follow this performance"
    >
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 w-80 text-center space-y-3">
        <div className="text-sm font-bold text-white">Follow this performance</div>
        <div className="inline-flex items-center gap-2 text-xs text-amber-500">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
          getting a room code&hellip;
        </div>
        <button
          onClick={onHide}
          className="w-full py-2 rounded bg-zinc-800 text-zinc-200 text-xs hover:bg-zinc-700"
        >
          Hide
        </button>
      </div>
    </div>
  );
}

export default function RelayQrOverlay({ joinUrl, code, onClose }: RelayQrOverlayProps) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(joinUrl, { margin: 1, width: 440, errorCorrectionLevel: 'M' })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        // The large-type code below IS the fallback — no QR, still joinable.
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [joinUrl]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center"
      onClick={onClose}
      role="dialog"
      aria-label="Follow this performance"
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 w-80 text-center space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-bold text-white">Follow this performance</div>
        {qrDataUrl && (
          // Data-URL QR, rendered locally — next/image adds nothing here.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={qrDataUrl} alt={`QR code to join: ${joinUrl}`} className="mx-auto w-[220px] h-[220px] rounded" />
        )}
        <div>
          <div className="text-[11px] uppercase tracking-wide text-zinc-500">
            {qrDataUrl ? 'or enter room code' : 'room code'}
          </div>
          <div className="font-mono text-4xl font-bold tracking-[0.3em] text-white mt-1">{code}</div>
        </div>
        <div className="text-xs text-zinc-500">
          Scan with a phone camera &mdash; opens straight into the show.
        </div>
        <button
          onClick={onClose}
          className="w-full py-2 rounded bg-zinc-800 text-zinc-200 text-xs hover:bg-zinc-700"
        >
          Done
        </button>
      </div>
    </div>
  );
}
