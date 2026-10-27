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
  alter?: -1 | 0 | 1;  // flat | natural | sharp on the ROOT (default 0); bass carries no alter (chromatic bass deferred)
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

interface ParsedPart { degree: number; quality: string; alter: -1 | 0 | 1 }

// Parse one degree token (no slash): accidental + roman|arabic + quality.
// parsePart is MECHANICAL — it reports the accidental it parsed as `alter` (for
// EITHER a root or a bass). Scope enforcement (root may carry alter, bass may not
// yet) lives in parseChordToken, so a chromatic bass is rejected there rather than
// silently downgraded. Accepts ASCII (b/#) and Unicode (♭/♯) accidentals.
function parsePart(s: string, allowQuality: boolean): ParsedPart | { error: string } {
  const m = s.match(/^([b#♭♯]?)([IiVv]+|[1-7])(.*)$/);
  if (!m) return { error: `"${s}" is not a chord degree` };
  const [, accRaw, numRaw, qualRaw] = m;
  const alter: -1 | 0 | 1 = accRaw === 'b' || accRaw === '♭' ? -1 : accRaw === '#' || accRaw === '♯' ? 1 : 0;

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

  return { degree, quality, alter };
}

// Parse a full chord token (main + optional /bass) into a beat-less ViewCell core.
// The ROOT keeps its alter; a BASS with an accidental is rejected (chromatic bass
// is deferred — ViewCell.bass has no alter slot, so accepting it would silently
// downgrade 1/♭2 to 1/2). Root-only accidentals for v1.
//
// When `renderKey` is given and the token starts with a letter name (A–G), it is
// read as a LETTER chord through parseLetterChord (the one letters→degrees seam),
// so the manual editor accepts "G7"/"Bm7"/"E/D" in key context. A non-diatonic
// letter chord fails with a clear, key-named error rather than being rounded.
function parseChordToken(tok: string, renderKey?: string): Omit<ViewCell, 'beats'> | { error: string } {
  const [main, bass, extra] = tok.split('/');
  if (extra !== undefined) return { error: `"${tok}" has too many "/" separators` };
  if (renderKey && /^[A-G]/.test(main)) {
    const hit = parseLetterChord(tok, renderKey);
    if (!hit) return { error: `"${tok}" is not a valid chord in ${renderKey}` };
    const cell: Omit<ViewCell, 'beats'> = { degree: hit.degree, quality: hit.quality ?? '' };
    if (hit.alter) cell.alter = hit.alter;
    if (hit.bass != null) cell.bass = hit.bass;
    return cell;
  }
  const head = parsePart(main, true);
  if ('error' in head) return head;
  const cell: Omit<ViewCell, 'beats'> = { degree: head.degree, quality: head.quality };
  if (head.alter) cell.alter = head.alter;
  if (bass !== undefined) {
    const b = parsePart(bass, false);
    if ('error' in b) return b;
    if (b.alter !== 0) return { error: `chromatic bass "${bass}" is not supported yet` };
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
// `renderKey` (when given) lets letter-named tokens be parsed in key context.
export function parseBarInput(raw: string, barBeats: number, renderKey?: string): BarParse {
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
    const core = parseChordToken(slot, renderKey);
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
  const acc = c.alter === -1 ? '♭' : c.alter === 1 ? '♯' : '';
  return `${acc}${c.degree}${c.quality}${c.bass != null ? `/${c.bass}` : ''}`;
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
    if (c.alter) hit.alter = c.alter;     // omit-when-0 (canonical form)
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
    if (c.alter) cell.alter = c.alter;
    if (c.bass != null) cell.bass = c.bass;
    if (c.held) cell.held = true;
    return cell;
  });
}

// ── Spec ↔ view ──────────────────────────────────────────────────────────────

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

// ── Structure edits (design-roadmap-structure-editing.md §3, §5.3) ───────────
// Every edit that changes a section's bars goes through these pure ViewModel →
// ViewModel operations. A section's chords, its repeat (plain needs ≥ 2 bars;
// volta endings are {start,count} ranges) and every nav ref into it point at bar
// POSITIONS, so each op is written as a plan — one entry per NEW bar naming the OLD
// bar it came from — and `applyPlan` moves every reference with its bar in the same
// step. The UI never edits bars / chords / repeat / navigation itself.
//
// Result: refused with a reason, or applied. An applied op that took something
// with it lists it in `removes` (the UI confirms before keeping the result);
// `edit` is the op's bar map (new bar → old 0-based bar, null = new blank bar),
// which the property test uses to carry synthetic bar ids through the op.
export type OpResult =
  | { ok: true; view: ViewModel; removes: string[]; edit?: { sectionId: string; src: (number | null)[] } }
  | { ok: false; reason: string };

// A bar's place in its section's repeat: the volta BODY (every bar before the
// earliest ending — endings[] order is not position order), one ending (its index
// in endings[]), or neither (a gap between endings, or a tail after them).
// Sections without a volta repeat are all 'body'.
type BarGroup = 'body' | 'none' | number;

interface PlannedBar {
  src: number | null; // old 0-based bar, or null for a new (blank) bar
  chords: ViewBar;
  group: BarGroup;
}

type MarkerKey = 'segno' | 'coda' | 'toCoda' | 'fine' | 'jump';
const MARKER_KEYS: MarkerKey[] = ['segno', 'coda', 'toCoda', 'fine', 'jump'];

// Which barline the renderer draws each marker on (roadmap-render.ts: segno/coda
// are edge 'start', To Coda / Fine / the D.S.–D.C. departure are edge 'end'). A
// split sends a start-edge marker to the FIRST new bar and an end-edge one to the
// LAST, so the musical bar still begins / ends where it did.
const MARKER_EDGE: Record<MarkerKey, 'start' | 'end'> = {
  segno: 'start',
  coda: 'start',
  toCoda: 'end',
  fine: 'end',
  jump: 'end',
};

function markerRef(nav: ViewNavigation, key: MarkerKey): ViewBarRef | undefined {
  return key === 'jump' ? nav.jump?.at : nav[key];
}

// The marker's printed name, for confirms ("removes the D.C. al Fine").
function markerName(nav: ViewNavigation, key: MarkerKey): string {
  if (key === 'segno') return 'Segno';
  if (key === 'coda') return 'Coda';
  if (key === 'toCoda') return 'To Coda';
  if (key === 'fine') return 'Fine';
  const j = nav.jump;
  const from = j?.from === 'segno' ? 'D.S.' : 'D.C.';
  const until = j?.until === 'coda' ? ' al Coda' : j?.until === 'fine' ? ' al Fine' : '';
  return `${from}${until}`;
}

// Close a set of removed markers over validateNavigation's preconditions: a To
// Coda needs its Coda; a D.S. needs the Segno, al Fine the Fine, al Coda the Coda
// and To Coda. Removing a marker removes what can't stand without it — never
// leaves a nav block the validator would reject (or the old "drop the whole block").
function withDependents(nav: ViewNavigation, removed: Set<MarkerKey>): Set<MarkerKey> {
  const out = new Set(removed);
  if (out.has('coda') && nav.toCoda) out.add('toCoda');
  const j = nav.jump;
  if (
    j &&
    ((out.has('segno') && j.from === 'segno') ||
      (out.has('fine') && j.until === 'fine') ||
      ((out.has('coda') || out.has('toCoda')) && j.until === 'coda'))
  ) {
    out.add('jump');
  }
  return out;
}

function dropMarkers(nav: ViewNavigation, keys: Set<MarkerKey>): ViewNavigation | undefined {
  const out: ViewNavigation = { ...nav };
  for (const k of keys) delete out[k];
  return Object.keys(out).length > 0 ? out : undefined;
}

function repeatName(repeat: NonNullable<ViewSection['repeat']>): string {
  return repeat.kind === 'plain' ? `the ×${repeat.times} repeat` : `the ${repeat.endings.length} endings`;
}

function barGroups(sec: ViewSection): BarGroup[] {
  const r = sec.repeat;
  if (r?.kind !== 'volta') return Array.from({ length: sec.bars }, () => 'body' as const);
  const earliest = Math.min(...r.endings.map((e) => e.bars.start));
  return Array.from({ length: sec.bars }, (_, i) => {
    const bar = i + 1;
    if (bar < earliest) return 'body' as const;
    const e = r.endings.findIndex((x) => bar >= x.bars.start && bar < x.bars.start + x.bars.count);
    return e === -1 ? ('none' as const) : e;
  });
}

// The identity plan for a section — each op edits a copy of it.
function identityPlan(sec: ViewSection): PlannedBar[] {
  const groups = barGroups(sec);
  return sec.chords.map((chords, i) => ({ src: i, chords, group: groups[i] }));
}

function findSection(view: ViewModel, sectionId: string): ViewSection | null {
  return view.sections.find((s) => s.id === sectionId) ?? null;
}

function badBar(sec: ViewSection, bar: number): boolean {
  return !Number.isInteger(bar) || bar < 1 || bar > sec.bars;
}

// Apply a plan to one section: rebuild its chords, recompute its repeat from the
// bars' groups, and move every nav ref with its bar. A ref whose bar was deleted is
// removed (with its dependents) and named in `removes`; it is never shifted onto a
// neighbour.
function applyPlan(view: ViewModel, sectionId: string, plan: PlannedBar[]): OpResult {
  const sec = findSection(view, sectionId);
  if (!sec) return { ok: false, reason: 'that section no longer exists' };
  if (plan.length === 0) return { ok: false, reason: 'a section needs at least one bar' };
  const removes: string[] = [];

  // Where did each old bar go? first/last new 0-based index (they differ after a split).
  const first = new Map<number, number>();
  const last = new Map<number, number>();
  plan.forEach((b, i) => {
    if (b.src == null) return;
    if (!first.has(b.src)) first.set(b.src, i);
    last.set(b.src, i);
  });

  let repeat = sec.repeat;
  if (repeat?.kind === 'plain' && plan.length < 2) {
    removes.push(repeatName(repeat));
    repeat = undefined;
  } else if (repeat?.kind === 'volta') {
    const r = repeat;
    const spans = r.endings.map((_, ei) => {
      const at = plan.flatMap((b, i) => (b.group === ei ? [i] : []));
      return at.length === 0 ? null : { start: at[0] + 1, count: at.length, contiguous: at[at.length - 1] - at[0] + 1 === at.length };
    });
    if (spans.some((s) => s === null)) {
      removes.push(repeatName(r));
      repeat = undefined;
    } else {
      if (spans.some((s) => !s!.contiguous)) return { ok: false, reason: 'that edit would split an ending in two' };
      if (Math.min(...spans.map((s) => s!.start)) <= 1) {
        return { ok: false, reason: 'the repeat needs a bar before its endings — remove the endings first' };
      }
      repeat = {
        kind: 'volta',
        endings: r.endings.map((e, ei) => ({ ...e, bars: { start: spans[ei]!.start, count: spans[ei]!.count } })),
      };
    }
  }

  let navigation = view.navigation;
  if (navigation) {
    const nav = navigation;
    const gone = new Set<MarkerKey>();
    const moved: Partial<Record<MarkerKey, ViewBarRef>> = {};
    for (const k of MARKER_KEYS) {
      const ref = markerRef(nav, k);
      if (!ref || ref.sectionId !== sectionId) continue;
      const to = (MARKER_EDGE[k] === 'start' ? first : last).get(ref.bar - 1);
      if (to === undefined) gone.add(k);
      else moved[k] = { sectionId, bar: to + 1 };
    }
    const next: ViewNavigation = { ...nav };
    for (const k of MARKER_KEYS) {
      const to = moved[k];
      if (!to) continue;
      if (k === 'jump') next.jump = { ...nav.jump!, at: to };
      else next[k] = to;
    }
    if (gone.size > 0) {
      const all = withDependents(nav, gone);
      for (const k of MARKER_KEYS) if (all.has(k)) removes.push(`the ${markerName(nav, k)}`);
      navigation = dropMarkers(next, all);
    } else {
      navigation = next;
    }
  }

  const nextSec: ViewSection = {
    id: sec.id,
    label: sec.label,
    bars: plan.length,
    chords: plan.map((b) => b.chords),
  };
  if (repeat) nextSec.repeat = repeat;
  const nextView: ViewModel = {
    ...view,
    sections: view.sections.map((s) => (s.id === sectionId ? nextSec : s)),
  };
  if (navigation) nextView.navigation = navigation;
  else delete nextView.navigation;
  return { ok: true, view: nextView, removes, edit: { sectionId, src: plan.map((b) => b.src) } };
}

// A bar of k ≥ 2 chords → k bars, one chord each, whole bar (`D E` → `D | E`).
export function splitBar(view: ViewModel, sectionId: string, bar: number): OpResult {
  const sec = findSection(view, sectionId);
  if (!sec) return { ok: false, reason: 'that section no longer exists' };
  if (badBar(sec, bar)) return { ok: false, reason: `bar ${bar} is not in ${sec.label}` };
  const cells = sec.chords[bar - 1] ?? [];
  if (cells.length < 2) return { ok: false, reason: 'only a bar with two or more chords can be split' };
  const plan = identityPlan(sec);
  const at = plan[bar - 1];
  const beats = view.timeSig.beats;
  plan.splice(bar - 1, 1, ...cells.map((c) => ({ src: at.src, chords: [{ ...c, beats }], group: at.group })));
  return applyPlan(view, sectionId, plan);
}

// A new BLANK bar before or after `bar`. It joins that bar's repeat group; the
// existing bar keeps its markers wherever it moves.
export function insertBar(view: ViewModel, sectionId: string, bar: number, side: 'before' | 'after'): OpResult {
  const sec = findSection(view, sectionId);
  if (!sec) return { ok: false, reason: 'that section no longer exists' };
  if (badBar(sec, bar)) return { ok: false, reason: `bar ${bar} is not in ${sec.label}` };
  const plan = identityPlan(sec);
  plan.splice(side === 'before' ? bar - 1 : bar, 0, { src: null, chords: null, group: plan[bar - 1].group });
  return applyPlan(view, sectionId, plan);
}

// Delete one bar. Refused on the only bar, and on the last body bar of a volta
// section; otherwise anything that can't survive it (a marker on it, an ending it
// was the only bar of, a plain repeat left at 1 bar) comes back in `removes`.
export function deleteBar(view: ViewModel, sectionId: string, bar: number): OpResult {
  const sec = findSection(view, sectionId);
  if (!sec) return { ok: false, reason: 'that section no longer exists' };
  if (badBar(sec, bar)) return { ok: false, reason: `bar ${bar} is not in ${sec.label}` };
  if (sec.bars === 1) return { ok: false, reason: 'a section needs at least one bar — remove the section instead' };
  const plan = identityPlan(sec);
  if (plan[bar - 1].group === 'body' && sec.repeat?.kind === 'volta' && plan.filter((b) => b.group === 'body').length === 1) {
    return { ok: false, reason: 'the repeat needs a bar before its endings — remove the endings first' };
  }
  plan.splice(bar - 1, 1);
  return applyPlan(view, sectionId, plan);
}

// The section's bar-count field: insert or delete at the END, one bar at a time
// through the ops above, so a shrink moves / removes markers and endings exactly
// as deleting those bars by hand would (and refuses where that would).
export function setBarCount(view: ViewModel, sectionId: string, bars: number): OpResult {
  const sec = findSection(view, sectionId);
  if (!sec) return { ok: false, reason: 'that section no longer exists' };
  if (!Number.isInteger(bars) || bars < 1) return { ok: false, reason: 'a section needs at least one bar' };
  let cur: ViewModel = view;
  const removes: string[] = [];
  let n = sec.bars;
  while (n !== bars) {
    const r = n < bars ? insertBar(cur, sectionId, n, 'after') : deleteBar(cur, sectionId, n);
    if (!r.ok) return r;
    cur = r.view;
    for (const x of r.removes) if (!removes.includes(x)) removes.push(x);
    n += n < bars ? 1 : -1;
  }
  // The composite's bar map: the first min(old, new) bars stay; the rest are new.
  const src = Array.from({ length: bars }, (_, i) => (i < sec.bars ? i : null));
  return { ok: true, view: cur, removes, edit: { sectionId, src } };
}

// Remove a whole section. Markers inside it are removed with their dependents and
// named — replacing viewToSpec's silent drop of the entire navigation block.
export function removeSection(view: ViewModel, sectionId: string): OpResult {
  if (!findSection(view, sectionId)) return { ok: false, reason: 'that section no longer exists' };
  const removes: string[] = [];
  let navigation = view.navigation;
  if (navigation) {
    const nav = navigation;
    const gone = new Set(MARKER_KEYS.filter((k) => markerRef(nav, k)?.sectionId === sectionId));
    if (gone.size > 0) {
      const all = withDependents(nav, gone);
      for (const k of MARKER_KEYS) if (all.has(k)) removes.push(`the ${markerName(nav, k)}`);
      navigation = dropMarkers(nav, all);
    }
  }
  const next: ViewModel = { ...view, sections: view.sections.filter((s) => s.id !== sectionId) };
  if (navigation) next.navigation = navigation;
  else delete next.navigation;
  return { ok: true, view: next, removes };
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

// Does `key` spell with flats? A key's own accidental decides: a sharp key (name
// carries #) spells sharp, a flat key (name carries b) spells flat. For a plain
// natural-letter key it comes down to the key signature — F major and the flat
// natural minors (Cm/Dm/Fm/Gm) use flats; the sharp naturals (G/D/A/E/B, Bm/Em) and
// neutral C/Am use sharps. The earlier `/^F/` heuristic was the bug: it matched F#
// (and F#m) as well as F, so an F# chart spelled from the flat table — tonic F# → Gb.
function keyPrefersFlat(key: string): boolean {
  const minor = /m$/.test(key);
  const bare = key.replace(/m$/, '');
  if (bare.includes('#')) return false; // explicit sharp key
  if (bare.includes('b')) return true; // explicit flat key
  return minor ? 'CDFG'.includes(bare[0]) : bare[0] === 'F'; // natural-letter keys
}

// Spell a degree as a letter in `key`. `alter` (a ±1 semitone on the ROOT, default
// 0) rides on whatever pitch the degree resolves to in the active key's scale
// (MAJOR_STEPS for major, MINOR_STEPS for minor — so alter is mode-agnostic). An
// altered note prefers the spelling matching its accidental direction (flat for
// ♭, sharp for ♯); an unaltered note follows the key's own accidental (keyPrefersFlat).
//
// ACCEPTED LIMITATION (Graham 2026-08-29): each pitch class maps to ONE name, so a
// key whose diatonic spelling needs a "double" name renders its enharmonic instead —
// F# major's 7th prints F (not E#), Eb minor's 6th prints B (not Cb). Same pitch,
// and preferred to a strict diatonic speller here. Not a bug.
export function degreeLetter(degree: number, key: string, alter: -1 | 0 | 1 = 0): string {
  const steps = /m$/.test(key) ? MINOR_STEPS : MAJOR_STEPS;
  const pc = (keyRootPc(key) + (steps[degree - 1] ?? 0) + alter + 12) % 12;
  const flat = alter !== 0 ? alter < 0 : keyPrefersFlat(key);
  return (flat ? CHROM_FLAT : CHROM_SHARP)[pc];
}

// ── Letter chord → Nashville degree, in a key (the inverse of degreeLetter) ──
// The key-aware front-end for letter-named input (chunk-5 §7.1, L1 grammar + the
// manual editor). degreeLetter spells a degree as a letter IN a key; this reads a
// letter back to its degree in that key. It is the ONE place letters→degrees, so
// the AI parse path and the manual editor agree by construction.

// A note name (A–G) + optional accidental → pitch class, or null if unparseable.
function noteLetterPc(letter: string, accidental: string): number | null {
  const base = LETTER_PC[letter];
  if (base === undefined) return null;
  const delta = accidental === '#' || accidental === '♯' ? 1 : accidental === 'b' || accidental === '♭' ? -1 : 0;
  return (base + delta + 12) % 12;
}

// The diatonic pitch classes of `key`, indexed by degree-1 (major or minor scale,
// the same scale degreeLetter spells against — no second source of truth).
function diatonicDegreePcs(key: string): number[] {
  const steps = /m$/.test(key) ? MINOR_STEPS : MAJOR_STEPS;
  const root = keyRootPc(key);
  return steps.map((s) => (root + s) % 12);
}

// Read one letter part (root or bass) to a degree in `key`. A diatonic letter maps
// straight to its degree. A chromatic ROOT (no diatonic match — e.g. C in D) is
// canonicalized by Gap-1's prefer-flat-upper-neighbor rule: it sits a semitone
// below exactly one diatonic degree (pc+1 is always diatonic for a chromatic pc in
// a diatonic scale), so it becomes that upper neighbor with alter:-1 (C in D → ♭7;
// Eb in D → ♭2). The five chromatic roots canonicalize to ♭2,♭3,♭5,♭6,♭7 in a MAJOR
// key; the set shifts to ♭1,♭2,♭4,♭5,♭7 in a MINOR key because the scale's semitone
// gaps move (so the "missing" flats land on a diatonic note instead). A chromatic
// BASS stays deferred (null) — ViewCell.bass has no alter slot, so root-only for
// v1. quality is only allowed on the root, mirroring parsePart's split.
function letterPartToDegree(
  s: string,
  key: string,
  allowQuality: boolean,
): { degree: number; quality: string; alter: -1 | 0 | 1 } | null {
  const m = s.match(/^([A-G])([b#♭♯]?)(.*)$/);
  if (!m) return null;
  const [, letter, acc, qualRaw] = m;
  const pc = noteLetterPc(letter, acc);
  if (pc === null) return null;
  if (!allowQuality && qualRaw !== '') return null;
  if (allowQuality && !QUALITY_WHITELIST.has(qualRaw)) return null;
  const pcs = diatonicDegreePcs(key);
  const idx = pcs.indexOf(pc);
  if (idx !== -1) return { degree: idx + 1, quality: qualRaw, alter: 0 };
  if (!allowQuality) return null; // chromatic bass → deferred (root-only for v1)
  const upper = pcs.indexOf((pc + 1) % 12); // upper diatonic neighbor → flat spelling
  if (upper === -1) return null; // unreachable for a chromatic pc, but fail closed
  return { degree: upper + 1, quality: qualRaw, alter: -1 };
}

// Parse a full letter chord (root[acc][quality][/bass]) to a canonical ChordHit in
// `renderKey`, or null when the bass is non-diatonic / the token is malformed (the
// whole token defers — never a lossy partial). "G7" in D → {degree:4, quality:'7'};
// "Bm7" → {degree:6, quality:'m7'}; "E/D" in D → {degree:2, bass:1} (in G → {6,
// bass:5} — the key decides). A chromatic ROOT canonicalizes to {degree,alter:-1}
// (C in D → {7, alter:-1} = ♭VII); a chromatic slash BASS still returns null.
export function parseLetterChord(token: string, renderKey: string): ChordHit | null {
  const [main, bass, extra] = token.split('/');
  if (extra !== undefined) return null; // too many "/" separators
  const head = letterPartToDegree(main, renderKey, true);
  if (!head) return null;
  const hit: ChordHit = { degree: head.degree };
  if (head.alter) hit.alter = head.alter;
  if (head.quality) hit.quality = head.quality;
  if (bass !== undefined) {
    const b = letterPartToDegree(bass, renderKey, false);
    if (!b) return null; // chromatic / invalid bass → defer the WHOLE token
    hit.bass = b.degree;
  }
  return hit;
}

// Display text for a cell in the chosen mode: numbers (degree+quality/bass) or
// letters (re-spelled into the render key — the transposition payoff). The bass
// carries no alter (chromatic bass deferred), so it always spells diatonically.
export function renderCell(cell: ViewCell, mode: 'numbers' | 'letters', key: string): string {
  if (mode === 'numbers') return cellChordText(cell);
  const head = degreeLetter(cell.degree, key, cell.alter ?? 0) + cell.quality;
  return cell.bass != null ? `${head}/${degreeLetter(cell.bass, key)}` : head;
}
