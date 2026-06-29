import type { Bar, ChartCalibration, RoadmapMarker, SectionAnchor, System } from './types';
import { compileRoadmap, initVM, stepVM } from './roadmap-vm';
import type { TraversalStep, RoadmapError } from './roadmap-vm';

// The traversal vocabulary now lives with the VM core; re-exported so existing
// importers (`import { TraversalStep } from './chart-calibration'`) are unbroken.
export type { TraversalStep, RoadmapError } from './roadmap-vm';

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

// ── Perform readiness (the can't-Perform/Conduct diagnosis) ─────────────────
// Pure classifier that EXPLAINS the Perform gates without re-deciding them — it
// reuses isPerformable / canVerify / resolveRoadmap verbatim so it can never
// drift from the live gate (invariants pinned in tests). It surfaces, in Perform
// mode, WHY a chart has no bar transport / isn't conductable and the owner's one
// next step. See docs/design-perform-readiness.md.

export type PerformReadiness =
  | { state: 'none' } // no calibration at all
  | {
      state: 'unverifiable'; // draft, and can't be promoted yet
      reason: 'no-sections' | 'unlabeled-section' | 'roadmap-unresolved';
    }
  | { state: 'verifiable' } // canVerify true, status still draft
  | { state: 'section-only' } // verified, no bars (section rail works)
  | { state: 'bar-ready' }; // verified + bars (full transport + conduct)

export function performReadiness(cal: ChartCalibration | null): PerformReadiness {
  if (cal == null) return { state: 'none' };
  if (isPerformable(cal)) {
    return (cal.bars?.length ?? 0) > 0 ? { state: 'bar-ready' } : { state: 'section-only' };
  }
  if (canVerify(cal)) return { state: 'verifiable' };
  // Decompose the SAME canVerify conditions (for messaging only) in canVerify's
  // own short-circuit order: sections present → labeled → roadmap resolves.
  if (cal.sections.length === 0) return { state: 'unverifiable', reason: 'no-sections' };
  if (cal.sections.some((s) => s.label.trim() === '')) {
    return { state: 'unverifiable', reason: 'unlabeled-section' };
  }
  return { state: 'unverifiable', reason: 'roadmap-unresolved' };
}

// The load/status layer above the (pure-on-cal) classifier. `cal === null` is
// overloaded in the live load effect — in-flight, a clean 404, a fetch failure,
// AND a no-PDF-bytes bail all yield null — so feeding raw null to the classifier
// would flash "no map" during load and misdiagnose load failures as "no map."
// This assembler keeps the classifier pure and resolves the ambiguity from the
// load signals the page already tracks.
export type PerformReadinessView =
  | { phase: 'loading' } // fetch in flight ⇒ strip renders nothing
  | { phase: 'load-error' } // PDF-bytes OR calibration fetch failed / unavailable
  | { phase: 'unreadable'; reason: 'unsupported-schema' | 'invalid' } // row exists, build refused it
  | { phase: 'ready'; readiness: PerformReadiness }; // settled — classify cal

export function performReadinessView(args: {
  loading: boolean;
  loadError: boolean; // PDF-bytes OR calibration fetch failed
  unreadable: { reason: 'unsupported-schema' | 'invalid' } | null; // §3.2 owner-only signal
  cal: ChartCalibration | null;
}): PerformReadinessView {
  if (args.loading) return { phase: 'loading' };
  if (args.loadError) return { phase: 'load-error' };
  if (args.unreadable) return { phase: 'unreadable', reason: args.unreadable.reason };
  return { phase: 'ready', readiness: performReadiness(args.cal) };
}

// Pure GET-route taxonomy decision, factored out so the data-safety logic is
// unit-testable without a Supabase harness (the route is a thin adapter that does
// the DB read then calls this). The input is a DISCRIMINATED UNION, not a flat
// bag: it enforces the live route's required check order (schema → valid →
// performable) by making `performable` representable ONLY on a schemaOk && valid
// row — isPerformable → canVerify → s.label.trim() THROWS on a malformed row, so
// the adapter must compute `performable` only after validity holds. A bad row is
// owner-only 409 (existence admitted, graph never returned); non-owner stays 404.
export type CalibrationGetInput =
  | { hasRow: false }
  | { hasRow: true; schemaOk: false; isOwner: boolean }
  | { hasRow: true; schemaOk: true; valid: false; isOwner: boolean }
  | { hasRow: true; schemaOk: true; valid: true; performable: boolean; isOwner: boolean };

export type CalibrationGetDisposition =
  | { status: 200 }
  | { status: 404 }
  | { status: 409; reason: 'unsupported-schema' | 'invalid' };

export function calibrationGetDisposition(input: CalibrationGetInput): CalibrationGetDisposition {
  if (!input.hasRow) return { status: 404 };
  if (!input.schemaOk) {
    return input.isOwner ? { status: 409, reason: 'unsupported-schema' } : { status: 404 };
  }
  if (!input.valid) {
    return input.isOwner ? { status: 409, reason: 'invalid' } : { status: 404 };
  }
  // Only here — schemaOk && valid — is `performable` available to read.
  if (input.performable) return { status: 200 };
  return input.isOwner ? { status: 200 } : { status: 404 };
}

// Pure response shaper: maps a disposition to the {status, body} the route emits.
// This pins the fail-closed promise that the status code alone can't — the
// calibration graph is returned ONLY on a 200; a 404/409 body carries no graph.
// (The route is a thin adapter: Response.json(body, { status }).)
export type CalibrationGetResponse =
  | { status: 200; body: { calibration: ChartCalibration } }
  | { status: 404; body: { error: string } }
  | { status: 409; body: { unreadable: true; reason: 'unsupported-schema' | 'invalid' } };

export function calibrationGetResponse(
  disposition: CalibrationGetDisposition,
  calibration: ChartCalibration | null,
): CalibrationGetResponse {
  switch (disposition.status) {
    case 200:
      // A 200 always carries the graph; no row can reach 200, so null here is a
      // programming error, not a servable state.
      if (calibration == null) throw new Error('calibrationGetResponse: 200 requires a calibration');
      return { status: 200, body: { calibration } };
    case 409:
      return { status: 409, body: { unreadable: true, reason: disposition.reason } };
    case 404:
      return { status: 404, body: { error: 'No calibration for this chart + hash' } };
  }
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

// Minimum bar width in normalized page units — a barline drag can't crush a bar
// below this. Also the edge-grace tolerance for span-aware tap resolution.
export const MIN_BAR_W = 0.01;
export const TAP_TOL = 0.01;

// Drag one barline boundary within a system to align it with the printed line.
// For N bars in reading order there are N+1 boundaries:
//   index 0   → leading edge   (bars[0].xStart — after clef/key-sig/margin)
//   index k   → shared edge between bars[k-1] and bars[k]  (1..N-1)
//   index N   → trailing edge  (bars[N-1].xEnd)
// An interior drag moves BOTH adjacent edges to x together (snapping any
// pre-existing gap/overlap from converter input to contiguity). x is clamped to
// the system bounds and to each moved bar's opposite edge (MIN_BAR_W floor), so
// a boundary can never cross its siblings or invert a bar. Manual edit clears
// confidence on the touched bars and resets to draft. No-op on bad inputs.
export function moveBarBoundary(
  cal: ChartCalibration,
  systemId: string,
  boundaryIndex: number,
  x: number,
): ChartCalibration {
  const system = (cal.systems ?? []).find((s) => s.id === systemId);
  if (!system) return cal;
  const sysBars = (cal.bars ?? [])
    .filter((b) => b.systemId === systemId)
    .sort((a, b) => a.xStart - b.xStart);
  const n = sysBars.length;
  if (n === 0) return cal;
  if (!Number.isInteger(boundaryIndex) || boundaryIndex < 0 || boundaryIndex > n) return cal;

  // The window the boundary may move within, bounded by the adjacent visible
  // tick positions (NOT a moved bar's far edge, which only coincides with the
  // next tick when bars are contiguous). Reading-order tick i is:
  //   0     -> bars[0].xStart       (leading edge)
  //   n     -> bars[n-1].xEnd       (trailing edge)
  //   1..n-1-> bars[i].xStart       (right bar's xStart — the drawn interior tick)
  // Using the tick keeps a boundary from crossing its siblings even when
  // converter bars overlap (bars[k-1].xEnd > bars[k].xStart).
  const tickX = (i: number): number =>
    i === 0 ? sysBars[0].xStart : i === n ? sysBars[n - 1].xEnd : sysBars[i].xStart;
  // Two independent floors per side, take the tighter:
  //  - the adjacent sibling TICK (so a boundary can't cross a neighbor), and
  //  - the moved bar's OWN opposite edge (so a gapped converter bar can't invert,
  //    e.g. moving a right bar's xStart past its fixed xEnd).
  // For contiguous bars the tick and the moved bar's edge coincide; they only
  // diverge when converter input has gaps/overlaps.
  const lower =
    boundaryIndex === 0
      ? system.xStart
      : Math.max(tickX(boundaryIndex - 1), sysBars[boundaryIndex - 1].xStart) + MIN_BAR_W;
  const upper =
    boundaryIndex === n
      ? system.xEnd
      : Math.min(tickX(boundaryIndex + 1), sysBars[boundaryIndex].xEnd) - MIN_BAR_W;
  if (lower >= upper) return cal; // degenerate window — ignore the drag (no mutation)

  const target = Math.min(Math.max(clamp01(x), lower), upper);

  // Apply: leading edge moves bars[0].xStart; trailing moves bars[n-1].xEnd; an
  // interior boundary snaps bars[k-1].xEnd and bars[k].xStart together.
  const movedIds = new Set<string>();
  const nextSysBars = sysBars.map((b) => ({ ...b }));
  if (boundaryIndex < n) {
    nextSysBars[boundaryIndex].xStart = target;
    movedIds.add(sysBars[boundaryIndex].id);
  }
  if (boundaryIndex > 0) {
    nextSysBars[boundaryIndex - 1].xEnd = target;
    movedIds.add(sysBars[boundaryIndex - 1].id);
  }

  const others = (cal.bars ?? []).filter((b) => b.systemId !== systemId);
  const merged = [...others, ...nextSysBars].map((b) =>
    movedIds.has(b.id) ? withoutConfidence(b) : b,
  );
  return {
    ...cal,
    status: 'draft',
    bars: renumberBars(merged, cal.systems ?? []),
  };
}

// ── Add / Remove a barline (local cardinality edit) ─────────────────────────
// Non-destructive companions to the count stepper (autoDistributeBars, which
// re-spaces a whole system) and the manual drag (moveBarBoundary, which only
// re-positions). removeBarline merges two measures (N→N-1); addBarline splits
// one (N→N+1). Every other bar is preserved. Both reuse renumberBars for the
// absNumber cascade and route the roadmap through an edge-aware remap + prune +
// a bounded resolver sweep so navigation markers follow the geometry instead of
// being blindly dropped. See docs/design-barline-add-remove.md.

// The roadmap rewrite produced by a cardinality edit: the new marker list plus
// the `touched` set = markers whose bar binding this edit actually changed
// (a remapped barId / rewritten ending barIds). The bounded sweep may only drop
// a marker from `touched`, so a local edit never deletes unrelated work.
interface RoadmapRemap {
  roadmap: RoadmapMarker[] | undefined;
  touched: Set<string>;
}

// REMOVE remap: merge leftId ⟵ rightId. The merged bar keeps leftId and spans
// to max(L.xEnd, R.xEnd); `endKeeperIsL` says which bar owns that surviving end
// edge. A marker survives iff its anchor x coincides with a surviving edge of
// the merged bar (left.xStart, or the kept end edge); anything anchored to the
// removed tick or the shorter bar's now-interior end is dropped.
function remapRoadmapForRemove(
  roadmap: RoadmapMarker[] | undefined,
  leftId: string,
  rightId: string,
  endKeeperIsL: boolean,
): RoadmapRemap {
  if (!roadmap) return { roadmap, touched: new Set() };
  const touched = new Set<string>();
  const next: RoadmapMarker[] = [];
  for (const m of roadmap) {
    if (m.kind === 'ending') {
      if (m.barIds.includes(rightId)) {
        const seen = new Set<string>();
        const barIds: string[] = [];
        for (const b of m.barIds) {
          const id = b === rightId ? leftId : b;
          if (!seen.has(id)) {
            seen.add(id);
            barIds.push(id);
          }
        }
        next.push({ ...m, barIds });
        touched.add(m.id);
      } else {
        next.push(m);
      }
      continue;
    }
    if (m.barId === rightId) {
      // Right bar vanishes. Its end edge survives only when it owns merged.xEnd.
      if (m.edge === 'end' && !endKeeperIsL) {
        next.push({ ...m, barId: leftId });
        touched.add(m.id);
      }
      // else: right start edge (the removed tick) or an interior right end → drop.
      continue;
    }
    if (m.barId === leftId) {
      // Left start edge always survives; left end edge survives only when L owns
      // merged.xEnd (overlap-contained), else it became interior → drop.
      if (m.edge === 'end' && !endKeeperIsL) continue;
      next.push(m);
      continue;
    }
    next.push(m);
  }
  return { roadmap: next, touched };
}

// ADD remap: split parentId → left keeps parentId (start edge), right is a new
// bar (end edge). Both original anchor positions survive, so add is fully
// non-destructive: start-edge markers stay on the parent, end-edge markers move
// to the right half, and an ending bracket gains the new bar (kept contiguous).
function remapRoadmapForAdd(
  roadmap: RoadmapMarker[] | undefined,
  parentId: string,
  rightId: string,
): RoadmapRemap {
  if (!roadmap) return { roadmap, touched: new Set() };
  const touched = new Set<string>();
  const next = roadmap.map((m): RoadmapMarker => {
    if (m.kind === 'ending') {
      if (!m.barIds.includes(parentId)) return m;
      const barIds: string[] = [];
      for (const b of m.barIds) {
        barIds.push(b);
        if (b === parentId) barIds.push(rightId); // immediately after, stays contiguous
      }
      touched.add(m.id);
      return { ...m, barIds };
    }
    if (m.barId === parentId && m.edge === 'end') {
      touched.add(m.id);
      return { ...m, barId: rightId };
    }
    return m;
  });
  return { roadmap: next, touched };
}

// The bounded resolver sweep (design §B2/R3). A remap can preserve every id yet
// still create a resolver-level contradiction pruneRoadmap can't see (e.g. two
// endings collapsing onto one bar). We repair ONLY contradictions this edit
// could have caused: skip entirely unless the roadmap was coherent before the
// edit (mid-edit drafts are allowed to be unresolved), and from each conflict
// drop only the single edit-touched participant (never an innocent/pre-existing
// marker), deterministically by reading order then id. Iterates to a fixpoint,
// bounded by |touched|.
function boundedResolverSweep(
  before: ChartCalibration,
  after: ChartCalibration,
  touched: Set<string>,
): ChartCalibration {
  if (!after.roadmap || after.roadmap.length === 0 || touched.size === 0) return after;
  if (!resolveRoadmap(before).ok) return after; // precondition: only fix what we broke

  const barPos = new Map(barsInOrder(after).map((b, i) => [b.id, i] as const));
  const anchorPos = (m: RoadmapMarker): number =>
    m.kind === 'ending'
      ? Math.min(...m.barIds.map((b) => barPos.get(b) ?? Number.POSITIVE_INFINITY))
      : barPos.get(m.barId) ?? Number.POSITIVE_INFINITY;

  let roadmap = after.roadmap;
  for (;;) {
    const res = resolveRoadmap({ ...after, roadmap });
    if (res.ok) break;
    const participants = new Set(res.error.markerIds);
    const losers = roadmap
      .filter((m) => participants.has(m.id) && touched.has(m.id))
      .sort((a, b) => anchorPos(a) - anchorPos(b) || (a.id < b.id ? -1 : 1));
    if (losers.length === 0) break; // contradiction not caused by this edit — leave it
    const dropId = losers[0].id;
    roadmap = roadmap.filter((m) => m.id !== dropId);
  }
  return roadmap === after.roadmap ? after : { ...after, roadmap };
}

// Remove an interior barline: merge the two measures it divides into one. The
// removable barlines are the interior boundaries 1..N-1 (shared edges); the
// leading/trailing edges (0 and N) are band extent, not dividers. The merged
// bar keeps the LEFT bar's id/sectionId and spans to max(L.xEnd, R.xEnd) (the
// union, so an overlapping converter pair never loses width). No-op identity on
// bad inputs. Manual edit clears confidence and resets to draft.
export function removeBarline(
  cal: ChartCalibration,
  systemId: string,
  boundaryIndex: number,
): ChartCalibration {
  const system = (cal.systems ?? []).find((s) => s.id === systemId);
  if (!system) return cal;
  const sysBars = (cal.bars ?? [])
    .filter((b) => b.systemId === systemId)
    .sort((a, b) => a.xStart - b.xStart);
  const n = sysBars.length;
  if (n < 2) return cal;
  if (!Number.isInteger(boundaryIndex) || boundaryIndex < 1 || boundaryIndex > n - 1) return cal;

  const left = sysBars[boundaryIndex - 1];
  const right = sysBars[boundaryIndex];
  const endKeeperIsL = left.xEnd >= right.xEnd;
  const merged = withoutConfidence({ ...left, xEnd: Math.max(left.xEnd, right.xEnd) });

  const nextSysBars = sysBars
    .filter((b) => b.id !== right.id)
    .map((b) => (b.id === left.id ? merged : b));
  const others = (cal.bars ?? []).filter((b) => b.systemId !== systemId);
  const nextBars = renumberBars([...others, ...nextSysBars], cal.systems ?? []);

  const { roadmap, touched } = remapRoadmapForRemove(cal.roadmap, left.id, right.id, endKeeperIsL);
  const after: ChartCalibration = {
    ...cal,
    status: 'draft',
    bars: nextBars,
    roadmap: pruneRoadmap(roadmap, new Set(nextBars.map((b) => b.id))),
  };
  return boundedResolverSweep(cal, after, touched);
}

// Add a barline: split the measure containing page-x `x` into two at `x`. The
// left half keeps the parent id; the right half is a new bar inheriting the
// parent's sectionId. No-op identity if x lies in no bar span (clef margin,
// trailing blank, a gap) or either half would fall below MIN_BAR_W. Clears
// confidence on both halves and resets to draft.
export function addBarline(
  cal: ChartCalibration,
  systemId: string,
  x: number,
): ChartCalibration {
  const system = (cal.systems ?? []).find((s) => s.id === systemId);
  if (!system) return cal;
  const sysBars = (cal.bars ?? [])
    .filter((b) => b.systemId === systemId)
    .sort((a, b) => a.xStart - b.xStart);

  const target = clamp01(x);
  const bar = sysBars.find((b) => target >= b.xStart && target <= b.xEnd);
  if (!bar) return cal; // nothing to split under the tap
  if (target - bar.xStart < MIN_BAR_W || bar.xEnd - target < MIN_BAR_W) return cal;

  const rightId = crypto.randomUUID();
  const left = withoutConfidence({ ...bar, xEnd: target });
  const rightBar: Bar = {
    id: rightId,
    systemId,
    xStart: target,
    xEnd: bar.xEnd,
    absNumber: 0,
    sectionId: bar.sectionId,
  };
  const right = withoutConfidence(rightBar);

  const nextSysBars = sysBars.flatMap((b) => (b.id === bar.id ? [left, right] : [b]));
  const others = (cal.bars ?? []).filter((b) => b.systemId !== systemId);
  const nextBars = renumberBars([...others, ...nextSysBars], cal.systems ?? []);

  const { roadmap, touched } = remapRoadmapForAdd(cal.roadmap, bar.id, rightId);
  const after: ChartCalibration = {
    ...cal,
    status: 'draft',
    bars: nextBars,
    roadmap: pruneRoadmap(roadmap, new Set(nextBars.map((b) => b.id))),
  };
  return boundedResolverSweep(cal, after, touched);
}

// Find the bar at a tap (page, x, y). Picks the nearest system by y, then the
// bar whose [xStart, xEnd] span contains x. Returns null when x falls outside
// every bar span (leading clef/margin, trailing blank, or a not-yet-normalized
// gap between converter bars) — except within TAP_TOL of the nearest bar edge,
// which snaps to that bar so a graze still lands. Returns null if no bars exist
// on the page or in the chosen system.
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

  const sysBars = (cal.bars ?? []).filter((b) => b.systemId === bestSys.id);
  if (sysBars.length === 0) return null;

  // Span containment: the bar whose [xStart, xEnd] holds x.
  const contained = sysBars.find((b) => x >= b.xStart && x <= b.xEnd);
  if (contained) return contained;

  // Otherwise snap to the nearest bar edge only within tolerance; else no bar.
  let nearest = sysBars[0];
  let nearestDist = Math.min(Math.abs(x - nearest.xStart), Math.abs(x - nearest.xEnd));
  for (let i = 1; i < sysBars.length; i++) {
    const d = Math.min(Math.abs(x - sysBars[i].xStart), Math.abs(x - sysBars[i].xEnd));
    if (d < nearestDist) {
      nearestDist = d;
      nearest = sysBars[i];
    }
  }
  return nearestDist <= TAP_TOL ? nearest : null;
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

// Render-derived display page for the Perform redline (design-conductor-chunk4-ui
// §1, page-turn parity). When a conductor session drives the redline, the displayed
// page must follow the current bar's system IN THE SAME render commit as the bar —
// so the overlay's `system.page === page` gate never suppresses the live redline on
// a stale frame. A deferred (effect/microtask) page-turn would leave exactly such a
// frame (the High finding). Off session, the caller's own `pageNum` (taps / arrows /
// ref-jumps) is the source, unchanged.
export function performDisplayPage(
  sessionDriving: boolean,
  currentSystem: System | null,
  pageNum: number,
): number {
  return sessionDriving && currentSystem ? currentSystem.page : pageNum;
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

export type RoadmapResult =
  | { ok: true; traversal: TraversalStep[] }
  | { ok: false; error: RoadmapError };

// The played traversal of a chart's roadmap. Now a thin batch runner over the
// extracted resumable VM core (lib/roadmap-vm.ts): compile → init → step to
// completion. The musical semantics live ONCE in the core, shared with the live
// conductor VM (design-conductor-authority.md §3.1). The termination cap (a
// non-terminating roadmap is a structural error) applies only here — live
// stepping is MD-bounded.
export function resolveRoadmap(cal: ChartCalibration): RoadmapResult {
  const compiled = compileRoadmap(barsInOrder(cal), cal.roadmap ?? []);
  if (!compiled.ok) return { ok: false, error: compiled.error };

  const program = compiled.compiled;
  const traversal: TraversalStep[] = [];
  let state = initVM(program);
  while (!state.done) {
    const { transition, state: next } = stepVM(program, state);
    if (transition) {
      traversal.push(transition);
      if (traversal.length > program.cap) {
        return { ok: false, error: { markerIds: (cal.roadmap ?? []).map((m) => m.id), reason: 'roadmap does not terminate' } };
      }
    }
    state = next;
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
