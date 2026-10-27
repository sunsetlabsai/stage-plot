import type { SetlistSong, StagePosition, StageSlot, InputChannel, MonitorMix } from './types';

/**
 * Suggested values for `MonitorMix.type`, offered via datalist — NOT a
 * whitelist. Typing anything else is valid and intended; see the field's doc
 * comment in `types.ts`. One definition so the editor and any future consumer
 * cannot drift.
 */
export const MONITOR_TYPES = ['Wedge', 'IEM', 'Side-fill', 'Drum fill', 'None'] as const;

// ── Stage-plot grouping / derivation (multi-occupant blocks) ──────────────

// Group slots by stage position, preserving stable insertion (array) order within
// each block so on-screen + print output is deterministic.
export function groupByPos(slots: StageSlot[]): Map<StagePosition, StageSlot[]> {
  const m = new Map<StagePosition, StageSlot[]>();
  for (const s of slots) {
    const arr = m.get(s.pos);
    if (arr) arr.push(s);
    else m.set(s.pos, [s]);
  }
  return m;
}

// Derived count of input channels linked to a slot (the ×n shared-mix badge;
// derived from slotId, never stored).
export function countLinkedInputs(slotId: string | undefined, inputs: InputChannel[]): number {
  if (!slotId) return 0;
  return inputs.reduce((n, i) => (i.slotId === slotId ? n + 1 : n), 0);
}

// Slot-owned display label: a blank name falls back to "Occupant {n}" (n = 1-based
// index within its block), identical on every surface that shows this slot.
export function slotLabel(slot: StageSlot, indexInBlock: number): string {
  return slot.name?.trim() || `Occupant ${indexInBlock + 1}`;
}

// Index of slots[idx] among the occupants of its own block (same pos), in array
// order — the n for the "Occupant {n}" fallback label.
export function blockIndexOf(slots: StageSlot[], idx: number): number {
  const pos = slots[idx]?.pos;
  let n = 0;
  for (let i = 0; i < idx; i++) if (slots[i].pos === pos) n++;
  return n;
}

// Build the Position-dropdown option list for the input list: one entry per slot
// that has an id, labeled "TLA — <slot label>" (the slot-owned label, so a blank
// name reads "Occupant {n}" everywhere). Grouped by block in stable array order.
export function slotOptionsForInputs(slots: StageSlot[]): { id: string; label: string }[] {
  const opts: { id: string; label: string }[] = [];
  for (const [pos, arr] of groupByPos(slots)) {
    arr.forEach((s, i) => {
      if (s.id) opts.push({ id: s.id, label: `${pos} — ${slotLabel(s, i)}` });
    });
  }
  return opts;
}

export function ensureSetlistSongIds(setlist: SetlistSong[]): SetlistSong[] {
  return setlist.map((s) =>
    s.id ? s : { ...s, id: crypto.randomUUID() }
  );
}

export function moveSetlistSong(setlist: SetlistSong[], from: number, to: number): SetlistSong[] {
  if (from === to || from < 0 || to < 0 || from >= setlist.length || to >= setlist.length) {
    return setlist;
  }
  const arr = [...setlist];
  const [moved] = arr.splice(from, 1);
  arr.splice(to, 0, moved);
  return renumberSetlist(arr);
}

export function renumberSetlist(setlist: SetlistSong[]): SetlistSong[] {
  return setlist.map((s, i) => (s.position === i + 1 ? s : { ...s, position: i + 1 }));
}

// ── Stage slot id lifecycle (the linkage hub) ─────────────────────────────

/**
 * Idempotent load-time normalizer for the StageSlot.id hub identity.
 *
 * - Mints `id = crypto.randomUUID()` for any slot missing one.
 * - De-dupes: if two slots share an `id` (import, copy-paste, hand-edited JSON,
 *   AI dup), the first occurrence keeps the id and the collision(s) are re-minted.
 * - Any `InputChannel.slotId` equal to a de-duped (shared) id is **ambiguous** —
 *   it could have meant the original or the re-minted copy — so its `slotId` is
 *   cleared and `needsReview` is set. These are returned in `ambiguousInputs`
 *   to drive the session relink prompt.
 * - Any `InputChannel.slotId` matching no slot (dangling import / deleted slot)
 *   keeps its `slotId` but gets `needsReview: true` (the relink badge resolves it).
 *
 * Returns `{ config, dirty, ambiguousInputs }`. `dirty` is true whenever anything
 * was minted, de-duped, cleared, or flagged — the load path force-saves on dirty
 * (a new config object) to close the lazy-mint persistence race.
 */
export function ensureStageSlotIds<
  C extends { stagePlot: StageSlot[]; inputs: InputChannel[] }
>(config: C): { config: C; dirty: boolean; ambiguousInputs: InputChannel[] } {
  let dirty = false;

  const seen = new Set<string>();
  const collisionValues = new Set<string>(); // shared id values that triggered a re-mint
  const newSlots = config.stagePlot.map((slot) => {
    if (!slot.id) {
      dirty = true;
      return { ...slot, id: crypto.randomUUID() };
    }
    if (seen.has(slot.id)) {
      collisionValues.add(slot.id);
      dirty = true;
      return { ...slot, id: crypto.randomUUID() };
    }
    seen.add(slot.id);
    return slot;
  });

  const validIds = new Set(newSlots.map((s) => s.id!));

  const ambiguousInputs: InputChannel[] = [];
  const newInputs = config.inputs.map((inp) => {
    if (!inp.slotId) return inp;
    if (collisionValues.has(inp.slotId)) {
      dirty = true;
      const cleared: InputChannel = { ...inp, slotId: undefined, needsReview: true };
      ambiguousInputs.push(cleared);
      return cleared;
    }
    if (!validIds.has(inp.slotId)) {
      if (inp.needsReview) return inp;
      dirty = true;
      return { ...inp, needsReview: true };
    }
    return inp;
  });

  return {
    config: dirty ? { ...config, stagePlot: newSlots, inputs: newInputs } : config,
    dirty,
    ambiguousInputs,
  };
}

// ── Input channel reorder ─────────────────────────────────────────────────

export function ensureInputIds(inputs: InputChannel[]): InputChannel[] {
  return inputs.map((inp) =>
    inp.id ? inp : { ...inp, id: crypto.randomUUID() }
  );
}

export function moveInput(inputs: InputChannel[], from: number, to: number): InputChannel[] {
  if (from === to || from < 0 || to < 0 || from >= inputs.length || to >= inputs.length) {
    return inputs;
  }
  const arr = [...inputs];
  const [moved] = arr.splice(from, 1);
  arr.splice(to, 0, moved);
  return arr.map((inp, i) => (inp.ch === i + 1 ? inp : { ...inp, ch: i + 1 }));
}

// ── Monitor mix identity (design-core-path-tier1 §3) ──────────────────────
//
// A mix number IS an aux number — "Mix 3" is aux 3, like a console. Slots point
// at it by value (`StageSlot.mix`), so it is a routing identity: it changes only
// through `renumberMix`, which moves the pointers with it. There is deliberately
// no reorder — `moveMonitor` rewrote `mix = i + 1` and left every slot pointing
// at someone else's wedge (B3). Contrast `moveInput` above: nothing references
// `ch` (input links are by `slotId`), which is why input reorder is safe.
//
// `StageSlot.mix === 0` is the "no monitor" sentinel and is never an orphan;
// `MonitorMix.mix` itself is always ≥ 1 (design-ai-op-contract §5 (c)).

export function ensureMonitorIds(monitors: MonitorMix[]): MonitorMix[] {
  return monitors.map((mon) =>
    mon.id ? mon : { ...mon, id: crypto.randomUUID() }
  );
}

function isMixNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0;
}

/**
 * Unique positive-integer mix numbers, or the reason they are not. Sparse
 * numbering (`[1, 2, 5]`) is valid — a gap is an unpatched aux, not an error.
 */
export function validateMonitors(monitors: readonly { mix?: unknown }[]): string | null {
  const seen = new Set<number>();
  for (const m of monitors) {
    if (!isMixNumber(m.mix)) return `mix number ${String(m.mix)} is not a positive whole number`;
    if (seen.has(m.mix)) return `mix ${m.mix} appears more than once`;
    seen.add(m.mix);
  }
  return null;
}

/**
 * Validity of an AI `update_monitors` full replace against the current list.
 * On top of `validateMonitors`: a row that comes back carrying an existing
 * monitor's id under a DIFFERENT number is a renumber, and is refused. The
 * model sees ids in `currentConfig`, so a swap of Mix 1 and Mix 2 that kept
 * both ids would otherwise pass. Slots would stay on their old numbers, and
 * both numbers still exist, so nothing would be flagged (Codex R1 on #193).
 * Refused rather than remapped because a renumber moves performers and §3.3
 * makes that confirm-worthy, naming who moves. An Apply card has no such
 * prompt, and the Monitor Mixes table does.
 */
export function validateMonitorReplace(
  current: readonly MonitorMix[],
  incoming: readonly { id?: unknown; mix?: unknown; [field: string]: unknown }[],
): string | null {
  const invalid = validateMonitors(incoming);
  if (invalid) return invalid;
  for (const row of incoming) {
    const was = current.find((m) => m.id !== undefined && m.id === row.id);
    if (was && was.mix !== row.mix) {
      return `it changes Mix ${was.mix} to Mix ${String(row.mix)} — renumber a mix in the Monitor Mixes table, which moves its performers with it`;
    }
  }
  return null;
}

/** Add a blank mix, numbered by `nextMixNumber`. */
export function addMonitor<T extends { stagePlot: StageSlot[]; monitors: MonitorMix[] }>(config: T): T {
  return {
    ...config,
    monitors: [...config.monitors, { id: crypto.randomUUID(), mix: nextMixNumber(config.monitors, config.stagePlot), name: '', needs: '' }],
  };
}

/**
 * Delete one mix by id. Delete orphans and does not cascade (§3.4). The
 * surviving numbers do not move and no slot is touched, so performers on the
 * removed mix keep its number and are flagged by `isOrphanedMix`.
 */
export function deleteMonitor<T extends { monitors: MonitorMix[] }>(config: T, id: string): T {
  return { ...config, monitors: config.monitors.filter((m) => m.id !== id) };
}

/**
 * The number a new mix gets: one past the highest, so sparse numbering never
 * collides. "Highest" includes ORPHANED slot mixes — seeding a blank mix onto a
 * removed number would silently re-attach the performers still pointing at it.
 */
export function nextMixNumber(monitors: readonly MonitorMix[], stagePlot: readonly StageSlot[] = []): number {
  const highest = Math.max(0, ...monitors.map((m) => m.mix), ...stagePlot.map((s) => s.mix));
  return highest + 1;
}

/** Monitor rows in aux order — the only order a mix list has now that it cannot be dragged. */
export function sortMonitorsByMix(monitors: readonly MonitorMix[]): MonitorMix[] {
  return [...monitors].sort((a, b) => a.mix - b.mix);
}

/** A slot pointing at a mix the monitor list does not have (after a delete, or a hand-edited import). */
export function isOrphanedMix(mix: number, monitors: readonly MonitorMix[]): boolean {
  return mix > 0 && !monitors.some((m) => m.mix === mix);
}

/**
 * Who is routed to `mix` — what a renumber moves and a delete orphans — labeled
 * "TLA — <slot label>" as in the input list's Position dropdown, so a prompt
 * names performers the same way every other surface does.
 */
export function performersOnMix(stagePlot: StageSlot[], mix: number): string[] {
  if (mix <= 0) return [];
  const out: string[] = [];
  stagePlot.forEach((s, idx) => {
    if (s.mix === mix) out.push(`${s.pos} — ${slotLabel(s, blockIndexOf(stagePlot, idx))}`);
  });
  return out;
}

const bullets = (names: string[]) => names.map((n) => `  • ${n}`).join('\n');

/**
 * The confirm text for renumbering `from` → `to`, or null when nobody is
 * affected and no prompt is needed. Call only after `renumberMix` accepted the
 * move: `to` is then not a live mix, so anyone already on it is an orphan of a
 * removed Mix `to` — and joins this one. Both groups are named.
 */
export function renumberMixPrompt(stagePlot: StageSlot[], from: number, to: number): string | null {
  const moving = performersOnMix(stagePlot, from);
  const joining = performersOnMix(stagePlot, to);
  if (moving.length === 0 && joining.length === 0) return null;
  let msg = `Renumber Mix ${from} to Mix ${to}?`;
  if (moving.length > 0) {
    msg += `\n\n${moving.length === 1 ? 'This performer moves' : `These ${moving.length} performers move`} with it:\n${bullets(moving)}`;
  }
  if (joining.length > 0) {
    msg += `\n\nStill pointing at the removed Mix ${to}, so they join this mix:\n${bullets(joining)}`;
  }
  return msg;
}

/**
 * The confirm text for deleting Mix `mix`, or null when nobody is on it.
 * Delete orphans rather than cascades (§3.4), so the prompt says who will be
 * left flagged — mirroring the slot-delete prompt.
 */
export function deleteMixPrompt(stagePlot: StageSlot[], mix: number): string | null {
  const affected = performersOnMix(stagePlot, mix);
  if (affected.length === 0) return null;
  return (
    `${affected.length === 1 ? '1 performer is' : `${affected.length} performers are`} on Mix ${mix}:\n` +
    `${bullets(affected)}\n\nOK: delete the mix (they'll be flagged to reassign).\nCancel: keep it.`
  );
}

export type RenumberMixResult<T> = { ok: true; config: T } | { ok: false; reason: string };

/**
 * The one deliberate path that changes a mix number. Moves the monitor row
 * AND every slot on it, in one step, so no reference is rewritten underneath
 * the thing pointing at it (I6). Rejects — mutating nothing — when `to` is not
 * a positive whole number or is already another live mix.
 */
export function renumberMix<T extends { stagePlot: StageSlot[]; monitors: MonitorMix[] }>(
  config: T,
  from: number,
  to: number,
): RenumberMixResult<T> {
  if (!config.monitors.some((m) => m.mix === from)) return { ok: false, reason: `there is no mix ${from}` };
  if (!isMixNumber(to)) return { ok: false, reason: 'a mix number must be a positive whole number' };
  if (to === from) return { ok: true, config };
  if (config.monitors.some((m) => m.mix === to)) return { ok: false, reason: `mix ${to} already exists` };
  return {
    ok: true,
    config: {
      ...config,
      monitors: config.monitors.map((m) => (m.mix === from ? { ...m, mix: to } : m)),
      stagePlot: config.stagePlot.map((s) => (s.mix === from ? { ...s, mix: to } : s)),
    },
  };
}

// ── Setlist title ownership (design-core-path-tier1 §1.3) ─────────────────

/**
 * Is this row's title editable in the setlist table?
 *
 * **Only when the row has no `songId`.** A library-linked row's title is owned by
 * the `songs` table: `PUT /api/shows/update` rebuilds `config.setlist` on every
 * save and writes `title: song.title` back over whatever the client sent, so an
 * edit here silently reverted on the next load — with a green "Saved" in the
 * meantime. Offering an unsavable field as editable is the defect; renames belong
 * in `/library`, which already cascades to `chart_library.song_key`.
 *
 * A row WITHOUT a `songId` is the opposite case and must stay editable: the
 * server resolves (or auto-creates) that row BY its title, so a blanket
 * read-only would break CSV/sheet import and the agent's `update_setlist`.
 *
 * A predicate rather than an inline ternary because that asymmetry is the whole
 * of §1.3's correctness, and nothing inside a 6700-line client component can be
 * exercised by a test in this repo.
 */
export function isTitleEditableInSetlist(song: Pick<SetlistSong, 'songId'>): boolean {
  return !song.songId;
}

// ── Whole-config id normalization ─────────────────────────────────────────

/** True when `next` contains any element the source array did not. */
function anyRowReplaced<T>(next: readonly T[], prev: readonly T[]): boolean {
  return next.length !== prev.length || next.some((row, i) => row !== prev[i]);
}

/**
 * Re-mint any id already seen earlier in the same array. Ref-stable when clean.
 *
 * Presence is the `ensure*Ids` helpers' job; this handles only COLLISIONS, which
 * they do not: each keeps an existing id verbatim, duplicate or not.
 *
 * **Safe to re-mint without a cascade for setlist/inputs/monitors specifically,
 * and that is a checked property rather than an assumption:** nothing references
 * those ids as a foreign key. The only cross-entity link is
 * `InputChannel.slotId → StageSlot.id`, which is why slot de-duping lives in
 * `ensureStageSlotIds` — it must also clear the referring `slotId`. Do not reuse
 * this helper for slots.
 */
function dedupeIds<T extends { id?: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  let dirty = false;
  const out = rows.map((row) => {
    if (!row.id) return row;
    if (seen.has(row.id)) {
      dirty = true;
      return { ...row, id: crypto.randomUUID() };
    }
    seen.add(row.id);
    return row;
  });
  return dirty ? out : rows;
}

/**
 * Mint AND de-dupe ids across EVERY entity, and repair or flag broken links.
 *
 * > ★ Codex R1 medium, folded. The first version said "mint/de-dupe across every
 * > entity" while only STAGE SLOTS were actually de-duped — `ensureSetlistSongIds`,
 * > `ensureInputIds` and `ensureMonitorIds` each keep an existing id verbatim,
 * > duplicate or not. A duplicate id breaks React keys and drag identity exactly
 * > as a missing one does, so the comment promised a guarantee the code did not
 * > give. Rather than narrow the contract, `dedupeIds` now makes it true: the
 * > re-mint is safe for those three because nothing references their ids as a
 * > foreign key (checked, not assumed — only `slotId → StageSlot.id` exists).
 *
 * **Ordering is load-bearing and must not be rearranged.** `ensureStageSlotIds`
 * runs FIRST: it may clear a `slotId` whose target id COLLIDED (setting
 * `needsReview`), and input id-minting must run on top of that cleared state.
 * Reversed, an input would be normalized against a link about to be
 * invalidated. Note the two cases differ — a **collision** clears the `slotId`,
 * a merely **dangling** one keeps the value and only sets `needsReview`, so the
 * original can still be repaired.
 *
 * **Ref-stable when nothing was minted**, which is what makes it safe at a
 * per-keystroke chokepoint: it returns the original object, so a no-op update
 * cannot force a re-render or a save.
 *
 * > ★ That stability had to be BUILT, not assumed. `ensureSetlistSongIds`,
 * > `ensureInputIds` and `ensureMonitorIds` are all `arr.map(...)`, which
 * > allocates a new array **unconditionally** — so a plain `!==` on the result
 * > is always true and this function always returned a fresh config. Harmless
 * > while it only ran on load; not harmless at a mutation chokepoint that fires
 * > on every keystroke. Hence `anyRowReplaced`, which compares element
 * > identity instead of array identity.
 *
 * Generic rather than typed to `AppConfig` because `AppConfig` is declared in
 * the page component; this mirrors `ensureStageSlotIds`'s own signature.
 *
 * Lives here rather than in the page component so it is testable at all — the
 * bug it fixes was a WIRING bug (the wrong normalizer at the mutation site),
 * and nothing inside a 6,700-line client component can be exercised by a test
 * in this repo. `planChanges` (design-ai-op-contract §5) will call it too.
 */
export function withStableIds<
  C extends {
    stagePlot: StageSlot[];
    inputs: InputChannel[];
    monitors: MonitorMix[];
    setlist: SetlistSong[];
  },
>(config: C): C {
  const { config: linked } = ensureStageSlotIds(config);
  // ensure*Ids guarantees PRESENCE; dedupeIds guarantees UNIQUENESS. Slots need
  // neither wrapper — ensureStageSlotIds already does both, plus the slotId
  // cascade a slot re-mint requires.
  const setlist = dedupeIds(ensureSetlistSongIds(linked.setlist));
  const inputs = dedupeIds(ensureInputIds(linked.inputs));
  const monitors = dedupeIds(ensureMonitorIds(linked.monitors));
  const changed =
    linked !== config ||
    anyRowReplaced(setlist, linked.setlist) ||
    anyRowReplaced(inputs, linked.inputs) ||
    anyRowReplaced(monitors, linked.monitors);
  return changed ? { ...linked, setlist, inputs, monitors } : config;
}
