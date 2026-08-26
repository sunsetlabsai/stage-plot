// The `?redirect=` guard on /sign-in.
//
// Every BYPASS vector below was MEASURED escaping the old
// `startsWith('/') && !startsWith('//')` guard in a real Chrome against a
// production build on 2026-08-26 — each one passed the guard and resolved to
// `http://evil.example`. They are the reason this function exists, so they are
// the test.
//
// Codex named the backslash and %5C families in review of PR #159. The TAB
// vector was not named by either of us and was found by running the sweep.
import { describe, it, expect } from 'vitest';
import { internalRedirect, DEFAULT_REDIRECT } from '@/lib/safe-redirect';

const ORIGIN = 'https://showrunr.ai';

describe('internalRedirect', () => {
  describe('vectors measured escaping the old guard', () => {
    // Spelt as real characters, which is what useSearchParams().get() hands
    // over — the browser decodes %5C before the component ever sees it.
    const BYPASSES = [
      ['backslash', '/\\evil.example'],
      ['double backslash', '/\\\\evil.example'],
      ['decoded %5C', '/\\evil.example'],
      ['decoded %5C%5C', '/\\\\evil.example'],
      ['leading tab', '/\t/evil.example'],
      ['carriage return', '/\r/evil.example'],
      ['newline', '/\n/evil.example'],
    ] as const;

    for (const [name, vector] of BYPASSES) {
      it(`refuses ${name}`, () => {
        expect(internalRedirect(vector, ORIGIN)).toBe(DEFAULT_REDIRECT);
      });
    }
  });

  describe('vectors the old guard already caught', () => {
    it('refuses a protocol-relative URL', () => {
      expect(internalRedirect('//evil.example', ORIGIN)).toBe(DEFAULT_REDIRECT);
    });

    it('refuses an absolute URL', () => {
      expect(internalRedirect('https://evil.example/x', ORIGIN)).toBe(DEFAULT_REDIRECT);
    });

    it('refuses a same-path absolute URL on another origin', () => {
      expect(internalRedirect('https://evil.example/dashboard', ORIGIN)).toBe(DEFAULT_REDIRECT);
    });
  });

  describe('legitimate destinations still work', () => {
    it('passes a plain path', () => {
      expect(internalRedirect('/dashboard', ORIGIN)).toBe('/dashboard');
    });

    it('passes a show URL', () => {
      expect(internalRedirect('/graham/nicholson-ranch', ORIGIN)).toBe('/graham/nicholson-ranch');
    });

    it('preserves query and hash', () => {
      expect(internalRedirect('/graham/show?tab=mix#song-3', ORIGIN))
        .toBe('/graham/show?tab=mix#song-3');
    });

    it('accepts an absolute URL on OUR origin, and returns it as a path', () => {
      expect(internalRedirect(`${ORIGIN}/library?q=1`, ORIGIN)).toBe('/library?q=1');
    });
  });

  describe('absent or malformed input', () => {
    it.each([null, undefined, ''])('falls back for %p', (raw) => {
      expect(internalRedirect(raw, ORIGIN)).toBe(DEFAULT_REDIRECT);
    });
  });

  it('never returns anything carrying an origin', () => {
    // The output is concatenated into a navigation. If it could ever come back
    // absolute, a caller building `origin + result` would be exploitable again.
    const inputs = [
      '/dashboard', '//evil.example', 'https://evil.example', '/\\evil.example',
      '/\t/evil.example', `${ORIGIN}/library`, null, '',
    ];
    for (const raw of inputs) {
      const out = internalRedirect(raw, ORIGIN);
      expect(out.startsWith('/')).toBe(true);
      expect(out.startsWith('//')).toBe(false);
      expect(out).not.toMatch(/^[a-z]+:/i);
    }
  });
});
