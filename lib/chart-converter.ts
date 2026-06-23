import type {
  Bar,
  ChartCalibration,
  RoadmapMarker,
  SectionAnchor,
  System,
} from './types';
import { CALIBRATION_SCHEMA_VERSION, isValidCalibration } from './chart-calibration';

// ─── Caps (tunable constants — see docs/design-chart-converter.md §Limits) ────
// File-size cap: oversized PDFs skip vision and degrade to manual (`too_large`).
// Page count is NOT pre-parsed server-side (no PDF parser dep in v1); the vision
// API's own PDF page/size limits act as the upstream page guard — an over-limit
// PDF surfaces as a vision error and is mapped to `too_large` by the route.
export const MAX_PDF_BYTES = 15 * 1024 * 1024; // 15 MB

// ─── Magic-byte type sniff ────────────────────────────────────────────────────
// Classify by the leading bytes of the FETCHED object, never the claimed
// MIME/extension (which can be wrong or spoofed). v1 is PDF-only.
export function sniffPdf(bytes: Uint8Array): boolean {
  // "%PDF-" === 0x25 0x50 0x44 0x46 0x2D
  return (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}

// ─── Vision JSON contract (what the model returns) ────────────────────────────
// Geometry is rough by design; bindings are by INDEX (resolved to ids/FKs
// server-side, per the spec). Coordinates are normalized 0..1.
export interface VisionSystem {
  page: number;
  yTop: number;
  yBottom: number;
  xStart: number;
  xEnd: number;
  confidence?: number;
}
export interface VisionBar {
  systemIndex: number; // index into VisionChart.systems
  xStart: number;
  xEnd: number;
  confidence?: number;
}
export interface VisionSection {
  page: number;
  x: number;
  y: number;
  label: string;
  confidence?: number;
}
export interface VisionRoadmapMarker {
  kind: string;
  barIndex?: number; // index into VisionChart.bars
  barIndices?: number[]; // ending bracket bars
  repeatStartBarIndex?: number; // the bar carrying the matching |:
  times?: number;
  numbers?: number[];
  from?: string;
  until?: string;
  confidence?: number;
}
export interface VisionChart {
  systems: VisionSystem[];
  bars: VisionBar[];
  sections: VisionSection[];
  roadmap?: VisionRoadmapMarker[];
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
const isFiniteNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

// Keep a converter confidence only when it's a finite number in [0,1]; otherwise
// omit (absent is always valid, and clears on the first manual edit).
function cleanConfidence(c: unknown): number | undefined {
  return isFiniteNum(c) && c >= 0 && c <= 1 ? c : undefined;
}
function withConfidence<T extends object>(o: T, c: unknown): T {
  const v = cleanConfidence(c);
  return v === undefined ? o : { ...o, confidence: v };
}

const JUMP_FROM = new Set(['capo', 'segno']);
const JUMP_UNTIL = new Set(['end', 'fine', 'coda']);

// Map a raw vision payload to a DRAFT ChartCalibration, or null when there's
// nothing usable. Pure + deterministic so it's unit-testable without the model.
// Structurally-unbindable roadmap markers are DROPPED here (never persisted);
// the result is finally gated by isValidCalibration (the DB-boundary contract).
export function buildCalibrationFromVision(vision: VisionChart): ChartCalibration | null {
  if (!vision || typeof vision !== 'object') return null;
  const rawSystems = Array.isArray(vision.systems) ? vision.systems : [];
  const rawBars = Array.isArray(vision.bars) ? vision.bars : [];
  const rawSections = Array.isArray(vision.sections) ? vision.sections : [];
  const rawRoadmap = Array.isArray(vision.roadmap) ? vision.roadmap : [];

  // ── Systems → reading order (page, yTop, xStart) ────────────────────────────
  interface SysWork {
    modelIndex: number;
    id: string;
    readPos: number;
    page: number;
    yTop: number;
    yBottom: number;
    xStart: number;
    xEnd: number;
    confidence: unknown;
  }
  const sysWork: SysWork[] = [];
  rawSystems.forEach((s, modelIndex) => {
    if (!s || typeof s !== 'object') return;
    if (!Number.isInteger(s.page) || s.page < 1) return;
    if (![s.yTop, s.yBottom, s.xStart, s.xEnd].every(isFiniteNum)) return;
    const yTop = clamp01(s.yTop);
    const yBottom = clamp01(s.yBottom);
    const xStart = clamp01(s.xStart);
    const xEnd = clamp01(s.xEnd);
    if (yBottom <= yTop || xEnd <= xStart) return;
    sysWork.push({
      modelIndex,
      id: '',
      readPos: -1,
      page: s.page,
      yTop,
      yBottom,
      xStart,
      xEnd,
      confidence: s.confidence,
    });
  });
  sysWork.sort((a, b) => a.page - b.page || a.yTop - b.yTop || a.xStart - b.xStart);
  sysWork.forEach((s, k) => {
    s.id = `s${k + 1}`;
    s.readPos = k;
  });
  const sysByModelIndex = new Map(sysWork.map((s) => [s.modelIndex, s]));
  const systems: System[] = sysWork.map((s) =>
    withConfidence(
      {
        id: s.id,
        page: s.page,
        yTop: s.yTop,
        yBottom: s.yBottom,
        xStart: s.xStart,
        xEnd: s.xEnd,
      },
      s.confidence,
    ),
  );

  // ── Bars → assigned to a system, clamped to its bounds, reading order ────────
  interface BarWork {
    modelIndex: number;
    id: string;
    systemId: string;
    readPos: number;
    xStart: number;
    xEnd: number;
    confidence: unknown;
  }
  const barWork: BarWork[] = [];
  rawBars.forEach((b, modelIndex) => {
    if (!b || typeof b !== 'object') return;
    const sys = sysByModelIndex.get(b.systemIndex);
    if (!sys) return;
    if (![b.xStart, b.xEnd].every(isFiniteNum)) return;
    // Clamp to the parent system's x-bounds (validity requires the bar fits).
    const xStart = Math.max(sys.xStart, clamp01(b.xStart));
    const xEnd = Math.min(sys.xEnd, clamp01(b.xEnd));
    if (xEnd <= xStart) return;
    barWork.push({
      modelIndex,
      id: '',
      systemId: sys.id,
      readPos: sys.readPos,
      xStart,
      xEnd,
      confidence: b.confidence,
    });
  });
  barWork.sort((a, b) => a.readPos - b.readPos || a.xStart - b.xStart);
  barWork.forEach((b, k) => {
    b.id = `b${k + 1}`;
  });
  const barIdByModelIndex = new Map(barWork.map((b) => [b.modelIndex, b.id]));
  const bars: Bar[] = barWork.map((b, k) =>
    withConfidence(
      {
        id: b.id,
        systemId: b.systemId,
        xStart: b.xStart,
        xEnd: b.xEnd,
        absNumber: k + 1,
        sectionId: null as string | null,
      },
      b.confidence,
    ),
  );

  // ── Sections ────────────────────────────────────────────────────────────────
  const sections: SectionAnchor[] = [];
  rawSections.forEach((s) => {
    if (!s || typeof s !== 'object') return;
    if (!Number.isInteger(s.page) || s.page < 1) return;
    if (![s.x, s.y].every(isFiniteNum)) return;
    if (typeof s.label !== 'string') return;
    sections.push(
      withConfidence(
        {
          id: `sec${sections.length + 1}`,
          page: s.page,
          x: clamp01(s.x),
          y: clamp01(s.y),
          label: s.label,
        },
        s.confidence,
      ),
    );
  });

  // ── Roadmap (bind by index; drop structurally-unbindable) ───────────────────
  const roadmap: RoadmapMarker[] = [];
  let mid = 0;
  const nextId = () => `m${++mid}`;
  const barId = (idx: number | undefined): string | undefined =>
    idx === undefined ? undefined : barIdByModelIndex.get(idx);

  // Pass 1: repeatStart markers (the bind targets for repeatEnd/ending).
  const repeatStartIdByBarId = new Map<string, string>();
  for (const rm of rawRoadmap) {
    if (!rm || rm.kind !== 'repeatStart') continue;
    const bid = barId(rm.barIndex);
    if (!bid || repeatStartIdByBarId.has(bid)) continue;
    const id = nextId();
    roadmap.push(withConfidence({ id, kind: 'repeatStart', barId: bid, edge: 'start' as const }, rm.confidence));
    repeatStartIdByBarId.set(bid, id);
  }

  // Pass 2: everything else.
  for (const rm of rawRoadmap) {
    if (!rm || typeof rm !== 'object' || rm.kind === 'repeatStart') continue;
    const conf = rm.confidence;
    switch (rm.kind) {
      case 'segno':
      case 'coda': {
        const bid = barId(rm.barIndex);
        if (!bid) break;
        roadmap.push(withConfidence({ id: nextId(), kind: rm.kind, barId: bid, edge: 'start' as const }, conf));
        break;
      }
      case 'toCoda':
      case 'fine': {
        const bid = barId(rm.barIndex);
        if (!bid) break;
        roadmap.push(withConfidence({ id: nextId(), kind: rm.kind, barId: bid, edge: 'end' as const }, conf));
        break;
      }
      case 'repeatEnd': {
        const bid = barId(rm.barIndex);
        const startBid = barId(rm.repeatStartBarIndex);
        const repeatStartId = startBid ? repeatStartIdByBarId.get(startBid) : undefined;
        if (!bid || !repeatStartId) break;
        const m: RoadmapMarker = {
          id: nextId(),
          kind: 'repeatEnd',
          barId: bid,
          edge: 'end',
          repeatStartId,
        };
        if (isFiniteNum(rm.times) && Number.isInteger(rm.times) && rm.times >= 1) m.times = rm.times;
        roadmap.push(withConfidence(m, conf));
        break;
      }
      case 'ending': {
        const startBid = barId(rm.repeatStartBarIndex);
        const repeatStartId = startBid ? repeatStartIdByBarId.get(startBid) : undefined;
        const barIds = Array.isArray(rm.barIndices)
          ? rm.barIndices.map((i) => barId(i)).filter((x): x is string => !!x)
          : [];
        const numbers = Array.isArray(rm.numbers)
          ? rm.numbers.filter((n) => isFiniteNum(n) && Number.isInteger(n) && n >= 1)
          : [];
        if (!repeatStartId || barIds.length === 0 || numbers.length === 0) break;
        roadmap.push(
          withConfidence({ id: nextId(), kind: 'ending', repeatStartId, barIds, numbers }, conf),
        );
        break;
      }
      case 'jump': {
        const bid = barId(rm.barIndex);
        if (!bid || !JUMP_FROM.has(rm.from ?? '') || !JUMP_UNTIL.has(rm.until ?? '')) break;
        roadmap.push(
          withConfidence(
            {
              id: nextId(),
              kind: 'jump',
              barId: bid,
              edge: 'end' as const,
              from: rm.from as 'capo' | 'segno',
              until: rm.until as 'end' | 'fine' | 'coda',
            },
            conf,
          ),
        );
        break;
      }
      default:
        break; // unknown kind → drop
    }
  }

  // Nothing usable extracted → write nothing (degrade to manual rail).
  if (systems.length === 0 && sections.length === 0) return null;

  const calibration: ChartCalibration = {
    schemaVersion: CALIBRATION_SCHEMA_VERSION,
    status: 'draft',
    sections,
    systems,
    bars,
    ...(roadmap.length > 0 ? { roadmap } : {}),
  };

  // Final DB-boundary gate. Any residual contradiction → nothing.
  return isValidCalibration(calibration) ? calibration : null;
}
