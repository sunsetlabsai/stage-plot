import { stringify, parse } from 'yaml';
import { renumberSetlist } from './setlist';
import type { StageSlot, InputChannel, MonitorMix, GeneralNote, SetlistSong } from './types';

// ─── Internal AppConfig shape (mirrors page.tsx) ─────────────────────────────
// Duplicated here to avoid circular deps; the canonical definition stays in page.tsx.
interface AppConfig {
  showInfo: { bandName: string; eventDate: string; venue: string; showName?: string };
  lineup?: string;
  stagePlot: StageSlot[];
  inputs: InputChannel[];
  monitors: MonitorMix[];
  notes: GeneralNote[];
  setlist: SetlistSong[];
  chartsRootFolderId?: string;
}

// ─── YAML show file schema ───────────────────────────────────────────────────
interface ShowFileV1 {
  format: 'showrunr/v1';
  name: string;
  showName?: string;
  date?: string;
  venue?: string;
  lineup?: string;
  stagePlot: StageSlot[];
  inputs: InputChannel[];
  monitors: MonitorMix[];
  notes: GeneralNote[];
  setlist: Omit<SetlistSong, 'id' | 'position'>[];
  chartsSource?: { provider: string; folderId: string };
}

// ─── Serialize AppConfig → YAML string ───────────────────────────────────────
export function serializeShow(config: AppConfig): string {
  const doc: ShowFileV1 = {
    format: 'showrunr/v1',
    name: config.showInfo.bandName,
    showName: config.showInfo.showName || undefined,
    date: config.showInfo.eventDate || undefined,
    venue: config.showInfo.venue || undefined,
    lineup: config.lineup || undefined,
    stagePlot: config.stagePlot,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    inputs: config.inputs.map(({ id, ...rest }) => rest),
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    monitors: config.monitors.map(({ id, ...rest }) => rest),
    notes: config.notes,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    setlist: config.setlist.map(({ id, position, charts, songId, ...rest }) => {
      return rest as Omit<SetlistSong, 'id' | 'position'>;
    }),
  };

  if (config.chartsRootFolderId) {
    doc.chartsSource = { provider: 'drive', folderId: config.chartsRootFolderId };
  }

  return stringify(doc, { lineWidth: 0 });
}

// ─── Deserialize file content → AppConfig ────────────────────────────────────
// Accepts both YAML (.yaml/.yml) and JSON (.json) based on filename extension.
export function deserializeShow(content: string, filename: string): AppConfig {
  const isYaml = /\.ya?ml$/i.test(filename);

  if (isYaml) {
    return fromYaml(content);
  }
  return fromJson(content);
}

function fromYaml(content: string): AppConfig {
  const parsed = parse(content);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid YAML — could not parse.');
  }

  validate(parsed);
  const doc = parsed as ShowFileV1;

  const config: AppConfig = {
    showInfo: {
      bandName: doc.name,
      eventDate: doc.date ?? '',
      venue: doc.venue ?? '',
      showName: doc.showName?.trim() || undefined,
    },
    lineup: doc.lineup,
    stagePlot: doc.stagePlot,
    inputs: doc.inputs,
    monitors: doc.monitors,
    notes: doc.notes,
    setlist: renumberSetlist(
      doc.setlist.map((s) => ({ ...s, position: 0 }) as SetlistSong)
    ),
  };

  if (doc.chartsSource?.folderId && (!doc.chartsSource.provider || doc.chartsSource.provider === 'drive')) {
    config.chartsRootFolderId = doc.chartsSource.folderId;
  }

  return config;
}

function fromJson(content: string): AppConfig {
  const parsed = JSON.parse(content);

  if (
    !Array.isArray(parsed.stagePlot) ||
    !Array.isArray(parsed.inputs) ||
    !Array.isArray(parsed.setlist) ||
    !Array.isArray(parsed.monitors) ||
    !Array.isArray(parsed.notes) ||
    !parsed.showInfo?.bandName
  ) {
    throw new Error('Invalid show file — missing required sections (stagePlot, inputs, setlist, monitors, notes, showInfo).');
  }

  // Strip songId from imported setlist entries (internal DB UUIDs must not cross owners)
  if (Array.isArray(parsed.setlist)) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    parsed.setlist = parsed.setlist.map(({ songId, ...rest }: { songId?: string; [k: string]: unknown }) => rest);
  }

  return parsed as AppConfig;
}

// ─── Validation for YAML files ───────────────────────────────────────────────
function validate(parsed: unknown): asserts parsed is ShowFileV1 {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid show file — could not parse.');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.format !== undefined && obj.format !== 'showrunr/v1') {
    throw new Error(`Unsupported show file format: "${obj.format}". This version of ShowRunr supports "showrunr/v1".`);
  }
  if (typeof obj.name !== 'string' || !obj.name) {
    throw new Error('Invalid show file — missing "name" field.');
  }
  if (!Array.isArray(obj.stagePlot)) {
    throw new Error('Invalid show file — missing "stagePlot" array.');
  }
  if (!Array.isArray(obj.inputs)) {
    throw new Error('Invalid show file — missing "inputs" array.');
  }
  if (!Array.isArray(obj.setlist)) {
    throw new Error('Invalid show file — missing "setlist" array.');
  }
  if (!Array.isArray(obj.monitors)) {
    throw new Error('Invalid show file — missing "monitors" array.');
  }
  if (!Array.isArray(obj.notes)) {
    throw new Error('Invalid show file — missing "notes" array.');
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'show';
}
