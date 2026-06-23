import type { Bar, ChartCalibration, RoadmapMarker, SectionAnchor, System } from './types';

// ── Chart Calibration — v3: sections + system/bar geometry + nav roadmap ────
// Pure helpers for the navigation/timeline calibration sidecar. v1 modeled a
// chart as a flat chain of SectionAnchors; v2 adds System/Bar geometry for
// bar-level redline; v3 adds the nav roadmap (repeats, endings, D.S./D.C./
// Coda/Fine) resolved to a played traversal by resolveRoadmap. All updates are
// immutable.
//
// NB the running constant governs upgrade-on-read, NOT what we stamp on write:
// a no-roadmap calibration is persisted as v2 (rollback-safe — an old v2 build
// still serves it); only a roadmap-bearing payload is persisted v3 and fenced
// from old readers. See app/api/charts/calibration/route.ts for the per-payload
// stamp.

export const CALIBRATION_SCHEMA_VERSION = 3;

// ── Upgrade-on-read ─────────────────────────────────────────────────────────

// Back-compat read: normalize any known-old (v1/v2) calibration up to the
// in-memory v3 shape. A v1 (sections-only) gains empty systems/bars; roadmap is
// left undefined (⇒ linear playback). A genuinely-future row (schemaVersion >
// current) is returned untouched so the GET version gate can fail it closed.
export function upgradeCalibration(cal: ChartCalibration): ChartCalibration {
  if (cal.schemaVersion >= CALIBRATION_SCHEMA_VERSION) return cal;
  return {
    ...cal,
    schemaVersion: CALIBRATION_SCHEMA_VERSION,
    systems: cal.systems ?? [],
    bars: cal.bars ?? [],
  };
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

// A manual edit takes ownership of an element, so drop any converter-seeded
// confidence (design: confidence is machine metadata, not a verify gate — once a
// human touches the element it leaves the review queue). No-op when absent.
function withoutConfidence<T extends { confidence?: number }>(o: T): T {
  if (o.confidence === undefined) return o;
  const next = { ...o };
  delete next.confidence;
  return next;
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
    sections: cal.sections.map((s) => (s.id === id ? withoutConfidence({ ...s, label }) : s)),
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
      s.id === id ? withoutConfidence({ ...s, x: clamp01(x), y: clamp01(y) }) : s,
    ),
  };
}

// The promotion invariant (fail-closed). For a pure section-chain rail the only
// "required" elements are the section anchors themselves; "accepted" = labeled.
// v3 adds the roadmap gate: a calibration carrying a roadmap may only be
// verified (and only served to Perform) when that roadmap RESOLVES — a
// contradictory roadmap can never reach 'verified'. An empty/absent roadmap
// resolves trivially (linear), so this is a no-op for non-roadmap charts.
export function canVerify(cal: ChartCalibration): boolean {
  if (!(cal.sections.length > 0 && cal.sections.every((s) => s.label.trim() !== ''))) {
    return false;
  }
  if ((cal.roadmap?.length ?? 0) > 0) {
    return resolveRoadmap(cal).ok;
  }
  return true;
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
  // Cascade: remove bars belonging to this system, then renumber.
  const nextBars = renumberBars(
    (cal.bars ?? []).filter((b) => b.systemId !== id),
    systems.filter((s) => s.id !== id),
  );
  return {
    ...cal,
    status: 'draft',
    systems: systems.filter((s) => s.id !== id),
    bars: nextBars,
    // Cascade: prune roadmap markers whose bars vanished, then drop any
    // ending/repeatEnd orphaned when its bound repeatStart was pruned.
    roadmap: pruneRoadmap(cal.roadmap, new Set(nextBars.map((b) => b.id))),
  };
}

// Drop roadmap markers that reference a removed bar, then drop any
// ending/repeatEnd whose bound repeatStart no longer exists (same cascade shape
// as Bar.sectionId nulling). Returns undefined when no roadmap was present so
// non-roadmap calibrations stay v2 (per-payload schema, §8).
function pruneRoadmap(
  roadmap: RoadmapMarker[] | undefined,
  liveBarIds: Set<string>,
): RoadmapMarker[] | undefined {
  if (!roadmap) return undefined;
  const barAlive = (m: RoadmapMarker): boolean => {
    if (m.kind === 'ending') return m.barIds.every((b) => liveBarIds.has(b));
    return liveBarIds.has(m.barId);
  };
  return dropOrphanedRepeatBindings(roadmap.filter(barAlive));
}

// Drop any ending/repeatEnd whose bound repeatStart is no longer in the set.
// Shared by the bar-deletion cascade (pruneRoadmap) and direct marker removal
// (removeRoadmapMarker) — deleting a `|:` must take its `:|`/voltas with it.
function dropOrphanedRepeatBindings(markers: RoadmapMarker[]): RoadmapMarker[] {
  const repeatStartIds = new Set(
    markers.filter((m) => m.kind === 'repeatStart').map((m) => m.id),
  );
  return markers.filter((m) =>
    (m.kind === 'repeatEnd' || m.kind === 'ending')
      ? repeatStartIds.has(m.repeatStartId)
      : true,
  );
}

// ── Roadmap authoring (the Roadmap calibrate tool) ──────────────────────────

// The repeatStart a `:|`/volta dropped at `barId` binds to: the latest
// repeatStart at-or-before that bar in reading order (the enclosing `|:` span).
// Returns null when no `|:` precedes — the UI disables `:|`/ending in that case.
// This computes the EXPLICIT binding the marker stores; the resolver never
// re-guesses it (design §OQ-B).
export function enclosingRepeatStartId(cal: ChartCalibration, barId: string): string | null {
  const order = barsInOrder(cal);
  const pos = new Map(order.map((b, i) => [b.id, i] as const));
  const target = pos.get(barId);
  if (target === undefined) return null;
  let best: { id: string; p: number } | null = null;
  for (const m of cal.roadmap ?? []) {
    if (m.kind !== 'repeatStart') continue;
    const p = pos.get(m.barId);
    if (p === undefined || p > target) continue;
    if (!best || p > best.p) best = { id: m.id, p };
  }
  return best?.id ?? null;
}

// Append a roadmap marker (caller builds it, incl. its id). Resets to draft.
// Structural validity / resolvability is enforced at the save boundary, not
// here — mid-edit drafts (e.g. a D.S. before its Segno) persist (design §7,
// BLOCKER-1 no authoring lockout).
export function addRoadmapMarker(cal: ChartCalibration, marker: RoadmapMarker): ChartCalibration {
  return { ...cal, status: 'draft', roadmap: [...(cal.roadmap ?? []), marker] };
}

// Remove a marker by id, then cascade-drop any ending/repeatEnd orphaned by
// removing a repeatStart. Collapses an emptied roadmap to undefined so the
// payload stays v2 (per-payload schema, §8). Resets to draft.
export function removeRoadmapMarker(cal: ChartCalibration, markerId: string): ChartCalibration {
  const roadmap = cal.roadmap ?? [];
  if (!roadmap.some((m) => m.id === markerId)) return cal;
  const remaining = dropOrphanedRepeatBindings(roadmap.filter((m) => m.id !== markerId));
  return { ...cal, status: 'draft', roadmap: remaining.length > 0 ? remaining : undefined };
}

// Resize a system's vertical band (drag the top/bottom edges to fit the printed
// staff). yTop/yBottom are normalized; they're ordered + clamped here. Because a
// y change can reorder systems in reading order, bars are renumbered. A
// degenerate (zero-height) band is rejected. Resets to draft.
export function resizeSystemBand(
  cal: ChartCalibration,
  id: string,
  yTop: number,
  yBottom: number,
): ChartCalibration {
  const systems = cal.systems ?? [];
  if (!systems.some((s) => s.id === id)) return cal;
  const top = clamp01(Math.min(yTop, yBottom));
  const bot = clamp01(Math.max(yTop, yBottom));
  if (top >= bot) return cal; // degenerate band — ignore
  const nextSystems = systems.map((s) => (s.id === id ? withoutConfidence({ ...s, yTop: top, yBottom: bot }) : s));
  return {
    ...cal,
    status: 'draft',
    systems: nextSystems,
    bars: renumberBars(cal.bars ?? [], nextSystems),
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

  const nextBars = renumberBars([...otherBars, ...newBars], systems);
  return {
    ...cal,
    status: 'draft',
    bars: nextBars,
    // Cascade: the old bars for this system were replaced with fresh ids, so
    // prune roadmap markers that referenced the now-deleted bars (same
    // treatment as removeSystem — the bar-deletion cascade in the design §7).
    roadmap: pruneRoadmap(cal.roadmap, new Set(nextBars.map((b) => b.id))),
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

// ── Roadmap resolver (the nav-graph VM) ─────────────────────────────────────
// Pure: derive the PLAYED traversal from the printed roadmap markers. It is both
// the consumer feeder (Perform walks `traversal`) AND the contradiction
// validator (a non-resolving roadmap returns an error and can never be
// verified/served). Empty roadmap ⇒ linear barsInOrder (today's behavior).
//
// `pass` on each traversal step = 1-based count of entries into that bar.

export interface TraversalStep {
  barId: string;
  pass: number;
}

export interface RoadmapError {
  markerIds: string[];
  reason: string;
}

export type RoadmapResult =
  | { ok: true; traversal: TraversalStep[] }
  | { ok: false; error: RoadmapError };

const ROADMAP_TERMINATION_K = 8;

interface EndingSpan {
  marker: Extract<RoadmapMarker, { kind: 'ending' }>;
  repeatStartId: string;
  startPos: number;
  lastPos: number;
}

export function resolveRoadmap(cal: ChartCalibration): RoadmapResult {
  const bars = barsInOrder(cal);
  const markers = cal.roadmap ?? [];

  // Degenerate case: no roadmap ⇒ linear playback (clean back-compat).
  if (markers.length === 0) {
    return { ok: true, traversal: bars.map((b) => ({ barId: b.id, pass: 1 })) };
  }

  const barPos = new Map<string, number>();
  bars.forEach((b, i) => barPos.set(b.id, i));

  const err = (markerIds: string[], reason: string): RoadmapResult => ({
    ok: false,
    error: { markerIds, reason },
  });

  // Marker buckets.
  type M<K extends RoadmapMarker['kind']> = Extract<RoadmapMarker, { kind: K }>;
  const repeatStarts = markers.filter((m): m is M<'repeatStart'> => m.kind === 'repeatStart');
  const repeatEnds = markers.filter((m): m is M<'repeatEnd'> => m.kind === 'repeatEnd');
  const endings = markers.filter((m): m is M<'ending'> => m.kind === 'ending');
  const segnos = markers.filter((m): m is M<'segno'> => m.kind === 'segno');
  const codas = markers.filter((m): m is M<'coda'> => m.kind === 'coda');
  const fines = markers.filter((m): m is M<'fine'> => m.kind === 'fine');
  const toCodas = markers.filter((m): m is M<'toCoda'> => m.kind === 'toCoda');
  const jumps = markers.filter((m): m is M<'jump'> => m.kind === 'jump');

  // Defensive FK guard (the API path already structurally validated, but the
  // resolver also runs on hand-edited DB rows). §5 #7.
  const repeatStartById = new Map(repeatStarts.map((m) => [m.id, m]));
  for (const m of markers) {
    if (m.kind === 'ending') {
      if (!m.barIds.every((b) => barPos.has(b))) return err([m.id], 'ending references a missing bar');
    } else if (!barPos.has(m.barId)) {
      return err([m.id], `${m.kind} references a missing bar`);
    }
    if ((m.kind === 'repeatEnd' || m.kind === 'ending') && !repeatStartById.has(m.repeatStartId)) {
      return err([m.id], `${m.kind} is not bound to a repeatStart`);
    }
  }

  // §5 — no two same-kind markers may share a bar. The walk keys its
  // action lookups (repeatEndAt / jumpAt / toCodaAt) by bar position, so a
  // second same-kind marker on the same bar would silently overwrite the first
  // and drive the wrong traversal. Reject as contradictory (endings handled by
  // their own overlap checks). v1 also rejects two repeats closing on one bar.
  const byKindBar = new Map<string, string[]>();
  for (const m of markers) {
    if (m.kind === 'ending') continue;
    const key = `${m.kind}\u0000${m.barId}`;
    const arr = byKindBar.get(key) ?? [];
    arr.push(m.id);
    byKindBar.set(key, arr);
  }
  for (const [key, ids] of byKindBar) {
    if (ids.length > 1) {
      return err(ids, `duplicate ${key.split('\u0000')[0]} markers on the same bar`);
    }
  }

  // §5 #2 — at most one segno/coda/fine.
  if (segnos.length > 1) return err(segnos.map((m) => m.id), 'multiple Segno markers');
  if (codas.length > 1) return err(codas.map((m) => m.id), 'multiple Coda markers');
  if (fines.length > 1) return err(fines.map((m) => m.id), 'multiple Fine markers');

  // §5 #1 — jump / Coda resolvability.
  for (const j of jumps) {
    if (j.from === 'segno' && segnos.length === 0) return err([j.id], 'D.S. has no Segno');
    if (j.until === 'fine' && fines.length === 0) return err([j.id], 'al Fine has no Fine');
    if (j.until === 'coda' && codas.length === 0) return err([j.id], 'al Coda has no Coda');
    if (j.until === 'coda' && toCodas.length === 0) return err([j.id], 'al Coda has no To Coda');
  }
  for (const tc of toCodas) {
    if (codas.length === 0) return err([tc.id], 'To Coda has no Coda');
  }

  // Per-repeat structure: times, span ordering (#5), ending ranges (#6),
  // partition (#3), mixed expression (#4).
  const times = new Map<string, number>();
  const endingSpansByRepeat = new Map<string, EndingSpan[]>();

  for (const R of repeatStarts) {
    const rPos = barPos.get(R.barId)!;
    const boundEnds = repeatEnds.filter((m) => m.repeatStartId === R.id);
    const boundEndings = endings.filter((m) => m.repeatStartId === R.id);

    // §5 #4 — a repeat is expressed EITHER plain OR as voltas, never both.
    if (boundEnds.length > 0 && boundEndings.length > 0) {
      return err([R.id, ...boundEnds.map((m) => m.id), ...boundEndings.map((m) => m.id)],
        'repeat has both a plain repeatEnd and volta endings');
    }
    // Two :| for one |: makes the back-jump ambiguous.
    if (boundEnds.length > 1) {
      return err([R.id, ...boundEnds.map((m) => m.id)], 'repeat has multiple repeatEnd markers');
    }

    if (boundEndings.length > 0) {
      // §5 #5 — every volta bar must come after the repeatStart.
      for (const e of boundEndings) {
        for (const b of e.barIds) {
          if (barPos.get(b)! <= rPos) return err([R.id, e.id], 'volta ending precedes its repeatStart');
        }
      }
      // §5 #6 — each ending's bars contiguous in reading order.
      const spans: EndingSpan[] = [];
      for (const e of boundEndings) {
        const positions = e.barIds.map((b) => barPos.get(b)!).sort((a, b) => a - b);
        const unique = new Set(positions);
        if (unique.size !== positions.length) return err([e.id], 'ending has duplicate bars');
        if (positions[positions.length - 1] - positions[0] !== positions.length - 1) {
          return err([e.id], 'ending bars are not contiguous');
        }
        spans.push({ marker: e, repeatStartId: R.id, startPos: positions[0], lastPos: positions[positions.length - 1] });
      }
      // §5 #6 — endings sorted, non-overlapping, no shared bar.
      spans.sort((a, b) => a.startPos - b.startPos);
      for (let i = 1; i < spans.length; i++) {
        if (spans[i].startPos <= spans[i - 1].lastPos) {
          return err([spans[i - 1].marker.id, spans[i].marker.id], 'endings overlap or share a bar');
        }
      }
      // §5 #3 — passes partition 1..max with no gap/overlap.
      const all = boundEndings.flatMap((e) => e.numbers);
      const seen = new Set<number>();
      for (const n of all) {
        if (seen.has(n)) return err(boundEndings.map((e) => e.id), 'volta passes overlap');
        seen.add(n);
      }
      const max = Math.max(...all);
      for (let n = 1; n <= max; n++) {
        if (!seen.has(n)) return err(boundEndings.map((e) => e.id), 'volta passes do not partition 1..max');
      }
      times.set(R.id, max);
      endingSpansByRepeat.set(R.id, spans);
    } else if (boundEnds.length === 1) {
      const e = boundEnds[0];
      // §5 #5 — repeatEnd must come after its repeatStart.
      if (barPos.get(e.barId)! <= rPos) return err([R.id, e.id], 'repeatEnd precedes its repeatStart');
      times.set(R.id, e.times ?? 2);
    } else {
      // Lone repeatStart — cosmetic no-op (never a back-jump target).
      times.set(R.id, 1);
    }
  }

  // Walk lookups.
  const segno = segnos[0];
  const coda = codas[0];
  const endingStartAt = new Map<number, EndingSpan>();
  const endingEndAt = new Map<number, EndingSpan>();
  const endingStartsByRepeat = new Map<string, number[]>();
  const groupLastPosByRepeat = new Map<string, number>();
  for (const [rsId, spans] of endingSpansByRepeat) {
    for (const span of spans) {
      endingStartAt.set(span.startPos, span);
      endingEndAt.set(span.lastPos, span);
    }
    endingStartsByRepeat.set(rsId, spans.map((s) => s.startPos).sort((a, b) => a - b));
    groupLastPosByRepeat.set(rsId, Math.max(...spans.map((s) => s.lastPos)));
  }
  const repeatEndAt = new Map<number, M<'repeatEnd'>>();
  for (const e of repeatEnds) repeatEndAt.set(barPos.get(e.barId)!, e);
  const jumpAt = new Map<number, M<'jump'>>();
  for (const j of jumps) jumpAt.set(barPos.get(j.barId)!, j);
  const toCodaAt = new Map<number, M<'toCoda'>>();
  for (const tc of toCodas) toCodaAt.set(barPos.get(tc.barId)!, tc);
  const fineAt = new Set<number>(fines.map((f) => barPos.get(f.barId)!));

  // §4 termination backstop (multiplicative for nesting + additive for jumps).
  let timesProduct = 1;
  for (const t of times.values()) timesProduct *= t;
  const cap = bars.length * timesProduct * (jumps.length + 1) + ROADMAP_TERMINATION_K;

  // Walk state.
  const completedPasses = new Map<string, number>();
  for (const R of repeatStarts) completedPasses.set(R.id, 0);
  const fired = new Map<string, boolean>();
  let toCodaFired = false;
  let alFineActive = false;
  let alCodaArmed = false;
  const passCount = new Map<string, number>();
  const traversal: TraversalStep[] = [];

  const backJumpTo = (rsId: string, triggerPos: number): number => {
    const target = barPos.get(repeatStartById.get(rsId)!.barId)!;
    // Nested-reset: replay inner repeats on each outer pass (§4).
    for (const R of repeatStarts) {
      if (R.id === rsId) continue;
      const sp = barPos.get(R.barId)!;
      if (sp > target && sp <= triggerPos) completedPasses.set(R.id, 0);
    }
    return target;
  };

  let cursor = 0;
  while (cursor < bars.length) {
    // Rule 1 — volta entry-select. Skip an ending whose numbers exclude the
    // current pass; fall through to the next ending (or past the group).
    const startSpan = endingStartAt.get(cursor);
    if (startSpan) {
      const k = completedPasses.get(startSpan.repeatStartId)! + 1;
      if (!startSpan.marker.numbers.includes(k)) {
        const starts = endingStartsByRepeat.get(startSpan.repeatStartId)!;
        const next = starts.find((p) => p > cursor);
        cursor = next ?? groupLastPosByRepeat.get(startSpan.repeatStartId)! + 1;
        continue;
      }
    }

    // Record the bar.
    const bar = bars[cursor];
    const pass = (passCount.get(bar.id) ?? 0) + 1;
    passCount.set(bar.id, pass);
    traversal.push({ barId: bar.id, pass });
    if (traversal.length > cap) {
      return err(markers.map((m) => m.id), 'roadmap does not terminate');
    }

    // End-edge rules, in priority order. `handled` ⇒ cursor already repositioned.
    let handled = false;

    // Rule 2a — exit of a taken volta (back-jump point).
    const exitSpan = endingEndAt.get(cursor);
    if (exitSpan) {
      const R = exitSpan.repeatStartId;
      completedPasses.set(R, completedPasses.get(R)! + 1);
      if (completedPasses.get(R)! < times.get(R)!) {
        cursor = backJumpTo(R, cursor);
        handled = true;
      }
      // else fall through past the group (lower rules may still apply).
    }

    // Rule 2b — plain repeatEnd.
    if (!handled) {
      const re = repeatEndAt.get(cursor);
      if (re) {
        const R = re.repeatStartId;
        completedPasses.set(R, completedPasses.get(R)! + 1);
        if (completedPasses.get(R)! < times.get(R)!) {
          cursor = backJumpTo(R, cursor);
          handled = true;
        }
      }
    }

    // Rule 3 — jump (D.C./D.S.), fires at most once.
    if (!handled) {
      const j = jumpAt.get(cursor);
      if (j && !fired.get(j.id)) {
        fired.set(j.id, true);
        if (j.until === 'fine') alFineActive = true;
        if (j.until === 'coda') alCodaArmed = true;
        cursor = j.from === 'capo' ? 0 : barPos.get(segno!.barId)!;
        handled = true;
      }
    }

    // Rule 4 — To Coda (only once an al Coda jump has armed it).
    if (!handled && alCodaArmed && !toCodaFired) {
      const tc = toCodaAt.get(cursor);
      if (tc) {
        toCodaFired = true;
        cursor = barPos.get(coda!.barId)!;
        handled = true;
      }
    }

    // Rule 5 — Fine (only once an al Fine jump has activated it). Stop.
    if (!handled && alFineActive && fineAt.has(cursor)) {
      break;
    }

    // Rule 6 — advance.
    if (!handled) cursor++;
  }

  return { ok: true, traversal };
}

// Human-readable play order for the Roadmap tool's live-resolve readout, e.g.
// "1–8, 1–8, 9–16". Compresses consecutive absNumbers into ranges; a jump or a
// repeat-reset breaks the run. Pass the resolved traversal (the UI already has
// it); returns '' for an empty traversal.
export function summarizeTraversal(cal: ChartCalibration, traversal: TraversalStep[]): string {
  const absById = new Map((cal.bars ?? []).map((b) => [b.id, b.absNumber] as const));
  const nums: number[] = [];
  for (const step of traversal) {
    const n = absById.get(step.barId);
    if (n !== undefined) nums.push(n);
  }
  if (nums.length === 0) return '';
  const runs: string[] = [];
  let runStart = nums[0];
  let prev = nums[0];
  const flush = () => runs.push(runStart === prev ? `${runStart}` : `${runStart}\u2013${prev}`);
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] === prev + 1) { prev = nums[i]; continue; }
    flush();
    runStart = nums[i];
    prev = nums[i];
  }
  flush();
  return runs.join(', ');
}

// ── Payload validation (untrusted boundary: API + hand-edited DB rows) ─────

// Optional converter confidence: absent is valid (manual elements carry none);
// when present it must be a finite number in [0,1].
function isValidConfidence(c: unknown): boolean {
  return c === undefined || (typeof c === 'number' && Number.isFinite(c) && c >= 0 && c <= 1);
}

export function isValidSectionAnchor(s: unknown): s is SectionAnchor {
  if (!s || typeof s !== 'object') return false;
  const a = s as Record<string, unknown>;
  return (
    typeof a.id === 'string' && a.id.length > 0 &&
    typeof a.page === 'number' && Number.isInteger(a.page) && a.page >= 1 &&
    typeof a.x === 'number' && Number.isFinite(a.x) && a.x >= 0 && a.x <= 1 &&
    typeof a.y === 'number' && Number.isFinite(a.y) && a.y >= 0 && a.y <= 1 &&
    typeof a.label === 'string' &&
    isValidConfidence(a.confidence)
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
    sys.xStart < sys.xEnd &&
    isValidConfidence(sys.confidence)
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
    (bar.sectionId === null || (typeof bar.sectionId === 'string' && bar.sectionId.length > 0)) &&
    isValidConfidence(bar.confidence)
  );
}

// Structural shape/enum check for one roadmap marker (no FK, no resolver). FK
// (barId/repeatStartId existence) is checked in isValidCalibration where the bar
// and marker sets are known.
export function isValidRoadmapMarkerShape(m: unknown): m is RoadmapMarker {
  if (!m || typeof m !== 'object') return false;
  const k = m as Record<string, unknown>;
  if (typeof k.id !== 'string' || k.id.length === 0) return false;
  if (!isValidConfidence(k.confidence)) return false;
  const barId = (): boolean => typeof k.barId === 'string' && k.barId.length > 0;
  switch (k.kind) {
    case 'repeatStart':
    case 'segno':
    case 'coda':
      return barId() && k.edge === 'start';
    case 'toCoda':
    case 'fine':
      return barId() && k.edge === 'end';
    case 'repeatEnd':
      return (
        barId() && k.edge === 'end' &&
        typeof k.repeatStartId === 'string' && k.repeatStartId.length > 0 &&
        (k.times === undefined ||
          (typeof k.times === 'number' && Number.isInteger(k.times) && k.times >= 1))
      );
    case 'ending':
      return (
        typeof k.repeatStartId === 'string' && k.repeatStartId.length > 0 &&
        Array.isArray(k.barIds) && k.barIds.length > 0 &&
        k.barIds.every((b) => typeof b === 'string' && b.length > 0) &&
        Array.isArray(k.numbers) && k.numbers.length > 0 &&
        k.numbers.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 1)
      );
    case 'jump':
      return (
        barId() && k.edge === 'end' &&
        (k.from === 'capo' || k.from === 'segno') &&
        (k.until === 'end' || k.until === 'fine' || k.until === 'coda')
      );
    default:
      return false;
  }
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

    // absNumber must be the dense 1..n reading order (no gaps/dupes/misorder).
    // Re-derive reading order and require absNumber === index + 1.
    const ordered = barsInOrder(c as ChartCalibration);
    for (let i = 0; i < ordered.length; i++) {
      if (ordered[i].absNumber !== i + 1) return false;
    }
  }

  // Roadmap (optional — absent in v1/v2 payloads). STRUCTURAL only: shape, enum,
  // unique ids, FK (bars exist; repeatStartId points at a real repeatStart), and
  // "roadmap only with bars." The resolver (resolveRoadmap) — which decides
  // performability/promotion — deliberately does NOT run here, so a mid-edit
  // draft with a temporary contradiction still persists and reloads.
  if (cal.roadmap !== undefined) {
    if (!Array.isArray(cal.roadmap)) return false;
    if (!cal.roadmap.every(isValidRoadmapMarkerShape)) return false;
    const markers = cal.roadmap as RoadmapMarker[];

    const markerIds = new Set(markers.map((m) => m.id));
    if (markerIds.size !== markers.length) return false;

    // A roadmap is only meaningful over bars.
    const bars = (cal.bars as Bar[] | undefined) ?? [];
    if (markers.length > 0 && bars.length === 0) return false;

    const barIds = new Set(bars.map((b) => b.id));
    const repeatStartIds = new Set(
      markers.filter((m) => m.kind === 'repeatStart').map((m) => m.id),
    );
    for (const m of markers) {
      // barId / barIds FK.
      if (m.kind === 'ending') {
        if (m.barIds.length === 0) return false;
        if (!m.barIds.every((b) => barIds.has(b))) return false;
      } else if (!barIds.has(m.barId)) {
        return false;
      }
      // repeatStartId must point at a real repeatStart marker.
      if (m.kind === 'repeatEnd' || m.kind === 'ending') {
        if (!repeatStartIds.has(m.repeatStartId)) return false;
      }
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
