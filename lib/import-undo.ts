import type { StageSlot, InputChannel, MonitorMix, GeneralNote, SetlistSong } from './types';

// The parts of a show these helpers read. Generic over the rest, because the
// page and lib/show-file each declare their own AppConfig.
type ShowShape = {
  stagePlot: StageSlot[];
  inputs: InputChannel[];
  monitors: MonitorMix[];
  notes: GeneralNote[];
  setlist: SetlistSong[];
  showInfo: { eventDate: string; venue: string };
};

/**
 * One-level, in-memory undo for an import (design §7, UAT S7). Two imports arm
 * it. The setlist import (Config → Setlist sheet/CSV) restores only the setlist
 * it replaced. Import Show (Config → Import Show) replaced the WHOLE show, so it
 * restores the whole show. Both share one button and one lifetime: until the
 * next user mutation, a user tab change, or a reload.
 */
export type ImportUndo<C> =
  | { kind: 'setlist'; setlist: SetlistSong[] }
  | { kind: 'show'; config: C };

/** The show after Undo. Pure, so it is safe inside a setState updater. */
export function restoreImportUndo<C extends ShowShape>(prev: C, undo: ImportUndo<C>): C {
  return undo.kind === 'setlist' ? { ...prev, setlist: undo.setlist } : undo.config;
}

/**
 * The confirm before Import Show replaces the show, or null when the show has
 * nothing to lose. Same confirm-with-counts rule as `replaceShowPrompt` (lib/ai-ops): it
 * states what is discarded, and how long undo lasts, because the replace
 * autosaves within seconds.
 *
 * Venue and date count as content (Codex R1 on #198): the replace discards them
 * too. Band and show name do not — New Show fills both from the name typed in
 * the create dialog, so counting them would prompt on every fresh show.
 */
export function importShowPrompt(current: ShowShape, fileName: string): string | null {
  const songs = current.setlist.length;
  const notes = current.notes.length;
  const listsEmpty = current.stagePlot.length === 0 && current.inputs.length === 0 && current.monitors.length === 0;
  const infoEmpty = !current.showInfo.eventDate && !current.showInfo.venue;
  if (listsEmpty && songs === 0 && notes === 0 && infoEmpty) return null;
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  return (
    `Replace this whole show with “${fileName}”?\n\n` +
    `This discards ${n(current.stagePlot.length, 'performer', 'performers')}, ${n(current.inputs.length, 'input', 'inputs')}, ` +
    `${n(current.monitors.length, 'monitor mix', 'monitor mixes')}, ${n(songs, 'song', 'songs')}, ${n(notes, 'note', 'notes')} and the show info.\n\n` +
    'You can undo it until your next edit or tab change.'
  );
}
