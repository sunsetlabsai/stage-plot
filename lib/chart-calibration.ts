import type { Bar, ChartCalibration, SectionAnchor, System } from './types';

// ── Chart Calibration — v2: sections + system/bar geometry ─────────────────
// Pure helpers for the navigation/timeline calibration sidecar. v1 modeled a
// chart as a flat chain of SectionAnchors; v2 adds System/Bar geometry for
// bar-level redline. All updates are immutable.

export const CALIBRATION_SCHEMA_VERSION = 2;

// ── v1 → v2 upgrade ────────────────────────────────────────────────────────

// Back-compat read: a v1 calibration (sections-only) gains empty systems/bars.
export function upgradeToV2(cal: ChartCalibration): ChartCalibration {
  if (cal.schemaVersion >= 2) return cal;
  return { ...cal, schemaVersion: 2, systems: cal.systems ?? [], bars: cal.bars ?? [] };
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function emptyCalibration(): ChartCalibration {
  return { schemaVersion: CALIBRATION_SCHEMA_VERSION, status: 'draft', sections: [], systems: [], bars: [] };
}

// ── Section helpers (unchanged from v1) ─────────────────────────────────────

// Playing order: page → y → x (top→bottom, left→right).
export function sectionsInOrder(cal: ChartCalibration): SectionAnchor[] {
  return [...cal.sections].sort(
    (a, b) => a.page - b.page || a.y - b.y || a.x - b.x,
  );
}

export function sectionsForPage(cal: ChartCalibration, page: number): SectionAnchor[] {
  return sectionsInOrder(cal).filter((s) => s.page === page);
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

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
  return { ...cal, status: 'draft', sections: [...cal.sections, section] };
}

export function removeSection(cal: ChartCalibration, id: string): ChartCalibration {
  if (!cal.sections.some((s) => s.id === id)) return cal;
  return {
    ...cal,
    status: 'draft',
    sections: cal.sections.filter((s) => s.id !== id),
    // Cascade: null out bar.sectionId references to the removed section.
    bars: cal.bars?.map((b) => b.sectionId === id ? { ...b, sectionId: null } : b),
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
// Unchanged in v2 — bars don't gate verification (yet).
export function canVerify(cal: ChartCalibration): boolean {
  return cal.sections.length > 0 && cal.sections.every((s) => s.label.trim() !== '');
}

export function verify(cal: ChartCalibration): ChartCalibration {
  if (cal.status === 'verified' || !canVerify(cal)) return cal;
  return { ...cal, status: 'verified' };
}

export function isPerformable(cal: ChartCalibration): boolean {
  return cal.status === 'verified' && canVerify(cal);
}

// ── System helpers ──────────────────────────────────────────────────────────

// Reading order for systems: page → yTop → xStart.
export function systemsInOrder(cal: ChartCalibration): System[] {
  return [...(cal.systems ?? [])].sort(
    (a, b) => a.page - b.page || a.yTop - b.yTop || a.xStart - b.xStart,
  );
}

export function systemsForPage(cal: ChartCalibration, page: number): System[] {
  return systemsInOrder(cal).filter((s) => s.page === page);
}

export function addSystem(
  cal: ChartCalibration,
  page: number,
  yTop: number,
  yBottom: number,
  xStart: number,
  xEnd: number,
): ChartCalibration {
  const system: System = {
    id: crypto.randomUUID(),
    page,
    yTop: clamp01(yTop),
    yBottom: clamp01(yBottom),
    xStart: clamp01(xStart),
    xEnd: clamp01(xEnd),
  };
  return { ...cal, status: 'draft', systems: [...(cal.systems ?? []), system] };
}

export function removeSystem(cal: ChartCalibration, id: string): ChartCalibration {
  const systems = cal.systems ?? [];
  if (!systems.some((s) => s.id === id)) return cal;
  return {
    ...cal,
    status: 'draft',
    systems: systems.filter((s) => s.id !== id),
    // Cascade: remove bars belonging to this system, then renumber.
    bars: renumberBars(
      (cal.bars ?? []).filter((b) => b.systemId !== id),
      systems.filter((s) => s.id !== id),
    ),
  };
}

// ── Bar helpers ─────────────────────────────────────────────────────────────

// Global reading order for bars: systems in reading order, then bars within
// each system sorted by xStart.
export function barsInOrder(cal: ChartCalibration): Bar[] {
  const ordered = systemsInOrder(cal);
  const sysBars = new Map<string, Bar[]>();
  for (const bar of cal.bars ?? []) {
    const arr = sysBars.get(bar.systemId) ?? [];
    arr.push(bar);
    sysBars.set(bar.systemId, arr);
  }
  const result: Bar[] = [];
  for (const sys of ordered) {
    const bars = sysBars.get(sys.id) ?? [];
    bars.sort((a, b) => a.xStart - b.xStart);
    result.push(...bars);
  }
  return result;
}

// Renumber bars globally by reading order. Returns new Bar[] (immutable).
function renumberBars(bars: Bar[], systems: System[]): Bar[] {
  // Sort systems into reading order.
  const ordered = [...systems].sort(
    (a, b) => a.page - b.page || a.yTop - b.yTop || a.xStart - b.xStart,
  );
  const sysBars = new Map<string, Bar[]>();
  for (const bar of bars) {
    const arr = sysBars.get(bar.systemId) ?? [];
    arr.push({ ...bar });
    sysBars.set(bar.systemId, arr);
  }
  const result: Bar[] = [];
  let absNum = 1;
  for (const sys of ordered) {
    const sb = sysBars.get(sys.id) ?? [];
    sb.sort((a, b) => a.xStart - b.xStart);
    for (const bar of sb) {
      result.push({ ...bar, absNumber: absNum++ });
    }
  }
  // Include orphan bars (systemId not in systems) at the end — shouldn't
  // happen in practice, but fail visibly rather than silently dropping.
  for (const bar of bars) {
    if (!systems.some((s) => s.id === bar.systemId)) {
      result.push({ ...bar, absNumber: absNum++ });
    }
  }
  return result;
}

// Distribute `count` even bars across a system's width. Replaces any existing
// bars for this system. Global renumber. sectionId left null (assignment
// deferred). Resets to draft.
export function autoDistributeBars(
  cal: ChartCalibration,
  systemId: string,
  count: number,
): ChartCalibration {
  const systems = cal.systems ?? [];
  const system = systems.find((s) => s.id === systemId);
  if (!system || count < 0) return cal;

  // Remove existing bars for this system.
  const otherBars = (cal.bars ?? []).filter((b) => b.systemId !== systemId);

  // Create evenly-spaced bars.
  const newBars: Bar[] = [];
  if (count > 0) {
    const width = system.xEnd - system.xStart;
    const barWidth = width / count;
    for (let i = 0; i < count; i++) {
      newBars.push({
        id: crypto.randomUUID(),
        systemId,
        xStart: system.xStart + i * barWidth,
        xEnd: system.xStart + (i + 1) * barWidth,
        absNumber: 0, // placeholder — renumber below
        sectionId: null,
      });
    }
  }

  const allBars = [...otherBars, ...newBars];
  return {
    ...cal,
    status: 'draft',
    bars: renumberBars(allBars, systems),
  };
}

// Find the bar nearest to a tap at (page, x, y). Returns null if no bars exist
// on the page or no system's y-range contains the tap point.
export function tapToBar(
  cal: ChartCalibration,
  page: number,
  x: number,
  y: number,
): Bar | null {
  const pageSystems = systemsForPage(cal, page);
  if (pageSystems.length === 0) return null;

  // Find the system whose y-range contains the tap (or the closest one).
  let bestSys = pageSystems[0];
  let bestDist = yDistToSystem(y, bestSys);
  for (let i = 1; i < pageSystems.length; i++) {
    const d = yDistToSystem(y, pageSystems[i]);
    if (d < bestDist) {
      bestDist = d;
      bestSys = pageSystems[i];
    }
  }

  // Find the bar in that system closest to the tap x (by midpoint).
  const sysBars = (cal.bars ?? []).filter((b) => b.systemId === bestSys.id);
  if (sysBars.length === 0) return null;

  let bestBar = sysBars[0];
  let bestBarDist = Math.abs(x - (bestBar.xStart + bestBar.xEnd) / 2);
  for (let i = 1; i < sysBars.length; i++) {
    const mid = (sysBars[i].xStart + sysBars[i].xEnd) / 2;
    const d = Math.abs(x - mid);
    if (d < bestBarDist) {
      bestBarDist = d;
      bestBar = sysBars[i];
    }
  }
  return bestBar;
}

function yDistToSystem(y: number, sys: System): number {
  if (y >= sys.yTop && y <= sys.yBottom) return 0;
  return Math.min(Math.abs(y - sys.yTop), Math.abs(y - sys.yBottom));
}

// ── Bar-level Perform transport (step-2 renderer) ───────────────────────────
// Walking these in order produces the redline sweep: consecutive bars advance
// L→R within a system, snap down to the next system, and cross pages (the next
// bar's system can be on a different page — the caller turns the page).

export function findSystem(cal: ChartCalibration, systemId: string): System | null {
  return (cal.systems ?? []).find((s) => s.id === systemId) ?? null;
}

// Bars on a given page, in reading order (left→right within each system band).
export function barsForPage(cal: ChartCalibration, page: number): Bar[] {
  const pageSystemIds = new Set(systemsForPage(cal, page).map((s) => s.id));
  return barsInOrder(cal).filter((b) => pageSystemIds.has(b.systemId));
}

// The first bar in global reading order (the redline's starting position).
export function firstBar(cal: ChartCalibration): Bar | null {
  return barsInOrder(cal)[0] ?? null;
}

// The next/previous bar in global reading order, or null at the ends (or when
// the current bar isn't found).
export function nextBar(cal: ChartCalibration, currentBarId: string): Bar | null {
  const ordered = barsInOrder(cal);
  const i = ordered.findIndex((b) => b.id === currentBarId);
  return i === -1 ? null : ordered[i + 1] ?? null;
}

export function prevBar(cal: ChartCalibration, currentBarId: string): Bar | null {
  const ordered = barsInOrder(cal);
  const i = ordered.findIndex((b) => b.id === currentBarId);
  return i <= 0 ? null : ordered[i - 1];
}

// ── Payload validation (untrusted boundary: API + hand-edited DB rows) ─────

export function isValidSectionAnchor(s: unknown): s is SectionAnchor {
  if (!s || typeof s !== 'object') return false;
  const a = s as Record<string, unknown>;
  return (
    typeof a.id === 'string' && a.id.length > 0 &&
    typeof a.page === 'number' && Number.isInteger(a.page) && a.page >= 1 &&
    typeof a.x === 'number' && Number.isFinite(a.x) && a.x >= 0 && a.x <= 1 &&
    typeof a.y === 'number' && Number.isFinite(a.y) && a.y >= 0 && a.y <= 1 &&
    typeof a.label === 'string'
  );
}

export function isValidSystem(s: unknown): s is System {
  if (!s || typeof s !== 'object') return false;
  const sys = s as Record<string, unknown>;
  return (
    typeof sys.id === 'string' && sys.id.length > 0 &&
    typeof sys.page === 'number' && Number.isInteger(sys.page) && sys.page >= 1 &&
    typeof sys.yTop === 'number' && Number.isFinite(sys.yTop) && sys.yTop >= 0 && sys.yTop <= 1 &&
    typeof sys.yBottom === 'number' && Number.isFinite(sys.yBottom) && sys.yBottom >= 0 && sys.yBottom <= 1 &&
    sys.yTop < sys.yBottom &&
    typeof sys.xStart === 'number' && Number.isFinite(sys.xStart) && sys.xStart >= 0 && sys.xStart <= 1 &&
    typeof sys.xEnd === 'number' && Number.isFinite(sys.xEnd) && sys.xEnd >= 0 && sys.xEnd <= 1 &&
    sys.xStart < sys.xEnd
  );
}

export function isValidBar(b: unknown): b is Bar {
  if (!b || typeof b !== 'object') return false;
  const bar = b as Record<string, unknown>;
  return (
    typeof bar.id === 'string' && bar.id.length > 0 &&
    typeof bar.systemId === 'string' && bar.systemId.length > 0 &&
    typeof bar.xStart === 'number' && Number.isFinite(bar.xStart) && bar.xStart >= 0 && bar.xStart <= 1 &&
    typeof bar.xEnd === 'number' && Number.isFinite(bar.xEnd) && bar.xEnd >= 0 && bar.xEnd <= 1 &&
    bar.xStart < bar.xEnd &&
    typeof bar.absNumber === 'number' && Number.isInteger(bar.absNumber) && bar.absNumber >= 1 &&
    (bar.sectionId === null || (typeof bar.sectionId === 'string' && bar.sectionId.length > 0))
  );
}

// A structurally valid calibration: known status, numeric schema version, valid
// sections with unique ids, and (if present) valid systems/bars with unique ids
// and referential integrity (each bar's systemId references a system).
export function isValidCalibration(c: unknown): c is ChartCalibration {
  if (!c || typeof c !== 'object') return false;
  const cal = c as Record<string, unknown>;
  if (cal.status !== 'draft' && cal.status !== 'verified') return false;
  if (typeof cal.schemaVersion !== 'number') return false;

  // Sections (required).
  if (!Array.isArray(cal.sections)) return false;
  if (!cal.sections.every(isValidSectionAnchor)) return false;
  const sectionIds = new Set((cal.sections as SectionAnchor[]).map((s) => s.id));
  if (sectionIds.size !== cal.sections.length) return false;

  // Systems (optional — absent in v1 payloads).
  if (cal.systems !== undefined) {
    if (!Array.isArray(cal.systems)) return false;
    if (!cal.systems.every(isValidSystem)) return false;
    const sysIds = new Set((cal.systems as System[]).map((s) => s.id));
    if (sysIds.size !== cal.systems.length) return false;
  }

  // Bars (optional — absent in v1 payloads).
  if (cal.bars !== undefined) {
    if (!Array.isArray(cal.bars)) return false;
    if (!cal.bars.every(isValidBar)) return false;
    const barIds = new Set((cal.bars as Bar[]).map((b) => b.id));
    if (barIds.size !== cal.bars.length) return false;

    // Referential integrity: systemId → system, sectionId → section.
    const sysMap = new Map((cal.systems as System[] ?? []).map((s) => [s.id, s]));
    for (const bar of cal.bars as Bar[]) {
      const sys = sysMap.get(bar.systemId);
      if (!sys) return false;
      // Bar geometry must fit within its parent system's x-bounds.
      if (bar.xStart < sys.xStart || bar.xEnd > sys.xEnd) return false;
      // sectionId FK (null is fine — unassigned).
      if (bar.sectionId !== null && !sectionIds.has(bar.sectionId)) return false;
    }
  }

  return true;
}

// sha256 hex of PDF bytes — the de-facto chart version.
export async function hashPdfBytes(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', view.slice());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
