// ── Roadmap Builder — the editable view model ↔ RoadmapSpec bridge ───────────
// The builder UI edits an ergonomic VIEW (per-bar chord cells whose width ∝ their
// beat span, authored with the terse `-` tie grammar). The persisted SOURCE OF
// TRUTH is RoadmapSpec (sparse BarChange[] with canonical ChordHit beats). This
// module is the PURE, fixture-tested bridge between the two — no IO, no React.
//
// Codex caution (PR #98 review): the mockup's per-cell beats was a visual SHARE
// model (every token beats:1, "even" computed separately). Here a ViewCell.beats
// is the REAL beat span, and cellsToChordHits emits canonical ChordHit beats —
// no-tie bars become even-division (no beats field) or, when they can't divide
// evenly, are rejected so the author reaches for `-`. This is the single place
// the authoring grammar is reconciled with validateRoadmapSpec's beat math.

import {
  QUALITY_WHITELIST,
  type RoadmapSpec,
  type RoadmapSection,
  type BarChange,
  type ChordHit,
  type RoadmapNavigation,
  type BarRef,
} from './roadmap-spec';

// A chord occupying `beats` beats of its measure (the real span — cells in a bar
// sum to timeSig.beats). degree/quality/bass mirror ChordHit; held is carried
// through but not yet expressible in the text grammar.
export interface ViewCell {
  degree: number;
  quality: string;     // '' = major triad
  bass?: number;
  beats: number;       // real beat span within the bar (≥ 1)
  held?: boolean;
}

// A bar is null (no change — inherits the prior chord, sparse chart convention)
// or 1+ cells laid out left→right by beat weight.
export type ViewBar = ViewCell[] | null;

export interface ViewSection {
  id: string;
  label: string;
  bars: number;
  repeat?: RoadmapSection['repeat'];
  chords: ViewBar[];   // length === bars (fitted)
}

export interface ViewModel {
  version: number;
  timeSig: { beats: number; unit: number };
  renderKey: string;
  barsPerLine?: number;
  navigation?: ViewNavigation;
  sections: ViewSection[];
}

// View-level navigation refs key their target section by its STABLE id, NOT the
// positional index RoadmapNavigation.BarRef uses (roadmap-spec). The builder lets
// sections be reordered and removed, which shuffles indices — an index-based ref
// would silently retarget the wrong section and persist a semantically-wrong but
// validator-valid chart (Codex #98 R2). Keying by id makes reorder a no-op for
// navigation and makes a removed-section ref detectable (its id stops resolving);
// viewToSpec lowers ids back to indices and drops navigation if a referenced
// section was deleted.
export interface ViewBarRef {
  sectionId: string;
  bar: number;
}

export interface ViewNavigation {
  segno?: ViewBarRef;
  coda?: ViewBarRef;
  toCoda?: ViewBarRef;
  fine?: ViewBarRef;
  jump?: { at: ViewBarRef; from: 'capo' | 'segno'; until: 'end' | 'fine' | 'coda' };
}

// ── Token grammar (roman → canonical numeric ChordHit) ───────────────────────
// Canonical storage is a numeric degree (1..7) + quality, so a chord typed in
// roman numerals folds on commit (IV→4, IV7→47, vi→6m). Lowercase roman = minor
// when no quality is given. Numeric input passes through. Quality + /bass ride
// along.
const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7 };

interface ParsedPart { degree: number; quality: string }

// Parse one degree token (no slash): accidental + roman|arabic + quality.
function parsePart(s: string, allowQuality: boolean): ParsedPart | { error: string } {
  const m = s.match(/^([b#]?)([IiVv]+|[1-7])(.*)$/);
  if (!m) return { error: `"${s}" is not a chord degree` };
  const [, , numRaw, qualRaw] = m;
  // Accidental on a degree token is not part of the v1 ChordHit vocabulary
  // (degree is 1..7; chromatic spelling rides on the render key), so reject it
  // rather than silently dropping it.
  if (m[1]) return { error: `accidental on degree "${s}" is not supported` };

  let degree: number;
  let minorByCase = false;
  if (/^[1-7]$/.test(numRaw)) {
    degree = Number(numRaw);
  } else {
    const lower = numRaw.toLowerCase();
    if (!(lower in ROMAN)) return { error: `"${s}" is not a valid roman numeral` };
    degree = ROMAN[lower];
    minorByCase = numRaw === lower; // all-lowercase roman = minor
  }

  let quality = qualRaw;
  if (!allowQuality && quality !== '') return { error: `bass "${s}" cannot carry a quality` };
  if (minorByCase && quality === '') quality = 'm';
  if (allowQuality && !QUALITY_WHITELIST.has(quality)) return { error: `quality "${quality}" is not supported` };

  return { degree, quality };
}

// Parse a full chord token (main + optional /bass) into a beat-less ViewCell core.
function parseChordToken(tok: string): Omit<ViewCell, 'beats'> | { error: string } {
  const [main, bass, extra] = tok.split('/');
  if (extra !== undefined) return { error: `"${tok}" has too many "/" separators` };
  const head = parsePart(main, true);
  if ('error' in head) return head;
  const cell: Omit<ViewCell, 'beats'> = { degree: head.degree, quality: head.quality };
  if (bass !== undefined) {
    const b = parsePart(bass, false);
    if ('error' in b) return b;
    cell.bass = b.degree;
  }
  return cell;
}

// ── Authoring string ↔ cells ─────────────────────────────────────────────────

export type BarParse =
  | { ok: true; cells: ViewCell[] }   // cells:[] means "clear this bar" (inherit)
  | { ok: false; error: string };

// Parse a bar's authoring string into beat-weighted cells, reconciled against the
// bar's beat count. Grammar: whitespace-separated chord tokens; `-` ties/extends
// the previous chord by one share. No `-` → chords split the bar EVENLY (must
// divide); any `-` → shares ARE the explicit beats and must sum to the bar.
export function parseBarInput(raw: string, barBeats: number): BarParse {
  const slots = raw.trim().split(/\s+/).filter(Boolean);
  if (slots.length === 0) return { ok: true, cells: [] };

  const cores: Array<Omit<ViewCell, 'beats'>> = [];
  const shares: number[] = [];
  for (const slot of slots) {
    if (slot === '-') {
      if (cores.length === 0) return { ok: false, error: 'a bar cannot start with "-"' };
      shares[shares.length - 1] += 1;
      continue;
    }
    const core = parseChordToken(slot);
    if ('error' in core) return { ok: false, error: core.error };
    cores.push(core);
    shares.push(1);
  }

  const count = cores.length;
  const totalShares = shares.reduce((a, b) => a + b, 0);
  const hasTie = totalShares > count;

  if (count === 1) {
    // Single chord = whole bar (its span is the full bar).
    return { ok: true, cells: [{ ...cores[0], beats: barBeats }] };
  }
  if (!hasTie) {
    // Even division — only legal when the chords divide the bar evenly.
    if (barBeats % count !== 0) {
      return {
        ok: false,
        error: `${count} chords don't divide ${barBeats} beats evenly — use "-" to weight them (e.g. "${slots[0]} - ${slots.slice(1).join(' ')}")`,
      };
    }
    const span = barBeats / count;
    return { ok: true, cells: cores.map((c) => ({ ...c, beats: span })) };
  }
  // Tie/weighted — shares are explicit beats; they must fill the bar exactly.
  if (totalShares !== barBeats) {
    return { ok: false, error: `beats sum to ${totalShares}, expected ${barBeats}` };
  }
  return { ok: true, cells: cores.map((c, i) => ({ ...c, beats: shares[i] })) };
}

// Numbers-mode text for one cell's chord (degree+quality, optional /bass). This
// is the canonical edit form — letters are a display-only re-spelling.
function cellChordText(c: ViewCell): string {
  return `${c.degree}${c.quality}${c.bass != null ? `/${c.bass}` : ''}`;
}

// Does this bar carve into an EVEN division (all equal spans that divide the bar)?
// Drives both the terse round-trip string and the canonical no-beats ChordHit form.
function isEvenDivision(cells: ViewCell[], barBeats: number): boolean {
  if (cells.length <= 1) return false;
  if (barBeats % cells.length !== 0) return false;
  const span = barBeats / cells.length;
  return cells.every((c) => c.beats === span);
}

// Reconstruct the editable authoring string from cells. Prefers the terse forms:
// single chord → just the chord; an even division → space-separated chords (no
// dashes); otherwise explicit ties (chord + (beats-1) dashes).
export function cellsToRaw(cells: ViewCell[], barBeats: number): string {
  if (cells.length === 0) return '';
  if (cells.length === 1) return cellChordText(cells[0]);
  if (isEvenDivision(cells, barBeats)) return cells.map(cellChordText).join(' ');
  return cells
    .map((c) => [cellChordText(c), ...Array(Math.max(0, c.beats - 1)).fill('-')].join(' '))
    .join(' ');
}

// ── Cells ↔ canonical ChordHit[] (the Codex-flagged reconciliation) ──────────

// View cells → canonical ChordHit[] for one bar. Single chord and even divisions
// emit NO beats field (validateRoadmapSpec treats absent beats as even division);
// genuinely uneven bars emit explicit beats on every chord. Matches the
// all-or-none beat contract in validateChords exactly.
export function cellsToChordHits(cells: ViewCell[], barBeats: number): ChordHit[] {
  const explicit = cells.length > 1 && !isEvenDivision(cells, barBeats);
  return cells.map((c) => {
    const hit: ChordHit = { degree: c.degree };
    if (c.quality) hit.quality = c.quality;
    if (c.bass != null) hit.bass = c.bass;
    if (c.held) hit.held = true;
    if (explicit) hit.beats = c.beats;
    return hit;
  });
}

// Canonical ChordHit[] → view cells (real beat spans). Inverse of the above:
// absent beats means even division (single chord = whole bar); explicit beats
// pass through. Falls back to even spans if a stored bar is malformed.
export function chordHitsToCells(chords: ChordHit[], barBeats: number): ViewCell[] {
  const anyBeats = chords.some((c) => c.beats != null);
  return chords.map((c) => {
    const beats = anyBeats
      ? c.beats ?? 1
      : chords.length === 1
        ? barBeats
        : Math.max(1, Math.floor(barBeats / chords.length));
    const cell: ViewCell = { degree: c.degree, quality: c.quality ?? '', beats };
    if (c.bass != null) cell.bass = c.bass;
    if (c.held) cell.held = true;
    return cell;
  });
}

// ── Spec ↔ view ──────────────────────────────────────────────────────────────

// Keep a section's per-bar chord array the same length as its bar count (bars are
// authoritative). Growing pads with null (inherit); shrinking truncates.
export function fitBars(chords: ViewBar[], bars: number): ViewBar[] {
  const out = chords.slice(0, bars);
  while (out.length < bars) out.push(null);
  return out;
}

// Spec BarRef (section INDEX) → view ViewBarRef (section ID). A validated spec's
// index always resolves; an out-of-range one yields null so the ref is dropped.
function liftRef(ref: BarRef, sections: RoadmapSection[]): ViewBarRef | null {
  const sec = sections[ref.section];
  return sec ? { sectionId: sec.id, bar: ref.bar } : null;
}

function liftNavigation(nav: RoadmapNavigation, sections: RoadmapSection[]): ViewNavigation {
  const out: ViewNavigation = {};
  let r: ViewBarRef | null;
  if (nav.segno && (r = liftRef(nav.segno, sections))) out.segno = r;
  if (nav.coda && (r = liftRef(nav.coda, sections))) out.coda = r;
  if (nav.toCoda && (r = liftRef(nav.toCoda, sections))) out.toCoda = r;
  if (nav.fine && (r = liftRef(nav.fine, sections))) out.fine = r;
  if (nav.jump) {
    const at = liftRef(nav.jump.at, sections);
    if (at) out.jump = { at, from: nav.jump.from, until: nav.jump.until };
  }
  return out;
}

// View ViewNavigation (section ID) → spec RoadmapNavigation (section INDEX) at the
// CURRENT section order. If any referenced section id no longer resolves (the
// section was removed in the builder) the whole navigation block is dropped: a
// half-resolved nav set could violate the validator's cross-field preconditions
// (toCoda⇒coda, D.S.⇒segno, al-Coda⇒coda+toCoda), so we fail safe rather than
// persist a dangling marker. Reorder is lossless — ids just map to new indices.
function lowerNavigation(nav: ViewNavigation, sections: ViewSection[]): RoadmapNavigation | null {
  const indexOf = new Map(sections.map((s, i) => [s.id, i] as const));
  let orphaned = false;
  const lower = (ref: ViewBarRef): BarRef => {
    const idx = indexOf.get(ref.sectionId);
    if (idx === undefined) {
      orphaned = true;
      return { section: -1, bar: ref.bar };
    }
    return { section: idx, bar: ref.bar };
  };

  const out: RoadmapNavigation = {};
  if (nav.segno) out.segno = lower(nav.segno);
  if (nav.coda) out.coda = lower(nav.coda);
  if (nav.toCoda) out.toCoda = lower(nav.toCoda);
  if (nav.fine) out.fine = lower(nav.fine);
  if (nav.jump) out.jump = { at: lower(nav.jump.at), from: nav.jump.from, until: nav.jump.until };

  return orphaned ? null : out;
}

// RoadmapSpec → editable ViewModel. Each section's sparse changes are expanded
// onto a per-bar array (length === bars); unaddressed bars are null (inherit).
export function specToView(spec: RoadmapSpec): ViewModel {
  const beats = spec.timeSig.beats;
  return {
    version: spec.version,
    timeSig: spec.timeSig,
    renderKey: spec.renderKey,
    barsPerLine: spec.barsPerLine,
    navigation: spec.navigation ? liftNavigation(spec.navigation, spec.sections) : undefined,
    sections: spec.sections.map((sec) => {
      const chords: ViewBar[] = Array.from({ length: sec.bars }, () => null);
      for (const change of sec.changes ?? []) {
        if (change.bar >= 1 && change.bar <= sec.bars) {
          chords[change.bar - 1] = chordHitsToCells(change.chords, beats);
        }
      }
      return { id: sec.id, label: sec.label, bars: sec.bars, repeat: sec.repeat, chords };
    }),
  };
}

// ViewModel → RoadmapSpec (the persisted source of truth). Re-derives each
// section's sparse changes from its non-null bars. The result is still gated by
// validateRoadmapSpec server-side — this only shapes the payload.
export function viewToSpec(view: ViewModel): RoadmapSpec {
  const beats = view.timeSig.beats;
  const sections: RoadmapSection[] = view.sections.map((sec) => {
    const changes: BarChange[] = [];
    sec.chords.forEach((bar, i) => {
      if (bar && bar.length > 0) {
        changes.push({ bar: i + 1, chords: cellsToChordHits(bar, beats) });
      }
    });
    const out: RoadmapSection = { id: sec.id, label: sec.label, bars: sec.bars };
    if (changes.length > 0) out.changes = changes;
    if (sec.repeat) out.repeat = sec.repeat;
    return out;
  });

  const spec: RoadmapSpec = {
    version: view.version,
    timeSig: view.timeSig,
    renderKey: view.renderKey,
    sections,
  };
  if (view.barsPerLine != null) spec.barsPerLine = view.barsPerLine;
  if (view.navigation) {
    const nav = lowerNavigation(view.navigation, view.sections);
    if (nav) spec.navigation = nav;
  }
  return spec;
}

// ── Nashville degree → letter, in a key (for the Letters display toggle) ─────
const CHROM_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const CHROM_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10];

function keyRootPc(key: string): number {
  const k = key.replace(/m$/, '');
  let pc = LETTER_PC[k[0]] ?? 0;
  if (k[1] === '#') pc += 1;
  if (k[1] === 'b') pc -= 1;
  return (pc + 12) % 12;
}

export function degreeLetter(degree: number, key: string): string {
  const steps = /m$/.test(key) ? MINOR_STEPS : MAJOR_STEPS;
  const pc = (keyRootPc(key) + (steps[degree - 1] ?? 0)) % 12;
  const flat = /b/.test(key) || /^F/.test(key.replace(/m$/, ''));
  return (flat ? CHROM_FLAT : CHROM_SHARP)[pc];
}

// Display text for a cell in the chosen mode: numbers (degree+quality/bass) or
// letters (re-spelled into the render key — the transposition payoff).
export function renderCell(cell: ViewCell, mode: 'numbers' | 'letters', key: string): string {
  if (mode === 'numbers') return cellChordText(cell);
  const head = degreeLetter(cell.degree, key) + cell.quality;
  return cell.bass != null ? `${head}/${degreeLetter(cell.bass, key)}` : head;
}
