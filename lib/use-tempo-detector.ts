'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  HOP_MS,
  ANALYSIS_PERIOD_MS,
  FFT_SIZE,
  ENVELOPE_SEC,
  ENVELOPE_CAPACITY,
  BPM_MIN,
  BPM_MAX,
  spectralFlux,
  autocorrelateTempo,
  regridOntoHop,
} from './tempo-detect';
import type { TempoTelemetry } from './tempo-telemetry';

// ── Conductor 5b, chunk 4a: the tempo detector's IO shell (the ONLY Web-Audio surface) ─
//
// (design-conductor-chunk5b-c4-live.md §2.2.) A thin hook owning the audio-graph
// lifecycle. It NEVER holds clock state — it only produces TempoTelemetry through a
// callback, which the conductor hook writes into its synchronous telemetryRef. enable()
// MUST be called from a user gesture (the chunk-0 iOS lesson). All DSP is the pure core
// (lib/tempo-detect.ts); this file only acquires the mic, polls the AnalyserNode onto the
// HOP_MS grid (the MEDIUM-2 re-grid), and tears the stream down on disable/unmount.
//
// Privacy: audio is processed IN-PROCESS and never leaves the device; the MediaStream is
// held only while detection is on and released (tracks stopped, context closed) on
// disable/unmount; enabling is an explicit, revocable MD action.

export type TempoDetectorStatus = 'off' | 'requesting' | 'running' | 'denied' | 'error';

export interface UseTempoDetectorArgs {
  // The octave-fold prior — the stated song tempo when present (null ⇒ band-centre default).
  prefer: number | null;
  // Synchronous sink for each emitted estimate. The conductor hook's handler writes its
  // telemetryRef synchronously here (§3 — the time-axis invariant).
  onTelemetry: (t: TempoTelemetry) => void;
}

export interface TempoDetectorControl {
  status: TempoDetectorStatus;
  lastError: string | null;
  enable: () => Promise<void>; // gesture-gated (iOS): call from a click handler
  disable: () => void; // idempotent
}

type WindowWithWebkitAudio = Window & { webkitAudioContext?: typeof AudioContext };

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : '';
}
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function useTempoDetector(args: UseTempoDetectorArgs): TempoDetectorControl {
  const [status, setStatus] = useState<TempoDetectorStatus>('off');
  const [lastError, setLastError] = useState<string | null>(null);

  // Live callback + prior (the frozen poll closure reads them through refs).
  const onTelemetryRef = useRef(args.onTelemetry);
  const preferRef = useRef(args.prefer);
  useEffect(() => {
    onTelemetryRef.current = args.onTelemetry;
  }, [args.onTelemetry]);
  useEffect(() => {
    preferRef.current = args.prefer;
  }, [args.prefer]);

  // Audio-graph + analysis refs (no React state — the poll is a free-running macrotask).
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const intervalRef = useRef<number | null>(null);
  const freqBufRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const prevMagRef = useRef<Float32Array | null>(null);
  const framesRef = useRef<{ tMs: number; flux: number }[]>([]);
  const lastAnalysisMsRef = useRef(0);
  const epochRef = useRef(0); // bumped on each (re)start — the telemetry incarnation watermark
  const seqRef = useRef(0); // per-incarnation monotonic

  // Free everything (idempotent). Status is set by the CALLER (disable ⇒ 'off'; an
  // acquire error keeps its 'denied'/'error' status).
  const release = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    try {
      sourceRef.current?.disconnect();
    } catch {
      /* already disconnected */
    }
    sourceRef.current = null;
    analyserRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop()); // release the mic (OS indicator off)
    streamRef.current = null;
    const ctx = ctxRef.current;
    ctxRef.current = null;
    if (ctx && ctx.state !== 'closed') void ctx.close();
    freqBufRef.current = null;
    prevMagRef.current = null;
    framesRef.current = [];
  }, []);

  // One poll: read the spectrum, accumulate a timestamped flux frame, and — every
  // ANALYSIS_PERIOD_MS — re-grid the rolling window onto the HOP_MS grid and emit an
  // estimate. Reads only refs (stable across the frozen interval closure).
  const poll = useCallback(() => {
    const ctx = ctxRef.current;
    const analyser = analyserRef.current;
    const buf = freqBufRef.current;
    if (!ctx || !analyser || !buf) return;
    analyser.getFloatFrequencyData(buf);
    const tMs = ctx.currentTime * 1000; // the audio clock — even, jitter-free (the MEDIUM-2 stamp)

    const prev = prevMagRef.current;
    if (prev) framesRef.current.push({ tMs, flux: spectralFlux(prev, buf) });
    prevMagRef.current = Float32Array.from(buf); // copy — getFloatFrequencyData reuses buf

    // Trim the rolling window to ENVELOPE_SEC.
    const windowStartMs = tMs - ENVELOPE_SEC * 1000;
    if (framesRef.current.length > 0 && framesRef.current[0].tMs < windowStartMs) {
      framesRef.current = framesRef.current.filter((f) => f.tMs >= windowStartMs);
    }

    if (tMs - lastAnalysisMsRef.current < ANALYSIS_PERIOD_MS) return;
    lastAnalysisMsRef.current = tMs;

    const frames = framesRef.current;
    if (frames.length < ENVELOPE_CAPACITY / 2) return; // not enough history yet
    const grid = regridOntoHop(frames, HOP_MS, windowStartMs, ENVELOPE_CAPACITY);
    const est = autocorrelateTempo(grid, HOP_MS, {
      prefer: preferRef.current ?? undefined,
      bpmMin: BPM_MIN,
      bpmMax: BPM_MAX,
    });
    if (!(est.bpmFolded > 0)) return;
    seqRef.current += 1;
    onTelemetryRef.current({
      tempoBpm: est.bpmFolded,
      confidence: est.confidence,
      ageMsAtSend: 0, // in-process MD-mic — producer and consumer share the event loop (§3)
      listenerId: 'md-mic',
      telemetryEpoch: epochRef.current,
      seq: seqRef.current,
    });
  }, []);

  const enable = useCallback(async () => {
    if (intervalRef.current !== null) return; // already running — idempotent
    setLastError(null);
    setStatus('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // Raw signal — the DSP wants the unprocessed mic (§2.2).
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      streamRef.current = stream;
      const Ctor = window.AudioContext ?? (window as WindowWithWebkitAudio).webkitAudioContext;
      if (!Ctor) throw new Error('Web Audio unsupported');
      const ctx = new Ctor();
      await ctx.resume();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      source.connect(analyser); // NOT to destination — no monitoring, no feedback loop
      ctxRef.current = ctx;
      sourceRef.current = source;
      analyserRef.current = analyser;
      freqBufRef.current = new Float32Array(analyser.frequencyBinCount);
      prevMagRef.current = null;
      framesRef.current = [];
      lastAnalysisMsRef.current = ctx.currentTime * 1000;
      epochRef.current += 1; // new incarnation ⇒ ingest resets its accepted-seq watermark (§3)
      seqRef.current = 0;
      intervalRef.current = window.setInterval(poll, HOP_MS);
      setStatus('running');
    } catch (e) {
      release();
      const name = errorName(e);
      setStatus(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'error');
      setLastError(errorMessage(e));
    }
  }, [poll, release]);

  const disable = useCallback(() => {
    release();
    setStatus('off');
    setLastError(null);
  }, [release]);

  // Release on unmount (mic indicator off even if the MD never tapped disable).
  useEffect(() => release, [release]);

  return { status, lastError, enable, disable };
}
