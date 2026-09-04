import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Why this test exists.
//
// Every design doc used to carry its own `Status:` line, written at DESIGN time
// and never revisited at SHIP time. The result was not merely stale, it was
// INVERTED: on 2026-09-04 an audit found eight docs reading "DESIGN-ONLY — do
// NOT build" for features that had been live for months, and the one doc that
// called itself "the sole authority on status" (design-single-backend.md:54)
// had drifted within a single day of its own last edit.
//
// A hand-maintained line cannot be trusted because nothing fails when it is
// wrong. So status moved OUT of the doc bodies and into docs/INDEX.md — one
// place, one line per doc — and this test is the thing that fails.
//
// What it pins is deliberately narrow: every doc is ACCOUNTED FOR, and its
// state is a legal value. It does NOT check that the state is correct — no test
// can, since "is this built?" is a judgement about code the doc only describes
// in prose. The value is that adding a doc without classifying it, or deleting
// one and leaving a phantom entry, cannot pass the gate silently.

const REPO = join(__dirname, '..');
const DOCS = join(REPO, 'docs');
const INDEX = 'docs/INDEX.md';

/** Every state an entry may declare. Adding one here is a deliberate act. */
const STATES = [
  'SHIPPED-RECORD', // shipped; kept as the record of WHY, not what to build
  'PARTIAL', // some named chunks shipped, others not — the note says which
  'UNBUILT-DESIGN', // designed, not built
  'BACKLOG', // holding pen; needs a design before it is buildable
  'SUPERSEDED', // dead; retained only because something still points at it
  'OPS', // runbook, agent instruction, or UAT record — not a design
] as const;

/** Markdown files under docs/, recursively, as repo-relative paths. */
function docFiles(dir: string, base = 'docs'): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return docFiles(full, `${base}/${name}`);
    return name.endsWith('.md') ? [`${base}/${name}`] : [];
  });
}

/**
 * An index entry is a table row whose first cell is a backticked filename.
 *
 * Parsing the backticks rather than a markdown link is what keeps the format
 * from drifting: a link renders identically whether or not the target exists,
 * so a typo would read as fine and this test would be the only thing that ever
 * noticed. A bare filename in backticks has exactly one spelling.
 */
const ENTRY_ROW = /^\|\s*`([^`]+\.md)`\s*\|\s*([A-Z-]+)\s*\|/;

function entries(index: string): { path: string; state: string; line: number }[] {
  return partition(index).shown.flatMap(({ text, line }) => {
    const m = text.match(ENTRY_ROW);
    return m ? [{ path: `docs/${m[1]}`, state: m[2], line }] : [];
  });
}

/** The opening marker of a fence line — '`' or '~' — or null if not a fence. */
function fenceOf(text: string): string | null {
  const m = text.match(/^ {0,3}(`{3,}|~{3,})/);
  return m ? m[1][0] : null;
}

/**
 * Split into what a reader sees and what is hidden from them.
 *
 * Three rounds of Codex have gone at this, and every break was the same
 * shape: some region that Markdown hides but the parser read, or vice versa.
 * R1 was HTML comments, R2 was a fence nested inside a comment, R3 was `~~~`
 * — which Markdown fences with and this only matched on backticks.
 *
 * So the hidden half is returned too, and `no hidden entry rows` below makes
 * a hidden row a failure in its own right. That kills the class rather than
 * the instance: it no longer matters whether a future hiding trick is one
 * this parser models, because any entry-shaped row that a reader cannot see
 * fails the suite regardless of how it was hidden.
 */
function partition(src: string): {
  shown: { text: string; line: number }[];
  hidden: { text: string; line: number }[];
} {
  const shown: { text: string; line: number }[] = [];
  const hidden: { text: string; line: number }[] = [];
  let fence: string | null = null;
  let commented = false;
  src.split('\n').forEach((raw, i) => {
    const line = i + 1;
    let t = raw;

    // 1. Inside a comment: nothing is a fence, only `-->` matters.
    if (commented) {
      const end = t.indexOf('-->');
      if (end === -1) {
        hidden.push({ text: t, line });
        return;
      }
      commented = false;
      hidden.push({ text: t.slice(0, end), line });
      t = t.slice(end + 3);
    }

    // 2. Inside a fence: `<!--` is literal code; only a matching fence closes.
    if (fence) {
      hidden.push({ text: t, line });
      if (fenceOf(t) === fence) fence = null;
      return;
    }

    // 3. Normal text: complete comments are hidden, then an unclosed opener.
    t = t.replace(/<!--[\s\S]*?-->/g, (m) => {
      hidden.push({ text: m, line });
      return '';
    });
    const open = t.indexOf('<!--');
    if (open !== -1) {
      commented = true;
      hidden.push({ text: t.slice(open), line });
      t = t.slice(0, open);
    }

    const f = fenceOf(t);
    if (f) {
      fence = f;
      hidden.push({ text: t, line });
      return;
    }
    shown.push({ text: t, line });
  });
  return { shown, hidden };
}

const INDEX_SRC = readFileSync(join(REPO, INDEX), 'utf8');
const { hidden: HIDDEN } = partition(INDEX_SRC);
const ENTRIES = entries(INDEX_SRC);
const FILES = docFiles(DOCS).filter((p) => p !== INDEX);

describe('docs/INDEX.md accounts for every doc', () => {
  it('parses at least one entry', () => {
    // A guard on the parser itself. If the table format changed, every other
    // assertion here would compare two empty sets and pass — the classic test
    // that cannot fail. This is the positive control.
    expect(ENTRIES.length).toBeGreaterThan(50);
  });

  it('lists every markdown file under docs/', () => {
    const listed = new Set(ENTRIES.map((e) => e.path));
    const missing = FILES.filter((f) => !listed.has(f));
    expect(missing, `add these to ${INDEX} with a state`).toEqual([]);
  });

  it('lists no file that does not exist', () => {
    const onDisk = new Set(FILES);
    const phantom = ENTRIES.filter((e) => !onDisk.has(e.path)).map((e) => `${e.path} (line ${e.line})`);
    expect(phantom, `remove these from ${INDEX} — the file is gone`).toEqual([]);
  });

  it('lists each file exactly once', () => {
    const seen = new Map<string, number>();
    for (const e of ENTRIES) seen.set(e.path, (seen.get(e.path) ?? 0) + 1);
    const dupes = [...seen].filter(([, n]) => n > 1).map(([p, n]) => `${p} ×${n}`);
    expect(dupes).toEqual([]);
  });

  it('does not count rows a reader cannot see', () => {
    // The mutation Codex used to defeat the earlier parser: keep the real rows,
    // hide them, and show something else. Both hidden forms must yield nothing.
    const hidden = [
      '<!--',
      '| `design-nav-graph.md` | SHIPPED-RECORD | hidden in a comment |',
      '-->',
      '```',
      '| `design-payments.md` | SHIPPED-RECORD | hidden in a fence |',
      '```',
      '| `design-perform-tab.md` | SHIPPED-RECORD | visible |',
    ].join('\n');
    expect(entries(hidden).map((e) => e.path)).toEqual(['docs/design-perform-tab.md']);
  });

  it('keeps fence and comment nesting straight in either order', () => {
    // Codex R2: a fence INSIDE a comment desynchronized the first fix.
    const fenceInComment = [
      '<!--',
      '```',
      '| `design-nav-graph.md` | SHIPPED-RECORD | hidden |',
      '-->',
      '| `design-perform-tab.md` | SHIPPED-RECORD | visible |',
    ].join('\n');
    expect(entries(fenceInComment).map((e) => e.path)).toEqual(['docs/design-perform-tab.md']);

    // And the mirror: `<!--` inside a fence is literal code, not a comment.
    const commentInFence = [
      '```',
      '<!--',
      '| `design-nav-graph.md` | SHIPPED-RECORD | code, not a row |',
      '```',
      '| `design-perform-tab.md` | SHIPPED-RECORD | visible |',
    ].join('\n');
    expect(entries(commentInFence).map((e) => e.path)).toEqual(['docs/design-perform-tab.md']);
  });

  it('hides no entry rows from the reader', () => {
    // The class-killer. Every bypass so far worked by keeping the real rows
    // in a region Markdown hides — an HTML comment (R1), a fence nested in a
    // comment (R2), a ~~~ fence (R3). Rather than model each hiding trick,
    // this makes ANY hidden entry-shaped row a failure, so the next trick
    // fails too whether or not the parser understands it.
    const buried = HIDDEN.filter((h) => ENTRY_ROW.test(h.text.trim())).map(
      (h) => `line ${h.line}: ${h.text.trim().slice(0, 60)}`,
    );
    expect(buried, 'index rows must not live inside comments or code fences').toEqual([]);
  });

  it('gives every entry a legal state', () => {
    const illegal = ENTRIES.filter((e) => !(STATES as readonly string[]).includes(e.state)).map(
      (e) => `${e.path}: ${e.state} (line ${e.line})`,
    );
    expect(illegal, `legal states: ${STATES.join(', ')}`).toEqual([]);
  });
});
