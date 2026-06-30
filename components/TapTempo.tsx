'use client';

// ── Conductor clock, chunk 5b chunk-0: the stated-tempo editor ───────────────
//
// Set / audition a song's stated tempo. Three ways to land a bpm: type it, nudge
// ±1, or tap it out. A play toggle runs a Web Audio click off that tempo (accenting
// the downbeat every `barBeats` beats per §5.5) so the owner can hear it before
// committing. All bpm values pass through clampBpm/isValidBpm so the control can
// never hold a value the column (012) would reject. Emits the chosen bpm (or null
// when cleared) up to the form via onChange.

import { useEffect, useRef, useState } from 'react';
import {
  MIN_BPM,
  MAX_BPM,
  DEFAULT_BAR_BEATS,
  isValidBpm,
  clampBpm,
  beatMs,
  tapTempoToBpm,
} from '@/lib/tempo';

// A fresh tap series starts once taps go quiet for this long (a new count-in).
const TAP_RESET_MS = 2000;

export default function TapTempo({
  bpm,
  onChange,
  barBeats = DEFAULT_BAR_BEATS,
}: {
  bpm: number | null;
  onChange: (bpm: number | null) => void;
  barBeats?: number;
}) {
  // Raw text mirrors the number input so a half-typed value ('' or '1') doesn't
  // immediately clamp under the user's cursor; we commit/clamp on change + blur.
  const [text, setText] = useState(bpm == null ? '' : String(bpm));
  const [playing, setPlaying] = useState(false);
  const tapsRef = useRef<number[]>([]);

  // Resync the text box when the parent swaps the bpm out from under us (tap/nudge
  // result, or an external reset). React's adjust-state-during-render pattern —
  // not an effect — so the box reflects the new value in the same commit.
  const [prevBpm, setPrevBpm] = useState(bpm);
  if (bpm !== prevBpm) {
    setPrevBpm(bpm);
    setText(bpm == null ? '' : String(bpm));
  }

  // ── Web Audio click ────────────────────────────────────────────────────────
  // Standard lookahead scheduler (set a 25ms timer, schedule clicks up to ~100ms
  // out against the audio clock) so the metronome doesn't drift with setInterval
  // jitter. Only runs while `playing` and a valid bpm is set.
  const audioRef = useRef<AudioContext | null>(null);
  useEffect(() => {
    if (!playing || bpm == null || !isValidBpm(bpm)) return;

    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    audioRef.current = ctx;

    const spb = beatMs(bpm) / 1000; // seconds per beat
    let beat = 0;                   // beat index within the bar (0 = downbeat)
    let nextNoteTime = ctx.currentTime + 0.05;

    function click(time: number, accent: boolean) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = accent ? 1500 : 1000;
      gain.gain.setValueAtTime(accent ? 0.5 : 0.3, time);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
      osc.connect(gain).connect(ctx.destination);
      osc.start(time);
      osc.stop(time + 0.05);
    }

    const timer = setInterval(() => {
      while (nextNoteTime < ctx.currentTime + 0.1) {
        click(nextNoteTime, beat % barBeats === 0);
        nextNoteTime += spb;
        beat += 1;
      }
    }, 25);

    return () => {
      clearInterval(timer);
      ctx.close();
      audioRef.current = null;
    };
  }, [playing, bpm, barBeats]);

  function commitText(raw: string) {
    const trimmed = raw.trim();
    if (trimmed === '') {
      onChange(null);
      return;
    }
    const n = Number(trimmed);
    if (Number.isFinite(n)) onChange(clampBpm(n));
  }

  function nudge(delta: number) {
    onChange(clampBpm((bpm ?? 120) + delta));
  }

  function tap() {
    const now = performance.now();
    const taps = tapsRef.current;
    if (taps.length > 0 && now - taps[taps.length - 1] > TAP_RESET_MS) {
      taps.length = 0; // gone quiet → start a fresh count-in
    }
    taps.push(now);
    const next = tapTempoToBpm(taps);
    if (next != null) onChange(next);
  }

  const valid = bpm != null && isValidBpm(bpm);

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-zinc-500 uppercase tracking-wide">Tempo</span>
      <button
        type="button"
        onClick={() => nudge(-1)}
        disabled={bpm == null}
        className="w-7 h-7 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 hover:border-zinc-600 disabled:opacity-40 transition-colors"
        aria-label="Decrease tempo"
      >
        −
      </button>
      <input
        type="number"
        inputMode="numeric"
        min={MIN_BPM}
        max={MAX_BPM}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commitText(e.target.value)}
        placeholder="—"
        className="w-16 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white text-center outline-none focus:border-blue-500"
      />
      <span className="text-xs text-zinc-500">bpm</span>
      <button
        type="button"
        onClick={() => nudge(1)}
        disabled={bpm == null}
        className="w-7 h-7 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 hover:border-zinc-600 disabled:opacity-40 transition-colors"
        aria-label="Increase tempo"
      >
        +
      </button>
      <button
        type="button"
        onClick={tap}
        className="px-3 py-1.5 rounded bg-zinc-800 border border-zinc-700 text-sm text-zinc-300 hover:border-zinc-600 transition-colors"
      >
        Tap
      </button>
      <button
        type="button"
        onClick={() => setPlaying((p) => !p)}
        disabled={!valid}
        className="w-8 h-8 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 hover:border-zinc-600 disabled:opacity-40 transition-colors"
        aria-label={playing && valid ? 'Stop click' : 'Play click'}
      >
        {playing && valid ? '■' : '▶'}
      </button>
      {bpm != null && (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="text-xs text-zinc-600 hover:text-red-400 transition-colors"
        >
          Clear
        </button>
      )}
    </div>
  );
}
