import type { Chart, SetlistSong } from './types';
import { ALLOWED_ROLES, canonicalizeRole, normalizeSongKeySafe, type ChartRole } from './normalize';

// Pure state helpers shared by the library and in-show Manage-Charts surfaces.
// The library is the authority (charts key by owner+normalize(title)+role); a
// show is just a title-keyed link. These keep both callers' local state in
// parity with the upload route's one-chart-per-role upsert without a refetch.

// Roles not yet filled for a song. Backend upserts on (owner, song_key, role),
// so a role can hold at most one chart — the Add picker offers only free roles
// (Replace is the path for filled ones). Existing roles are canonicalized first
// so legacy/free-text roles collapse onto the allowlist before diffing.
export function availableRoles(charts: Pick<Chart, 'role'>[]): ChartRole[] {
  const filled = new Set(charts.map((c) => canonicalizeRole(c.role)));
  return ALLOWED_ROLES.filter((r) => !filled.has(r));
}

// Apply an uploaded/replaced chart to a chart list: drop any chart with the same
// canonical role, then append the new one — mirroring the route's upsert so the
// local list matches the server (replace clobbers the role; add appends).
export function applyUploadedChart(charts: Chart[], next: Chart): Chart[] {
  const role = canonicalizeRole(next.role);
  return [...charts.filter((c) => canonicalizeRole(c.role) !== role), next];
}

// Remove a chart by its library id (Chart.fileId = chart_library.id).
export function removeChartById(charts: Chart[], chartId: string): Chart[] {
  return charts.filter((c) => c.fileId !== chartId);
}

// Update EVERY setlist row whose normalized title matches `title` (a song may
// appear in a setlist more than once, and charts are title-keyed authority, so
// all matching rows must reflect the change). Unnormalizable titles no-op.
export function updateSetlistCharts(
  setlist: SetlistSong[],
  title: string,
  fn: (charts: Chart[]) => Chart[],
): SetlistSong[] {
  const key = normalizeSongKeySafe(title);
  if (!key) return setlist;
  return setlist.map((s) =>
    normalizeSongKeySafe(s.title) === key ? { ...s, charts: fn(s.charts ?? []) } : s,
  );
}

// Suggest a non-colliding duplicate title. Defaults to "<title> (copy)" so the
// new song_key differs from the original; the owner then edits it (e.g. to a key
// variant like "Song X (Bb)"). Compares on normalized keys to match DB uniqueness.
export function suggestDuplicateTitle(title: string, existingTitles: string[]): string {
  const taken = new Set(existingTitles.map((t) => normalizeSongKeySafe(t)).filter(Boolean));
  let candidate = `${title} (copy)`;
  let n = 2;
  while (taken.has(normalizeSongKeySafe(candidate))) {
    candidate = `${title} (copy ${n})`;
    n++;
  }
  return candidate;
}
