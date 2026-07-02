import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ROOM_CODE_LENGTH,
  buildJoinUrl,
  findChartForSongRef,
  isRoomCodeShaped,
  loadDeviceLabel,
  normalizeRoomCode,
  saveDeviceLabel,
} from '../lib/relay-join';
import { CODE_ALPHABET, CODE_LEN } from '../relay/relay-core';
import type { Chart, SetlistSong } from '../lib/types';

// ── cloud-relay chunk 2: the join/QR helpers ─────────────────────────────────
// D4: the RELAY mints room codes (room == code); the client only normalizes,
// shape-checks, and builds the QR payload. mintRoomCode/roomNameFor are gone.

describe('room code shape (relay-minted, D4)', () => {
  it('client shape constants stay in sync with the relay minting rules', () => {
    expect(ROOM_CODE_LENGTH).toBe(CODE_LEN);
    // Every relay glyph must survive normalize + shape-check round-trip.
    for (const c of CODE_ALPHABET) {
      const code = c.repeat(ROOM_CODE_LENGTH);
      expect(normalizeRoomCode(code.toLowerCase())).toBe(code);
      expect(isRoomCodeShaped(code)).toBe(true);
    }
  });

  it('the alphabet excludes the shout-ambiguous glyphs 0/O/1/I (S1)', () => {
    for (const bad of ['0', 'O', '1', 'I']) {
      expect(CODE_ALPHABET).not.toContain(bad);
      expect(isRoomCodeShaped(`${bad}B7XQ2`)).toBe(false);
      expect(normalizeRoomCode(`${bad}B7XQ2W`)).toBe('B7XQ2W');
    }
  });

  it('uppercases, strips junk, and clamps to the code length', () => {
    expect(normalizeRoomCode('ab-7xq2')).toBe('AB7XQ2');
    expect(normalizeRoomCode('  w 9 q z 2 3 extra')).toBe('W9QZ23');
    expect(normalizeRoomCode('!!')).toBe('');
  });

  it('shapes: exactly ROOM_CODE_LENGTH glyphs, all from the alphabet', () => {
    expect(isRoomCodeShaped('AB7XQ2')).toBe(true);
    expect(isRoomCodeShaped('AB7XQ')).toBe(false); // short
    expect(isRoomCodeShaped('AB7XQ2Z')).toBe(false); // long
    expect(isRoomCodeShaped('AB0XQ2')).toBe(false); // 0 not in alphabet
    expect(isRoomCodeShaped('ab7xq2')).toBe(false); // normalize first — shape is post-normalize
  });
});

describe('buildJoinUrl', () => {
  it('carries the join code on the SHOW url (locked Q1 — no separate /join route)', () => {
    expect(buildJoinUrl('https://showrunr.ai', 'graham', 'spring-tour', 'AB7XQ2')).toBe(
      'https://showrunr.ai/graham/spring-tour?join=AB7XQ2',
    );
  });

  it('URL-encodes owner/slug/code', () => {
    expect(buildJoinUrl('https://x.test', 'gr aham', 'a/b', 'AB7XQ2')).toBe(
      'https://x.test/gr%20aham/a%2Fb?join=AB7XQ2',
    );
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
