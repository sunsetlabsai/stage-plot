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
}

export interface RoadmapSection {
  id: string;
  label: string;                               // "Intro", "Verse", "Chorus", "Solo"
  bars: number;                                // count (the form math the validator checks)
  changes?: BarChange[];                       // optional NNS changes (sparse; one entry per addressed bar)
  repeat?: { times: number; endings?: number[][] }; // maps to RoadmapMarker repeat/ending on render
}

export interface BarChange {
  bar: number;                                 // 1-based within the section
  chords: ChordHit[];                          // 1 = whole bar; >1 = split bar (beats sum to timeSig.beats)
}

export interface ChordHit {
  degree: number;                              // 1..7 (Nashville scale degree)
  quality?: string;                            // '' = major triad; see QUALITY_WHITELIST
  bass?: number;                               // slash-chord bass degree 1..7
  beats?: number;                              // split-bar weight; omitted = even division of the bar
  held?: boolean;                              // diamond / whole-note hold
}

// ── v1 vocabulary (design §"NNS scope" / Open Q5) ────────────────────────────

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

  if (!isInt(s.version) || (s.version as number) < 1) {
    errors.push('version must be an integer >= 1');
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
      validateRepeat(sec.repeat, name, errors);
    }
  });

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

// A repeat: times >= 2, and (when present) endings partition the passes 1..times
// with no gap or overlap — the same balance rule the calibration resolver
// enforces on voltas (lib/chart-calibration resolveRoadmap §5 #3).
function validateRepeat(repeat: unknown, where: string, errors: string[]): void {
  if (!repeat || typeof repeat !== 'object') {
    errors.push(`${where}: repeat must be an object { times, endings? }`);
    return;
  }
  const r = repeat as Record<string, unknown>;

  let times = 0;
  if (!isInt(r.times) || (r.times as number) < 2) {
    errors.push(`${where}: repeat.times must be an integer >= 2`);
  } else {
    times = r.times as number;
  }

  if (r.endings === undefined) return;

  if (!Array.isArray(r.endings) || r.endings.length < 2) {
    errors.push(`${where}: repeat.endings must list at least 2 ending groups`);
    return;
  }

  const seen = new Set<number>();
  let shapeBad = false;
  r.endings.forEach((group, i) => {
    if (!Array.isArray(group) || group.length === 0 || !group.every((n) => isInt(n) && (n as number) >= 1)) {
      errors.push(`${where}: ending ${i + 1} must be a non-empty array of pass numbers >= 1`);
      shapeBad = true;
      return;
    }
    for (const n of group as number[]) {
      if (seen.has(n)) errors.push(`${where}: pass ${n} appears in more than one ending`);
      seen.add(n);
    }
  });
  if (shapeBad) return;

  const max = Math.max(...seen);
  for (let n = 1; n <= max; n++) {
    if (!seen.has(n)) errors.push(`${where}: ending passes do not cover 1..${max} (missing ${n})`);
  }
  if (times > 0 && max !== times) {
    errors.push(`${where}: ending passes top out at ${max} but repeat.times is ${times}`);
  }
}
