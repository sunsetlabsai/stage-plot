import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ROOM_CODE_LENGTH,
  buildJoinUrl,
  findChartForSongRef,
  isRoomCodeShaped,
  loadDeviceLabel,
  mintRoomCode,
  normalizeRoomCode,
  roomNameFor,
  saveDeviceLabel,
} from '../lib/relay-join';
import type { Chart, SetlistSong } from '../lib/types';

// ── Conductor 3b chunk 5: the join/QR helpers (design-conductor-3b §3) ────────
// Pure seams for the join flow: code minting/normalizing, the QR payload URL,
// room naming, the switch-session chart lookup, and the device-label store.

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

describe('mintRoomCode', () => {
  it('mints ROOM_CODE_LENGTH glyphs from the shout-proof alphabet (default RNG)', () => {
    const code = mintRoomCode();
    expect(code).toHaveLength(ROOM_CODE_LENGTH);
    for (const c of code) expect(ALPHABET).toContain(c);
  });

  it('is deterministic under an injected random source', () => {
    // random(max) = 0 always → first glyph of the alphabet repeated.
    expect(mintRoomCode(() => 0)).toBe('AAAA');
    expect(mintRoomCode((max) => max - 1)).toBe('9999');
  });

  it('never mints the ambiguous glyphs (0/O/1/I/L are excluded by design — D1)', () => {
    for (const bad of ['0', 'O', '1', 'I', 'L']) expect(ALPHABET).not.toContain(bad);
  });
});

describe('normalizeRoomCode / isRoomCodeShaped', () => {
  it('uppercases, strips junk, and clamps to the code length', () => {
    expect(normalizeRoomCode('ab-7x')).toBe('AB7X');
    expect(normalizeRoomCode('  w 9 q z extra')).toBe('W9QZ');
    expect(normalizeRoomCode('!!')).toBe('');
  });

  it('shapes: exactly 4 glyphs, all from the alphabet', () => {
    expect(isRoomCodeShaped('AB7X')).toBe(true);
    expect(isRoomCodeShaped('AB7')).toBe(false); // short
    expect(isRoomCodeShaped('AB7XZ')).toBe(false); // long
    expect(isRoomCodeShaped('AB0X')).toBe(false); // 0 not in alphabet
    expect(isRoomCodeShaped('ab7x')).toBe(false); // normalize first — shape is post-normalize
  });
});

describe('buildJoinUrl / roomNameFor', () => {
  it('carries the join code on the SHOW url (locked Q1 — no separate /join route)', () => {
    expect(buildJoinUrl('https://showrunr.ai', 'graham', 'spring-tour', 'AB7X')).toBe(
      'https://showrunr.ai/graham/spring-tour?join=AB7X',
    );
  });

  it('URL-encodes owner/slug/code', () => {
    expect(buildJoinUrl('https://x.test', 'gr aham', 'a/b', 'AB7X')).toBe(
      'https://x.test/gr%20aham/a%2Fb?join=AB7X',
    );
  });

  it('room name is the show identity — one conductor per show per owner is structural', () => {
    expect(roomNameFor('graham', 'spring-tour')).toBe('graham/spring-tour');
  });
});

describe('findChartForSongRef', () => {
  const chart = (fileId: string, role = 'Guitar'): Chart => ({ role, url: 'u', fileId });
  const song = (title: string, position: number, charts: Chart[]): SetlistSong => ({
    position,
    title,
    lead: '',
    charts,
  });
  const setlist: SetlistSong[] = [
    song('Opener', 1, [chart('f1')]),
    song('Ballad', 2, [chart('f2a', 'Lyrics'), chart('f2b')]),
    song('No charts', 3, []),
  ];

  it('finds the exact song+chart indices for a fileId', () => {
    expect(findChartForSongRef(setlist, 'f2b')).toEqual({ songIdx: 1, chartIdx: 1 });
    expect(findChartForSongRef(setlist, 'f1')).toEqual({ songIdx: 0, chartIdx: 0 });
  });

  it('returns null when no chart carries that fileId (mismatch strip is the honest outcome)', () => {
    expect(findChartForSongRef(setlist, 'nope')).toBeNull();
    expect(findChartForSongRef([], 'f1')).toBeNull();
  });

  it('tolerates songs without a charts array', () => {
    expect(findChartForSongRef([{ position: 1, title: 'X', lead: '' }], 'f1')).toBeNull();
  });
});

describe('device label store (locked Q3 — once per device)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('round-trips through localStorage when available', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    expect(loadDeviceLabel()).toBe('');
    saveDeviceLabel('Rachel');
    expect(loadDeviceLabel()).toBe('Rachel');
  });

  it('degrades to "" / no-op when storage is unavailable (private mode etc.)', () => {
    // node test env has no localStorage at all — the try/catch IS the seam.
    expect(loadDeviceLabel()).toBe('');
    expect(() => saveDeviceLabel('Rachel')).not.toThrow();
  });
});
