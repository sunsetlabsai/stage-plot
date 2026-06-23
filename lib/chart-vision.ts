import Anthropic from '@anthropic-ai/sdk';
import type { VisionChart } from './chart-converter';

// Abort the Anthropic call comfortably under the route's maxDuration so the
// route always returns a clean degrade rather than a platform 504.
export const VISION_TIMEOUT_MS = 50_000;

const MODEL = 'claude-opus-4-6';

const SYSTEM_PROMPT = `You are a music-chart structure extractor. You are given a chart/lead-sheet/score PDF.
Return ONLY a JSON object (no prose, no markdown fences) describing its visual structure.
All coordinates are normalized 0..1 within their page: x is left→right, y is top→bottom.
Schema:
{
  "systems": [ { "page": <1-based int>, "yTop": <0..1>, "yBottom": <0..1>, "xStart": <0..1>, "xEnd": <0..1>, "confidence": <0..1> } ],
  "bars": [ { "systemIndex": <index into systems[]>, "xStart": <0..1>, "xEnd": <0..1>, "confidence": <0..1> } ],
  "sections": [ { "page": <1-based int>, "x": <0..1>, "y": <0..1>, "label": "<e.g. Intro/Verse/Chorus>", "confidence": <0..1> } ],
  "roadmap": [ { "kind": "repeatStart|repeatEnd|ending|segno|coda|toCoda|fine|jump",
                 "barIndex": <index into bars[]>, "barIndices": [<indices>], "repeatStartBarIndex": <index into bars[]>,
                 "times": <int>=1>, "numbers": [<int>=1>], "from": "capo|segno", "until": "end|fine|coda", "confidence": <0..1> } ]
}
Rules:
- A "system" is one horizontal staff/chord line; systems span the full width unless clearly indented (default xStart=0, xEnd=1).
- A "bar" is a barline-delimited measure; reference its parent by systemIndex.
- roadmap markers are printed navigation symbols: |: (repeatStart), :| (repeatEnd, with repeatStartBarIndex = the matching |: bar),
  1st/2nd endings/voltas (ending, with barIndices = bracket bars and numbers = e.g. [1] or [2,3]), Segno, Coda, "To Coda" (toCoda),
  Fine, and D.C./D.S. (jump: from "capo"/"segno", until "end"/"fine"/"coda"). Omit any you don't clearly see.
- confidence is YOUR certainty (0..1) per element. Coarse coordinates are fine.
Return {} if you cannot read any structure.`;

function stripFences(text: string): string {
  const t = text.trim();
  if (t.startsWith('```')) {
    return t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  }
  return t;
}

// Send the PDF to Claude as a document block and parse the structured JSON.
// Throws on transport/auth/timeout (the route maps that to a graceful degrade);
// returns null only when the model returns unparseable / non-object output.
export async function extractChartVision(
  pdfBytes: Uint8Array,
  apiKey: string,
  signal?: AbortSignal,
): Promise<VisionChart | null> {
  // Key is resolved + passed by the caller (the convert route) so key SOURCING
  // — the shared platform key today, per-owner BYOA later — stays the route's
  // concern and this stays a pure "given a key + bytes, call Claude".
  const client = new Anthropic({ apiKey });
  const base64 = Buffer.from(pdfBytes).toString('base64');

  const response = await client.messages.create(
    {
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: 'low' },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: base64 },
            },
            { type: 'text', text: 'Extract this chart\u2019s structure as JSON per the schema.' },
          ],
        },
      ],
    },
    { signal },
  );

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (!text.trim()) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(text));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  return parsed as VisionChart;
}
