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
// scope: this asserts DIRECT imports across ALL production source — app/, lib/,
// components/ — as of chunk 5. It was app/api/ only through chunks 0–2, because
// lib/agent-key.ts and lib/admin-config.ts still imported redis legitimately
// until chunk 2 moved the quota onto Supabase RPCs.
//
// Still DIRECT, not transitive. A dependency that itself imports redis would not
// be caught here — but chunk 5 also removes redis from package.json, so no
// specifier resolves at all and that case is a build error, not a test's job.
//
// tests/ is deliberately NOT scanned: :239 below holds redis import strings as
// scanner FIXTURES. Including it would make the suite fail on its own test data.
// This is also why `grep -rn "from 'redis'"` can never be the gate — the fixtures
// and docs/ prose both match. AST over the production roots is the only form of
// this check that can pass while remaining meaningful.

const REPO = resolve(__dirname, '..');
const API_DIR = join(REPO, 'app', 'api');

// Every production root. Named individually rather than globbed from the repo
// root so that adding a new top-level source directory is a deliberate edit here
// — a glob would silently pick up (or miss) directories as the tree changes.
const SOURCE_ROOTS = ['app', 'lib', 'components'] as const;

/**
 * THE definition of "a Redis client package", used by all three assertions —
 * the import scan, package.json and the lockfile.
 *
 * Codex flagged (chunk 5 review) that banning `redis` and `redis/*` alone leaves
 * the SCOPED family open: `@redis/client` is a real, separately-installable
 * package, and `import { createClient } from '@redis/client'` would have passed
 * the guard while reintroducing exactly what the retirement removed. The
 * invariant is "no Redis client family at all", so it is spelled that way.
 *
 * One matcher rather than three inline predicates, because the way this fails is
 * for one site to be widened and the others quietly left behind — which is the
 * same drift the shared quota-backend helper exists to prevent.
 */
function isRedisPackage(name: string): boolean {
  return name === 'redis' || name.startsWith('redis/') || name === '@redis' || name.startsWith('@redis/');
}

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
 * ★ THE FIVE RUNTIME MODULE-LOAD FORMS, enumerated from the AST rather than
 * discovered one review round at a time (which is how the previous four
 * versions of this function were built, and why each had a neighbour):
 *   1. ImportDeclaration                  import x from '…' / import '…'
 *   2. ExportDeclaration + specifier      export … from '…' / export * from '…'
 *   3. ImportEqualsDeclaration            import x = require('…')
 *   4. CallExpression + ImportKeyword     import('…')
 *   5. CallExpression + require           require('…')
 *
 * DELIBERATELY EXCLUDED, because none loads a module at runtime:
 *   - ImportTypeNode — `let x: import('redis').RedisClientType`. Type position,
 *     fully erased.
 *   - JSDoc `@type {import('redis')}` — same, in a comment.
 *   - `declare module 'redis'` — an ambient declaration, not a load.
 *
 * ★ REMAINING LIMIT. Now genuinely structural rather than a gap not yet closed.
 * Two things, and only two:
 *   1. The SPECIFIER is not a string literal — `import(name)`,
 *      `require('re' + 'dis')`, `require(\`red${x}is\`)`.
 *   2. The CALLEE is bound to a different name before use —
 *      `const r = require; r('redis')`, or
 *      `const r = createRequire(u); r('redis')`.
 * Both need name resolution, which is a type-checker's job, not a syntax
 * walker's. (`createRequire(u)('redis')` INVOKED INLINE is caught; only the
 * stored-then-called form escapes.)
 *
 * This guard defends against ACCIDENTAL REINTRODUCTION and must not be cited
 * as a control against deliberate evasion. The real guarantee is chunk 5
 * removing `redis` from package.json — then no specifier of any form resolves
 * and the failure is a build error, not a test being clever enough.
 */
function importSpecifiers(src: string, fileName = 'probe.ts'): Set<string> {
  // ScriptKind from the extension: TSX parses `<T,>` differently from TS, so
  // guessing here would mis-parse one or the other. app/api is all .ts today,
  // but the walker accepts .tsx and that should not silently become wrong.
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, kind);
  const specs = new Set<string>();

  // The SPECIFIER can be wrapped exactly as the callee can: `require(('redis'))`,
  // `import('redis' as string)`. Unwrap before testing for a string literal —
  // otherwise every callee fix has a mirror-image hole on the argument side.
  const literal = (n: ts.Node | undefined): string | null => {
    if (!n) return null;
    const inner = ts.isExpression(n) ? unwrap(n) : n;
    return ts.isStringLiteralLike(inner) ? inner.text : null;
  };

  const visit = (node: ts.Node): void => {
    // (1) import … from '…'  /  import '…'
    if (ts.isImportDeclaration(node)) {
      const spec = literal(node.moduleSpecifier);
      const clause = node.importClause;
      // No clause at all => side-effect import, always runtime.
      if (spec && (!clause || !isClauseTypeOnly(clause))) specs.add(spec);
    }
    // (2) export … from '…'  /  export * from '…'
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const spec = literal(node.moduleSpecifier);
      if (spec && !isExportTypeOnly(node)) specs.add(spec);
    }
    // (3) import redis = require('…')  /  export import redis = require('…')
    //     TS-only syntax. Parsed as ImportEqualsDeclaration wrapping an
    //     ExternalModuleReference — neither an ImportDeclaration nor a
    //     CallExpression, so a visitor that checks only those walks past it
    //     (Codex). `import type x = require('…')` is erased and excluded.
    else if (ts.isImportEqualsDeclaration(node)) {
      if (!node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
        const spec = literal(node.moduleReference.expression);
        if (spec) specs.add(spec);
      }
    }
    // (4) import('…')  and  (5) require('…') in all its callee shapes
    else if (ts.isCallExpression(node)) {
      const isDynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (isDynamic || isRequireLike(node.expression)) {
        const spec = literal(node.arguments[0]);
        if (spec) specs.add(spec);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specs;
}

/**
 * Peel wrappers that change an expression's NODE KIND without changing its value.
 *
 * Applies to BOTH sides of a call: the callee AND the specifier argument.
 * `require(('redis'))` and `require('redis' as string)` are as real as
 * `(require)('redis')`, and I found those by attacking this myself rather than
 * waiting for review to name them.
 *
 * `(require)('redis')` parses as a CallExpression whose callee is a
 * ParenthesizedExpression, so an `isIdentifier` check falls straight through
 * (Codex). Rather than special-case parentheses, this handles the whole class —
 * measured against the real parser, not guessed:
 *
 *   (require)('…')                  ParenthesizedExpression
 *   ((require))('…')                ParenthesizedExpression, nested
 *   (0, require)('…')               ParenthesizedExpression → comma Binary
 *   require!('…')                   NonNullExpression
 *   (require as any)('…')           Parenthesized → AsExpression
 *   (require satisfies Fn)('…')     Parenthesized → SatisfiesExpression
 *   (<any>require)('…')             TypeAssertionExpression
 */
function unwrap(node: ts.Expression): ts.Expression {
  let n = node;
  for (;;) {
    if (ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n) || ts.isAsExpression(n)) {
      n = n.expression;
    } else if (ts.isSatisfiesExpression(n) || ts.isTypeAssertionExpression(n)) {
      n = n.expression;
    } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      n = n.right; // `(0, require)` — the value of a comma expression is its right operand
    } else {
      return n;
    }
  }
}

/**
 * True for every LITERAL, DIRECT way of naming CommonJS require.
 *
 * Covers the bare identifier, the Node property-access forms, and an immediately
 * invoked `createRequire(...)`. `require?.('…')` needs nothing extra — optional
 * call is still a CallExpression with an Identifier callee.
 */
function isRequireLike(callee: ts.Expression): boolean {
  const n = unwrap(callee);
  if (ts.isIdentifier(n)) return n.text === 'require';
  // module.require / globalThis.require / global.require — real Node APIs.
  // Deliberately NOT any `x.require`: that would fail the build on unrelated
  // code, and a false positive here costs more than this guard is worth.
  if (ts.isPropertyAccessExpression(n) && n.name.text === 'require') {
    const obj = unwrap(n.expression);
    return ts.isIdentifier(obj) && ['module', 'globalThis', 'global'].includes(obj.text);
  }
  // createRequire(import.meta.url)('redis') — invoked inline, so the specifier
  // is still a literal at this call site.
  if (ts.isCallExpression(n)) {
    const inner = unwrap(n.expression);
    return ts.isIdentifier(inner) && inner.text === 'createRequire';
  }
  return false;
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

  it('no production source under app/, lib/ or components/ imports a redis package', () => {
    const offenders = SOURCE_ROOTS.flatMap((root) => walk(join(REPO, root))).filter((file) => {
      // Filename passed so .tsx parses as TSX — see importSpecifiers.
      const specs = importSpecifiers(readFileSync(file, 'utf8'), file);
      return [...specs].some(isRedisPackage);
    });

    // Named, not just counted — a failure should say which file to look at.
    expect(offenders.map((f) => f.slice(REPO.length + 1))).toEqual([]);
  });

  it('no redis package in package.json — the guarantee the walker cannot give', () => {
    // The walker defends against ACCIDENTAL reintroduction only; it cannot catch
    // a computed specifier. Removing the dependency is what makes every form
    // fail, including the ones the AST walk documents as out of reach.
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
    const declared = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ];
    expect(declared.filter(isRedisPackage)).toEqual([]);
  });

  it('no redis package in the lockfile either, direct or transitive', () => {
    // package.json alone would still pass if the dep were merely orphaned in the
    // lock — npm ci would reinstall it and a computed specifier would resolve.
    // The lock also catches a TRANSITIVE reintroduction, which package.json
    // cannot see at all: some future dependency pulling in @redis/client.
    const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8'));
    const offenders = Object.keys(lock.packages ?? {})
      // Only the package name matters; nested paths look like
      // node_modules/foo/node_modules/@redis/client.
      .map((p) => p.split('node_modules/').pop() ?? '')
      .filter(isRedisPackage);
    expect([...new Set(offenders)]).toEqual([]);
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
    // The SCOPED family — Codex's chunk 5 note. @redis/client is separately
    // installable, so these are reintroduction paths, not hypotheticals.
    ["scoped client", `import { createClient } from '@redis/client';`],
    ["scoped subpath", `import x from '@redis/client/dist/lib';`],
    ["scoped bloom", `import x from '@redis/bloom';`],
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
    // TS-only ImportEqualsDeclaration. Not an ImportDeclaration and not a
    // CallExpression, so a visitor checking only those walks past it (Codex).
    ["import-equals-require", `import redis = require('redis');`],
    ["exported import-equals", `export import redis = require('redis');`],
    // Callee shapes. Codex found the parenthesized one; the rest came from
    // probing every wrapper against the real parser rather than waiting to be
    // told about them one at a time.
    ["parenthesized require", `const r = (require)('redis');`],
    ["doubly parenthesized", `const r = ((require))('redis');`],
    ["comma sequence callee", `const r = (0, require)('redis');`],
    ["non-null asserted", `const r = require!('redis');`],
    ["as-any callee", `const r = (require as any)('redis');`],
    ["satisfies callee", `const r = (require satisfies Function)('redis');`],
    ["optional call", `const r = require?.('redis');`],
    ["module.require", `const r = module.require('redis');`],
    ["globalThis.require", `const r = globalThis.require('redis');`],
    ["createRequire inline", `const r = createRequire(import.meta.url)('redis');`],
    // ARGUMENT wrappers — the mirror image of the callee case, and the reason
    // this fix is `unwrap` applied to both sides rather than a parentheses patch.
    ["parenthesized specifier", `const r = require(('redis'));`],
    ["specifier as string", `const r = require('redis' as string);`],
    ["specifier satisfies", `const r = require('redis' satisfies string);`],
    ["dynamic paren specifier", `const r = await import(('redis'));`],
    ["dynamic as specifier", `const r = await import('redis' as string);`],
    ["import-equals paren spec", `import redis = require(('redis'));`],
    ["optional prop require", `const r = module?.require('redis');`],
    ["export * as ns", `export * as redisNs from 'redis';`],
  ])('detects a redis import written as: %s', (_label, src) => {
    // isRedisPackage, not an inline copy — this assertion is what proves the
    // matcher recognises each form, so it must be the SAME matcher the three
    // real assertions use or the fixtures stop testing anything that ships.
    const specs = [...importSpecifiers(src)];
    expect(specs.some(isRedisPackage)).toBe(true);
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
    ["type-only import-equals", `import type redis = require('redis');`],
    // Type-position import — erased, loads nothing.
    ["import type node", `let x: import('redis').RedisClientType | null = null;`],
    ["declare module", `declare module 'redis' { export const x: number; }`],
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

  // PER-ROOT, deliberately not an aggregate count. app/ alone clears any total
  // threshold, so a mistyped or emptied lib/ or components/ would contribute
  // zero files and the repo-wide claim above would silently narrow back to
  // roughly what it asserted before chunk 5 — passing the whole time.
  it.each(SOURCE_ROOTS)('the walker reaches %s/ (per-root positive control)', (root) => {
    expect(walk(join(REPO, root)).length).toBeGreaterThan(0);
  });

  it('every declared source root exists on disk', () => {
    // walk() throws on a missing directory, but only once something calls it.
    // Asserting existence directly makes a renamed directory fail HERE, with a
    // readable message, rather than as an ENOENT inside an unrelated test.
    const missing = SOURCE_ROOTS.filter((r) => !existsSync(join(REPO, r)));
    expect(missing).toEqual([]);
  });

  it('scans the file that held the last prod redis import', () => {
    // lib/agent-key.ts:2 was the final production import, removed in chunk 2.
    // Naming it pins that the widened scan actually covers the file the whole
    // retirement was about — not merely that lib/ is non-empty.
    const scanned = SOURCE_ROOTS.flatMap((r) => walk(join(REPO, r)));
    expect(scanned.some((f) => f.endsWith(join('lib', 'agent-key.ts')))).toBe(true);
  });
});
