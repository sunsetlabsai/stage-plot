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

/** Runtime imports only — `import type` cannot pull a driver into the bundle. */
function importSpecifiers(src: string): Set<string> {
  const specs = new Set<string>();
  const patterns = [
    /^\s*(?:import|export)(?!\s+type\b)[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/gm,
    /^\s*import\s*['"]([^'"]+)['"]/gm,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
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

  it('the walker actually reaches route files (positive control)', () => {
    // Without this, a broken walker returning [] would make the assertion above
    // pass vacuously — which is exactly the failure mode that produced the
    // fabricated finding in Codex R5: an empty result read as proof of absence.
    const files = walk(API_DIR);
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.endsWith(join('shows', 'route.ts')))).toBe(true);
  });
});
