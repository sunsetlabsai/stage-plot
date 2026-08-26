// Claiming a handle must leave /claim by a DOCUMENT LOAD, never a client
// navigation.
//
// ★ WHY. `middleware.ts:86` redirects /dashboard → /claim while the signing-in
// user has no `profiles` row. `/dashboard` builds as a STATIC route, and static
// routes are held in Next's client cache (`staleTimes.static`, 5 min default),
// so that 307 is cached against /dashboard. Claiming a handle changes the
// server's answer but NOT the cached one: `router.push('/dashboard')` and
// `<Link href="/dashboard">` both replay the stale redirect without asking the
// server, and the user is pinned on "Redirecting to your dashboard..." forever.
//
// Reproduced against a production build 2026-08-26 (a `next dev` server caches
// differently and does NOT show it). Measured, before the fix: navigating away
// produced ZERO requests for /dashboard. After: one `DOC 200 /dashboard`.
//
// `router.refresh()` is NOT a fix and was measured failing: it clears the
// client cache for the CURRENT route only (next/dist/docs use-router.md:46).
// A document load is the documented reset — "The client cache is cleared on
// page refresh" (next/dist/docs glossary.md:45).
//
// This is a SOURCE-LEVEL pin because the defect lives in the browser's router,
// which no unit test in this suite can drive. It follows the scanner shape used
// by tests/redis-retirement.test.ts, positive control included.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'app/claim/page.tsx'), 'utf8');

/** Client-navigation constructs that replay the cached redirect. */
function clientNavsToDashboard(src: string): string[] {
  const hits: string[] = [];
  if (/from ['"]next\/link['"]/.test(src)) hits.push("imports next/link");
  if (/<Link\b[^>]*href=["']\/dashboard["']/.test(src)) hits.push("<Link href='/dashboard'>");
  if (/router\.(push|replace)\(\s*['"]\/dashboard['"]/.test(src)) hits.push("router.push('/dashboard')");
  return hits;
}

describe('claim page leaves via a document load', () => {
  it('uses no client navigation to /dashboard', () => {
    expect(clientNavsToDashboard(SRC)).toEqual([]);
  });

  it('does perform a document load to /dashboard', () => {
    // Without this the first assertion passes trivially on a file that simply
    // never navigates anywhere.
    expect(SRC).toMatch(/window\.location\.assign\(\s*['"]\/dashboard['"]/);
  });

  it('POSITIVE CONTROL — the scanner catches the code this replaced', () => {
    // The exact constructs that shipped before the fix. If the scanner ever
    // stops flagging these it has been broken, and the first test above is
    // asserting nothing.
    const before = `
      import Link from 'next/link';
      setTimeout(() => router.push('/dashboard'), 1500);
      <Link href="/dashboard">Go to Dashboard</Link>
    `;
    expect(clientNavsToDashboard(before)).toEqual([
      'imports next/link',
      "<Link href='/dashboard'>",
      "router.push('/dashboard')",
    ]);
  });
});
