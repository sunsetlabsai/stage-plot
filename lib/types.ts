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
  // ── Re-key (Option A: live-relabel) ──
  // A builder (Nashville) chart's body is key-invariant degree numbers; only the
  // key LABEL follows the song. The baked PDF no longer prints "Key:" — the live
  // key is resolved into the viewer chrome from the setlist (song.key), falling
  // back to authored_key when there is no song context (standalone library view).
  is_builder?: boolean;       // source_spec present = authored in the builder
  authored_key?: string | null; // the spec's renderKey (informational; not the live key)
  charted_key?: string | null;  // reserved for import-time key capture (null for now)
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
  confidence?: number; // 0..1; populated by the auto-converter, cleared on manual edit
}

// ── Step-2 enrichment: bar-level geometry ────────────────────────────────────
// A System is a horizontal band on a PDF page containing one or more bars (a
// "staff system" or "chord chart line"). Coords are PDF-relative / normalized
// 0..1 so they survive zoom, rotation, and device size.
export interface System {
  id: string;
  page: number;     // 1-based
  yTop: number;     // normalized 0..1 (top edge of the system band)
  yBottom: number;  // normalized 0..1 (bottom edge; yBottom > yTop)
  xStart: number;   // normalized 0..1 (left edge)
  xEnd: number;     // normalized 0..1 (right edge; xEnd > xStart)
  confidence?: number; // 0..1; populated by the auto-converter, cleared on manual edit
}

// A Bar is a barline-delimited region within a System. absNumber is the global
// bar number in reading order (page→yTop→xStart across systems, then xStart
// within each system). sectionId links to a SectionAnchor when assigned.
export interface Bar {
  id: string;
  systemId: string;       // FK to System.id
  xStart: number;         // normalized 0..1 within the page
  xEnd: number;           // normalized 0..1 within the page (xEnd > xStart)
  absNumber: number;      // 1-based global bar number in reading order
  sectionId: string | null; // FK to SectionAnchor.id; null until assignment
  confidence?: number;    // 0..1; populated by the auto-converter, cleared on manual edit
}

// A position reference — used by nav/temporal layers so they never assume bar
// geometry. Coarse (sectionId string) for step-1; fine (barId + pass) for step-2+.
export type PositionRef =
  | string                              // sectionId (coarse, step-1 rail)
  | { barId: string; pass: number };    // bar-level (fine, step-2+)

// ── Roadmap markers (nav graph: repeats, endings, D.S./D.C./Coda/Fine) ───────
// We persist the printed symbols (the "roadmap"), not a pre-expanded timeline.
// A pure resolver (resolveRoadmap) derives the played traversal from these, so
// the model matches the page 1:1 and a converter can later detect glyphs →
// markers. Each marker attaches to a bar EDGE (start | end) of a referenced bar.
// `confidence` is converter forward-compat (no future schema bump).
interface RoadmapMarkerBase {
  id: string;
  confidence?: number; // 0..1; populated by the auto-converter later
}

export type RoadmapMarker =
  // |:  — return target for repeats AND voltas.
  | (RoadmapMarkerBase & { kind: 'repeatStart'; barId: string; edge: 'start' })
  // :|  PLAIN repeat (no voltas). times = total passes (default 2). Binds to its |:.
  | (RoadmapMarkerBase & { kind: 'repeatEnd'; barId: string; edge: 'end'; repeatStartId: string; times?: number })
  // volta bracket bound to its |:; barIds = the bracket's (contiguous) bars; numbers = e.g. [1] or [2,3].
  | (RoadmapMarkerBase & { kind: 'ending'; repeatStartId: string; barIds: string[]; numbers: number[] })
  // 𝄋 Segno target.
  | (RoadmapMarkerBase & { kind: 'segno'; barId: string; edge: 'start' })
  // ⊕ Coda jump-to target.
  | (RoadmapMarkerBase & { kind: 'coda'; barId: string; edge: 'start' })
  // "To Coda" departure.
  | (RoadmapMarkerBase & { kind: 'toCoda'; barId: string; edge: 'end' })
  // end point for al Fine.
  | (RoadmapMarkerBase & { kind: 'fine'; barId: string; edge: 'end' })
  // D.C. (from:'capo') vs D.S. (from:'segno'); until encodes plain | al Fine | al Coda.
  | (RoadmapMarkerBase & {
      kind: 'jump';
      barId: string;
      edge: 'end';
      from: 'capo' | 'segno';
      until: 'end' | 'fine' | 'coda';
    });

// The calibration sidecar payload (the navigation/timeline graph). Persisted
// keyed by (chart_id, source_hash). Step 1 = section chain; step 2 adds
// system/bar geometry. Nav edges + temporal layer are later enrichment.
//   status: Perform consumes ONLY 'verified' (a matching hash is necessary, not
//   sufficient). 'draft' seeds the editor but never drives the live redline.
export interface ChartCalibration {
  schemaVersion: number;
  status: 'draft' | 'verified';
  sections: SectionAnchor[];
  systems?: System[];   // step-2+ enrichment; absent in v1 payloads
  bars?: Bar[];         // step-2+ enrichment; absent in v1 payloads
  roadmap?: RoadmapMarker[]; // v3 nav graph; absent ⇒ linear playback (back-compat)
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
  artist: string;       // song-level credit; printed on built charts
  key: string | null;
  lead: string;
  notes: string;
  bpm: number | null;   // stated tempo (chunk-5b clock's static-BPM rung); null ⇒ no stated tempo
  created_at: string;
  updated_at: string;
  chart_count?: number;
  show_count?: number;
  charts?: Chart[];       // owner's library charts for this song (from GET /api/songs)
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
