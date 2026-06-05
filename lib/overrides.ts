import { normalizeSongKeySafe } from './normalize';

/**
 * Decide whether a show save should send reference-based `entries` (rpc_save_show
 * path) or fall back to the legacy inline-blob path.
 *
 * Entries are wanted when the show is already on the reference path (migrated,
 * entries sent earlier this session, or any row carries a songId) OR when an owner
 * saves — owners migrate-on-first-save.
 *
 * BUT entries are only safe to send when every row resolves to a library song:
 * either it has a songId, or its title normalizes to a non-empty song_key. A row
 * with no songId and an unnormalizable title (e.g. "!!!") cannot be resolved server
 * side and would 400 the entire update. In that case we fall back to the legacy
 * path so the save still succeeds — migration simply defers until titles are clean.
 */
export function shouldSendEntries(
  setlist: Array<{ songId?: string; title: string }> | undefined,
  opts: { isOwner: boolean; setlistMigrated: boolean; hasSentEntries: boolean },
): boolean {
  const rows = setlist ?? [];
  const wantsEntries =
    opts.isOwner || opts.setlistMigrated || opts.hasSentEntries || rows.some((s) => s.songId);
  if (!wantsEntries) return false;
  return rows.every((s) => !!s.songId || normalizeSongKeySafe(s.title) !== null);
}

/**
 * Three-state override resolution for song library.
 *   null/undefined → use library default
 *   ''            → explicitly blank (override to empty)
 *   'value'       → use this override
 */
export function resolveOverride(
  override: string | null | undefined,
  fallback: string | null | undefined,
  emptyAs?: string,
): string | undefined {
  if (override === '') return emptyAs;
  if (override != null) return override;
  return fallback ?? undefined;
}

/**
 * Compare an effective value against a library default.
 * Returns: null (matches default), '' (explicitly blank), or the override value.
 */
export function diffOverride(
  effective: string | undefined | null,
  libraryDefault: string | null,
): string | null {
  const eff = effective ?? '';
  const def = libraryDefault ?? '';

  if (eff === def) return null;
  if (eff === '' && def !== '') return '';
  return eff;
}
