export type StagePosition =
  | 'USR' | 'USC' | 'USL'   // Upstage
  | 'MSR' | 'MSC' | 'MSL'   // Mid-stage
  | 'DSR' | 'DSC' | 'DSL'   // Downstage
  | 'PIT'                    // Orchestra pit
  | 'FOH'                    // Front of house (engineer position)
  | 'OTHER';                 // Catch-all for non-standard positions

export interface StageSlot {
  id?: string;         // stable hub identity for input↔slot linkage; guaranteed at runtime by ensureStageSlotIds
  name: string;
  pos: StagePosition;
  role: string;
  mix: number;
  power?: boolean;
  featured?: boolean; // highlights the slot (e.g. lead vox)
}

export interface InputChannel {
  id?: string;
  ch: number;
  inst: string;
  mic: string;
  stand: string;
  notes?: string;
  slotId?: string;     // links this channel to a StageSlot.id (the linkage); absent ⇒ unassigned
  needsReview?: boolean; // needs-attention/relink flag (orphaned or ambiguous link); absent ⇒ false
}

export interface MonitorMix {
  id?: string;
  mix: number;
  name: string;
  needs: string;
}

export interface GeneralNote {
  label: string;
  text: string;
}

export interface Chart {
  role: string;           // folder name = role ("Lyrics", "Guitar", free text)
  url: string;            // any URL
  label?: string;         // optional e.g. "Bb transposition", "Chorus Only"
  dupeCount?: number;     // >1 = flag for review
  fileId?: string;        // Drive file ID (for offline cache)
  mimeType?: string;      // original MIME type (for export detection)
  modifiedTime?: string;  // ISO timestamp (for cache invalidation)
}

export interface SetlistSong {
  id?: string;              // stable identity for DnD + navigator; guaranteed at runtime
  songId?: string;          // canonical song ID from songs table (round-trips for save)
  position: number;
  title: string;
  key?: string;           // musical key — e.g. "Eb", "Am", "F#m"
  lead: string;           // singer name(s) — e.g. "Rachel" or "Graham + Rachel"
  notes?: string;         // e.g. "key change", "guest", "spoken word"
  sceneNote?: string;     // engineer cue — e.g. "save scene after"
  charts?: Chart[];       // matched charts from Google Drive
}

export interface Song {
  id: string;
  owner_id: string;
  song_key: string;
  title: string;
  key: string | null;
  lead: string;
  notes: string;
  created_at: string;
  updated_at: string;
  chart_count?: number;
  show_count?: number;
}

export interface BandConfig {
  slug: string;           // used in ?band= URL param
  name: string;           // band name shown in header
  lineup: string;         // e.g. "7-Piece Band"
  stagePlot: StageSlot[];
  inputs: InputChannel[];
  monitors: MonitorMix[];
  notes: GeneralNote[];
  setlist?: SetlistSong[]; // optional — omit if not needed
}
