import { describe, it, expect } from 'vitest';
import { parseContentLength } from '../lib/http-headers';

// The regression guard for the numeric-prefix class: parseInt reads a PREFIX, so
// parseInt('1e9') is 1. Every case below is one an implementation using parseInt
// would get wrong, plus the cases it would get right (so the fix is not just
// "reject everything").

describe('parseContentLength — absent vs invalid are distinct', () => {
  // Conflating these IS the bug: "no header" must stay permissible, "junk header"
  // must not become a small byte count that slips under a size guard.
  it('treats a missing header as absent, not as zero bytes', () => {
    expect(parseContentLength(null)).toEqual({ kind: 'absent' });
    expect(parseContentLength(undefined)).toEqual({ kind: 'absent' });
    expect(parseContentLength('')).toEqual({ kind: 'absent' });
  });

  it('never reports absent for a value that is merely unparseable', () => {
    for (const raw of ['abc', '1e9', '-1']) {
      expect(parseContentLength(raw).kind).toBe('invalid');
    }
  });
});

describe('parseContentLength — the prefix traps', () => {
  // Each of these yields a plausible small number under parseInt. That is what
  // makes the defect invisible: no throw, no NaN, just a wrong answer.
  it.each([
    ['1e9', 1],
    ['12abc', 12],
    ['12.5', 12],
    ['100 000', 100],
    ['0x10', 0],
  ])('rejects %s, which parseInt would read as %i', (raw) => {
    expect(parseContentLength(raw)).toEqual({ kind: 'invalid' });
  });

  it('rejects negatives and whitespace-padded values', () => {
    expect(parseContentLength('-1').kind).toBe('invalid');
    expect(parseContentLength(' 12').kind).toBe('invalid');
    expect(parseContentLength('12 ').kind).toBe('invalid');
  });

  it('rejects a value too large to compare against a limit exactly', () => {
    expect(parseContentLength('9'.repeat(20)).kind).toBe('invalid');
  });
});

describe('parseContentLength — valid values still parse', () => {
  it('accepts a plain byte count', () => {
    expect(parseContentLength('100000')).toEqual({ kind: 'bytes', bytes: 100000 });
  });

  it('accepts zero — an empty body is a real body', () => {
    expect(parseContentLength('0')).toEqual({ kind: 'bytes', bytes: 0 });
  });

  it('accepts leading zeros', () => {
    expect(parseContentLength('007')).toEqual({ kind: 'bytes', bytes: 7 });
  });

  it('accepts the largest exactly-comparable integer', () => {
    expect(parseContentLength(String(Number.MAX_SAFE_INTEGER))).toEqual({
      kind: 'bytes',
      bytes: Number.MAX_SAFE_INTEGER,
    });
  });
});
