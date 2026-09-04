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
function entries(index: string): { path: string; state: string; line: number }[] {
  return index.split('\n').flatMap((line, i) => {
    const m = line.match(/^\|\s*`([^`]+\.md)`\s*\|\s*([A-Z-]+)\s*\|/);
    return m ? [{ path: `docs/${m[1]}`, state: m[2], line: i + 1 }] : [];
  });
}

const INDEX_SRC = readFileSync(join(REPO, INDEX), 'utf8');
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

  it('gives every entry a legal state', () => {
    const illegal = ENTRIES.filter((e) => !(STATES as readonly string[]).includes(e.state)).map(
      (e) => `${e.path}: ${e.state} (line ${e.line})`,
    );
    expect(illegal, `legal states: ${STATES.join(', ')}`).toEqual([]);
  });
});
