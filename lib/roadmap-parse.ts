import Anthropic from '@anthropic-ai/sdk';
import { validateRoadmapSpec, type SpecValidation } from './roadmap-spec';

// ── Roadmap Builder — chunk 2: the AI parse boundary ─────────────────────────
// Natural-language song description → RoadmapSpec. The model PROPOSES a spec;
// validateRoadmapSpec (chunk 0, the DB-boundary gate) DISPOSES — so a malformed
// or hallucinated payload can never escape this seam into the renderer/save path.
// Split exactly like the converter: a PURE, fixture-tested gate (parseModelSpec)
// and a thin transport (parseRoadmapSpec) that only adds the Claude call. The
// route owns key sourcing + timeout; this stays "given a description + key, parse".

const MODEL = 'claude-opus-4-6';

// Abort the Anthropic call comfortably under the route's maxDuration so the route
// always returns a clean result rather than a platform 504 (mirrors chart-vision).
export const PARSE_TIMEOUT_MS = 50_000;

const SYSTEM_PROMPT = `You translate a natural-language description of a song's structure into a RoadmapSpec JSON object.
Return ONLY the JSON object — no prose, no markdown fences.

A RoadmapSpec describes a song's FORM in Nashville Number System terms (chords are scale DEGREES 1..7, key-agnostic):
{
  "version": 1,
  "timeSig": { "beats": <int 1..32>, "unit": <1|2|4|8|16> },
  "renderKey": "<printed key: A-G, optional # or b, optional trailing m for minor, e.g. G, Bb, F#, Am>",
  "barsPerLine": <optional int 1..16 layout hint>,
  "sections": [
    {
      "id": "<unique slug, e.g. 'verse-1'>",
      "label": "<human label, e.g. Intro/Verse/Chorus/Solo/Outro>",
      "bars": <int >= 1>,
      "changes": [ { "bar": <1-based int within the section>, "chords": [ <ChordHit>, ... ] } ],
      "repeat": <SectionRepeat>
    }
  ],
  "navigation": <RoadmapNavigation>
}

ChordHit: { "degree": <int 1..7>, "quality"?: <one of "","m","dim","aug","sus","sus2","sus4","7","maj7","m7","m7b5","dim7","6","m6">, "bass"?: <int 1..7 slash bass>, "beats"?: <int split-bar weight>, "held"?: <bool diamond/whole-note hold> }
- One chord in a bar = whole bar. Multiple chords with no "beats" = even division (chord count must divide timeSig.beats evenly).
- If chords split a bar unevenly, give EVERY chord an explicit "beats"; the beats MUST sum to timeSig.beats.
- "changes" is SPARSE: include only the bars that have chords; omit "changes" entirely for sections you don't know.

SectionRepeat (a section repeat is EITHER plain OR volta, never both):
- Plain: { "kind": "plain", "times": <int >= 2> }. The section MUST have bars >= 2.
- Volta (1st/2nd... endings): { "kind": "volta", "endings": [ { "bars": { "start": <int > 1>, "count": <int >= 1> }, "passes": [<int >= 1>, ...] }, ... ] }
  - At least 2 endings. Each "bars" is a contiguous slice within the section (start > 1, not running past the section).
  - Ending bar ranges must NOT overlap. The union of all "passes" must cover 1..max with no gap (e.g. ending A passes [1], ending B passes [2]).

RoadmapNavigation (all optional; a BarRef is { "section": <0-based index into sections>, "bar": <1-based bar in that section> }):
{ "segno"?: <BarRef>, "coda"?: <BarRef>, "toCoda"?: <BarRef>, "fine"?: <BarRef>,
  "jump"?: { "at": <BarRef>, "from": "capo"|"segno", "until": "end"|"fine"|"coda" } }
- D.C. = from "capo"; D.S. = from "segno" (requires "segno").
- "To Coda" (toCoda) REQUIRES "coda". An al-Coda jump (until "coda") requires BOTH "coda" and "toCoda". An al-Fine jump (until "fine") requires "fine".

If the description is too vague to place chords, still return a valid skeleton: sensible sections with bar counts and no "changes".
Always return version 1 and a valid timeSig and renderKey (default to { "beats": 4, "unit": 4 } and "C" if unstated).`;

// Strip an accidental ```json … ``` fence the model may add despite instructions.
function stripFences(text: string): string {
  const t = text.trim();
  if (t.startsWith('```')) {
    return t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  }
  return t;
}

// PURE gate: raw model text → a validated RoadmapSpec (or the validator's errors).
// strip fences → JSON.parse → validateRoadmapSpec. Unparseable / non-JSON output
// fails closed with a clear error, exactly as a structurally-invalid spec does, so
// the caller has one uniform SpecValidation to branch on. No IO — fixture-testable.
export function parseModelSpec(rawText: string): SpecValidation {
  const text = stripFences(rawText);
  if (!text) return { ok: false, errors: ['model returned empty output'] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['model did not return valid JSON'] };
  }
  return validateRoadmapSpec(parsed);
}

// Thin transport: send the description to Claude and gate the reply. Throws on
// transport/auth/timeout (the route maps that to a clean failure); otherwise
// returns the uniform SpecValidation from parseModelSpec. Key sourcing stays the
// route's concern (shared platform key today, per-owner BYOA later).
export async function parseRoadmapSpec(
  description: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<SpecValidation> {
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create(
    {
      model: MODEL,
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: description }],
    },
    { signal },
  );

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  return parseModelSpec(text);
}
