import { normalizeSongKeySafe } from './normalize';

/**
 * Decide whether a show save should send reference-based `entries` (rpc_save_show
 * path) or fall back to the legacy inline-blob path.
 *
 * Once a show is on the reference path — `setlist_migrated` in the DB or entries
 * sent earlier this session (`hasSentEntries`) — GET hydrates the setlist from
 * `setlist_entries` and IGNORES `config.setlist`. A legacy blob write would then
 * be silently lost on reload, so we MUST send entries even when a row is
 * unresolvable; the server returns 400 and the caller surfaces the failure.
 *
 * Before the show is on the reference path, GET still reads `config.setlist`, so
 * the legacy path persists. There we only migrate (send entries) when an owner is
 * saving (or some row already carries a songId) AND every row resolves to a
 * library song — has a songId, or a title that normalizes to a non-empty
 * song_key. If any row is unresolvable we stay on the legacy path: the save still
 * persists and migration simply defers until titles are clean.
 */
export function shouldSendEntries(
  setlist: Array<{ songId?: string; title: string }> | undefined,
  opts: { isOwner: boolean; setlistMigrated: boolean; hasSentEntries: boolean },
): boolean {
  // On the reference path the legacy blob is ignored by GET — entries are mandatory.
  if (opts.setlistMigrated || opts.hasSentEntries) return true;

  const rows = setlist ?? [];
  const wantsMigration = opts.isOwner || rows.some((s) => s.songId);
  if (!wantsMigration) return false;

  // Migrate only when every row resolves; otherwise stay legacy (persists, defers).
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
