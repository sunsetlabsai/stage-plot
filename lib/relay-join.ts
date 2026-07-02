// ── Conductor 3b chunk 5: join/QR plumbing (design-conductor-3b §3, §10-5) ────
//
// Pure helpers for the join flow. The QR/deep-link carries the SHOW URL plus a
// `join` code param (locked over D1's separate /join route: the follower must
// land on the show page anyway — that's where the charts are). Room identity is
// `${owner}/${slug}` (matches the sessionId convention), so "one conductor per
// show per owner" is structural, not policy.

import type { SetlistSong } from './types';

// Code alphabet: no 0/O/1/I/L — the can't-scan fallback is READ ALOUD across a
// stage (D1), so every glyph must survive being shouted over a drummer.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 4;

/** Mint a rotating room code (D3: generated at room-create, per show). */
export function mintRoomCode(
  random: (max: number) => number = (max) => {
    // crypto when available (browser + node); modulo bias is irrelevant at 31 glyphs.
    const buf = new Uint32Array(1);
    globalThis.crypto.getRandomValues(buf);
    return buf[0] % max;
  },
): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += CODE_ALPHABET[random(CODE_ALPHABET.length)];
  return code;
}

/** Uppercase + strip to the code alphabet's shape; '' when hopeless. */
export function normalizeRoomCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, ROOM_CODE_LENGTH);
}

export function isRoomCodeShaped(raw: string): boolean {
  return raw.length === ROOM_CODE_LENGTH && [...raw].every((c) => CODE_ALPHABET.includes(c));
}

/** The QR payload: the show page itself, carrying the join code (locked Q1). */
export function buildJoinUrl(origin: string, owner: string, slug: string, code: string): string {
  return `${origin}/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}?join=${encodeURIComponent(code)}`;
}

/** Room name = show identity (doc §3; one conductor per show per owner). */
export function roomNameFor(owner: string, slug: string): string {
  return `${owner}/${slug}`;
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
