import type { SetlistSong, StageSlot, InputChannel, MonitorMix } from './types';

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
