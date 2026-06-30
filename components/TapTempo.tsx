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
  // Raw text mirrors the number input so a half-typed/out-of-range value ('' or
  // '1' or '1500') doesn't clamp under the user's cursor; valid in-range input is
  // synced to the parent live (so Enter submits it), and blur clamps the rest.
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

  // The AudioContext is created/resumed inside the Play tap (below) — iOS/Safari
  // only let audio start from a trusted gesture, so it CANNOT be born in an effect.
  // It lives here so the scheduler reuses one context across tempo changes.
  const audioRef = useRef<AudioContext | null>(null);

  // ── Web Audio click ────────────────────────────────────────────────────────
  // Standard lookahead scheduler (a 25ms timer schedules clicks up to ~100ms out
  // against the audio clock) so the metronome doesn't drift with setInterval
  // jitter. Runs only while `playing`, a valid bpm is set, and the context (made
  // in the Play gesture) exists.
  useEffect(() => {
    if (!playing || bpm == null || !isValidBpm(bpm)) return;
    const ctx = audioRef.current;
    if (!ctx) return;

    const spb = beatMs(bpm) / 1000; // seconds per beat
    let beat = 0;                   // beat index within the bar (0 = downbeat)
    let nextNoteTime = ctx.currentTime + 0.05;

    function click(time: number, accent: boolean) {
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.frequency.value = accent ? 1500 : 1000;
      gain.gain.setValueAtTime(accent ? 0.5 : 0.3, time);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
      osc.connect(gain).connect(ctx!.destination);
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

    return () => clearInterval(timer);
  }, [playing, bpm, barBeats]);

  // Tear the context down on unmount only (empty deps → no setState in effect).
  useEffect(() => () => {
    audioRef.current?.close();
    audioRef.current = null;
  }, []);

  function togglePlay() {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (bpm == null || !isValidBpm(bpm)) return;
    // Create/resume the context synchronously in this trusted tap so iOS/Safari
    // actually emit sound; the scheduler effect then drives this same context.
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!audioRef.current) audioRef.current = new Ctx();
    if (audioRef.current.state === 'suspended') void audioRef.current.resume();
    setPlaying(true);
  }

  // Drop the stated tempo entirely — also stop the click and reset taps so a later
  // tap/type can't silently resume a metronome the user thought they'd cleared.
  function clearBpm() {
    setPlaying(false);
    tapsRef.current = [];
    onChange(null);
  }

  function handleTextChange(raw: string) {
    setText(raw);
    const trimmed = raw.trim();
    if (trimmed === '') {
      clearBpm();
      return;
    }
    const n = Number(trimmed);
    // Sync valid, in-range input to the parent immediately so Enter (form submit)
    // never saves a stale/null tempo. Partial or out-of-range stays local until blur.
    if (isValidBpm(n)) onChange(n);
  }

  // Enter in the bpm field commits/clamps the typed value rather than letting the
  // form submit a stale parent bpm (e.g. typing 401 over null/120 then hitting
  // Enter without blurring). We suppress the implicit submit so the clamped tempo
  // lands first; the user submits the form from the Save button or another field.
  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitText(e.currentTarget.value);
    }
  }

  function commitText(raw: string) {
    const trimmed = raw.trim();
    if (trimmed === '') {
      clearBpm();
      return;
    }
    const n = Number(trimmed);
    if (Number.isFinite(n)) {
      onChange(clampBpm(n));
    } else {
      // Non-finite garbage ('1e', '-', 'abc') → discard it and snap the field back
      // to the committed value, so a visible invalid edit can never save the stale
      // parent bpm out from under the user.
      setText(bpm == null ? '' : String(bpm));
    }
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
        onChange={(e) => handleTextChange(e.target.value)}
        onKeyDown={handleKeyDown}
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
        onClick={togglePlay}
        disabled={!valid}
        className="w-8 h-8 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 hover:border-zinc-600 disabled:opacity-40 transition-colors"
        aria-label={playing && valid ? 'Stop click' : 'Play click'}
      >
        {playing && valid ? '■' : '▶'}
      </button>
      {bpm != null && (
        <button
          type="button"
          onClick={clearBpm}
          className="text-xs text-zinc-600 hover:text-red-400 transition-colors"
        >
          Clear
        </button>
      )}
    </div>
  );
}
