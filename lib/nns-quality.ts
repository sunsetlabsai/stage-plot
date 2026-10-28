// ── Nashville Number System display (backlog #204, ruled 2026-10-27) ─────────
//
// DISPLAY ONLY. Storage and input stay plain text (`'7'`, `'maj7'`, `'m'`…); this turns a
// stored quality into the NNS way of writing it: the extension raised and smaller (5⁷),
// △ for major 7, a dash for minor (2–), ° for diminished, ø for half-diminished.
// A dominant 7 used to print as "57" — degree and quality at one size — which reads as
// fifty-seven.
//
// ONE segment list feeds both the saved PDF and the builder preview, so they cannot
// disagree. Every glyph here is WinAnsi-encodable (pdf-lib's standard Helvetica) except
// the triangle, which is a `triangle` segment the PDF draws as a vector shape, like ♭/♯.

export type NnsSegment =
  | { kind: 'text'; text: string; size: 'main' | 'sup' }
  | { kind: 'triangle' };

interface Glyph {
  minor: boolean;
  symbol: '' | '°' | 'ø' | '+' | 'triangle';
  sup: string;
}

// Exhaustive over QUALITY_WHITELIST (a test pins it). Anything unknown falls back to a
// raised raw quality — never full-size beside the degree.
const GLYPHS: Record<string, Glyph> = {
  '': { minor: false, symbol: '', sup: '' },
  m: { minor: true, symbol: '', sup: '' },
  dim: { minor: false, symbol: '°', sup: '' },
  aug: { minor: false, symbol: '+', sup: '' },
  sus: { minor: false, symbol: '', sup: 'sus' },
  sus2: { minor: false, symbol: '', sup: 'sus2' },
  sus4: { minor: false, symbol: '', sup: 'sus4' },
  '7': { minor: false, symbol: '', sup: '7' },
  '7sus2': { minor: false, symbol: '', sup: '7sus2' },
  '7sus4': { minor: false, symbol: '', sup: '7sus4' },
  maj7: { minor: false, symbol: 'triangle', sup: '7' },
  m7: { minor: true, symbol: '', sup: '7' },
  m7b5: { minor: false, symbol: 'ø', sup: '7' },
  dim7: { minor: false, symbol: '°', sup: '7' },
  '6': { minor: false, symbol: '', sup: '6' },
  m6: { minor: true, symbol: '', sup: '6' },
};

/** The NNS segments for one chord: degree, then quality, then any slash bass. The
 *  root accidental (♭/♯) is NOT included — callers already draw it as a prefix. */
export function nnsSegments(c: { degree: number; quality: string; bass?: number | null }): NnsSegment[] {
  const g = GLYPHS[c.quality] ?? { minor: false, symbol: '', sup: c.quality };
  const out: NnsSegment[] = [{ kind: 'text', text: String(c.degree), size: 'main' }];
  if (g.minor) out.push({ kind: 'text', text: '–', size: 'main' });
  if (g.symbol === 'triangle') out.push({ kind: 'triangle' });
  else if (g.symbol) out.push({ kind: 'text', text: g.symbol, size: 'main' });
  if (g.sup) out.push({ kind: 'text', text: g.sup, size: 'sup' });
  if (c.bass != null) out.push({ kind: 'text', text: `/${c.bass}`, size: 'main' });
  return out;
}

/**
 * Accept the NNS symbols as typed or pasted input, mapped onto the canonical plain-text
 * qualities: △/Δ → maj7, ° → dim, ø → m7b5, a leading dash (- – −) → minor, + → aug.
 * Plain-text qualities pass through unchanged. A STANDALONE "-" is the bar grammar's tie
 * and never reaches here — only a dash attached to a degree or letter does.
 */
export function normalizeQualityInput(raw: string): string {
  const head = raw[0];
  const rest = raw.slice(1);
  if (head === '△' || head === 'Δ') return rest === '' || rest === '7' ? 'maj7' : `maj${rest}`;
  if (head === 'ø') return rest === '' || rest === '7' ? 'm7b5' : raw;
  if (head === '°') return `dim${rest}`;
  if (head === '-' || head === '–' || head === '−') return `m${rest}`;
  if (raw === '+') return 'aug';
  return raw;
}
