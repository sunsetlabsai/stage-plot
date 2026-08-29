'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { ReactNode, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { LogoMark } from '@/components/Logo';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  DragOverlay,
} from '@dnd-kit/core';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type {
  BandConfig,
  StagePosition,
  StageSlot,
  InputChannel,
  MonitorMix,
  SetlistSong,
  GeneralNote,
  Chart,
  ChartCalibration,
  SectionAnchor,
  System,
  Bar,
  RoadmapMarker,
} from '@/lib/types';
import { moveSetlistSong, moveInput, moveMonitor, groupByPos, countLinkedInputs, slotLabel, slotOptionsForInputs, blockIndexOf, isTitleEditableInSetlist, withStableIds, MONITOR_TYPES } from '@/lib/setlist';
import type { ImportedRow } from '@/lib/setlist-import';
import { mergeSetlist } from '@/lib/setlist-import';
import SetlistImportPreview from '@/components/SetlistImportPreview';
import { AgentAvailabilityPanel } from '@/components/AgentAvailabilityPanel';
import { ByoaKeySettings } from '@/components/ByoaKeySettings';
import { SettingsOverlay } from '@/components/SettingsOverlay';
import { resolveAvailability, canSendMessage, effectiveProbe, probeCapabilities, type FetchedProbe } from '@/lib/agent-availability';
import { rememberPrompt } from '@/lib/prompt-cache';
import { visibleTab, type ShowTab } from '@/lib/show-tabs';
import { shouldRestoreComposer, rollbackOptimisticSend, rejectedKeySource, type KeyRejectSource } from '@/lib/send-recovery';
import { newStreamState, splitSseData, parseSseEvent, reduceStreamEvent, finalizeTurn, arrivedFrom } from '@/lib/agent-stream';
import { buildApiMessages, hasPendingTools as transcriptHasPendingTools } from '@/lib/agent-history';
// No BYOA_KEY here any more: the page no longer touches either store directly,
// so the storage-key name is now entirely `lib/byoa-key-storage`'s business.
// (#133 centralized the literal; this removes the last caller that needed it.)
// `readKey` seeds the device key at mount; `persistKey` is the single storage clear
// on the recovery path. Everything else about storage is `ByoaKeySettings`'s job now
// (chunk 4) — the overlay is the sole writer, so `initialRemember`/the persist effect
// that used to live here are gone.
import { readKey, persistKey } from '@/lib/byoa-key-storage';
import { serializeShow, deserializeShow, slugify } from '@/lib/show-file';
import { exportPatchCsv, exportPatchXml } from '@/lib/console-export';
import {
  chartCacheKey,
  downloadAllCharts,
  getCacheStats,
  clearChartCache,
  registerServiceWorker,
  formatBytes,
  type DownloadProgress,
} from '@/lib/chart-cache';
import { loadPdfDoc, renderPage, renderPageOffscreen, destroyAllDocs, prefetchChart, fetchChartBytes } from '@/lib/pdf-viewer';
import { isUnsupportedChartMime } from '@/lib/chart-converter';
import { parseChartDeepLink, buildChartShareUrl, buildShowShareUrl, chartShareFilename } from '@/lib/share';
import ShareButton from '@/components/ShareButton';
import ManageChartsModal from '@/components/ManageChartsModal';
import TapTempo from '@/components/TapTempo';
import { createBpmWriter, type BpmWriter } from '@/lib/bpm-writer';
import { updateSetlistCharts } from '@/lib/chart-management';
import {
  emptyCalibration,
  addSection,
  removeSection,
  relabelSection,
  sectionsForPage,
  canVerify,
  verify,
  isPerformable,
  tapToBar,
  findSystem,
  performDisplayPage,
  barsInOrder,
  resolveRoadmap,
  enclosingRepeatStartId,
  addRoadmapMarker,
  removeRoadmapMarker,
  summarizeTraversal,
  addSystem,
  removeSystem,
  resizeSystemBand,
  moveBarBoundary,
  autoDistributeBars,
  addBarline,
  removeBarline,
  systemsForPage,
  performReadinessView,
} from '@/lib/chart-calibration';
import type { TraversalStep } from '@/lib/chart-calibration';
import PerformReadinessStrip, { type CalTool } from '@/components/PerformReadinessStrip';
import {
  detectBarlines,
  snapBarsToLines,
  DARK_LUMA,
  SNAP_RENDER_SCALE,
  STAFF_ROW_FRAC,
  type BandProfile,
  type SnapBarsResult,
} from '@/lib/chart-snap';
import { reviewFlags } from '@/lib/chart-review';
import type { FlaggedRef } from '@/lib/chart-review';
import { useConductorSession } from '@/lib/use-conductor-session';
import ConductorCluster, { type ClusterRelayState } from '@/components/ConductorCluster';
import RelayStrip from '@/components/RelayStrip';
import RelayQrOverlay, { RelayConnectingOverlay } from '@/components/RelayQrOverlay';
import {
  buildJoinUrl,
  findChartForSongRef,
  isRoomCodeShaped,
  loadDeviceLabel,
  normalizeRoomCode,
  saveDeviceLabel,
} from '@/lib/relay-join';
import { useShow } from '@/lib/use-show';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { normalizeSongKeySafe, displayRole } from '@/lib/normalize';
import type { ChartRole } from '@/lib/normalize';

// ─── Default band (imported at build time, used as fallback) ────────────────
import { getBand } from '@/lib/bands';
const fallbackBand = getBand();

// Pass ordinal for the Perform transport readout ("2nd", "3rd" pass through a bar).
function passOrdinal(n: number): string {
  const v = n % 100;
  const suffix = v >= 11 && v <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

// ─── Config shape stored in localStorage / URL ─────────────────────────────
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

// ─── Google tokens (legacy — kept for backwards compat during transition) ───
const GOOGLE_TOKEN_KEY = 'stageplot-google-token';

interface GoogleToken {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // epoch ms
}

function getGoogleToken(): GoogleToken | null {
  try {
    const stored = localStorage.getItem(GOOGLE_TOKEN_KEY);
    if (!stored) return null;
    const token = JSON.parse(stored) as GoogleToken;
    if (token.expires_at < Date.now()) return null;
    return token;
  } catch {
    return null;
  }
}

function saveGoogleToken(token: GoogleToken) {
  localStorage.setItem(GOOGLE_TOKEN_KEY, JSON.stringify(token));
}

function clearGoogleToken() {
  localStorage.removeItem(GOOGLE_TOKEN_KEY);
}

function bandToConfig(b: BandConfig): AppConfig {
  return {
    showInfo: { bandName: b.name, eventDate: '', venue: '' },
    lineup: b.lineup,
    stagePlot: b.stagePlot.map((s) => ({ ...s })),
    inputs: b.inputs.map((i) => ({ ...i })),
    monitors: b.monitors.map((m) => ({ ...m })),
    notes: b.notes.map((n) => ({ ...n })),
    setlist: (b.setlist ?? []).map((s) => ({ ...s })),
  };
}

function configToBand(c: AppConfig): BandConfig {
  return {
    slug: 'custom',
    name: c.showInfo.bandName || 'Untitled',
    lineup: c.lineup || '',
    stagePlot: c.stagePlot,
    inputs: c.inputs,
    monitors: c.monitors,
    notes: c.notes,
    setlist: c.setlist,
  };
}

const POSITIONS: StagePosition[] = ['USR', 'USC', 'USL', 'MSR', 'MSC', 'MSL', 'DSR', 'DSC', 'DSL'];

// ─── Singer Colors (shared between tabs) ───────────────────────────────────
const SINGER_COLORS = [
  'bg-blue-100 text-blue-800',
  'bg-purple-100 text-purple-800',
  'bg-green-100 text-green-800',
  'bg-orange-100 text-orange-800',
  'bg-pink-100 text-pink-800',
  'bg-teal-100 text-teal-800',
];

function getSingerColor(name: string, colorMap: Map<string, string>): string {
  if (!colorMap.has(name)) {
    const color = SINGER_COLORS[colorMap.size % SINGER_COLORS.length];
    colorMap.set(name, color);
  }
  return colorMap.get(name)!;
}

// ─── Stage-plot linkage helpers (multi-occupant blocks) ─────────────────────

// Per-mix color palette — deterministic by mix number so the same wedge reads the
// same color everywhere, and two mixes in one block are visually distinct.
const MIX_BADGE_COLORS = [
  'bg-indigo-600',
  'bg-fuchsia-600',
  'bg-emerald-600',
  'bg-amber-600',
  'bg-sky-600',
  'bg-rose-600',
  'bg-violet-600',
  'bg-teal-600',
];
function mixColor(mix: number): string {
  return MIX_BADGE_COLORS[(mix - 1) % MIX_BADGE_COLORS.length];
}

// Shared occupant chip — name, role, per-mix MIX badge, ×n inputs badge, power.
// `featured` styles the chip (not the cell). `grip` is the drag handle (config view only).
function OccupantChip({
  slot,
  indexInBlock,
  inputCount,
  grip,
}: {
  slot: StageSlot;
  indexInBlock: number;
  inputCount: number;
  grip?: ReactNode;
}) {
  const featured = slot.featured;
  const badges: ReactNode[] = [];
  if (slot.mix) {
    badges.push(
      <span key="mix" className={`px-1.5 py-0.5 ${mixColor(slot.mix)} text-white rounded text-[9px] font-bold`}>MIX {slot.mix}</span>
    );
  }
  if (inputCount > 0) {
    badges.push(
      <span key="inp" className="px-1.5 py-0.5 bg-gray-200 text-gray-700 rounded text-[9px] font-bold">×{inputCount} inputs</span>
    );
  }
  if (slot.power) {
    badges.push(
      <span key="pwr" className="px-1.5 py-0.5 bg-yellow-400 text-black rounded text-[9px] font-bold">POWER</span>
    );
  }
  return (
    <div className={`flex items-center gap-1 rounded border px-1.5 py-1 ${featured ? 'bg-gray-900 text-white border-black' : 'bg-white border-blue-100'}`}>
      {grip}
      <div className="flex-1 text-left leading-tight">
        <p className="font-bold text-[12px] uppercase">{slotLabel(slot, indexInBlock)}</p>
        <p className={`text-[10px] ${featured ? 'opacity-70' : 'text-gray-500'}`}>{slot.role}</p>
      </div>
      {badges.length > 1 ? (
        <div className="flex flex-col items-end gap-0.5">{badges}</div>
      ) : (
        badges
      )}
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function decodeConfig(s: string): AppConfig | null {
  try {
    return JSON.parse(decodeURIComponent(atob(s)));
  } catch {
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ════════════════════════════════════════════════════════════════════════════
function initConfig(): AppConfig {
  if (typeof window === 'undefined') return withStableIds(bandToConfig(fallbackBand));

  // Legacy ?config= URL (base64 encoded) — still supported for backwards compat
  const params = new URLSearchParams(window.location.search);
  const urlConfig = params.get('config');
  if (urlConfig) {
    const decoded = decodeConfig(urlConfig);
    if (decoded) {
      const cfg = withStableIds(decoded);
      window.history.replaceState(null, '', window.location.pathname);
      return cfg;
    }
  }

  // Show will be loaded from Supabase via slug — start with fallback
  return withStableIds(bandToConfig(fallbackBand));
}

function initGoogleToken(): GoogleToken | null {
  if (typeof window === 'undefined') return null;
  if (window.location.hash.startsWith('#google_auth=')) {
    const fragment = new URLSearchParams(window.location.hash.slice('#google_auth='.length));
    const accessToken = fragment.get('access_token');
    const expiresIn = fragment.get('expires_in');
    if (accessToken && expiresIn) {
      const token: GoogleToken = {
        access_token: accessToken,
        refresh_token: fragment.get('refresh_token') ?? undefined,
        expires_at: Date.now() + Number(expiresIn) * 1000,
      };
      saveGoogleToken(token);
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      return token;
    }
  }
  return getGoogleToken();
}

/**
 * Route entry point. Its ONLY job is to give the workspace a remount key.
 *
 * ★ THIS IS INSURANCE, NOT A FIX FOR A LIVE BUG. Be honest about that before
 * reasoning from it.
 *
 * /[owner]/[show] is one route, so a client-side navigation between two shows
 * would change the params WITHOUT remounting — the show data would swap while
 * every piece of UI state rode along. PR #158 treated that as live and fixed
 * three instances of it (`tab`, `reorderMode`, `calMode`, all derived from
 * `isOwner`).
 *
 * ⚠ MEASURED 2026-08-26, against a production build: that navigation DOES NOT
 * EXIST in this app. Nothing links show → show. The show page links only to /
 * and /dashboard, and /library likewise, so every route between two shows goes
 * via another page and UNMOUNTS this component. Driving the real UI, an owner
 * on CONFIG in show A who reaches show B through the dashboard lands on
 * PERFORM — state already resets, with or without this key.
 *
 * So the key changes nothing reachable today. It is here because the defect
 * arrives fully formed the moment anyone adds the obvious feature — a "jump to
 * another show" switcher — and at that point it is a one-line prevention rather
 * than a fourth round of instance-by-instance fixes. When the key changes React
 * discards the old tree and builds a fresh one, so every piece of state returns
 * to its initial value exactly as if the URL had been typed.
 *
 * ⚠ If you add a show-switcher, VERIFY this actually fires — a `key` only helps
 * on a real Next router navigation. `history.pushState` does not drive the
 * router, and a test built on it proves nothing (I made exactly that mistake).
 *
 * The key is the ROUTE PARAMS, deliberately, not the loaded show's `id` — the id
 * does not exist until the fetch resolves, so keying on it would remount midway
 * through loading. The params ARE the show's identity at the only moment that
 * matters, which is before anything renders.
 *
 * The `isOwner` derivations stay. This is the runtime guarantee; they are the
 * compile-time one, and deleting them would re-open the class the moment
 * anything about routing changes.
 */
export default function Page() {
  const params = useParams();
  const owner = params.owner as string;
  const slug = params.show as string;

  return <ShowWorkspace key={`${owner}/${slug}`} />;
}

function ShowWorkspace() {
  const params = useParams();
  const owner = params.owner as string;
  const slug = params.show as string;

  const [tab, setTab] = useState<ShowTab>('perform');
  const [config, setConfig] = useState<AppConfig>(initConfig);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [showPrintModal, setShowPrintModal] = useState(false);
  const [googleToken, setGoogleToken] = useState<GoogleToken | null>(initGoogleToken);
  const [printSections, setPrintSections] = useState({
    stagePlot: true,
    inputList: true,
    monitorMixes: true,
    notes: true,
    setlist: true,
  });
  const [isOffline, setIsOffline] = useState(() =>
    typeof window !== 'undefined' ? !navigator.onLine : false
  );
  const [googleError] = useState('');

  // ── Supabase show context ─────────────────────────────────────────────
  const [showId, setShowId] = useState<string | null>(null);
  const [showOwnerId, setShowOwnerId] = useState<string | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  // Read by updateConfig, which is deliberately ref-stable (deps: []) so that no
  // mutation callback on the page changes identity. A ref keeps the read-only
  // gate current without spending that stability. Defaults to refusing: until
  // the show loads, ownership is unknown, and no edit affordance renders in that
  // window anyway (every one of them is behind !isReadOnly).
  const isReadOnlyRef = useRef(true);
  // Synced in an effect, not written during render — same idiom as bpmConfigRef
  // below. The one-commit lag is in the SAFE direction: the ref starts refusing
  // and only relaxes once ownership is known.
  useEffect(() => { isReadOnlyRef.current = !isOwner; }, [isOwner]);
  const [loadError, setLoadError] = useState('');
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const [chartCacheProgress, setChartCacheProgress] = useState<DownloadProgress | null>(null);
  const [setlistMigrated, setSetlistMigrated] = useState(false);

  const { context: showContext, saveConfig } = useShow(showId, slug, isOwner, setlistMigrated);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);

  // ── Check auth state + subscribe to changes (sign-out, token expiry) ──
  useEffect(() => {
    const supabase = getSupabaseBrowser();
    supabase.auth.getUser().then(({ data }: { data: { user: unknown } }) => {
      setIsAuthenticated(!!data.user);
      setAuthChecked(true);
    }).catch(() => {
      setAuthChecked(true);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event: string, session: { user: unknown } | null) => {
      setIsAuthenticated(!!session?.user);
      setAuthChecked(true);
    });

    return () => { subscription.unsubscribe(); };
  }, []);

  // ── Load show from Supabase on mount ─────────────────────────────────
  useEffect(() => {
    if (!owner || !slug) return;

    let cancelled = false;

    function tryOfflineFallback(): boolean {
      try {
        const showIds = JSON.parse(localStorage.getItem('showrunr-show-ids') || '{}');
        const showId = showIds[`${owner}/${slug}`];
        if (!showId) return false;
        const cached = localStorage.getItem(`showrunr-cache-${showId}`);
        if (!cached) return false;
        // Explicit type argument: withStableIds is generic, and `JSON.parse`
        // returns `any`, so inference would make the whole config `any` and
        // silently drop type-checking on every downstream field.
        setConfig(withStableIds<AppConfig>(JSON.parse(cached)));
        setLoadedPath(`/${owner}/${slug}`);
        return true;
      } catch {
        return false;
      }
    }

    async function loadShow() {
      // Reset state from any previous show on route change
      setLoadedPath(null);
      setShowId(null);
      setIsOwner(false);
      // A new show does not inherit the previous show's tab. Deps are
      // [owner, slug], so this fires only on an actual show change.
      setTab('perform');
      setLoadError('');
      setChartCacheProgress(null);

      try {
        const res = await fetch(`/api/shows/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`);
        if (cancelled) return;

        if (!res.ok) {
          // 5xx — try offline fallback
          if (res.status >= 500) {
            if (tryOfflineFallback()) return;
          }
          // Client errors (400-499) — hard fail, no fallback
          const err = await res.json().catch(() => ({ error: 'Load failed' }));
          setLoadError(err.error || `Show "${owner}/${slug}" not found`);
          return;
        }

        const data = await res.json();
        if (cancelled || !data?.config) return;

        const cfg = withStableIds<AppConfig>(data.config);

        // Apply charts from owner's library (matched by normalized song title)
        if (data.charts && typeof data.charts === 'object') {
          const chartMap = data.charts as Record<string, Array<{ id: string; role: string; url: string; mime_type: string; updated_at: string; file_name: string; is_builder?: boolean; authored_key?: string | null; notation?: 'numbers' | 'letters'; charted_key?: string | null }>>;
          cfg.setlist = cfg.setlist.map((song) => {
            const songKey = normalizeSongKeySafe(song.title);
            if (!songKey || !chartMap[songKey]) return song;
            const charts: Chart[] = chartMap[songKey].map((c) => ({
              role: c.role,
              url: c.url,
              fileId: c.id,
              mimeType: c.mime_type,
              modifiedTime: c.updated_at,
              label: c.file_name,
              is_builder: c.is_builder,
              authored_key: c.authored_key,
              notation: c.notation,
              charted_key: c.charted_key,
            }));
            return { ...song, charts };
          });
        }

        setConfig(cfg);
        setLoadError('');
        setLoadedPath(`/${owner}/${slug}`);

        // Cache config for all viewers (offline fallback)
        try {
          if (data.show_id) {
            localStorage.setItem(`showrunr-cache-${data.show_id}`, JSON.stringify(cfg));
            const showIds = JSON.parse(localStorage.getItem('showrunr-show-ids') || '{}');
            showIds[`${owner}/${slug}`] = data.show_id;
            localStorage.setItem('showrunr-show-ids', JSON.stringify(showIds));
          }
        } catch {
          // Non-fatal — offline fallback won't be available
        }

        // Register SW + warm app cache (best-effort, fire-and-forget)
        registerServiceWorker().catch(() => {});

        // Auto-cache Supabase charts for all viewers (fire-and-forget)
        const supabaseCharts = (cfg.setlist ?? [])
          .flatMap(s => s.charts ?? [])
          .filter(c => c.url?.includes('/storage/v1/object/public/') && chartCacheKey(c));
        if (supabaseCharts.length > 0) {
          downloadAllCharts(supabaseCharts, null, (p) => {
            if (!cancelled) setChartCacheProgress({ ...p });
          }).catch(() => {});
        }

        // Check ownership using IDs from API response
        // Wrapped separately so auth failures don't hide already-loaded show content
        try {
          const supabase = getSupabaseBrowser();
          const { data: { user } } = await supabase.auth.getUser();
          if (cancelled) return;
          if (user && data.show_id) {
            // Ownership is the whole write gate. Collaborators are view-only
            // (§3.3c), so the show_collaborators lookup that used to run here is
            // gone — membership grants placement on the dashboard, not access.
            setIsOwner(data.owner_id === user.id);
            setShowId(data.show_id);
            setShowOwnerId(data.owner_id ?? null);
            setSetlistMigrated(!!data.setlist_migrated);
          }
        } catch {
          // Auth check failed — show content is already loaded, continue as anonymous
        }
      } catch {
        if (!cancelled) {
          // Network error — try offline fallback
          if (tryOfflineFallback()) return;
          setLoadError(`Could not load show "${owner}/${slug}" — network error`);
        }
      }
    }

    loadShow();
    return () => { cancelled = true; };
  }, [owner, slug]);

  // ── Remember last-viewed show for offline PWA launch ────────────────
  useEffect(() => {
    if (loadedPath) {
      try { localStorage.setItem('showrunr-last-show', loadedPath); } catch { /* quota */ }
    }
  }, [loadedPath]);

  // ── Persist to localStorage + Supabase on change ─────────────────────
  useEffect(() => {
    if (showId) {
      saveConfig(config as unknown as Record<string, unknown>);
    }
  }, [config, showId, saveConfig]);

  // ── Offline detection ─────────────────────────────────────────────────
  useEffect(() => {
    const goOffline = () => setIsOffline(true);
    const goOnline = () => setIsOffline(false);
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, []);

  // One-level, in-memory undo for a setlist import (design §7). Null ⇒ no
  // affordance. Not persisted: a reload drops it, which is the specified scope.
  const [importUndo, setImportUndo] = useState<SetlistSong[] | null>(null);

  const updateConfig = useCallback((
    fn: (prev: AppConfig) => AppConfig,
    opts?: { automatic?: boolean },
  ) => {
    // Normalize EVERY entity's id through the single mutation chokepoint so every
    // live writer (Add Row, AI ops, DnD) mints ids + de-dupes/flags links — not
    // just load/import. Idempotent and ref-stable when nothing's dirty (no edit
    // churn), because withStableIds returns the original object unless it minted.
    //
    // `withStableIds`, not `ensureStageSlotIds` alone: the latter covers slots
    // only, so setlist/input/monitor rows created here landed with `id:
    // undefined` while 12 sites dereference `.id!` — broken React keys and dead
    // drag-and-drop (design-ai-op-contract §9.4). The ordering inside
    // withStableIds is deliberate and preserved: slot ids first, so input
    // id-minting runs on top of any cleared slotIds.
    // ★ §3.3c, the LAST line of defence. Every edit affordance on this page
    // funnels through here (the comment above already calls this the single
    // mutation chokepoint), so a read-only viewer who reaches ANY of them —
    // one missed today, one added tomorrow — mutates nothing. Two affordance
    // leaks were found in review by walking the UI; this one does not depend on
    // that walk being complete.
    //
    // Refuse rather than apply-then-fail-to-save: useShow blocks persistence for
    // a read-only viewer, so mutating local state here would show the change
    // landing and then silently discard it — the app claiming a save it did not
    // make (§1.1).
    if (isReadOnlyRef.current) return;
    setConfig((prev) => withStableIds(fn(prev)));
    // §7: undo survives only until the next mutation. Because updateConfig is the
    // single mutation chokepoint, clearing here covers every writer in the app
    // without each one having to remember. The import apply deliberately does not
    // route through updateConfig, so it cannot clear the snapshot it just armed.
    //
    // `automatic` is the exception, and it is load-bearing: auto-resolve-charts
    // writes here on a 1s debounce after any setlist-title change, so WITHOUT this
    // an import would arm undo and then have it silently vanish a second later —
    // but only for users who have Drive charts configured, which is worse than
    // never offering it. "The next mutation" means the next mutation the USER
    // makes; an automatic write is not one.
    if (!opts?.automatic) setImportUndo(null);
  }, []);

  // Commit an import merge and arm undo. Bypasses updateConfig on purpose — see
  // above — so the ordering of the two setStates carries no meaning.
  const applyImportMerge = useCallback((merged: SetlistSong[], before: SetlistSong[]) => {
    // withStableIds, not ensureStageSlotIds: this is THE path CSV/sheet-imported
    // rows arrive on, and slot-only normalization left every imported song with
    // no `id` — the defect this fix exists for.
    setConfig((prev) => withStableIds({ ...prev, setlist: merged }));
    setImportUndo(before);
  }, []);

  // No side effect inside a state updater: React may invoke an updater twice in
  // StrictMode, so the snapshot is read from scope and each setState is called once.
  const undoImport = useCallback(() => {
    if (!importUndo) return;
    // Same reason as applyImportMerge: undo restores the pre-import setlist, whose
    // rows may themselves predate id-minting.
    setConfig((prev) => withStableIds({ ...prev, setlist: importUndo }));
    setImportUndo(null);
  }, [importUndo]);

  // §7: undo also expires on a tab change — the other half of "until the next
  // mutation or tab change" (the mutation half is updateConfig).
  //
  // Deliberately an ACTION, not an effect on [tab]: the print flow switches to Mix
  // and restores the previous tab behind the user's back, and an effect would let
  // that invisible round-trip silently eat the affordance. Only user-initiated
  // navigation goes through here. (It also satisfies react-hooks/set-state-in-effect.)
  const goToTab = useCallback((next: typeof tab) => {
    setImportUndo(null);
    setTab(next);
  }, []);

  // Canonical-BPM writer (lib/bpm-writer): optimistic patch, per-song serialized
  // PUTs (server receives writes in order), revert-to-confirmed on failure. Lives
  // HERE — not in ConfigTab, which remounts on every tab switch (Codex R2 HIGH-2) —
  // so ONE writer's in-flight chain + confirmed map span the whole show session.
  // Built lazily inside the handler (react-hooks/refs: no ref access in render);
  // reads the live setlist via bpmConfigRef so the confirmed seed is never stale.
  const bpmConfigRef = useRef(config);
  useEffect(() => { bpmConfigRef.current = config; }, [config]);
  const bpmWriterRef = useRef<BpmWriter | null>(null);
  const handleBpmChange = useCallback((songId: string, bpm: number | null) => {
    if (bpmWriterRef.current == null) {
      bpmWriterRef.current = createBpmWriter({
        put: async (id, value) => {
          const res = await fetch('/api/songs/update', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, bpm: value }),
          });
          return res.ok;
        },
        getCurrent: (id) =>
          bpmConfigRef.current.setlist.find((s) => s.songId === id)?.bpm ?? null,
        patch: (id, value) =>
          updateConfig((p) => ({
            ...p,
            setlist: p.setlist.map((s) => (s.songId === id ? { ...s, bpm: value } : s)),
          })),
      });
    }
    void bpmWriterRef.current(songId, bpm);
  }, [updateConfig]);

  const [publishSlug] = useState(slug);
  const [publishing] = useState(false);
  const [publishError] = useState('');

  // Share: just copy the current slug URL
  const handlePublish = useCallback(async () => {
    const url = `${window.location.origin}/${owner}/${slug}`;
    await navigator.clipboard.writeText(url);
    setCopyFeedback(true);
    setTimeout(() => setCopyFeedback(false), 2000);
  }, [owner, slug]);

  const band = configToBand(config);
  const isReadOnly = !isOwner;
  // ★ `tab` survives a show change (same route, new params → no remount), so an
  // owner sitting on Config who navigates to a show they only collaborate on
  // would otherwise keep the editor. Hiding the buttons is not enough — the
  // panels render from this value. See lib/show-tabs.
  const shownTab = visibleTab(tab, isReadOnly);

  if (loadError) {
    const isNetworkError = loadError.includes('network');
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950 text-white">
        <div className="text-center max-w-md px-6">
          <h1 className="text-2xl font-bold mb-4">
            {isNetworkError ? 'Connection error' : 'Show not found'}
          </h1>
          <p className="text-gray-400 mb-6">
            {isNetworkError
              ? 'Could not reach ShowRunr. Check your connection and try again.'
              : 'This show may have been renamed or removed. If you received this link from someone, ask them for an updated link.'}
          </p>
          {isNetworkError && (
            <button
              onClick={() => window.location.reload()}
              className="text-blue-400 hover:text-blue-300 underline mr-4"
            >
              Retry
            </button>
          )}
          <Link href="/" className="text-blue-400 hover:text-blue-300 underline">
            Go to ShowRunr home
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 font-sans text-gray-900">
      {/* ── Auth / save status banner ────────────────────────────────── */}
      {authChecked && !isAuthenticated && !loadError && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 text-center text-sm text-amber-800">
          Not signed in — changes won&apos;t be saved.{' '}
          <Link href="/sign-in" className="underline font-semibold hover:text-amber-900">Sign in</Link>
        </div>
      )}
      {isAuthenticated && isReadOnly && showId && (
        <div className="bg-blue-50 border-b border-blue-200 px-4 py-2 text-center text-sm text-blue-800">
          Viewing as collaborator (read-only).
        </div>
      )}
      {/* ── Tab Bar ─────────────────────────────────────────────────────── */}
      <div className="sticky top-0 z-10 bg-white border-b shadow-sm">
        <div className="max-w-4xl mx-auto flex items-center">
          <LogoMark className="h-5 w-auto ml-3 mr-1 shrink-0" />
          {isAuthenticated && (
            <Link href="/dashboard" className="px-3 py-3 text-gray-400 hover:text-black transition-colors" title="My Shows">
              <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </Link>
          )}
          <button
            onClick={() => goToTab('perform')}
            className={`flex-1 py-3 text-center font-bold text-sm uppercase tracking-wide transition-colors ${
              shownTab === 'perform'
                ? 'border-b-2 border-black text-black'
                : 'text-gray-400 hover:text-gray-600'
            }`}
          >
            Perform
          </button>
          <button
            onClick={() => goToTab('mix')}
            className={`flex-1 py-3 text-center font-bold text-sm uppercase tracking-wide transition-colors ${
              shownTab === 'mix'
                ? 'border-b-2 border-black text-black'
                : 'text-gray-400 hover:text-gray-600'
            }`}
          >
            Mix
          </button>
          {!isReadOnly && (
          <button
            onClick={() => goToTab('config')}
            className={`flex-1 py-3 text-center font-bold text-sm uppercase tracking-wide transition-colors ${
              shownTab === 'config'
                ? 'border-b-2 border-black text-black'
                : 'text-gray-400 hover:text-gray-600'
            }`}
          >
            Config
          </button>
          )}
          {!isReadOnly && (
          <button
            onClick={() => goToTab('ai')}
            className={`flex-1 py-3 text-center font-bold text-sm uppercase tracking-wide transition-colors ${
              shownTab === 'ai'
                ? 'border-b-2 border-black text-black'
                : 'text-gray-400 hover:text-gray-600'
            }`}
          >
            AI
          </button>
          )}
          <button
            onClick={() => setShowPrintModal(true)}
            className="p-2 text-gray-500 hover:text-black transition-colors print:hidden"
            title="Print / Save PDF"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4H7v4a2 2 0 002 2zm0-14V3a2 2 0 012-2h2a2 2 0 012 2v4H9z" />
            </svg>
          </button>
          <button
            onClick={handlePublish}
            disabled={publishing}
            className="p-2 mr-1 text-gray-500 hover:text-black transition-colors disabled:opacity-30"
            title={copyFeedback ? 'Published & copied!' : publishSlug ? `Publish & copy link (${publishSlug})` : 'Publish & copy shareable link'}
          >
            {copyFeedback ? (
              <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
            )}
          </button>
          {/* Undo import — one level, in-memory, alongside the save status (§7).
              Cleared by the next mutation (updateConfig) or a tab change. */}
          {importUndo && isOwner && (
            <button
              onClick={undoImport}
              className="text-[10px] font-medium px-2 py-1 rounded mr-1 flex-shrink-0 text-amber-700 bg-amber-50 hover:bg-amber-100 transition-colors"
            >
              Undo import
            </button>
          )}
          {/* Save status */}
          {isOwner && (
            <span role="status" aria-live="polite" title={showContext.saveError ?? undefined} className={`text-[10px] font-medium px-2 py-1 rounded mr-1 flex-shrink-0 max-w-[16rem] truncate ${
              showContext.saveError
                ? 'text-red-600 bg-red-50'
                : showContext.saving
                  ? 'text-amber-600 bg-amber-50'
                  : showContext.lastSavedAt
                    ? 'text-green-600 bg-green-50'
                    : 'text-gray-400'
            }`}>
              {showContext.saveError
                ? `Couldn't save — ${showContext.saveError}`
                : showContext.saving ? 'Saving...' : showContext.lastSavedAt ? 'Saved' : ''}
            </span>
          )}
        </div>
      </div>

      {/* ── Errors ────────────────────────────────────────────────────── */}
      {publishError && (
        <div className="max-w-4xl mx-auto px-4 pt-4">
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">
            {publishError}
          </div>
        </div>
      )}

      {/* ── Content ────────────────────────────────────────────────────── */}
      {shownTab === 'perform' && (
        <PerformTab setlist={config.setlist} showInfo={config.showInfo} isOffline={isOffline} accessToken={googleToken?.access_token} slug={slug} owner={owner} isOwner={isOwner} chartCacheProgress={chartCacheProgress} />
      )}
      {shownTab === 'mix' && (
        <MixTab band={band} setlist={config.setlist} printSections={printSections} showInfo={config.showInfo} isOffline={isOffline} accessToken={googleToken?.access_token} slug={slug} owner={owner} isOwner={isOwner} onReorder={(from, to) => updateConfig((p) => ({ ...p, setlist: moveSetlistSong(p.setlist, from, to) }))} />
      )}
      {shownTab === 'config' && (
        <ConfigTab config={config} updateConfig={updateConfig} onBpmChange={handleBpmChange} onImportApply={applyImportMerge} googleToken={googleToken} googleError={googleError} onDisconnectGoogle={() => { clearGoogleToken(); setGoogleToken(null); }} showId={showId} ownerId={showOwnerId} isOwner={isOwner} />
      )}
      {shownTab === 'ai' && (
        <div className="p-4 md:p-8">
          <div className="max-w-4xl mx-auto">
            <AgentChat config={config} updateConfig={updateConfig} owner={owner} slug={slug} />
          </div>
        </div>
      )}

      {/* ── Print Modal ─────────────────────────────────────────────── */}
      {showPrintModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 print:hidden">
          <div className="bg-white rounded-xl shadow-2xl p-6 w-full max-w-sm mx-4">
            <h3 className="text-lg font-bold mb-4">Print / Save PDF</h3>
            <p className="text-sm text-gray-500 mb-4">Select sections to include:</p>
            <div className="space-y-3">
              {([
                ['stagePlot', 'Stage Plot'],
                ['inputList', 'Input List'],
                ['monitorMixes', 'Monitor Mixes'],
                ['notes', 'Notes'],
                ['setlist', 'Setlist / Run Order'],
              ] as const).map(([key, label]) => (
                <label key={key} className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={printSections[key]}
                    onChange={(e) =>
                      setPrintSections((prev) => ({ ...prev, [key]: e.target.checked }))
                    }
                    className="w-4 h-4"
                  />
                  <span className="text-sm font-medium">{label}</span>
                </label>
              ))}
            </div>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => {
                  setShowPrintModal(false);
                  // The printable sections (incl. the 2-col cue sheet) live in
                  // MixTab, which only mounts on the Mix tab. The print button is
                  // global, so a print from another tab would be blank. There is
                  // one canonical print view, so route every print through MixTab:
                  // switch to it, print, then restore the user's tab.
                  const prevTab = tab;
                  setTab('mix');
                  const restore = () => {
                    setTab(prevTab);
                    window.removeEventListener('afterprint', restore);
                  };
                  window.addEventListener('afterprint', restore);
                  setTimeout(() => window.print(), 150);
                }}
                className="flex-1 px-4 py-2 text-sm font-bold bg-black text-white rounded hover:bg-gray-800 transition-colors"
              >
                Print
              </button>
              <button
                onClick={() => setShowPrintModal(false)}
                className="flex-1 px-4 py-2 text-sm font-bold bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition-colors border border-gray-300"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// PERFORM TAB — musician's gig-day view
// ════════════════════════════════════════════════════════════════════════════

function PerformTab({ setlist, showInfo, isOffline, accessToken, slug, owner, isOwner, chartCacheProgress }: {
  setlist: SetlistSong[];
  showInfo: { bandName: string; eventDate: string; venue: string; showName?: string };
  isOffline: boolean;
  accessToken?: string;
  slug: string;
  owner: string;
  isOwner: boolean;
  chartCacheProgress?: DownloadProgress | null;
}) {
  // Role filter (per-show, owner-scoped to avoid cross-owner collisions)
  const roleKey = `showrunr-role-filter-${owner}/${slug}`;
  const [roleFilter, setRoleFilter] = useState<string>(() => {
    if (typeof window === 'undefined') return 'all';
    return sessionStorage.getItem(roleKey) ?? 'all';
  });
  const handleRoleChange = useCallback((role: string) => {
    setRoleFilter(role);
    sessionStorage.setItem(roleKey, role);
  }, [roleKey]);

  const allRoles = Array.from(new Set(
    setlist.flatMap((s) => (s.charts ?? []).map((c) => c.role))
  )).sort();
  const effectiveRoleFilter = roleFilter === 'all' || allRoles.includes(roleFilter) ? roleFilter : 'all';

  // Chart navigator state
  const [navigatorSongIdx, setNavigatorSongIdx] = useState<number | null>(null);

  // ── 3b chunk 5: the QR deep link (?join=CODE, lib/relay-join buildJoinUrl) ──
  // Landing here with a join code auto-opens the navigator on the first song
  // with charts; once connected, `joined.activeSession` navigates to the live
  // chart (the switch-session effect in ChartNavigator) — doc §3: "open the
  // right chart without hunting". Read once on mount; consumed, not reactive.
  const [joinCode, setJoinCode] = useState<string | null>(null);
  const joinArmedRef = useRef(false);
  useEffect(() => {
    if (joinArmedRef.current) return;
    const raw = new URLSearchParams(window.location.search).get('join');
    if (!raw) return;
    const code = normalizeRoomCode(raw);
    if (!isRoomCodeShaped(code)) return;
    const idx = setlist.findIndex((s) => (s.charts ?? []).length > 0);
    if (idx === -1) return; // nothing to perform on yet — the setlist view stands
    joinArmedRef.current = true;
    // Deferred setState (the repo's set-state-in-effect discipline); the armed
    // ref above already latched, so a re-run can't double-fire.
    let cancelled = false;
    Promise.resolve().then(() => {
      if (cancelled) return;
      setJoinCode(code);
      setNavigatorSongIdx(idx);
    });
    return () => {
      cancelled = true;
    };
  }, [setlist]);

  // ── Share deep link (?song=N&chart=ROLE, lib/share buildChartShareUrl) ──
  // A shared chart link opens the navigator on that song; the role rides along
  // as a prop and ChartNavigator selects the matching chart. Same read-once /
  // armed-ref / deferred-setState shape as the ?join handler above. Invalid
  // song ⇒ ignore, land on the setlist as usual.
  const [deepLinkRole, setDeepLinkRole] = useState<string | null>(null);
  const chartLinkArmedRef = useRef(false);
  useEffect(() => {
    if (chartLinkArmedRef.current) return;
    const parsed = parseChartDeepLink(window.location.search, setlist);
    if (!parsed) return;
    chartLinkArmedRef.current = true;
    let cancelled = false;
    Promise.resolve().then(() => {
      if (cancelled) return;
      setNavigatorSongIdx(parsed.songIdx);
      setDeepLinkRole(parsed.role);
    });
    return () => {
      cancelled = true;
    };
  }, [setlist]);

  return (
    <div className="bg-zinc-950 min-h-screen text-zinc-100">
      <div className="max-w-2xl mx-auto px-4 py-6">
        {/* Header */}
        <header className="mb-6">
          {showInfo.showName ? (
            <h1 className="text-2xl font-black tracking-tight">{showInfo.showName}</h1>
          ) : (
            <h1 className="text-2xl font-black tracking-tight">
              {showInfo.venue || showInfo.eventDate
                ? [showInfo.venue, showInfo.eventDate].filter(Boolean).join(' · ')
                : 'Setlist'}
            </h1>
          )}
          <div className="flex items-center justify-between mt-1">
            {showInfo.showName && (
              <p className="text-sm text-zinc-400">
                {showInfo.venue && showInfo.eventDate
                  ? `${showInfo.venue} · ${showInfo.eventDate}`
                  : showInfo.venue || showInfo.eventDate || ''}
              </p>
            )}
            <div className="flex items-center gap-2 ml-auto">
              {chartCacheProgress && chartCacheProgress.done < chartCacheProgress.total && (
                <span className="text-[10px] text-amber-400 bg-amber-950/50 px-2 py-0.5 rounded">
                  Caching {chartCacheProgress.done}/{chartCacheProgress.total}
                </span>
              )}
              {chartCacheProgress && chartCacheProgress.done === chartCacheProgress.total && chartCacheProgress.failed.length === 0 && chartCacheProgress.total > 0 && (
                <span className="text-[10px] text-green-400 bg-green-950/50 px-2 py-0.5 rounded">
                  {chartCacheProgress.total} charts cached
                </span>
              )}
              {chartCacheProgress && chartCacheProgress.done === chartCacheProgress.total && chartCacheProgress.failed.length > 0 && (
                <span className="text-[10px] text-amber-400 bg-amber-950/50 px-2 py-0.5 rounded">
                  {chartCacheProgress.done - chartCacheProgress.failed.length} of {chartCacheProgress.total} cached
                </span>
              )}
              <p className="text-sm text-zinc-500">{setlist.length} songs</p>
              {/* Show-level share: the bare show URL (tiers 2/3 — no file). */}
              <ShareButton
                title={showInfo.showName || [showInfo.venue, showInfo.eventDate].filter(Boolean).join(' · ') || 'Setlist'}
                buildUrl={() => buildShowShareUrl(window.location.origin, owner, slug)}
              />
            </div>
          </div>
          {/* Role selector */}
          {allRoles.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-3">
              <button
                onClick={() => handleRoleChange('all')}
                className={`px-2.5 py-1 text-xs font-semibold rounded-full transition-colors ${
                  effectiveRoleFilter === 'all'
                    ? 'bg-white text-black'
                    : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                All
              </button>
              {allRoles.map((role) => (
                <button
                  key={role}
                  onClick={() => handleRoleChange(role)}
                  className={`px-2.5 py-1 text-xs font-semibold rounded-full transition-colors ${
                    effectiveRoleFilter === role
                      ? 'bg-white text-black'
                      : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {role}
                </button>
              ))}
            </div>
          )}
        </header>

        {/* Setlist */}
        {setlist.length === 0 ? (
          <p className="text-zinc-500 text-center py-12">No setlist yet.</p>
        ) : (
          <div className="space-y-0.5">
            {setlist.map((song, idx) => {
              const songCharts = (song.charts ?? []).filter(
                (c) => effectiveRoleFilter === 'all' || c.role === effectiveRoleFilter
              );
              return (
                <div
                  key={song.id ?? song.position}
                  className="flex items-center gap-3 px-3 py-3 rounded-lg hover:bg-zinc-900 active:bg-zinc-800 transition-colors"
                >
                  <span className="text-zinc-600 font-mono text-sm w-7 text-right flex-shrink-0">
                    {song.position}.
                  </span>
                  <div className="flex-1 min-w-0">
                    <span className="font-bold text-lg leading-tight">{song.title}</span>
                    {song.key && (
                      <span className="ml-2 text-xs bg-zinc-800 text-zinc-300 px-2 py-1 rounded font-bold border border-zinc-700 align-middle">
                        {song.key}
                      </span>
                    )}
                  </div>
                  {songCharts.length > 0 && (
                    <button
                      onClick={() => setNavigatorSongIdx(idx)}
                      className="w-10 h-10 flex items-center justify-center rounded-lg bg-zinc-800 text-blue-400 hover:bg-zinc-700 active:bg-zinc-600 transition-colors flex-shrink-0"
                      title={`${songCharts.length} chart${songCharts.length > 1 ? 's' : ''}`}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z" />
                      </svg>
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Chart Navigator Overlay */}
      {navigatorSongIdx !== null && setlist[navigatorSongIdx] && (
        <ChartNavigator
          setlist={setlist}
          currentIdx={navigatorSongIdx}
          roleFilter={effectiveRoleFilter}
          allRoles={allRoles}
          isOffline={isOffline}
          accessToken={accessToken}
          isOwner={isOwner}
          owner={owner}
          slug={slug}
          onChangeIdx={setNavigatorSongIdx}
          onChangeRole={handleRoleChange}
          onClose={() => setNavigatorSongIdx(null)}
          joinCode={joinCode}
          initialChartRole={deepLinkRole}
        />
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// MIX TAB — engineer's rider view
// ════════════════════════════════════════════════════════════════════════════

// Read-only / print container cell: TLA header + occupant count, stacked chips
// (stable insertion order), or "empty".
function StageSlotCell({ pos, slots, inputs }: { pos: StagePosition; slots: StageSlot[]; inputs: InputChannel[] }) {
  const count = slots.length;
  return (
    <div className="rounded-lg border-2 border-dashed border-blue-100 bg-blue-50/30 overflow-hidden">
      <div className={`flex items-center justify-between px-1.5 py-0.5 ${count ? 'bg-blue-100/60' : 'bg-blue-50'}`}>
        <span className={`text-[9px] font-bold tracking-wider ${count ? 'text-blue-700' : 'text-gray-400'}`}>{pos}</span>
        {count > 0 && (
          <span className="text-[9px] text-blue-400">{count} occupant{count > 1 ? 's' : ''}</span>
        )}
      </div>
      <div className="p-1.5 space-y-1">
        {count === 0 ? (
          <p className="text-[10px] text-gray-300 italic text-center py-1">empty</p>
        ) : (
          slots.map((s, i) => (
            <OccupantChip key={s.id ?? i} slot={s} indexInBlock={i} inputCount={countLinkedInputs(s.id, inputs)} />
          ))
        )}
      </div>
    </div>
  );
}

function StagePlotView({ band }: { band: BandConfig }) {
  const byPos = groupByPos(band.stagePlot);
  const cell = (pos: StagePosition) => (
    <StageSlotCell key={pos} pos={pos} slots={byPos.get(pos) ?? []} inputs={band.inputs} />
  );
  const hasMidStage = (['MSR', 'MSC', 'MSL'] as StagePosition[]).some((p) => byPos.has(p));

  return (
    <div className="bg-white border-4 border-gray-200 rounded-xl shadow-inner overflow-hidden">
      <div className="flex justify-between px-3 pt-2 pb-1">
        <span className="text-[10px] font-bold text-gray-400">USR</span>
        <span className="text-[10px] font-bold text-gray-500 tracking-widest">UPSTAGE</span>
        <span className="text-[10px] font-bold text-gray-400">USL</span>
      </div>
      <div className="grid grid-cols-3 gap-2 px-3 pb-2 items-start">
        {(['USR', 'USC', 'USL'] as StagePosition[]).map(cell)}
      </div>
      {hasMidStage && (
        <>
          <div className="mx-3 border-t-2 border-dashed border-gray-300 my-1" />
          <div className="grid grid-cols-3 gap-2 px-3 pt-2 pb-2 items-start">
            {(['MSR', 'MSC', 'MSL'] as StagePosition[]).map(cell)}
          </div>
        </>
      )}
      <div className="mx-3 border-t-2 border-dashed border-gray-300 my-1" />
      <div className="grid grid-cols-3 gap-2 px-3 pt-2 pb-2 items-start">
        {(['DSR', 'DSC', 'DSL'] as StagePosition[]).map(cell)}
      </div>
      <div className="flex justify-between px-3 pb-2 pt-1">
        <span className="text-[10px] font-bold text-gray-400">DSR</span>
        <span className="text-[10px] font-bold text-gray-500 tracking-widest">AUDIENCE / FOH</span>
        <span className="text-[10px] font-bold text-gray-400">DSL</span>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// DRAGGABLE STAGE PLOT (Config tab — drag to reposition)
// ════════════════════════════════════════════════════════════════════════════

// One draggable occupant chip — the grip is the drag handle (id `drag-${slot.id}`,
// so input links survive a reposition). Dimmed while dragging; the moving copy is
// rendered in the DragOverlay.
function DraggableOccupantChip({ slot, indexInBlock, inputCount }: { slot: StageSlot; indexInBlock: number; inputCount: number }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `drag-${slot.id}`,
    disabled: !slot.id,
    data: { slotId: slot.id, pos: slot.pos },
  });
  const grip = (
    <span
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className="grip text-gray-300 text-xs leading-none cursor-grab touch-none select-none"
      aria-label="Drag to reposition"
    >
      ⠿
    </span>
  );
  return (
    <div className={isDragging ? 'opacity-30' : ''}>
      <OccupantChip slot={slot} indexInBlock={indexInBlock} inputCount={inputCount} grip={grip} />
    </div>
  );
}

// Config container cell: droppable block (id `drop-${pos}`) with stacked draggable
// chips (stable insertion order) + "+ add occupant".
function DraggableStageCell({
  pos,
  slots,
  inputs,
  onAddOccupant,
}: {
  pos: StagePosition;
  slots: StageSlot[];
  inputs: InputChannel[];
  onAddOccupant: (pos: StagePosition) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `drop-${pos}` });
  const count = slots.length;
  return (
    <div
      ref={setNodeRef}
      className={`rounded-lg border-2 overflow-hidden transition-colors ${
        isOver ? 'border-blue-400 bg-blue-50 ring-2 ring-blue-200' : 'border-dashed border-blue-100 bg-blue-50/30'
      }`}
    >
      <div className={`flex items-center justify-between px-1.5 py-0.5 ${count ? 'bg-blue-100/60' : 'bg-blue-50'}`}>
        <span className={`text-[9px] font-bold tracking-wider ${count ? 'text-blue-700' : 'text-gray-400'}`}>{pos}</span>
        {count > 0 && (
          <span className="text-[9px] text-blue-400">{count} occupant{count > 1 ? 's' : ''}</span>
        )}
      </div>
      <div className="p-1.5 space-y-1">
        {slots.map((s, i) => (
          <DraggableOccupantChip key={s.id ?? i} slot={s} indexInBlock={i} inputCount={countLinkedInputs(s.id, inputs)} />
        ))}
        <button
          type="button"
          onClick={() => onAddOccupant(pos)}
          className="w-full text-[10px] text-blue-500 border border-dashed border-blue-200 rounded py-1.5 hover:bg-blue-50"
        >
          + add occupant
        </button>
      </div>
    </div>
  );
}

function DraggableStagePlotView({
  stagePlot,
  inputs,
  onMove,
  onAddOccupant,
}: {
  stagePlot: StageSlot[];
  inputs: InputChannel[];
  onMove: (slotId: string, toPos: StagePosition) => void;
  onAddOccupant: (pos: StagePosition) => void;
}) {
  const byPos = groupByPos(stagePlot);
  const [activeSlot, setActiveSlot] = useState<StageSlot | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
  );

  const handleDragStart = (event: DragStartEvent) => {
    const slotId = event.active.data.current?.slotId as string | undefined;
    const s = stagePlot.find((x) => x.id === slotId);
    if (s) setActiveSlot(s);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveSlot(null);
    const { active, over } = event;
    if (!over) return;
    const slotId = (active.id as string).replace('drag-', '');
    const toPos = (over.id as string).replace('drop-', '') as StagePosition;
    const s = stagePlot.find((x) => x.id === slotId);
    if (s && s.pos !== toPos) onMove(slotId, toPos);
  };

  const cell = (pos: StagePosition) => (
    <DraggableStageCell key={pos} pos={pos} slots={byPos.get(pos) ?? []} inputs={inputs} onAddOccupant={onAddOccupant} />
  );

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="bg-white border-4 border-gray-200 rounded-xl shadow-inner overflow-hidden">
        <div className="flex justify-between px-3 pt-2 pb-1">
          <span className="text-[10px] font-bold text-gray-400">USR</span>
          <span className="text-[10px] font-bold text-gray-500 tracking-widest">UPSTAGE</span>
          <span className="text-[10px] font-bold text-gray-400">USL</span>
        </div>
        <div className="grid grid-cols-3 gap-2 px-3 pb-2 items-start">
          {(['USR', 'USC', 'USL'] as StagePosition[]).map(cell)}
        </div>
        <div className="mx-3 border-t-2 border-dashed border-gray-300 my-1" />
        <div className="grid grid-cols-3 gap-2 px-3 pt-2 pb-2 items-start">
          {(['MSR', 'MSC', 'MSL'] as StagePosition[]).map(cell)}
        </div>
        <div className="mx-3 border-t-2 border-dashed border-gray-300 my-1" />
        <div className="grid grid-cols-3 gap-2 px-3 pt-2 pb-2 items-start">
          {(['DSR', 'DSC', 'DSL'] as StagePosition[]).map(cell)}
        </div>
        <div className="flex justify-between px-3 pb-2 pt-1">
          <span className="text-[10px] font-bold text-gray-400">DSR</span>
          <span className="text-[10px] font-bold text-gray-500 tracking-widest">AUDIENCE / FOH</span>
          <span className="text-[10px] font-bold text-gray-400">DSL</span>
        </div>
      </div>
      <DragOverlay>
        {activeSlot && (
          <OccupantChip slot={activeSlot} indexInBlock={0} inputCount={countLinkedInputs(activeSlot.id, inputs)} />
        )}
      </DragOverlay>
      <p className="text-[10px] text-gray-400 text-center mt-2">Drag a chip by its grip to reposition</p>
    </DndContext>
  );
}

// Exported for tests only — same precedent as SetupSetlistTable below. The
// view-only gate here has no other executable home: Page is a 6800-line client
// route that cannot be rendered in isolation.
export function MixTab({ band, setlist, printSections, showInfo, isOffline, accessToken, slug, owner, isOwner, onReorder }: { band: BandConfig; setlist: SetlistSong[]; printSections: Record<string, boolean>; showInfo: { bandName: string; eventDate: string; venue: string; showName?: string }; isOffline: boolean; accessToken?: string; slug: string; owner: string; isOwner: boolean; onReorder: (from: number, to: number) => void }) {
  const colorMap = new Map<string, string>();
  if (band.setlist?.length) {
    band.setlist.forEach((s) => {
      s.lead.split('+').map((n) => n.trim()).forEach((n) => getSingerColor(n, colorMap));
    });
  }
  const legend = Array.from(colorMap.entries());

  // Navigator state
  const [navigatorSongIdx, setNavigatorSongIdx] = useState<number | null>(null);
  const roleKey = `showrunr-role-filter-${owner}/${slug}`;
  const [roleFilter, setRoleFilter] = useState<string>(() => {
    if (typeof window === 'undefined') return 'all';
    return sessionStorage.getItem(roleKey) ?? 'all';
  });
  const handleRoleChange = useCallback((role: string) => {
    setRoleFilter(role);
    sessionStorage.setItem(roleKey, role);
  }, [roleKey]);

  // Reorder mode
  const [reorderMode, setReorderMode] = useState(false);
  // ★ EXACTLY the `tab` trap again (see lib/show-tabs): this state survives a
  // show change, because /[owner]/[show] re-renders rather than remounting. An
  // owner who leaves Mix in reorder mode and opens a show they only collaborate
  // on would otherwise keep the drag-and-drop table. Derived rather than reset,
  // so the guarantee does not depend on remembering to clear it.
  const reordering = reorderMode && isOwner;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
  );
  const songIds = setlist.map((s) => s.id!);
  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = songIds.indexOf(active.id as string);
    const to = songIds.indexOf(over.id as string);
    if (from !== -1 && to !== -1) onReorder(from, to);
  }, [songIds, onReorder]);

  // Show chart column if any song has charts (resolved) — column stays visible even
  // if zero matches so users see the gray "none" state and can still open navigator
  const showChartsColumn = band.setlist?.some((s) => s.charts !== undefined) ?? false;

  // Collect all unique roles across all songs for filter dropdown
  const allRoles = Array.from(new Set(
    (band.setlist ?? []).flatMap((s) => (s.charts ?? []).map((c) => c.role))
  )).sort();

  // Reset stale filter if the persisted role no longer exists in current charts
  const effectiveRoleFilter = roleFilter === 'all' || allRoles.includes(roleFilter) ? roleFilter : 'all';

  return (
    <div className="p-4 md:p-8">
      <div className="max-w-4xl mx-auto space-y-12">
        <header className="text-center border-b pb-8">
          <h1 className="text-4xl font-black tracking-tight uppercase">{band.name}</h1>
          {showInfo.showName && (
            <p className="text-xl font-semibold text-gray-600 mt-1">{showInfo.showName}</p>
          )}
          <p className="text-lg font-semibold text-gray-700 mt-1">
            {showInfo.venue && showInfo.eventDate
              ? `${showInfo.venue} · ${showInfo.eventDate}`
              : showInfo.venue || showInfo.eventDate || 'Set venue & date in Config'}
          </p>
          <p className="text-sm text-gray-400 mt-1 uppercase tracking-wide">{band.lineup}</p>
        </header>

        <section className={printSections.stagePlot ? '' : 'no-print'}>
          <h2 className="text-2xl font-bold mb-6 flex items-center gap-2">
            <span className="w-8 h-8 bg-black text-white flex items-center justify-center rounded text-sm">1</span>
            Stage Plot
          </h2>
          <StagePlotView band={band} />
        </section>

        <section className={printSections.inputList ? '' : 'no-print'}>
          <h2 className="text-2xl font-bold mb-6 flex items-center gap-2">
            <span className="w-8 h-8 bg-black text-white flex items-center justify-center rounded text-sm">2</span>
            Input List
          </h2>
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="px-4 py-3 font-bold w-12">Ch</th>
                  <th className="px-4 py-3 font-bold">Source</th>
                  <th className="px-4 py-3 font-bold">Mic/DI</th>
                  <th className="px-4 py-3 font-bold">Stand</th>
                  <th className="px-4 py-3 font-bold">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {band.inputs.map((i) => (
                  <tr key={i.ch} className="hover:bg-gray-50">
                    <td className="px-4 py-2 font-mono">{i.ch}</td>
                    <td className="px-4 py-2 font-bold">{i.inst}</td>
                    <td className="px-4 py-2 text-gray-600">{i.mic}</td>
                    <td className="px-4 py-2 text-gray-600">{i.stand}</td>
                    <td className="px-4 py-2 italic text-gray-500">{i.notes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className={`grid md:grid-cols-2 gap-8 ${!printSections.monitorMixes && !printSections.notes ? 'no-print' : ''}`}>
          <div className={printSections.monitorMixes ? '' : 'no-print'}>
            <h2 className="text-2xl font-bold mb-6 flex items-center gap-2">
              <span className="w-8 h-8 bg-black text-white flex items-center justify-center rounded text-sm">3</span>
              Monitor Mixes
            </h2>
            <div className="space-y-4">
              {band.monitors.map((m) => (
                <div key={m.mix} className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
                  <h3 className="font-bold flex items-center gap-2">
                    <span className="text-blue-600">Mix {m.mix}:</span> {m.name}
                    {/* Legacy mixes have no type — render nothing rather than
                        guess "Wedge", which would be a fact we do not have. */}
                    {m.type && (
                      <span className="text-xs font-medium text-gray-500 bg-gray-100 px-2 py-0.5 rounded">
                        {m.type}
                      </span>
                    )}
                  </h3>
                  <p className="text-sm text-gray-600 mt-1">{m.needs}</p>
                </div>
              ))}
            </div>
          </div>

          <div className={printSections.notes ? '' : 'no-print'}>
            <h2 className="text-2xl font-bold mb-6 flex items-center gap-2">
              <span className="w-8 h-8 bg-black text-white flex items-center justify-center rounded text-sm">4</span>
              Notes
            </h2>
            <ul className="space-y-3 text-sm text-gray-700 bg-yellow-50 p-6 rounded-xl border border-yellow-200">
              {band.notes.map((n, i) => (
                <li key={i}><strong>{n.label}:</strong> {n.text}</li>
              ))}
            </ul>
          </div>
        </section>

        {band.setlist && band.setlist.length > 0 && (
          <section className={printSections.setlist ? '' : 'no-print'}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-2xl font-bold flex items-center gap-2">
                <span className="w-8 h-8 bg-black text-white flex items-center justify-center rounded text-sm">5</span>
                Run Order / Setlist
              </h2>
              <div className="flex items-center gap-2 print:hidden">
                {allRoles.length > 0 && (
                  <select
                    value={effectiveRoleFilter}
                    onChange={(e) => handleRoleChange(e.target.value)}
                    className="text-xs border border-gray-300 rounded px-2 py-1.5 bg-white"
                  >
                    <option value="all">All Parts</option>
                    {allRoles.map((r) => <option key={r} value={r}>My Charts: {r}</option>)}
                  </select>
                )}
                {/* Owner-only: reordering the run order is an EDIT. §3.3c —
                    collaborators are view only, and the Mix tab is a surface
                    they can reach, so the gate lives here and not on the tab. */}
                {isOwner && (
                <button
                  onClick={() => setReorderMode(!reorderMode)}
                  className={`px-3 py-1.5 text-xs font-bold rounded transition-colors ${
                    reordering
                      ? 'bg-black text-white hover:bg-gray-800'
                      : 'bg-gray-100 border border-gray-300 hover:bg-gray-200'
                  }`}
                >
                  {reordering ? 'Done' : 'Reorder'}
                </button>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 mb-4 print:hidden">
              {legend.map(([name, color]) => (
                <span key={name} className={`px-2 py-0.5 rounded text-xs font-semibold ${color}`}>{name}</span>
              ))}
              {effectiveRoleFilter !== 'all' && (
                <span className="ml-auto text-xs text-gray-500 print:hidden">
                  {(band.setlist ?? []).filter((s) => (s.charts ?? []).some((c) => c.role === effectiveRoleFilter)).length} of {band.setlist?.length ?? 0} songs have {effectiveRoleFilter} charts
                </span>
              )}
            </div>
            {reordering ? (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={songIds} strategy={verticalListSortingStrategy}>
                  <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden print:hidden">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-gray-50 border-b">
                        <tr>
                          <th className="w-8 print:hidden"></th>
                          <th className="px-4 py-3 font-bold w-10">#</th>
                          <th className="px-4 py-3 font-bold">Song</th>
                          <th className="px-4 py-3 font-bold">Lead</th>
                          <th className="px-4 py-3 font-bold hidden sm:table-cell">Notes</th>
                          {showChartsColumn && <th className="px-4 py-3 font-bold w-12">Charts</th>}
                          <th className="w-12 print:hidden"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {band.setlist.map((song, idx) => (
                          <ShowSortableRow
                            key={song.id!}
                            song={song}
                            idx={idx}
                            total={band.setlist?.length ?? 0}
                            showChartsColumn={showChartsColumn}
                            colorMap={colorMap}
                            onNavigate={setNavigatorSongIdx}
                            onMoveUp={() => onReorder(idx, idx - 1)}
                            onMoveDown={() => onReorder(idx, idx + 1)}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                </SortableContext>
              </DndContext>
            ) : (
              <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden print:hidden">
              <table className="w-full text-left text-sm">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="px-4 py-3 font-bold w-10">#</th>
                    <th className="px-4 py-3 font-bold">Song</th>
                    <th className="px-4 py-3 font-bold">Lead</th>
                    <th className="px-4 py-3 font-bold hidden sm:table-cell">Notes</th>
                    {showChartsColumn && <th className="px-4 py-3 font-bold w-12">Charts</th>}
                  </tr>
                </thead>
                  <tbody className="divide-y">
                    {band.setlist.map((song, idx) => {
                      const singers = song.lead.split('+').map((n) => n.trim());
                      const songCharts = song.charts ?? [];
                      const hasDupes = songCharts.some((c) => (c.dupeCount ?? 0) > 1);
                      return (
                        <tr key={song.id ?? song.position} className="hover:bg-gray-50">
                          <td className="px-4 py-2 font-mono text-gray-400">{song.position}</td>
                          <td className="px-4 py-2 font-medium">
                            {song.title}
                            {song.key && (
                              <span className="ml-2 text-[10px] bg-gray-100 text-gray-700 px-1.5 py-0.5 rounded font-semibold border border-gray-200">
                                {song.key}
                              </span>
                            )}
                            {song.sceneNote && (
                              <span className="ml-2 text-[10px] bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded font-semibold">
                                {song.sceneNote}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2">
                            <div className="flex flex-wrap gap-1">
                              {singers.map((singer) => (
                                <span key={singer} className={`px-1.5 py-0.5 rounded text-xs font-semibold ${getSingerColor(singer, colorMap)}`}>
                                  {singer}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td className="px-4 py-2 text-gray-500 italic text-xs hidden sm:table-cell">
                            {song.notes}
                          </td>
                          {showChartsColumn && (
                            <td className="px-4 py-2">
                              <button
                                onClick={() => setNavigatorSongIdx(idx)}
                                className={`w-8 h-8 flex items-center justify-center rounded transition-colors ${
                                  songCharts.length > 0
                                    ? hasDupes
                                      ? 'bg-orange-100 text-orange-700 hover:bg-orange-200'
                                      : 'bg-blue-100 text-blue-700 hover:bg-blue-200'
                                    : 'text-gray-200 hover:text-gray-400 hover:bg-gray-100'
                                }`}
                                title={songCharts.length > 0 ? `${songCharts.length} chart${songCharts.length > 1 ? 's' : ''}` : 'No charts'}
                              >
                                <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z" />
                                </svg>
                              </button>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
              </table>
              </div>
            )}

            {/* Print-only cue sheet: two-column layout with density + overflow handling */}
            <div className="hidden print:block">
              {(() => {
                const songs = band.setlist ?? [];
                const densityClass = songs.length > 16 ? 'cue-sheet-compact' : '';

                if (songs.length >= 29) {
                  // CSS columns: sequential flow across columns and pages
                  return (
                    <div className={`cue-sheet ${densityClass}`}>
                      <ol className="cue-sheet-flow">
                        {songs.map((song) => (
                          <li key={song.id ?? song.position} className="cue-sheet-item">
                            <span className="cue-sheet-num">{song.position}.</span>
                            <span className="cue-sheet-title">{song.title}</span>
                            {song.key && <span className="cue-sheet-key">{song.key}</span>}
                          </li>
                        ))}
                      </ol>
                    </div>
                  );
                }

                // Manual two-column grid for <= 28 songs (proven single-page layout)
                const half = Math.ceil(songs.length / 2);
                const col1 = songs.slice(0, half);
                const col2 = songs.slice(half);
                return (
                  <div className={`cue-sheet ${densityClass}`}>
                    <div className="cue-sheet-grid">
                      <div className="cue-sheet-col">
                        {col1.map((song) => (
                          <div key={song.id ?? song.position} className="cue-sheet-item">
                            <span className="cue-sheet-num">{song.position}.</span>
                            <span className="cue-sheet-title">{song.title}</span>
                            {song.key && <span className="cue-sheet-key">{song.key}</span>}
                          </div>
                        ))}
                      </div>
                      <div className="cue-sheet-col">
                        {col2.map((song) => (
                          <div key={song.id ?? song.position} className="cue-sheet-item">
                            <span className="cue-sheet-num">{song.position}.</span>
                            <span className="cue-sheet-title">{song.title}</span>
                            {song.key && <span className="cue-sheet-key">{song.key}</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* Chart Navigator Overlay */}
            {navigatorSongIdx !== null && band.setlist[navigatorSongIdx] && (
              <ChartNavigator
                setlist={band.setlist}
                currentIdx={navigatorSongIdx}
                roleFilter={effectiveRoleFilter}
                allRoles={allRoles}
                isOffline={isOffline}
                accessToken={accessToken}
                isOwner={isOwner}
                owner={owner}
                slug={slug}
                onChangeIdx={setNavigatorSongIdx}
                onChangeRole={handleRoleChange}
                onClose={() => setNavigatorSongIdx(null)}
              />
            )}
          </section>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// CHART NAVIGATOR — inline PDF viewer with page controls
// ════════════════════════════════════════════════════════════════════════════

// Role colors removed — chart pill picker now uses active/inactive pattern

// ── Calibration overlay (realtime chart control, step 1: section rail) ──
// The canvas is max-w/max-h centered, so it's smaller than its container. A
// CanvasBox mirrors the canvas's actual rendered rect (relative to the shared
// container) so section anchors — stored normalized 0..1 in PDF space — land on
// the printed page rather than the letterboxed container.
interface CanvasBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

// DOM half of the CV barline snap (the pure half is lib/chart-snap.ts): turn an
// offscreen-rendered page canvas into a per-column darkness profile over a
// system's band rect. Each column's value is the fraction of STAFF rows whose
// pixel reads as dark ink. pdf.js paints ink onto a transparent canvas, so a
// pixel only counts when it is BOTH opaque and below the luma floor — that
// rejects the empty background (luma 0 but alpha 0) and white fills alike.
//
// Crucially the coverage denominator is the staff's vertical span, NOT the full
// band. Users (and the VLM) routinely draw a band taller than the printed staff;
// a barline only spans the staff, so against the padded band its coverage falls
// under MIN_COVERAGE and nothing is detected ("no clear barlines"). Staff lines
// run dark across most of the band width, so we find the first/last such row and
// crop to it — then a real barline reads ~1.0 regardless of band slack. If no
// staff rows are found (e.g. a slash/chord chart with no staff), we fall back to
// the full band. Manual-UAT only (vitest is environment:'node', no canvas).
function buildBandProfile(
  canvas: HTMLCanvasElement,
  system: { xStart: number; xEnd: number; yTop: number; yBottom: number },
): BandProfile | null {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const W = canvas.width;
  const H = canvas.height;
  const x0 = Math.max(0, Math.floor(system.xStart * W));
  const x1 = Math.min(W, Math.ceil(system.xEnd * W));
  const y0 = Math.max(0, Math.floor(system.yTop * H));
  const y1 = Math.min(H, Math.ceil(system.yBottom * H));
  const cols = x1 - x0;
  const rows = y1 - y0;
  if (cols <= 0 || rows <= 0) return null;

  // Single pixel pass: a 1-bit ink map plus the per-row dark count (for the
  // staff-extent crop). luma is only computed for opaque pixels.
  const data = ctx.getImageData(x0, y0, cols, rows).data;
  const ink = new Uint8Array(cols * rows);
  const rowInk = new Uint32Array(rows);
  for (let cy = 0; cy < rows; cy += 1) {
    let rc = 0;
    const base = cy * cols;
    for (let cx = 0; cx < cols; cx += 1) {
      const p = (base + cx) * 4;
      if (data[p + 3] <= 10) continue; // transparent background — not ink
      const luma = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      if (luma < DARK_LUMA) {
        ink[base + cx] = 1;
        rc += 1;
      }
    }
    rowInk[cy] = rc;
  }

  // Staff vertical extent: the topmost/bottommost rows dark across ≥ STAFF_ROW_FRAC
  // of the width (the printed staff lines). Crop coverage to that span.
  const staffRowMin = STAFF_ROW_FRAC * cols;
  let ry0 = 0;
  let ry1 = rows - 1;
  let first = -1;
  let last = -1;
  for (let cy = 0; cy < rows; cy += 1) {
    if (rowInk[cy] >= staffRowMin) {
      if (first < 0) first = cy;
      last = cy;
    }
  }
  if (first >= 0 && last > first) {
    ry0 = first;
    ry1 = last;
  }
  const winH = ry1 - ry0 + 1;

  const dark = new Float32Array(cols);
  for (let cx = 0; cx < cols; cx += 1) {
    let darkRows = 0;
    for (let cy = ry0; cy <= ry1; cy += 1) {
      if (ink[cy * cols + cx]) darkRows += 1;
    }
    dark[cx] = darkRows / winH;
  }
  return { cols, dark };
}

// Press-and-hold threshold: a quick tap seeks the redline to a section; a hold
// "parks" it there (step 1 has no transport, so both just park — hold is the
// forward-looking gesture for level-B follow).
const LONG_PRESS_MS = 450;

// A single section anchor: a modest label pill with a deliberately larger,
// transparent hit target (touch-friendly, esp. in Perform). In Perform a tap
// seeks and a long-press holds; in Calibrate a tap opens inline label editing.
function SectionMarker({
  section, box, mode, isSeeked, isHeld, isEditing, flagged, onSeek, onHold, onRelabel, onDelete, onBeginEdit,
}: {
  section: SectionAnchor;
  box: CanvasBox;
  mode: 'perform' | 'calibrate';
  flagged: boolean;
  isSeeked: boolean;
  isHeld: boolean;
  isEditing: boolean;
  onSeek: () => void;
  onHold: () => void;
  onRelabel: (label: string) => void;
  onDelete: () => void;
  onBeginEdit: () => void;
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heldRef = useRef(false);
  const left = box.left + section.x * box.width;
  const top = box.top + section.y * box.height;

  const clearTimer = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  };
  const onPointerDown = () => {
    if (mode !== 'perform') return;
    heldRef.current = false;
    clearTimer();
    timerRef.current = setTimeout(() => { heldRef.current = true; onHold(); }, LONG_PRESS_MS);
  };
  const onPointerUp = () => {
    if (mode !== 'perform') return;
    clearTimer();
    if (!heldRef.current) onSeek();
  };

  const pillState = isHeld
    ? 'bg-red-500 text-white ring-2 ring-red-300'
    : isSeeked
      ? 'bg-red-600/90 text-white'
      : mode === 'calibrate'
        ? section.label.trim() === ''
          ? 'bg-amber-500 text-black'
          : 'bg-sky-600 text-white'
        : 'bg-zinc-800/85 text-zinc-100 ring-1 ring-zinc-600';

  // The wrapper IS the single hit element — its handlers fire anywhere in its
  // box, and its p-2.5 padding makes that box larger than the visible pill (a
  // touch-friendly target, esp. in Perform). The pill is pointer-events-none so
  // it can never sit above the handlers and steal the tap; stopPropagation keeps
  // a marker tap from bubbling to the calibrate backdrop (which would drop one).
  return (
    <div
      data-chart-overlay-interactive
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerLeave={clearTimer}
      onPointerCancel={clearTimer}
      onClick={(e) => {
        e.stopPropagation();
        if (mode === 'calibrate' && !isEditing) onBeginEdit();
      }}
      className="absolute -translate-x-1/2 -translate-y-1/2 p-2.5"
      style={{ left, top, pointerEvents: 'auto', touchAction: 'manipulation' }}
    >
      {isEditing ? (
        <div
          className="flex items-center gap-1 rounded bg-zinc-900 ring-1 ring-sky-500 px-1 py-0.5 shadow-lg"
          style={{ pointerEvents: 'auto' }}
        >
          <input
            autoFocus
            defaultValue={section.label}
            onChange={(e) => onRelabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') onBeginEdit(); }}
            placeholder="Label…"
            className="w-24 bg-transparent text-xs text-white outline-none placeholder:text-zinc-500"
          />
          <button
            type="button"
            aria-label="Delete section"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="text-zinc-400 hover:text-red-400 text-sm leading-none px-1"
          >
            ×
          </button>
        </div>
      ) : (
        <span
          className={`block max-w-[8rem] truncate rounded px-1.5 py-0.5 text-[11px] font-bold shadow ${pillState} ${
            flagged ? 'outline-dashed outline-2 outline-offset-1 outline-amber-400' : ''
          }`}
          style={{ pointerEvents: 'none' }}
        >
          {flagged && <span aria-hidden className="mr-0.5">&#9873;</span>}
          {section.label.trim() === '' ? '(unlabeled)' : section.label}
        </span>
      )}
    </div>
  );
}

// A calibrated staff system: a translucent full-width band (the chunk-3
// creation tier). Tap to select; when selected it shows top/bottom drag handles
// (fit the band to the printed staff) and its barline ticks. When selected, each
// barline tick (N bars → N+1 boundaries) gets a wide invisible hit-strip so it
// can be dragged horizontally onto the real printed barline.
function SystemBand({
  system, bars, box, selected, flagged, addBarMode, selectedBoundaryIndex,
  onSelect, onAddBarline, onResizeStart, onBoundaryResizeStart,
}: {
  system: System;
  bars: Bar[];
  box: CanvasBox;
  selected: boolean;
  flagged: boolean;
  addBarMode: boolean;
  selectedBoundaryIndex: number | null;
  onSelect: () => void;
  onAddBarline: (x: number) => void;
  onResizeStart: (edge: 'top' | 'bottom', e: ReactPointerEvent<HTMLDivElement>) => void;
  onBoundaryResizeStart: (index: number, e: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const left = box.left + system.xStart * box.width;
  const top = box.top + system.yTop * box.height;
  const width = (system.xEnd - system.xStart) * box.width;
  const height = (system.yBottom - system.yTop) * box.height;
  const ordered = [...bars].sort((a, b) => a.xStart - b.xStart);
  // Boundary x-positions: each bar's leading edge, plus the last bar's closing
  // edge. Index aligns with moveBarBoundary's boundaryIndex (0..N).
  const boundaries =
    ordered.length > 0
      ? [...ordered.map((b) => b.xStart), ordered[ordered.length - 1].xEnd]
      : [];

  return (
    <>
      <div
        data-chart-overlay-interactive
        onClick={(e) => {
          e.stopPropagation();
          // In Add mode, a tap inside the selected band splits the measure under
          // x; otherwise it (de)selects the band.
          if (selected && addBarMode) {
            const r = e.currentTarget.getBoundingClientRect();
            const xNorm = system.xStart + ((e.clientX - r.left) / r.width) * (system.xEnd - system.xStart);
            onAddBarline(xNorm);
          } else {
            onSelect();
          }
        }}
        className={`absolute ${selected ? 'bg-sky-500/15 ring-2 ring-sky-400' : 'bg-zinc-400/10 ring-1 ring-zinc-500'} ${
          selected && addBarMode ? 'cursor-copy' : ''
        } ${
          flagged ? 'outline-dashed outline-2 outline-offset-1 outline-amber-400' : ''
        }`}
        style={{ left, top, width, height, pointerEvents: 'auto', touchAction: 'manipulation', zIndex: selected ? 20 : 10 }}
      >
        {selected && (
          <span className="absolute -top-4 left-0 text-[10px] font-bold text-sky-300">
            {ordered.length} bar{ordered.length === 1 ? '' : 's'}
          </span>
        )}
        {flagged && (
          <span aria-hidden className="absolute -top-3 right-0 text-[11px] font-bold text-amber-400">&#9873;</span>
        )}
      </div>
      {/* Barline ticks (leading edge of each bar + the closing edge). */}
      {ordered.map((b) => (
        <div
          key={b.id}
          className="absolute w-px bg-sky-400/70"
          style={{ left: box.left + b.xStart * box.width, top, height, pointerEvents: 'none' }}
        />
      ))}
      {ordered.length > 0 && (
        <div
          className="absolute w-px bg-sky-400/70"
          style={{ left: box.left + ordered[ordered.length - 1].xEnd * box.width, top, height, pointerEvents: 'none' }}
        />
      )}
      {/* Grabbable barline hit-strips (selected only): drag a tick onto the
          real printed barline. Wide invisible target over the thin visual line. */}
      {selected && boundaries.map((bx, i) => (
        <div
          key={`b${i}`}
          data-chart-overlay-interactive
          onPointerDown={(e) => onBoundaryResizeStart(i, e)}
          onClick={(e) => e.stopPropagation()}
          className={`absolute w-3.5 -translate-x-1/2 cursor-ew-resize ${
            i === selectedBoundaryIndex ? 'bg-red-500/40 ring-1 ring-red-400' : 'hover:bg-sky-400/20'
          }`}
          style={{
            left: box.left + bx * box.width,
            top,
            height,
            pointerEvents: 'auto',
            touchAction: 'none',
            zIndex: 21,
          }}
        />
      ))}
      {/* Top/bottom resize handles (selected only). */}
      {selected && (['top', 'bottom'] as const).map((edge) => (
        <div
          key={edge}
          data-chart-overlay-interactive
          onPointerDown={(e) => onResizeStart(edge, e)}
          onClick={(e) => e.stopPropagation()}
          className="absolute h-3 -translate-y-1/2 cursor-ns-resize bg-sky-400/40 hover:bg-sky-400/70"
          style={{
            left,
            top: edge === 'top' ? top : top + height,
            width,
            pointerEvents: 'auto',
            touchAction: 'none',
            zIndex: 21,
          }}
        />
      ))}
    </>
  );
}

// Short, font-safe label for a placed roadmap marker glyph.
function roadmapMarkerLabel(m: RoadmapMarker): string {
  switch (m.kind) {
    case 'repeatStart': return '|:';
    case 'repeatEnd': return `:|\u00d7${m.times ?? 2}`;
    case 'segno': return 'Segno';
    case 'coda': return 'Coda';
    case 'toCoda': return 'To Coda';
    case 'fine': return 'Fine';
    case 'jump': {
      const head = m.from === 'capo' ? 'D.C.' : 'D.S.';
      const tail = m.until === 'fine' ? ' al Fine' : m.until === 'coda' ? ' al Coda' : '';
      return head + tail;
    }
    case 'ending': return `[${m.numbers.join(',')}]`;
  }
}

// Roadmap-tool visual layer: faint system bands + bar dividers (so bars are
// visible to tap), the selected-bar / ending-draft highlights, and a badge per
// placed marker at its bar edge (red ring = part of the live-resolve error,
// sky ring = selected for deletion). Bars are tapped through the overlay surface
// (tapToBar); only the marker badges capture their own clicks. All visuals are
// pointer-events:none except the badges.
function RoadmapOverlayLayer({
  calibration, box, page, selectedBarId, selectedMarkerId, endingBarIds, resolveErrorIds, flaggedMarkerIds, onSelectMarker,
}: {
  calibration: ChartCalibration;
  box: CanvasBox;
  page: number;
  selectedBarId: string | null;
  selectedMarkerId: string | null;
  endingBarIds: string[] | null;
  resolveErrorIds: Set<string>;
  flaggedMarkerIds: Set<string>;
  onSelectMarker: (id: string) => void;
}) {
  const systems = systemsForPage(calibration, page);
  const sysOnPage = new Set(systems.map((s) => s.id));
  const bars = (calibration.bars ?? []).filter((b) => sysOnPage.has(b.systemId));
  const barById = new Map((calibration.bars ?? []).map((b) => [b.id, b] as const));
  const sysById = new Map((calibration.systems ?? []).map((s) => [s.id, s] as const));
  const endingSet = new Set(endingBarIds ?? []);

  // Screen geometry for one bar (or null if its system isn't on this page).
  const barRect = (barId: string) => {
    const b = barById.get(barId);
    const s = b ? sysById.get(b.systemId) : null;
    if (!b || !s || s.page !== page) return null;
    return {
      left: box.left + b.xStart * box.width,
      right: box.left + b.xEnd * box.width,
      top: box.top + s.yTop * box.height,
      bottom: box.top + s.yBottom * box.height,
    };
  };

  return (
    <>
      {/* Faint bands so the roadmap tool shows where bars are. */}
      {systems.map((s) => (
        <div
          key={s.id}
          className="absolute bg-zinc-400/5 ring-1 ring-zinc-600/40"
          style={{
            left: box.left + s.xStart * box.width,
            top: box.top + s.yTop * box.height,
            width: (s.xEnd - s.xStart) * box.width,
            height: (s.yBottom - s.yTop) * box.height,
            pointerEvents: 'none',
          }}
        />
      ))}
      {/* Bar dividers + selected / ending-draft highlights. */}
      {bars.map((b) => {
        const r = barRect(b.id);
        if (!r) return null;
        const highlight = b.id === selectedBarId ? 'bg-sky-500/20 ring-1 ring-sky-400'
          : endingSet.has(b.id) ? 'bg-amber-500/20 ring-1 ring-amber-400'
          : '';
        return (
          <div key={b.id} className={`absolute ${highlight}`}
            style={{ left: r.left, top: r.top, width: r.right - r.left, height: r.bottom - r.top, pointerEvents: 'none' }}>
            <div className="absolute top-0 bottom-0 left-0 w-px bg-zinc-500/50" />
          </div>
        );
      })}
      {/* Placed marker badges. */}
      {(calibration.roadmap ?? []).map((m) => {
        if (m.kind === 'ending') {
          const first = barRect(m.barIds[0]);
          const last = barRect(m.barIds[m.barIds.length - 1]);
          if (!first || !last) return null;
          const isErr = resolveErrorIds.has(m.id);
          const isSel = m.id === selectedMarkerId;
          const isFlagged = !isErr && !isSel && flaggedMarkerIds.has(m.id);
          return (
            <button key={m.id} onClick={(e) => { e.stopPropagation(); onSelectMarker(m.id); }}
              data-chart-overlay-interactive
              className={`absolute text-[9px] font-bold rounded px-1 border-t-2 ${
                isErr ? 'border-red-500 text-red-300 bg-red-950/60'
                : isSel ? 'border-sky-400 text-sky-200 bg-sky-950/60'
                : isFlagged ? 'border-amber-400 text-amber-200 bg-zinc-900/80 outline-dashed outline-2 outline-offset-1 outline-amber-400'
                : 'border-amber-400 text-amber-200 bg-zinc-900/80'}`}
              style={{ left: first.left, top: first.top - 16, width: last.right - first.left, pointerEvents: 'auto' }}>
              {isFlagged && <span aria-hidden className="mr-0.5">&#9873;</span>}
              {roadmapMarkerLabel(m)}
            </button>
          );
        }
        const r = barRect(m.barId);
        if (!r) return null;
        const atStart = m.edge === 'start';
        const x = atStart ? r.left : r.right;
        const isErr = resolveErrorIds.has(m.id);
        const isSel = m.id === selectedMarkerId;
        const isFlagged = !isErr && !isSel && flaggedMarkerIds.has(m.id);
        return (
          <button key={m.id} onClick={(e) => { e.stopPropagation(); onSelectMarker(m.id); }}
            data-chart-overlay-interactive
            className={`absolute text-[9px] font-bold rounded px-1 whitespace-nowrap -translate-x-1/2 ${
              isErr ? 'ring-1 ring-red-500 text-red-300 bg-red-950/80'
              : isSel ? 'ring-1 ring-sky-400 text-sky-200 bg-sky-950/80'
              : isFlagged ? 'ring-1 ring-zinc-600 text-zinc-200 bg-zinc-900/90 outline-dashed outline-2 outline-offset-1 outline-amber-400'
              : 'ring-1 ring-zinc-600 text-zinc-200 bg-zinc-900/90'}`}
            style={{ left: x, top: r.top - 16, pointerEvents: 'auto' }}>
            {isFlagged && <span aria-hidden className="mr-0.5">&#9873;</span>}
            {roadmapMarkerLabel(m)}
          </button>
        );
      })}
    </>
  );
}

// Absolutely fills the viewer container. In section-rail Perform the container
// is pointer-events-none so taps between markers fall through to the page-turn
// handler; markers re-enable pointer events on themselves. In Calibrate (and in
// bar-level Perform) the container captures clicks (tagged interactive so the
// window page-turn handler ignores it) — a calibrate Sections-tool click drops a
// section, a Bars-tool click drops a staff system, and a bar-mode click seeks
// the redline to the nearest bar.
function CalibrationOverlay({
  calibration, box, page, mode, calTool, seekId, holdId, editingId,
  barMode, barRedline, onBarTap,
  selectedSystemId, onDropSystem, onSelectSystem, onResizeSystem, onMoveBoundary,
  addBarMode, selectedBoundary, onAddBarline, onTapBoundary,
  onDrop, onSeek, onHold, onRelabel, onDelete, onBeginEdit,
  selectedBarId, selectedMarkerId, endingBarIds, resolveErrorIds,
  flaggedSectionIds, flaggedSystemIds, flaggedMarkerIds,
  onRoadmapBarTap, onSelectMarker,
}: {
  calibration: ChartCalibration | null;
  box: CanvasBox;
  page: number;
  mode: 'perform' | 'calibrate';
  calTool: 'sections' | 'bars' | 'roadmap';
  seekId: string | null;
  holdId: string | null;
  editingId: string | null;
  barMode: boolean;
  barRedline: { bar: Bar; system: System } | null;
  onBarTap: (x: number, y: number) => void;
  selectedSystemId: string | null;
  onDropSystem: (y: number) => void;
  onSelectSystem: (id: string | null) => void;
  onResizeSystem: (id: string, yTop: number, yBottom: number) => void;
  onMoveBoundary: (systemId: string, boundaryIndex: number, x: number) => void;
  addBarMode: boolean;
  selectedBoundary: { systemId: string; index: number } | null;
  onAddBarline: (systemId: string, x: number) => void;
  onTapBoundary: (systemId: string, index: number) => void;
  onDrop: (x: number, y: number) => void;
  onSeek: (id: string) => void;
  onHold: (id: string) => void;
  onRelabel: (id: string, label: string) => void;
  onDelete: (id: string) => void;
  onBeginEdit: (id: string | null) => void;
  selectedBarId: string | null;
  selectedMarkerId: string | null;
  endingBarIds: string[] | null;
  resolveErrorIds: Set<string>;
  flaggedSectionIds: Set<string>;
  flaggedSystemIds: Set<string>;
  flaggedMarkerIds: Set<string>;
  onRoadmapBarTap: (barId: string) => void;
  onSelectMarker: (id: string) => void;
}) {
  const roadmapTool = mode === 'calibrate' && calTool === 'roadmap';
  // Which element types are live this frame. Sections show in section-rail
  // Perform and in the Sections calibrate tool; systems show in the Bars tool.
  const showSystems = mode === 'calibrate' && calTool === 'bars';
  const showSectionMarkers = !barMode && (mode === 'perform' || calTool === 'sections');
  const sections = showSectionMarkers && calibration ? sectionsForPage(calibration, page) : [];
  const systemsOnPage = showSystems && calibration ? systemsForPage(calibration, page) : [];
  const allBars = calibration?.bars ?? [];
  const seeked = calibration?.sections.find((s) => s.id === seekId) ?? null;
  const redlineOnPage = !barMode && seeked && seeked.page === page ? seeked : null;
  const interactive = mode === 'calibrate' || barMode;

  // Drag of a calibration gizmo: a system band's top/bottom edge (vertical) or a
  // barline boundary within a selected system (horizontal). The handler is
  // subscribed once and reads the live box + callbacks through refs, so a
  // re-render mid-drag (the calibration updates on every move) can't strand the
  // listener or lose the gesture.
  const overlayRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<
    | { kind: 'band'; id: string; edge: 'top' | 'bottom'; other: number }
    | { kind: 'boundary'; systemId: string; index: number; startX: number; startY: number; moved: boolean }
    | null
  >(null);
  const boxRef = useRef(box);
  const onResizeRef = useRef(onResizeSystem);
  const onMoveBoundaryRef = useRef(onMoveBoundary);
  const onTapBoundaryRef = useRef(onTapBoundary);
  // Keep the drag-loop's refs current without re-subscribing the listener.
  useEffect(() => {
    boxRef.current = box;
    onResizeRef.current = onResizeSystem;
    onMoveBoundaryRef.current = onMoveBoundary;
    onTapBoundaryRef.current = onTapBoundary;
  });
  useEffect(() => {
    const move = (e: globalThis.PointerEvent) => {
      const d = dragRef.current;
      const ov = overlayRef.current;
      if (!d || !ov) return;
      const b = boxRef.current;
      const r = ov.getBoundingClientRect();
      if (d.kind === 'band') {
        if (!b.height) return;
        let ny = (e.clientY - r.top - b.top) / b.height;
        ny = ny < 0 ? 0 : ny > 1 ? 1 : ny;
        if (d.edge === 'top') onResizeRef.current(d.id, ny, d.other);
        else onResizeRef.current(d.id, d.other, ny);
      } else {
        if (!b.width) return;
        // Below a small threshold the gesture is still a candidate TAP (select a
        // tick to remove); only once it clearly moves does it become a drag.
        if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) return;
        d.moved = true;
        let nx = (e.clientX - r.left - b.left) / b.width;
        nx = nx < 0 ? 0 : nx > 1 ? 1 : nx;
        onMoveBoundaryRef.current(d.systemId, d.index, nx);
      }
    };
    const up = (e: globalThis.PointerEvent) => {
      const d = dragRef.current;
      if (d && d.kind === 'boundary') {
        // Classify on the release displacement, not just prior pointermove
        // events: a release within the threshold (no real drag delivered) is a
        // TAP → select for removal; anything past it is a drag we've already
        // tracked, so apply its final position here too in case no pointermove
        // landed between press and release.
        const released = Math.hypot(e.clientX - d.startX, e.clientY - d.startY);
        if (!d.moved && released < 4) {
          onTapBoundaryRef.current(d.systemId, d.index);
        } else {
          const ov = overlayRef.current;
          const b = boxRef.current;
          if (ov && b.width) {
            const r = ov.getBoundingClientRect();
            let nx = (e.clientX - r.left - b.left) / b.width;
            nx = nx < 0 ? 0 : nx > 1 ? 1 : nx;
            onMoveBoundaryRef.current(d.systemId, d.index, nx);
          }
        }
      }
      dragRef.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, []);

  const beginResize = (sys: System, edge: 'top' | 'bottom', e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    dragRef.current = { kind: 'band', id: sys.id, edge, other: edge === 'top' ? sys.yBottom : sys.yTop };
    // Capture so a finger/cursor that slides off the thin handle keeps driving
    // the drag (and pointerup still fires to end it).
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
  };

  const beginBoundary = (sys: System, index: number, e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    dragRef.current = { kind: 'boundary', systemId: sys.id, index, startX: e.clientX, startY: e.clientY, moved: false };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
  };

  const onSurface = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!interactive) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left - box.left;
    const py = e.clientY - rect.top - box.top;
    if (px < 0 || py < 0 || px > box.width || py > box.height) return;
    if (barMode) { onBarTap(px / box.width, py / box.height); return; }
    if (roadmapTool) {
      // Tap a bar → select it for the palette (or extend the volta draft). A tap
      // on empty space (no bar) is ignored. Marker badges capture their own taps.
      if (!calibration) return;
      const bar = tapToBar(calibration, page, px / box.width, py / box.height);
      if (bar) onRoadmapBarTap(bar.id);
      return;
    }
    if (calTool === 'bars') {
      // A backdrop tap deselects if something's selected, else drops a new
      // full-width system band at the tap's height.
      if (selectedSystemId) { onSelectSystem(null); return; }
      onDropSystem(py / box.height);
      return;
    }
    // Sections tool: dismiss an open editor, else drop a section.
    if (editingId) { onBeginEdit(null); return; }
    onDrop(px / box.width, py / box.height);
  };

  // The current bar's region, rendered only when its system is on this page.
  const barOnPage = barRedline && barRedline.system.page === page ? barRedline : null;
  const barLeft = barOnPage ? box.left + barOnPage.bar.xStart * box.width : 0;
  const barTop = barOnPage ? box.top + barOnPage.system.yTop * box.height : 0;
  const barWidth = barOnPage ? (barOnPage.bar.xEnd - barOnPage.bar.xStart) * box.width : 0;
  const barHeight = barOnPage ? (barOnPage.system.yBottom - barOnPage.system.yTop) * box.height : 0;

  return (
    <div
      ref={overlayRef}
      data-chart-overlay-interactive={interactive ? '' : undefined}
      onClick={onSurface}
      className="absolute inset-0"
      style={{ pointerEvents: interactive ? 'auto' : 'none' }}
    >
      {roadmapTool && calibration && (
        <RoadmapOverlayLayer
          calibration={calibration}
          box={box}
          page={page}
          selectedBarId={selectedBarId}
          selectedMarkerId={selectedMarkerId}
          endingBarIds={endingBarIds}
          resolveErrorIds={resolveErrorIds}
          flaggedMarkerIds={flaggedMarkerIds}
          onSelectMarker={onSelectMarker}
        />
      )}
      {systemsOnPage.map((sys) => (
        <SystemBand
          key={sys.id}
          system={sys}
          box={box}
          bars={allBars.filter((b) => b.systemId === sys.id)}
          selected={sys.id === selectedSystemId}
          flagged={flaggedSystemIds.has(sys.id)}
          addBarMode={addBarMode}
          selectedBoundaryIndex={selectedBoundary && selectedBoundary.systemId === sys.id ? selectedBoundary.index : null}
          onSelect={() => onSelectSystem(sys.id)}
          onAddBarline={(x) => onAddBarline(sys.id, x)}
          onResizeStart={(edge, e) => beginResize(sys, edge, e)}
          onBoundaryResizeStart={(index, e) => beginBoundary(sys, index, e)}
        />
      ))}
      {redlineOnPage && (
        <div
          className="absolute h-0.5 bg-red-600 shadow-[0_0_6px_rgba(220,38,38,0.8)]"
          style={{
            left: box.left,
            top: box.top + redlineOnPage.y * box.height,
            width: box.width,
            pointerEvents: 'none',
          }}
        />
      )}
      {barOnPage && (
        <>
          {/* Current-bar highlight. */}
          <div
            className="absolute bg-red-500/15 ring-1 ring-red-500/40"
            style={{ left: barLeft, top: barTop, width: barWidth, height: barHeight, pointerEvents: 'none' }}
          />
          {/* Leading-edge sweep cursor — moves L→R as the redline advances. */}
          <div
            className="absolute w-0.5 bg-red-600 shadow-[0_0_6px_rgba(220,38,38,0.8)]"
            style={{ left: barLeft, top: barTop, height: barHeight, pointerEvents: 'none' }}
          />
        </>
      )}
      {sections.map((s) => (
        <SectionMarker
          key={s.id}
          section={s}
          box={box}
          mode={mode}
          isSeeked={s.id === seekId}
          isHeld={s.id === holdId}
          isEditing={s.id === editingId}
          flagged={flaggedSectionIds.has(s.id)}
          onSeek={() => onSeek(s.id)}
          onHold={() => onHold(s.id)}
          onRelabel={(label) => onRelabel(s.id, label)}
          onDelete={() => onDelete(s.id)}
          onBeginEdit={() => onBeginEdit(editingId === s.id ? null : s.id)}
        />
      ))}
    </div>
  );
}

// A single marker-palette button (uniform styling; disables on duplicate kind
// or unmet precondition).
function PaletteBtn({ label, title, onClick, disabled }: {
  label: string;
  title?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="px-2 py-1 rounded bg-zinc-800 text-zinc-200 font-bold hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
    >
      {label}
    </button>
  );
}

// Inline −/+ number stepper (repeat-count ×N, ending number) with a floor.
function NumStepper({ label, value, min, onChange }: {
  label: string;
  value: number;
  min: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex items-center gap-0.5 shrink-0">
      <span className="text-zinc-500">{label}</span>
      <button
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
        className="w-5 h-5 rounded bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed"
      >
        &minus;
      </button>
      <span className="w-4 text-center font-bold text-white">{value}</span>
      <button onClick={() => onChange(value + 1)} className="w-5 h-5 rounded bg-zinc-800 text-zinc-200 hover:bg-zinc-700">+</button>
    </div>
  );
}

// Roadmap-tool toolbar: the marker palette (acts on the selected bar), the
// volta-bracket draw controls (while an ending is being drawn), a Delete button
// (when a placed marker is selected), and the live-resolve readout (green play
// order or red contradiction). Empty geometry shows a hint to add bars first.
// Duplicate marker kinds disable; repeat-end and endings require an enclosing |:.
function RoadmapToolbar({
  hasBars, selectedBar, selectedMarkerId, markerKindsOnBar, globalSingletonsUsed, boundRepeatStartId,
  endingDraft, nextTimes, nextUntil, playOrder, resolveError,
  onSetTimes, onSetUntil, onRepeatStart, onRepeatEnd, onSegno, onCoda, onToCoda,
  onFine, onJump, onBeginEnding, onConfirmEnding, onCancelEnding, onSetEndingNumber, onDeleteMarker,
}: {
  hasBars: boolean;
  selectedBar: Bar | null;
  selectedMarkerId: string | null;
  markerKindsOnBar: Set<RoadmapMarker['kind']>;
  globalSingletonsUsed: Set<RoadmapMarker['kind']>;
  boundRepeatStartId: string | null;
  endingDraft: { barIds: string[]; number: number } | null;
  nextTimes: number;
  nextUntil: 'end' | 'fine' | 'coda';
  playOrder: string;
  resolveError: string | null;
  onSetTimes: (n: number) => void;
  onSetUntil: (u: 'end' | 'fine' | 'coda') => void;
  onRepeatStart: () => void;
  onRepeatEnd: () => void;
  onSegno: () => void;
  onCoda: () => void;
  onToCoda: () => void;
  onFine: () => void;
  onJump: (from: 'capo' | 'segno') => void;
  onBeginEnding: () => void;
  onConfirmEnding: () => void;
  onCancelEnding: () => void;
  onSetEndingNumber: (n: number) => void;
  onDeleteMarker: (id: string) => void;
}) {
  const readout = resolveError ? (
    <span className="text-red-400 truncate">&#10005; {resolveError}</span>
  ) : playOrder ? (
    <span className="text-emerald-400 truncate">plays: {playOrder}</span>
  ) : null;

  // No geometry yet — nothing to place markers on.
  if (!hasBars) {
    return (
      <p className="text-[11px] text-zinc-400 truncate">
        Add bars first (Bars tool), then tap a bar to place repeats, endings, and jumps.
      </p>
    );
  }

  // Volta-bracket draw: extend the run by tapping adjacent bars, set the ending
  // number, confirm or cancel.
  if (endingDraft) {
    const n = endingDraft.barIds.length;
    return (
      <div className="flex items-center gap-2 text-[11px] text-zinc-300 min-w-0">
        <span className="font-bold text-sky-300 shrink-0">Ending</span>
        <span className="text-zinc-400 truncate">{n} bar{n === 1 ? '' : 's'} · tap adjacent bars</span>
        <NumStepper label="#" value={endingDraft.number} min={1} onChange={onSetEndingNumber} />
        <button
          onClick={onConfirmEnding}
          disabled={n === 0}
          className="px-2 py-1 rounded bg-emerald-600 text-white font-bold hover:bg-emerald-500 disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
        >
          Confirm
        </button>
        <button onClick={onCancelEnding} className="px-2 py-1 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 shrink-0">
          Cancel
        </button>
      </div>
    );
  }

  // A placed marker is selected → delete-to-resolve escape hatch.
  if (selectedMarkerId) {
    return (
      <div className="flex items-center gap-2 text-[11px] min-w-0">
        <button
          onClick={() => onDeleteMarker(selectedMarkerId)}
          className="px-2 py-1 rounded bg-red-600 text-white font-bold hover:bg-red-500 shrink-0"
        >
          Delete marker
        </button>
        {readout}
      </div>
    );
  }

  // No bar selected → hint + current readout.
  if (!selectedBar) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-zinc-400 min-w-0">
        <span className="truncate">Tap a bar to place a marker · tap a glyph to delete</span>
        {readout}
      </div>
    );
  }

  // Bar selected → the marker palette.
  const has = (k: RoadmapMarker['kind']) => markerKindsOnBar.has(k);
  return (
    <div className="flex items-center gap-1.5 text-[11px] min-w-0">
      <span className="text-zinc-500 shrink-0">Bar {selectedBar.absNumber}</span>
      <PaletteBtn label="|:" title="Repeat start" onClick={onRepeatStart} disabled={has('repeatStart')} />
      <div className="flex items-center gap-1 shrink-0">
        <PaletteBtn label=":|" title="Repeat end" onClick={onRepeatEnd} disabled={!boundRepeatStartId || has('repeatEnd')} />
        <NumStepper label={'\u00d7'} value={nextTimes} min={2} onChange={onSetTimes} />
      </div>
      <PaletteBtn label="Ending" title="1st/2nd ending (volta)" onClick={onBeginEnding} disabled={!boundRepeatStartId} />
      <PaletteBtn label="Segno" title="One per chart" onClick={onSegno} disabled={globalSingletonsUsed.has('segno')} />
      <PaletteBtn label="Coda" title="One per chart" onClick={onCoda} disabled={globalSingletonsUsed.has('coda')} />
      <PaletteBtn label="To Coda" onClick={onToCoda} disabled={has('toCoda')} />
      <PaletteBtn label="Fine" title="One per chart" onClick={onFine} disabled={globalSingletonsUsed.has('fine')} />
      <PaletteBtn label="D.C." title="Da Capo" onClick={() => onJump('capo')} disabled={has('jump')} />
      <PaletteBtn label="D.S." title="Dal Segno" onClick={() => onJump('segno')} disabled={has('jump')} />
      <select
        value={nextUntil}
        onChange={(e) => onSetUntil(e.target.value as 'end' | 'fine' | 'coda')}
        title="Jump destination"
        className="bg-zinc-800 text-zinc-200 rounded px-1 py-1 text-[11px] shrink-0"
      >
        <option value="end">(to end)</option>
        <option value="fine">al Fine</option>
        <option value="coda">al Coda</option>
      </select>
      {readout}
    </div>
  );
}

// ── 3b chunk 5: the join/go-live footer form (design-conductor-3b §3, mockup P3) ──
// One slim strip asking for exactly what's missing before connecting: the room
// code (join, unless the QR carried it) and the device name (both flows — the
// socket is keyed on the label, so it must settle BEFORE the first connect).
// Locked Q3: name prefills from the last-used device label; typing overrides.
function RelayPromptForm({
  kind,
  initialCode,
  onSubmit,
  onCancel,
}: {
  kind: 'join' | 'live';
  initialCode: string; // '' = ask; QR deep links arrive with it filled
  onSubmit: (code: string, label: string) => void;
  onCancel: () => void;
}) {
  const [code, setCode] = useState(initialCode);
  const [label, setLabel] = useState(() => loadDeviceLabel());
  const needCode = kind === 'join';
  const ready = (!needCode || isRoomCodeShaped(code)) && label.trim().length > 0;
  return (
    <form
      className="flex items-center justify-center gap-2 px-3 py-1.5 text-xs bg-zinc-900 border-t border-zinc-800"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onSubmit(code, label.trim());
      }}
    >
      <span className="text-zinc-400">{kind === 'join' ? 'Join the room' : 'Go live'}</span>
      {needCode && (
        <input
          value={code}
          onChange={(e) => setCode(normalizeRoomCode(e.target.value))}
          placeholder="CODE"
          autoFocus={initialCode === ''}
          className="w-20 px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-white font-mono uppercase tracking-[0.2em] text-center"
          aria-label="Room code"
        />
      )}
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Your name"
        autoFocus={!needCode || initialCode !== ''}
        className="w-32 px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-white"
        aria-label="Your name"
      />
      <button
        type="submit"
        disabled={!ready}
        className="px-3 py-1 rounded bg-emerald-600 text-white font-bold hover:bg-emerald-500 disabled:opacity-30 disabled:cursor-not-allowed"
      >
        {kind === 'join' ? 'Join' : 'Go live'}
      </button>
      <button type="button" onClick={onCancel} className="text-zinc-500 underline hover:text-white">
        Cancel
      </button>
    </form>
  );
}

function ChartNavigator({
  setlist, currentIdx, roleFilter, allRoles, isOffline, accessToken, isOwner = false, owner, slug, onChangeIdx, onChangeRole, onClose, joinCode = null, initialChartRole = null,
}: {
  setlist: SetlistSong[];
  currentIdx: number;
  roleFilter: string;
  allRoles: string[];
  isOffline: boolean;
  accessToken?: string;
  isOwner?: boolean;
  owner: string;
  slug: string;
  onChangeIdx: (idx: number) => void;
  onChangeRole: (role: string) => void;
  onClose: () => void;
  // 3b chunk 5: a QR deep link's room code (?join=CODE) — auto-joins the room.
  joinCode?: string | null;
  // Share deep link's chart role (?chart=ROLE) — selects that chart on open.
  initialChartRole?: string | null;
}) {
  const song = setlist[currentIdx];
  const charts = (song?.charts ?? []).filter(
    (c) => roleFilter === 'all' || c.role === roleFilter
  );
  const [activeChartIdx, setActiveChartIdx] = useState(0);
  const [pageNum, setPageNum] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [loading, setLoading] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<import('pdfjs-dist').PDFDocumentProxy | null>(null);
  const prevSongIdxRef = useRef(currentIdx);
  const prevPageNumRef = useRef(1);

  // ── Chart calibration (realtime chart control, step 1: section rail) ──
  const [calModeState, setCalMode] = useState<'perform' | 'calibrate'>('perform');
  // ★ Third instance of ONE defect: /[owner]/[show] re-renders rather than
  // remounting on a show change, so component state survives it. `tab` and
  // `reorderMode` were the first two; this is the same trap one level deeper.
  // An owner in Calibrate who opens a show they only collaborate on kept the
  // calibration toolbar and overlay, because the entry button is gated on
  // `calibratable` but every render below reads `calMode` alone.
  //
  // Derived under the ORIGINAL name on purpose: it closes all 17 read sites at
  // once, including the `=== 'perform'` branches, which is what keeps the
  // navigator rendering normally for a collaborator instead of going blank.
  const calMode = isOwner ? calModeState : 'perform';
  const [calibration, setCalibration] = useState<ChartCalibration | null>(null);
  // Latest-value mirror of calibration: the async snap reads this AFTER its
  // offscreen render so it matches+applies against the freshest geometry, never
  // a snapshot captured before any concurrent add/remove/drag/stepper edit.
  const calibrationRef = useRef(calibration);
  const [sourceHash, setSourceHash] = useState<string | null>(null);
  // Perform-readiness load/status signals (design-perform-readiness.md §3.1/§3.2).
  // loadError: the PDF bytes OR the calibration fetch failed — distinct from a
  // clean 404 (genuinely no map). calUnreadable: a row EXISTS but this build
  // refused it (owner-only 409); never collapse either into `none`.
  const [loadError, setLoadError] = useState(false);
  const [calUnreadable, setCalUnreadable] = useState<{
    reason: 'unsupported-schema' | 'invalid';
  } | null>(null);
  const [seekId, setSeekId] = useState<string | null>(null);
  const [holdId, setHoldId] = useState<string | null>(null);
  // Position in the PLAYED traversal (index, not bar id): a bar can recur across
  // passes (repeats/voltas), so the index is what disambiguates which pass we're on.
  const [barSeekIdx, setBarSeekIdx] = useState<number | null>(null);
  // "Local MD mode" toggle (Q2): explicitly take the baton. OFF lets the player
  // rehearse with the free self-drive seek without minting/advancing a session.
  // (3b chunk 5 dropped the owner gate: owner ≠ conductor — anyone in the show
  // can conduct; the relay's single-writer arbitration is the only authority.)
  const [conducting, setConducting] = useState(false);

  // ── 3b chunk 5: relay intent (design-conductor-3b §10-5) ──
  // The device's own decision about the room; the HOOK owns all wire truth.
  // 'prompt-join' / 'prompt-live' swap the footer for the one missing input
  // (code and/or name) — label must be settled BEFORE connecting, because the
  // socket is keyed on it (a label change mid-baton would drop the writer).
  const relayUrl = process.env.NEXT_PUBLIC_RELAY_URL ?? null;
  // Cloud-relay D4: 'live' carries NO code — the RELAY mints the room code and
  // the hook surfaces it (conductor.relay.room) once `joined` lands; the QR and
  // room chip render from that. 'joined' still carries the code the member
  // typed/scanned (it IS the room name on the shared relay).
  const [relayIntent, setRelayIntent] = useState<
    | { mode: 'off' }
    | { mode: 'prompt-join'; code: string }
    | { mode: 'prompt-live' }
    | { mode: 'joined'; code: string; label: string }
    | { mode: 'live'; label: string }
  >({ mode: 'off' });
  const [showQr, setShowQr] = useState(false);
  // Rising-edge latch: go-live claims the baton ONCE per live intent; a later
  // orphan re-claim is the user's deliberate strip tap, never automatic.
  const goLiveClaimedRef = useRef(false);

  // A QR deep link auto-joins: stored label goes straight in; no label yet →
  // the footer asks for the name first (code already known).
  useEffect(() => {
    if (!joinCode || relayUrl === null) return;
    // Deferred setState (the repo's set-state-in-effect discipline).
    let cancelled = false;
    Promise.resolve().then(() => {
      if (cancelled) return;
      setRelayIntent((prev) => {
        if (prev.mode !== 'off') return prev; // never clobber an in-flight intent
        const label = loadDeviceLabel();
        return label
          ? { mode: 'joined', code: joinCode, label }
          : { mode: 'prompt-join', code: joinCode };
      });
    });
    return () => {
      cancelled = true;
    };
  }, [joinCode, relayUrl]);

  // Share deep link (?chart=ROLE): one-shot select of the matching chart within
  // the visible (role-filtered) list. Case-insensitive to be forgiving of hand-
  // edited URLs; no match (renamed role, or hidden by a stored role filter) ⇒
  // silently ignore — the default first chart stands. Latched so later chart
  // switches are never clobbered.
  const chartRoleArmedRef = useRef(false);
  useEffect(() => {
    if (chartRoleArmedRef.current || !initialChartRole) return;
    const wanted = initialChartRole.toLowerCase();
    const idx = charts.findIndex((c) => c.role.toLowerCase() === wanted);
    if (idx === -1) return;
    chartRoleArmedRef.current = true;
    // Deferred setState (the repo's set-state-in-effect discipline).
    let cancelled = false;
    Promise.resolve().then(() => {
      if (cancelled) return;
      setActiveChartIdx(idx);
    });
    return () => {
      cancelled = true;
    };
  }, [initialChartRole, charts]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [calTool, setCalTool] = useState<'sections' | 'bars' | 'roadmap'>('sections');
  const [selectedSystemId, setSelectedSystemId] = useState<string | null>(null);
  // ── Bars-tool cardinality edits (add / remove a single barline) ──
  // addBarMode = the "＋ Add barline" toggle (a tap inside a band splits at x);
  // selectedBoundary = an interior tick tapped (not dragged) for removal. The
  // two are mutually exclusive; both clear on tool/mode/system change.
  const [addBarMode, setAddBarMode] = useState(false);
  const [selectedBoundary, setSelectedBoundary] = useState<{ systemId: string; index: number } | null>(null);
  // ── CV barline snap (#2) ──
  // snapBusy guards the async offscreen render; snapResult holds the last run's
  // metadata for the selected system so the controls can surface no-ops, count
  // mismatches, and clamped partials. Cleared whenever the selection changes.
  const [snapBusy, setSnapBusy] = useState(false);
  const [snapResult, setSnapResult] = useState<{ systemId: string; result: SnapBarsResult } | null>(null);
  // ── Roadmap tool state ──
  // selectedBarId = the bar the marker palette acts on; selectedMarkerId = a
  // placed marker tapped for deletion (delete-to-resolve). endingDraft = the
  // multi-tap volta-bracket flow. nextTimes/nextUntil pre-set the value of the
  // next :| / D.C.-D.S. placed (no marker-editing surface in v1 — change = delete + re-add).
  const [selectedBarId, setSelectedBarId] = useState<string | null>(null);
  const [selectedMarkerId, setSelectedMarkerId] = useState<string | null>(null);
  const [endingDraft, setEndingDraft] = useState<{ barIds: string[]; number: number } | null>(null);
  const [nextTimes, setNextTimes] = useState(2);
  const [nextUntil, setNextUntil] = useState<'end' | 'fine' | 'coda'>('end');
  const [canvasBox, setCanvasBox] = useState<CanvasBox | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  // Calibrate entry/exit. All THREE entry points — the top toggle, the tool tabs,
  // and the perform-readiness strip CTAs — share resetCalSelections so the
  // full-union reset can't drift between them (design-perform-readiness.md §4.1).
  // enterCalibrate is enter-only; the top toggle keeps its "Done exits Perform"
  // by branching to exitCalibrate when already in calibrate.
  const resetCalSelections = () => {
    setSelectedSystemId(null);
    setEditingId(null);
    setSelectedBarId(null);
    setSelectedMarkerId(null);
    setEndingDraft(null);
    setAddBarMode(false);
    setSelectedBoundary(null);
  };
  const enterCalibrate = (tool: CalTool) => {
    setCalTool(tool);
    resetCalSelections();
    setCalMode('calibrate');
  };
  const exitCalibrate = () => {
    resetCalSelections();
    setCalMode('perform');
  };
  // ── Review queue (converter chunk 3) ──
  // reviewIdx = position in the page→top→left walk of flagged elements; the
  // everReviewed latch lets the chip show "✓ Reviewed" once a draft that DID
  // have flags has been cleared to zero (vs. a hand-built calibration that never
  // had any — which shows nothing). Reset when the chart changes. Starts at -1
  // ("nothing selected yet") so the first Next lands on item 0 and the first
  // Previous lands on the last item, rather than skipping the first.
  const [reviewIdx, setReviewIdx] = useState(-1);
  const [everReviewed, setEverReviewed] = useState(false);

  // Reset chart and page when song or available charts change
  useEffect(() => {
    if (currentIdx !== prevSongIdxRef.current) {
      prevSongIdxRef.current = currentIdx;
      setActiveChartIdx(0);
      setPageNum(1);
    }
  }, [currentIdx]);

  // Keep the latest-value calibration mirror current (read by the async snap).
  useEffect(() => {
    calibrationRef.current = calibration;
  }, [calibration]);

  // The bars-tool selection is page-local — a selected system (and any tick
  // selection / snap result on it) lives on the current page. When the page
  // changes (arrows, swipe, ref-jump, chart switch), clear it so off-page edits
  // can't fire on a hidden band — in particular so "Snap to lines" can't profile
  // a stale off-page system rect. Guarded by a ref so the clear only fires on an
  // actual page change, not every render.
  useEffect(() => {
    if (pageNum !== prevPageNumRef.current) {
      prevPageNumRef.current = pageNum;
      setSelectedSystemId(null);
      setSelectedBoundary(null);
      setAddBarMode(false);
      setSnapResult(null);
    }
  }, [pageNum]);

  // Clamp activeChartIdx when filtered charts shrink (e.g., role filter change)
  const clampedChartIdx = charts.length > 0 ? Math.min(activeChartIdx, charts.length - 1) : 0;
  if (clampedChartIdx !== activeChartIdx) setActiveChartIdx(clampedChartIdx);

  // Load and render PDF
  const activeChart = charts[clampedChartIdx] ?? null;
  const chartFileId = activeChart?.fileId;
  const chartModifiedTime = activeChart?.modifiedTime;

  // A library chart's id is the calibration chart_id. fileId is overloaded (Drive
  // charts also carry one), so we require BOTH a UUID-shaped id AND a Supabase
  // storage URL — that pair only ever describes a chart_library row. Anyone (incl.
  // non-owner performers on a shared show) fetches by this id; the GET enforces
  // the Perform boundary (non-owners get only an isPerformable row, else 404).
  const isLibraryChart = !!activeChart?.url?.includes('/storage/v1/object/public/');
  const calibrationChartId =
    isLibraryChart && !!chartFileId &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(chartFileId)
      ? chartFileId
      : null;
  // The Calibrate affordance (edit mode) is owner-only — the v1 source-scope
  // boundary. Drive / static charts and non-owners never see it.
  const calibratable = isOwner && !!calibrationChartId;
  // Perform consumes a calibration only when it is verified (and hash-matched on
  // load). overlayCalibration is what the overlay renders in each mode.
  const overlayCalibration =
    calMode === 'calibrate'
      ? calibration
      : calibration && isPerformable(calibration)
        ? calibration
        : null;

  // Mirror the canvas's ACTUAL rendered rect (it's max-w/max-h clamped, so its
  // painted size can be smaller than its style w/h) as a delta from the viewer
  // container — the overlay fills the container, so markers land on the printed
  // page regardless of letterboxing or layout shifts (e.g. the toolbar opening).
  const updateCanvasBox = useCallback(() => {
    const c = canvasRef.current;
    const cont = containerRef.current;
    if (!c || !cont) return;
    const cr = c.getBoundingClientRect();
    const pr = cont.getBoundingClientRect();
    if (!cr.width || !cr.height) return;
    setCanvasBox({ left: cr.left - pr.left, top: cr.top - pr.top, width: cr.width, height: cr.height });
  }, []);

  const dropSection = (x: number, y: number) => {
    const base = calibration ?? emptyCalibration();
    const next = addSection(base, pageNum, x, y);
    setCalibration(next);
    setEditingId(next.sections[next.sections.length - 1].id);
  };
  const relabel = (id: string, label: string) =>
    setCalibration((c) => (c ? relabelSection(c, id, label) : c));
  const deleteSection = (id: string) => {
    setCalibration((c) => (c ? removeSection(c, id) : c));
    setEditingId(null);
    setSeekId((s) => (s === id ? null : s));
    setHoldId((h) => (h === id ? null : h));
  };
  const seek = (id: string) => { setSeekId(id); setHoldId(null); };
  const hold = (id: string) => { setSeekId(id); setHoldId(id); };

  // ── Bar-level calibration (step 3: system/bar creation) ──
  // Systems are full-width bands; a tap drops one ~6% tall centered on the tap
  // height, then drag handles fit it to the printed staff and the stepper
  // auto-distributes even bars.
  const dropSystem = (y: number) => {
    const base = calibration ?? emptyCalibration();
    const next = addSystem(base, pageNum, y - 0.03, y + 0.03, 0, 1);
    setCalibration(next);
    const created = next.systems![next.systems!.length - 1];
    setSelectedSystemId(created.id);
  };
  const resizeSystem = (id: string, yTop: number, yBottom: number) =>
    setCalibration((c) => (c ? resizeSystemBand(c, id, yTop, yBottom) : c));
  const moveBoundary = (systemId: string, boundaryIndex: number, x: number) =>
    setCalibration((c) => (c ? moveBarBoundary(c, systemId, boundaryIndex, x) : c));
  const setSystemBars = (id: string, count: number) => {
    // The stepper re-distributes evenly (destructive), which renumbers every
    // tick — drop any pending tick selection so the Remove button can't act on a
    // stale index, and disarm Add mode (it would otherwise stay armed across the
    // destructive redistribution).
    setSelectedBoundary(null);
    setAddBarMode(false);
    setSnapResult(null);
    setCalibration((c) => (c ? autoDistributeBars(c, id, Math.max(0, count)) : c));
  };
  // Local cardinality edits (non-destructive to neighbors), beside the stepper:
  // add splits the measure under x; remove merges the two bars a tick divides.
  const addBarlineAt = (systemId: string, x: number) => {
    setSnapResult(null);
    setCalibration((c) => (c ? addBarline(c, systemId, x) : c));
  };
  const removeBarlineAt = (systemId: string, index: number) => {
    setCalibration((c) => (c ? removeBarline(c, systemId, index) : c));
    setSelectedBoundary(null);
    setSnapResult(null);
  };
  // CV barline snap (#2): render the page offscreen, read the selected system's
  // band darkness, detect printed barlines, and snap the auto-distributed
  // boundaries onto them — all through moveBarBoundary (so every #94 invariant
  // inherits). Positions only; never changes bar count. Result metadata drives
  // the controls' no-op / count-mismatch / partial hints.
  const snapSelectedSystem = useCallback(
    async (systemId: string) => {
      const doc = docRef.current;
      if (!doc || snapBusy) return;
      setSnapBusy(true);
      try {
        const system = (calibrationRef.current?.systems ?? []).find((s) => s.id === systemId);
        if (!system) return;
        // Render the SYSTEM's own page (not the displayed pageNum): the band rect
        // is normalized to that page, so detection geometry stays self-consistent
        // regardless of where the viewer currently sits.
        const canvas = await renderPageOffscreen(doc, system.page, SNAP_RENDER_SCALE);
        if (!canvas) return;
        const profile = buildBandProfile(canvas, system);
        if (!profile) return;
        const lines = detectBarlines(profile);
        // Match + apply against the calibration as it stands AFTER the async render
        // (read via the latest-value ref), so a concurrent add/remove/drag/stepper
        // edit isn't clobbered by a stale pre-render snapshot. snapBarsToLines is
        // pure; this read→apply is synchronous so nothing can interleave between.
        const current = calibrationRef.current;
        if (!current) return;
        const result = snapBarsToLines(current, systemId, lines);
        setCalibration(result.calibration);
        setSnapResult({ systemId, result });
        setSelectedBoundary(null);
        setAddBarMode(false);
      } finally {
        setSnapBusy(false);
      }
    },
    [snapBusy],
  );
  // A tick TAP (vs drag) selects an interior boundary (1..N-1) for removal; the
  // band edges (0, N) are extent, not dividers, so they never select.
  const tapBoundary = (systemId: string, index: number) => {
    const n = (calibration?.bars ?? []).filter((b) => b.systemId === systemId).length;
    if (index < 1 || index > n - 1) { setSelectedBoundary(null); return; }
    setAddBarMode(false);
    setSelectedBoundary((cur) =>
      cur && cur.systemId === systemId && cur.index === index ? null : { systemId, index });
  };
  // Selecting a system (or deselecting) clears any in-flight cardinality edit.
  const selectSystem = (id: string | null) => {
    setSelectedSystemId(id);
    setSelectedBoundary(null);
    setAddBarMode(false);
    setSnapResult(null);
  };
  const deleteSystem = (id: string) => {
    setCalibration((c) => (c ? removeSystem(c, id) : c));
    setSelectedSystemId(null);
    setSelectedBoundary(null);
    setAddBarMode(false);
    setSnapResult(null);
  };
  const selectedSystem = selectedSystemId
    ? (calibration?.systems ?? []).find((s) => s.id === selectedSystemId) ?? null
    : null;
  const selectedBarCount = selectedSystem
    ? (calibration?.bars ?? []).filter((b) => b.systemId === selectedSystem.id).length
    : 0;

  // ── Roadmap tool (step 3: nav-graph authoring) ──
  // Tap a bar → palette drops a marker on its start/end edge; tap a placed glyph
  // → Delete (delete-to-resolve). Live-resolve runs resolveRoadmap on every edit
  // and shows the play order or the contradiction. Geometry (systems/bars) must
  // already exist — the tool reuses it, it doesn't create it.
  const roadmapMarkers = calibration?.roadmap ?? [];
  const selectedBar = selectedBarId ? (calibration?.bars ?? []).find((b) => b.id === selectedBarId) ?? null : null;
  // Which marker kinds already sit on the selected bar's edges (the resolver
  // rejects two of a kind on one bar, so the palette disables the duplicate).
  const markerKindsOnBar = new Set(
    roadmapMarkers
      .filter((m) => m.kind !== 'ending' && m.barId === selectedBarId)
      .map((m) => m.kind),
  );
  // Segno/Coda/Fine are v1 global singletons (resolveRoadmap §5 #2 rejects more
  // than one of each), so their palette buttons disable once one exists ANYWHERE
  // — not just on the selected bar — to keep authoring out of an avoidable error.
  const globalSingletonsUsed = new Set(
    roadmapMarkers
      .filter((m) => m.kind === 'segno' || m.kind === 'coda' || m.kind === 'fine')
      .map((m) => m.kind),
  );
  const boundRepeatStartId = calibration && selectedBarId ? enclosingRepeatStartId(calibration, selectedBarId) : null;
  // Live resolve of the whole roadmap (also feeds the readout + error highlight).
  const roadmapResolve = calibration ? resolveRoadmap(calibration) : null;
  const playOrder = calibration && roadmapResolve?.ok ? summarizeTraversal(calibration, roadmapResolve.traversal) : '';
  const resolveErrorIds = roadmapResolve && !roadmapResolve.ok ? new Set(roadmapResolve.error.markerIds) : new Set<string>();

  // ── Review queue (converter chunk 3) ──
  // The pure flagging seam decides which elements the human should look at
  // (low-confidence ∪ resolve-error). Editing any element clears its confidence,
  // so flags self-clear and the queue shrinks as the human works through it.
  const reviewFlagSet = useMemo(() => (calibration ? reviewFlags(calibration) : null), [calibration]);
  const reviewCount = reviewFlagSet?.count ?? 0;
  // (The everReviewed latch is set at calibration load — see the load effect —
  // and cleared on chart change, so the chip can distinguish "cleared to done"
  // from a hand-built calibration that never had flags.)
  const emptyIds = useMemo(() => new Set<string>(), []);
  const flaggedSectionIds = reviewFlagSet?.sectionIds ?? emptyIds;
  const flaggedSystemIds = reviewFlagSet?.systemIds ?? emptyIds;
  const flaggedMarkerIds = reviewFlagSet?.markerIds ?? emptyIds;

  // Step the review stepper: switch tool + page + select the flagged element so
  // the human lands on it ready to fix. Selection is type-specific (system band,
  // marker badge, or section pill editor); all other selections clear.
  const stepReview = (dir: 1 | -1) => {
    const ordered: FlaggedRef[] = reviewFlagSet?.ordered ?? [];
    const n = ordered.length;
    if (n === 0) return;
    // From the unselected start (-1), Next lands on 0 and Previous on the last
    // item; thereafter step with wraparound.
    const next = reviewIdx < 0 ? (dir === 1 ? 0 : n - 1) : (((reviewIdx + dir) % n) + n) % n;
    setReviewIdx(next);
    const ref = ordered[next];
    setCalTool(ref.tool);
    setPageNum(ref.page);
    setSelectedSystemId(ref.type === 'system' ? ref.id : null);
    setSelectedMarkerId(ref.type === 'marker' ? ref.id : null);
    setSelectedBarId(null);
    setEndingDraft(null);
    setEditingId(ref.type === 'section' ? ref.id : null);
  };

  const pushMarker = (marker: RoadmapMarker) => {
    setCalibration((c) => (c ? addRoadmapMarker(c, marker) : c));
    setSelectedMarkerId(null);
  };
  const newId = () => crypto.randomUUID();
  const addRepeatStart = () => selectedBarId && pushMarker({ id: newId(), kind: 'repeatStart', barId: selectedBarId, edge: 'start' });
  const addRepeatEnd = () => selectedBarId && boundRepeatStartId &&
    pushMarker({ id: newId(), kind: 'repeatEnd', barId: selectedBarId, edge: 'end', repeatStartId: boundRepeatStartId, times: nextTimes });
  const addSegno = () => selectedBarId && pushMarker({ id: newId(), kind: 'segno', barId: selectedBarId, edge: 'start' });
  const addCoda = () => selectedBarId && pushMarker({ id: newId(), kind: 'coda', barId: selectedBarId, edge: 'start' });
  const addToCoda = () => selectedBarId && pushMarker({ id: newId(), kind: 'toCoda', barId: selectedBarId, edge: 'end' });
  const addFine = () => selectedBarId && pushMarker({ id: newId(), kind: 'fine', barId: selectedBarId, edge: 'end' });
  const addJump = (from: 'capo' | 'segno') => selectedBarId &&
    pushMarker({ id: newId(), kind: 'jump', barId: selectedBarId, edge: 'end', from, until: nextUntil });
  const deleteMarker = (id: string) => {
    setCalibration((c) => (c ? removeRoadmapMarker(c, id) : c));
    setSelectedMarkerId(null);
  };

  // Volta-bracket draw: tap contiguous (reading-order-adjacent) bars to extend
  // the run, then confirm to drop an `ending` bound to the enclosing repeat.
  const beginEnding = () => { setEndingDraft({ barIds: selectedBarId ? [selectedBarId] : [], number: 1 }); setSelectedMarkerId(null); };
  const toggleEndingBar = (barId: string) => {
    setEndingDraft((d) => {
      if (!d) return d;
      if (d.barIds.includes(barId)) return d; // already in the run
      if (d.barIds.length === 0) return { ...d, barIds: [barId] };
      const order = calibration ? barsInOrder(calibration).map((b) => b.id) : [];
      const firstPos = order.indexOf(d.barIds[0]);
      const lastPos = order.indexOf(d.barIds[d.barIds.length - 1]);
      const p = order.indexOf(barId);
      // Only extend if adjacent to either end (keeps the bracket contiguous).
      if (p === lastPos + 1) return { ...d, barIds: [...d.barIds, barId] };
      if (p === firstPos - 1) return { ...d, barIds: [barId, ...d.barIds] };
      return d;
    });
  };
  const confirmEnding = () => {
    if (!calibration || !endingDraft || endingDraft.barIds.length === 0) return;
    const rsId = enclosingRepeatStartId(calibration, endingDraft.barIds[0]);
    if (!rsId) return;
    pushMarker({ id: newId(), kind: 'ending', repeatStartId: rsId, barIds: endingDraft.barIds, numbers: [endingDraft.number] });
    setEndingDraft(null);
  };
  const cancelEnding = () => setEndingDraft(null);

  // A roadmap-tool surface/marker tap: in ending-draw it extends the bracket;
  // otherwise it selects the bar for the palette (clearing any marker selection).
  const roadmapBarTap = (barId: string) => {
    if (endingDraft) { toggleEndingBar(barId); return; }
    setSelectedBarId(barId);
    setSelectedMarkerId(null);
  };
  const selectMarker = (id: string) => {
    if (endingDraft) return;
    setSelectedMarkerId(id);
    setSelectedBarId(null);
  };

  // ── Bar-level Perform redline (step 2) ──
  // Active only when a performable calibration carries bar geometry. The redline
  // follows the RESOLVED traversal (repeats, voltas, D.S./D.C., Coda, Fine) rather
  // than raw reading order: stepping advances along the played order, snapping
  // across systems and pages (turning the page as it goes). An absent/empty
  // roadmap resolves to the linear order, so this is identical to before.
  const barMode = calMode === 'perform' && !!overlayCalibration && (overlayCalibration.bars?.length ?? 0) > 0;
  const barCal = barMode ? overlayCalibration : null;
  // The played order as traversal steps ({barId, pass}). A performable calibration
  // always resolves; if an owner is previewing a draft whose roadmap doesn't
  // resolve, fall back to the linear order so the transport still works.
  const traversal = useMemo<TraversalStep[]>(() => {
    if (!barCal) return [];
    const resolved = resolveRoadmap(barCal);
    return resolved.ok ? resolved.traversal : barsInOrder(barCal).map((b) => ({ barId: b.id, pass: 1 }));
  }, [barCal]);
  // ── Conductor authority, chunk 4: the MD's own single-device session ──
  // The pure controller drives a redline by emitting `current` (a TraversalStep —
  // the same shape as the self-drive's `currentStep`), so a live session simply
  // REPLACES barSeekIdx as the source below (one redline, one driver — §1). Per-song,
  // single-device, advance-by-tap; no relay, no clock (those are 3b / chunk 5).
  // 3b chunk 5: relayOn = a settled intent (label known, connecting/connected).
  // A follower must run enabled=true too — mirroring needs the local session
  // identity (localKey) even when this device never conducts.
  const relayOn = relayIntent.mode === 'joined' || relayIntent.mode === 'live';
  const conductorEnabled = (conducting || relayOn) && barMode;
  const conductor = useConductorSession({
    enabled: conductorEnabled,
    // Q1: stable per (chart-in-show) — changing it mints a fresh session.
    sessionId: `${chartFileId ?? 'none'}::${owner}/${slug}`,
    songRef: chartFileId ?? 'none',
    cal: barCal,
    // 5b chunk 2 — the static-BPM motion rung's tempo source. A migrated song carries
    // its stated tempo; a legacy/inline song has none ⇒ null ⇒ manual rung (honest floor).
    // barBeats defaults inside the hook (4/4) until a meter source exists.
    bpm: song.bpm ?? null,
    // 3b chunk 5 → cloud-relay chunk 2: bind the room when the intent is
    // settled. The config's FIELDS key the socket, so label/code changes only
    // at intent transitions. 'live' = CREATE (the relay mints the code; showRef
    // is the opaque owner/slug blob it echoes); 'joined' = JOIN by code.
    relay:
      relayUrl !== null && relayOn
        ? relayIntent.mode === 'live'
          ? {
              url: relayUrl,
              deviceLabel: relayIntent.label,
              mode: 'create' as const,
              showRef: `${owner}/${slug}`,
            }
          : {
              url: relayUrl,
              deviceLabel: relayIntent.label,
              mode: 'join' as const,
              room: relayIntent.code,
            }
        : null,
  });
  // A follower's redline is wire-driven even though `conducting` is false here.
  const sessionDriving = (conducting || conductor.relay.role === 'follower') && conductor.active;

  // 3b chunk 5: go-live claims the baton exactly once per live intent (rising
  // edge). A LATER orphan is never auto-reclaimed — that's the strip's explicit
  // "take the baton" tap (§4.2: silence over invention).
  const relayCanClaim = conductor.relay.canClaim;
  useEffect(() => {
    if (relayIntent.mode !== 'live') {
      goLiveClaimedRef.current = false;
      return;
    }
    if (relayCanClaim && !goLiveClaimedRef.current) {
      goLiveClaimedRef.current = true;
      conductor.relay.requestClaim();
    }
  }, [relayIntent.mode, relayCanClaim, conductor.relay]);

  // 3b chunk 5: switch-session navigation (doc §10-5). When the room announces
  // a session for a DIFFERENT chart, a follower auto-opens it: song first (the
  // currentIdx reset effect above then zeroes chart/page; the step recomputes
  // on the new song and wins the same pass), then the chart within the
  // role-filtered list. Filtered-out / not-in-setlist deliberately does NOT
  // navigate — the chartMismatch strip is the honest outcome. The WHICH-step
  // decision is render-derived; the effect only performs it (deferred setState).
  const relayActiveSession = conductor.relay.activeSession;
  const relayRole = conductor.relay.role;
  let relaySwitchStep: { kind: 'song'; songIdx: number } | { kind: 'chart'; chartIdx: number } | null = null;
  if (relayRole === 'follower' && relayActiveSession && relayActiveSession.songRef !== chartFileId) {
    const hit = findChartForSongRef(setlist, relayActiveSession.songRef);
    if (hit) {
      if (hit.songIdx !== currentIdx) {
        relaySwitchStep = { kind: 'song', songIdx: hit.songIdx };
      } else {
        const idx = charts.findIndex((c) => c.fileId === relayActiveSession.songRef);
        if (idx !== -1 && idx !== activeChartIdx) relaySwitchStep = { kind: 'chart', chartIdx: idx };
      }
    }
  }
  useEffect(() => {
    if (!relaySwitchStep) return;
    let cancelled = false;
    Promise.resolve().then(() => {
      if (cancelled) return;
      if (relaySwitchStep.kind === 'song') onChangeIdx(relaySwitchStep.songIdx);
      else setActiveChartIdx(relaySwitchStep.chartIdx);
    });
    return () => {
      cancelled = true;
    };
  }, [relaySwitchStep, onChangeIdx]);

  // 3b chunk 5: the two intent transitions the footer/cluster trigger.
  // Go-live with a stored label connects immediately and shows the QR; without
  // one it asks for the name first (label keys the socket — settle it first).
  const goLive = () => {
    const label = loadDeviceLabel();
    if (!label) {
      setRelayIntent({ mode: 'prompt-live' });
      return;
    }
    // D4: no code minted here — the hook CREATES and the relay returns the code.
    setRelayIntent({ mode: 'live', label });
    setShowQr(true);
  };
  // Leaving is total: release the baton if we hold it, then drop the intent
  // (the hook sees relay:null and closes the socket).
  const leaveRoom = () => {
    if (conductor.relay.role === 'writer') conductor.relay.releaseBaton();
    setRelayIntent({ mode: 'off' });
    setShowQr(false);
  };

  // Effective (clamped) seek index: a stored index can fall out of range when the
  // traversal shrinks under it (a roadmap/bar edit, or leaving perform for
  // calibrate where the traversal is empty). Reading it as null when stale keeps
  // the redline and the Next/Prev disabled logic correct at render time — no
  // setState-in-effect, no flash of a vanished redline with Next stuck disabled.
  const seekIdx = barSeekIdx !== null && barSeekIdx < traversal.length ? barSeekIdx : null;
  // Driver swap: when the conductor session is live it sources currentStep; else the
  // self-drive seek. The derivation below (bar → system → page-turn → redline) is the
  // same for both — the session is purely a WHICH-bar driver, not a render change.
  const currentStep = sessionDriving
    ? conductor.current
    : barCal && seekIdx !== null
      ? traversal[seekIdx]
      : null;
  const currentBar = currentStep && barCal ? (barCal.bars ?? []).find((b) => b.id === currentStep.barId) ?? null : null;
  const currentSystem = currentBar && barCal ? findSystem(barCal, currentBar.systemId) : null;
  const barRedline = currentBar && currentSystem ? { bar: currentBar, system: currentSystem } : null;

  // Render-derived display page (§1 page-turn parity). While a session drives the
  // redline, the displayed page FOLLOWS the current bar's system IN THE SAME COMMIT
  // as `currentStep` — so the page and the redline are never inconsistent for a
  // render (no stale-page frame where the overlay suppresses the redline). Off
  // session, `pageNum` (taps / arrows / ref-jumps) is the source, unchanged.
  const displayPage = performDisplayPage(sessionDriving, currentSystem, pageNum);

  const seekToIndex = (idx: number) => {
    if (!barCal || idx < 0 || idx >= traversal.length) return;
    setBarSeekIdx(idx);
    const bar = (barCal.bars ?? []).find((b) => b.id === traversal[idx].barId);
    const sys = bar ? findSystem(barCal, bar.systemId) : null;
    if (sys && sys.page !== pageNum) setPageNum(sys.page);
  };
  const seekBarAt = (x: number, y: number) => {
    if (!barCal) return;
    // While a conductor session drives the redline, the self-drive is fully
    // suppressed — a surface tap is inert (no second driver, and no dormant
    // barSeekIdx left to surface on hand-off when Conduct stops). The session is
    // the sole WHICH-bar authority; the MD advances via the cluster, not by tapping.
    if (sessionDriving) return;
    const bar = tapToBar(barCal, pageNum, x, y);
    if (!bar) return;
    // Tapping a bar jumps to its FIRST occurrence in the played order.
    const idx = traversal.findIndex((t) => t.barId === bar.id);
    if (idx !== -1) seekToIndex(idx);
  };
  const stepNextBar = () => seekToIndex(seekIdx === null ? 0 : seekIdx + 1);
  const stepPrevBar = () => { if (seekIdx !== null) seekToIndex(seekIdx - 1); };

  // Keep `pageNum` eventually-consistent with the session's render-derived
  // `displayPage`, so handing back to the self-drive (the MD exits Conduct) lands on
  // the page the redline left off on — not a stale pre-session page. This is a SYNC,
  // NOT the page-turn driver: `displayPage` already turned the page in-commit above,
  // so the redline never waits on this effect (the prior flash is gone). Deferred to
  // a microtask (the repo's no-sync-setState-in-effect rule); a cancelled guard drops
  // a stale sync if the driven page changed under it.
  const drivenBarId = sessionDriving ? conductor.current?.barId ?? null : null;
  useEffect(() => {
    if (!drivenBarId || !barCal) return;
    const bar = (barCal.bars ?? []).find((b) => b.id === drivenBarId);
    const sys = bar ? findSystem(barCal, bar.systemId) : null;
    if (!sys || sys.page === pageNum) return;
    let cancelled = false;
    Promise.resolve().then(() => { if (!cancelled) setPageNum(sys.page); });
    return () => { cancelled = true; };
  }, [drivenBarId, barCal, pageNum]);

  const saveCalibration = async (promote: boolean) => {
    // §3.3c. The overlay that reaches this is now owner-only, but the write is
    // guarded independently: this is the ONE edit path on the show page that
    // does not funnel through updateConfig, so the chokepoint refusal there
    // cannot cover it.
    if (!isOwner) return;
    if (!calibration || !chartFileId || !sourceHash) return;
    const payload = promote ? verify(calibration) : calibration;
    setSaveState('saving');
    try {
      const res = await fetch('/api/charts/calibration', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chart_id: chartFileId, source_hash: sourceHash, calibration: payload }),
      });
      if (!res.ok) { setSaveState('error'); return; }
      setCalibration(payload);
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 1500);
    } catch {
      setSaveState('error');
    }
  };

  useEffect(() => {
    let cancelled = false;
    // New chart ⇒ drop any prior calibration state (avoid cross-chart bleed).
    const resetCalState = () => {
      setCalMode('perform');
      setCalibration(null);
      setSourceHash(null);
      setLoadError(false);
      setCalUnreadable(null);
      setSeekId(null);
      setHoldId(null);
      setBarSeekIdx(null);
      setConducting(false);
      setEditingId(null);
      setCalTool('sections');
      setSelectedSystemId(null);
      setSelectedBarId(null);
      setSelectedMarkerId(null);
      setEndingDraft(null);
      setAddBarMode(false);
      setSelectedBoundary(null);
      setCanvasBox(null);
      setReviewIdx(-1);
      setEverReviewed(false);
    };
    if (!chartFileId) {
      // Defer state reset to microtask to satisfy lint (no sync setState in effect)
      Promise.resolve().then(() => {
        if (cancelled) return;
        resetCalState();
        docRef.current = null;
        setNumPages(0);
        setPageNum(1);
        setLoading(false);
      });
      return () => { cancelled = true; };
    }
    const load = async () => {
      resetCalState();
      setLoading(true);
      try {
        const loaded = await loadPdfDoc(activeChart!, accessToken);
        if (cancelled) return;
        if (!loaded) {
          // PDF bytes failed to load: no sourceHash ⇒ a `none`/"Calibrate" CTA
          // would Save-no-op. Surface load-error, never "no map" (§3.1 case d).
          docRef.current = null;
          setNumPages(0);
          setPageNum(1);
          if (!cancelled) setLoadError(true);
          return;
        }
        const { doc, sourceHash: loadedHash } = loaded;
        docRef.current = doc;
        setNumPages(doc.numPages);
        setPageNum(1);
        if (canvasRef.current) {
          await renderPage(doc, 1, canvasRef.current);
          if (!cancelled) updateCanvasBox();
        }
        // loadPdfDoc already hashed the exact fetched bytes (shared with the
        // converter). Fetch the matching calibration. On any fetch failure ⇒ no
        // redline (not best-effort). Library charts only (UUID id + storage
        // URL); Drive ids never hit the endpoint. Owners get drafts back to
        // edit; non-owners only ever get an isPerformable row.
        if (calibrationChartId) {
          try {
            setSourceHash(loadedHash);
            const res = await fetch(
              `/api/charts/calibration?chart_id=${encodeURIComponent(calibrationChartId)}&hash=${loadedHash}`,
            );
            if (cancelled) return;
            if (res.ok) {
              const json = await res.json();
              if (!cancelled) {
                const loadedCal = json.calibration as ChartCalibration;
                setCalibration(loadedCal);
                // Latch the review-done indicator if the loaded draft carries
                // any model flags (low-confidence ∪ resolve-error).
                if (reviewFlags(loadedCal).count > 0) setEverReviewed(true);
              }
            } else if (res.status === 409) {
              // A row EXISTS but this build refused it (owner-only). Do NOT show
              // `none`/"Calibrate" — that would clobber the unreadable map (§3.2).
              const json = await res.json().catch(() => null);
              const reason = json?.reason === 'unsupported-schema' ? 'unsupported-schema' : 'invalid';
              if (!cancelled) setCalUnreadable({ reason });
            } else if (res.status !== 404) {
              // A clean 404 is honest `none` (no map for these bytes). Any other
              // non-ok (500, …) is a load failure, not "no map".
              if (!cancelled) setLoadError(true);
            }
          } catch {
            if (!cancelled) { setSourceHash(null); setCalibration(null); setLoadError(true); }
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [chartFileId, chartModifiedTime, accessToken]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-render on page change (then re-measure the canvas for overlay alignment).
  // Keyed on the render-derived `displayPage` (not raw `pageNum`) so a session
  // page-turn renders the new PDF page in the SAME commit the redline moves to it.
  useEffect(() => {
    if (docRef.current && canvasRef.current && displayPage >= 1 && displayPage <= numPages) {
      renderPage(docRef.current, displayPage, canvasRef.current).then(() => updateCanvasBox());
    }
  }, [displayPage, numPages, updateCanvasBox]);

  // Keep the overlay aligned to the canvas across any layout change — viewport
  // resize/rotate, the canvas re-clamping, or the calibrate toolbar opening
  // (which shrinks the container). A ResizeObserver catches all of these; a
  // window 'resize' listener would miss the layout-only shifts.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => updateCanvasBox());
    const cont = containerRef.current;
    const c = canvasRef.current;
    if (cont) ro.observe(cont);
    if (c) ro.observe(c);
    return () => ro.disconnect();
  }, [updateCanvasBox, activeChart, calMode]);

  // Prefetch N-1 and N+1
  useEffect(() => {
    for (const offset of [-1, 1]) {
      const idx = currentIdx + offset;
      if (idx < 0 || idx >= setlist.length) continue;
      const neighborCharts = (setlist[idx]?.charts ?? []).filter(
        (c) => roleFilter === 'all' || c.role === roleFilter
      );
      if (neighborCharts[0]) prefetchChart(neighborCharts[0], accessToken);
    }
  }, [currentIdx, setlist, roleFilter, accessToken]);

  // Cleanup on unmount
  useEffect(() => {
    return () => { destroyAllDocs(); };
  }, []);

  // Keyboard nav: left/right = song, up/down = page
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && currentIdx > 0) onChangeIdx(currentIdx - 1);
      if (e.key === 'ArrowRight' && currentIdx < setlist.length - 1) onChangeIdx(currentIdx + 1);
      if (e.key === 'ArrowUp' && pageNum > 1) { e.preventDefault(); setPageNum((p) => p - 1); }
      if (e.key === 'ArrowDown' && pageNum < numPages) { e.preventDefault(); setPageNum((p) => p + 1); }
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [currentIdx, setlist.length, pageNum, numPages, onChangeIdx, onClose]);

  // Touch: dominant-axis lock — horizontal swipe = song, tap = page turn
  useEffect(() => {
    let startX = 0;
    let startY = 0;
    let locked: 'h' | 'v' | null = null;

    const onStart = (e: TouchEvent) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      locked = null;
    };
    const onMove = (e: TouchEvent) => {
      if (locked) return;
      const dx = Math.abs(e.touches[0].clientX - startX);
      const dy = Math.abs(e.touches[0].clientY - startY);
      if (dx > 10 || dy > 10) locked = dx > dy ? 'h' : 'v';
    };
    const onEnd = (e: TouchEvent) => {
      // Taps/holds inside the calibration overlay (markers, or the calibrate-mode
      // backdrop) own the gesture — never also turn the page or change song.
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('[data-chart-overlay-interactive]')) return;

      const dx = e.changedTouches[0].clientX - startX;
      const dy = e.changedTouches[0].clientY - startY;
      const totalDisplacement = Math.abs(dx) + Math.abs(dy);

      // Tap detection: page turn via left/right half
      if (totalDisplacement < 10 && canvasRef.current) {
        const rect = canvasRef.current.getBoundingClientRect();
        const tapX = e.changedTouches[0].clientX;
        if (tapX >= rect.left && tapX <= rect.right && e.changedTouches[0].clientY >= rect.top && e.changedTouches[0].clientY <= rect.bottom) {
          const midX = rect.left + rect.width / 2;
          if (tapX > midX && pageNum < numPages) setPageNum((p) => p + 1);
          else if (tapX <= midX && pageNum > 1) setPageNum((p) => p - 1);
        }
        return;
      }

      // Horizontal swipe = song change
      if (locked === 'h' && Math.abs(dx) > 60) {
        if (dx < 0 && currentIdx < setlist.length - 1) onChangeIdx(currentIdx + 1);
        if (dx > 0 && currentIdx > 0) onChangeIdx(currentIdx - 1);
      }
    };

    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
    };
  }, [currentIdx, setlist.length, pageNum, numPages, onChangeIdx]);

  return (
    <div className="fixed inset-0 z-50 bg-zinc-950 text-zinc-100 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800 bg-zinc-900">
        <button onClick={onClose} className="text-sm font-bold text-zinc-400 hover:text-white">
          &larr; Back
        </button>
        <div className="text-center flex-1 px-2">
          <p className="text-sm font-bold truncate">{song.title}</p>
          <p className="text-[10px] text-zinc-500">
            Song {currentIdx + 1} of {setlist.length}
            {/* Re-key (Option A): a NUMBERS builder chart's body is key-invariant, so
                the live key is surfaced here from the setlist (song.key), falling
                back to authored_key. A LETTERS chart is baked concrete in its
                authored_key and CANNOT be live-rekeyed, so it shows authored_key and
                ignores any setlist override (design-roadmap-notation-toggle.md). */}
            {activeChart?.is_builder &&
              (activeChart.notation === 'letters'
                ? activeChart.authored_key && (
                    <span className="ml-1.5 px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-200 font-bold">
                      {activeChart.authored_key}
                    </span>
                  )
                : (song.key || activeChart.authored_key) && (
                    <span className="ml-1.5 px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-200 font-bold">
                      {song.key || activeChart.authored_key}
                    </span>
                  ))}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isOffline && (
            <span className="px-2 py-0.5 bg-amber-900 text-amber-300 text-[10px] font-bold rounded">
              OFFLINE
            </span>
          )}
          {/* Chart share: tier 1 shares the PDF itself (bytes via the viewer's
              own cache/proxy path); tiers 2/3 the ?song&chart deep link. An
              external-only chart (no fileId) has no bytes and no in-app viewer
              — its own URL is the honest share. */}
          {activeChart && (
            <ShareButton
              title={`${song.title} – ${activeChart.role}`}
              buildUrl={() =>
                activeChart.fileId
                  ? buildChartShareUrl(window.location.origin, owner, slug, song.position, activeChart.role)
                  : activeChart.url
              }
              getFile={
                activeChart.fileId
                  ? async () => {
                      const bytes = await fetchChartBytes(activeChart, accessToken);
                      return bytes
                        ? new File([bytes], chartShareFilename(song.title, activeChart.role), { type: 'application/pdf' })
                        : null;
                    }
                  : undefined
              }
            />
          )}
          {/* Suppress the ENTER path on a load-error / unreadable chart: entering
              Calibrate there would let a Save PUT to the same (chart_id, source_hash)
              and clobber the very map this build refused to interpret — the innocent
              CTA the strip already hides (design-perform-readiness.md §3.2/§4, D6).
              ALSO suppress while `loading`: the signals are false in-flight, but
              `sourceHash` is set before the GET awaits (`:3047`), so a click during
              loading could land the owner in Calibrate just before a 409 arrives —
              and the 409 sets calUnreadable WITHOUT forcing perform. Blocking entry
              for the whole load window (load start already reset to perform) makes
              "in Calibrate when a signal lands" unreachable. Conditioned on perform
              so the in-calibrate "Done" exit is never trapped. */}
          {calibratable && !(calMode === 'perform' && (loading || loadError || !!calUnreadable)) && (
            <button
              onClick={() => (calMode === 'calibrate' ? exitCalibrate() : enterCalibrate(calTool))}
              className={`px-2 py-1 rounded text-xs font-bold transition-colors ${
                calMode === 'calibrate'
                  ? 'bg-sky-500 text-white'
                  : 'bg-zinc-800 text-zinc-300 hover:text-white'
              }`}
            >
              {calMode === 'calibrate' ? 'Done' : 'Calibrate'}
            </button>
          )}
          <select
            value={roleFilter}
            onChange={(e) => onChangeRole(e.target.value)}
            className="text-xs border border-zinc-700 rounded px-2 py-1 bg-zinc-800 text-zinc-200"
          >
            <option value="all">All Parts</option>
            {allRoles.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
      </div>

      {/* Chart pill picker (multi-chart) */}
      {charts.length > 1 && (
        <div className="flex items-center gap-1 px-4 py-2 border-b border-zinc-800 bg-zinc-900 overflow-x-auto">
          {charts.map((c, i) => (
            <button
              key={`${c.role}-${c.fileId}`}
              onClick={() => { setActiveChartIdx(i); setPageNum(1); setBarSeekIdx(null); }}
              className={`px-2 py-1 rounded text-xs font-bold shrink-0 transition-colors ${
                i === activeChartIdx
                  ? 'bg-white text-black'
                  : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {c.role}
            </button>
          ))}
        </div>
      )}

      {/* PDF viewer */}
      <div ref={containerRef} className="flex-1 flex items-center justify-center bg-zinc-900 overflow-hidden relative">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/80 z-10">
            <p className="text-sm text-zinc-400 animate-pulse">Loading chart...</p>
          </div>
        )}
        {charts.length === 0 ? (
          <div className="text-zinc-500 text-sm italic">
            {roleFilter !== 'all'
              ? `No ${roleFilter} chart for this song`
              : 'No charts for this song'}
          </div>
        ) : activeChart && isUnsupportedChartMime(activeChart.mimeType) ? (
          /* §1.2 part 3: this viewer is pdf.js-on-canvas with no image branch, so
             a non-PDF row used to load, throw, and report a generic failure. Say
             why instead. Reachable only for LEGACY rows — since §1.2 part 2b the
             upload route stores `application/pdf` by construction. */
          <div className="text-center space-y-3">
            <p className="text-sm text-zinc-400">
              This chart is an image. Images can&apos;t be displayed in the viewer — replace it with a PDF.
            </p>
            <a
              href={activeChart.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block px-4 py-2 text-sm font-bold bg-white text-black rounded hover:bg-zinc-200 transition-colors"
            >
              Open {activeChart.role} Chart &rarr;
            </a>
          </div>
        ) : activeChart && !activeChart.fileId ? (
          <div className="text-center space-y-3">
            <p className="text-sm text-zinc-400">This chart can only be viewed externally</p>
            <a
              href={activeChart.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block px-4 py-2 text-sm font-bold bg-white text-black rounded hover:bg-zinc-200 transition-colors"
            >
              Open {activeChart.role} Chart &rarr;
            </a>
          </div>
        ) : (
          <canvas ref={canvasRef} className="max-w-full max-h-full" />
        )}
        {canvasBox && (calMode === 'calibrate' || overlayCalibration) && (
          <CalibrationOverlay
            calibration={calMode === 'calibrate' ? (calibration ?? emptyCalibration()) : overlayCalibration}
            box={canvasBox}
            page={displayPage}
            mode={calMode}
            calTool={calTool}
            seekId={seekId}
            holdId={holdId}
            editingId={editingId}
            barMode={barMode}
            barRedline={barRedline}
            onBarTap={seekBarAt}
            selectedSystemId={selectedSystemId}
            onDropSystem={dropSystem}
            onMoveBoundary={moveBoundary}
            onSelectSystem={selectSystem}
            onResizeSystem={resizeSystem}
            addBarMode={addBarMode}
            selectedBoundary={selectedBoundary}
            onAddBarline={addBarlineAt}
            onTapBoundary={tapBoundary}
            onDrop={dropSection}
            onSeek={seek}
            onHold={hold}
            onRelabel={relabel}
            onDelete={deleteSection}
            onBeginEdit={setEditingId}
            selectedBarId={selectedBarId}
            selectedMarkerId={selectedMarkerId}
            endingBarIds={endingDraft?.barIds ?? null}
            resolveErrorIds={resolveErrorIds}
            flaggedSectionIds={flaggedSectionIds}
            flaggedSystemIds={flaggedSystemIds}
            flaggedMarkerIds={flaggedMarkerIds}
            onRoadmapBarTap={roadmapBarTap}
            onSelectMarker={selectMarker}
          />
        )}
      </div>

      {/* Calibrate toolbar (owner-only, in calibrate mode) */}
      {calMode === 'calibrate' && (
        <div className="flex items-center justify-between gap-2 px-4 py-2 border-t border-zinc-800 bg-zinc-900">
          <div className="flex items-center gap-3 min-w-0">
            {/* Tool toggle: Sections (rail) · Bars (geometry) · Roadmap (nav graph). */}
            <div className="flex rounded bg-zinc-800 p-0.5 shrink-0">
              {(['sections', 'bars', 'roadmap'] as const).map((tool) => (
                <button
                  key={tool}
                  onClick={() => enterCalibrate(tool)}
                  className={`px-2 py-1 rounded text-[11px] font-bold capitalize transition-colors ${
                    calTool === tool ? 'bg-sky-500 text-white' : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  {tool}
                </button>
              ))}
            </div>
            {calTool === 'roadmap' ? (
              <RoadmapToolbar
                hasBars={(calibration?.bars?.length ?? 0) > 0}
                selectedBar={selectedBar}
                selectedMarkerId={selectedMarkerId}
                markerKindsOnBar={markerKindsOnBar}
                globalSingletonsUsed={globalSingletonsUsed}
                boundRepeatStartId={boundRepeatStartId}
                endingDraft={endingDraft}
                nextTimes={nextTimes}
                nextUntil={nextUntil}
                playOrder={playOrder}
                resolveError={roadmapResolve && !roadmapResolve.ok ? roadmapResolve.error.reason : null}
                onSetTimes={setNextTimes}
                onSetUntil={setNextUntil}
                onRepeatStart={addRepeatStart}
                onRepeatEnd={addRepeatEnd}
                onSegno={addSegno}
                onCoda={addCoda}
                onToCoda={addToCoda}
                onFine={addFine}
                onJump={addJump}
                onBeginEnding={beginEnding}
                onConfirmEnding={confirmEnding}
                onCancelEnding={cancelEnding}
                onSetEndingNumber={(n) => setEndingDraft((d) => (d ? { ...d, number: n } : d))}
                onDeleteMarker={deleteMarker}
              />
            ) : calTool === 'sections' ? (
              <p className="text-[11px] text-zinc-400 truncate">
                Tap the page to drop a section · tap a pill to label or delete
                {calibration && !canVerify(calibration) && (
                  <span className="text-amber-400"> · every section needs a label to verify</span>
                )}
              </p>
            ) : selectedSystem ? (
              <div className="flex items-center gap-2 text-[11px] text-zinc-400">
                <span>Bars</span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setSystemBars(selectedSystem.id, selectedBarCount - 1)}
                    disabled={selectedBarCount === 0}
                    className="w-6 h-6 rounded bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    &minus;
                  </button>
                  <span className="w-6 text-center font-bold text-white">{selectedBarCount}</span>
                  <button
                    onClick={() => setSystemBars(selectedSystem.id, selectedBarCount + 1)}
                    className="w-6 h-6 rounded bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
                  >
                    +
                  </button>
                </div>
                <span className="text-zinc-600">·</span>
                {/* CV barline snap (#2): align the even-distributed boundaries onto
                    the page's real printed barlines. Positions only — bar count is
                    the stepper's job. Result hint surfaces no-op / count-mismatch /
                    partials so a bad snap reads as "nudge these" not "done". */}
                <button
                  onClick={() => snapSelectedSystem(selectedSystem.id)}
                  disabled={snapBusy || selectedBarCount === 0}
                  className="px-2 h-6 rounded font-bold bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  {snapBusy ? 'Snapping\u2026' : '\u2317 Snap to lines'}
                </button>
                {snapResult && snapResult.systemId === selectedSystem.id && (() => {
                  const r = snapResult.result;
                  if (r.accepted === 0) {
                    return <span className="text-amber-400 truncate">no clear barlines to snap</span>;
                  }
                  const countOff = r.detectedLines !== r.expectedBoundaries;
                  return (
                    <span className="flex items-center gap-1 truncate">
                      <span className="text-emerald-400">
                        {r.fullySnapped} snapped{r.partial > 0 ? `, ${r.partial} need a nudge` : ''}
                      </span>
                      {countOff && (
                        <span className="text-amber-400">
                          · found {r.detectedLines}, expected {r.expectedBoundaries} &mdash; adjust count
                        </span>
                      )}
                    </span>
                  );
                })()}
                <span className="text-zinc-600">·</span>
                {/* Local cardinality edits (don't re-distribute / wipe nudges like
                    the stepper does). Add: toggle, then tap inside a measure. Remove:
                    tap a barline tick to select it, then confirm. */}
                <button
                  onClick={() => { setAddBarMode((v) => !v); setSelectedBoundary(null); }}
                  className={`px-2 h-6 rounded font-bold ${
                    addBarMode ? 'bg-sky-500 text-white' : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
                  }`}
                >
                  &#65291; Add barline
                </button>
                {selectedBoundary && selectedBoundary.systemId === selectedSystem.id && calibration && (() => {
                  const dry = removeBarline(calibration, selectedBoundary.systemId, selectedBoundary.index);
                  const lost = (calibration.roadmap?.length ?? 0) - (dry.roadmap?.length ?? 0);
                  return (
                    <button
                      onClick={() => removeBarlineAt(selectedBoundary.systemId, selectedBoundary.index)}
                      className="px-2 h-6 rounded font-bold bg-red-600 text-white hover:bg-red-500"
                    >
                      &#10005; Remove barline{lost > 0 ? ` (\u2212${lost} marker${lost === 1 ? '' : 's'})` : ''}
                    </button>
                  );
                })()}
                <span className="truncate text-zinc-500">
                  {addBarMode
                    ? 'tap inside a measure to split it'
                    : selectedBoundary
                      ? 'confirm removal, or tap the tick again to cancel'
                      : 'tap a barline to remove · drag a tick to align'}
                </span>
                <span className="text-zinc-600">·</span>
                <button
                  onClick={() => deleteSystem(selectedSystem.id)}
                  className="text-zinc-500 hover:text-red-400 underline shrink-0"
                >
                  Delete system
                </button>
              </div>
            ) : (
              <p className="text-[11px] text-zinc-400 truncate">
                Tap the page to drop a staff system · tap a band to select · drag its edges to fit
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* Review stepper: walk the model-flagged elements (low-confidence ∪
                resolve-error) page→top→left. Disappears once the queue clears;
                "✓ Reviewed" shows only if it ever had flags. */}
            {reviewCount > 0 ? (
              <div className="flex items-center gap-1 rounded bg-amber-500/15 ring-1 ring-amber-500/40 px-1.5 py-0.5">
                <span aria-hidden className="text-amber-400">&#9873;</span>
                <span className="text-[11px] font-bold text-amber-300">{reviewCount} to review</span>
                <button
                  onClick={() => stepReview(-1)}
                  aria-label="Previous flagged element"
                  className="w-5 h-5 rounded text-amber-200 hover:bg-amber-500/20"
                >
                  &lsaquo;
                </button>
                <button
                  onClick={() => stepReview(1)}
                  aria-label="Next flagged element"
                  className="w-5 h-5 rounded text-amber-200 hover:bg-amber-500/20"
                >
                  &rsaquo;
                </button>
              </div>
            ) : everReviewed ? (
              <span className="text-[11px] font-bold text-emerald-400">&#10003; Reviewed</span>
            ) : null}
            {saveState === 'saving' && <span className="text-[11px] text-zinc-500">Saving…</span>}
            {saveState === 'saved' && <span className="text-[11px] text-emerald-400">Saved</span>}
            {saveState === 'error' && <span className="text-[11px] text-red-400">Save failed</span>}
            <button
              onClick={() => saveCalibration(false)}
              disabled={!calibration || (calibration.sections.length === 0 && (calibration.systems?.length ?? 0) === 0) || saveState === 'saving'}
              className="px-3 py-1.5 text-xs font-bold rounded bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Save draft
            </button>
            <button
              onClick={() => saveCalibration(true)}
              disabled={!calibration || !canVerify(calibration) || saveState === 'saving'}
              className="px-3 py-1.5 text-xs font-bold rounded bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Verify &amp; save
            </button>
          </div>
        </div>
      )}

      {/* Perform bar transport — ONE bottom slot, honesty-first priority
          (3b chunk 5, design-conductor-3b §10-5): prompt form (a missing input
          blocks connecting) → conductor cluster (conducting, not a follower) →
          follower strip (relay on, wire is the writer) → self-drive seek.
          The prompt and follower rows deliberately do NOT gate on barMode: a
          joined device must ALWAYS show its room state + Leave (doc §honesty —
          "chart not on this device"), even when the local chart has no bar
          calibration to perform on. Only the transports (cluster / self-drive)
          need barMode. */}
      {calMode === 'perform' && (relayIntent.mode === 'prompt-join' || relayIntent.mode === 'prompt-live') ? (
        <RelayPromptForm
          key={relayIntent.mode} // join↔live never share half-typed state
          kind={relayIntent.mode === 'prompt-join' ? 'join' : 'live'}
          initialCode={relayIntent.mode === 'prompt-join' ? relayIntent.code : ''}
          onSubmit={(code, label) => {
            saveDeviceLabel(label);
            if (relayIntent.mode === 'prompt-join') {
              setRelayIntent({ mode: 'joined', code, label });
            } else {
              setRelayIntent({ mode: 'live', label }); // D4: the relay mints the code
              setShowQr(true);
            }
          }}
          onCancel={() => setRelayIntent({ mode: 'off' })}
        />
      ) : calMode === 'perform' && barMode && conducting && conductor.relay.role !== 'follower' ? (() => {
        const armed = conductor.armed;
        const armedTarget = armed ? conductor.targets.find((t) => t.barId === armed.directive.barId) : null;
        const fireAtBar = armed ? (barCal?.bars ?? []).find((b) => b.id === armed.fireAt) : null;
        // Header relay state (mockup P1/P5): live once the intent is settled —
        // 'joined' counts too, because a follower who took the baton conducts
        // under the code they joined with. null relayUrl hides the affordance.
        // D4: the code is the RELAY's (conductor.relay.room) — until it lands
        // (create in flight / reconnecting) the honest state is 'connecting'.
        const relayRoomCode = conductor.relay.room;
        const clusterRelay: ClusterRelayState | null =
          relayUrl === null
            ? null
            : relayIntent.mode === 'live' || relayIntent.mode === 'joined'
              ? conductor.relay.status === 'connecting' || relayRoomCode === null
                ? { kind: 'connecting', onShowQr: () => setShowQr(true) }
                : { kind: 'live', code: relayRoomCode, onShowQr: () => setShowQr(true) }
              : { kind: 'available', onGoLive: goLive };
        return (
          <ConductorCluster
            active={conductor.active}
            readout={currentBar
              ? { absNumber: currentBar.absNumber, passLabel: currentStep && currentStep.pass > 1 ? passOrdinal(currentStep.pass) : null }
              : null}
            armedSummary={armed
              ? { targetLabel: armedTarget?.label ?? 'target', fireAtLabel: fireAtBar ? String(fireAtBar.absNumber) : '?' }
              : null}
            targets={conductor.targets}
            redirects={conductor.redirects}
            canAdvance={!conductor.done}
            canArm={!conductor.done}
            ignored={conductor.outcome === 'ignored'}
            autoFire={conductor.autoFireOn}
            clockOn={conductor.clockOn}
            rung={conductor.rung}
            stalled={conductor.stalled}
            holding={conductor.state?.vm.holding != null}
            canArmNextSection={conductor.canArmNextSection}
            micStatus={conductor.micStatus}
            shadow={conductor.shadow}
            validationLogCount={conductor.validationLog.length}
            onEnableMic={conductor.enableMicDetection}
            onDisableMic={conductor.disableMicDetection}
            onCopyLog={() => {
              void navigator.clipboard?.writeText(JSON.stringify(conductor.validationLog, null, 2));
            }}
            onClearLog={conductor.clearValidationLog}
            onAdvance={conductor.advance}
            onAlign={conductor.align}
            onArm={conductor.arm}
            onCommit={conductor.commit}
            onDisarm={conductor.disarm}
            onRedirect={conductor.redirect}
            onToggleAutoFire={() => conductor.setAutoFire(!conductor.autoFireOn)}
            onToggleClock={() => conductor.setClockOn(!conductor.clockOn)}
            relay={clusterRelay}
            onStop={() => {
              // Exit hands the room off cleanly: release the baton (followers get
              // the honest waiting/lost strip) but STAY in the room as a follower.
              if (conductor.relay.role === 'writer') conductor.relay.releaseBaton();
              setConducting(false);
            }}
          />
        );
      })() : calMode === 'perform' && relayOn ? (() => {
        // The follower strip (mockups P4/P5/P7). No transport here — with a
        // relay bound and this device a follower, the wire is the ONE writer.
        // Not barMode-gated: an uncalibrated local chart still mirrors NOTHING
        // (localKey null ⇒ chartMismatch), and the strip must say so + offer
        // Leave rather than leaving a silently-connected device (Codex finding).
        const rs = conductor.relay.activeSession;
        const roomHit = rs ? findChartForSongRef(setlist, rs.songRef) : null;
        if (conductor.relay.roomGone) {
          // D4 close-code honesty: the relay said 4004 — the room no longer
          // exists (expired/typo'd). Retrying can never help; say so + Leave.
          return (
            <div className="flex items-center justify-center gap-3 py-1.5 text-xs bg-zinc-900 border-t border-red-900/60">
              <span className="text-red-400">Room not found — it may have ended.</span>
              <button onClick={leaveRoom} className="px-2 py-1 rounded bg-zinc-800 text-zinc-200 hover:bg-zinc-700">
                Leave
              </button>
            </div>
          );
        }
        return (
          <RelayStrip
            status={conductor.relay.status === 'connecting' ? 'connecting' : 'joined'}
            conductorLost={conductor.relay.conductorLost}
            conductorLabel={conductor.relay.conductorLabel}
            canClaim={conductor.relay.canClaim}
            waiting={rs === null}
            chartMismatch={conductor.relay.chartMismatch}
            songTitle={
              conductor.relay.chartMismatch
                ? roomHit
                  ? setlist[roomHit.songIdx].title
                  : null
                : song?.title ?? null
            }
            readout={currentBar
              ? { absNumber: currentBar.absNumber, passLabel: currentStep && currentStep.pass > 1 ? passOrdinal(currentStep.pass) : null }
              : null}
            onTakeBaton={() => {
              // Claiming IS conducting: flip local intent so the cluster mounts
              // the moment the relay grants (role writer ⇒ this branch yields).
              setConducting(true);
              conductor.relay.requestClaim();
            }}
            onLeave={leaveRoom}
          />
        );
      })() : calMode === 'perform' && barMode ? (
        <div className="flex items-center justify-center gap-3 py-1.5 text-xs bg-zinc-900 border-t border-zinc-800">
          <button
            onClick={stepPrevBar}
            disabled={seekIdx === null || seekIdx <= 0}
            className="px-2 py-1 rounded bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            &larr; Prev bar
          </button>
          <span className="text-zinc-400 min-w-[6rem] text-center">
            {currentBar
              ? <>
                  Bar <span className="font-bold text-red-400">{currentBar.absNumber}</span>
                  {currentStep && currentStep.pass > 1 && (
                    <span className="text-zinc-500"> &middot; {passOrdinal(currentStep.pass)}</span>
                  )}
                </>
              : 'Tap a bar or step →'}
          </span>
          <button
            onClick={stepNextBar}
            disabled={traversal.length === 0 || (seekIdx !== null && seekIdx >= traversal.length - 1)}
            className="px-2 py-1 rounded bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Next bar &rarr;
          </button>
          {currentBar && (
            <button onClick={() => setBarSeekIdx(null)} className="text-zinc-500 hover:text-white underline">
              clear
            </button>
          )}
          {/* 3b chunk 5: owner gate dropped (locked Q2 — owner ≠ conductor; the
              relay's single-writer arbitration is the only authority). */}
          <button onClick={() => setConducting(true)} className="text-amber-400 hover:text-amber-300 underline">
            Conduct
          </button>
          {relayUrl !== null && relayIntent.mode === 'off' && (
            <button
              onClick={() => setRelayIntent({ mode: 'prompt-join', code: '' })}
              className="text-emerald-400 hover:text-emerald-300 underline"
            >
              Join
            </button>
          )}
        </div>
      ) : calMode === 'perform' && !barMode ? (
        /* The transport hole: no bar transport ⇒ surface WHY + the one next step
           (design-perform-readiness.md §4). Renders exactly where the conditional
           used to fall to `: null`. */
        <PerformReadinessStrip
          view={performReadinessView({ loading, loadError, unreadable: calUnreadable, cal: calibration })}
          calibratable={calibratable}
          onCalibrate={enterCalibrate}
        />
      ) : null}

      {/* 3b chunk 5: the join QR (mockup P2) — shown on go-live and from the
          cluster's room chip. The QR itself dismisses anywhere; the interim
          connecting dialog dismisses ONLY via Hide (see RelayConnectingOverlay).
          Never blocks conducting. D4: the code is the relay-minted room
          (facts.room) — renders once the create's `joined` lands (goLive opens
          this overlay optimistically; the connecting pulse is the honest interim). */}
      {showQr &&
        (relayIntent.mode === 'live' || relayIntent.mode === 'joined') &&
        (conductor.relay.room !== null ? (
          <RelayQrOverlay
            joinUrl={buildJoinUrl(window.location.origin, owner, slug, conductor.relay.room)}
            code={conductor.relay.room}
            onClose={() => setShowQr(false)}
          />
        ) : (
          // UAT fix: the interim dialog is NOT backdrop-dismissable (a stray/
          // synthesized tap right after "Go live" was silently killing it) —
          // explicit Hide only; the cluster's connecting chip re-opens it.
          <RelayConnectingOverlay onHide={() => setShowQr(false)} />
        ))}

      {/* Perform seek status (a section is parked under the redline) */}
      {calMode === 'perform' && !barMode && seekId && overlayCalibration && (() => {
        const s = overlayCalibration.sections.find((x) => x.id === seekId);
        if (!s) return null;
        return (
          <div className="flex items-center justify-center gap-2 py-1.5 text-xs bg-zinc-900 border-t border-zinc-800">
            <span className="text-zinc-400">{holdId === seekId ? 'Holding' : 'At'}</span>
            <span className="font-bold text-red-400">{s.label || '(unlabeled)'}</span>
            <button onClick={() => { setSeekId(null); setHoldId(null); }} className="text-zinc-500 hover:text-white underline">
              clear
            </button>
          </div>
        );
      })()}

      {/* Page indicator */}
      {numPages > 1 && (
        <div className="text-center py-1 text-xs text-zinc-500 bg-zinc-900 border-t border-zinc-800">
          Page {displayPage} of {numPages} &middot; tap left/right on chart to turn
        </div>
      )}

      {/* Prev / Next Song */}
      <div className="flex items-center justify-between px-4 py-3 border-t border-zinc-800 bg-zinc-900">
        <button
          onClick={() => onChangeIdx(currentIdx - 1)}
          disabled={currentIdx === 0}
          className="px-4 py-2 text-sm font-bold rounded bg-zinc-800 text-zinc-200 hover:bg-zinc-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          &larr; Prev
        </button>
        <button
          onClick={() => onChangeIdx(currentIdx + 1)}
          disabled={currentIdx >= setlist.length - 1}
          className="px-4 py-2 text-sm font-bold rounded bg-zinc-800 text-zinc-200 hover:bg-zinc-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Next &rarr;
        </button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// CONFIG TAB
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// SHOW SORTABLE ROW (used in Mix tab reorder mode)
// ════════════════════════════════════════════════════════════════════════════

function ShowSortableRow({
  song, idx, total, showChartsColumn, colorMap, onNavigate, onMoveUp, onMoveDown,
}: {
  song: SetlistSong;
  idx: number;
  total: number;
  showChartsColumn: boolean;
  colorMap: Map<string, string>;
  onNavigate: (idx: number) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: song.id! });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };
  const singers = song.lead.split('+').map((n) => n.trim());
  const songCharts = song.charts ?? [];
  const hasDupes = songCharts.some((c) => (c.dupeCount ?? 0) > 1);

  return (
    <tr ref={setNodeRef} style={style} className="hover:bg-gray-50">
      <td className="px-2 py-2 cursor-grab print:hidden" {...attributes} {...listeners}>
        <span className="text-gray-300 text-sm select-none">&#x2630;</span>
      </td>
      <td className="px-4 py-2 font-mono text-gray-400">{song.position}</td>
      <td className="px-4 py-2 font-medium">
        {song.title}
        {song.key && (
          <span className="ml-2 text-[10px] bg-gray-100 text-gray-700 px-1.5 py-0.5 rounded font-semibold border border-gray-200">
            {song.key}
          </span>
        )}
        {song.sceneNote && (
          <span className="ml-2 text-[10px] bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded font-semibold">
            {song.sceneNote}
          </span>
        )}
      </td>
      <td className="px-4 py-2">
        <div className="flex flex-wrap gap-1">
          {singers.map((singer) => (
            <span key={singer} className={`px-1.5 py-0.5 rounded text-xs font-semibold ${getSingerColor(singer, colorMap)}`}>
              {singer}
            </span>
          ))}
        </div>
      </td>
      <td className="px-4 py-2 text-gray-500 italic text-xs hidden sm:table-cell">
        {song.notes}
      </td>
      {showChartsColumn && (
        <td className="px-4 py-2">
          <button
            onClick={() => onNavigate(idx)}
            className={`w-8 h-8 flex items-center justify-center rounded transition-colors ${
              songCharts.length > 0
                ? hasDupes ? 'bg-orange-100 text-orange-700' : 'bg-blue-100 text-blue-700'
                : 'text-gray-200'
            }`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z" />
            </svg>
          </button>
        </td>
      )}
      <td className="px-2 py-2 print:hidden">
        <div className="flex flex-col items-center">
          <button className="px-1 py-0.5 text-gray-400 hover:text-gray-700 disabled:opacity-20 disabled:cursor-not-allowed" disabled={idx === 0} onClick={onMoveUp}>&uarr;</button>
          <button className="px-1 py-0.5 text-gray-400 hover:text-gray-700 disabled:opacity-20 disabled:cursor-not-allowed" disabled={idx === total - 1} onClick={onMoveDown}>&darr;</button>
        </div>
      </td>
    </tr>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ADD SONG FROM LIBRARY (autocomplete + Create & Add)
// ════════════════════════════════════════════════════════════════════════════

export function AddSongFromLibrary({
  onAddSong,
  isOwner,
  ownerId,
}: {
  onAddSong: (song: { songId?: string; title: string; key?: string; lead?: string; notes?: string; bpm?: number | null; charts?: Chart[] }) => void;
  isOwner: boolean;
  ownerId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [songs, setSongs] = useState<Array<{ id: string; title: string; key: string | null; lead: string; notes: string; bpm: number | null; charts?: Chart[] }>>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    async function loadLibrary() {
      setLoading(true);
      try {
        // Browse the show owner's library (a collaborator must target the owner, not themselves)
        const r = await fetch(ownerId ? `/api/songs?owner_id=${encodeURIComponent(ownerId)}` : '/api/songs');
        const data = r.ok ? await r.json() : { songs: [] };
        if (!cancelled) setSongs(data.songs || []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadLibrary();
    return () => { cancelled = true; };
  }, [open, ownerId]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open) {
    return (
      <button
        className="px-3 py-1.5 text-xs font-bold bg-gray-100 border border-gray-300 rounded hover:bg-gray-200 transition-colors mt-3"
        onClick={() => setOpen(true)}
      >
        + Add Song
      </button>
    );
  }

  const trimmed = query.trim();
  const filtered = trimmed
    ? songs.filter((s) => s.title.toLowerCase().includes(trimmed.toLowerCase()))
    : songs;
  const exactMatch = songs.find((s) => s.title.toLowerCase() === trimmed.toLowerCase());

  function handleSelect(song: { id: string; title: string; key: string | null; lead: string; notes: string; bpm: number | null; charts?: Chart[] }) {
    onAddSong({
      songId: song.id,
      title: song.title,
      key: song.key ?? undefined,
      lead: song.lead,
      notes: song.notes,
      // Thread the library song's stated tempo so the new row shows it without a
      // reload (Codex R1 MEDIUM) — without this the row lands BPM-less on `manual`.
      bpm: song.bpm,
      charts: song.charts,
    });
    setQuery('');
    setOpen(false);
  }

  async function handleCreateAndAdd() {
    if (!trimmed || creating) return;
    setCreating(true);
    setCreateError('');
    try {
      const res = await fetch('/api/songs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmed }),
      });
      if (res.ok) {
        const newSong = await res.json();
        onAddSong({
          songId: newSong.id,
          title: newSong.title,
          key: newSong.key ?? undefined,
          lead: newSong.lead || '',
          notes: newSong.notes || '',
          bpm: newSong.bpm ?? null,
        });
        setQuery('');
        setOpen(false);
      } else {
        const data = await res.json().catch(() => ({}));
        setCreateError(data.error || 'Failed to create song');
      }
    } catch {
      setCreateError('Network error');
    }
    setCreating(false);
  }

  return (
    <div className="mt-3 relative">
      <div className="flex gap-2">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setOpen(false); setQuery(''); }
            if (e.key === 'Enter' && exactMatch) { e.preventDefault(); handleSelect(exactMatch); }
          }}
          placeholder="Search library or type new title..."
          className="flex-1 bg-white border border-gray-300 rounded px-2 py-1.5 text-sm outline-none focus:border-blue-500"
        />
        <button
          onClick={() => { setOpen(false); setQuery(''); }}
          className="px-2 py-1 text-xs text-gray-500 hover:text-gray-700"
        >
          Cancel
        </button>
      </div>
      {loading ? (
        <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded shadow-lg p-2 text-sm text-gray-400">
          Loading library...
        </div>
      ) : trimmed ? (
        <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded shadow-lg max-h-48 overflow-y-auto">
          {filtered.map((song) => (
            <button
              key={song.id}
              className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 transition-colors flex justify-between"
              onClick={() => handleSelect(song)}
            >
              <span className="font-medium">{song.title}</span>
              {song.key && <span className="text-xs text-gray-400 ml-2">{song.key}</span>}
            </button>
          ))}
          {!exactMatch && trimmed && (
            isOwner ? (
              <>
                <button
                  className="w-full text-left px-3 py-2 text-sm text-blue-600 hover:bg-blue-50 border-t border-gray-100 font-medium transition-colors"
                  onClick={handleCreateAndAdd}
                  disabled={creating}
                >
                  {creating ? 'Creating...' : `Create & Add "${trimmed}"`}
                </button>
                {createError && (
                  <div className="px-3 py-1.5 text-xs text-red-500 border-t border-gray-100">{createError}</div>
                )}
              </>
            ) : null
          )}
          {filtered.length === 0 && exactMatch === undefined && !isOwner && (
            <div className="px-3 py-2 text-sm text-gray-400">No matches</div>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SORTABLE SETLIST TABLE (shared DnD logic for Config tab)
// ════════════════════════════════════════════════════════════════════════════

export function SetupSetlistTable({
  setlist, canResolveCharts, onReorder, onUpdate, onDelete, onAddSong, onBpmChange, isOwner, ownerId, onManageCharts,
}: {
  setlist: SetlistSong[];
  canResolveCharts: boolean;
  onReorder: (from: number, to: number) => void;
  onUpdate: (idx: number, field: string, value: string) => void;
  onDelete: (idx: number) => void;
  onAddSong: (song: { songId?: string; title: string; key?: string; lead?: string; notes?: string; bpm?: number | null; charts?: Chart[] }) => void;
  // BPM writes the CANONICAL song row (owner-only), not the per-show blob — see §3.
  onBpmChange: (songId: string, bpm: number | null) => void;
  isOwner: boolean;
  ownerId: string | null;
  onManageCharts?: (songTitle: string) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
  );

  const songIds = setlist.map((s) => s.id!);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = songIds.indexOf(active.id as string);
    const to = songIds.indexOf(over.id as string);
    if (from !== -1 && to !== -1) onReorder(from, to);
  };

  return (
    <>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={songIds} strategy={verticalListSortingStrategy}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="w-8"></th>
                  <th className="text-left px-2 py-2 text-xs font-bold text-gray-500 w-10">#</th>
                  <th className="text-left px-2 py-2 text-xs font-bold text-gray-500 min-w-[160px]">Title</th>
                  <th className="text-left px-2 py-2 text-xs font-bold text-gray-500 w-16">Key</th>
                  <th className="text-left px-2 py-2 text-xs font-bold text-gray-500 min-w-[100px]">Lead</th>
                  <th className="text-left px-2 py-2 text-xs font-bold text-gray-500">Notes</th>
                  <th className="text-left px-2 py-2 text-xs font-bold text-gray-500 min-w-[120px]">Charts</th>
                  <th className="w-16"></th>
                  <th className="w-10"></th>
                </tr>
              </thead>
              <tbody>
                {setlist.map((song, idx) => (
                  <SetupSortableRow
                    key={song.id!}
                    song={song}
                    idx={idx}
                    total={setlist.length}
                    canResolveCharts={canResolveCharts}
                    onUpdate={onUpdate}
                    onDelete={onDelete}
                    onMoveUp={() => onReorder(idx, idx - 1)}
                    onMoveDown={() => onReorder(idx, idx + 1)}
                    isOwner={isOwner}
                    onBpmChange={onBpmChange}
                    onManageCharts={onManageCharts}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </SortableContext>
      </DndContext>
      <AddSongFromLibrary onAddSong={onAddSong} isOwner={isOwner} ownerId={ownerId} />
    </>
  );
}

const inputCls = 'w-full px-2 py-2.5 sm:py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-black bg-white';
const arrowBtn = 'px-1 py-0.5 text-gray-400 hover:text-gray-700 disabled:opacity-20 disabled:cursor-not-allowed';

function SetupSortableRow({
  song, idx, total, canResolveCharts, onUpdate, onDelete, onMoveUp, onMoveDown, isOwner, onBpmChange, onManageCharts,
}: {
  song: SetlistSong;
  idx: number;
  total: number;
  canResolveCharts: boolean;
  onUpdate: (idx: number, field: string, value: string) => void;
  onDelete: (idx: number) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  isOwner: boolean;
  onBpmChange: (songId: string, bpm: number | null) => void;
  onManageCharts?: (songTitle: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: song.id! });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };

  const hasSongCharts = (song.charts?.length ?? 0) > 0;
  const hasSongDupes = song.charts?.some((c) => (c.dupeCount ?? 0) > 1) ?? false;
  // BPM is a song-level (canonical) write — owner-only, and only for library-linked
  // rows (a songId is the write target). Inline/legacy rows have no canonical row,
  // so they get no control and stay on the `manual` rung (§3, resolved Q3).
  const showBpm = isOwner && !!song.songId;

  return (
    <>
    <tr ref={setNodeRef} style={style} className="border-b border-gray-100">
      <td className="px-1 py-1 cursor-grab" {...attributes} {...listeners}>
        <span className="text-gray-300 text-sm select-none">&#x2630;</span>
      </td>
      <td className="px-2 py-1 relative">
        {canResolveCharts && (
          <span className={`absolute top-1 left-0.5 w-1.5 h-1.5 rounded-full ${
            hasSongDupes ? 'bg-orange-400' : hasSongCharts ? 'bg-green-400' : 'bg-gray-300'
          }`} />
        )}
        <span className="text-xs font-mono text-gray-400">{song.position}</span>
      </td>
      <td className="px-2 py-1">
        {/* §1.3: a library-linked row's title is NOT editable here. The server
            rebuilds config.setlist from the songs table on every save
            (shows/update/route.ts writes `title: song.title`), so typing here
            reverted on reload with a green "Saved" in between — a field offered
            as editable that cannot persist.
            A row with NO songId is different and stays editable: route.ts:100
            genuinely resolves (or auto-creates) that row BY its title, so making
            it read-only would break CSV import and the AI's update_setlist. */}
        {!isTitleEditableInSetlist(song) ? (
          <div className="flex items-center gap-1.5 group">
            <span className="text-sm text-gray-700 truncate" title={song.title}>{song.title}</span>
            <a
              href="/library"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] text-blue-600 hover:text-blue-800 underline opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity whitespace-nowrap"
              title="Song titles live in your library — renaming there updates every show"
            >
              Rename in Library
            </a>
          </div>
        ) : (
          <input className={inputCls} value={song.title} onChange={(e) => onUpdate(idx, 'title', e.target.value)} />
        )}
      </td>
      <td className="px-2 py-1">
        <input className={`${inputCls} w-16`} placeholder="Eb" value={song.key ?? ''} onChange={(e) => onUpdate(idx, 'key', e.target.value)} />
      </td>
      <td className="px-2 py-1">
        <input className={inputCls} value={song.lead} onChange={(e) => onUpdate(idx, 'lead', e.target.value)} />
      </td>
      <td className="px-2 py-1">
        <input className={inputCls} value={song.notes ?? ''} onChange={(e) => onUpdate(idx, 'notes', e.target.value)} />
      </td>
      <td className="px-2 py-1">
        <div className="flex flex-wrap items-center gap-1">
          {(song.charts || []).map((c) => (
            <span key={c.role} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-xs rounded bg-blue-50 text-blue-700">
              {displayRole(c.role as ChartRole)}
            </span>
          ))}
          {/* Owners manage (add/replace/delete/preview) via the shared modal;
              collaborators get a read-only preview when charts exist. */}
          {onManageCharts && (isOwner || (song.charts?.length ?? 0) > 0) && (
            <button onClick={() => onManageCharts(song.title)} className="text-xs text-gray-400 hover:text-gray-600">
              {(song.charts?.length ?? 0) > 0 ? 'Manage' : '+'}
            </button>
          )}
        </div>
      </td>
      <td className="px-1 py-1">
        <div className="flex flex-col items-center">
          <button className={arrowBtn} disabled={idx === 0} onClick={onMoveUp} title="Move up">&uarr;</button>
          <button className={arrowBtn} disabled={idx === total - 1} onClick={onMoveDown} title="Move down">&darr;</button>
        </div>
      </td>
      <td className="px-2 py-1">
        <button className="px-2 py-1 text-xs text-red-600 hover:text-red-800 hover:bg-red-50 rounded transition-colors" onClick={() => onDelete(idx)}>X</button>
      </td>
    </tr>
    {showBpm && (
      <tr style={style} className="border-b border-gray-100">
        <td></td>
        <td colSpan={8} className="px-2 pb-2">
          <div className="flex flex-wrap items-center gap-3">
            <TapTempo bpm={song.bpm ?? null} onChange={(bpm) => onBpmChange(song.songId!, bpm)} />
            {/* The write is genuinely global (canonical song row) — say so (Q2). */}
            <span className="text-xs text-gray-400">sets this song&rsquo;s tempo everywhere</span>
          </div>
        </td>
      </tr>
    )}
    </>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SORTABLE INPUT TABLE (Config tab)
// ════════════════════════════════════════════════════════════════════════════

function SetupInputTable({
  inputs, slots, onReorder, onUpdate, onLink, onCreateOccupant, onDelete, onAdd,
}: {
  inputs: import('@/lib/types').InputChannel[];
  slots: StageSlot[];
  onReorder: (from: number, to: number) => void;
  onUpdate: (idx: number, field: string, value: string) => void;
  onLink: (idx: number, slotId: string | undefined) => void;
  onCreateOccupant: (idx: number, pos: StagePosition) => void;
  onDelete: (idx: number) => void;
  onAdd: () => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
  );
  const inputIds = inputs.map((inp) => inp.id!);
  // The Position dropdown options — one per occupied slot, "TLA — label".
  const slotOptions = slotOptionsForInputs(slots);
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = inputIds.indexOf(active.id as string);
    const to = inputIds.indexOf(over.id as string);
    if (from !== -1 && to !== -1) onReorder(from, to);
  };

  return (
    <>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={inputIds} strategy={verticalListSortingStrategy}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="w-8"></th>
                  <th className="text-left px-2 py-2 text-xs font-bold text-gray-500 w-14">Ch</th>
                  <th className="text-left px-2 py-2 text-xs font-bold text-gray-500 min-w-[140px]">Instrument</th>
                  <th className="text-left px-2 py-2 text-xs font-bold text-gray-500 min-w-[100px]">Mic/DI</th>
                  <th className="text-left px-2 py-2 text-xs font-bold text-gray-500">Stand</th>
                  <th className="text-left px-2 py-2 text-xs font-bold text-gray-500">Notes</th>
                  <th className="text-left px-2 py-2 text-xs font-bold text-gray-500 min-w-[150px]">Position</th>
                  <th className="w-16"></th>
                  <th className="w-10"></th>
                </tr>
              </thead>
              <tbody>
                {inputs.map((inp, idx) => (
                  <SortableInputRow
                    key={inp.id!}
                    input={inp}
                    idx={idx}
                    total={inputs.length}
                    slotOptions={slotOptions}
                    onUpdate={onUpdate}
                    onLink={onLink}
                    onCreateOccupant={onCreateOccupant}
                    onDelete={onDelete}
                    onMoveUp={() => onReorder(idx, idx - 1)}
                    onMoveDown={() => onReorder(idx, idx + 1)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </SortableContext>
      </DndContext>
      <button className={`${btnAdd} mt-3`} onClick={onAdd}>+ Add Row</button>
    </>
  );
}

const NEW_OCCUPANT_PREFIX = '__new__:';

function SortableInputRow({
  input: inp, idx, total, slotOptions, onUpdate, onLink, onCreateOccupant, onDelete, onMoveUp, onMoveDown,
}: {
  input: import('@/lib/types').InputChannel;
  idx: number;
  total: number;
  slotOptions: { id: string; label: string }[];
  onUpdate: (idx: number, field: string, value: string) => void;
  onLink: (idx: number, slotId: string | undefined) => void;
  onCreateOccupant: (idx: number, pos: StagePosition) => void;
  onDelete: (idx: number) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: inp.id! });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };

  // Dangling link: a slotId that no longer resolves to a live occupant.
  const dangling = !!inp.slotId && !slotOptions.some((o) => o.id === inp.slotId);
  // Unified needs-attention state; sub-reason drives the tooltip.
  const attentionTip = inp.slotId
    ? 'The linked occupant no longer exists — reassign.'
    : 'This channel’s link was ambiguous after import — reassign.';

  const handleLinkChange = (value: string) => {
    if (value === '') onLink(idx, undefined);
    else if (value.startsWith(NEW_OCCUPANT_PREFIX)) {
      onCreateOccupant(idx, value.slice(NEW_OCCUPANT_PREFIX.length) as StagePosition);
    } else onLink(idx, value);
  };

  return (
    <tr ref={setNodeRef} style={style} className="border-b border-gray-100">
      <td className="px-1 py-1 cursor-grab" {...attributes} {...listeners}>
        <span className="text-gray-300 text-sm select-none">&#x2630;</span>
      </td>
      <td className="px-2 py-1">
        <span className="text-xs font-mono text-gray-400">{inp.ch}</span>
      </td>
      <td className="px-2 py-1">
        <input className={inputCls} value={inp.inst} onChange={(e) => onUpdate(idx, 'inst', e.target.value)} />
      </td>
      <td className="px-2 py-1">
        <input className={inputCls} value={inp.mic} onChange={(e) => onUpdate(idx, 'mic', e.target.value)} />
      </td>
      <td className="px-2 py-1">
        <input className={inputCls} value={inp.stand} onChange={(e) => onUpdate(idx, 'stand', e.target.value)} />
      </td>
      <td className="px-2 py-1">
        <input className={inputCls} value={inp.notes ?? ''} onChange={(e) => onUpdate(idx, 'notes', e.target.value)} />
      </td>
      <td className="px-2 py-1">
        <div className="flex items-center gap-1">
          <select
            className={`${inputCls} px-1 ${inp.needsReview ? 'border-amber-400 bg-amber-50' : ''}`}
            value={dangling ? inp.slotId : inp.slotId ?? ''}
            onChange={(e) => handleLinkChange(e.target.value)}
          >
            <option value="">&mdash; None &mdash;</option>
            {slotOptions.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
            {dangling && <option value={inp.slotId}>&#9888; removed occupant</option>}
            <optgroup label="＋ New occupant at…">
              {POSITIONS.map((pos) => (
                <option key={`new-${pos}`} value={`${NEW_OCCUPANT_PREFIX}${pos}`}>{pos}</option>
              ))}
            </optgroup>
          </select>
          {inp.needsReview && (
            <span className="text-amber-500 text-sm select-none" title={attentionTip}>&#9888;</span>
          )}
        </div>
      </td>
      <td className="px-1 py-1">
        <div className="flex flex-col items-center">
          <button className={arrowBtn} disabled={idx === 0} onClick={onMoveUp} title="Move up">&uarr;</button>
          <button className={arrowBtn} disabled={idx === total - 1} onClick={onMoveDown} title="Move down">&darr;</button>
        </div>
      </td>
      <td className="px-2 py-1">
        <button className="px-2 py-1 text-xs text-red-600 hover:text-red-800 hover:bg-red-50 rounded transition-colors" onClick={() => onDelete(idx)}>X</button>
      </td>
    </tr>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SORTABLE MONITOR TABLE (Config tab)
// ════════════════════════════════════════════════════════════════════════════

function SetupMonitorTable({
  monitors, onReorder, onUpdate, onDelete, onAdd,
}: {
  monitors: import('@/lib/types').MonitorMix[];
  onReorder: (from: number, to: number) => void;
  onUpdate: (idx: number, field: string, value: string) => void;
  onDelete: (idx: number) => void;
  onAdd: () => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
  );
  const monitorIds = monitors.map((mon) => mon.id!);
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = monitorIds.indexOf(active.id as string);
    const to = monitorIds.indexOf(over.id as string);
    if (from !== -1 && to !== -1) onReorder(from, to);
  };

  return (
    <>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={monitorIds} strategy={verticalListSortingStrategy}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="w-8"></th>
                  <th className="text-left px-2 py-2 text-xs font-bold text-gray-500 w-14">Mix #</th>
                  <th className="text-left px-2 py-2 text-xs font-bold text-gray-500 min-w-[140px]">Name</th>
                  <th className="text-left px-2 py-2 text-xs font-bold text-gray-500 min-w-[160px]">Needs</th>
                  <th className="text-left px-2 py-2 text-xs font-bold text-gray-500 w-28">Type</th>
                  <th className="w-16"></th>
                  <th className="w-10"></th>
                </tr>
              </thead>
              <tbody>
                {monitors.map((mon, idx) => (
                  <SortableMonitorRow
                    key={mon.id!}
                    monitor={mon}
                    idx={idx}
                    total={monitors.length}
                    onUpdate={onUpdate}
                    onDelete={onDelete}
                    onMoveUp={() => onReorder(idx, idx - 1)}
                    onMoveDown={() => onReorder(idx, idx + 1)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </SortableContext>
      </DndContext>
      {/* One datalist for the whole table — the rows reference it by id. */}
      <datalist id="monitor-types">
        {MONITOR_TYPES.map((t) => <option key={t} value={t} />)}
      </datalist>
      <button className={`${btnAdd} mt-3`} onClick={onAdd}>+ Add Mix</button>
    </>
  );
}

function SortableMonitorRow({
  monitor: mon, idx, total, onUpdate, onDelete, onMoveUp, onMoveDown,
}: {
  monitor: import('@/lib/types').MonitorMix;
  idx: number;
  total: number;
  onUpdate: (idx: number, field: string, value: string) => void;
  onDelete: (idx: number) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: mon.id! });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };

  return (
    <tr ref={setNodeRef} style={style} className="border-b border-gray-100">
      <td className="px-1 py-1 cursor-grab" {...attributes} {...listeners}>
        <span className="text-gray-300 text-sm select-none">&#x2630;</span>
      </td>
      <td className="px-2 py-1">
        <span className="text-xs font-mono text-gray-400">{mon.mix}</span>
      </td>
      <td className="px-2 py-1">
        <input className={inputCls} value={mon.name} onChange={(e) => onUpdate(idx, 'name', e.target.value)} />
      </td>
      <td className="px-2 py-1">
        <input className={inputCls} value={mon.needs} onChange={(e) => onUpdate(idx, 'needs', e.target.value)} />
      </td>
      <td className="px-2 py-1">
        {/* Datalist, not a select: MONITOR_TYPES suggests, it does not constrain
            — side-fills and hybrid rigs are real and an enum would make each one
            a schema change (design-ai-op-contract §3.4). `?? ''` keeps the input
            controlled for the legacy rows that predate this field. */}
        <input
          className={inputCls}
          list="monitor-types"
          placeholder="Wedge"
          value={mon.type ?? ''}
          onChange={(e) => onUpdate(idx, 'type', e.target.value)}
        />
      </td>
      <td className="px-1 py-1">
        <div className="flex flex-col items-center">
          <button className={arrowBtn} disabled={idx === 0} onClick={onMoveUp} title="Move up">&uarr;</button>
          <button className={arrowBtn} disabled={idx === total - 1} onClick={onMoveDown} title="Move down">&darr;</button>
        </div>
      </td>
      <td className="px-2 py-1">
        <button className="px-2 py-1 text-xs text-red-600 hover:text-red-800 hover:bg-red-50 rounded transition-colors" onClick={() => onDelete(idx)}>X</button>
      </td>
    </tr>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// AGENT CHAT (AI Show Designer panel in Config tab)
// ════════════════════════════════════════════════════════════════════════════

interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
    status: 'pending' | 'applied' | 'rejected';
  }>;
  // §5.2a.2b: the stream opened and then died. The turn stays visible — the
  // partial content WAS delivered and billed — but it is excluded from API
  // history, because replaying half a turn as canonical context invites the
  // model to continue from something it never said. See lib/agent-history.ts.
  failed?: boolean;
}

function AgentChat({
  config,
  updateConfig,
  owner,
  slug,
}: {
  config: AppConfig;
  updateConfig: (fn: (prev: AppConfig) => AppConfig) => void;
  // §5.2a.3: the prompt cache is keyed per show, so one show's prompts never
  // surface in another. Same identity the sibling tabs already receive.
  owner: string;
  slug: string;
}) {
  const [apiKey, setApiKey] = useState(() => {
    if (typeof window === 'undefined') return '';
    return readKey(localStorage, sessionStorage);
  });
  // The settings overlay (chunk 4). Opening it renders `ByoaKeySettings` on TOP of
  // this still-mounted host, so restored composer text and the transcript survive
  // (§3.1, §9 T21) — a navigation to /dashboard/settings would destroy them.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState('');
  const [tryitRemaining, setTryitRemaining] = useState<number | null>(null);
  const [tryitExhausted, setTryitExhausted] = useState(false);
  const [fetchedProbe, setFetchedProbe] = useState<FetchedProbe>('loading');
  // Bumped to force a re-probe when nothing the mount effect already watches has
  // changed — specifically after an ACCOUNT key is saved or removed in the overlay
  // while no device key is held (§3.2, §9 T22). A device-key change re-runs the probe
  // on its own by flipping `apiKey`; the account key is invisible to the browser, so
  // only the server-side probe can observe it, and it needs an explicit nudge.
  const [probeNonce, setProbeNonce] = useState(0);
  // §5.1: a BYOA key Anthropic rejected (revoked, rotated, mistyped) — and WHICH
  // backend it was, so the banner offers the right recovery (device: clear the
  // browser key; account: open Settings to Remove/Replace). The server names the
  // source via `keyReject` on the 401; we do not infer it (design-account-key-recovery
  // §3). null means no such rejection is showing.
  const [rejectedKey, setRejectedKey] = useState<KeyRejectSource | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const configRef = useRef(config);
  useEffect(() => { configRef.current = config; }, [config]);

  // §5: no probe when a BYOA key is already saved — /api/agent/chat prefers
  // Authorization unconditionally, so try-it state cannot affect what a send does.
  // `skipped` is derived, not stored, so clearing the key returns this to `loading`
  // and the effect below fetches. See effectiveProbe.
  const probe = effectiveProbe(apiKey, fetchedProbe);

  // Deliberately not aborted on unmount: the response only calls setState, React
  // no-ops a set on an unmounted component, and an AbortController here would need
  // to survive the tab remounting to be worth anything.
  // The status→probe mapping moved to `probeCapabilities` (issue #136): it was
  // three lines no test could reach, and a wrong branch here passes the whole
  // suite while reintroducing the state-2 dead end chunk 3 exists to fix.
  useEffect(() => {
    if (apiKey) return;
    let live = true;
    void probeCapabilities().then((probe) => {
      if (live) setFetchedProbe(probe);
    });
    return () => { live = false; };
  }, [apiKey, probeNonce]);

  // No persist effect here any more. The settings overlay (`ByoaKeySettings`) is the
  // SOLE writer of BYOA storage — one writer, no drift — and the recovery path clears
  // it explicitly in `handleClearKey`. The old effect wrote on every `apiKey` change,
  // which fought the overlay's own write the moment the two disagreed about the
  // Remember choice.

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streaming]);

  // Build Claude API message array from our messages (including tool results)
  // The replay rules — including §5.2a.2b's failed-turn exclusion — moved to
  // lib/agent-history.ts. They were a closure over component state, so nothing
  // could assert them; test 13l requires asserting the FULL message array.

  async function sendMessage(text?: string) {
    const userText = text ?? input.trim();
    if (!userText || streaming) return;

    // §5.2a.3: the cache write and the clear are ONE action — the composer must
    // never be emptied without the text landing somewhere first. `rememberPrompt`
    // is best-effort and cannot throw, so a failing store can't block a send.
    rememberPrompt(sessionStorage, owner, slug, userText);
    setInput('');
    setError('');
    // Cleared with the error it annotates. A rejection describes ONE response;
    // left standing it would put "That key was rejected" under the NEXT failure —
    // a 502 or an offline send — and talk the user into deleting a working
    // credential over a fault that was never theirs.
    setRejectedKey(null);

    // Declared outside the try so the catch can commit whatever arrived before
    // a transport drop. The rules live in lib/agent-stream.ts.
    // (The old `streamStarted` byte-timing flag is gone: §5.2a.4 now keys the
    // restore decision on what reached the transcript. See shouldRestoreComposer.)
    let streamState = newStreamState();

    const userMsg: AgentMessage = { role: 'user', content: userText };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setStreaming(true);

    try {
      const apiMessages = [...buildApiMessages(messages), { role: 'user', content: userText }];

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

      const res = await fetch('/api/agent/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          messages: apiMessages,
          currentConfig: configRef.current,
          configHash: '',
        }),
      });

      // Check try-it remaining
      const remaining = res.headers.get('X-Tryit-Remaining');
      if (remaining !== null) setTryitRemaining(parseInt(remaining, 10));

      if (!res.ok) {
        const err = await res.json();
        if (err.tryitExhausted) setTryitExhausted(true);
        // §5.1: Anthropic rejected the BYOA key we used, and the server said which
        // backend via `keyReject`. Device → the banner clears the browser key and
        // re-probes; account → it opens Settings to Remove/Replace. A try-it or
        // unconfigured 401 carries no `keyReject`, so no banner fires for a fault the
        // user cannot fix. Logic + reasoning live in lib/send-recovery.ts.
        setRejectedKey(rejectedKeySource({ status: res.status, keyReject: err.keyReject }));
        throw new Error(err.error || 'Request failed');
      }

      // Parse SSE stream
      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const { payloads, rest } = splitSseData(buffer);
        buffer = rest;

        for (const payload of payloads) {
          const event = parseSseEvent(payload);
          if (!event) continue;
          const next = reduceStreamEvent(streamState, event);
          const textGrew = next.text !== streamState.text;
          streamState = next;
          // Live update while text arrives — unchanged behaviour, now driven by
          // the reduced state rather than by local accumulators.
          if (textGrew) {
            setMessages([...newMessages, {
              role: 'assistant',
              content: streamState.text,
              toolCalls: streamState.toolCalls.length > 0 ? [...streamState.toolCalls] : undefined,
            }]);
          }
        }
      }

      // §5.2a.2: an `error` event is surfaced rather than swallowed. Partial
      // content is kept and marked — it was delivered and billed — and the
      // composer is NOT restored (§5.2a.4 row 2).
      if (streamState.failed && streamState.errorMessage) setError(streamState.errorMessage);
      // ...but a failed turn that delivered NOTHING has nothing to mark. The
      // `failed` guard is load-bearing: a SUCCESSFUL empty turn also satisfies
      // the predicate, and restoring the composer there would put the text back
      // after Claude legitimately answered with nothing.
      if (streamState.failed && shouldRestoreComposer(arrivedFrom(streamState))) {
        setInput(userText);
        setMessages((prev) => rollbackOptimisticSend(prev, userText));
      } else {
        setMessages([...newMessages, finalizeTurn(streamState)]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
      // §5.2a.4: nothing was delivered, so put the text back and drop the
      // optimistic entry — a restored composer PLUS a stranded transcript entry
      // reads as though the message was sent twice. Retry stays explicit: this
      // re-arms Send, it does not re-send.
      if (shouldRestoreComposer(arrivedFrom(streamState))) {
        setInput(userText);
        setMessages((prev) => rollbackOptimisticSend(prev, userText));
      } else {
        // The stream opened and then the connection died — no `error` frame,
        // because nothing was alive to send one. Beyond §5.2a.2's letter, but
        // the identical hazard: partial text already live in the transcript
        // would replay as canonical context, and a tool call that completed
        // before the drop would sit `pending` and lock the composer. Same
        // disposal, so the two cannot diverge.
        setMessages([...newMessages, finalizeTurn({ ...streamState, failed: true })]);
      }
    } finally {
      setStreaming(false);
    }
  }

  // Expand a stage slot into one or more input channels based on role keywords.
  // Produces a realistic skeleton — user refines mic/stand details from here.
  function expandSlotToInputs(slot: StageSlot): Omit<InputChannel, 'ch'>[] {
    const role = (slot.role || '').toLowerCase();
    const name = slot.name;
    const results: Omit<InputChannel, 'ch'>[] = [];

    const add = (inst: string, mic: string, stand: string, notes?: string) =>
      results.push({ inst, mic, stand, notes: notes || name });

    // Drums — expand to full kit
    if (role.includes('drum')) {
      add('Kick', 'Beta 52 / D6', 'Short Boom', name);
      add('Snare', 'SM57', 'Short Boom', name);
      add('Hi-Hat', 'Condenser', 'Small Boom', name);
      add('Rack Tom', 'Clip', 'N/A', name);
      add('Floor Tom', 'Clip', 'N/A', name);
      add('OH L', 'Condenser', 'Tall Boom', name);
      add('OH R', 'Condenser', 'Tall Boom', name);
    }
    // Bass — DI, possibly amp mic
    else if (role.includes('bass')) {
      add('Bass DI', 'DI', 'N/A', name);
      if (role.includes('amp')) add('Bass Amp', 'SM57 / e906', 'Short Boom', name);
    }
    // Keys / keyboard / piano
    else if (role.includes('key') || role.includes('piano') || role.includes('organ')) {
      if (role.includes('piano') && (role.includes('hi') || role.includes('lo') || role.includes('mic'))) {
        add('Piano Hi', 'Condenser', 'Tall Boom', name);
        add('Piano Lo', 'Condenser', 'Tall Boom', name);
      }
      if (role.includes('stereo')) {
        add('Keys L', 'DI', 'N/A', name);
        add('Keys R', 'DI', 'N/A', name);
      } else {
        add('Keys', 'DI', 'N/A', name);
      }
    }
    // Guitar
    else if (role.includes('gtr') || role.includes('guitar')) {
      add('Guitar', 'SM57 / e906', 'Short Boom', name);
    }
    // Horn instruments — one channel each
    else if (role.includes('sax')) {
      add('Sax', 'SM57 / Clip', 'Tall Boom', name);
    } else if (role.includes('trumpet') || role.includes('tpt') || role.includes('pet')) {
      add('Trumpet', 'SM57 / Clip', 'Tall Boom', name);
    } else if (role.includes('trombone') || role.includes('bone')) {
      add('Trombone', 'SM57 / Clip', 'Tall Boom', name);
    }
    // Horn section (grouped zone) — expand per instrument in the role
    else if (role.includes('horn') || (role.includes('sax') && role.includes('tpt'))) {
      const parts = role.split(/[,&+\/]/);
      for (const part of parts) {
        const p = part.trim().toLowerCase();
        if (p.includes('sax')) add('Sax', 'SM57 / Clip', 'Tall Boom', name);
        else if (p.includes('tpt') || p.includes('trumpet') || p.includes('pet')) add('Trumpet', 'SM57 / Clip', 'Tall Boom', name);
        else if (p.includes('bone') || p.includes('trombone')) add('Trombone', 'SM57 / Clip', 'Tall Boom', name);
        else if (p) add(part.trim(), 'SM57 / Clip', 'Tall Boom', name);
      }
    }
    // Lead vocals
    else if (role.includes('lead vox') || role.includes('lead vocal') || role.includes('singer') || role.includes('vox')) {
      add('Lead Vox', 'Beta 58', 'Straight', name);
    }
    // Generic fallback — one channel
    else {
      add(slot.role || name, '', '', name);
    }

    // Add vocal mic if role mentions BGV, vocal, or singing alongside an instrument
    if (!role.includes('lead vox') && !role.includes('lead vocal') && !role.includes('singer')) {
      if (role.includes('bgv') || role.includes('vocal') || role.includes('vox') || role.includes('sing')) {
        add('BGV', 'SM58', 'Boom', name);
      }
    }

    return results;
  }

  function validateToolInput(name: string, input: Record<string, unknown>): string | null {
    switch (name) {
      case 'update_stage_plot':
        if (!Array.isArray(input.stagePlot)) return 'stagePlot must be an array';
        break;
      case 'update_inputs':
        if (!Array.isArray(input.inputs)) return 'inputs must be an array';
        break;
      case 'update_monitors':
        if (!Array.isArray(input.monitors)) return 'monitors must be an array';
        break;
      case 'update_setlist':
        if (!Array.isArray(input.setlist)) return 'setlist must be an array';
        break;
      case 'update_notes':
        if (!Array.isArray(input.notes)) return 'notes must be an array';
        break;
      case 'update_show_info':
        if (input.showInfo && typeof input.showInfo !== 'object') return 'showInfo must be an object';
        break;
    }
    return null;
  }

  function applyToolCall(msgIdx: number, toolIdx: number) {
    setMessages((prev) => {
      const updated = [...prev];
      const msg = { ...updated[msgIdx], toolCalls: [...(updated[msgIdx].toolCalls || [])] };
      const tc = msg.toolCalls![toolIdx];

      const validationError = validateToolInput(tc.name, tc.input);
      if (validationError) {
        setError(`Invalid tool output: ${validationError}`);
        msg.toolCalls![toolIdx] = { ...tc, status: 'rejected' as const };
        updated[msgIdx] = msg;
        return updated;
      }

      msg.toolCalls![toolIdx] = { ...tc, status: 'applied' as const };
      updated[msgIdx] = msg;

      const toolInput = tc.input;
      updateConfig((p) => {
        switch (tc.name) {
          case 'update_stage_plot': {
            const newPlot = toolInput.stagePlot as StageSlot[];
            const result = { ...p, stagePlot: newPlot };

            // Cascade: expand stage slots into per-channel input list.
            let ch = 1;
            const inputs: InputChannel[] = [];
            for (const slot of newPlot) {
              for (const input of expandSlotToInputs(slot)) {
                inputs.push({ ...input, ch: ch++ });
              }
            }
            result.inputs = inputs;

            // Cascade: generate monitor mixes from stage plot
            const mixMap = new Map<number, string[]>();
            for (const slot of newPlot) {
              if (!slot.mix) continue; // skip slots with no monitor assignment
              const names = mixMap.get(slot.mix) || [];
              names.push(slot.name);
              mixMap.set(slot.mix, names);
            }
            const monitors: MonitorMix[] = [];
            for (const [mix, names] of Array.from(mixMap.entries()).sort((a, b) => a[0] - b[0])) {
              monitors.push({
                mix,
                name: names.join(', '),
                needs: '',
              });
            }
            result.monitors = monitors;

            return result;
          }
          case 'update_inputs':
            return { ...p, inputs: toolInput.inputs as InputChannel[] };
          case 'update_monitors':
            return { ...p, monitors: toolInput.monitors as MonitorMix[] };
          case 'update_setlist':
            return { ...p, setlist: toolInput.setlist as SetlistSong[] };
          case 'update_notes':
            return { ...p, notes: toolInput.notes as GeneralNote[] };
          case 'update_show_info': {
            const si = toolInput.showInfo as { bandName?: string; showName?: string; eventDate?: string; venue?: string } | undefined;
            const lineup = toolInput.lineup as string | undefined;
            const merged = si ? { ...p.showInfo, ...si } : p.showInfo;
            merged.showName = merged.showName?.trim() || undefined;
            return {
              ...p,
              ...(lineup ? { lineup } : {}),
              showInfo: merged,
            };
          }
          default:
            return p;
        }
      });

      return updated;
    });
  }

  function rejectToolCall(msgIdx: number, toolIdx: number) {
    setMessages((prev) => {
      const updated = [...prev];
      const msg = { ...updated[msgIdx], toolCalls: [...(updated[msgIdx].toolCalls || [])] };
      msg.toolCalls![toolIdx] = { ...msg.toolCalls![toolIdx], status: 'rejected' as const };
      updated[msgIdx] = msg;
      return updated;
    });
  }

  // ── The ONE path into "we no longer hold a device key" ─────────────────────
  //
  // The prominent recovery button and the overlay's device-Remove both route
  // here, so the state derived from the key can never drift between call sites.
  //
  // Codex R1 and R2 on #140 were the same defect at two call sites: clearing the
  // key reset the derived state but a second handler did not, so a stale
  // `tryitExhausted`/`tryitRemaining` overrode a fresh probe and pinned the user
  // in state 4 with the composer disabled. One function is the fix.
  //
  // This DOES clear storage now (chunk 4): the persist effect that used to remove
  // the entry as a side effect of `apiKey` emptying is gone, because the overlay
  // is the sole writer. With no effect to lean on, the clear is explicit here — a
  // single call, not a competing second path. `persistKey(…, '', …)` removes the
  // entry from BOTH stores regardless of the `remember` flag (lib/byoa-key-storage,
  // pinned by tests/byoa-key-storage.test.ts).
  function handleClearKey() {
    persistKey(localStorage, sessionStorage, '', true);
    setApiKey('');
    // A rejection describes a key we no longer hold.
    setRejectedKey(null);
    // Back to state 2 (`checking`) while the probe re-runs, rather than showing
    // whatever a PREVIOUS probe found — plausibly `error` from before the key
    // was pasted — as though it described the request now in flight. Safe
    // because `effectiveProbe` derives `skipped` from `loading` only while a
    // key is held.
    setFetchedProbe('loading');
    // The load-bearing pair (Codex R1). `sendRemaining`/`sendExhausted` OUTRANK
    // the probe in `resolveAvailability` — deliberately, so spending the last
    // free message updates the panel without a remount — so a stale
    // exhausted-or-zero from an earlier send silently beats the fresh probe.
    // §5.1 promises the opposite: clearing re-probes and, when try-it is
    // available, lands in state 3. The probe is the newer measurement, so
    // everything derived from older sends goes with the key.
    setTryitRemaining(null);
    setTryitExhausted(false);
  }

  // The overlay's callbacks (chunk 4). A DEVICE key saved in the overlay reaches
  // the host here so `apiKey` — and therefore Send — updates in place, with no
  // remount (§9 T22); the overlay already wrote storage, so this only mirrors it
  // into state. An empty value is a device Remove, which is exactly `handleClearKey`.
  function handleDeviceKeyChange(next: string) {
    if (!next) {
      handleClearKey();
      return;
    }
    // A rejection described the OLD key; a freshly saved one makes that banner stale.
    setApiKey(next);
    setRejectedKey(null);
  }

  // An ACCOUNT key change is invisible to the browser — only the server-side probe
  // can see it — so re-run the probe to pick it up. Reset to `loading` so a prior
  // verdict (e.g. state 5) does not outlive the save that invalidated it (§9 T22),
  // and bump the nonce so the mount effect actually re-fetches even though `apiKey`
  // has not changed. Harmless when a device key is held: the effect early-returns
  // and device precedence keeps state 1.
  function handleAccountKeyChange() {
    setFetchedProbe('loading');
    setProbeNonce((n) => n + 1);
    // The SAME stale-send-state reset handleClearKey does, for the same reason (Codex
    // chunk-4 R1): `sendExhausted`/`sendRemaining` OUTRANK a `loading` probe, so a prior
    // try-it 429 would keep the panel on "free messages used up" through the whole
    // re-probe window — and, until the probe returns `{ accountKey: true }`, block a
    // user who now has a working account key. Saving/removing an account key changes how
    // a send is authorized, so the try-it send state it invalidates goes with it.
    setTryitRemaining(null);
    setTryitExhausted(false);
    // And the account-key rejection banner: Remove/Replace is exactly the fix it asked
    // for, so it must not survive the action (design-account-key-recovery §4.1). Without
    // this the "that account key was rejected" banner outlives the key it described.
    setRejectedKey(null);
  }

  // §5.2a.2b / test 13m: a failed turn must NOT lock the composer. That holds
  // through the data — finalizeTurn discards a failed turn's tool calls — not
  // through a special case here. Extracted alongside buildApiMessages so the
  // pair can be asserted together.
  const hasPendingTools = transcriptHasPendingTools(messages);

  // Replaces `!!apiKey || !tryitExhausted` (§5). That predicate was true whenever no
  // key was set and no 429 had arrived — and only a 429 set tryitExhausted, so with
  // try-it UNCONFIGURED (a 401) the composer stayed enabled forever, inviting sends
  // the app already knew would fail. The rules now live in one tested function.
  const availability = resolveAvailability({
    apiKey,
    probe,
    sendRemaining: tryitRemaining,
    sendExhausted: tryitExhausted,
  });
  const canSend = canSendMessage({ availability, streaming, hasPendingTools });
  const needsKey = availability.showKeyField && !apiKey;

  const toolNameLabels: Record<string, string> = {
    update_stage_plot: 'Stage Plot',
    update_inputs: 'Input List',
    update_monitors: 'Monitor Mixes',
    update_setlist: 'Setlist',
    update_notes: 'General Notes',
    update_show_info: 'Show Info',
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-500">
        Describe your band in plain English. The AI builds your stage plot, input list, and monitors.
      </p>

      {/* Availability lead copy + the settings affordance. The old "Try it free" line
          rendered under `!apiKey && !tryitExhausted && tryitRemaining === null` — which
          is exactly the UNCONFIGURED state, so the tab advertised a free trial that was
          not set up. That claim is gone; the panel only says what the probe measured.
          The inline key input is gone too (chunk 4): every "you need a key" state now
          opens the settings overlay below, one entry surface. */}
      <AgentAvailabilityPanel
        availability={availability}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {/* The settings overlay (§3.1). Rendered as a sibling of the still-mounted host,
          so opening it does not unmount the workspace and the composer text survives
          (§9 T21). Same `ByoaKeySettings` the /dashboard/settings page renders — one
          route, two presentations (§9 T24) — wired so a saved key reaches the host with
          no remount (§9 T22). */}
      {settingsOpen && (
        <SettingsOverlay onClose={() => setSettingsOpen(false)}>
          <ByoaKeySettings
            onDeviceKeyChange={handleDeviceKeyChange}
            onAccountKeyChange={handleAccountKeyChange}
          />
        </SettingsOverlay>
      )}

      {/* Chat messages */}
      {(messages.length > 0 || streaming) && <div className="border border-gray-200 rounded-lg p-3 max-h-[calc(100vh-280px)] overflow-y-auto space-y-3 text-sm bg-white">
        {messages.map((msg, msgIdx) => (
          <div key={msgIdx} className={msg.role === 'user' ? 'text-right' : ''}>
            {msg.role === 'user' ? (
              <div className="inline-block bg-black text-white rounded-lg px-3 py-2 max-w-[85%] text-left">
                {msg.content}
              </div>
            ) : (
              <div className="space-y-2">
                {msg.content && (
                  <div className="bg-gray-100 rounded-lg px-3 py-2 whitespace-pre-wrap">{msg.content}</div>
                )}
                {/* §5.2a.2: the turn stays visible and is visibly marked. Saying
                    so matters — without it a half-answer is indistinguishable
                    from Claude choosing to stop, which is the defect this
                    section exists to fix. The second line is not decoration:
                    the turn really is excluded from what Claude sees next, and
                    a user who re-asks deserves to know why it has no memory of
                    it. */}
                {msg.failed && (
                  <p className="text-xs text-red-600">
                    This response was interrupted. It won&apos;t be sent back to Claude as context — ask again to continue.
                  </p>
                )}
                {msg.toolCalls?.map((tc, tcIdx) => (
                  <div key={tc.id} className="border border-gray-300 rounded-lg p-3 bg-gray-50">
                    <p className="text-xs font-bold text-gray-500 mb-2">
                      Update: {toolNameLabels[tc.name] || tc.name}
                    </p>
                    <div className="text-xs text-gray-600 mb-2 max-h-32 overflow-y-auto">
                      <ToolCallPreview name={tc.name} input={tc.input} />
                    </div>
                    {tc.status === 'pending' ? (
                      <div className="flex gap-2">
                        <button
                          onClick={() => applyToolCall(msgIdx, tcIdx)}
                          className="px-3 py-1 text-xs font-bold bg-black text-white rounded hover:bg-gray-800 transition-colors"
                        >
                          Apply
                        </button>
                        <button
                          onClick={() => rejectToolCall(msgIdx, tcIdx)}
                          className="px-3 py-1 text-xs font-bold bg-white text-gray-700 border border-gray-300 rounded hover:bg-gray-100 transition-colors"
                        >
                          Reject
                        </button>
                      </div>
                    ) : (
                      <p className={`text-xs font-bold ${tc.status === 'applied' ? 'text-green-600' : 'text-red-500'}`}>
                        {tc.status === 'applied' ? 'Applied' : 'Rejected'}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {streaming && (
          <div className="text-gray-400 text-xs animate-pulse">Thinking...</div>
        )}
        <div ref={chatEndRef} />
      </div>}

      {error && (
        <div className="space-y-2">
          <p className="text-sm text-red-600">{error}</p>
          {/* §5.1: a prominent action, not a small link beside the input. The
              existing Clear control is undiscoverable at the moment of failure,
              which is the only moment it matters. Clearing re-runs the probe
              (the effect fires when `apiKey` empties), so if try-it is
              configured the panel drops straight into state 3 and the user
              continues with no key at all. The failed message is NOT
              auto-retried — Send is re-armed and the user presses it. */}
          {/* Which recovery depends on WHICH key the server rejected (design-account-
              key-recovery §4). A device key lives in this browser, so clearing it here
              is the fix; an account key lives server-side, so the fix is the Settings
              overlay's Remove/Replace. */}
          {rejectedKey === 'device' && (
            <div className="flex items-center gap-3">
              <button
                onClick={handleClearKey}
                className="px-3 py-2 text-sm font-medium text-white bg-red-600 rounded hover:bg-red-700"
              >
                Clear saved key
              </button>
              {/* "That key" rather than "your saved key": the rejected key may
                  have been typed a second ago and never saved. The button label
                  is §5.1's, verbatim. */}
              <span className="text-xs text-gray-500">
                That key was rejected. Clearing it lets ShowRunr check whether
                free try-it mode is available.
              </span>
            </div>
          )}
          {rejectedKey === 'account' && (
            <div className="flex items-center gap-3">
              <button
                onClick={() => setSettingsOpen(true)}
                className="px-3 py-2 text-sm font-medium text-white bg-red-600 rounded hover:bg-red-700"
              >
                Manage key in Settings
              </button>
              {/* Removing or replacing the account key in the overlay clears this
                  banner via handleAccountKeyChange (§4.1). */}
              <span className="text-xs text-gray-500">
                That account key was rejected. Remove or replace it in Settings.
              </span>
            </div>
          )}
        </div>
      )}

      {/* Input */}
      <div className="flex gap-2 items-end">
        <textarea
          className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-black bg-white resize-none"
          rows={2}
          placeholder={needsKey ? 'Add your API key in Settings to continue...' : hasPendingTools ? 'Apply or reject pending changes first...' : messages.length > 0 ? 'Reply or ask a follow-up...' : 'Describe your band, lineup, and stage layout...'}
          value={input}
          disabled={!canSend}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
        />
        <button
          onClick={() => sendMessage()}
          disabled={!canSend || !input.trim()}
          className="px-4 py-2 text-sm font-bold bg-black text-white rounded hover:bg-gray-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Send
        </button>
      </div>
    </div>
  );
}

function ToolCallPreview({ name, input }: { name: string; input: Record<string, unknown> }) {
  const fallback = <pre className="whitespace-pre-wrap">{JSON.stringify(input, null, 2)}</pre>;
  switch (name) {
    case 'update_stage_plot': {
      const slots = input.stagePlot;
      if (!Array.isArray(slots)) return fallback;
      return (
        <div className="space-y-2">
          <div>
            <p className="font-bold text-gray-500 mb-1">Stage Plot</p>
            <ul className="space-y-0.5">
              {slots.map((s: Record<string, unknown>, i: number) => (
                <li key={i}>
                  <span className="font-bold">{String(s.name)}</span> — {String(s.role)}, {String(s.pos)}
                  {s.featured ? ' (featured)' : ''}{s.power ? ' [POWER]' : ''}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="font-bold text-gray-500 mb-1">Input List (auto-generated, editable after apply)</p>
            <ul className="space-y-0.5">
              {(() => {
                let ch = 1;
                return slots.flatMap((s: Record<string, unknown>) => {
                  const role = String(s.role || '').toLowerCase();
                  const nm = String(s.name);
                  const lines: { ch: number; inst: string; note: string }[] = [];
                  const add = (inst: string) => lines.push({ ch: ch++, inst, note: nm });
                  if (role.includes('drum')) { add('Kick'); add('Snare'); add('Hi-Hat'); add('Rack Tom'); add('Floor Tom'); add('OH L'); add('OH R'); }
                  else if (role.includes('bass')) { add('Bass DI'); if (role.includes('amp')) add('Bass Amp'); }
                  else if (role.includes('key') || role.includes('piano') || role.includes('organ')) {
                    if (role.includes('piano') && (role.includes('hi') || role.includes('lo') || role.includes('mic'))) { add('Piano Hi'); add('Piano Lo'); }
                    if (role.includes('stereo')) { add('Keys L'); add('Keys R'); } else add('Keys');
                  }
                  else if (role.includes('gtr') || role.includes('guitar')) add('Guitar');
                  else if (role.includes('sax')) add('Sax');
                  else if (role.includes('trumpet') || role.includes('tpt') || role.includes('pet')) add('Trumpet');
                  else if (role.includes('trombone') || role.includes('bone')) add('Trombone');
                  else if (role.includes('lead vox') || role.includes('lead vocal') || role.includes('singer') || role.includes('vox')) add('Lead Vox');
                  else add(String(s.role || s.name));
                  if (!role.includes('lead vox') && !role.includes('singer') && (role.includes('bgv') || role.includes('vocal'))) add('BGV');
                  return lines;
                }).map((l) => <li key={l.ch}>Ch {l.ch}: {l.inst} ({l.note})</li>);
              })()}
            </ul>
          </div>
          <div>
            <p className="font-bold text-gray-500 mb-1">Monitor Mixes (auto-generated)</p>
            <ul className="space-y-0.5">
              {(() => {
                const mixMap = new Map<number, string[]>();
                for (const s of slots) {
                  const mix = Number(s.mix);
                  if (!mix) continue; // skip slots with no monitor assignment
                  const names = mixMap.get(mix) || [];
                  names.push(String(s.name));
                  mixMap.set(mix, names);
                }
                return Array.from(mixMap.entries()).sort((a, b) => a[0] - b[0]).map(([mix, names]) => (
                  <li key={mix}>Mix {mix}: {names.join(', ')}</li>
                ));
              })()}
            </ul>
          </div>
        </div>
      );
    }
    case 'update_inputs': {
      const inputs = input.inputs;
      if (!Array.isArray(inputs)) return fallback;
      return (
        <ul className="space-y-0.5">
          {inputs.map((inp: Record<string, unknown>, i: number) => (
            <li key={i}>
              Ch {String(inp.ch)}: {String(inp.inst)} — {String(inp.mic)}, {String(inp.stand)}{inp.notes ? ` (${String(inp.notes)})` : ''}
            </li>
          ))}
        </ul>
      );
    }
    case 'update_monitors': {
      const monitors = input.monitors;
      if (!Array.isArray(monitors)) return fallback;
      return (
        <ul className="space-y-0.5">
          {monitors.map((m: Record<string, unknown>, i: number) => (
            <li key={i}>
              {/* `m.type &&` not `String(m.type)`: an absent type must render
                  nothing, and String(undefined) is the literal "undefined". */}
              Mix {String(m.mix)}: {String(m.name)}
              {m.type ? ` (${String(m.type)})` : ''} — {String(m.needs)}
            </li>
          ))}
        </ul>
      );
    }
    case 'update_setlist': {
      const songs = input.setlist;
      if (!Array.isArray(songs)) return fallback;
      return (
        <ul className="space-y-0.5">
          {songs.map((s: Record<string, unknown>, i: number) => (
            <li key={i}>
              {String(s.position)}. {String(s.title)} — {String(s.lead)}{s.notes ? ` (${String(s.notes)})` : ''}
            </li>
          ))}
        </ul>
      );
    }
    case 'update_notes': {
      const notes = input.notes;
      if (!Array.isArray(notes)) return fallback;
      return (
        <ul className="space-y-0.5">
          {notes.map((n: Record<string, unknown>, i: number) => (
            <li key={i}><span className="font-bold">{String(n.label)}:</span> {String(n.text)}</li>
          ))}
        </ul>
      );
    }
    case 'update_show_info': {
      const si = input.showInfo as Record<string, unknown> | undefined;
      const lineup = input.lineup;
      return (
        <ul className="space-y-0.5">
          {si?.bandName ? <li>Band: {String(si.bandName)}</li> : null}
          {si?.showName ? <li>Show: {String(si.showName)}</li> : null}
          {si?.eventDate ? <li>Date: {String(si.eventDate)}</li> : null}
          {si?.venue ? <li>Venue: {String(si.venue)}</li> : null}
          {lineup ? <li>Lineup: {String(lineup)}</li> : null}
        </ul>
      );
    }
    default:
      return fallback;
  }
}

const labelCls = 'block text-xs font-bold text-gray-500 uppercase mb-1';
const sectionCls = 'bg-white rounded-xl border border-gray-200 shadow-sm p-4 md:p-6';
const btnAdd = 'px-3 py-1.5 text-xs font-bold bg-gray-100 border border-gray-300 rounded hover:bg-gray-200 transition-colors';
const btnRemove = 'px-2 py-1 text-xs text-red-600 hover:text-red-800 hover:bg-red-50 rounded transition-colors';

function ConfigTab({
  config,
  updateConfig,
  onBpmChange,
  onImportApply,
  googleToken,
  googleError,
  onDisconnectGoogle,
  showId,
  ownerId,
  isOwner,
}: {
  config: AppConfig;
  // `automatic` marks a write that is a consequence of another change rather than a
  // user edit — it does not expire import-undo. See Page's updateConfig.
  updateConfig: (fn: (prev: AppConfig) => AppConfig, opts?: { automatic?: boolean }) => void;
  // Session-lifetime canonical-BPM writer, owned by Page (survives tab remounts).
  onBpmChange: (songId: string, bpm: number | null) => void;
  // Commits an import merge AND arms one-level undo, in Page so the affordance
  // survives this tab's remount (design §7). Deliberately not updateConfig.
  onImportApply: (merged: SetlistSong[], before: SetlistSong[]) => void;
  googleToken: GoogleToken | null;
  googleError?: string;
  onDisconnectGoogle: () => void;
  showId: string | null;
  ownerId: string | null;
  isOwner: boolean;
}) {
  const [sheetUrl, setSheetUrl] = useState('');
  const [sheetLoading, setSheetLoading] = useState(false);
  const [sheetError, setSheetError] = useState('');
  // Fetched sheet rows awaiting the user's Apply. Non-null ⇒ the preview panel
  // replaces the loader row (§7). Nothing here has touched config.
  const [importRows, setImportRows] = useState<{
    rows: ImportedRow[];
    ignored: { bpm: boolean; artist: boolean };
  } | null>(null);
  const [importRemoveMissing, setImportRemoveMissing] = useState(false);
  const [driveSetupLoading, setDriveSetupLoading] = useState(false);
  const [driveError, setDriveError] = useState('');
  const [folderIdInput, setFolderIdInput] = useState(config.chartsRootFolderId ?? '');
  const [chartsResolving, setChartsResolving] = useState(false);
  const [chartsError, setChartsError] = useState('');
  // Title of the song whose charts the shared Manage-Charts modal is open for.
  const [manageChartsSong, setManageChartsSong] = useState<string | null>(null);

  // Count songs with resolved charts
  const chartsMatchCount = config.setlist.filter((s) => s.charts && s.charts.length > 0).length;
  const canResolveCharts = !!googleToken && !!config.chartsRootFolderId && config.setlist.length > 0;

  // Version guard: prevents out-of-order batch responses from overwriting newer data
  const resolveVersionRef = useRef(0);

  const resolveCharts = useCallback(async () => {
    if (!googleToken || !config.chartsRootFolderId || config.setlist.length === 0) return;
    const version = ++resolveVersionRef.current;
    setChartsResolving(true);
    setChartsError('');
    try {
      const res = await fetch('/api/drive/batch', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${googleToken.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          folderId: config.chartsRootFolderId,
          songs: config.setlist.map((s, idx) => ({ idx, title: s.title })),
        }),
      });
      // Discard if a newer resolve was started while this one was in flight
      if (version !== resolveVersionRef.current) return;
      if (res.status === 401) {
        setChartsError('Google session expired — reconnect Drive');
        onDisconnectGoogle();
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Unknown error' })) as { error?: string };
        setChartsError(data.error ?? `Error (${res.status})`);
        return;
      }
      const data = await res.json() as { results: { idx: number; charts: Chart[] }[] };
      if (version !== resolveVersionRef.current) return;
      // `automatic`: this write is a debounced consequence of a setlist change, not
      // a user edit, so it must not expire the import-undo affordance (§7).
      updateConfig((p) => {
        const newSetlist = [...p.setlist];
        for (const r of data.results) {
          if (newSetlist[r.idx]) {
            newSetlist[r.idx] = { ...newSetlist[r.idx], charts: r.charts };
          }
        }
        return { ...p, setlist: newSetlist };
      }, { automatic: true });
    } catch {
      if (version === resolveVersionRef.current) {
        setChartsError('Network error resolving charts');
      }
    } finally {
      if (version === resolveVersionRef.current) {
        setChartsResolving(false);
      }
    }
  }, [googleToken, config.chartsRootFolderId, config.setlist, updateConfig, onDisconnectGoogle]);

  // Auto-resolve charts when setlist titles or folder ID change (debounced 1s)
  const resolveSignature = `${config.chartsRootFolderId ?? ''}\n${config.setlist.map((s) => s.title).join('\0')}`;
  const prevSignatureRef = useRef(resolveSignature);
  const resolveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Drive-era only. Supabase shows resolve charts from the library on every GET,
    // so we must never wipe them here — bail out when this is a Supabase show.
    if (showId) return;

    // Clear charts and invalidate in-flight requests when Drive is disconnected
    if (!config.chartsRootFolderId) {
      resolveVersionRef.current++;
      const hasCharts = config.setlist.some((s) => s.charts);
      if (hasCharts) {
        // `automatic` for the same reason as the resolve write below: this is an
        // effect-driven consequence, and this effect re-runs on every setlist
        // change — so on a local (non-Supabase) show it would otherwise expire
        // import-undo the moment the merge landed.
        updateConfig((p) => ({
          ...p,
          setlist: p.setlist.map((s) => ({ ...s, charts: undefined })),
        }), { automatic: true });
      }
      prevSignatureRef.current = resolveSignature;
      return;
    }

    if (!canResolveCharts) return;
    if (resolveSignature === prevSignatureRef.current) return;
    prevSignatureRef.current = resolveSignature;

    // Invalidate any in-flight request from the previous signature
    resolveVersionRef.current++;
    if (resolveTimerRef.current) clearTimeout(resolveTimerRef.current);
    resolveTimerRef.current = setTimeout(() => {
      resolveCharts();
    }, 1000);

    return () => { if (resolveTimerRef.current) clearTimeout(resolveTimerRef.current); };
  }, [showId, resolveSignature, canResolveCharts, resolveCharts, config.chartsRootFolderId, config.setlist, updateConfig]);

  // Extract folder ID from URL or bare ID
  const parseFolderId = (input: string): string | null => {
    const trimmed = input.trim();
    // Match /folders/FOLDER_ID or /d/FOLDER_ID patterns in Drive URLs
    const urlMatch = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (urlMatch) return urlMatch[1];
    const dMatch = trimmed.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (dMatch) return dMatch[1];
    // Bare ID (no slashes, reasonable length)
    if (/^[a-zA-Z0-9_-]{10,}$/.test(trimmed)) return trimmed;
    return null;
  };

  const handleSetupDrive = async () => {
    if (!googleToken || !folderIdInput.trim()) return;
    const folderId = parseFolderId(folderIdInput);
    if (!folderId) {
      setDriveError('Invalid folder URL or ID. Paste a Google Drive folder link or its ID.');
      return;
    }
    setDriveSetupLoading(true);
    setDriveError('');
    try {
      const res = await fetch(
        `/api/drive/setup?parentFolderId=${encodeURIComponent(folderId)}`,
        { headers: { Authorization: `Bearer ${googleToken.access_token}` } },
      );
      const data = await res.json();
      if (!res.ok) {
        setDriveError(data.error || 'Failed to setup Drive folders');
        return;
      }
      updateConfig((p) => ({ ...p, chartsRootFolderId: folderId }));
    } catch {
      setDriveError('Network error');
    } finally {
      setDriveSetupLoading(false);
    }
  };

  // Chunk 3 (design §7): fetch and PREVIEW. Nothing reaches config until Apply —
  // this handler's whole job is to put rows in state so the merge can be computed
  // and shown. It replaces the destructive rebuild that dropped id/songId/key/
  // bpm/charts on every re-import.
  const handlePreviewImport = async () => {
    if (!sheetUrl.trim()) return;
    setSheetLoading(true);
    setSheetError('');
    try {
      const res = await fetch(`/api/sheet?url=${encodeURIComponent(sheetUrl)}`);
      const data = await res.json();
      if (!res.ok) {
        setSheetError(data.error || 'Failed to load sheet');
        return;
      }
      // A sheet whose every row has a blank title parses to zero rows. Previewing
      // that would offer "Also remove the N songs not in this sheet" for the WHOLE
      // setlist — an invitation to wipe the show off the back of a malformed sheet.
      // Not in the design; refusing is plainly better than previewing it.
      const rows = data.songs as ImportedRow[];
      if (rows.length === 0) {
        setSheetError('No songs found in that sheet — every row is missing a title.');
        return;
      }
      setImportRemoveMissing(false); // §7: removal is opt-in on EVERY preview
      setImportRows({
        rows,
        ignored: {
          bpm: Boolean(data.ignored?.bpm),
          artist: Boolean(data.ignored?.artist),
        },
      });
    } catch {
      setSheetError('Network error');
    } finally {
      setSheetLoading(false);
    }
  };

  // The merge is computed client-side, so toggling the removal checkbox re-runs it
  // with no refetch (§7, §12 Q3). `newId` is injected per mergeSetlist's purity
  // contract (§0 rule 7); recomputation minting fresh ids is harmless because
  // nothing is persisted until Apply, which commits exactly this `merged` array.
  const importResult = useMemo(() => {
    if (!importRows) return null;
    return mergeSetlist(config.setlist, importRows.rows, {
      newId: () => crypto.randomUUID(),
      removeMissing: importRemoveMissing,
    });
  }, [importRows, config.setlist, importRemoveMissing]);

  const dismissImport = () => {
    setImportRows(null);
    setImportRemoveMissing(false);
  };

  const applyImport = () => {
    if (!importResult) return;
    // Page owns the undo snapshot: it must outlive this tab (ConfigTab remounts on
    // every tab switch) and it must not be cleared by the very mutation that
    // creates it, which is why it does NOT go through updateConfig.
    onImportApply(importResult.merged, config.setlist);
    dismissImport();
    // Auto-resolve charts fires on the next render via the existing effect.
  };

  return (
    <div className="p-4 md:p-8">
      <div className="max-w-4xl mx-auto space-y-8">

        {/* ── 1. Show Info ────────────────────────────────────────────── */}
        <section className={sectionCls}>
          <h2 className="text-lg font-bold mb-4">Show Info</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
            <div>
              <label className={labelCls}>Band Name</label>
              <input
                className={inputCls}
                value={config.showInfo.bandName}
                onChange={(e) =>
                  updateConfig((p) => ({
                    ...p,
                    showInfo: { ...p.showInfo, bandName: e.target.value },
                  }))
                }
              />
            </div>
            <div>
              <label className={labelCls}>Show Name</label>
              <input
                className={inputCls}
                placeholder="e.g., Friday Night at The Roxy"
                value={config.showInfo.showName ?? ''}
                onChange={(e) =>
                  updateConfig((p) => ({
                    ...p,
                    showInfo: { ...p.showInfo, showName: e.target.value.trim() || undefined },
                  }))
                }
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>Event Date</label>
              <input
                type="date"
                className={inputCls}
                value={config.showInfo.eventDate}
                onChange={(e) =>
                  updateConfig((p) => ({
                    ...p,
                    showInfo: { ...p.showInfo, eventDate: e.target.value },
                  }))
                }
              />
            </div>
            <div>
              <label className={labelCls}>Venue / Location</label>
              <input
                className={inputCls}
                value={config.showInfo.venue}
                onChange={(e) =>
                  updateConfig((p) => ({
                    ...p,
                    showInfo: { ...p.showInfo, venue: e.target.value },
                  }))
                }
              />
            </div>
          </div>
        </section>

        {/* ── 2. Stage Plot ───────────────────────────────────────────── */}
        <section className={sectionCls}>
          <h2 className="text-lg font-bold mb-4">Stage Plot</h2>
          <div className="mb-6">
            <DraggableStagePlotView
              stagePlot={config.stagePlot}
              inputs={config.inputs}
              onMove={(slotId, toPos) => updateConfig((p) => ({
                ...p,
                // Re-parent only the dragged slot; its id rides along so input links
                // survive. Other occupants of the source block are untouched (no swap).
                stagePlot: p.stagePlot.map((s) => (s.id === slotId ? { ...s, pos: toPos } : s)),
              }))}
              onAddOccupant={(pos) => updateConfig((p) => ({
                ...p,
                // New blank slot at this block; id is minted by the updateConfig normalizer.
                stagePlot: [...p.stagePlot, { name: '', pos, role: '', mix: 0 }],
              }))}
            />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left px-2 py-2 text-xs font-bold text-gray-500 min-w-[120px]">Role</th>
                  <th className="text-left px-2 py-2 text-xs font-bold text-gray-500 min-w-[60px]">Mix</th>
                  <th className="text-left px-2 py-2 text-xs font-bold text-gray-500 min-w-[78px]">Position</th>
                  <th className="text-center px-2 py-2 text-xs font-bold text-gray-500 w-14">Power</th>
                  <th className="text-left px-2 py-2 text-xs font-bold text-gray-500 min-w-[120px]">Name</th>
                  <th className="w-10"></th>
                </tr>
              </thead>
              <tbody>
                {config.stagePlot.map((slot, idx) => (
                  <tr key={idx} className="border-b border-gray-100">
                    <td className="px-2 py-1">
                      <input
                        className={inputCls}
                        value={slot.role}
                        onChange={(e) =>
                          updateConfig((p) => {
                            const arr = [...p.stagePlot];
                            arr[idx] = { ...arr[idx], role: e.target.value };
                            return { ...p, stagePlot: arr };
                          })
                        }
                      />
                    </td>
                    <td className="px-2 py-1">
                      <select
                        className={`${inputCls} px-1 text-center`}
                        value={slot.mix}
                        onChange={(e) =>
                          updateConfig((p) => {
                            const arr = [...p.stagePlot];
                            arr[idx] = { ...arr[idx], mix: Number(e.target.value) };
                            return { ...p, stagePlot: arr };
                          })
                        }
                      >
                        <option value={0}>&mdash;</option>
                        {config.monitors.map((m) => (
                          <option key={m.id ?? m.mix} value={m.mix}>{m.mix}</option>
                        ))}
                        {slot.mix > 0 && !config.monitors.some((m) => m.mix === slot.mix) && (
                          <option value={slot.mix}>{slot.mix}</option>
                        )}
                      </select>
                    </td>
                    <td className="px-2 py-1">
                      <select
                        className={`${inputCls} px-1`}
                        value={slot.pos}
                        onChange={(e) =>
                          updateConfig((p) => {
                            const arr = [...p.stagePlot];
                            arr[idx] = { ...arr[idx], pos: e.target.value as StagePosition };
                            return { ...p, stagePlot: arr };
                          })
                        }
                      >
                        {POSITIONS.map((pos) => (
                          <option key={pos} value={pos}>{pos}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-2 py-1 text-center">
                      <input
                        type="checkbox"
                        checked={slot.power ?? false}
                        onChange={(e) =>
                          updateConfig((p) => {
                            const arr = [...p.stagePlot];
                            arr[idx] = { ...arr[idx], power: e.target.checked };
                            return { ...p, stagePlot: arr };
                          })
                        }
                      />
                    </td>
                    <td className="px-2 py-1">
                      <input
                        className={inputCls}
                        value={slot.name}
                        onChange={(e) =>
                          updateConfig((p) => {
                            const arr = [...p.stagePlot];
                            arr[idx] = { ...arr[idx], name: e.target.value };
                            return { ...p, stagePlot: arr };
                          })
                        }
                      />
                    </td>
                    <td className="px-2 py-1">
                      <button
                        className={btnRemove}
                        onClick={() => {
                          const linked = slot.id
                            ? config.inputs.filter((i) => i.slotId === slot.id)
                            : [];
                          // Delete-time prompt is the primary guard when inputs are linked;
                          // the needs-attention badge is the backstop. OK = keep & flag,
                          // Cancel = clear their link.
                          const keep =
                            linked.length === 0 ||
                            window.confirm(
                              `${linked.length} input${linked.length > 1 ? 's are' : ' is'} linked to “${slotLabel(slot, blockIndexOf(config.stagePlot, idx))}”.\n\n` +
                                `OK: keep them (they'll be flagged to relink).\n` +
                                `Cancel: clear their link.`,
                            );
                          updateConfig((p) => ({
                            ...p,
                            stagePlot: p.stagePlot.filter((_, i) => i !== idx),
                            // Kept inputs keep their slotId and get flagged by the
                            // normalizer (dangling → needsReview). Cleared inputs drop it.
                            inputs: keep
                              ? p.inputs
                              : p.inputs.map((i) =>
                                  i.slotId === slot.id ? { ...i, slotId: undefined, needsReview: false } : i,
                                ),
                          }));
                        }}
                      >
                        X
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            className={`${btnAdd} mt-3`}
            onClick={() =>
              updateConfig((p) => ({
                ...p,
                stagePlot: [
                  ...p.stagePlot,
                  { name: '', pos: 'DSC' as StagePosition, role: '', mix: 0 },
                ],
              }))
            }
          >
            + Add Row
          </button>
        </section>

        {/* ── 3. Input List ───────────────────────────────────────────── */}
        <section className={sectionCls}>
          <h2 className="text-lg font-bold mb-4">Input List</h2>
          <SetupInputTable
            inputs={config.inputs}
            slots={config.stagePlot}
            onReorder={(from, to) => updateConfig((p) => ({ ...p, inputs: moveInput(p.inputs, from, to) }))}
            onUpdate={(idx, field, value) => updateConfig((p) => {
              const arr = [...p.inputs];
              arr[idx] = { ...arr[idx], [field]: field === 'ch' ? Number(value) : value };
              return { ...p, inputs: arr };
            })}
            onLink={(idx, slotId) => updateConfig((p) => {
              const arr = [...p.inputs];
              // Explicit user pick resolves any needs-attention state (valid slot OR "None").
              arr[idx] = { ...arr[idx], slotId, needsReview: false };
              return { ...p, inputs: arr };
            })}
            onCreateOccupant={(idx, pos) => updateConfig((p) => {
              const inst = p.inputs[idx]?.inst?.trim() ?? '';
              // Coalesce: reuse a same-block slot already named for this instrument
              // (so 6 drum rows + "New at USC" land on one shared-mix slot).
              const existing = inst
                ? p.stagePlot.find((s) => s.pos === pos && s.name.trim() === inst)
                : undefined;
              const arr = [...p.inputs];
              if (existing?.id) {
                arr[idx] = { ...arr[idx], slotId: existing.id, needsReview: false };
                return { ...p, inputs: arr };
              }
              // Otherwise mint a real slot now; name from the row's instrument else "Occupant {n}".
              const id = crypto.randomUUID();
              const name = inst || `Occupant ${p.stagePlot.filter((s) => s.pos === pos).length + 1}`;
              arr[idx] = { ...arr[idx], slotId: id, needsReview: false };
              return {
                ...p,
                stagePlot: [...p.stagePlot, { id, name, pos, role: '', mix: 0 }],
                inputs: arr,
              };
            })}
            onDelete={(idx) => updateConfig((p) => ({
              ...p,
              inputs: p.inputs.filter((_, i) => i !== idx).map((inp, i) => ({ ...inp, ch: i + 1 })),
            }))}
            onAdd={() => updateConfig((p) => ({
              ...p,
              inputs: [...p.inputs, { id: crypto.randomUUID(), ch: p.inputs.length + 1, inst: '', mic: '', stand: '', notes: '' }],
            }))}
          />
        </section>

        {/* ── 4. Monitor Mixes ────────────────────────────────────────── */}
        <section className={sectionCls}>
          <h2 className="text-lg font-bold mb-4">Monitor Mixes</h2>
          <SetupMonitorTable
            monitors={config.monitors}
            onReorder={(from, to) => updateConfig((p) => ({ ...p, monitors: moveMonitor(p.monitors, from, to) }))}
            onUpdate={(idx, field, value) => updateConfig((p) => {
              const arr = [...p.monitors];
              arr[idx] = { ...arr[idx], [field]: field === 'mix' ? Number(value) : value };
              return { ...p, monitors: arr };
            })}
            onDelete={(idx) => updateConfig((p) => ({
              ...p,
              monitors: p.monitors.filter((_, i) => i !== idx).map((mon, i) => ({ ...mon, mix: i + 1 })),
            }))}
            onAdd={() => updateConfig((p) => ({
              ...p,
              monitors: [...p.monitors, { id: crypto.randomUUID(), mix: p.monitors.length + 1, name: '', needs: '' }],
            }))}
          />
        </section>

        {/* ── 5. Notes ──────────────────────────────────────────────── */}
        <section className={sectionCls}>
          <h2 className="text-lg font-bold mb-4">Notes</h2>
          <div className="space-y-3">
            {config.notes.map((note, idx) => (
              <div key={idx} className="flex flex-col sm:flex-row gap-2 items-start sm:items-center border-b border-gray-100 pb-3">
                <div className="w-full sm:w-40 shrink-0">
                  <label className={labelCls}>Label</label>
                  <input
                    className={inputCls}
                    placeholder="e.g., Power"
                    value={note.label}
                    onChange={(e) => updateConfig((p) => {
                      const arr = [...p.notes];
                      arr[idx] = { ...arr[idx], label: e.target.value };
                      return { ...p, notes: arr };
                    })}
                  />
                </div>
                <div className="flex-1 w-full">
                  <label className={labelCls}>Text</label>
                  <input
                    className={inputCls}
                    placeholder="Note content..."
                    value={note.text}
                    onChange={(e) => updateConfig((p) => {
                      const arr = [...p.notes];
                      arr[idx] = { ...arr[idx], text: e.target.value };
                      return { ...p, notes: arr };
                    })}
                  />
                </div>
                <div className="pt-5">
                  <button className={btnRemove} onClick={() => updateConfig((p) => ({
                    ...p,
                    notes: p.notes.filter((_, i) => i !== idx),
                  }))}>X</button>
                </div>
              </div>
            ))}
          </div>
          <button
            className={`${btnAdd} mt-3`}
            onClick={() => updateConfig((p) => ({
              ...p,
              notes: [...p.notes, { label: '', text: '' }],
            }))}
          >
            + Add Note
          </button>
        </section>

        {/* ── 6. Setlist ──────────────────────────────────────────────── */}
        <section className={sectionCls}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold">Setlist</h2>
            {canResolveCharts && (
              <div className="flex items-center gap-3">
                <span className="text-xs text-gray-500">
                  Charts: {chartsMatchCount}/{config.setlist.length} matched
                </span>
                <button
                  onClick={resolveCharts}
                  disabled={chartsResolving}
                  className="px-3 py-1 text-xs font-bold bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors disabled:opacity-50"
                >
                  {chartsResolving ? 'Resolving...' : 'Refresh Charts'}
                </button>
              </div>
            )}
          </div>
          {chartsError && (
            <p className="text-xs text-red-600 mb-3">{chartsError}</p>
          )}

          {/* How it works — Sheet import */}
          <details className="mb-4 text-sm">
            <summary className="cursor-pointer text-xs font-bold text-gray-400 uppercase hover:text-gray-600">How it works</summary>
            <ol className="mt-2 ml-4 list-decimal space-y-1 text-gray-600">
              <li>Columns: <strong>Title</strong> (or Song) is required. Optional: <strong>#</strong>, <strong>Key</strong>, <strong>Lead</strong>, <strong>Notes</strong>, <strong>Scene Note</strong>.</li>
              <li>Re-importing matches songs by title and keeps their charts and tempo. A blank cell leaves the existing value alone, and songs missing from the sheet are kept unless you ask for them to be removed.</li>
              <li>Make the sheet publicly viewable: <em>Share &rarr; Anyone with the link &rarr; Viewer</em>, then paste the URL.</li>
            </ol>
          </details>

          {/* Google Sheet loader — replaced by the preview panel until dismissed (§7) */}
          {importRows && importResult ? (
            <SetlistImportPreview
              rowCount={importRows.rows.length}
              diff={importResult.diff}
              ignored={importRows.ignored}
              removeMissing={importRemoveMissing}
              onToggleRemoveMissing={setImportRemoveMissing}
              onApply={applyImport}
              onCancel={dismissImport}
            />
          ) : (
            <div className="flex flex-col sm:flex-row gap-2 mb-4 p-3 bg-gray-50 rounded-lg border border-gray-200">
              <input
                className={`${inputCls} flex-1`}
                placeholder="Google Sheet URL..."
                value={sheetUrl}
                onChange={(e) => setSheetUrl(e.target.value)}
              />
              <button
                className="px-4 py-1.5 text-xs font-bold bg-green-600 text-white rounded hover:bg-green-700 transition-colors disabled:opacity-50 whitespace-nowrap"
                onClick={handlePreviewImport}
                disabled={sheetLoading}
              >
                {sheetLoading ? 'Loading...' : 'Preview import'}
              </button>
            </div>
          )}
          {sheetError && (
            <p className="text-xs text-red-600 mb-3">{sheetError}</p>
          )}

          <SetupSetlistTable
            setlist={config.setlist}
            canResolveCharts={canResolveCharts}
            isOwner={isOwner}
            ownerId={ownerId}
            onReorder={(from, to) => updateConfig((p) => ({ ...p, setlist: moveSetlistSong(p.setlist, from, to) }))}
            onUpdate={(idx, field, value) => updateConfig((p) => {
              const arr = [...p.setlist];
              arr[idx] = { ...arr[idx], [field]: value };
              return { ...p, setlist: arr };
            })}
            onDelete={(idx) => updateConfig((p) => ({
              ...p,
              setlist: p.setlist.filter((_, i) => i !== idx).map((s, i) => ({ ...s, position: i + 1 })),
            }))}
            onAddSong={(song) => {
              updateConfig((p) => ({
                ...p,
                setlist: [...p.setlist, {
                  id: crypto.randomUUID(),
                  songId: song.songId,
                  position: p.setlist.length + 1,
                  title: song.title,
                  key: song.key,
                  lead: song.lead || '',
                  notes: song.notes,
                  bpm: song.bpm ?? null,
                  charts: song.charts,
                }],
              }));
              // Cache the song's charts for offline use immediately (no reload needed)
              const newCharts = (song.charts ?? []).filter(
                (c) => c.url?.includes('/storage/v1/object/public/') && chartCacheKey(c),
              );
              if (newCharts.length > 0) {
                downloadAllCharts(newCharts, null, () => {}).catch(() => {});
              }
            }}
            onBpmChange={onBpmChange}
            onManageCharts={(songTitle) => setManageChartsSong(songTitle)}
          />
          {manageChartsSong && (
            <ManageChartsModal
              songTitle={manageChartsSong}
              charts={config.setlist.find((s) => s.title === manageChartsSong)?.charts ?? []}
              isOwner={isOwner}
              onClose={() => setManageChartsSong(null)}
              onChartsChanged={(charts) =>
                updateConfig((prev) => ({
                  ...prev,
                  setlist: updateSetlistCharts(prev.setlist, manageChartsSong, () => charts),
                }))
              }
            />
          )}
        </section>

        {/* ── 6. Google Drive Charts (legacy — only when no Supabase show) ── */}
        {!showId && (
        <section className={sectionCls}>
          <h2 className="text-lg font-bold mb-4">Charts / Lead Sheets</h2>

          {/* How it works — Charts */}
          <details className="mb-4 text-sm">
            <summary className="cursor-pointer text-xs font-bold text-gray-400 uppercase hover:text-gray-600">How it works</summary>
            <div className="mt-2 space-y-2 text-gray-600">
              <p>Charts are matched automatically from a Google Drive folder. The folder structure is:</p>
              <pre className="bg-gray-50 border border-gray-200 rounded p-2 text-xs overflow-x-auto">
{`Your Charts Folder/
  Lyrics/        ← lyric sheets
  Guitar/        ← chord charts
  Bass/          ← bass charts
  Piano / Keys/  ← keys charts
  Horns/         ← horn parts
  Drums/         ← drum charts
  Conductor/     ← full scores
  Other/         ← anything else`}
              </pre>
              <ol className="ml-4 list-decimal space-y-1">
                <li>Click <strong>Connect Google Drive</strong> and authorize read access.</li>
                <li>Create (or pick) a folder in Drive for your charts. Copy the folder URL.</li>
                <li>Paste it below and click <strong>Setup Chart Folders</strong> &mdash; the app creates the role subfolders for you.</li>
                <li>Drop chart files into the matching role folder. Name files after the song (e.g., &ldquo;Superstition.pdf&rdquo; in <code className="text-xs bg-gray-100 px-1 rounded">Guitar/</code>).</li>
                <li>On the <strong>Mix</strong> tab, each song in the setlist gets a music-note icon. Tap it to see matched charts.</li>
              </ol>
            </div>
          </details>

          {!googleToken ? (
            <div className="space-y-3">
              <p className="text-sm text-gray-600">
                Connect Google Drive to auto-match charts to songs by role (Lyrics, Guitar, Bass, etc.).
              </p>
              {googleError && (
                <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{googleError}</p>
              )}
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
              <a
                href="/api/auth/google"
                className="inline-block px-4 py-2 text-sm font-bold bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
              >
                Connect Google Drive
              </a>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <span className="text-xs font-bold text-green-600 bg-green-50 px-2 py-1 rounded">Connected</span>
                <button
                  onClick={() => {
                    onDisconnectGoogle();
                    updateConfig((p) => ({ ...p, chartsRootFolderId: undefined }));
                  }}
                  className="text-xs text-red-600 hover:text-red-800"
                >
                  Disconnect
                </button>
              </div>

              {config.chartsRootFolderId ? (
                <div className="p-3 bg-gray-50 rounded-lg border border-gray-200">
                  <p className="text-xs text-gray-500 mb-1">Charts folder ID</p>
                  <p className="text-sm font-mono text-gray-700 break-all">{config.chartsRootFolderId}</p>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-gray-600">
                    Paste the Google Drive folder URL (or ID) where your Charts folder should live.
                    The app will create role subfolders automatically.
                  </p>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      className={`${inputCls} flex-1`}
                      placeholder="Google Drive folder URL or ID..."
                      value={folderIdInput}
                      onChange={(e) => setFolderIdInput(e.target.value)}
                    />
                    <button
                      className="px-4 py-1.5 text-xs font-bold bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors disabled:opacity-50 whitespace-nowrap"
                      onClick={handleSetupDrive}
                      disabled={driveSetupLoading || !folderIdInput.trim()}
                    >
                      {driveSetupLoading ? 'Setting up...' : 'Setup Chart Folders'}
                    </button>
                  </div>
                  {driveError && <p className="text-xs text-red-600">{driveError}</p>}
                </div>
              )}
            </div>
          )}
        </section>
        )}

        {/* ── 8. Offline Access (Drive/anonymous only — Supabase shows auto-cache on load) ── */}
        {!showId && (
          <OfflineSection
            charts={config.setlist.flatMap((s) => s.charts ?? [])}
            googleToken={googleToken}
          />
        )}

        {/* ── 8. Export / Import ───────────────────────────────────────────── */}
        <section className={sectionCls}>
          <h2 className="text-lg font-bold mb-4">Export / Import</h2>
          <p className="text-sm text-gray-600 mb-4">
            Save your show as a <code>.yaml</code> file for backup or sharing between devices.
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              className="px-4 py-2 text-sm font-bold bg-black text-white rounded hover:bg-gray-800 transition-colors"
              onClick={() => {
                const yaml = serializeShow(config);
                const blob = new Blob([yaml], { type: 'application/x-yaml' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${slugify(config.showInfo.showName || config.showInfo.bandName)}.showrunr.yaml`;
                a.click();
                URL.revokeObjectURL(url);
              }}
            >
              Export Show (.yaml)
            </button>
            <button
              className="px-4 py-2 text-sm font-bold bg-gray-100 border border-gray-300 rounded hover:bg-gray-200 transition-colors"
              onClick={() => {
                const csv = exportPatchCsv(config.inputs);
                const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${slugify(config.showInfo.showName || config.showInfo.bandName)}-patch.csv`;
                a.click();
                URL.revokeObjectURL(url);
              }}
            >
              Export Patch (.csv)
            </button>
            <button
              className="px-4 py-2 text-sm font-bold bg-gray-100 border border-gray-300 rounded hover:bg-gray-200 transition-colors"
              onClick={() => {
                const xml = exportPatchXml(config.inputs, config.showInfo);
                const blob = new Blob([xml], { type: 'application/xml;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${slugify(config.showInfo.showName || config.showInfo.bandName)}-patch.xml`;
                a.click();
                URL.revokeObjectURL(url);
              }}
            >
              Export Patch (.xml)
            </button>
            <label className="px-4 py-2 text-sm font-bold bg-gray-100 border border-gray-300 rounded hover:bg-gray-200 transition-colors cursor-pointer">
              Import Show
              <input
                type="file"
                accept=".yaml,.yml,.json,application/x-yaml,application/json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = () => {
                    try {
                      const imported = deserializeShow(reader.result as string, file.name);
                      updateConfig(() => withStableIds(imported));
                    } catch (err) {
                      alert(err instanceof Error ? err.message : 'Could not read file.');
                    }
                  };
                  reader.readAsText(file);
                  e.target.value = '';
                }}
              />
            </label>
          </div>
        </section>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// OFFLINE SECTION (Config tab — download charts for gig-day use)
// ════════════════════════════════════════════════════════════════════════════

function OfflineSection({
  charts,
  googleToken,
}: {
  charts: Chart[];
  googleToken: GoogleToken | null;
}) {
  const [cacheStats, setCacheStats] = useState<{ count: number; bytes: number } | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Load cache stats on mount and after operations
  const refreshStats = useCallback(() => {
    getCacheStats().then(setCacheStats).catch(() => setCacheStats(null));
  }, []);

  useEffect(() => {
    refreshStats();
  }, [refreshStats]);

  const cacheableCharts = charts.filter(c => !!chartCacheKey(c));

  const handleDownload = async () => {
    if (cacheableCharts.length === 0) return;
    setDownloading(true);
    setProgress(null);

    try {
      // Register SW before first download
      await registerServiceWorker();

      const controller = new AbortController();
      abortRef.current = controller;

      const result = await downloadAllCharts(
        charts,
        googleToken?.access_token ?? null,
        (p) => setProgress({ ...p }),
        controller.signal,
      );

      setProgress(result);
    } finally {
      setDownloading(false);
      abortRef.current = null;
      refreshStats();
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
  };

  const handleClear = async () => {
    await clearChartCache();
    setCacheStats({ count: 0, bytes: 0 });
    setProgress(null);
  };

  const cacheableCount = charts.filter((c) => c.fileId && c.modifiedTime).length;

  return (
    <section className={sectionCls}>
      <h2 className="text-lg font-bold mb-4">Offline Access</h2>
      <p className="text-sm text-gray-600 mb-4">
        Cache charts for offline use at the gig. Requires an active internet connection to download.
      </p>

      {downloading ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <div className="flex-1 bg-gray-200 rounded-full h-2.5">
              <div
                className="bg-black h-2.5 rounded-full transition-all duration-300"
                style={{ width: `${progress && progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%` }}
              />
            </div>
            <span className="text-xs font-mono text-gray-500 shrink-0">
              {progress ? `${progress.done}/${progress.total}` : 'Starting...'}
            </span>
          </div>
          <button
            onClick={handleCancel}
            className="px-3 py-1.5 text-xs font-bold bg-gray-100 border border-gray-300 rounded hover:bg-gray-200 transition-colors"
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <button
            onClick={handleDownload}
            disabled={cacheableCount === 0}
            className="px-4 py-2 text-sm font-bold bg-black text-white rounded hover:bg-gray-800 transition-colors disabled:opacity-50"
          >
            Download Charts for Offline
          </button>

          {progress && !downloading && (
            <div className="text-xs text-gray-600 space-y-1">
              <p>
                {progress.done - progress.failed.length - progress.skipped} downloaded,
                {progress.skipped > 0 && ` ${progress.skipped} already cached,`}
                {progress.failed.length > 0 && ` ${progress.failed.length} failed,`}
                {progress.aborted && ' cancelled'}
              </p>
              {progress.failed.length > 0 && (
                <p className="text-amber-600">
                  {progress.failed.length} chart{progress.failed.length > 1 ? 's' : ''} could not be downloaded — these require internet
                </p>
              )}
            </div>
          )}

          {cacheStats && cacheStats.count > 0 && (
            <div className="flex items-center gap-4 p-3 bg-gray-50 rounded-lg border border-gray-200">
              <div className="text-sm">
                <span className="font-bold">{cacheStats.count}</span>
                <span className="text-gray-500"> chart{cacheStats.count !== 1 ? 's' : ''} cached</span>
                {cacheStats.bytes > 0 && (
                  <span className="text-gray-400"> ({formatBytes(cacheStats.bytes)})</span>
                )}
              </div>
              <button
                onClick={handleClear}
                className="px-3 py-1 text-xs text-red-600 hover:text-red-800 hover:bg-red-50 rounded transition-colors"
              >
                Clear Cache
              </button>
            </div>
          )}

          {cacheableCount === 0 && (
            <p className="text-xs text-gray-400 italic">
              No charts to cache. Resolve charts first by connecting Google Drive above.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
