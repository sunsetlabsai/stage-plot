import { describe, it, expect } from 'vitest';
import ts from 'typescript';
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
 * Runtime module specifiers, via the TypeScript compiler's own parser.
 *
 * ★ THIS WAS A REGEX SCANNER AND IT WAS WRONG THREE ROUNDS RUNNING. Each round
 * closed the hole Codex named and left an adjacent one: `require (` with a
 * space, then an interstitial comment, then `import { type as foo }`, then a
 * comment-stripper that ate `"http://"` and deleted the import after it.
 *
 * The mistake was not any individual pattern — it was hand-rolling a TypeScript
 * lexer in a TypeScript repo. `typescript` is already a devDependency. The
 * compiler tokenises strings, comments, regex literals and template literals
 * correctly BY DEFINITION, and it exposes `isTypeOnly` on both the import clause
 * and each individual specifier, which is precisely the distinction three
 * regex attempts kept getting wrong.
 *
 * Type-only bindings are excluded because they are erased at compile time and
 * cannot pull a driver into the bundle. A MIXED clause is NOT excluded:
 * `import { createClient, type X }` is a runtime import.
 *
 * ★ REMAINING LIMIT — genuinely out of reach of a source-level check, not a
 * gap I have merely failed to close yet: a specifier that is not a string
 * literal. `import(driverName)`, `require('re' + 'dis')`, an aliased
 * `const r = require; r('redis')`, `createRequire(import.meta.url)('redis')`.
 * This guard defends against ACCIDENTAL REINTRODUCTION and must not be cited
 * as a control against deliberate evasion. The real guarantee is chunk 5
 * removing `redis` from package.json — then no specifier of any form resolves
 * and the failure is a build error, not a test being clever enough.
 */
function importSpecifiers(src: string): Set<string> {
  const sf = ts.createSourceFile('probe.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specs = new Set<string>();

  const literal = (n: ts.Node | undefined): string | null =>
    n && ts.isStringLiteralLike(n) ? n.text : null;

  const visit = (node: ts.Node): void => {
    // import … from '…'  /  import '…'
    if (ts.isImportDeclaration(node)) {
      const spec = literal(node.moduleSpecifier);
      const clause = node.importClause;
      // No clause at all => side-effect import, always runtime.
      if (spec && (!clause || !isClauseTypeOnly(clause))) specs.add(spec);
    }
    // export … from '…'
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const spec = literal(node.moduleSpecifier);
      if (spec && !isExportTypeOnly(node)) specs.add(spec);
    }
    // import('…')  and  require('…')
    else if (ts.isCallExpression(node)) {
      const isDynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamic || isRequire) {
        const spec = literal(node.arguments[0]);
        if (spec) specs.add(spec);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specs;
}

/** `import type …`, or named bindings where EVERY specifier is type-only. */
function isClauseTypeOnly(clause: ts.ImportClause): boolean {
  if (clause.isTypeOnly) return true;
  if (clause.name) return false; // default binding is runtime
  const b = clause.namedBindings;
  if (!b || ts.isNamespaceImport(b)) return false; // `* as ns` is runtime
  if (b.elements.length === 0) return false; // `import {} from` still loads the module
  return b.elements.every((e) => e.isTypeOnly);
}

function isExportTypeOnly(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  const c = node.exportClause;
  if (!c || !ts.isNamedExports(c)) return false; // `export * from` is runtime
  if (c.elements.length === 0) return false;
  return c.elements.every((e) => e.isTypeOnly);
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
    // `type` is a valid RUNTIME export name. `{ type as foo }` imports the
    // binding named `type` — TypeScript reports isTypeOnly: false. A textual
    // /^type\s/ check treated it as type-only and dropped it (Codex).
    ["runtime export literally named `type`", `import { type as foo } from 'redis';`],
    ["same via export-from", `export { type as foo } from 'redis';`],
    // A string containing comment delimiters must not swallow the real import
    // that follows it. The previous regex comment-stripper turned
    // `const s = "http://"` into `const s = "http:` and ate the next line.
    ["import after a string holding //", `const s = "http://"; const r = await import('redis');`],
    ["import after a string holding /*", `const s = "/*"; const r = require('redis');`],
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

  it('does not invent an import out of string contents', () => {
    // The regex comment-stripper could splice two string literals into a fake
    // import (Codex). A real parser sees two strings and no import at all.
    const src = `const a = "import x /*"; const b = "*/ from 'redis'";`;
    expect([...importSpecifiers(src)]).not.toContain('redis');
  });

  it('parses a route with JSX/generics/regex literals without choking', () => {
    // A hand-rolled lexer trips on `/` in regex literals and `<` in generics.
    // Pinned so a future "optimisation" back to regex scanning fails loudly.
    const src = `
      const re = /from 'redis'/g;
      const pick = <T,>(x: T) => x;
      const tpl = \`require('redis')\`;
      export async function GET() { return Response.json({ ok: !!re && !!pick && !!tpl }); }
    `;
    expect([...importSpecifiers(src)]).not.toContain('redis');
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
