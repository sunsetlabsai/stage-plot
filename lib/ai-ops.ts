// The AI op contract — design-ai-op-contract.md §3 and §5.
//
// The AI edits a show by naming only the rows it means to touch:
//
//   apply_changes({ ops: [{ entity, action, id?, tempId?, values? }, …] })
//
// `planChanges` decides everything decidable about such a plan — identity,
// intra-batch references, row shape, mix and link integrity — and returns
// either the complete next config plus a plain-language summary, or the reasons
// it refuses. Pure and total: no I/O, no throw, the input config is never
// mutated. The apply path in the page swaps `next` in through `withStableIds`
// and writes once (§6), so there is no partial-apply path.
//
// O1 (a row the model does not name is not modified) is structural: rows are
// only ever touched by an op that names their id.

import type { GeneralNote, InputChannel, MonitorMix, StageSlot } from './types';
import { POSITIONS, blockIndexOf, isOrphanedMix, nextMixNumber, slotLabel } from './setlist';

export const OP_ENTITIES = ['stagePlot', 'inputs', 'monitors'] as const;
export const OP_ACTIONS = ['add', 'remove', 'patch'] as const;
export type OpEntity = (typeof OP_ENTITIES)[number];
export type OpAction = (typeof OP_ACTIONS)[number];

export interface Op {
  entity: OpEntity;
  action: OpAction;
  /** remove/patch: an existing row's id, or a `new:` tempId added earlier in the batch. Forbidden on add. */
  id?: string;
  /** add only: a `new:`-prefixed handle other ops in the batch may use wherever an id is expected (§3.3). */
  tempId?: string;
  /** add: the new row. patch: ONLY the changed fields. Forbidden on remove. */
  values?: Record<string, unknown>;
}

/** `op` is the 0-based index of the op the problem belongs to; absent for a whole-plan problem. */
export interface Problem {
  op?: number;
  message: string;
}

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface EntityChanges {
  added: string[];
  removed: string[];
  patched: { label: string; changes: FieldChange[] }[];
}

/**
 * What a plan does, for the approve card (§7). Computed by DIFFING the config
 * against `next` by id, not by reading the ops back — so it describes what
 * apply will actually do and cannot drift from it (§10.2 test 10).
 */
export interface ChangeSummary {
  stagePlot: EntityChanges;
  inputs: EntityChanges;
  monitors: EntityChanges;
  /**
   * A mix that comes into existence at N re-attaches every performer already
   * on N. Usually right (the AI recreates Mix 7 because Cy is on it), but never
   * silent — the card names them (design-core-path-tier1 §3.6 item 7).
   */
  joins: { mix: number; names: string[] }[];
  /** Unknown fields that were dropped (§5.2): reported, not refused. */
  warnings: string[];
}

type ShowLists = { stagePlot: StageSlot[]; inputs: InputChannel[]; monitors: MonitorMix[] };

export type PlanResult<C> =
  | { ok: true; next: C; summary: ChangeSummary }
  | { ok: false; problems: Problem[] };

// ── Row shape (§5.3) ─────────────────────────────────────────────────────────
//
// Keyed `Record<keyof T, …>`, so a field added to lib/types.ts without a rule
// here is a COMPILE error — the validator cannot silently fall behind the
// schema. That covers FIELDS only. The VALUE domains below are derived from
// what the app itself creates, not from the type (§5.3 ★★): `pos` is the nine
// renderable cells, `StageSlot.mix` 0 is the unassigned sentinel, and no string
// is required to be non-empty because the app creates rows with '' everywhere.

type FieldRule = { required: boolean; check: (v: unknown) => boolean };

const isString = (v: unknown) => typeof v === 'string';
const isBoolean = (v: unknown) => typeof v === 'boolean';
const isIntAtLeast = (min: number) => (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= min;

const STAGE_SLOT_RULES: Record<keyof StageSlot, FieldRule> = {
  id: { required: false, check: isString },
  name: { required: true, check: isString },
  pos: { required: true, check: (v) => (POSITIONS as readonly unknown[]).includes(v) },
  role: { required: true, check: isString },
  mix: { required: true, check: isIntAtLeast(0) },
  power: { required: false, check: isBoolean },
  featured: { required: false, check: isBoolean },
};

const INPUT_RULES: Record<keyof InputChannel, FieldRule> = {
  id: { required: false, check: isString },
  ch: { required: true, check: isIntAtLeast(1) },
  inst: { required: true, check: isString },
  mic: { required: true, check: isString },
  stand: { required: true, check: isString },
  notes: { required: false, check: isString },
  slotId: { required: false, check: (v) => typeof v === 'string' && v !== '' },
  needsReview: { required: false, check: isBoolean },
};

const MONITOR_RULES: Record<keyof MonitorMix, FieldRule> = {
  id: { required: false, check: isString },
  mix: { required: true, check: isIntAtLeast(1) },
  name: { required: true, check: isString },
  needs: { required: true, check: isString },
  type: { required: false, check: isString },
};

const RULES: Record<OpEntity, Record<string, FieldRule>> = {
  stagePlot: STAGE_SLOT_RULES,
  inputs: INPUT_RULES,
  monitors: MONITOR_RULES,
};

/** Identity is carried by the op, never by its payload (§5.3). `slotId` is a reference, not identity, and is legal. */
const IDENTITY_KEYS = ['id', 'tempId'];

const TEMP_PREFIX = 'new:';
const isTempRef = (v: unknown): v is string => typeof v === 'string' && v.startsWith(TEMP_PREFIX);

const NOUN: Record<OpEntity, string> = { stagePlot: 'stage-plot slot', inputs: 'input', monitors: 'monitor mix' };

type Row = Record<string, unknown> & { id: string };

// ── planChanges ──────────────────────────────────────────────────────────────

/**
 * Validate and apply a batch of ops. `rawOps` is the model's tool input, so it
 * is treated as unknown and checked structurally first. Every rule is evaluated
 * against the POST-batch config (§5.2): a plan that removes a monitor and
 * re-points its performers in the same batch is valid.
 *
 * `mintId` exists for deterministic tests; production uses `crypto.randomUUID`.
 */
export function planChanges<C extends ShowLists>(
  config: C,
  rawOps: unknown,
  mintId: () => string = () => crypto.randomUUID(),
): PlanResult<C> {
  const problems: Problem[] = [];
  const warnings: string[] = [];

  if (!Array.isArray(rawOps) || rawOps.length === 0) {
    return { ok: false, problems: [{ message: 'The plan contains no changes.' }] };
  }
  // Ops address rows by id, so every row must have one. The page guarantees it
  // (`withStableIds` at every setConfig site, §9.4); this keeps the function
  // total if a caller ever skips that.
  if ([...config.stagePlot, ...config.inputs, ...config.monitors].some((r) => typeof r.id !== 'string' || r.id === '')) {
    return { ok: false, problems: [{ message: 'the show has rows without ids — reload the show and ask again' }] };
  }

  // Pass 1 — structure, and mint every tempId up front. References in `values`
  // resolve regardless of op order: the model reordering its own ops must not
  // change their meaning (§3.3, rejected alternative 2).
  const ops: Op[] = [];
  const tempIds = new Map<string, string>();
  rawOps.forEach((raw, i) => {
    const op = parseOp(raw, i, problems);
    if (!op) return;
    if (op.tempId !== undefined) {
      if (tempIds.has(op.tempId)) problems.push({ op: i, message: `tempId "${op.tempId}" is used by more than one add` });
      else tempIds.set(op.tempId, mintId());
    }
    ops.push(op);
  });
  if (problems.length > 0) return { ok: false, problems };

  // Pass 2 — apply in order to copies of the ARRAYS. Rows are never mutated:
  // a patch replaces its row with a merged copy, so a row no op names keeps its
  // object identity in `next` (O1, held by reference, not just by value).
  const lists = {
    stagePlot: [...config.stagePlot] as unknown as Row[],
    inputs: [...config.inputs] as unknown as Row[],
    monitors: [...config.monitors] as unknown as Row[],
  };
  const added: Record<OpEntity, Set<string>> = { stagePlot: new Set(), inputs: new Set(), monitors: new Set() };
  const touched: Record<OpEntity, Map<string, number>> = { stagePlot: new Map(), inputs: new Map(), monitors: new Map() };
  const warned = new Set<string>();

  ops.forEach((op, i) => {
    const rules = RULES[op.entity];
    const list = lists[op.entity];

    const values: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(op.values ?? {})) {
      if (!(key in rules)) {
        const tag = `${op.entity}.${key}`;
        if (!warned.has(tag)) {
          warned.add(tag);
          warnings.push(`Ignored "${key}" — ${PLURAL[op.entity]} have no such field.`);
        }
        continue;
      }
      if (key === 'slotId' && isTempRef(value)) {
        const real = tempIds.get(value);
        if (!real) {
          problems.push({ op: i, message: `slotId "${value}" refers to a new slot that no op in this plan creates` });
          return;
        }
        values[key] = real;
        continue;
      }
      values[key] = value;
    }
    if (op.action === 'add') {
      const id = op.tempId !== undefined ? tempIds.get(op.tempId)! : mintId();
      list.push({ ...stripNulls(values), id });
      added[op.entity].add(id);
      touched[op.entity].set(id, i);
      return;
    }

    const targetId = isTempRef(op.id) ? tempIds.get(op.id) : op.id;
    const idx = targetId === undefined ? -1 : list.findIndex((r) => r.id === targetId);
    if (idx === -1) {
      problems.push({ op: i, message: `there is no ${NOUN[op.entity]} with id "${op.id}"` });
      return;
    }

    if (op.action === 'remove') {
      list.splice(idx, 1);
      touched[op.entity].delete(targetId!);
      return;
    }

    // patch
    if (Object.keys(values).length === 0) {
      problems.push({ op: i, message: `the change to ${describeRow(op.entity, list[idx], list)} has no fields to apply` });
      return;
    }
    const row = list[idx];
    // A mix number is an aux number and changes only through renumberMix, which
    // moves its performers with it (design-core-path-tier1 §3.6 item 5). A swap
    // of Mix 1 and Mix 2 would pass every post-batch reference check — both
    // numbers still exist — and silently put each performer on the other's
    // wedge. Refused, with the recovery named. A monitor ADDED in this batch has
    // no performers routed to it yet, so setting its number is not a renumber
    // (Codex R1 on #194); a collision is still caught in pass 5.
    if (op.entity === 'monitors' && 'mix' in values && values.mix !== row.mix && !added.monitors.has(row.id)) {
      problems.push({
        op: i,
        message: `it changes Mix ${String(row.mix)} to Mix ${String(values.mix)} — renumber a mix in the Monitor Mixes table, which moves its performers with it`,
      });
      return;
    }
    // Re-linking a flagged input resolves its flag, exactly as the manual
    // relink does (the Position dropdown sets `needsReview: false`). Only a
    // flagged row: writing `false` onto one that never had the flag would show
    // as a phantom change on the card. Only a CHANGED link: re-sending the same
    // dangling slotId resolves nothing, and clearing the flag would describe a
    // change `withStableIds` reverts on apply (Codex R1 NIT on #194).
    if (op.entity === 'inputs' && 'slotId' in values && values.slotId !== row.slotId && !('needsReview' in values) && row.needsReview) {
      values.needsReview = false;
    }
    list[idx] = mergePatch(row, values);
    if (!touched[op.entity].has(row.id)) touched[op.entity].set(row.id, i);
  });
  if (problems.length > 0) return { ok: false, problems };

  // Ids are unique per list after the batch. Only a broken `mintId` could
  // violate it, but pass 3 below relies on it, so it is checked, not assumed.
  for (const entity of OP_ENTITIES) {
    const ids = lists[entity].map((r) => r.id);
    if (new Set(ids).size !== ids.length) return { ok: false, problems: [{ message: `two ${PLURAL[entity]} ended up with the same id — ask again` }] };
  }

  // Pass 3 — positional numbers an add may omit (§3.5). Assigned after every op
  // has run, so an auto number never takes one a later explicit op claims.
  // Rows are assigned only when they are NOT one of the caller's objects, so the
  // input config is never mutated even if an id were to collide (Codex R2 NIT on #194).
  const callerRows = new Set<unknown>([...config.stagePlot, ...config.inputs, ...config.monitors]);
  for (const row of lists.inputs) {
    if (added.inputs.has(row.id) && !callerRows.has(row) && row.ch === undefined) {
      row.ch = Math.max(0, ...lists.inputs.map((r) => (typeof r.ch === 'number' ? r.ch : 0))) + 1;
    }
  }
  for (const row of lists.monitors) {
    if (added.monitors.has(row.id) && !callerRows.has(row) && row.mix === undefined) {
      const numbered = lists.monitors.filter((r) => typeof r.mix === 'number') as unknown as MonitorMix[];
      // Skips orphaned slot mixes too, like "+ Add Mix" (tier1 §3.6 item 1).
      row.mix = nextMixNumber(numbered, lists.stagePlot as unknown as StageSlot[]);
    }
  }

  // Pass 4 — shape, judged on the row each touched op PRODUCES (§5.3), so a
  // patch is checked post-merge and a pre-existing row the plan never named is
  // never judged at all.
  for (const entity of OP_ENTITIES) {
    for (const [id, opIndex] of touched[entity]) {
      const row = lists[entity].find((r) => r.id === id)!;
      for (const [field, rule] of Object.entries(RULES[entity])) {
        const v = row[field];
        if (v === undefined) {
          if (rule.required) problems.push({ op: opIndex, message: `${describeRow(entity, row, lists[entity])} is missing "${field}"` });
        } else if (!rule.check(v)) {
          problems.push({ op: opIndex, message: `${describeRow(entity, row, lists[entity])} has an invalid ${field}: ${JSON.stringify(v)}${field === 'pos' ? ` (must be one of ${POSITIONS.join(', ')})` : ''}` });
        }
      }
    }
  }
  if (problems.length > 0) return { ok: false, problems };

  // Pass 5 — references and uniqueness over the post-batch config (O3).
  const next = lists as unknown as ShowLists;
  problems.push(...referenceProblems(config, next, touched));
  if (problems.length > 0) return { ok: false, problems };

  const nextConfig = { ...config, stagePlot: next.stagePlot, inputs: next.inputs, monitors: next.monitors };
  return { ok: true, next: nextConfig, summary: summarize(config, nextConfig, warnings) };
}

// ── generate_show (§9.2, §9.2a) ──────────────────────────────────────────────

/**
 * The whole-show create. Expressed AS a batch — add every row the model sent,
 * remove every row the show has — and run through `planChanges`, so the
 * flagship first run and an edit are judged by one validator, not two that can
 * drift. The model links an input to a performer by giving the slot a `new:`
 * `tempId` and the input that `slotId` (§14, step 3).
 *
 * Only `stagePlot`, `inputs` and `monitors` are replaced. Setlist, charts, notes
 * and show info ride through untouched: they are not the AI's to destroy
 * (§9.2a), and a user regenerating a stage plot has not asked to lose songs.
 */
export function planGenerateShow<C extends ShowLists>(
  config: C,
  input: unknown,
  mintId: () => string = () => crypto.randomUUID(),
): PlanResult<C> {
  const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const missing = (['stagePlot', 'inputs', 'monitors'] as const).filter((k) => !Array.isArray(body[k]));
  if (missing.length > 0) {
    return { ok: false, problems: [{ message: `generate_show needs ${missing.join(', ')} as ${missing.length === 1 ? 'a list' : 'lists'}` }] };
  }
  const rows = (k: OpEntity) => body[k] as unknown[];
  const ops: unknown[] = [];
  for (const row of rows('stagePlot')) {
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      const { tempId, ...values } = row as Record<string, unknown>;
      ops.push({ entity: 'stagePlot', action: 'add', ...(tempId !== undefined ? { tempId } : {}), values });
    } else {
      ops.push({ entity: 'stagePlot', action: 'add', values: row });
    }
  }
  // Every generated input must DECLARE its owner: a performer's tempId, or
  // null for a source no performer owns (playback, click, talkback). An
  // omitted slotId is indistinguishable from a forgotten one, and a forgotten
  // one is exactly the unlinked-input defect this tool exists to end (Codex R1
  // on #195). `null` is stripped on add, so it stores as "no link".
  const undeclared = rows('inputs').filter(
    (row) => row !== null && typeof row === 'object' && !Array.isArray(row) && !Object.prototype.hasOwnProperty.call(row, 'slotId'),
  ) as Record<string, unknown>[];
  if (undeclared.length > 0) {
    const names = undeclared.map((r) => `ch ${String(r.ch ?? '?')} ${typeof r.inst === 'string' ? r.inst : ''}`.trim());
    return {
      ok: false,
      problems: [{ message: `${names.length === 1 ? 'an input has' : `${names.length} inputs have`} no slotId (${names.join(', ')}) — give each its performer's tempId, or null if no performer owns it` }],
    };
  }
  for (const entity of ['inputs', 'monitors'] as const) {
    for (const row of rows(entity)) ops.push({ entity, action: 'add', values: row });
  }
  for (const entity of OP_ENTITIES) {
    for (const row of config[entity]) ops.push({ entity, action: 'remove', id: row.id });
  }
  return planChanges(config, ops, mintId);
}

/** True when there is nothing for a `generate_show` to replace. */
export function isShowEmpty(config: ShowLists): boolean {
  return config.stagePlot.length === 0 && config.inputs.length === 0 && config.monitors.length === 0;
}

/**
 * The confirm for a `generate_show` on a show that has content, or null on an
 * empty one (§9.2a). It states the cost in rows, because replace is the most
 * destructive thing the AI can do. Distinct from an ordinary Apply: the card
 * labels the button "Replace everything", and this confirm follows it.
 */
export function replaceShowPrompt(config: ShowLists): string | null {
  if (isShowEmpty(config)) return null;
  return (
    `Replace the whole show?\n\nThis discards ${replaceCounts(config)} and builds a new show from your description.\n\n` +
    'The setlist, charts, notes and show info are not touched.'
  );
}

/** "6 performers, 24 inputs and 4 monitor mixes" — the card and the confirm say the same thing. */
export function replaceCounts(config: ShowLists): string {
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  return `${n(config.stagePlot.length, 'performer', 'performers')}, ${n(config.inputs.length, 'input', 'inputs')} and ${n(config.monitors.length, 'monitor mix', 'monitor mixes')}`;
}

// ── update_notes ─────────────────────────────────────────────────────────────

/**
 * `update_notes` replaces the whole notes list, and notes carry no identity, so
 * a model that sends only the note it was asked to add deletes the rest (Codex
 * R1 on #195). Shape-checked here, and every existing note the new list does
 * not keep VERBATIM is named before Apply — the same confirm-with-names rule as
 * `replaceShowPrompt`. An edited note counts: its old text is what is lost.
 */
export function validateNotes(incoming: unknown): string | null {
  if (!Array.isArray(incoming)) return 'notes must be a list';
  const bad = incoming.findIndex((n) => !n || typeof n !== 'object' || typeof n.label !== 'string' || typeof n.text !== 'string');
  return bad === -1 ? null : `note ${bad + 1} needs a text label and text`;
}

export function notesReplacePrompt(current: readonly GeneralNote[], incoming: readonly GeneralNote[]): string | null {
  // Matched as a MULTISET: the notes editor allows identical rows, so two
  // copies kept as one is a loss a Set would not see (Codex R2 on #195).
  const key = (n: GeneralNote) => JSON.stringify([n.label, n.text]);
  const available = new Map<string, number>();
  for (const n of incoming) available.set(key(n), (available.get(key(n)) ?? 0) + 1);
  const lost = current.filter((n) => {
    const left = available.get(key(n)) ?? 0;
    if (left === 0) return true;
    available.set(key(n), left - 1);
    return false;
  });
  if (lost.length === 0) return null;
  return (
    `Replace the general notes?\n\nThis removes or rewrites ${lost.length === 1 ? '1 existing note' : `${lost.length} existing notes`}:\n` +
    lost.map((n) => `  • ${n.label || '(no label)'}`).join('\n')
  );
}

// ── The approve card's diff (§7) ─────────────────────────────────────────────

export interface SummaryLine {
  kind: 'add' | 'remove' | 'patch' | 'join' | 'warn';
  text: string;
}

export interface SummarySection {
  title: string;
  lines: SummaryLine[];
}

/** Field names as the tables label them, where the type's name would mean nothing to a performer. */
const FIELD_LABEL: Record<string, string> = { slotId: 'performer', pos: 'position', inst: 'source', needsReview: 'review flag' };
const fieldLabel = (f: string) => FIELD_LABEL[f] ?? f;

/** Past this many patched rows in one list, the card counts instead of listing (§7). */
export const SUMMARY_ROW_LIMIT = 5;

const PLURAL: Record<OpEntity, string> = { stagePlot: 'performers', inputs: 'inputs', monitors: 'monitor mixes' };
const TITLE: Record<OpEntity, string> = { stagePlot: 'Stage plot', inputs: 'Inputs', monitors: 'Monitors' };

/**
 * `ChangeSummary` as plain-language lines, grouped by list. A raw op list is
 * worse than useless to a performer; this is what they approve. `prev`/`next`
 * resolve a `slotId` to the performer it names, so a re-link reads
 * "→ DSR — Ray", never a UUID.
 */
export function summaryLines(summary: ChangeSummary, prev: ShowLists, next: ShowLists): SummarySection[] {
  // Two lookups, not one: a `from` names the performer as they were BEFORE
  // Apply, a `to` as they will be after. One shared map let a same-batch
  // rename overwrite the old name (Codex R1 on #196).
  const names = (list: StageSlot[]) =>
    new Map(list.map((s, idx) => [s.id, `${s.pos} — ${slotLabel(s, blockIndexOf(list, idx))}`] as const));
  const before = names(prev.stagePlot);
  const after = names(next.stagePlot);
  const show = (field: string, v: unknown, side: 'from' | 'to'): string => {
    if (v === undefined && field === 'needsReview') return 'no'; // absent flag = off
    if (field === 'mix' && v === 0) return 'none'; // the unassigned sentinel
    if (v === undefined || v === '') return field === 'slotId' ? 'no performer' : '—';
    if (field === 'slotId') return (side === 'from' ? before : after).get(String(v)) ?? 'a removed performer';
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    return String(v);
  };
  const changeText = (c: FieldChange) => `${fieldLabel(c.field)} ${show(c.field, c.from, 'from')} → ${show(c.field, c.to, 'to')}`;

  // An ADDED row lists EVERY field it sets, in `RULES` order. Choosing which
  // fields "matter" was the defect — Codex found a missing one twice (routing
  // in R1, stand/needs/power in R2). `RULES` is keyed `Record<keyof T, …>`, so
  // a field added to lib/types.ts is shown here without anyone remembering to.
  const HEAD: Record<OpEntity, string[]> = { stagePlot: ['pos', 'name'], inputs: ['ch', 'inst'], monitors: ['mix', 'name'] };
  const headText: Record<OpEntity, (r: Record<string, unknown>) => string> = {
    stagePlot: (r) => after.get(String(r.id)) ?? `${String(r.pos)} — ${String(r.name)}`,
    inputs: (r) => `ch ${String(r.ch)} ${String(r.inst)}`.trim(),
    monitors: (r) => `Mix ${String(r.mix)}${r.name ? ` (${String(r.name)})` : ''}`,
  };
  const addedText = (entity: OpEntity): string[] =>
    (next[entity] as unknown as Record<string, unknown>[])
      .filter((r) => !prevIds.has(String(r.id)))
      .map((r) => {
        const rest = Object.keys(RULES[entity])
          .filter((f) => f !== 'id' && !HEAD[entity].includes(f) && r[f] !== undefined && r[f] !== '')
          .map((f) => `${fieldLabel(f)} ${show(f, r[f], 'to')}`);
        return rest.length > 0 ? `${headText[entity](r)} — ${rest.join(', ')}` : headText[entity](r);
      });
  const prevIds = new Set([...prev.stagePlot, ...prev.inputs, ...prev.monitors].map((r) => String(r.id)));

  const sections: SummarySection[] = [];
  for (const entity of OP_ENTITIES) {
    const changes = summary[entity];
    const lines: SummaryLine[] = [];
    for (const label of changes.removed) lines.push({ kind: 'remove', text: label });
    for (const text of addedText(entity)) lines.push({ kind: 'add', text });

    const patched = changes.patched
      .map((p) => ({ label: p.label, changes: p.changes.filter((c) => !isAutoCleared(c, p.changes)) }))
      .filter((p) => p.changes.length > 0);
    if (patched.length > SUMMARY_ROW_LIMIT) {
      // Grouped by fields AND destination values, so "type → IEM" and
      // "type → Side-fill" never collapse into one line (Codex R1 on #196).
      const groups = new Map<string, typeof patched>();
      for (const p of patched) {
        const key = p.changes.map((c) => `${fieldLabel(c.field)} → ${show(c.field, c.to, 'to')}`).join('; ');
        groups.set(key, [...(groups.get(key) ?? []), p]);
      }
      for (const [key, rows] of groups) {
        lines.push({
          kind: 'patch',
          text: rows.length === 1 ? `${rows[0].label}: ${rows[0].changes.map(changeText).join('; ')}` : `${rows.length} ${PLURAL[entity]} — ${key}`,
        });
      }
    } else {
      for (const p of patched) lines.push({ kind: 'patch', text: `${p.label}: ${p.changes.map(changeText).join('; ')}` });
    }
    if (entity === 'monitors') {
      for (const j of summary.joins) lines.push({ kind: 'join', text: `Mix ${j.mix} is back, so performers still on it rejoin: ${j.names.join(', ')}` });
    }
    if (lines.length > 0) sections.push({ title: TITLE[entity], lines });
  }
  if (summary.warnings.length > 0) sections.push({ title: 'Ignored', lines: summary.warnings.map((w) => ({ kind: 'warn' as const, text: w })) });
  return sections;
}

/**
 * The one change the card leaves out: a review flag cleared BECAUSE the same
 * row was re-linked (step 2 item 7) — bookkeeping that follows the link line
 * already shown. Any other flag change, including one an op set explicitly,
 * is shown (Codex R1 on #196).
 */
function isAutoCleared(c: FieldChange, rowChanges: readonly FieldChange[]): boolean {
  return c.field === 'needsReview' && c.from === true && c.to === false && rowChanges.some((o) => o.field === 'slotId');
}

/** One sentence for the refused card and for the model's `tool_result` (§5.4, §5.5). */
export function describeProblems(problems: readonly Problem[]): string {
  const msgs = [...new Set(problems.map((p) => p.message))];
  return `This plan was refused because ${msgs.join('; ')}.`;
}

// ── Internals ────────────────────────────────────────────────────────────────

function parseOp(raw: unknown, i: number, problems: Problem[]): Op | null {
  const fail = (message: string) => {
    problems.push({ op: i, message });
    return null;
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(`op ${i + 1} is not an object`);
  const r = raw as Record<string, unknown>;
  if (!(OP_ENTITIES as readonly unknown[]).includes(r.entity)) return fail(`op ${i + 1} has an unknown entity ${JSON.stringify(r.entity)}`);
  if (!(OP_ACTIONS as readonly unknown[]).includes(r.action)) return fail(`op ${i + 1} has an unknown action ${JSON.stringify(r.action)}`);
  const entity = r.entity as OpEntity;
  const action = r.action as OpAction;
  const what = `op ${i + 1} (${action} ${NOUN[entity]})`;

  if (r.values !== undefined && (r.values === null || typeof r.values !== 'object' || Array.isArray(r.values))) {
    return fail(`${what} has values that are not an object`);
  }
  const values = r.values as Record<string, unknown> | undefined;
  if (values) {
    const identity = IDENTITY_KEYS.find((k) => k in values);
    if (identity) return fail(`${what} puts "${identity}" inside values — identity belongs on the op, never in its fields`);
  }

  if (action === 'add') {
    if (r.id !== undefined) return fail(`${what} carries an id — the app assigns ids to new rows`);
    if (!values) return fail(`${what} has no values`);
    if (r.tempId !== undefined && !(typeof r.tempId === 'string' && r.tempId.length > TEMP_PREFIX.length && r.tempId.startsWith(TEMP_PREFIX))) {
      return fail(`${what} has tempId ${JSON.stringify(r.tempId)}, which must start with "${TEMP_PREFIX}"`);
    }
    return { entity, action, tempId: r.tempId as string | undefined, values };
  }

  if (typeof r.id !== 'string' || r.id === '') return fail(`${what} needs the id of the row it changes`);
  if (r.tempId !== undefined) return fail(`${what} carries a tempId — only an add may`);
  if (action === 'remove') {
    if (values !== undefined) return fail(`${what} carries values — a remove names the row and nothing else`);
    return { entity, action, id: r.id };
  }
  if (!values) return fail(`${what} has no values`);
  return { entity, action, id: r.id, values };
}

/** Merge a patch. `null` clears an optional field; on a required one it stays and fails the shape check. */
function mergePatch(row: Row, values: Record<string, unknown>): Row {
  const out: Row = { ...row };
  for (const [k, v] of Object.entries(values)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

function stripNulls(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null));
}

/**
 * Dangling references and duplicate numbers — but only those the PLAN
 * introduced. A slot that was already orphaned, or an input whose link was
 * already dangling (and flagged `needsReview`) before this plan, is the user's
 * existing data: refusing over it would let an unrelated problem block the AI
 * from helping (the same reasoning as §5.3 (d)).
 */
function referenceProblems(prev: ShowLists, next: ShowLists, touched: Record<OpEntity, Map<string, number>>): Problem[] {
  const out: Problem[] = [];
  const prevSlots = new Map(prev.stagePlot.map((s) => [s.id, s]));
  const prevInputs = new Map(prev.inputs.map((r) => [r.id, r]));
  const nextSlotIds = new Set(next.stagePlot.map((s) => s.id));
  const removedMixes = new Set(prev.monitors.map((m) => m.mix).filter((n) => !next.monitors.some((m) => m.mix === n)));

  // stagePlot.mix ≥ 1 must name a monitor after the batch; 0 is "unassigned".
  const dangling = new Map<number, number>();
  for (const s of next.stagePlot) {
    if (!isOrphanedMix(s.mix, next.monitors)) continue;
    const before = prevSlots.get(s.id);
    if (before && before.mix === s.mix && isOrphanedMix(before.mix, prev.monitors)) continue;
    dangling.set(s.mix, (dangling.get(s.mix) ?? 0) + 1);
  }
  for (const [mix, count] of [...dangling].sort((a, b) => a[0] - b[0])) {
    const who = count === 1 ? '1 performer' : `${count} performers`;
    out.push({
      message: removedMixes.has(mix)
        ? `it would leave ${who} pointing at Mix ${mix}, which it removes — move them to another mix in the same plan`
        : `it would put ${who} on Mix ${mix}, which does not exist — add that mix in the same plan`,
    });
  }

  // inputs.slotId must name a slot after the batch.
  const removedSlots = new Map(prev.stagePlot.filter((s) => !nextSlotIds.has(s.id)).map((s) => [s.id, s]));
  const leftBehind = new Map<string, string[]>();
  for (const inp of next.inputs) {
    if (inp.slotId === undefined || nextSlotIds.has(inp.slotId)) continue;
    const before = prevInputs.get(inp.id);
    if (before && before.slotId === inp.slotId && !prevSlots.has(inp.slotId)) continue;
    if (removedSlots.has(inp.slotId)) {
      const list = leftBehind.get(inp.slotId) ?? [];
      list.push(`ch ${inp.ch} ${inp.inst}`.trim());
      leftBehind.set(inp.slotId, list);
    } else {
      out.push({ op: touched.inputs.get(inp.id!), message: `input ch ${inp.ch} links to a stage-plot slot that does not exist` });
    }
  }
  for (const [slotId, chans] of leftBehind) {
    const s = removedSlots.get(slotId)!;
    out.push({
      message: `it removes ${s.name || s.role || 'a performer'} but leaves ${chans.length === 1 ? 'an input' : `${chans.length} inputs`} linked to them (${chans.join(', ')}) — remove or re-link ${chans.length === 1 ? 'it' : 'them'} in the same plan`,
    });
  }

  // A number the plan SETS may not collide with another row's. Only adds can
  // set a mix (a patch to it is refused as a renumber); a patch can move a ch.
  // A legacy duplicate the plan does not touch is left alone (tier1 §3.6).
  const prevMonitorIds = new Set(prev.monitors.map((m) => m.id));
  for (const [id, opIndex] of touched.monitors) {
    if (prevMonitorIds.has(id)) continue;
    const m = next.monitors.find((r) => r.id === id)!;
    if (next.monitors.some((o) => o.id !== id && o.mix === m.mix)) out.push({ op: opIndex, message: `Mix ${m.mix} already exists` });
  }
  for (const [id, opIndex] of touched.inputs) {
    const inp = next.inputs.find((r) => r.id === id)!;
    if (prevInputs.get(id)?.ch === inp.ch) continue;
    if (next.inputs.some((o) => o.id !== id && o.ch === inp.ch)) out.push({ op: opIndex, message: `channel ${inp.ch} is already in use` });
  }
  return out;
}

function describeRow(entity: OpEntity, row: Record<string, unknown>, list: readonly Record<string, unknown>[]): string {
  if (entity === 'stagePlot') {
    const slots = list as unknown as StageSlot[];
    const idx = slots.indexOf(row as unknown as StageSlot);
    const label = slotLabel(row as unknown as StageSlot, idx === -1 ? 0 : blockIndexOf(slots, idx));
    return typeof row.pos === 'string' ? `${row.pos} — ${label}` : label;
  }
  if (entity === 'inputs') return `ch ${row.ch ?? '?'} ${typeof row.inst === 'string' ? row.inst : ''}`.trim();
  return `Mix ${row.mix ?? '?'}${typeof row.name === 'string' && row.name ? ` (${row.name})` : ''}`;
}

function diffEntity(entity: OpEntity, prev: readonly Record<string, unknown>[], next: readonly Record<string, unknown>[]): EntityChanges {
  const prevById = new Map(prev.map((r) => [r.id, r]));
  const nextIds = new Set(next.map((r) => r.id));
  const changes: EntityChanges = { added: [], removed: [], patched: [] };
  for (const r of prev) if (!nextIds.has(r.id)) changes.removed.push(describeRow(entity, r, prev));
  for (const r of next) {
    const before = prevById.get(r.id);
    if (!before) {
      changes.added.push(describeRow(entity, r, next));
      continue;
    }
    const fields = [...new Set([...Object.keys(before), ...Object.keys(r)])].filter((f) => f !== 'id');
    const fieldChanges = fields
      .filter((f) => JSON.stringify(before[f]) !== JSON.stringify(r[f]))
      .map((f) => ({ field: f, from: before[f], to: r[f] }));
    if (fieldChanges.length > 0) changes.patched.push({ label: describeRow(entity, before, prev), changes: fieldChanges });
  }
  return changes;
}

function summarize(prev: ShowLists, next: ShowLists, warnings: string[]): ChangeSummary {
  const prevMonitorIds = new Set(prev.monitors.map((m) => m.id));
  const joins: ChangeSummary['joins'] = [];
  for (const m of next.monitors) {
    if (prevMonitorIds.has(m.id) || !isOrphanedMix(m.mix, prev.monitors)) continue;
    // Performers who were ALREADY on this number before the plan, and still are.
    const names: string[] = [];
    next.stagePlot.forEach((s, idx) => {
      if (s.mix === m.mix && prev.stagePlot.some((p) => p.id === s.id && p.mix === m.mix)) {
        names.push(`${s.pos} — ${slotLabel(s, blockIndexOf(next.stagePlot, idx))}`);
      }
    });
    if (names.length === 0) continue;
    joins.push({ mix: m.mix, names });
  }
  return {
    stagePlot: diffEntity('stagePlot', prev.stagePlot as unknown as Record<string, unknown>[], next.stagePlot as unknown as Record<string, unknown>[]),
    inputs: diffEntity('inputs', prev.inputs as unknown as Record<string, unknown>[], next.inputs as unknown as Record<string, unknown>[]),
    monitors: diffEntity('monitors', prev.monitors as unknown as Record<string, unknown>[], next.monitors as unknown as Record<string, unknown>[]),
    joins: joins.sort((a, b) => a.mix - b.mix),
    warnings,
  };
}
