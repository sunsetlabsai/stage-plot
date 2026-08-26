// The two pages that CHANGE WHO THIS BROWSER IS — /sign-in and /claim — must
// leave by a DOCUMENT LOAD, never a client navigation.
//
// ★ WHY. `middleware.ts:62` gates /dashboard and /library on the session, and
// `:86` redirects to /claim while the user has no `profiles` row. Both routes
// build STATIC, and static routes are held in Next's client cache
// (`staleTimes.static`, 5 min default) — so a middleware redirect issued under
// the OLD identity is cached against the destination. Signing in or claiming a
// handle changes the server's answer but NOT the cached one:
// `router.push('/dashboard')` and `<Link href="/dashboard">` replay the stale
// redirect without asking the server, and the user is stranded.
//
// Reproduced against a production build 2026-08-26 (a `next dev` server caches
// differently and does NOT show it). Measured, before the fix: navigating away
// from /claim produced ZERO requests for /dashboard. After: one `DOC 200`.
//
// `router.refresh()` is NOT a fix and was measured failing: it clears the
// client cache for the CURRENT route only (next/dist/docs use-router.md:46).
// A document load is the documented reset — "The client cache is cleared on
// page refresh" (next/dist/docs glossary.md:45).
//
// ★ THE REAL GUARANTEE IS STRUCTURAL, NOT THIS SCANNER. Neither page imports
// `useRouter` at all, so there is no router object in scope to push with.
// Reintroducing a client navigation takes a deliberate new import, not a
// one-word slip — which also closes the `const href = '/dashboard';
// router.push(href)` indirection a string scanner alone would miss.
//
// Source-level because the defect lives in the browser's router, which nothing
// in this suite can drive. Scanner shape follows tests/redis-retirement.test.ts.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Pages whose own effect is to change the identity middleware routes on. */
const IDENTITY_CHANGING_PAGES = ['app/sign-in/page.tsx', 'app/claim/page.tsx'];

/**
 * Source with comments removed.
 *
 * Required, not cosmetic: both pages explain IN A COMMENT that they avoid
 * `useRouter` and `router.push`, so a scanner reading raw text flags the very
 * prose documenting the fix. Caught by this test failing on its own subjects.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const read = (p: string) => stripComments(readFileSync(join(process.cwd(), p), 'utf8'));

/** Client-navigation constructs that would replay a cached redirect. */
function clientNavs(src: string): string[] {
  const hits: string[] = [];
  if (/from ['"]next\/link['"]/.test(src)) hits.push('imports next/link');
  if (/\buseRouter\b/.test(src)) hits.push('imports/uses useRouter');
  if (/<Link\b/.test(src)) hits.push('renders <Link>');
  if (/router\.(push|replace)\(/.test(src)) hits.push('router.push/replace');
  return hits;
}

describe('identity-changing pages leave via a document load', () => {
  for (const page of IDENTITY_CHANGING_PAGES) {
    it(`${page} performs no client navigation`, () => {
      expect(clientNavs(read(page))).toEqual([]);
    });

    it(`${page} does navigate, by document load`, () => {
      // Without this, the assertion above passes trivially on a page that
      // simply never navigates anywhere.
      expect(read(page)).toMatch(/window\.location\.assign\(/);
    });
  }

  it('POSITIVE CONTROL — the scanner catches the code this replaced', () => {
    // The exact constructs that shipped before the fix. If the scanner ever
    // stops flagging these it is broken, and the assertions above assert
    // nothing.
    const before = `
      import Link from 'next/link';
      import { useRouter } from 'next/navigation';
      const router = useRouter();
      setTimeout(() => router.push('/dashboard'), 1500);
      <Link href="/dashboard">Go to Dashboard</Link>
    `;
    expect(clientNavs(before)).toEqual([
      'imports next/link',
      'imports/uses useRouter',
      'renders <Link>',
      'router.push/replace',
    ]);
  });

  it('POSITIVE CONTROL — indirection through a variable is still caught', () => {
    // Codex flagged that a pure string scan would miss this. It does. The
    // useRouter check is what catches it, which is why the guarantee is the
    // absent import rather than the absent string.
    const indirect = `
      import { useRouter } from 'next/navigation';
      const href = '/dashboard';
      const router = useRouter();
      router.push(href);
    `;
    expect(clientNavs(indirect)).toContain('imports/uses useRouter');
  });
});
