// ── Chart-PDF share + deep link (design: share-pdf, approved 2026-07-03) ─────
//
// Pure helpers for the share buttons (chart viewer header + setlist header).
// Three-tier fallback, decided from the CAPABILITIES the device actually has:
//   1. Web Share Level 2 (files)  → share the PDF itself
//   2. Web Share Level 1 (url)    → share the deep link
//   3. clipboard                  → copy the deep link, caller shows "Link copied"
// The tier decision and the filename/URL builders are pure (unit-tested);
// `performShare` is the thin navigator wrapper the buttons call.

import type { SetlistSong } from './types';

export type ShareTier = 'file' | 'url' | 'clipboard';

/** Pure tier decision from device capabilities. */
export function decideShareTier(caps: { canShareFile: boolean; canShareUrl: boolean }): ShareTier {
  if (caps.canShareFile) return 'file';
  if (caps.canShareUrl) return 'url';
  return 'clipboard';
}

/**
 * "{Song Title} – {Role}.pdf", scrubbed of filesystem-hostile characters.
 * (The en-dash is deliberate — it survives every target filesystem and reads
 * better than a hyphen on the share sheet.)
 */
export function chartShareFilename(songTitle: string, role: string): string {
  const scrub = (s: string) =>
    s
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/[\u0000-\u001f]/g, '')
      .trim();
  return `${scrub(songTitle) || 'Chart'} – ${scrub(role) || 'Chart'}.pdf`;
}

/**
 * The chart deep link: show URL + ?song=POSITION&sid=SONG_ID&chart=ROLE.
 *
 * ★ UAT S6. The link used to carry only the setlist POSITION, so after a reorder
 * it opened whichever song had moved into that slot, with no error. It now
 * carries the canonical `songId` too, and the parser matches on that. Not the
 * setlist ROW id: `rpc_save_show` deletes and re-inserts every setlist_entries
 * row on each save (006), so a row id does not outlive the next edit. `songId`
 * does — but it is not unique within a setlist (nothing stops a reprise), so the
 * position stays in the link as the tie-break. An inline song with no `songId`
 * gets a position-only link, the same as before.
 */
export function buildChartShareUrl(
  origin: string,
  owner: string,
  slug: string,
  song: Pick<SetlistSong, 'position' | 'songId'>,
  role: string,
): string {
  const sid = song.songId ? `&sid=${encodeURIComponent(song.songId)}` : '';
  return `${buildShowShareUrl(origin, owner, slug)}?song=${encodeURIComponent(String(song.position))}${sid}&chart=${encodeURIComponent(role)}`;
}

/** The show-level share: the bare show URL. */
export function buildShowShareUrl(origin: string, owner: string, slug: string): string {
  return `${origin}/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`;
}

/** What a chart deep link resolves to against the setlist as it is NOW. */
export type ChartDeepLink =
  | { kind: 'song'; songIdx: number; role: string | null }
  /** The linked song is no longer in this setlist — say so, don't open a stranger. */
  | { kind: 'gone' };

/**
 * Parse ?song=N[&sid=ID]&chart=ROLE against the setlist.
 *
 * With `sid` (links built since S6): match the song by `songId`. If it appears
 * more than once, prefer the copy at position N, else the first. Not present ⇒
 * 'gone' — the sender's song was removed, and position N is now some other song.
 *
 * Without `sid` (older links, and inline songs that have no `songId`): position
 * is all there is, so N matches song.position as before.
 *
 * Absent or malformed ⇒ null (ignore the link, land on the setlist as usual).
 * Role is optional and matched case-insensitively downstream; carried raw here.
 */
export function parseChartDeepLink(search: string, setlist: SetlistSong[]): ChartDeepLink | null {
  const params = new URLSearchParams(search);
  const rawSong = params.get('song');
  if (!rawSong || !/^\d+$/.test(rawSong)) return null;
  const position = Number(rawSong);
  const role = params.get('chart') || null;
  const sid = params.get('sid');

  if (sid) {
    const atPosition = setlist.findIndex((s) => s.songId === sid && s.position === position);
    const songIdx = atPosition !== -1 ? atPosition : setlist.findIndex((s) => s.songId === sid);
    return songIdx === -1 ? { kind: 'gone' } : { kind: 'song', songIdx, role };
  }

  const songIdx = setlist.findIndex((s) => s.position === position);
  if (songIdx === -1) return null;
  return { kind: 'song', songIdx, role };
}

// ── The thin navigator wrapper ────────────────────────────────────────────────

export type ShareOutcome = ShareTier | 'cancelled' | 'failed';

/**
 * Run the tiered share. `getFile` (chart shares only) is awaited first — a
 * fetch failure simply degrades to the URL tiers. A user-cancelled share sheet
 * (AbortError) is a clean no-op ('cancelled'), never a fallback — the user
 * said no, don't paste into their clipboard. 'clipboard' tells the caller to
 * show the "Link copied" confirmation.
 */
export async function performShare(opts: {
  title: string;
  url: string;
  getFile?: () => Promise<File | null>;
}): Promise<ShareOutcome> {
  const nav = navigator as Navigator & {
    share?: (data: ShareData) => Promise<void>;
    canShare?: (data: ShareData) => boolean;
  };

  let file: File | null = null;
  if (opts.getFile) {
    try {
      file = await opts.getFile();
    } catch {
      file = null; // degrade to tier 2
    }
  }

  const canShareFile =
    !!file && typeof nav.share === 'function' && typeof nav.canShare === 'function' &&
    nav.canShare({ files: [file] });
  const canShareUrl = typeof nav.share === 'function';
  const tier = decideShareTier({ canShareFile, canShareUrl });

  if (tier === 'file') {
    try {
      await nav.share!({ files: [file!], title: opts.title });
      return 'file';
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
      // File share refused (platform quirk) — fall through to the URL tier.
    }
  }

  if (tier === 'file' || tier === 'url') {
    try {
      await nav.share!({ title: opts.title, url: opts.url });
      return 'url';
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
      // Fall through to clipboard.
    }
  }

  try {
    await navigator.clipboard.writeText(opts.url);
    return 'clipboard';
  } catch {
    return 'failed';
  }
}
