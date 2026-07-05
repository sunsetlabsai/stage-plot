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

/** The chart deep link: show URL + ?song=POSITION&chart=ROLE (position as displayed, 1-based). */
export function buildChartShareUrl(
  origin: string,
  owner: string,
  slug: string,
  songPosition: number,
  role: string,
): string {
  return `${buildShowShareUrl(origin, owner, slug)}?song=${encodeURIComponent(String(songPosition))}&chart=${encodeURIComponent(role)}`;
}

/** The show-level share: the bare show URL. */
export function buildShowShareUrl(origin: string, owner: string, slug: string): string {
  return `${origin}/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`;
}

/**
 * Parse ?song=N&chart=ROLE from a query string against the setlist.
 * N matches song.position (the number the sender saw). Invalid/absent song ⇒
 * null (ignore the link, land on the setlist as usual). Role is optional and
 * matched case-insensitively downstream; carried through raw here.
 */
export function parseChartDeepLink(
  search: string,
  setlist: SetlistSong[],
): { songIdx: number; role: string | null } | null {
  const params = new URLSearchParams(search);
  const rawSong = params.get('song');
  if (!rawSong || !/^\d+$/.test(rawSong)) return null;
  const position = Number(rawSong);
  const songIdx = setlist.findIndex((s) => s.position === position);
  if (songIdx === -1) return null;
  const role = params.get('chart');
  return { songIdx, role: role || null };
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
