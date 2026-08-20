import type { SetlistSong, StagePosition, StageSlot, InputChannel, MonitorMix } from './types';

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

// ── Monitor mix reorder ───────────────────────────────────────────────────

export function ensureMonitorIds(monitors: MonitorMix[]): MonitorMix[] {
  return monitors.map((mon) =>
    mon.id ? mon : { ...mon, id: crypto.randomUUID() }
  );
}

export function moveMonitor(monitors: MonitorMix[], from: number, to: number): MonitorMix[] {
  if (from === to || from < 0 || to < 0 || from >= monitors.length || to >= monitors.length) {
    return monitors;
  }
  const arr = [...monitors];
  const [moved] = arr.splice(from, 1);
  arr.splice(to, 0, moved);
  return arr.map((mon, i) => (mon.mix === i + 1 ? mon : { ...mon, mix: i + 1 }));
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
 * Mint/de-dupe ids across EVERY entity, and repair or flag broken links.
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
  const setlist = ensureSetlistSongIds(linked.setlist);
  const inputs = ensureInputIds(linked.inputs);
  const monitors = ensureMonitorIds(linked.monitors);
  const changed =
    linked !== config ||
    anyRowReplaced(setlist, linked.setlist) ||
    anyRowReplaced(inputs, linked.inputs) ||
    anyRowReplaced(monitors, linked.monitors);
  return changed ? { ...linked, setlist, inputs, monitors } : config;
}
