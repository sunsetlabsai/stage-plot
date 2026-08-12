// Header parsing that cannot silently invent a number.
//
// Both `Content-Length` readers in this repo used `parseInt(raw, 10)`, which reads
// a numeric PREFIX and discards the rest: parseInt('1e9') is 1, parseInt('12abc')
// is 12. That is the same defect Codex found twice in the setlist-import work (the
// `#` column and the sheet `gid`), and the same reason it was hard to see — a
// malformed value doesn't throw or return NaN, it returns a plausible small number.
//
// It is not a live vulnerability: Node's HTTP parser rejects a malformed
// Content-Length before a route ever sees it. The point is to remove the pattern,
// so the next reader of these lines doesn't copy it somewhere it DOES matter.

export type ContentLength =
  /** No `Content-Length` header. Legitimate — e.g. a chunked body. */
  | { kind: 'absent' }
  /** Present but not a whole number of bytes. A malformed request, not a size. */
  | { kind: 'invalid' }
  | { kind: 'bytes'; bytes: number };

/**
 * Parse a `Content-Length` header value.
 *
 * `absent` and `invalid` are deliberately DISTINCT: conflating them is the bug
 * this replaces, because "no header" must stay permissible while "junk header"
 * must not quietly become a small byte count that slips under a size guard.
 *
 * Requires the WHOLE value to be digits, so `1e9`, `12abc`, `12.5`, `-1` and
 * `' 12'` are all invalid. Leading zeros are fine (`007` is 7).
 */
export function parseContentLength(raw: string | null | undefined): ContentLength {
  if (raw === null || raw === undefined || raw === '') return { kind: 'absent' };
  if (!/^\d+$/.test(raw)) return { kind: 'invalid' };
  const bytes = Number(raw);
  // Beyond 2^53 the value is no longer an exact integer, so it cannot be compared
  // against a limit meaningfully. Nothing legitimate sends it.
  if (!Number.isSafeInteger(bytes)) return { kind: 'invalid' };
  return { kind: 'bytes', bytes };
}
