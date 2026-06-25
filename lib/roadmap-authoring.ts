// ── Roadmap Builder — chunk 5: authoring fidelity (the SpanList spine) ────────
// The AI parse used to drop bars because one LLM pass was asked to TRANSCRIBE and
// COMPRESS at once, and the sparse output format rewarded "that's a vamp". This
// module is the deterministic substrate that takes counting off the model: the
// model transcribes into an explicit, per-span intermediate (the AuthoringDraft /
// SpanList), and WE do the compression — expand → splice → inheritance-diff →
// sparse RoadmapSpec — in pure, fixture-tested code. The count is right by
// construction, not by the model's diligence.
//
// Everything here is PURE (no IO, no React, no LLM) and sits BEFORE the existing
// DB-boundary gate: foldDraft produces a RoadmapSpec that the caller still feeds
// to validateRoadmapSpec (lib/roadmap-spec), exactly mirroring the converter's
// "pure gate + thin transport" discipline. Authoring-structural errors (duplicate
// ids, out-of-bounds / overlapping splices, >1 repeat) fail HERE; musical
// validity (beats, quality, repeat preconditions, nav cross-field) stays the one
// source of truth at validateRoadmapSpec.

import {
  ROADMAP_SPEC_VERSION,
  isValidKey,
  type RoadmapSpec,
  type RoadmapSection,
  type BarChange,
  type ChordHit,
  type SectionRepeat,
  type RoadmapNavigation,
  type BarRef,
} from './roadmap-spec';
import {
  cellsToChordHits,
  chordHitsToCells,
  degreeLetter,
  parseBarInput,
  type ViewBarRef,
} from './roadmap-view';

// ── The SpanList intermediate ────────────────────────────────────────────────

// One bar's content: 1 chord = whole bar; N chords = a split bar, each carrying
// its beat weight — the shape parseBarInput / cellsToChordHits already produce.
export type BarPattern = ChordHit[];

// A run of contiguous bars sharing one IDENTICAL bar pattern. `bars` is the run
// length (>= 1); a sustained 2-bar D is { bar: [{degree:1}], bars: 2 }.
export interface ChordSpan {
  bar: BarPattern;
  bars: number;
}

export interface SectionDraft {
  id: string;                // STABLE unique slug (e.g. "verse-1"); nav refs key by this, never by index
  label: string;             // "Verse", "Chorus", "Intro"…
  spans: ChordSpan[];        // IN ORDER, one per contiguous region — NEVER pre-merged across a differing bar
  ops?: StructureOp[];       // repeat / tag-edit splice / nav (§5.1)
}

export type AuthoringDraft = {
  timeSig: { beats: number; unit: number };
  renderKey: string;         // pinned by L0 BEFORE any letter parse
  sections: SectionDraft[];
};

// Non-span structure the author states in prose. Bar references are 1-based bar
// positions within the section, against the section's PRE-OP (authored-span) bar
// array, so an op can't drift after another op resizes the section.
export type StructureOp =
  // Remove `count` bars at 1-based `at`, insert `insert` spans in their place.
  | { kind: 'spliceBars'; at: number; count: number; insert: ChordSpan[] }
  // Section repeat (plain | volta). At most one per section.
  | { kind: 'repeat'; repeat: SectionRepeat }
  // Global navigation marker; `ref.bar` is a PRE-OP bar identity, re-mapped through splices at fold time.
  | { kind: 'nav'; marker: 'segno' | 'coda' | 'toCoda' | 'fine'; ref: ViewBarRef }
  | { kind: 'navJump'; at: ViewBarRef; from: 'capo' | 'segno'; until: 'end' | 'fine' | 'coda' };

// ── Canonical BarPattern form + equality ─────────────────────────────────────

// Normalize a bar pattern to the SAME canonical beats convention the shipped
// ChordHit / validator already use (whole bar & even division omit `beats`;
// uneven splits carry explicit all-or-none beats). Reusing the shipped bridge
// keeps "identical pattern" and what folds into RoadmapSpec.changes byte-for-byte
// what validateRoadmapSpec accepts — no second source of truth for the beat math.
export function canonicalBarPattern(pattern: BarPattern, beats: number): ChordHit[] {
  return cellsToChordHits(chordHitsToCells(pattern, beats), beats);
}

// A stable string key for a canonical pattern. cellsToChordHits emits keys in a
// fixed insertion order (degree, alter, quality, bass, held, beats) and omits
// absent fields, so JSON.stringify is deterministic — equal patterns ⇒ equal key.
function patternKey(pattern: BarPattern, beats: number): string {
  return JSON.stringify(canonicalBarPattern(pattern, beats));
}

// ── Deterministic fold (SpanList → RoadmapSpec) ──────────────────────────────

export type FoldResult =
  | { ok: true; spec: RoadmapSpec }
  | { ok: false; errors: string[] };

// One expanded bar carrying its stable identity = its 1-based PRE-OP position
// (null for a bar inserted by a splice — inserted bars get fresh identities that
// never reuse a pre-op number, so nav refs to pre-op bars stay unambiguous).
interface IdBar { pattern: BarPattern; id: number | null }

// SpanList (+ ops) → RoadmapSpec, total and deterministic. Per section: expand
// spans → identity-bearing bar array; apply spliceBars on pre-op positions
// (resolved once, left-to-right, no drift); recompute bars; derive sparse changes
// by inheritance-diff; attach the single repeat; then lower nav refs through the
// identity map. The ONLY place compression happens. The returned spec is still
// gated by validateRoadmapSpec downstream.
export function foldDraft(draft: AuthoringDraft): FoldResult {
  const errors: string[] = [];
  const beats = draft.timeSig.beats;

  if (!Array.isArray(draft.sections) || draft.sections.length === 0) {
    return { ok: false, errors: ['draft must have at least one section'] };
  }

  // Duplicate section ids fail closed before any nav lowering (never a silent
  // collision — nav refs key by id).
  const seenIds = new Set<string>();
  for (const sec of draft.sections) {
    if (seenIds.has(sec.id)) errors.push(`duplicate section id "${sec.id}"`);
    seenIds.add(sec.id);
  }

  const sections: RoadmapSection[] = [];
  const identityMaps = new Map<string, Map<number, number>>(); // sectionId → (pre-op id → final 1-based bar)
  const sectionIndexById = new Map<string, number>();

  draft.sections.forEach((sec, sIdx) => {
    sectionIndexById.set(sec.id, sIdx);
    const where = sec.label || sec.id || `section ${sIdx + 1}`;

    // 1. Expand spans → explicit identity-bearing bar array (id = pre-op position).
    const expanded: IdBar[] = [];
    sec.spans.forEach((span, spi) => {
      if (!Number.isInteger(span.bars) || span.bars < 1) {
        errors.push(`${where} span ${spi + 1}: bars must be an integer >= 1`);
        return;
      }
      if (!Array.isArray(span.bar) || span.bar.length === 0) {
        errors.push(`${where} span ${spi + 1}: bar pattern must be a non-empty array`);
        return;
      }
      for (let k = 0; k < span.bars; k += 1) expanded.push({ pattern: span.bar, id: expanded.length + 1 });
    });
    const N = expanded.length;

    const ops = sec.ops ?? [];
    const splices = ops.filter((o): o is Extract<StructureOp, { kind: 'spliceBars' }> => o.kind === 'spliceBars');
    const repeats = ops.filter((o): o is Extract<StructureOp, { kind: 'repeat' }> => o.kind === 'repeat');

    if (repeats.length > 1) errors.push(`${where}: a section may carry at most one repeat op`);

    // Validate splice bounds (against the PRE-OP bar count).
    for (const op of splices) {
      if (!Number.isInteger(op.at) || op.at < 1) errors.push(`${where}: spliceBars.at must be an integer >= 1`);
      if (!Number.isInteger(op.count) || op.count < 0) errors.push(`${where}: spliceBars.count must be an integer >= 0`);
      if (Number.isInteger(op.at) && Number.isInteger(op.count) && op.at + op.count - 1 > N) {
        errors.push(`${where}: spliceBars range runs past the section (${N} bars)`);
      }
    }
    // Splices apply left-to-right by `at` on the original positions; a clean
    // monotonic gap (next.at >= prev.at + prev.count) guarantees no overlap.
    const sorted = [...splices].sort((a, b) => a.at - b.at);
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i].at < sorted[i - 1].at + sorted[i - 1].count) {
        errors.push(`${where}: overlapping splice ranges`);
        break;
      }
    }

    // 2. Apply splices on pre-op positions. Inserts land AT `at` (before the
    //    deleted originals); deleted pre-op positions are skipped.
    const deleted = new Set<number>();
    for (const op of sorted) for (let p = op.at; p <= op.at + op.count - 1; p += 1) deleted.add(p);

    const finalBars: IdBar[] = [];
    for (let pos = 1; pos <= N + 1; pos += 1) {
      for (const op of sorted) {
        if (op.at !== pos) continue;
        for (const span of op.insert ?? []) {
          if (!Number.isInteger(span.bars) || span.bars < 1) {
            errors.push(`${where}: inserted span bars must be an integer >= 1`);
            continue;
          }
          if (!Array.isArray(span.bar) || span.bar.length === 0) {
            errors.push(`${where}: inserted span pattern must be a non-empty array`);
            continue;
          }
          for (let k = 0; k < span.bars; k += 1) finalBars.push({ pattern: span.bar, id: null });
        }
      }
      if (pos <= N && !deleted.has(pos)) finalBars.push(expanded[pos - 1]);
    }

    // 3. Recompute bar count.
    const M = finalBars.length;
    if (M < 1) errors.push(`${where}: section has no bars after splices`);

    // Identity map for nav lowering (pre-op id → final 1-based index).
    const idMap = new Map<number, number>();
    finalBars.forEach((b, i) => { if (b.id !== null) idMap.set(b.id, i + 1); });
    identityMaps.set(sec.id, idMap);

    // 4. Sparse changes by inheritance-diff: emit a change only where the bar's
    //    canonical pattern differs from the previous bar (the sustain-until-next
    //    model the renderer draws).
    const changes: BarChange[] = [];
    let prevKey: string | null = null;
    finalBars.forEach((b, i) => {
      const k = patternKey(b.pattern, beats);
      if (prevKey === null || k !== prevKey) {
        changes.push({ bar: i + 1, chords: canonicalBarPattern(b.pattern, beats) });
      }
      prevKey = k;
    });

    const out: RoadmapSection = { id: sec.id, label: sec.label, bars: M };
    if (changes.length > 0) out.changes = changes;
    // 5. Attach the single repeat op (musical preconditions checked at L3).
    if (repeats.length === 1) out.repeat = repeats[0].repeat;
    sections.push(out);
  });

  // Duplicate GLOBAL navigation directives are an authoring conflict, not a
  // musical one: two segno ops (or two navJump ops) would silently collapse to
  // the last during lowering, and validateRoadmapSpec only ever sees the
  // already-lowered single-field RoadmapNavigation — so it cannot catch the loss.
  // Fail here, like >1 repeat. Counted from the DECLARED ops (regardless of
  // whether a ref later resolves), so the conflict is reported even if one drops.
  const navMarkerCounts = new Map<string, number>();
  let jumpCount = 0;
  for (const sec of draft.sections) {
    for (const op of sec.ops ?? []) {
      if (op.kind === 'nav') navMarkerCounts.set(op.marker, (navMarkerCounts.get(op.marker) ?? 0) + 1);
      else if (op.kind === 'navJump') jumpCount += 1;
    }
  }
  for (const [marker, count] of navMarkerCounts) {
    if (count > 1) errors.push(`conflicting navigation: ${count} "${marker}" ops (each marker may be declared once)`);
  }
  if (jumpCount > 1) errors.push(`conflicting navigation: ${jumpCount} navJump ops (only one jump may be declared)`);

  if (errors.length > 0) return { ok: false, errors };

  // 6. Lower nav refs (global) through the identity maps. A ref to an unknown
  //    section or a spliced-away bar drops THAT nav block (the §5.1 fail-safe);
  //    cross-field preconditions (toCoda⇒coda, etc.) stay at validateRoadmapSpec.
  const lowerRef = (ref: ViewBarRef): BarRef | null => {
    const sIdx = sectionIndexById.get(ref.sectionId);
    if (sIdx === undefined) return null;
    const finalBar = identityMaps.get(ref.sectionId)?.get(ref.bar);
    if (finalBar === undefined) return null;
    return { section: sIdx, bar: finalBar };
  };

  const navigation: RoadmapNavigation = {};
  for (const sec of draft.sections) {
    for (const op of sec.ops ?? []) {
      if (op.kind === 'nav') {
        const r = lowerRef(op.ref);
        if (r) navigation[op.marker] = r;
      } else if (op.kind === 'navJump') {
        const at = lowerRef(op.at);
        if (at) navigation.jump = { at, from: op.from, until: op.until };
      }
    }
  }

  const spec: RoadmapSpec = {
    version: ROADMAP_SPEC_VERSION,
    timeSig: draft.timeSig,
    renderKey: draft.renderKey,
    sections,
  };
  if (Object.keys(navigation).length > 0) spec.navigation = navigation;

  return { ok: true, spec };
}

// ── L0 — renderKey resolution (pinned before any letter parse, §4.1) ─────────

// Tiny key grammar: a leading/inline statement of the printed key. The note
// letter stays strict A–G (case-sensitive); the surrounding keywords are matched
// in their natural casing. "in D" / "key of Bb" / "G minor" / "in Dm".
const NOTE = '([A-G](?:#|b)?)';
const RE_KEYED = new RegExp(`(?:[Kk]ey of|\\b[Ii]n)\\s+${NOTE}(m)?(?:\\s+(minor|min|major|maj))?\\b`);
const RE_BARE = new RegExp(`\\b${NOTE}\\s+(minor|major)\\b`);

function explicitKey(text: string): string | null {
  let note: string | undefined;
  let minor = false;

  const m = text.match(RE_KEYED);
  if (m) {
    note = m[1];
    if (m[2]) minor = true;                                  // trailing m, e.g. "in Dm"
    else if (m[3] && /^min/i.test(m[3])) minor = true;       // "in D minor"
  } else {
    const b = text.match(RE_BARE);
    if (!b) return null;
    note = b[1];
    minor = /^min/i.test(b[2]);
  }

  const key = note + (minor ? 'm' : '');
  return isValidKey(key) ? key : null;
}

// Resolve renderKey by the fixed L0 precedence (§4.1): (1) an explicit key stated
// in the description wins; (2) the UI-selected key (Compose pre-parse selector);
// (3) default "C" — the same fallback the parse prompt / validator use today.
// L1's letter→degree parse MUST run against this pinned key, never an unpinned one.
export function resolveRenderKey(description: string, uiKey?: string): string {
  const stated = explicitKey(description);
  if (stated) return stated;
  if (uiKey && isValidKey(uiKey)) return uiKey;
  return 'C';
}

// ── L4 — read-back tally (post-parse, pre-accept) ────────────────────────────

// Render one bar pattern as letters in the draft's key, for the human-readable
// tally ("D", "G7", "Bm7", "5/4"). Letters echo what the author wrote so a drop
// is obvious on sight.
function barPatternText(pattern: BarPattern, key: string): string {
  return pattern
    .map((c) => {
      const head = degreeLetter(c.degree, key, c.alter ?? 0) + (c.quality ?? '');
      return c.bass != null ? `${head}/${degreeLetter(c.bass, key)}` : head;
    })
    .join(' ');
}

// Per-section plain-English echo rendered FROM the SpanList (pre-op spans), so a
// dropped span shows up as a short total before the draft is ever folded/saved:
// "Verse: 16 bars — D×2, G7×2, D×2, …".
export function tallyDraft(draft: AuthoringDraft): string[] {
  return draft.sections.map((sec) => {
    const total = sec.spans.reduce((sum, s) => sum + (Number.isInteger(s.bars) ? s.bars : 0), 0);
    const parts = sec.spans.map((s) => {
      const txt = barPatternText(s.bar, draft.renderKey);
      return s.bars > 1 ? `${txt}×${s.bars}` : txt;
    });
    return `${sec.label}: ${total} bars — ${parts.join(', ')}`;
  });
}

// ── L1 — the deterministic span-grammar parser (§7) ──────────────────────────
//
// The fast, faithful, ZERO-LLM front-end for the countable phrasing authors
// naturally write ("2 bars D, 2 bars G7, …"). It converts ONLY what it can convert
// exactly and defers everything else to L2 by returning null for the WHOLE
// description — it never emits a partial or a guess. This is an optimization on
// top of the (already faithful) L2 path, not the fidelity fix: when the grammar
// hits, the count is right by construction and no model call is needed; when it
// misses, L2 covers it (the transport logs the hit/miss ratio as coverage
// telemetry). The chord token itself routes through the SAME parseBarInput /
// parseLetterChord seam the manual editor uses, so a letter that isn't diatonic in
// the L0-pinned key (e.g. a chromatic root) fails the whole parse to L2 / Gap-1
// rather than being rounded.

// Strip a leading/inline key statement (the L0 grammar already consumed it for the
// renderKey) so it can't masquerade as span prose. Removes the FIRST match only —
// conservative, mirrors resolveRenderKey's single-key resolution.
function stripKeyPhrase(text: string): string {
  const km = text.match(RE_KEYED);
  if (km && km.index !== undefined) {
    return `${text.slice(0, km.index)} ${text.slice(km.index + km[0].length)}`;
  }
  const bm = text.match(RE_BARE);
  if (bm && bm.index !== undefined) {
    return `${text.slice(0, bm.index)} ${text.slice(bm.index + bm[0].length)}`;
  }
  return text;
}

// A deterministic, collision-free slug from a section label (the same stable-id
// discipline the fold's nav lowering relies on). Duplicate labels are deduped by
// the caller; this only normalizes one label.
function slugify(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  );
}

// Split a description into labelled sections. A header is a short label followed
// by a colon, anchored at the start or after a clause boundary (".,;\n"), so a
// colon is the unambiguous section delimiter. No headers ⇒ one default section
// (the whole text). If headers exist, any non-blank text BEFORE the first one
// fails the parse (we won't silently drop authored content). Returns null when the
// text is empty.
function splitSections(text: string): Array<{ label: string; body: string }> | null {
  const t = text.trim();
  if (!t) return null;

  const headerRe = /(?:^|[.,;\n])[ \t]*([A-Za-z][A-Za-z0-9 '&/-]{0,24}?)[ \t]*:/g;
  const heads: Array<{ label: string; bodyStart: number; matchStart: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(t)) !== null) {
    // matchStart = the boundary char (or 0 for ^); bodyStart = just after the colon.
    heads.push({ label: m[1].trim(), matchStart: m.index, bodyStart: m.index + m[0].length });
  }

  if (heads.length === 0) return [{ label: 'Section', body: t }];

  // Content before the first header must be blank — never silently dropped.
  if (t.slice(0, heads[0].matchStart).trim() !== '') return null;

  return heads.map((h, i) => ({
    label: h.label,
    body: t.slice(h.bodyStart, i + 1 < heads.length ? heads[i + 1].matchStart : t.length),
  }));
}

// Split a section body into span clauses on commas, semicolons, periods, newlines,
// or the word "then" — the separators an author uses between spans.
function splitClauses(body: string): string[] {
  return body
    .split(/\s*(?:[,;.\n]|\bthen\b)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Parse ONE span clause to a ChordSpan, or null if it isn't clean countable
// phrasing. Forms: "N bar(s) [of] CHORD", "CHORD for N bar(s)", or a bare CHORD
// (= 1 bar). CHORD is whatever parseBarInput accepts in the pinned key — a single
// chord OR a split-bar pattern ("1 - 4 5") — so the grammar inherits the manual
// editor's exact chord rules and its honest failure (chromatic root → defer).
function parseSpanClause(clause: string, renderKey: string, beats: number): ChordSpan | null {
  const c = clause.trim();
  if (!c) return null;

  let bars = 1;
  let barText = c;
  const leading = c.match(/^(\d+)\s+bars?\s+(?:of\s+)?(.+)$/i);
  if (leading) {
    bars = Number(leading[1]);
    barText = leading[2].trim();
  } else {
    const trailing = c.match(/^(.+?)\s+for\s+(\d+)\s+bars?$/i);
    if (trailing) {
      barText = trailing[1].trim();
      bars = Number(trailing[2]);
    }
  }
  if (!Number.isInteger(bars) || bars < 1) return null;

  const parsed = parseBarInput(barText, beats, renderKey);
  if (!parsed.ok || parsed.cells.length === 0) return null;
  return { bar: cellsToChordHits(parsed.cells, beats), bars };
}

// L1 entry point: a natural-language description + the L0-pinned renderKey → an
// AuthoringDraft, or null when the grammar can't transcribe the WHOLE description
// exactly (the caller then falls to L2). Pure, deterministic, fixture-tested. The
// returned draft is still folded + validated downstream like any other — L1 only
// removes the model from the loop for the countable part.
export function parseDescription(
  description: string,
  renderKey: string,
  timeSig: { beats: number; unit: number } = { beats: 4, unit: 4 },
): AuthoringDraft | null {
  const secs = splitSections(stripKeyPhrase(description));
  if (!secs) return null;

  const beats = timeSig.beats;
  const used = new Map<string, number>();
  const sections: SectionDraft[] = [];

  for (const { label, body } of secs) {
    const clauses = splitClauses(body);
    if (clauses.length === 0) return null; // a labelled section with no spans = miss

    const spans: ChordSpan[] = [];
    for (const clause of clauses) {
      const span = parseSpanClause(clause, renderKey, beats);
      if (!span) return null; // any unparseable clause defers the whole description
      spans.push(span);
    }

    let id = slugify(label);
    const seen = used.get(id);
    if (seen) {
      const n = seen + 1;
      used.set(id, n);
      id = `${id}-${n}`;
    } else {
      used.set(id, 1);
    }
    sections.push({ id, label, spans });
  }

  return sections.length > 0 ? { timeSig, renderKey, sections } : null;
}
