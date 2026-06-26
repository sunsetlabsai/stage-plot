import type { ChartCalibration, RoadmapMarker, SectionAnchor } from './types';

// ── Conductor authority, chunk 1: canonical SongStructure + per-chart alignment ─
//
// (design-conductor-authority.md §2). The cross-chart identity for live roadmap
// broadcast. A single MD advances ONE canonical VM over a song-scoped
// SongStructure; each chart is a pure renderer of canonical-position → local
// coords. This module is the pure identity/alignment layer — no VM, no
// transport, no geometry. (The resumable VM is chunk 2; transport is chunk 3.)
//
// The governing spine (§2.2.0): DEGRADE PRECISION, NEVER HONESTY —
//   bar → section → tacet → self-nav,
// but never land on a node the alignment did not confirm. A wrong guess is worse
// than honest self-navigation.

// ── Canonical structure (song-scoped, one per song) ──────────────────────────
// The canonical roadmap. Same marker model as a chart's roadmap (RoadmapMarker),
// just at the song level (§2.2) — so chunk 2's VM reuses resolveRoadmap's
// musical semantics unchanged. Sections + bars carry STABLE ids (not labels or
// ordinals): stable ids are what make re-key safe (§2.2.1).

export interface CanonicalSection {
  id: string;    // stable canonical id; survives owner rename/reorder (§2.2.1)
  label: string; // human label (seed for alignment, NOT the authority)
}

// A canonical bar has NO geometry (canonical structure is abstract — coordinates
// live only on each chart's calibration). Order is array order; a bar's within-
// section offset is its index among its section's bars in that order.
export interface CanonicalBar {
  id: string;
  sectionId: string; // FK to CanonicalSection.id
}

export interface SongStructure {
  songId: string;
  sections: CanonicalSection[]; // ordered (playing order of the printed page)
  bars: CanonicalBar[];         // ordered; each → a canonical section
  roadmap: RoadmapMarker[];     // canonical nav markers, keyed by canonical bar id
}

// ── The wire ref (§2.3) ──────────────────────────────────────────────────────
// The MD broadcasts a CanonicalRef — a node in SongStructure, NEVER a portable
// bar number (finding 4). Each device resolves it to its own local node + label.
// `barOffset` (mid-section targets, "bar 5 of the solo") is honored ONLY inside a
// bar-isomorphic span (§2.3.1); otherwise it drops to the section head.
export type CanonicalRef =
  | { kind: 'pieceStart' }
  | { kind: 'segno' }
  | { kind: 'coda' }
  | { kind: 'fine' }
  | { kind: 'section'; sectionId: string; barOffset?: number }
  | { kind: 'repeatStart'; markerId: string; barOffset?: number };

// ── Per-chart alignment (§2.2 / §2.2.0) ──────────────────────────────────────
// How one chart maps into the canonical structure. Alignment is PER-NODE and may
// be PARTIAL — charts routinely disagree on section count (a horn tacets the
// bridge; a part omits a tag). Each canonical section resolves to exactly one of:
//   local    — a confirmed local node (resolves to local coords).
//   tacet    — declared-absent: the player genuinely rests here. A RESOLVED
//              outcome, not an error — hold + re-home at the next present section.
//   unmapped — ambiguous: can't place it. Self-navigate (loud); never auto-snap.
// A canonical section with NO entry is treated as unmapped (self-nav) — the chart
// has not declared a mapping, so we do not guess.
export type NodeAlignment =
  | {
      status: 'local';
      localSectionId: string;
      // True only when canonical↔local bars are 1:1 in this span (§2.3.1): equal
      // bar count AND no intervening structural divergence. Gates barOffset.
      barIsomorphic: boolean;
    }
  | { status: 'tacet' }
  | { status: 'unmapped' };

export interface ChartAlignment {
  songId: string;
  chartId: string;
  // canonical section id → this chart's mapping for it. Keyed by STABLE id.
  sections: Record<string, NodeAlignment>;
}

// ── Resolution result ────────────────────────────────────────────────────────
// What resolving a CanonicalRef on one chart yields. The frontend (a later
// chunk) turns localSectionId(+barOffset) into coordinates; this layer never
// touches geometry.
export type RefResolution =
  // The chart plays here. barApproximate = barOffset was requested but the span
  // was not bar-isomorphic, so we coarsened to the section head (§2.3.1).
  | { status: 'local'; localSectionId: string; barOffset: number; barApproximate: boolean }
  // The player rests this section; re-home at the next present (local) section.
  // null = nothing present ahead (rest to the end).
  | { status: 'tacet'; rehomeSectionId: string | null }
  // Can't place the ref on this chart → this member self-navigates (§7).
  | { status: 'unresolved' };

// ── Label normalization + ordinals (the seed heuristic, §2.2) ────────────────
// label+ordinal is a SEED for proposing an alignment, never the cross-chart
// authority — unmatched sections degrade to `unmapped` (→ review), they are not
// silently forced together.
export function normalizeLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    // Strip a run of trailing punctuation ("Chorus:" / "Verse 1 ." → "chorus" /
    // "verse 1"). BOUNDED to at most one separating space (`\s?`) so we only
    // clean decoration ADJACENT to the label — we never reach across a word to
    // grab punctuation that rightly belongs to something else ("Solo - to coda"
    // keeps "- to coda"; only a true trailing "!" / ":" / "." is removed). Both
    // charts normalize identically, so like still matches like.
    .replace(/\s?[^\w\s]+$/, '');
}

// ordinal = 1-based occurrence index of a section among same-normalized-label
// siblings, in array order ("Chorus" #1, #2, …). Returned keyed by section id.
function sectionOrdinals(sections: { id: string; label: string }[]): Map<string, number> {
  const seen = new Map<string, number>();
  const out = new Map<string, number>();
  for (const s of sections) {
    const key = normalizeLabel(s.label);
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    out.set(s.id, n);
  }
  return out;
}

// ── Locate a CanonicalRef → (canonical section, within-section bar offset) ─────
// Collapses every ref form to one shape so alignment application is uniform. The
// point anchors (pieceStart/segno/coda/fine) resolve through the canonical bar
// they sit on. Returns null when the ref names a marker the structure lacks (a
// corrupt/stale directive) → caller treats as unresolved.
function withinSectionOffset(structure: SongStructure, barId: string): { sectionId: string; offset: number } | null {
  const bar = structure.bars.find((b) => b.id === barId);
  if (!bar) return null;
  const sectionBars = structure.bars.filter((b) => b.sectionId === bar.sectionId);
  const offset = sectionBars.findIndex((b) => b.id === barId);
  if (offset < 0) return null;
  return { sectionId: bar.sectionId, offset };
}

function markerBarId(structure: SongStructure, kind: 'segno' | 'coda' | 'fine'): string | null {
  const m = structure.roadmap.find((mk) => mk.kind === kind);
  return m && 'barId' in m ? m.barId : null;
}

export function locateRef(
  structure: SongStructure,
  ref: CanonicalRef,
): { sectionId: string; offset: number } | null {
  switch (ref.kind) {
    case 'pieceStart': {
      const first = structure.sections[0];
      return first ? { sectionId: first.id, offset: 0 } : null;
    }
    case 'segno':
    case 'coda':
    case 'fine': {
      const barId = markerBarId(structure, ref.kind);
      return barId ? withinSectionOffset(structure, barId) : null;
    }
    case 'section': {
      if (!structure.sections.some((s) => s.id === ref.sectionId)) return null;
      return { sectionId: ref.sectionId, offset: Math.max(0, ref.barOffset ?? 0) };
    }
    case 'repeatStart': {
      const m = structure.roadmap.find((mk) => mk.id === ref.markerId && mk.kind === 'repeatStart');
      if (!m || !('barId' in m)) return null;
      const base = withinSectionOffset(structure, m.barId);
      if (!base) return null;
      return { sectionId: base.sectionId, offset: base.offset + Math.max(0, ref.barOffset ?? 0) };
    }
  }
}

// Re-home target for a tacet section: the first FOLLOWING canonical section this
// chart maps as `local` (§2.2.0 — "re-home at the next present section"). Tacet
// and unmapped sections ahead are skipped; null = nothing present to the end.
function nextLocalSection(
  structure: SongStructure,
  alignment: ChartAlignment,
  fromSectionId: string,
): string | null {
  const start = structure.sections.findIndex((s) => s.id === fromSectionId);
  if (start < 0) return null;
  for (let i = start + 1; i < structure.sections.length; i++) {
    const na = alignment.sections[structure.sections[i].id];
    if (na?.status === 'local') return na.localSectionId;
  }
  return null;
}

// ── resolveRef — the core (§2.3 / §2.2.0 / §2.3.1) ───────────────────────────
// Resolve a broadcast CanonicalRef to THIS chart's local node, degrading
// precision (never honesty) down the ladder: local-bar → local-section → tacet
// → self-nav.
export function resolveRef(
  structure: SongStructure,
  alignment: ChartAlignment,
  ref: CanonicalRef,
): RefResolution {
  const loc = locateRef(structure, ref);
  if (!loc) return { status: 'unresolved' };

  const na = alignment.sections[loc.sectionId];
  if (!na || na.status === 'unmapped') return { status: 'unresolved' };

  if (na.status === 'tacet') {
    return { status: 'tacet', rehomeSectionId: nextLocalSection(structure, alignment, loc.sectionId) };
  }

  // status === 'local'
  if (loc.offset > 0 && !na.barIsomorphic) {
    // §2.3.1: a mid-section offset in a non-isomorphic span is non-portable —
    // drop to the section head and flag approximate. NEVER land on a guessed bar.
    return { status: 'local', localSectionId: na.localSectionId, barOffset: 0, barApproximate: true };
  }
  return { status: 'local', localSectionId: na.localSectionId, barOffset: loc.offset, barApproximate: false };
}

// ── Bar-isomorphism (§2.3.1) ─────────────────────────────────────────────────
// A canonical↔local section pair is bar-isomorphic iff: equal bar count AND no
// structural divergence in the span on EITHER side (no repeat/ending/jump/coda/
// fine boundary one chart writes out and the other doesn't). Conservative by
// design — any structural marker in the span disqualifies it, so barOffset can
// never reintroduce finding-4 fragility.
const STRUCTURAL_KINDS = new Set(['repeatStart', 'repeatEnd', 'ending', 'segno', 'coda', 'toCoda', 'fine', 'jump']);

function barIdsOfSection<B extends { id: string; sectionId: string | null }>(bars: B[], sectionId: string): Set<string> {
  return new Set(bars.filter((b) => b.sectionId === sectionId).map((b) => b.id));
}

function hasStructuralMarker(roadmap: RoadmapMarker[] | undefined, sectionBarIds: Set<string>): boolean {
  if (!roadmap) return false;
  return roadmap.some((m) => {
    if (!STRUCTURAL_KINDS.has(m.kind)) return false;
    if (m.kind === 'ending') return m.barIds.some((id) => sectionBarIds.has(id));
    return 'barId' in m && sectionBarIds.has(m.barId);
  });
}

function isBarIsomorphic(
  structure: SongStructure,
  canonicalSectionId: string,
  cal: Pick<ChartCalibration, 'bars' | 'roadmap'>,
  localSectionId: string,
): boolean {
  const canonBarIds = barIdsOfSection(structure.bars, canonicalSectionId);
  const localBarIds = barIdsOfSection(cal.bars ?? [], localSectionId);
  if (canonBarIds.size !== localBarIds.size) return false;
  if (hasStructuralMarker(structure.roadmap, canonBarIds)) return false;
  if (hasStructuralMarker(cal.roadmap, localBarIds)) return false;
  return true;
}

// ── Seed an alignment (§2.2 — the converter/owner proposal) ──────────────────
// Propose how a chart maps into a SongStructure using the label+ordinal seed
// heuristic. A canonical section matches the local section sharing its
// (normalized label, ordinal); matched → `local` (with the bar-isomorphism flag
// computed); UNMATCHED → `unmapped` (loud, → review). The seed NEVER proposes
// `tacet` — "I can't place it" is honestly unmapped; only a human declares a
// genuine rest (degrade to honesty, not a silent guess).
export function seedAlignment(
  structure: SongStructure,
  chartId: string,
  cal: Pick<ChartCalibration, 'sections' | 'bars' | 'roadmap'>,
): ChartAlignment {
  const localOrdinals = sectionOrdinals(cal.sections);
  const canonOrdinals = sectionOrdinals(structure.sections);

  // Index local sections by (normalized label, ordinal) for O(1) lookup.
  const localByKey = new Map<string, SectionAnchor>();
  for (const ls of cal.sections) {
    localByKey.set(`${normalizeLabel(ls.label)}#${localOrdinals.get(ls.id)}`, ls);
  }

  const sections: Record<string, NodeAlignment> = {};
  for (const cs of structure.sections) {
    const key = `${normalizeLabel(cs.label)}#${canonOrdinals.get(cs.id)}`;
    const match = localByKey.get(key);
    sections[cs.id] = match
      ? { status: 'local', localSectionId: match.id, barIsomorphic: isBarIsomorphic(structure, cs.id, cal, match.id) }
      : { status: 'unmapped' };
  }

  return { songId: structure.songId, chartId, sections };
}

// ── Re-key on owner edit (§2.2.1) ────────────────────────────────────────────
// When the owner edits SongStructure, existing alignments are auto-remapped by
// STABLE canonical id — rename/reorder preserve ids, so those alignments survive
// untouched. Only alignments whose canonical node was REMOVED (split/replace
// mints new ids) break and are flagged for re-review. We do NOT invalidate every
// alignment on every edit. New canonical sections simply have no entry yet
// (→ unmapped/self-nav until re-seeded).
export function rekeyAlignment(
  newStructure: SongStructure,
  alignment: ChartAlignment,
): { alignment: ChartAlignment; broken: string[] } {
  const liveIds = new Set(newStructure.sections.map((s) => s.id));
  const kept: Record<string, NodeAlignment> = {};
  const broken: string[] = [];
  for (const [canonId, na] of Object.entries(alignment.sections)) {
    if (liveIds.has(canonId)) kept[canonId] = na;
    else broken.push(canonId);
  }
  return { alignment: { ...alignment, songId: newStructure.songId, sections: kept }, broken };
}
