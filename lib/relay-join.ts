// ── Conductor 3b chunk 5 → cloud-relay chunk 2: join/QR plumbing ──────────────
//
// (design-conductor-3b §3, superseded in part by design-relay-cloud.md §4 D4.)
// Pure helpers for the join flow. The QR/deep-link carries the SHOW URL plus a
// `join` code param (locked: the follower must land on the show page anyway —
// that's where the charts are). D4: the RELAY mints the room code (room ==
// code); client-side minting (mintRoomCode) and slug room naming (roomNameFor)
// are deleted — rooms are per-gig ephemera addressed by the minted code.

import type { SetlistSong } from './types';

// The RELAY's code alphabet (relay/relay-core.ts CODE_ALPHABET — S1: no
// 0/O/1/I; the can't-scan fallback is READ ALOUD across a stage, so every
// glyph must survive being shouted over a drummer). Kept in sync by test.
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 6;

/** Uppercase + strip to the code alphabet's shape; '' when hopeless. */
export function normalizeRoomCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, '').slice(0, ROOM_CODE_LENGTH);
}

export function isRoomCodeShaped(raw: string): boolean {
  return raw.length === ROOM_CODE_LENGTH && [...raw].every((c) => CODE_ALPHABET.includes(c));
}

/** The QR payload: the show page itself, carrying the join code (locked Q1). */
export function buildJoinUrl(origin: string, owner: string, slug: string, code: string): string {
  return `${origin}/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}?join=${encodeURIComponent(code)}`;
}

// ── switch-session chart navigation (doc §10-5: "auto-open activeSession's chart") ──
//
// The wire names the writer's chart by songRef (= its chart fileId). Mirroring
// requires the SAME chart identity (SessionKey), so the lookup is exact-fileId —
// a different-role chart of the same song deliberately does NOT match (it could
// never mirror; the honest outcome is the chartMismatch strip).
export function findChartForSongRef(
  setlist: SetlistSong[],
  songRef: string,
): { songIdx: number; chartIdx: number } | null {
  for (let songIdx = 0; songIdx < setlist.length; songIdx++) {
    const charts = setlist[songIdx].charts ?? [];
    const chartIdx = charts.findIndex((c) => c.fileId === songRef);
    if (chartIdx !== -1) return { songIdx, chartIdx };
  }
  return null;
}

// ── Device label persistence (locked Q3: account name prefill, join override) ──
// localStorage-backed so a band member types their name ONCE per device.

const LABEL_KEY = 'showrunr-device-label';

export function loadDeviceLabel(): string {
  try {
    return localStorage.getItem(LABEL_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveDeviceLabel(label: string): void {
  try {
    localStorage.setItem(LABEL_KEY, label);
  } catch {
    // Private mode etc. — the label just won't persist; not worth surfacing.
  }
}
