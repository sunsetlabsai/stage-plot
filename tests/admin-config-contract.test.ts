import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// design-single-backend §9 chunk 1, item 1: "A test pins that the two documents
// describe one union."
//
// The defect this exists to prevent is documented rather than hypothetical.
// `design-ai-key-availability.md` sat on main at v11.1 specifying
// `source: 'store' | 'env'` — a state no code could produce — because it was
// amended in a PR where nothing pinned it to the code. §3.2 records that the
// amendment was deliberately DEFERRED to this build PR for exactly that reason:
// so a test could hold the two together.
//
// So this asserts the paired doc against the SOURCE, not against a copy of the
// source's text. A test that only grepped the doc would drift the moment the
// type changed.

const REPO = join(__dirname, '..');
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');

/**
 * Comments are stripped before any assertion about CODE.
 *
 * Not a convenience — a correctness requirement. Every deletion in this chunk
 * left a comment behind naming what it deleted ("`mode: 'error'` was DELETED
 * with the Redis config client"), which is exactly the note a future reader
 * needs and exactly the string a naive `not.toContain` would trip on. Asserting
 * over raw text would force the code to be less well explained in order to stay
 * green.
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** A type declaration, from its name to the blank line that ends it. */
function declaration(src: string, name: string): string {
  const start = src.indexOf(name);
  if (start === -1) return '';
  const end = src.indexOf('\n\n', start);
  return src.slice(start, end === -1 ? undefined : end);
}

const CONFIG_SRC = code(read('lib/admin-config.ts'));
const KEY_SRC = code(read('lib/agent-key.ts'));
const KEY_DOC = read('docs/design-ai-key-availability.md');
const ONBOARDING_DOC = read('docs/design-owner-onboarding.md');

/** The `source:` members the code actually declares, in order of appearance. */
function sourceMembers(src: string): string[] {
  const m = src.match(/source:\s*((?:'[a-z]+'\s*\|?\s*)+)/);
  if (!m) return [];
  return [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
}

describe('ConfigRead is ONE union, and both documents describe it', () => {
  it('the code declares exactly one source member: env', () => {
    // Reading the declaration rather than the runtime value: `source` is a type,
    // erased at runtime, so only the source text can prove it was narrowed.
    expect(sourceMembers(CONFIG_SRC)).toEqual(['env']);
  });

  it('ConfigRead has exactly two members — no error, no store', () => {
    const decl = declaration(CONFIG_SRC, 'export type ConfigRead');
    expect(decl).toContain("status: 'ok'");
    expect(decl).toContain("status: 'none'");
    expect(decl).not.toContain("status: 'error'");
    expect(decl).not.toContain("'store'");
    expect(decl).not.toContain("'redis'");
  });

  it('neither document still specifies the retired two-member source', () => {
    for (const [name, doc] of [
      ['design-ai-key-availability.md', KEY_DOC],
      ['design-owner-onboarding.md', ONBOARDING_DOC],
    ] as const) {
      expect(doc, name).not.toContain("source: 'store' | 'env'");
      expect(doc, name).not.toContain("source: 'redis' | 'env'");
    }
  });

  it('the paired doc carries a supersession notice rather than silently disagreeing', () => {
    // A corrected doc with no notice reads as though it was always right, which
    // is how the next reader trusts the surrounding rationale that is now wrong.
    expect(KEY_DOC).toContain('SUPERSEDED IN PART');
    expect(KEY_DOC).toContain('design-single-backend.md');
  });

  it('design-owner-onboarding.md no longer presents ADMIN_SECRET as the live auth model', () => {
    // It still MENTIONS ADMIN_SECRET — the notice explains what replaced it, and
    // deleting the mentions would leave the reader unable to map the old text.
    // What it must not do is present it without that notice.
    expect(ONBOARDING_DOC).toContain('SUPERSEDED IN PART');
    expect(ONBOARDING_DOC).toContain('PLATFORM_ADMIN_EMAIL');
    expect(ONBOARDING_DOC.indexOf('SUPERSEDED IN PART')).toBeLessThan(
      ONBOARDING_DOC.indexOf('ADMIN_SECRET'),
    );
  });
});

describe('the capabilities wire shape is ONE union, and the doc describes it', () => {
  const members = (s: string) => [...s.matchAll(/'([a-z]+)'/g)].map((x) => x[1]).sort();

  it('code and doc agree on three try-it states', () => {
    const codeDecl = KEY_SRC.slice(KEY_SRC.indexOf('tryit:'), KEY_SRC.indexOf('\n', KEY_SRC.indexOf('tryit:')));
    expect(members(codeDecl)).toEqual(['available', 'exhausted', 'unconfigured']);

    // The doc writes the same union in JSON, with double quotes.
    const docDecl = KEY_DOC.slice(KEY_DOC.indexOf('"tryit":'), KEY_DOC.indexOf('\n', KEY_DOC.indexOf('"tryit":')));
    expect([...docDecl.matchAll(/"([a-z]+)"/g)].map((x) => x[1]).filter((x) => x !== 'tryit').sort())
      .toEqual(['available', 'exhausted', 'unconfigured']);
  });

  it("no KeyMode 'error' survives in code", () => {
    // The producer, the union member, and the projection all had to go together;
    // any one left behind is a branch that cannot run.
    expect(KEY_SRC).not.toContain("mode: 'error'");
    expect(KEY_SRC).not.toContain("tryit: 'error'");
  });
});

// A key pasted with a trailing newline is invisible in the Vercel dashboard and
// on /admin (which only tests non-empty), ships to Anthropic, and 401s — while
// every consumer degrades silently. Pinning the trim so it cannot regress.
describe('readAdminConfig trims surrounding whitespace', () => {
  const ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ENV };
    vi.resetModules();
  });

  it('strips a trailing newline from a pasted value', async () => {
    process.env.CLAUDE_TRYIT_KEY = 'sk-ant-real-key\n';
    const { readAdminConfig } = await import('@/lib/admin-config');
    const read = await readAdminConfig('claude_tryit_key');
    expect(read).toEqual({ status: 'ok', value: 'sk-ant-real-key', source: 'env' });
  });

  it('strips carriage returns and surrounding spaces too', async () => {
    process.env.CLAUDE_TRYIT_KEY = '  sk-ant-real-key\r\n';
    const { readAdminConfig } = await import('@/lib/admin-config');
    const read = await readAdminConfig('claude_tryit_key');
    if (read.status !== 'ok') throw new Error('expected ok');
    expect(read.value).toBe('sk-ant-real-key');
  });

  it('treats a whitespace-only value as unconfigured, not as a value', async () => {
    process.env.CLAUDE_TRYIT_KEY = '   \n';
    const { readAdminConfig } = await import('@/lib/admin-config');
    expect(await readAdminConfig('claude_tryit_key')).toEqual({ status: 'none' });
  });
});
