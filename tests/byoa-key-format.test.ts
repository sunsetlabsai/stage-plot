import { describe, it, expect } from 'vitest';
import {
  normalizeKey,
  keyFormatMessage,
  MIN_KEY_LENGTH,
  ANTHROPIC_KEY_PREFIX,
} from '@/lib/byoa-key-format';

// design-single-backend.md §4.5/§4.6, chunk 3.
//
// ★ THIS EXISTS BECAUSE OF A MEASURED INCIDENT, NOT A HYPOTHETICAL. A local 401
// was once chased as a bad Anthropic key and turned out to be a CARRIAGE RETURN
// in a pasted value. Nothing about that failure points at whitespace: the
// vendor returns "invalid x-api-key" whether the key is wrong or merely has a
// \r glued to it. So the whitespace cases below are the point of this file, not
// filler around the prefix check.

const VALID = 'sk-ant-api03-abcdefghijklmnop';

describe('normalizeKey — whitespace, the failure that does not announce itself', () => {
  it.each([
    ['trailing newline', `${VALID}\n`],
    ['trailing carriage return', `${VALID}\r`],
    ['CRLF', `${VALID}\r\n`],
    ['leading space', `  ${VALID}`],
    ['trailing tab', `${VALID}\t`],
    ['wrapped in whitespace', ` \n${VALID}\r\n `],
  ])('strips %s rather than rejecting it', (_label, raw) => {
    const r = normalizeKey(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.key).toBe(VALID);
  });

  // ★ The counterexample that makes the rule above meaningful. Trimming is
  // generous at the EDGES only. Deleting characters from the MIDDLE of someone's
  // credential would silently corrupt it, and they would then debug an auth
  // failure caused by us rather than by their paste.
  it.each([
    ['a space in the middle', 'sk-ant-api03-abcd efghijklmnop'],
    ['a newline in the middle', 'sk-ant-api03-abcd\nefghijklmnop'],
    ['a tab in the middle', 'sk-ant-api03-abcd\tefghijklmnop'],
  ])('rejects %s instead of silently deleting it', (_label, raw) => {
    const r = normalizeKey(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('whitespace');
  });
});

describe('normalizeKey — shape', () => {
  it('accepts a well-formed key unchanged', () => {
    const r = normalizeKey(VALID);
    expect(r).toEqual({ ok: true, key: VALID });
  });

  it('rejects an empty or whitespace-only value as empty, not as a prefix problem', () => {
    expect(normalizeKey('')).toEqual({ ok: false, reason: 'empty' });
    expect(normalizeKey('   \n ')).toEqual({ ok: false, reason: 'empty' });
  });

  it('rejects a key without the Anthropic prefix', () => {
    expect(normalizeKey('sk-proj-abcdefghijklmnopqrs')).toEqual({ ok: false, reason: 'prefix' });
  });

  it('rejects a key too short to mask safely', () => {
    const short = `${ANTHROPIC_KEY_PREFIX}abc`;
    expect(short.length).toBeLessThan(MIN_KEY_LENGTH);
    expect(normalizeKey(short)).toEqual({ ok: false, reason: 'too-short' });
  });

  // ★ Pins the reason the limit exists, not just the limit. The hint is
  // `left(7) + '…' + right(4)` = 11 characters of a real key. At MIN_KEY_LENGTH
  // that still conceals the majority; any lower and the "mask" would leak more
  // than it hides. This is the assertion that should fail if someone lowers the
  // constant for convenience.
  it('keeps the minimum length above what the hint reveals', () => {
    const revealed = 7 + 4;
    expect(MIN_KEY_LENGTH).toBeGreaterThan(revealed * 1.5);
  });
});

describe('keyFormatMessage', () => {
  it.each(['empty', 'whitespace', 'prefix', 'too-short'] as const)(
    'returns copy for %s',
    (reason) => {
      const msg = keyFormatMessage(reason);
      expect(msg.length).toBeGreaterThan(0);
    },
  );

  // §4.6.3 — these strings land in a DOM node and can end up in a screenshot on
  // a support thread. None of them may carry the value being rejected.
  it('never echoes a key back in any message', () => {
    for (const reason of ['empty', 'whitespace', 'prefix', 'too-short'] as const) {
      expect(keyFormatMessage(reason)).not.toContain(VALID);
    }
  });
});
