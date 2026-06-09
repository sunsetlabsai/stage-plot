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
  fileId?: string;        // Drive file ID (for offline cache); for library charts = chart_library.id (the calibration chart_id)
  mimeType?: string;      // original MIME type (for export detection)
  modifiedTime?: string;  // ISO timestamp (for cache invalidation)
}

// ── Chart Calibration (realtime chart control, step 1: sections-only rail) ──
// A SectionAnchor marks a section head ("Intro", "Chorus", rehearsal letter "B")
// on a PDF page. Coords are PDF-relative / normalized 0..1 so they survive zoom,
// rotation, and device size. This is the coarse step-1 anchor tier; bar-level
// System/Bar geometry is step-2 enrichment.
export interface SectionAnchor {
  id: string;
  page: number;   // 1-based page index within the PDF
  x: number;      // normalized 0..1, left→right within the page
  y: number;      // normalized 0..1, top→bottom within the page
  label: string;  // human label; required (non-blank) to verify the calibration
}

// The calibration sidecar payload (the navigation/timeline graph). Step 1 is a
// pure section chain; nav edges + temporal layer are step-2+ enrichment and are
// intentionally absent here. Persisted keyed by (chart_id, source_hash).
//   status: Perform consumes ONLY 'verified' (a matching hash is necessary, not
//   sufficient). 'draft' seeds the editor but never drives the live redline.
export interface ChartCalibration {
  schemaVersion: number;
  status: 'draft' | 'verified';
  sections: SectionAnchor[];
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
