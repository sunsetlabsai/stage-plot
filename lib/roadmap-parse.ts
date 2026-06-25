import Anthropic from '@anthropic-ai/sdk';
import { validateRoadmapSpec, TIME_SIG_UNITS, type RoadmapSpec } from './roadmap-spec';
import {
  foldDraft,
  tallyDraft,
  resolveRenderKey,
  parseDescription,
  type AuthoringDraft,
  type SectionDraft,
  type ChordSpan,
  type StructureOp,
} from './roadmap-authoring';

// ── Roadmap Builder — chunk 5a: the AI parse boundary (SpanList contract) ─────
// Natural-language song description → RoadmapSpec, in TWO deterministic stages so
// the model never has to transcribe AND compress at once (the bar-drop bug, §2 of
// docs/design-roadmap-authoring-fidelity.md):
//   L0 resolveRenderKey      — pin the printed key BEFORE the model runs.
//   L2 the model TRANSCRIBES — emits an AuthoringDraft (a per-span SpanList) where
//                              enumeration IS the output; no sparse-spec authoring,
//                              so the "that's a vamp" collapse reward is gone.
//   L3 foldDraft (PURE)      — WE compress: expand → splice → inheritance-diff →
//                              sparse RoadmapSpec; then validateRoadmapSpec (the
//                              unchanged DB-boundary gate) DISPOSES.
//   L4 tallyDraft            — a read-back echo from the SpanList so a dropped span
//                              is caught on sight before save.
// Split exactly like the converter: a PURE, fixture-tested gate (parseModelDraft)
// and a thin transport (parseRoadmapSpec) that only adds the Claude call. The
// route owns key sourcing + timeout; this stays "given a description + key, parse".

const MODEL = 'claude-opus-4-6';

// Abort the Anthropic call comfortably under the route's maxDuration so the route
// always returns a clean result rather than a platform 504 (mirrors chart-vision).
export const PARSE_TIMEOUT_MS = 50_000;

const SYSTEM_PROMPT = `You TRANSCRIBE a natural-language description of a song's structure into an AuthoringDraft JSON object. You do NOT compress, summarize, or "tidy" it — you list every bar the author described, in order. We do the compression deterministically afterward.

The user message begins with a line "Song key: <KEY>". Convert EVERY chord to its Nashville scale DEGREE (an integer 1..7) relative to that key. (In key D: D=1, E=2, G=4, A=5, Bm=6m. In a minor key the tonic chord is degree 1.) Never output letter names; "degree" is always 1..7.

Return ONLY the JSON object — no prose, no markdown fences. Do NOT include a "renderKey" field; we set it.

AuthoringDraft:
{
  "timeSig": { "beats": <int 1..32>, "unit": <1|2|4|8|16> },
  "sections": [
    {
      "id": "<unique slug, e.g. 'verse-1'; reuse-safe stable id, NEVER an index>",
      "label": "<human label, e.g. Intro/Verse/Chorus/Solo/Outro>",
      "spans": [ { "bar": [ <ChordHit>, ... ], "bars": <int >= 1> }, ... ],
      "ops": [ <StructureOp>, ... ]   // optional
    }
  ]
}

A SPAN is a run of CONTIGUOUS bars that all share ONE identical bar pattern. "bars" is how many bars long that run is. "2 bars of D, then 2 bars of G7" → two spans: { bar:[{degree:1}], bars:2 }, { bar:[{degree:4,quality:"7"}], bars:2 }.

ChordHit: { "degree": <int 1..7>, "alter"?: <-1 | 0 | 1 chromatic root shift>, "quality"?: <one of "","m","dim","aug","sus","sus2","sus4","7","maj7","m7","m7b5","dim7","6","m6">, "bass"?: <int 1..7 slash bass>, "beats"?: <int split-bar weight>, "held"?: <bool diamond/whole-note hold> }
- "bar" is ONE bar's content. One chord = whole bar → [{degree:..}]. Multiple chords in a bar = a split bar: list each ChordHit. Even division → omit "beats". Uneven split → give EVERY chord an explicit "beats" that sum to timeSig.beats.
- ACCEPT roman numerals and chord letters in the description and EMIT numeric degrees: IV→{degree:4}, V7→{degree:5,quality:"7"}, vi→{degree:6,quality:"m"} (a lowercase roman with no other quality is minor).
- A CHROMATIC root (a chord whose root is NOT in the key, e.g. C in key D, or written ♭VII/bVII) becomes the upper diatonic neighbor degree with "alter":-1: C in D → {degree:7,alter:-1} (♭VII); ♭III → {degree:3,alter:-1}. Honor an explicit ♯/♭ in a roman/number as written. NEVER round a chromatic root to the nearest diatonic degree without "alter". A chromatic SLASH BASS is not supported — re-voice or omit the bass.

ANTI-COLLAPSE RULES (this is the whole point — follow them exactly):
- List ONE span per contiguous region, IN ORDER. The enumeration IS the answer.
- Do NOT merge non-adjacent identical patterns. "D, G7, D, G7, D" is FIVE spans (D, G7, D, G7, D), never collapsed to "D and G7 a few times".
- Coalesce into one span's "bars" ONLY adjacent bars with the IDENTICAL pattern. Never across a differing bar.
- Do NOT introduce a section "repeat" op unless the author EXPLICITLY says "repeat" / "x2" / "played twice".
- Preserve the EXACT chord quality given (major unless told minor; do not diatonicize).
- If the description is vague, still emit your best literal reading as spans with bar counts. Never silently shorten a section.

StructureOp (optional, for things the author states in prose beyond plain spans). Bar references are 1-based bar positions WITHIN the section, against the authored-span bar array (before any splice):
- { "kind": "spliceBars", "at": <1-based bar>, "count": <int >= 0 bars to remove>, "insert": [ <ChordSpan>, ... ] }  // "drop the last bar of G, replace with Bm7 / Em / A as a tag"
- { "kind": "repeat", "repeat": <SectionRepeat> }  // at most one per section, only when stated
- { "kind": "nav", "marker": "segno"|"coda"|"toCoda"|"fine", "ref": { "sectionId": "<id>", "bar": <1-based bar> } }
- { "kind": "navJump", "at": { "sectionId": "<id>", "bar": <1-based bar> }, "from": "capo"|"segno", "until": "end"|"fine"|"coda" }  // D.C. = from "capo"; D.S. = from "segno"

SectionRepeat (used only inside a "repeat" op; EITHER plain OR volta, never both):
- Plain: { "kind": "plain", "times": <int >= 2> }. The section MUST be >= 2 bars.
- Volta: { "kind": "volta", "endings": [ { "bars": { "start": <int > 1>, "count": <int >= 1> }, "passes": [<int >= 1>, ...] }, ... ] }. At least 2 endings; bar ranges must not overlap; the union of "passes" must cover 1..max with no gap.

Always return a valid timeSig (default { "beats": 4, "unit": 4 } if unstated).`;

// Strip an accidental ```json … ``` fence the model may add despite instructions.
function stripFences(text: string): string {
  const t = text.trim();
  if (t.startsWith('```')) {
    return t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  }
  return t;
}

// The uniform shape the route returns: a folded+validated spec OR a list of
// errors, ALWAYS with the read-back tally when a draft was parseable, so the UI
// can echo what was understood even on a fold/validate failure.
export type ParseResult =
  | { ok: true; spec: RoadmapSpec; tally: string[] }
  | { ok: false; errors: string[]; tally?: string[] };

// Coerce the model's timeSig to a safe canonical one (the fold's beat math runs
// on it before validateRoadmapSpec re-checks). Anything malformed → 4/4.
function normalizeTimeSig(input: unknown): { beats: number; unit: number } {
  if (input && typeof input === 'object') {
    const t = input as Record<string, unknown>;
    const { beats, unit } = t;
    if (
      typeof beats === 'number' && Number.isInteger(beats) && beats >= 1 && beats <= 32 &&
      typeof unit === 'number' && TIME_SIG_UNITS.includes(unit)
    ) {
      return { beats, unit };
    }
  }
  return { beats: 4, unit: 4 };
}

// Shape-coerce sections to SectionDraft; the span/op CONTENTS are passed straight
// to foldDraft, which is the structural gate (bounds, identity, nav conflict).
function normalizeSections(input: unknown): SectionDraft[] {
  if (!Array.isArray(input)) return [];
  return input.map((raw, i) => {
    const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const id = typeof s.id === 'string' && s.id.trim() ? s.id : `section-${i + 1}`;
    const label = typeof s.label === 'string' && s.label.trim() ? s.label : id;
    const spans = Array.isArray(s.spans) ? (s.spans as ChordSpan[]) : [];
    const out: SectionDraft = { id, label, spans };
    if (Array.isArray(s.ops)) out.ops = s.ops as StructureOp[];
    return out;
  });
}

// tallyDraft walks raw model spans; guard so a malformed bar can't throw past the
// gate — a missing tally is fine, the errors still surface.
function safeTally(draft: AuthoringDraft): string[] {
  try {
    return tallyDraft(draft);
  } catch {
    return [];
  }
}

// L3 + L4 shared by both fronts (L1 grammar and L2 model): an AuthoringDraft →
// read-back tally → deterministic fold → the unchanged musical gate. The ONE place
// a draft becomes a validated spec, so the grammar path and the model path dispose
// identically. No IO — fixture-testable.
function foldAndValidateDraft(draft: AuthoringDraft): ParseResult {
  // L4 read-back, rendered FROM the SpanList so it reflects exactly what folds.
  const tally = safeTally(draft);

  // L3: we compress (deterministic), then the unchanged musical gate disposes.
  const folded = foldDraft(draft);
  if (!folded.ok) return { ok: false, errors: folded.errors, tally };

  const validated = validateRoadmapSpec(folded.spec);
  if (!validated.ok) return { ok: false, errors: validated.errors, tally };

  return { ok: true, spec: validated.spec, tally };
}

// PURE gate: raw model text + the L0-pinned renderKey → a folded, validated
// RoadmapSpec (or errors), plus the read-back tally. strip fences → JSON.parse →
// normalize → foldDraft (compress) → validateRoadmapSpec (the unchanged musical
// gate). Unparseable / non-JSON output fails closed with a clear error, so the
// caller has one uniform ParseResult to branch on. No IO — fixture-testable.
export function parseModelDraft(rawText: string, renderKey: string): ParseResult {
  const text = stripFences(rawText);
  if (!text) return { ok: false, errors: ['model returned empty output'] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['model did not return valid JSON'] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, errors: ['model did not return a draft object'] };
  }

  const obj = parsed as Record<string, unknown>;
  const draft: AuthoringDraft = {
    timeSig: normalizeTimeSig(obj.timeSig),
    renderKey, // L0 owns the key; the model's job was transcription, not key choice
    sections: normalizeSections(obj.sections),
  };

  return foldAndValidateDraft(draft);
}

// PURE L1 gate: a description + the L0-pinned renderKey → a folded, validated spec
// when the span-grammar transcribes the WHOLE description exactly, else null (the
// transport then falls to the L2 model). parseDescription is deterministic and
// only claims clean countable phrasing; on the rare draft that the grammar emits
// but the fold/validate rejects we ALSO return null, so an over-claim never blocks
// the model fallback. No IO — fixture-testable.
export function parseGrammarDraft(
  description: string,
  renderKey: string,
): Extract<ParseResult, { ok: true }> | null {
  const draft = parseDescription(description, renderKey);
  if (!draft) return null;
  const result = foldAndValidateDraft(draft);
  return result.ok ? result : null;
}

// Thin transport: pin the key (L0), send the description to Claude, gate the
// reply. Throws on transport/auth/timeout (the route maps that to a clean
// failure); otherwise returns the uniform ParseResult. Key sourcing stays the
// route's concern (shared platform key today, per-owner BYOA later). `uiKey` is
// the optional Compose-screen pre-parse key selector (L0 source 2).
export async function parseRoadmapSpec(
  description: string,
  apiKey: string,
  signal?: AbortSignal,
  uiKey?: string,
): Promise<ParseResult> {
  const renderKey = resolveRenderKey(description, uiKey);

  // L1: try the deterministic span-grammar first. A hit skips the model entirely —
  // the count is right by construction. A miss falls through to L2. Log the
  // hit/miss ratio as coverage telemetry (§7) to steer where the grammar widens.
  const grammar = parseGrammarDraft(description, renderKey);
  if (grammar) {
    console.info('[roadmap-parse] L1 grammar hit', { renderKey, sections: grammar.tally.length });
    return grammar;
  }
  console.info('[roadmap-parse] L1 grammar miss — falling to L2', { renderKey });

  const client = new Anthropic({ apiKey });

  const response = await client.messages.create(
    {
      model: MODEL,
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Song key: ${renderKey}\n\n${description}` }],
    },
    { signal },
  );

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  return parseModelDraft(text, renderKey);
}
