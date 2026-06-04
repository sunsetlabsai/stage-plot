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
