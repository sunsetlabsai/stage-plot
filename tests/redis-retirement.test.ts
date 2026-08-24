import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

// docs/design-single-backend.md chunk 0 — the guard that proves the deletion stuck.
//
// §6.1 deletes app/api/show/route.ts (the Redis slug CRUD superseded by Supabase on
// 2026-05-25 and never removed). §2.1 records that THREE supersessions were designed,
// migrated and never wired, and that both halves were left live each time. A deletion
// with no test is how the next one survives fifteen months too.
//
// SCOPE, stated because the design's own rule is that a negative claim names its
// scope: this asserts DIRECT imports under app/api/ only. lib/agent-key.ts and
// lib/admin-config.ts still import redis legitimately until chunk 5 retires the
// dependency, so a transitive check would fail today and would be asserting a
// different (later) invariant. Chunk 5 replaces this with the repo-wide version.

const REPO = resolve(__dirname, '..');
const API_DIR = join(REPO, 'app', 'api');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Runtime imports only — `import type` cannot pull a driver into the bundle.
 *
 * Covers static `from '…'`, side-effect `import '…'`, CJS `require('…')`, and
 * DYNAMIC `import('…')` / `await import('…')`. The dynamic case was a real gap
 * (Codex): the first version of this guard matched the other three, so a route
 * could `await import('redis')` — a genuine runtime Redis import inside
 * app/api/ — while the test still passed.
 *
 * Quote styles include backticks, since require(`redis`) and import(`redis`)
 * are both valid and both evade a ['"]-only character class.
 *
 * ★ WHAT THIS CANNOT CATCH — stated in full rather than implied, because two
 * rounds of review found evasions I had claimed were already covered:
 *   - computed specifiers: `import(driverName)`, `require('re' + 'dis')`
 *   - an aliased require: `const r = require; r('redis')`
 *   - `createRequire(import.meta.url)('redis')`
 *
 * ⇒ This guard defends against ACCIDENTAL REINTRODUCTION — someone adding a
 * Redis import to a route without realising the retirement is underway. It is
 * NOT a control against deliberate evasion, and must not be cited as one.
 * The real guarantee is chunk 5 removing `redis` from package.json: once the
 * package is not installed, no specifier of any form resolves, and the failure
 * is a build error rather than a test that has to be clever enough.
 */
/** Remove block and line comments so they can neither hide nor fake an import. */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
}

/**
 * True when an import clause binds NOTHING at runtime.
 *
 * `import type { X }` and `import { type X }` are both erased by the compiler.
 * A MIXED clause is not: `import { createClient, type X }` still pulls the
 * module in. So the rule is "every binding is type-only", not "any binding is".
 */
function isTypeOnlyClause(clause: string): boolean {
  const c = clause.trim();
  if (/^type\b/.test(c)) return true; // import type { X } / import type X
  const braced = c.match(/^\{([\s\S]*)\}$/);
  if (!braced) return false; // default or namespace binding — runtime
  const entries = braced[1].split(',').map((e) => e.trim()).filter(Boolean);
  if (entries.length === 0) return false; // `import {} from` — still a runtime import
  return entries.every((e) => /^type\s/.test(e));
}

const Q = `['"\`]`;
const SPEC = `([^'"\`]+)`;

function importSpecifiers(rawSrc: string): Set<string> {
  const src = stripComments(rawSrc);
  const specs = new Set<string>();

  // Static `import <clause> from '…'` / `export <clause> from '…'`. The clause is
  // captured so type-only forms can be excluded by analysis rather than by a
  // lookahead, which cannot see inline `{ type X }`.
  const staticRe = new RegExp(
    `\\b(?:import|export)\\s+([\\s\\S]*?)\\s+from\\s*${Q}${SPEC}${Q}`,
    'g',
  );
  let m: RegExpExecArray | null;
  while ((m = staticRe.exec(src))) {
    if (!isTypeOnlyClause(m[1])) specs.add(m[2]);
  }

  // Side-effect import, CJS require, and dynamic import. `\s*` before every call
  // paren: `require ('redis')` is valid JS and was a real evasion (Codex).
  const simple = [
    new RegExp(`^\\s*import\\s*${Q}${SPEC}${Q}`, 'gm'),
    new RegExp(`\\brequire\\s*\\(\\s*${Q}${SPEC}${Q}\\s*\\)`, 'g'),
    new RegExp(`\\bimport\\s*\\(\\s*${Q}${SPEC}${Q}\\s*\\)`, 'g'),
  ];
  for (const re of simple) {
    while ((m = re.exec(src))) specs.add(m[1]);
  }
  return specs;
}

describe('chunk 0 — the Redis show route is gone and stays gone', () => {
  it('app/api/show no longer exists', () => {
    expect(existsSync(join(API_DIR, 'show'))).toBe(false);
  });

  it('leaves app/api/shows (the Supabase replacement) untouched', () => {
    // Guards against deleting the wrong one — the two paths differ by a single
    // character and the live route is the plural.
    expect(existsSync(join(API_DIR, 'shows'))).toBe(true);
  });

  it('no route under app/api/ imports redis directly', () => {
    const offenders = walk(API_DIR).filter((file) => {
      const specs = importSpecifiers(readFileSync(file, 'utf8'));
      return [...specs].some((s) => s === 'redis' || s.startsWith('redis/'));
    });

    // Named, not just counted — a failure should say which file to look at.
    expect(offenders.map((f) => f.slice(REPO.length + 1))).toEqual([]);
  });

  it.each([
    ["static default", `import redis from 'redis';`],
    ["static named", `import { createClient } from 'redis';`],
    ["static namespace", `import * as r from 'redis';`],
    ["side-effect", `import 'redis';`],
    ["re-export", `export { createClient } from 'redis';`],
    ["require", `const r = require('redis');`],
    ["require backtick", 'const r = require(`redis`);'],
    ["dynamic import", `const r = await import('redis');`],
    ["dynamic, no await", `void import('redis');`],
    ["dynamic backtick", 'const r = await import(`redis`);'],
    ["subpath", `import x from 'redis/dist/thing';`],
    // Whitespace and comments between the identifier and the call paren — both
    // valid JS, neither a computed specifier. Codex found these evading the guard.
    ["require with space", `const r = require ('redis');`],
    ["require with comment", `const r = require /* sneaky */ ('redis');`],
    ["dynamic with space", `const r = await import ('redis');`],
    // Mixed clause: one type binding does NOT make the import type-only.
    ["mixed type + runtime", `import { type RedisClientType, createClient } from 'redis';`],
    ["empty clause", `import {} from 'redis';`],
  ])('detects a redis import written as: %s', (_label, src) => {
    const specs = [...importSpecifiers(src)];
    expect(specs.some((s) => s === 'redis' || s.startsWith('redis/'))).toBe(true);
  });

  it.each([
    ["import type clause", `import type { RedisClientType } from 'redis';`],
    ["import type default", `import type Redis from 'redis';`],
    // Inline type modifier — erased by the compiler, so NOT a runtime import.
    // The old lookahead could not see this and falsely flagged it (Codex).
    ["inline type modifier", `import { type RedisClientType } from 'redis';`],
    ["inline type, multiple", `import { type A, type B } from 'redis';`],
    ["export inline type", `export { type RedisClientType } from 'redis';`],
    ["export type clause", `export type { RedisClientType } from 'redis';`],
  ])('does NOT flag type-only form: %s', (_label, src) => {
    expect([...importSpecifiers(src)]).not.toContain('redis');
  });

  it('ignores an import that is itself commented out', () => {
    expect([...importSpecifiers(`// import { createClient } from 'redis';`)]).not.toContain('redis');
    expect([...importSpecifiers(`/* import 'redis'; */`)]).not.toContain('redis');
  });

  it('the walker actually reaches route files (positive control)', () => {
    // Without this, a broken walker returning [] would make the assertion above
    // pass vacuously — which is exactly the failure mode that produced the
    // fabricated finding in Codex R5: an empty result read as proof of absence.
    const files = walk(API_DIR);
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.endsWith(join('shows', 'route.ts')))).toBe(true);
  });
});
