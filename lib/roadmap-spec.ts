// ── Roadmap Builder — the authored source spec + its deterministic validator ──
// A RoadmapSpec is the SOURCE OF TRUTH for a builder chart: the author describes
// a song's structure (time signature, ordered sections with bar counts, optional
// Nashville changes, repeats/endings) and we DERIVE the PDF substrate + a
// born-verified ChartCalibration from it (chunk 1). This file is chunk 0: the
// contract everything else binds to, plus the pure validator that is the DB
// boundary gate — the spec analogue of isValidCalibration (lib/chart-calibration).
//
// The validator is deterministic and has no IO: the AI parse route (chunk 2) and
// the save route (chunk 5) both run it; the model proposes, this math gates.

// ── Model ───────────────────────────────────────────────────────────────────

// The authored source of a builder chart. PDF + ChartCalibration are DERIVED
// from this; this is the source of truth. Persisted as chart_library.source_spec
// (design Open Q2). Nashville changes are key-agnostic (degree + quality), so
// renderKey only fixes the printed key for this single artifact (v1 = cheap
// re-key; see design §Transposition).
export interface RoadmapSpec {
  version: number;
  timeSig: { beats: number; unit: number };   // e.g. { beats: 4, unit: 4 }
  renderKey: string;                           // printed key, e.g. "G" / "Bb" / "Am"
  barsPerLine?: number;                        // layout hint (default applied by the renderer)
  sections: RoadmapSection[];                  // ordered; the song form
  navigation?: RoadmapNavigation;              // OPTIONAL global jumps/targets (D.S./D.C./Coda/Fine/Segno)
}

export interface RoadmapSection {
  id: string;
  label: string;                               // "Intro", "Verse", "Chorus", "Solo"
  bars: number;                                // count (the form math the validator checks)
  changes?: BarChange[];                       // optional NNS changes (sparse; one entry per addressed bar)
  repeat?: SectionRepeat;                      // section-scoped repeat; maps to RoadmapMarkers on render
}

// A repeat is EITHER a plain |: … :|×times OR a volta repeat (1st/2nd… endings) —
// NEVER both. The discriminated union encodes that at the type level, matching
// resolveRoadmap §5#4 (a repeatStart binds EITHER a repeatEnd OR endings, never
// both) so the renderer cannot emit an unresolvable marker set. Section-scoped:
// the repeatStart anchors the section's FIRST bar.
export type SectionRepeat =
  | { kind: 'plain'; times: number }            // |: … :|×times  → repeatStart + repeatEnd(times)
  | { kind: 'volta'; endings: VoltaEnding[] };   // |: …[1.][2.]   → repeatStart + ending markers

// One volta bracket. `bars` is a CONTIGUOUS range within the section (contiguity
// guaranteed by {start,count}, which a loose number[][] could not express).
// `passes` = which repeat passes take this ending (e.g. [1] or [2,3]).
export interface VoltaEnding {
  bars: { start: number; count: number };      // 1-based range within the section; start MUST be > 1, count >= 1
  passes: number[];                            // ⋃ passes across endings must partition 1..max
}

// Global roadmap jumps/targets — segno/coda/D.S./D.C./Fine. Each is a reference to
// a (section, bar) position the renderer resolves to a barId and emits as the
// matching RoadmapMarker (lib/types.ts). All optional; present only when used. The
// validator mirrors resolveRoadmap's preconditions so a born-verified chart can
// never carry a dangling jump.
export interface RoadmapNavigation {
  segno?: BarRef;                              // 𝄋 target            → segno marker
  coda?: BarRef;                               // ⊕ coda target       → coda marker
  toCoda?: BarRef;                             // "To Coda" departure → toCoda marker
  fine?: BarRef;                               // Fine end point      → fine marker
  jump?: {                                     // D.C. (from:'capo') / D.S. (from:'segno')
    at: BarRef;                                //   departure bar
    from: 'capo' | 'segno';
    until: 'end' | 'fine' | 'coda';
  };
}

// A position within the form: section index (0-based, into spec.sections) + 1-based
// bar within that section. The renderer maps this to a concrete barId once bar
// geometry is expanded.
export interface BarRef { section: number; bar: number; }

export interface BarChange {
  bar: number;                                 // 1-based within the section
  chords: ChordHit[];                          // 1 = whole bar; >1 = split bar (beats sum to timeSig.beats)
}

export interface ChordHit {
  degree: number;                              // 1..7 (Nashville scale degree)
  alter?: -1 | 0 | 1;                          // flat | natural | sharp on the degree ROOT; omitted = 0 (diatonic). e.g. ♭VII in D = { degree: 7, alter: -1 }
  quality?: string;                            // '' = major triad; see QUALITY_WHITELIST
  bass?: number;                               // slash-chord bass degree 1..7 (chromatic bass not yet supported)
  beats?: number;                              // split-bar weight; omitted = even division of the bar
  held?: boolean;                              // diamond / whole-note hold
}

// ── v1 vocabulary (design §"NNS scope" / Open Q5) ────────────────────────────

// The only RoadmapSpec version this build understands. The validator is the DB
// boundary, so it FAILS CLOSED on any other version — a future/AI-produced v2
// payload must not slip past today's validator into a renderer with v1 semantics.
// Bump in lockstep with a migration when the spec shape changes.
export const ROADMAP_SPEC_VERSION = 1;

// Time-signature lower number (the beat unit). Whole..sixteenth.
export const TIME_SIG_UNITS: readonly number[] = [1, 2, 4, 8, 16];

// Chord qualities accepted in v1: triads + common 7ths + dim/sus (+ 6ths).
// Full reharm/altered-dominant taxonomy is deferred (design Open Q5). '' = major.
export const QUALITY_WHITELIST: ReadonlySet<string> = new Set([
  '',        // major triad
  'm',       // minor triad
  'dim',     // diminished triad
  'aug',     // augmented triad
  'sus', 'sus2', 'sus4',
  '7',       // dominant 7
  'maj7',
  'm7',
  'm7b5',    // half-diminished
  'dim7',
  '6', 'm6',
]);

// A printed key: A–G, optional accidental, optional minor 'm'. e.g. G, Bb, F#, Am, C#m.
const KEY_PATTERN = /^[A-G](#|b)?m?$/;

export function isValidKey(k: unknown): k is string {
  return typeof k === 'string' && KEY_PATTERN.test(k);
}

// ── Validator (the DB boundary gate) ─────────────────────────────────────────

export type SpecValidation =
  | { ok: true; spec: RoadmapSpec }
  | { ok: false; errors: string[] };

function isInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n);
}

// Validate an untrusted value as a RoadmapSpec: structural shape AND musical
// coherence (bar math, time-sig consistency, degree/quality whitelist, split-bar
// beat sums, repeat/ending balance). Returns every problem found (not just the
// first) so the builder UI can surface them all at once. ok:true narrows the
// input to RoadmapSpec for the renderer/save path.
export function validateRoadmapSpec(input: unknown): SpecValidation {
  const errors: string[] = [];

  if (!input || typeof input !== 'object') {
    return { ok: false, errors: ['spec must be an object'] };
  }
  const s = input as Record<string, unknown>;

  if (s.version !== ROADMAP_SPEC_VERSION) {
    errors.push(`version must be ${ROADMAP_SPEC_VERSION} (unsupported spec version)`);
  }

  // Time signature.
  let beats = 0;
  if (!s.timeSig || typeof s.timeSig !== 'object') {
    errors.push('timeSig must be an object { beats, unit }');
  } else {
    const ts = s.timeSig as Record<string, unknown>;
    if (!isInt(ts.beats) || (ts.beats as number) < 1 || (ts.beats as number) > 32) {
      errors.push('timeSig.beats must be an integer 1..32');
    } else {
      beats = ts.beats as number;
    }
    if (!isInt(ts.unit) || !TIME_SIG_UNITS.includes(ts.unit as number)) {
      errors.push(`timeSig.unit must be one of ${TIME_SIG_UNITS.join(', ')}`);
    }
  }

  if (!isValidKey(s.renderKey)) {
    errors.push('renderKey must be a key like "G", "Bb", "F#", or "Am"');
  }

  if (s.barsPerLine !== undefined && (!isInt(s.barsPerLine) || (s.barsPerLine as number) < 1 || (s.barsPerLine as number) > 16)) {
    errors.push('barsPerLine, when set, must be an integer 1..16');
  }

  // Sections.
  if (!Array.isArray(s.sections) || s.sections.length === 0) {
    errors.push('sections must be a non-empty array');
    return errors.length > 0 ? { ok: false, errors } : { ok: true, spec: input as RoadmapSpec };
  }

  const sectionIds = new Set<string>();
  const sectionBars: number[] = [];            // bar count per section index (0 = invalid); for BarRef resolution
  s.sections.forEach((raw, i) => {
    const where = `section ${i + 1}`;
    if (!raw || typeof raw !== 'object') {
      errors.push(`${where} must be an object`);
      return;
    }
    const sec = raw as Record<string, unknown>;
    const label = typeof sec.label === 'string' ? sec.label.trim() : '';
    const name = label || where;

    if (typeof sec.id !== 'string' || sec.id.length === 0) {
      errors.push(`${where}: id must be a non-empty string`);
    } else if (sectionIds.has(sec.id)) {
      errors.push(`${where}: duplicate section id "${sec.id}"`);
    } else {
      sectionIds.add(sec.id);
    }

    if (label === '') errors.push(`${where}: label must be a non-empty string`);

    let secBars = 0;
    if (!isInt(sec.bars) || (sec.bars as number) < 1) {
      errors.push(`${name}: bars must be an integer >= 1`);
    } else {
      secBars = sec.bars as number;
    }
    sectionBars[i] = secBars;

    // Changes (optional, sparse).
    if (sec.changes !== undefined) {
      if (!Array.isArray(sec.changes)) {
        errors.push(`${name}: changes must be an array`);
      } else {
        const seenBars = new Set<number>();
        sec.changes.forEach((rawCh, ci) => {
          const chWhere = `${name} change ${ci + 1}`;
          if (!rawCh || typeof rawCh !== 'object') {
            errors.push(`${chWhere} must be an object`);
            return;
          }
          const ch = rawCh as Record<string, unknown>;
          if (!isInt(ch.bar) || (ch.bar as number) < 1 || (secBars > 0 && (ch.bar as number) > secBars)) {
            errors.push(`${chWhere}: bar must be an integer within 1..${secBars || '?'}`);
          } else if (seenBars.has(ch.bar as number)) {
            errors.push(`${name}: duplicate change for bar ${ch.bar}`);
          } else {
            seenBars.add(ch.bar as number);
          }
          validateChords(ch.chords, `${name} bar ${typeof ch.bar === 'number' ? ch.bar : '?'}`, beats, errors);
        });
      }
    }

    // Repeat / endings.
    if (sec.repeat !== undefined) {
      validateRepeat(sec.repeat, name, secBars, errors);
    }
  });

  // Navigation (optional) — validated after sections so BarRefs resolve against
  // the collected section bar counts.
  if (s.navigation !== undefined) {
    validateNavigation(s.navigation, sectionBars, errors);
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, spec: input as RoadmapSpec };
}

// Convenience boolean guard wrapping the full validator.
export function isValidRoadmapSpec(input: unknown): input is RoadmapSpec {
  return validateRoadmapSpec(input).ok;
}

// ── Internal sub-validators ──────────────────────────────────────────────────

// A bar's chords: each chord well-formed, and the split-bar beat math reconciles
// with the time signature. Single chord = whole bar. Multiple chords with no
// explicit beats = even division (the bar's beats must divide evenly). Explicit
// beats must be all-or-none and sum to the bar's beats.
function validateChords(chords: unknown, where: string, beats: number, errors: string[]): void {
  if (!Array.isArray(chords) || chords.length === 0) {
    errors.push(`${where}: chords must be a non-empty array`);
    return;
  }

  let withBeats = 0;
  let beatSum = 0;
  chords.forEach((rawC, i) => {
    const cw = `${where} chord ${i + 1}`;
    if (!rawC || typeof rawC !== 'object') {
      errors.push(`${cw} must be an object`);
      return;
    }
    const c = rawC as Record<string, unknown>;
    if (!isInt(c.degree) || (c.degree as number) < 1 || (c.degree as number) > 7) {
      errors.push(`${cw}: degree must be an integer 1..7`);
    }
    if (c.alter !== undefined && c.alter !== -1 && c.alter !== 0 && c.alter !== 1) {
      errors.push(`${cw}: alter must be -1, 0, or 1`);
    }
    if (c.quality !== undefined && !(typeof c.quality === 'string' && QUALITY_WHITELIST.has(c.quality))) {
      errors.push(`${cw}: quality "${String(c.quality)}" is not in the v1 vocabulary`);
    }
    if (c.bass !== undefined && (!isInt(c.bass) || (c.bass as number) < 1 || (c.bass as number) > 7)) {
      errors.push(`${cw}: bass must be an integer 1..7`);
    }
    if (c.held !== undefined && typeof c.held !== 'boolean') {
      errors.push(`${cw}: held must be a boolean`);
    }
    if (c.beats !== undefined) {
      if (!isInt(c.beats) || (c.beats as number) < 1) {
        errors.push(`${cw}: beats must be an integer >= 1`);
      } else {
        withBeats += 1;
        beatSum += c.beats as number;
      }
    }
  });

  if (beats <= 0) return; // time sig already flagged; skip beat math

  if (withBeats === 0) {
    // Even division: the bar's beats must split evenly across the chords.
    if (chords.length > 1 && beats % chords.length !== 0) {
      errors.push(`${where}: ${chords.length} chords don't divide ${beats} beats evenly — set explicit beats`);
    }
  } else if (withBeats !== chords.length) {
    errors.push(`${where}: set beats on all chords or none`);
  } else if (beatSum !== beats) {
    errors.push(`${where}: split beats sum to ${beatSum}, expected ${beats}`);
  }
}

// A section repeat is a discriminated union (SectionRepeat): EITHER a plain
// |: … :|×times OR a volta repeat with endings — never both (mirrors
// resolveRoadmap §5#4). A plain repeat emits repeatStart on the section's first
// bar and repeatEnd on its last; resolveRoadmap rejects repeatEnd whose position
// is <= the repeatStart (lib/chart-calibration.ts:954), so a 1-bar section would
// collide them — hence section.bars >= 2 for a plain repeat.
function validateRepeat(repeat: unknown, where: string, secBars: number, errors: string[]): void {
  if (!repeat || typeof repeat !== 'object') {
    errors.push(`${where}: repeat must be an object`);
    return;
  }
  const r = repeat as Record<string, unknown>;

  if (r.kind === 'plain') {
    if (!isInt(r.times) || (r.times as number) < 2) {
      errors.push(`${where}: plain repeat.times must be an integer >= 2`);
    }
    if (secBars > 0 && secBars < 2) {
      errors.push(`${where}: a plain repeat needs section.bars >= 2 (a 1-bar section collides repeatStart and repeatEnd)`);
    }
  } else if (r.kind === 'volta') {
    validateVolta(r.endings, where, secBars, errors);
  } else {
    errors.push(`${where}: repeat.kind must be 'plain' or 'volta'`);
  }
}

// Volta endings: each VoltaEnding.bars is a contiguous in-range slice of the
// section (start > 1 — after the section-anchored repeatStart — and count >= 1,
// not running past the section), ending ranges are non-overlapping, and the union
// of passes partitions 1..max with no gap or overlap (resolveRoadmap §5 #3/#6).
function validateVolta(endings: unknown, where: string, secBars: number, errors: string[]): void {
  if (!Array.isArray(endings) || endings.length < 2) {
    errors.push(`${where}: volta repeat must list at least 2 endings`);
    return;
  }

  const seenPasses = new Set<number>();
  const ranges: Array<{ start: number; end: number }> = [];
  let shapeBad = false;

  endings.forEach((raw, i) => {
    const ew = `${where} ending ${i + 1}`;
    if (!raw || typeof raw !== 'object') {
      errors.push(`${ew} must be an object { bars, passes }`);
      shapeBad = true;
      return;
    }
    const e = raw as Record<string, unknown>;

    const bars = e.bars as Record<string, unknown> | undefined;
    if (!bars || typeof bars !== 'object' || !isInt(bars.start) || !isInt(bars.count)) {
      errors.push(`${ew}: bars must be { start, count } integers`);
      shapeBad = true;
    } else {
      const start = bars.start as number;
      const count = bars.count as number;
      if (start <= 1) errors.push(`${ew}: bars.start must be > 1 (after the section-anchored repeatStart)`);
      if (count < 1) errors.push(`${ew}: bars.count must be >= 1`);
      if (secBars > 0 && start >= 1 && count >= 1 && start + count - 1 > secBars) {
        errors.push(`${ew}: bars range runs past the section (${secBars} bars)`);
      }
      if (start > 1 && count >= 1) ranges.push({ start, end: start + count - 1 });
    }

    if (!Array.isArray(e.passes) || e.passes.length === 0 || !e.passes.every((n) => isInt(n) && (n as number) >= 1)) {
      errors.push(`${ew}: passes must be a non-empty array of pass numbers >= 1`);
      shapeBad = true;
    } else {
      for (const n of e.passes as number[]) {
        if (seenPasses.has(n)) errors.push(`${where}: pass ${n} appears in more than one ending`);
        seenPasses.add(n);
      }
    }
  });

  if (shapeBad) return;

  const max = Math.max(...seenPasses);
  for (let n = 1; n <= max; n++) {
    if (!seenPasses.has(n)) errors.push(`${where}: ending passes do not cover 1..${max} (missing ${n})`);
  }

  ranges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i += 1) {
    if (ranges[i].start <= ranges[i - 1].end) {
      errors.push(`${where}: volta ending bar ranges overlap`);
      break;
    }
  }
}

// Global navigation: every BarRef must resolve to a real (section, bar), and the
// jump/target preconditions mirror resolveRoadmap's walk exactly so a born-verified
// chart never carries a dangling marker: toCoda implies coda (standalone To Coda is
// rejected at lib/chart-calibration.ts:890, independent of any jump); a segno-jump
// needs a segno; an al-Coda jump needs both coda and toCoda; an al-Fine jump needs
// a fine.
function validateNavigation(nav: unknown, sectionBars: number[], errors: string[]): void {
  if (!nav || typeof nav !== 'object') {
    errors.push('navigation must be an object');
    return;
  }
  const n = nav as Record<string, unknown>;

  const checkRef = (ref: unknown, label: string): void => {
    if (!ref || typeof ref !== 'object') {
      errors.push(`navigation.${label} must be a { section, bar } reference`);
      return;
    }
    const r = ref as Record<string, unknown>;
    if (!isInt(r.section) || (r.section as number) < 0 || (r.section as number) >= sectionBars.length) {
      errors.push(`navigation.${label}.section must index an existing section`);
      return;
    }
    const bars = sectionBars[r.section as number];
    if (!isInt(r.bar) || (r.bar as number) < 1 || (bars > 0 && (r.bar as number) > bars)) {
      errors.push(`navigation.${label}.bar must be within 1..${bars || '?'} of its section`);
    }
  };

  if (n.segno !== undefined) checkRef(n.segno, 'segno');
  if (n.coda !== undefined) checkRef(n.coda, 'coda');
  if (n.toCoda !== undefined) checkRef(n.toCoda, 'toCoda');
  if (n.fine !== undefined) checkRef(n.fine, 'fine');

  // toCoda implies coda — independent of any jump (resolveRoadmap rejects a
  // standalone To Coda with no Coda).
  if (n.toCoda !== undefined && n.coda === undefined) {
    errors.push('navigation.toCoda requires navigation.coda');
  }

  if (n.jump !== undefined) {
    if (!n.jump || typeof n.jump !== 'object') {
      errors.push('navigation.jump must be an object { at, from, until }');
      return;
    }
    const j = n.jump as Record<string, unknown>;
    checkRef(j.at, 'jump.at');

    if (j.from !== 'capo' && j.from !== 'segno') {
      errors.push("navigation.jump.from must be 'capo' or 'segno'");
    } else if (j.from === 'segno' && n.segno === undefined) {
      errors.push('navigation.jump.from "segno" requires navigation.segno');
    }

    if (j.until !== 'end' && j.until !== 'fine' && j.until !== 'coda') {
      errors.push("navigation.jump.until must be 'end', 'fine', or 'coda'");
    } else if (j.until === 'fine' && n.fine === undefined) {
      errors.push('navigation.jump.until "fine" requires navigation.fine');
    } else if (j.until === 'coda' && (n.coda === undefined || n.toCoda === undefined)) {
      errors.push('navigation.jump.until "coda" requires navigation.coda and navigation.toCoda');
    }
  }
}
