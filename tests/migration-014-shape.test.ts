import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// design-single-backend.md §3.3c — chunk 6, migration 014.
//
// ★ WHY A TEXT TEST. This suite has no live database, so the ordering that
// §3.3c calls NORMATIVE has no other executable home. The failure modes it
// guards are not hypothetical:
//
//   * `create or replace` instead of drop+create leaves the 2-arg overload
//     standing. Its body reads `role`, so the final `drop column` fails and the
//     migration dies halfway — after "Collaborator read" has already been
//     dropped. Collaborators lose read access and the operator sees a partial
//     apply.
//   * Dropping the function before its dependent policy is refused by Postgres
//     outright.
//   * Dropping the column before the helper is rewritten breaks both policies
//     that call it.
//
// A comment asserting the order does not fail when someone reorders the file.

const SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/014_collaborator_view_only.sql'),
  'utf8',
);

// ★ Every content assertion runs against the STATEMENTS, never the raw file.
// This migration's comments quote the very things being asserted absent — they
// explain why `create or replace` is wrong and why `chart_library` is a
// different concept. Matching the raw text would fail on the explanation rather
// than on the code, which is a test that punishes documentation.
const STMTS = SQL.split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

/** Index of the first line that is a STATEMENT match, ignoring comment lines. */
function stmtIndex(pattern: RegExp): number {
  const lines = SQL.split('\n');
  const i = lines.findIndex(
    (line) => !line.trim().startsWith('--') && pattern.test(line),
  );
  if (i === -1) throw new Error(`no statement matching ${pattern}`);
  return i;
}

describe('migration 014 — the statements that must be present', () => {
  it('POSITIVE CONTROL: the file was read and has content', () => {
    // Without this, every `stmtIndex` below would throw on an empty read and the
    // ordering assertions would never be reached to fail honestly.
    expect(SQL.length).toBeGreaterThan(0);
    expect(STMTS).toContain('show_collaborators');
  });

  it('converts surviving editor rows before narrowing anything', () => {
    expect(stmtIndex(/update show_collaborators set role = 'viewer'/i))
      .toBeLessThan(stmtIndex(/alter table show_collaborators drop column role/i));
  });

  it('drops the "Editor update" grant — the only surviving editor grant', () => {
    expect(STMTS).toMatch(/drop policy if exists "Editor update" on shows/i);
  });
});

describe('migration 014 — the helper is DROPPED and recreated, not replaced', () => {
  it('does NOT use `create or replace` on is_show_collaborator', () => {
    // ★ The specific trap §3.3c names: this is a SIGNATURE change, and
    // `create or replace` cannot perform one. It would silently add a second
    // overload rather than failing.
    expect(STMTS).not.toMatch(/create or replace function is_show_collaborator/i);
  });

  it('drops the 2-arg signature explicitly', () => {
    expect(STMTS).toMatch(/drop function if exists is_show_collaborator\(uuid, ?text\)/i);
  });

  it('recreates it taking only p_show_id — p_role is gone, not ignored', () => {
    expect(STMTS).toMatch(/create function is_show_collaborator\(p_show_id uuid\)/i);
    // A parameter that silently does nothing is the next reader's trap.
    expect(STMTS).not.toMatch(/create function is_show_collaborator\([^)]*p_role/i);
  });

  it('pins search_path on the security-definer helper', () => {
    expect(STMTS).toMatch(/security definer set search_path = public/i);
  });
});

describe('migration 014 — the order Postgres actually requires', () => {
  const dropPolicy = () => stmtIndex(/drop policy if exists "Collaborator read"/i);
  const dropFn = () => stmtIndex(/drop function if exists is_show_collaborator/i);
  const createFn = () => stmtIndex(/create function is_show_collaborator/i);
  const createPolicy = () => stmtIndex(/create policy "Collaborator read"/i);
  const dropCol = () => stmtIndex(/alter table show_collaborators drop column role/i);

  it('drops the dependent policy BEFORE the function it depends on', () => {
    expect(dropPolicy()).toBeLessThan(dropFn());
  });

  it('drops the old function BEFORE creating the new one', () => {
    expect(dropFn()).toBeLessThan(createFn());
  });

  it('recreates "Collaborator read" AFTER the new function exists', () => {
    expect(createFn()).toBeLessThan(createPolicy());
  });

  it('drops the column LAST — after nothing reads it any more', () => {
    const col = dropCol();
    expect(createPolicy()).toBeLessThan(col);
    expect(createFn()).toBeLessThan(col);
  });
});

describe('§3.3c — the chart role is a DIFFERENT concept and must survive', () => {
  it('touches no chart_library / chart role', () => {
    // `chart_library.role` is guitar/lyrics/keys/... and the RPCs in 009 and 011
    // take a `p_role` of that kind. A migration that pattern-matched on "role"
    // would take them out with it.
    expect(STMTS).not.toMatch(/chart_library/i);
    expect(STMTS).not.toMatch(/alter table chart_library/i);
  });
});
