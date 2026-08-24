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
 * KNOWN LIMIT, stated rather than implied: a COMPUTED specifier
 * (`import(driverName)`) cannot be resolved statically by any regex. This guard
 * catches literal specifiers. That is the honest boundary of a source-level
 * check, and the reason chunk 5 removes the dependency from package.json
 * outright — once it is not installed, no specifier of any form can resolve.
 */
function importSpecifiers(src: string): Set<string> {
  const specs = new Set<string>();
  const Q = `['"\\\`]`;
  const patterns = [
    new RegExp(`^\\s*(?:import|export)(?!\\s+type\\b)[\\s\\S]*?\\bfrom\\s*${Q}([^'"\`]+)${Q}`, 'gm'),
    new RegExp(`^\\s*import\\s*${Q}([^'"\`]+)${Q}`, 'gm'),
    new RegExp(`\\brequire\\(\\s*${Q}([^'"\`]+)${Q}\\s*\\)`, 'g'),
    // Dynamic import — `import('redis')`, `await import('redis')`. The negative
    // lookbehind keeps this from double-matching the static `from` form.
    new RegExp(`\\bimport\\s*\\(\\s*${Q}([^'"\`]+)${Q}\\s*\\)`, 'g'),
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
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
  ])('detects a redis import written as: %s', (_label, src) => {
    const specs = [...importSpecifiers(src)];
    expect(specs.some((s) => s === 'redis' || s.startsWith('redis/'))).toBe(true);
  });

  it('does not flag `import type`, which cannot pull a driver into the bundle', () => {
    const specs = [...importSpecifiers(`import type { RedisClientType } from 'redis';`)];
    expect(specs).not.toContain('redis');
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
