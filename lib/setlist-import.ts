import { normalizeSongKeySafe } from './normalize';
import type { SetlistSong } from './types';

// Setlist import: CSV parsing, header mapping, and the merge.
//
// Design: docs/design-setlist-import-merge.md (v8, Codex R6, design-complete).
// Everything here is PURE — no fetch, no crypto, no Date. `mergeSetlist` takes
// an injected `newId` precisely so the round-trip test can deep-equal.
//
// The invariants these functions exist to hold (design §0):
//   1. Import never destroys data the sheet did not mention.
//   2. Matching uses normalizeSongKeySafe — the same primitive the save path
//      uses, imported, never re-implemented.
//   3. Kept-missing rows hold their existing index; incoming rows fill the
//      remaining slots in sheet order.
//   4. Free slots === incoming row count. Exact fit, no holes.
//   5. An empty sheet cell never clears an existing value.
//   6. Nothing here persists BPM or artist.
//   7. mergeSetlist is pure — newId injected.
//   8. Sheet order === the order parseRows returns; mergeSetlist never re-sorts.
//   9. Final positions are dense and 1-based.

/** A row read from the sheet. `artist` is carried for display only — design §6. */
export interface ImportedRow {
  title: string;
  key?: string;
  lead?: string;
  notes?: string;
  sceneNote?: string;
  /** Parsed so the preview can show it. NEVER persisted — design §6. */
  artist?: string;
}

/** Column positions resolved from the header row. Design §5. */
export interface FieldIndex {
  position?: number;
  title: number;
  key?: number;
  lead?: number;
  notes?: number;
  sceneNote?: number;
  /** Recognized so the matcher cannot mis-bind it. Not imported — design §6. */
  artist?: number;
  /** Recognized so the matcher cannot mis-bind it. Not imported — design §10. */
  bpm?: number;
}

/** Fields a sheet cell can overwrite on a matched row. Deliberately excludes
 *  bpm (no persistence path — design §10) and artist (library-level — §6). */
const MERGEABLE_FIELDS = ['title', 'key', 'lead', 'notes', 'sceneNote'] as const;
type MergeableField = typeof MERGEABLE_FIELDS[number];

export interface FieldChange {
  field: MergeableField;
  from?: string;
  to: string;
}

export interface ImportDiff {
  matched: { title: string; id?: string; changes: FieldChange[] }[];
  added: { title: string }[];
  /** Present in the setlist, absent from the sheet, and KEPT (removeMissing false). */
  missing: { title: string; index: number }[];
  /** Present in the setlist, absent from the sheet, and DROPPED (removeMissing true). */
  removed: { title: string; index: number }[];
  /** True when the merge changes the relative order of pre-existing rows. */
  reordered: boolean;
}

export class MissingTitleColumnError extends Error {
  constructor() {
    super('Could not find a "title" or "song" column');
    this.name = 'MissingTitleColumnError';
  }
}

// ── CSV ──────────────────────────────────────────────────────────────────────

/**
 * Moved verbatim from app/api/sheet/route.ts — no behavior change (design §8).
 * Handles quoted fields, escaped "" pairs, CRLF, and an unterminated quote at
 * EOF (the partial field is kept rather than dropped).
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let current: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        current.push(field);
        field = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        current.push(field);
        field = '';
        rows.push(current);
        current = [];
      } else {
        field += ch;
      }
    }
  }
  if (field || current.length) {
    current.push(field);
    rows.push(current);
  }
  return rows;
}

// ── Header mapping ───────────────────────────────────────────────────────────

/**
 * Exact aliases are tried for EVERY field before any substring match is
 * attempted. That ordering is the fix for "Song Key" binding the title column
 * when it sits left of "Title" — design §5.
 *
 * `key` has NO substring aliases on purpose (Codex R1): a "Keys" column in a
 * band's sheet is at least as likely to mean the keyboard player's part, and
 * mis-binding it would write instrument names into every song's musical key.
 */
const FIELD_ALIASES: {
  field: keyof FieldIndex;
  exact: string[];
  substring: string[];
}[] = [
  { field: 'position', exact: ['#', 'pos', 'position', 'order'], substring: ['pos'] },
  { field: 'title', exact: ['title', 'song', 'song title'], substring: ['title'] },
  { field: 'key', exact: ['key', 'song key'], substring: [] },
  { field: 'lead', exact: ['lead', 'singer', 'vocal', 'vocals'], substring: ['lead', 'singer'] },
  { field: 'artist', exact: ['artist'], substring: ['artist'] },
  { field: 'bpm', exact: ['bpm'], substring: ['tempo'] },
  // sceneNote precedes notes in the substring pass: "scene note" contains
  // "note", and single-binding alone would otherwise resolve it by column order.
  { field: 'sceneNote', exact: ['scene note', 'scene', 'scene cue'], substring: ['scene'] },
  { field: 'notes', exact: ['notes', 'note'], substring: ['note'] },
];

/**
 * Resolve column indices from a header row. Precedence-ordered and
 * single-binding: an index bound to one field is not eligible for another.
 *
 * @throws MissingTitleColumnError when no title column can be resolved.
 */
export function mapHeaders(headers: string[]): FieldIndex {
  const norm = headers.map((h) => h.toLowerCase().trim());
  const used = new Set<number>();
  const found: Partial<Record<keyof FieldIndex, number>> = {};

  // Pass 1 — exact equality, all fields.
  for (const { field, exact } of FIELD_ALIASES) {
    if (found[field] !== undefined) continue;
    const idx = norm.findIndex((h, i) => !used.has(i) && exact.includes(h));
    if (idx !== -1) {
      found[field] = idx;
      used.add(idx);
    }
  }

  // Pass 2 — substring containment, only for fields still unbound.
  for (const { field, substring } of FIELD_ALIASES) {
    if (found[field] !== undefined || substring.length === 0) continue;
    const idx = norm.findIndex(
      (h, i) => !used.has(i) && substring.some((s) => h.includes(s)),
    );
    if (idx !== -1) {
      found[field] = idx;
      used.add(idx);
    }
  }

  if (found.title === undefined) throw new MissingTitleColumnError();
  return found as FieldIndex;
}

// ── Row parsing ──────────────────────────────────────────────────────────────

/**
 * Turn data rows into ImportedRows, and establish SHEET ORDER.
 *
 * Sheet order is defined here and nowhere else (design §4, Codex R4):
 *   - if EVERY row carries a finite `#`, rows are returned stably sorted by it;
 *   - otherwise they are returned in physical order, untouched.
 *
 * All-or-nothing rather than a per-row fallback, because `#` values are 1-based
 * and array indices are 0-based — v5's "interleave the two" had no definite
 * order to specify (Codex R5). A half-numbered sheet is malformed; honoring
 * physical order for it cannot drop a row.
 *
 * `mergeSetlist` consumes this order as given and never re-sorts.
 */
export function parseRows(dataRows: string[][], fields: FieldIndex): ImportedRow[] {
  const cell = (row: string[], idx: number | undefined): string | undefined => {
    if (idx === undefined) return undefined;
    const v = row[idx];
    return v === undefined ? undefined : v.trim();
  };

  const decorated: { row: ImportedRow; order: number; pos: number | null }[] = [];

  dataRows.forEach((raw) => {
    const title = cell(raw, fields.title);
    if (!title) return; // blank-title rows are dropped

    const row: ImportedRow = { title };
    const key = cell(raw, fields.key);
    const lead = cell(raw, fields.lead);
    const notes = cell(raw, fields.notes);
    const sceneNote = cell(raw, fields.sceneNote);
    const artist = cell(raw, fields.artist);
    if (key) row.key = key;
    if (lead) row.lead = lead;
    if (notes) row.notes = notes;
    if (sceneNote) row.sceneNote = sceneNote;
    if (artist) row.artist = artist;

    // Number('four') is NaN and used to land straight in `position`
    // (app/api/sheet/route.ts:50). Guard, and treat non-finite as "absent",
    // which makes the whole column incomplete.
    let pos: number | null = null;
    const rawPos = cell(raw, fields.position);
    if (rawPos) {
      const n = Number.parseInt(rawPos, 10);
      if (Number.isFinite(n)) pos = n;
    }

    decorated.push({ row, order: decorated.length, pos });
  });

  const complete =
    fields.position !== undefined &&
    decorated.length > 0 &&
    decorated.every((d) => d.pos !== null);

  if (!complete) return decorated.map((d) => d.row);

  // Decorate-sort-undecorate rather than relying on Array#sort stability, so
  // duplicate `#` values provably keep their physical order (design §4).
  return decorated
    .slice()
    .sort((a, b) => (a.pos! - b.pos!) || (a.order - b.order))
    .map((d) => d.row);
}

// ── Merge ────────────────────────────────────────────────────────────────────

/**
 * Merge sheet rows into an existing setlist, preserving everything the sheet
 * did not mention. This is the function that fixes the live data-loss bug:
 * today's importer rebuilds the setlist wholesale and drops id, songId, key,
 * bpm and charts on every re-import.
 *
 * `newId` is injected, never called from module scope — that is what makes the
 * round-trip assertion an exact deep-equal rather than an id-blind compare.
 */
export function mergeSetlist(
  existing: SetlistSong[],
  incoming: ImportedRow[],
  opts: { newId: () => string; removeMissing: boolean },
): { merged: SetlistSong[]; diff: ImportDiff } {
  const { newId, removeMissing } = opts;

  // Rule 1 — index existing rows by the SAME key the save path resolves with.
  // Titles that normalize to null (blank, punctuation-only) are unmatchable and
  // fall through to the removal-candidate path.
  const byKey = new Map<string, number[]>();
  existing.forEach((song, i) => {
    const k = normalizeSongKeySafe(song.title);
    if (k === null) return;
    const bucket = byKey.get(k);
    if (bucket) bucket.push(i);
    else byKey.set(k, [i]);
  });

  const consumed = new Set<number>();
  const placements: SetlistSong[] = [];
  const matched: ImportDiff['matched'] = [];
  const added: ImportDiff['added'] = [];

  // Rules 2–4 — walk incoming in sheet order, first-unconsumed match wins.
  for (const row of incoming) {
    const k = normalizeSongKeySafe(row.title);
    let matchIdx = -1;
    if (k !== null) {
      for (const candidate of byKey.get(k) ?? []) {
        if (!consumed.has(candidate)) {
          matchIdx = candidate;
          break;
        }
      }
    }

    if (matchIdx !== -1) {
      consumed.add(matchIdx);
      const base = existing[matchIdx];
      const { song, changes } = applySheetRow(base, row);
      placements.push(song);
      matched.push({ title: base.title, id: base.id, changes });
    } else {
      const song: SetlistSong = {
        id: newId(),
        position: 0, // rewritten below; positions are always dense and 1-based
        title: row.title,
        lead: row.lead ?? '',
      };
      if (row.key) song.key = row.key;
      if (row.notes) song.notes = row.notes;
      if (row.sceneNote) song.sceneNote = row.sceneNote;
      placements.push(song);
      added.push({ title: row.title });
    }
  }

  // Rule 5 — everything unconsumed is a removal candidate.
  const keptIndices = existing
    .map((_, i) => i)
    .filter((i) => !consumed.has(i));
  const missingEntries = keptIndices.map((i) => ({
    title: existing[i].title,
    index: i,
  }));

  let merged: SetlistSong[];

  if (removeMissing) {
    // No kept rows, so sheet order is the order.
    merged = placements;
  } else {
    // Rule 5a — kept rows hold their existing index; incoming rows fill the
    // remaining slots in sheet order.
    //
    // The slot arithmetic is exact and worth stating:
    //   free = (existing + added) - (existing - matched) = added + matched
    //        = incoming.length
    // so there is never a spare slot and never an unplaced row. An
    // implementation that can leave a hole has a bug — asserted in tests.
    const slots: (SetlistSong | undefined)[] = new Array(
      existing.length + added.length,
    ).fill(undefined);
    for (const i of keptIndices) slots[i] = existing[i];

    let next = 0;
    for (const song of placements) {
      while (next < slots.length && slots[next] !== undefined) next++;
      if (next >= slots.length) {
        // Unreachable unless the slot arithmetic above is wrong. Assert rather
        // than write past the end: `slots[slots.length] = song` would silently
        // extend the array and produce a longer setlist than either input
        // justifies, which is precisely the silent-corruption shape this whole
        // module exists to remove.
        throw new Error(
          `setlist merge: no free slot for "${song.title}" ` +
            `(${placements.length} incoming, ${slots.length} slots)`,
        );
      }
      slots[next] = song;
    }

    if (slots.some((s) => s === undefined)) {
      // The mirror case: a leftover hole would be silently dropped by the
      // filter below, shortening the setlist. Invariant 4 says free slots
      // exactly equal incoming rows — enforce it, don't just assert it in prose.
      throw new Error(
        `setlist merge: ${slots.filter((s) => s === undefined).length} unfilled slot(s)`,
      );
    }

    merged = slots.filter((s): s is SetlistSong => s !== undefined);
  }

  // Rule 6 — positions are dense and 1-based over the merged array, always.
  merged = merged.map((song, i) => ({ ...song, position: i + 1 }));

  return {
    merged,
    diff: {
      matched,
      added,
      missing: removeMissing ? [] : missingEntries,
      removed: removeMissing ? missingEntries : [],
      reordered: didReorder(existing, merged),
    },
  };
}

/**
 * Carry a matched row forward, overwriting only fields the sheet supplied as a
 * NON-EMPTY cell. id, songId, charts and bpm ride along untouched — that
 * preservation is the entire point of merging.
 *
 * An empty cell never clears an existing value (design §4). The alternative
 * makes a half-filled sheet destructive again, which is the bug being fixed.
 */
function applySheetRow(
  base: SetlistSong,
  row: ImportedRow,
): { song: SetlistSong; changes: FieldChange[] } {
  const song: SetlistSong = { ...base };
  const changes: FieldChange[] = [];

  for (const field of MERGEABLE_FIELDS) {
    const incoming = row[field];
    if (incoming === undefined || incoming === '') continue;
    const current = base[field];
    if (current !== incoming) {
      changes.push({ field, from: current, to: incoming });
      // All MERGEABLE_FIELDS are string-valued; the cast is only to satisfy the
      // union-keyed write, not to widen anything.
      (song as Record<MergeableField, string | undefined>)[field] = incoming;
    }
  }

  return { song, changes };
}

/**
 * Did the relative order of pre-existing rows change? Drives the preview's
 * "Order will change" line, so it must not fire for a pure field update — and
 * must not fire merely because rows were removed. Only ids present on BOTH
 * sides are compared, so removal and addition are invisible to it; what is left
 * is genuine reordering.
 */
function didReorder(existing: SetlistSong[], merged: SetlistSong[]): boolean {
  const survivors = new Set(
    merged.map((s) => s.id).filter((id): id is string => !!id),
  );
  const before = existing
    .map((s) => s.id)
    .filter((id): id is string => !!id && survivors.has(id));
  const beforeSet = new Set(before);
  const after = merged
    .map((s) => s.id)
    .filter((id): id is string => !!id && beforeSet.has(id));
  return before.some((id, i) => after[i] !== id);
}
