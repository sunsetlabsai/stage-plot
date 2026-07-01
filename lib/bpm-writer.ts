// ── Conductor UX-polish §3: the canonical-BPM write path ─────────────────────
//
// TapTempo emits on every valid keystroke, nudge, and tap, and each emit becomes
// a PUT against the canonical song row. Two failure modes fall out of that
// (Codex BUILD review on a3b29b3, both HIGH):
//
//   1. A failed/rejected PUT left the parent bpm untouched, but TapTempo's local
//      text kept the new value (its resync only fires on a PROP change) — visible
//      tempo diverged from what Perform/DB actually use.
//   2. Two quick writes (130 then 140) could resolve out of order and patch the
//      older bpm last, leaving local state or the DB at the wrong tempo.
//
// Fix, one mechanism: optimistic patch + latest-request-wins + revert-to-confirmed.
//   - Patch local state immediately (so the row, Perform, and nudge-from-parent
//     all read the new tempo without waiting on the network).
//   - Abort any in-flight PUT for the same song; only the LATEST request may
//     finalize (older responses — success, failure, or abort — are ignored).
//   - Track the last server-CONFIRMED bpm per song (seeded from current state on
//     first write). If the latest write fails, patch back to it — the prop change
//     re-fires TapTempo's resync, so the text box snaps back too. No silent
//     divergence, no stale optimistic state.

export type BpmWriter = (songId: string, bpm: number | null) => Promise<void>;

export function createBpmWriter({
  put,
  getCurrent,
  patch,
}: {
  /** Send the write; resolve true on 2xx. May reject (network) or be aborted. */
  put: (songId: string, bpm: number | null, signal: AbortSignal) => Promise<boolean>;
  /** Read the song's current bpm from live state (used once, to seed confirmed). */
  getCurrent: (songId: string) => number | null;
  /** Patch the song's bpm in live state (by songId, never row index). */
  patch: (songId: string, bpm: number | null) => void;
}): BpmWriter {
  const controllers = new Map<string, AbortController>();
  // Last bpm the server acknowledged for each song. Seeded lazily from current
  // state (which came from the DB) the first time a song is written.
  const confirmed = new Map<string, number | null>();

  return async function write(songId: string, bpm: number | null) {
    if (!confirmed.has(songId)) confirmed.set(songId, getCurrent(songId));

    // Latest-wins: cancel the in-flight write (its handler sees itself superseded
    // below and does nothing — this request now owns the outcome for this song).
    controllers.get(songId)?.abort();
    const controller = new AbortController();
    controllers.set(songId, controller);

    patch(songId, bpm); // optimistic

    let ok = false;
    try {
      ok = await put(songId, bpm, controller.signal);
    } catch {
      ok = false; // network error or abort — treated below
    }

    // Superseded while in flight → a newer write owns the outcome; stay silent.
    if (controllers.get(songId) !== controller) return;
    controllers.delete(songId);

    if (ok) {
      confirmed.set(songId, bpm);
    } else {
      // Honest revert: back to the last tempo the server acknowledged.
      patch(songId, confirmed.get(songId) ?? null);
    }
  };
}
