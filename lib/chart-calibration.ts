import type { ChartCalibration, SectionAnchor } from './types';

// ── Chart Calibration — step 1: sections-only rail ────────────────────────
// Pure helpers for the navigation/timeline calibration sidecar. Step 1 models a
// chart as a flat chain of SectionAnchors (no bars, no nav edges, no tempo); the
// redline parks at a seeked section. All updates are immutable.

export const CALIBRATION_SCHEMA_VERSION = 1;

export function emptyCalibration(): ChartCalibration {
  return { schemaVersion: CALIBRATION_SCHEMA_VERSION, status: 'draft', sections: [] };
}

// Playing order is best-effort in step 1 (no nav graph yet): top→bottom down a
// page, then page by page, with x as the tiebreaker for side-by-side heads.
export function sectionsInOrder(cal: ChartCalibration): SectionAnchor[] {
  return [...cal.sections].sort(
    (a, b) => a.page - b.page || a.y - b.y || a.x - b.x,
  );
}

// Section anchors on a given 1-based page, in top→bottom order.
export function sectionsForPage(cal: ChartCalibration, page: number): SectionAnchor[] {
  return sectionsInOrder(cal).filter((s) => s.page === page);
}

// Clamp a normalized coordinate into [0, 1].
function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// Add a section anchor at a normalized (x, y) on a page. Label defaults blank
// (the editor prompts for it; a blank label blocks verification, by design).
export function addSection(
  cal: ChartCalibration,
  page: number,
  x: number,
  y: number,
  label = '',
): ChartCalibration {
  const section: SectionAnchor = {
    id: crypto.randomUUID(),
    page,
    x: clamp01(x),
    y: clamp01(y),
    label,
  };
  // Editing always returns the calibration to draft — a change must be re-verified.
  return { ...cal, status: 'draft', sections: [...cal.sections, section] };
}

export function removeSection(cal: ChartCalibration, id: string): ChartCalibration {
  if (!cal.sections.some((s) => s.id === id)) return cal;
  return {
    ...cal,
    status: 'draft',
    sections: cal.sections.filter((s) => s.id !== id),
  };
}

export function relabelSection(
  cal: ChartCalibration,
  id: string,
  label: string,
): ChartCalibration {
  if (!cal.sections.some((s) => s.id === id)) return cal;
  return {
    ...cal,
    status: 'draft',
    sections: cal.sections.map((s) => (s.id === id ? { ...s, label } : s)),
  };
}

export function moveSection(
  cal: ChartCalibration,
  id: string,
  x: number,
  y: number,
): ChartCalibration {
  if (!cal.sections.some((s) => s.id === id)) return cal;
  return {
    ...cal,
    status: 'draft',
    sections: cal.sections.map((s) =>
      s.id === id ? { ...s, x: clamp01(x), y: clamp01(y) } : s,
    ),
  };
}

// The promotion invariant (fail-closed). For a pure section-chain rail the only
// "required" elements are the section anchors themselves; "accepted" = labeled.
// So a calibration is verifiable iff it has at least one section AND every
// section carries a non-blank label.
export function canVerify(cal: ChartCalibration): boolean {
  return cal.sections.length > 0 && cal.sections.every((s) => s.label.trim() !== '');
}

// Promote draft → verified (no-op unless the invariant holds). Demotion is just
// editing (the mutators above reset to draft), so there's no explicit demote.
export function verify(cal: ChartCalibration): ChartCalibration {
  if (cal.status === 'verified' || !canVerify(cal)) return cal;
  return { ...cal, status: 'verified' };
}

// Perform mode consumes a calibration only when it is verified AND its stored
// source_hash matches the live PDF's hash. This expresses the second boundary
// (hash match is necessary, not sufficient) given an already-matched hash.
// Fails closed at the DB boundary: a payload whose status is 'verified' but
// whose sections no longer satisfy the invariant (e.g. a hand-edited row with a
// blank label) does NOT drive the redline — re-check canVerify, never trust the
// stored flag alone.
export function isPerformable(cal: ChartCalibration): boolean {
  return cal.status === 'verified' && canVerify(cal);
}

// sha256 hex of PDF bytes — the de-facto chart version (the library has no
// version concept). Computed where the bytes already live (the client viewer);
// the sidecar stores this as source_hash and apply is gated on a live re-hash.
export async function hashPdfBytes(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  // Copy into a fresh, tightly-bounded ArrayBuffer (handles offset views and
  // rejects SharedArrayBuffer — digest wants a plain BufferSource).
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', view.slice());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
