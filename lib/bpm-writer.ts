// ── Conductor UX-polish §3: the canonical-BPM write path ─────────────────────
//
// TapTempo emits on every valid keystroke, nudge, and tap, and each emit becomes
// a PUT against the canonical song row. Codex BUILD reviews (R1 on a3b29b3, R2 on
// 53d1e05) found the naive fire-per-emit path dishonest twice over:
//
//   1. A failed/rejected PUT left the parent bpm untouched while TapTempo's local
//      text kept the new value — visible tempo diverged from what Perform/DB use.
//   2. Concurrent PUTs give no ordering guarantee. Client-side abort is NOT enough
//      (R2): the server may already have received the older request, so "130 then
//      140" can still commit as 140-then-130 in the DB even if the client ignores
//      the older response.
//
// Fix: optimistic patch + PER-SONG SERIALIZE/COALESCE + revert-to-confirmed.
//   - Patch local state immediately (the row, Perform, and nudge-from-parent all
//     read the new tempo without waiting on the network).
//   - At most ONE PUT in flight per song. While one is in flight, newer intents
//     coalesce into a single "latest pending" value; it is sent only after the
//     in-flight request SETTLES. The server therefore receives this client's
//     writes for a song strictly in order — no out-of-order commit window.
//   - Track the last server-ACKed bpm per song (seeded from current state on
//     first write). When the FINAL settled write fails with nothing newer queued,
//     patch back to it — the prop change re-fires TapTempo's resync, so the text
//     box snaps back too. An intermediate failure with a newer intent queued does
//     NOT revert (the newer write owns the visible outcome).
//
// Lifetime (R2 HIGH-2): create ONE writer per show session — in Page(), not in a
// remounting tab — so the in-flight chain and confirmed map survive tab switches
// and the confirmed seed always derives from server-loaded state.

export type BpmWriter = (songId: string, bpm: number | null) => Promise<void>;

export function createBpmWriter({
  put,
  getCurrent,
  patch,
}: {
  /** Send the write; resolve true on 2xx. May reject (network error). */
  put: (songId: string, bpm: number | null) => Promise<boolean>;
  /** Read the song's current bpm from live state (used once, to seed confirmed). */
  getCurrent: (songId: string) => number | null;
  /** Patch the song's bpm in live state (by songId, never row index). */
  patch: (songId: string, bpm: number | null) => void;
}): BpmWriter {
  // Songs with a PUT chain currently running. Value = the coalesced latest intent
  // to send next, or absent when nothing newer arrived while in flight.
  const running = new Set<string>();
  const pending = new Map<string, number | null>();
  // Last bpm the server acknowledged for each song. Seeded lazily from current
  // state (which came from the DB) the first time a song is written.
  const confirmed = new Map<string, number | null>();

  return async function write(songId: string, bpm: number | null) {
    if (!confirmed.has(songId)) confirmed.set(songId, getCurrent(songId));

    patch(songId, bpm); // optimistic

    if (running.has(songId)) {
      // Serialize: a PUT is in flight — coalesce to the latest intent and let the
      // running chain send it after the in-flight request settles.
      pending.set(songId, bpm);
      return;
    }

    running.add(songId);
    let value = bpm;
    try {
      for (;;) {
        let ok = false;
        try {
          ok = await put(songId, value);
        } catch {
          ok = false; // network error — handled below
        }
        if (ok) confirmed.set(songId, value);

        if (pending.has(songId)) {
          // A newer intent arrived while that request was in flight — it owns the
          // outcome now (so no revert here even on failure). Send it next.
          value = pending.get(songId)!;
          pending.delete(songId);
          continue;
        }

        if (!ok) {
          // Final settled write failed and nothing newer is queued: honest revert
          // to the last tempo the server acknowledged.
          patch(songId, confirmed.get(songId) ?? null);
        }
        return;
      }
    } finally {
      running.delete(songId);
    }
  };
}
