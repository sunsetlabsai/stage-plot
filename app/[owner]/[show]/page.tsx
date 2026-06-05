'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
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
} from '@/lib/types';
import { ensureSetlistSongIds, moveSetlistSong, ensureInputIds, moveInput, ensureMonitorIds, moveMonitor } from '@/lib/setlist';
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
import { loadPdfDoc, renderPage, destroyAllDocs, prefetchChart } from '@/lib/pdf-viewer';
import { useShow } from '@/lib/use-show';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { normalizeSongKeySafe, displayRole } from '@/lib/normalize';
import type { ChartRole } from '@/lib/normalize';

// ─── Default band (imported at build time, used as fallback) ────────────────
import { getBand } from '@/lib/bands';
const fallbackBand = getBand();

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
function withStableIds(config: AppConfig): AppConfig {
  const setlist = ensureSetlistSongIds(config.setlist);
  const inputs = ensureInputIds(config.inputs);
  const monitors = ensureMonitorIds(config.monitors);
  const changed = setlist !== config.setlist || inputs !== config.inputs || monitors !== config.monitors;
  return changed ? { ...config, setlist, inputs, monitors } : config;
}

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

export default function Page() {
  const params = useParams();
  const owner = params.owner as string;
  const slug = params.show as string;

  const [tab, setTab] = useState<'perform' | 'mix' | 'config' | 'ai'>('perform');
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
  const [isEditor, setIsEditor] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const [chartCacheProgress, setChartCacheProgress] = useState<DownloadProgress | null>(null);
  const [setlistMigrated, setSetlistMigrated] = useState(false);

  const { context: showContext, saveConfig } = useShow(showId, slug, isOwner, isEditor, setlistMigrated);
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
        setConfig(withStableIds(JSON.parse(cached)));
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
      setIsEditor(false);
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

        const cfg = withStableIds(data.config);

        // Apply charts from owner's library (matched by normalized song title)
        if (data.charts && typeof data.charts === 'object') {
          const chartMap = data.charts as Record<string, Array<{ id: string; role: string; url: string; mime_type: string; updated_at: string; file_name: string }>>;
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

        // Check ownership/editor status using IDs from API response
        // Wrapped separately so auth failures don't hide already-loaded show content
        try {
          const supabase = getSupabaseBrowser();
          const { data: { user } } = await supabase.auth.getUser();
          if (cancelled) return;
          if (user && data.show_id) {
            let isOwnerFlag = false;
            let isEditorFlag = false;
            if (data.owner_id === user.id) {
              isOwnerFlag = true;
              isEditorFlag = true;
            } else {
              const { data: collab } = await supabase
                .from('show_collaborators')
                .select('role')
                .eq('show_id', data.show_id)
                .eq('user_id', user.id)
                .single();

              if (collab?.role === 'editor') isEditorFlag = true;
            }
            if (cancelled) return;
            setIsOwner(isOwnerFlag);
            setIsEditor(isEditorFlag);
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

  const updateConfig = useCallback((fn: (prev: AppConfig) => AppConfig) => {
    setConfig((prev) => fn(prev));
  }, []);

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
  const isReadOnly = !isOwner && !isEditor;

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
          {isAuthenticated && (
            <Link href="/dashboard" className="px-3 py-3 text-gray-400 hover:text-black transition-colors" title="My Shows">
              <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </Link>
          )}
          <button
            onClick={() => setTab('perform')}
            className={`flex-1 py-3 text-center font-bold text-sm uppercase tracking-wide transition-colors ${
              tab === 'perform'
                ? 'border-b-2 border-black text-black'
                : 'text-gray-400 hover:text-gray-600'
            }`}
          >
            Perform
          </button>
          <button
            onClick={() => setTab('mix')}
            className={`flex-1 py-3 text-center font-bold text-sm uppercase tracking-wide transition-colors ${
              tab === 'mix'
                ? 'border-b-2 border-black text-black'
                : 'text-gray-400 hover:text-gray-600'
            }`}
          >
            Mix
          </button>
          {!isReadOnly && (
          <button
            onClick={() => setTab('config')}
            className={`flex-1 py-3 text-center font-bold text-sm uppercase tracking-wide transition-colors ${
              tab === 'config'
                ? 'border-b-2 border-black text-black'
                : 'text-gray-400 hover:text-gray-600'
            }`}
          >
            Config
          </button>
          )}
          {!isReadOnly && (
          <button
            onClick={() => setTab('ai')}
            className={`flex-1 py-3 text-center font-bold text-sm uppercase tracking-wide transition-colors ${
              tab === 'ai'
                ? 'border-b-2 border-black text-black'
                : 'text-gray-400 hover:text-gray-600'
            }`}
          >
            AI Designer
          </button>
          )}
          {tab === 'mix' && (
            <button
              onClick={() => setShowPrintModal(true)}
              className="p-2 text-gray-500 hover:text-black transition-colors print:hidden"
              title="Print / Save PDF"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4H7v4a2 2 0 002 2zm0-14V3a2 2 0 012-2h2a2 2 0 012 2v4H9z" />
              </svg>
            </button>
          )}
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
          {/* Save status */}
          {(isOwner || isEditor) && (
            <span role="status" aria-live="polite" className={`text-[10px] font-medium px-2 py-1 rounded mr-1 flex-shrink-0 ${
              showContext.saving
                ? 'text-amber-600 bg-amber-50'
                : showContext.lastSavedAt
                  ? 'text-green-600 bg-green-50'
                  : 'text-gray-400'
            }`}>
              {showContext.saving ? 'Saving...' : showContext.lastSavedAt ? 'Saved' : ''}
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
      {tab === 'perform' && (
        <PerformTab setlist={config.setlist} showInfo={config.showInfo} isOffline={isOffline} accessToken={googleToken?.access_token} slug={slug} owner={owner} chartCacheProgress={chartCacheProgress} />
      )}
      {tab === 'mix' && (
        <MixTab band={band} setlist={config.setlist} printSections={printSections} showInfo={config.showInfo} isOffline={isOffline} accessToken={googleToken?.access_token} slug={slug} owner={owner} onReorder={(from, to) => updateConfig((p) => ({ ...p, setlist: moveSetlistSong(p.setlist, from, to) }))} />
      )}
      {tab === 'config' && (
        <ConfigTab config={config} updateConfig={updateConfig} googleToken={googleToken} googleError={googleError} onDisconnectGoogle={() => { clearGoogleToken(); setGoogleToken(null); }} showId={showId} ownerId={showOwnerId} isOwner={isOwner} isEditor={isEditor} />
      )}
      {tab === 'ai' && (
        <div className="p-4 md:p-8">
          <div className="max-w-4xl mx-auto">
            <AgentChat config={config} updateConfig={updateConfig} />
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
                  setTimeout(() => window.print(), 100);
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

function PerformTab({ setlist, showInfo, isOffline, accessToken, slug, owner, chartCacheProgress }: {
  setlist: SetlistSong[];
  showInfo: { bandName: string; eventDate: string; venue: string; showName?: string };
  isOffline: boolean;
  accessToken?: string;
  slug: string;
  owner: string;
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
          onChangeIdx={setNavigatorSongIdx}
          onChangeRole={handleRoleChange}
          onClose={() => setNavigatorSongIdx(null)}
        />
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// MIX TAB — engineer's rider view
// ════════════════════════════════════════════════════════════════════════════

function StageSlotCell({ slot }: { slot: StageSlot | undefined }) {
  const isFeatured = slot?.featured;
  return (
    <div
      className={`flex flex-col items-center rounded-lg p-2 text-center gap-0.5 border-2 ${
        isFeatured
          ? 'border-black bg-gray-900 text-white shadow-lg'
          : 'border-dashed border-blue-100 bg-blue-50/30'
      }`}
    >
      {slot ? (
        <>
          <p className="font-bold text-sm leading-tight uppercase">{slot.name}</p>
          <p className={`text-[11px] leading-tight ${isFeatured ? 'opacity-80' : 'text-gray-600'}`}>{slot.role}</p>
          <p className={`text-[10px] ${isFeatured ? 'opacity-60' : 'text-gray-400'}`}>Mix {slot.mix}</p>
        </>
      ) : (
        <p className="text-[10px] text-gray-300 italic">empty</p>
      )}
      <div className="h-5 flex items-center justify-center">
        {slot?.power && (
          <span className="px-1.5 py-0.5 bg-yellow-400 text-[9px] font-bold rounded text-black">POWER</span>
        )}
      </div>
    </div>
  );
}

function StagePlotView({ band }: { band: BandConfig }) {
  const slotMap = Object.fromEntries(band.stagePlot.map((s) => [s.pos, s]));
  const hasMidStage = (['MSR', 'MSC', 'MSL'] as StagePosition[]).some((p) => slotMap[p]);

  return (
    <div className="bg-white border-4 border-gray-200 rounded-xl shadow-inner overflow-hidden">
      <div className="flex justify-between px-3 pt-2 pb-1">
        <span className="text-[10px] font-bold text-gray-400">USR</span>
        <span className="text-[10px] font-bold text-gray-500 tracking-widest">UPSTAGE</span>
        <span className="text-[10px] font-bold text-gray-400">USL</span>
      </div>
      <div className="grid grid-cols-3 gap-2 px-3 pb-2">
        {(['USR', 'USC', 'USL'] as StagePosition[]).map((pos) => (
          <StageSlotCell key={pos} slot={slotMap[pos]} />
        ))}
      </div>
      {hasMidStage && (
        <>
          <div className="mx-3 border-t-2 border-dashed border-gray-300 my-1" />
          <div className="grid grid-cols-3 gap-2 px-3 pt-2 pb-2">
            {(['MSR', 'MSC', 'MSL'] as StagePosition[]).map((pos) => (
              <StageSlotCell key={pos} slot={slotMap[pos]} />
            ))}
          </div>
        </>
      )}
      <div className="mx-3 border-t-2 border-dashed border-gray-300 my-1" />
      <div className="grid grid-cols-3 gap-2 px-3 pt-2 pb-2">
        {(['DSR', 'DSC', 'DSL'] as StagePosition[]).map((pos) => (
          <StageSlotCell key={pos} slot={slotMap[pos]} />
        ))}
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

function DraggableStageSlot({ pos, slot }: { pos: StagePosition; slot: StageSlot | undefined }) {
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `drop-${pos}` });
  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({
    id: `drag-${pos}`,
    disabled: !slot,
    data: { pos },
  });

  const isFeatured = slot?.featured;

  return (
    <div ref={setDropRef} className="relative">
      <div
        ref={setDragRef}
        {...attributes}
        {...listeners}
        className={`flex flex-col items-center rounded-lg p-2 text-center gap-0.5 border-2 transition-colors ${
          isDragging
            ? 'opacity-30 border-dashed border-gray-300'
            : isOver
              ? 'border-blue-400 bg-blue-50 ring-2 ring-blue-200'
              : isFeatured
                ? 'border-black bg-gray-900 text-white shadow-lg'
                : slot
                  ? 'border-dashed border-blue-100 bg-blue-50/30 cursor-grab'
                  : 'border-dashed border-blue-100 bg-blue-50/30'
        }`}
      >
        {slot ? (
          <>
            <p className="font-bold text-sm leading-tight uppercase">{slot.name}</p>
            <p className={`text-[11px] leading-tight ${isFeatured ? 'opacity-80' : 'text-gray-600'}`}>{slot.role}</p>
            <p className={`text-[10px] ${isFeatured ? 'opacity-60' : 'text-gray-400'}`}>Mix {slot.mix}</p>
          </>
        ) : (
          <p className="text-[10px] text-gray-300 italic">empty</p>
        )}
        <div className="h-5 flex items-center justify-center">
          {slot?.power && (
            <span className="px-1.5 py-0.5 bg-yellow-400 text-[9px] font-bold rounded text-black">POWER</span>
          )}
        </div>
      </div>
    </div>
  );
}

function DraggableStagePlotView({ stagePlot, onMove }: { stagePlot: StageSlot[]; onMove: (fromPos: StagePosition, toPos: StagePosition) => void }) {
  const slotMap = Object.fromEntries(stagePlot.map((s) => [s.pos, s]));
  const [activeSlot, setActiveSlot] = useState<StageSlot | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
  );

  const handleDragStart = (event: DragStartEvent) => {
    const pos = event.active.data.current?.pos as StagePosition | undefined;
    if (pos && slotMap[pos]) setActiveSlot(slotMap[pos]);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveSlot(null);
    const { active, over } = event;
    if (!over) return;
    const fromPos = (active.id as string).replace('drag-', '') as StagePosition;
    const toPos = (over.id as string).replace('drop-', '') as StagePosition;
    if (fromPos !== toPos) onMove(fromPos, toPos);
  };

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="bg-white border-4 border-gray-200 rounded-xl shadow-inner overflow-hidden">
        <div className="flex justify-between px-3 pt-2 pb-1">
          <span className="text-[10px] font-bold text-gray-400">USR</span>
          <span className="text-[10px] font-bold text-gray-500 tracking-widest">UPSTAGE</span>
          <span className="text-[10px] font-bold text-gray-400">USL</span>
        </div>
        <div className="grid grid-cols-3 gap-2 px-3 pb-2">
          {(['USR', 'USC', 'USL'] as StagePosition[]).map((pos) => (
            <DraggableStageSlot key={pos} pos={pos} slot={slotMap[pos]} />
          ))}
        </div>
        <div className="mx-3 border-t-2 border-dashed border-gray-300 my-1" />
        <div className="grid grid-cols-3 gap-2 px-3 pt-2 pb-2">
          {(['MSR', 'MSC', 'MSL'] as StagePosition[]).map((pos) => (
            <DraggableStageSlot key={pos} pos={pos} slot={slotMap[pos]} />
          ))}
        </div>
        <div className="mx-3 border-t-2 border-dashed border-gray-300 my-1" />
        <div className="grid grid-cols-3 gap-2 px-3 pt-2 pb-2">
          {(['DSR', 'DSC', 'DSL'] as StagePosition[]).map((pos) => (
            <DraggableStageSlot key={pos} pos={pos} slot={slotMap[pos]} />
          ))}
        </div>
        <div className="flex justify-between px-3 pb-2 pt-1">
          <span className="text-[10px] font-bold text-gray-400">DSR</span>
          <span className="text-[10px] font-bold text-gray-500 tracking-widest">AUDIENCE / FOH</span>
          <span className="text-[10px] font-bold text-gray-400">DSL</span>
        </div>
      </div>
      <DragOverlay>
        {activeSlot && (
          <div className={`flex flex-col items-center rounded-lg p-2 text-center gap-0.5 border-2 shadow-xl ${
            activeSlot.featured ? 'border-black bg-gray-900 text-white' : 'border-blue-300 bg-white'
          }`}>
            <p className="font-bold text-sm leading-tight uppercase">{activeSlot.name}</p>
            <p className={`text-[11px] leading-tight ${activeSlot.featured ? 'opacity-80' : 'text-gray-600'}`}>{activeSlot.role}</p>
          </div>
        )}
      </DragOverlay>
      <p className="text-[10px] text-gray-400 text-center mt-2">Drag to reposition</p>
    </DndContext>
  );
}

function MixTab({ band, setlist, printSections, showInfo, isOffline, accessToken, slug, owner, onReorder }: { band: BandConfig; setlist: SetlistSong[]; printSections: Record<string, boolean>; showInfo: { bandName: string; eventDate: string; venue: string; showName?: string }; isOffline: boolean; accessToken?: string; slug: string; owner: string; onReorder: (from: number, to: number) => void }) {
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
                <button
                  onClick={() => setReorderMode(!reorderMode)}
                  className={`px-3 py-1.5 text-xs font-bold rounded transition-colors ${
                    reorderMode
                      ? 'bg-black text-white hover:bg-gray-800'
                      : 'bg-gray-100 border border-gray-300 hover:bg-gray-200'
                  }`}
                >
                  {reorderMode ? 'Done' : 'Reorder'}
                </button>
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
            {reorderMode ? (
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

function ChartNavigator({
  setlist, currentIdx, roleFilter, allRoles, isOffline, accessToken, onChangeIdx, onChangeRole, onClose,
}: {
  setlist: SetlistSong[];
  currentIdx: number;
  roleFilter: string;
  allRoles: string[];
  isOffline: boolean;
  accessToken?: string;
  onChangeIdx: (idx: number) => void;
  onChangeRole: (role: string) => void;
  onClose: () => void;
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

  // Reset chart and page when song or available charts change
  useEffect(() => {
    if (currentIdx !== prevSongIdxRef.current) {
      prevSongIdxRef.current = currentIdx;
      setActiveChartIdx(0);
      setPageNum(1);
    }
  }, [currentIdx]);

  // Clamp activeChartIdx when filtered charts shrink (e.g., role filter change)
  const clampedChartIdx = charts.length > 0 ? Math.min(activeChartIdx, charts.length - 1) : 0;
  if (clampedChartIdx !== activeChartIdx) setActiveChartIdx(clampedChartIdx);

  // Load and render PDF
  const activeChart = charts[clampedChartIdx] ?? null;
  const chartFileId = activeChart?.fileId;
  const chartModifiedTime = activeChart?.modifiedTime;

  useEffect(() => {
    let cancelled = false;
    if (!chartFileId) {
      // Defer state reset to microtask to satisfy lint (no sync setState in effect)
      Promise.resolve().then(() => {
        if (cancelled) return;
        docRef.current = null;
        setNumPages(0);
        setPageNum(1);
        setLoading(false);
      });
      return () => { cancelled = true; };
    }
    const load = async () => {
      setLoading(true);
      try {
        const doc = await loadPdfDoc(activeChart!, accessToken);
        if (cancelled) return;
        if (!doc) {
          docRef.current = null;
          setNumPages(0);
          setPageNum(1);
          return;
        }
        docRef.current = doc;
        setNumPages(doc.numPages);
        setPageNum(1);
        if (canvasRef.current) {
          await renderPage(doc, 1, canvasRef.current);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [chartFileId, chartModifiedTime, accessToken]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-render on page change
  useEffect(() => {
    if (docRef.current && canvasRef.current && pageNum >= 1 && pageNum <= numPages) {
      renderPage(docRef.current, pageNum, canvasRef.current);
    }
  }, [pageNum, numPages]);

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
          <p className="text-[10px] text-zinc-500">Song {currentIdx + 1} of {setlist.length}</p>
        </div>
        <div className="flex items-center gap-2">
          {isOffline && (
            <span className="px-2 py-0.5 bg-amber-900 text-amber-300 text-[10px] font-bold rounded">
              OFFLINE
            </span>
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
              onClick={() => { setActiveChartIdx(i); setPageNum(1); }}
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
      </div>

      {/* Page indicator */}
      {numPages > 1 && (
        <div className="text-center py-1 text-xs text-zinc-500 bg-zinc-900 border-t border-zinc-800">
          Page {pageNum} of {numPages} &middot; tap left/right on chart to turn
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

function AddSongFromLibrary({
  onAddSong,
  isOwner,
  ownerId,
  isEditor,
}: {
  onAddSong: (song: { songId?: string; title: string; key?: string; lead?: string; notes?: string }) => void;
  isOwner: boolean;
  ownerId: string | null;
  isEditor?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [songs, setSongs] = useState<Array<{ id: string; title: string; key: string | null; lead: string; notes: string }>>([]);
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
        // Browse the show owner's library (editors must target the owner, not themselves)
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

  function handleSelect(song: { id: string; title: string; key: string | null; lead: string; notes: string }) {
    onAddSong({
      songId: song.id,
      title: song.title,
      key: song.key ?? undefined,
      lead: song.lead,
      notes: song.notes,
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
            ) : isEditor ? (
              <div className="px-3 py-2 text-sm text-gray-400 border-t border-gray-100">
                Song not found. Ask the show owner to add it to the library.
              </div>
            ) : null
          )}
          {filtered.length === 0 && exactMatch === undefined && !isOwner && !isEditor && (
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

function SetupSetlistTable({
  setlist, canResolveCharts, onReorder, onUpdate, onDelete, onAddSong, isOwner, ownerId, isEditor, onChartUpload, onChartDelete,
}: {
  setlist: SetlistSong[];
  canResolveCharts: boolean;
  onReorder: (from: number, to: number) => void;
  onUpdate: (idx: number, field: string, value: string) => void;
  onDelete: (idx: number) => void;
  onAddSong: (song: { songId?: string; title: string; key?: string; lead?: string; notes?: string }) => void;
  isOwner: boolean;
  ownerId: string | null;
  isEditor?: boolean;
  onChartUpload?: (songTitle: string) => void;
  onChartDelete?: (chartId: string, songTitle: string, role: string) => void;
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
                    onChartUpload={onChartUpload}
                    onChartDelete={onChartDelete}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </SortableContext>
      </DndContext>
      <AddSongFromLibrary onAddSong={onAddSong} isOwner={isOwner} ownerId={ownerId} isEditor={isEditor} />
    </>
  );
}

const inputCls = 'w-full px-2 py-2.5 sm:py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-black bg-white';
const arrowBtn = 'px-1 py-0.5 text-gray-400 hover:text-gray-700 disabled:opacity-20 disabled:cursor-not-allowed';

function SetupSortableRow({
  song, idx, total, canResolveCharts, onUpdate, onDelete, onMoveUp, onMoveDown, isOwner, onChartUpload, onChartDelete,
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
  onChartUpload?: (songTitle: string) => void;
  onChartDelete?: (chartId: string, songTitle: string, role: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: song.id! });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };

  const hasSongCharts = (song.charts?.length ?? 0) > 0;
  const hasSongDupes = song.charts?.some((c) => (c.dupeCount ?? 0) > 1) ?? false;

  return (
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
        <input className={inputCls} value={song.title} onChange={(e) => onUpdate(idx, 'title', e.target.value)} />
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
              {isOwner && onChartDelete && (
                <button onClick={() => onChartDelete(c.fileId!, song.title, c.role)} className="text-blue-400 hover:text-red-500 ml-0.5 leading-none">&times;</button>
              )}
            </span>
          ))}
          {isOwner && onChartUpload && (
            <button onClick={() => onChartUpload(song.title)} className="text-xs text-gray-400 hover:text-gray-600">+</button>
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
// SORTABLE INPUT TABLE (Config tab)
// ════════════════════════════════════════════════════════════════════════════

function SetupInputTable({
  inputs, onReorder, onUpdate, onDelete, onAdd,
}: {
  inputs: import('@/lib/types').InputChannel[];
  onReorder: (from: number, to: number) => void;
  onUpdate: (idx: number, field: string, value: string) => void;
  onDelete: (idx: number) => void;
  onAdd: () => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
  );
  const inputIds = inputs.map((inp) => inp.id!);
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
      <button className={`${btnAdd} mt-3`} onClick={onAdd}>+ Add Row</button>
    </>
  );
}

function SortableInputRow({
  input: inp, idx, total, onUpdate, onDelete, onMoveUp, onMoveDown,
}: {
  input: import('@/lib/types').InputChannel;
  idx: number;
  total: number;
  onUpdate: (idx: number, field: string, value: string) => void;
  onDelete: (idx: number) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: inp.id! });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };

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
          <div className="space-y-3">
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
          </div>
        </SortableContext>
      </DndContext>
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
    <div ref={setNodeRef} style={style} className="flex flex-col sm:flex-row gap-2 items-start sm:items-center border-b border-gray-100 pb-3">
      <div className="cursor-grab shrink-0 pt-5 sm:pt-0 self-center" {...attributes} {...listeners}>
        <span className="text-gray-300 text-sm select-none">&#x2630;</span>
      </div>
      <div className="w-16 shrink-0">
        <label className={labelCls}>Mix #</label>
        <span className="text-sm font-mono text-gray-500">{mon.mix}</span>
      </div>
      <div className="flex-1">
        <label className={labelCls}>Name</label>
        <input className={inputCls} value={mon.name} onChange={(e) => onUpdate(idx, 'name', e.target.value)} />
      </div>
      <div className="flex-[2]">
        <label className={labelCls}>Needs</label>
        <input className={inputCls} value={mon.needs} onChange={(e) => onUpdate(idx, 'needs', e.target.value)} />
      </div>
      <div className="pt-5 flex items-center gap-1">
        <div className="flex flex-col items-center">
          <button className={arrowBtn} disabled={idx === 0} onClick={onMoveUp} title="Move up">&uarr;</button>
          <button className={arrowBtn} disabled={idx === total - 1} onClick={onMoveDown} title="Move down">&darr;</button>
        </div>
        <button className={btnRemove} onClick={() => onDelete(idx)}>X</button>
      </div>
    </div>
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
}

function AgentChat({
  config,
  updateConfig,
}: {
  config: AppConfig;
  updateConfig: (fn: (prev: AppConfig) => AppConfig) => void;
}) {
  const [apiKey, setApiKey] = useState(() => {
    if (typeof window === 'undefined') return '';
    return localStorage.getItem('showrunr-claude-key') || sessionStorage.getItem('showrunr-claude-key') || '';
  });
  const [rememberKey, setRememberKey] = useState(() => {
    if (typeof window === 'undefined') return false;
    return !!localStorage.getItem('showrunr-claude-key');
  });
  const [showKey, setShowKey] = useState(false);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState('');
  const [tryitRemaining, setTryitRemaining] = useState<number | null>(null);
  const [tryitExhausted, setTryitExhausted] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const configRef = useRef(config);
  useEffect(() => { configRef.current = config; }, [config]);

  // Persist key when rememberKey changes
  useEffect(() => {
    if (rememberKey && apiKey) {
      localStorage.setItem('showrunr-claude-key', apiKey);
    } else {
      localStorage.removeItem('showrunr-claude-key');
      sessionStorage.removeItem('showrunr-claude-key');
    }
  }, [rememberKey, apiKey]);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streaming]);

  // Build Claude API message array from our messages (including tool results)
  function buildApiMessages(): Array<{ role: string; content: unknown }> {
    const apiMsgs: Array<{ role: string; content: unknown }> = [];
    for (const msg of messages) {
      if (msg.role === 'user') {
        apiMsgs.push({ role: 'user', content: msg.content });
      } else {
        // Assistant message with possible tool calls
        const blocks: Array<Record<string, unknown>> = [];
        if (msg.content) blocks.push({ type: 'text', text: msg.content });
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
          }
        }
        apiMsgs.push({ role: 'assistant', content: blocks.length === 1 && blocks[0].type === 'text' ? msg.content : blocks });

        // Add tool results if any tools were resolved
        if (msg.toolCalls?.some((tc) => tc.status !== 'pending')) {
          const resultBlocks: Array<Record<string, unknown>> = [];
          for (const tc of msg.toolCalls) {
            if (tc.status === 'applied') {
              resultBlocks.push({ type: 'tool_result', tool_use_id: tc.id, content: `Applied. ${tc.name} updated successfully.` });
            } else if (tc.status === 'rejected') {
              resultBlocks.push({ type: 'tool_result', tool_use_id: tc.id, content: 'Rejected by user.', is_error: true });
            }
          }
          if (resultBlocks.length > 0) {
            apiMsgs.push({ role: 'user', content: resultBlocks });
          }
        }
      }
    }
    return apiMsgs;
  }

  async function sendMessage(text?: string) {
    const userText = text ?? input.trim();
    if (!userText || streaming) return;

    setInput('');
    setError('');

    const userMsg: AgentMessage = { role: 'user', content: userText };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setStreaming(true);

    try {
      const apiMessages = [...buildApiMessages(), { role: 'user', content: userText }];

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
        throw new Error(err.error || 'Request failed');
      }

      // Parse SSE stream
      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      let assistantText = '';
      const toolCalls: AgentMessage['toolCalls'] = [];
      let currentToolId = '';
      let currentToolName = '';
      let currentToolJson = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const event = JSON.parse(data);

            if (event.type === 'content_block_start') {
              if (event.content_block?.type === 'tool_use') {
                currentToolId = event.content_block.id;
                currentToolName = event.content_block.name;
                currentToolJson = '';
              }
            } else if (event.type === 'content_block_delta') {
              if (event.delta?.type === 'text_delta') {
                assistantText += event.delta.text;
                // Live update the assistant message
                setMessages([...newMessages, { role: 'assistant', content: assistantText, toolCalls: toolCalls.length > 0 ? [...toolCalls] : undefined }]);
              } else if (event.delta?.type === 'input_json_delta') {
                currentToolJson += event.delta.partial_json;
              }
            } else if (event.type === 'content_block_stop') {
              if (currentToolId) {
                try {
                  const input = JSON.parse(currentToolJson);
                  toolCalls.push({ id: currentToolId, name: currentToolName, input, status: 'pending' });
                } catch {
                  // Malformed tool JSON — skip
                }
                currentToolId = '';
                currentToolName = '';
                currentToolJson = '';
              }
            }
          } catch {
            // Skip unparseable SSE lines
          }
        }
      }

      setMessages([...newMessages, { role: 'assistant', content: assistantText, toolCalls: toolCalls.length > 0 ? toolCalls : undefined }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
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

  const hasPendingTools = messages.some((m) => m.toolCalls?.some((tc) => tc.status === 'pending'));
  const canSend = !streaming && !hasPendingTools && (!!apiKey || (!tryitExhausted));
  const needsKey = !apiKey && tryitExhausted;

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

      {/* API Key input */}
      {!apiKey && !tryitExhausted && tryitRemaining === null && (
        <p className="text-xs text-gray-500">
          Try it free — or <button onClick={() => setShowKey(true)} className="underline">enter your own API key</button> for unlimited use.
          {' '}<a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer" className="text-gray-400 underline">(get a key)</a>
        </p>
      )}

      {tryitRemaining !== null && !apiKey && (
        <p className="text-xs text-gray-500">
          {tryitRemaining} free message{tryitRemaining !== 1 ? 's' : ''} remaining.
          <button onClick={() => setShowKey(true)} className="underline ml-1">Add your own key</button> for unlimited use.
        </p>
      )}

      {(needsKey || apiKey || showKey) && (
        <div className="flex items-center gap-2">
          <input
            type="password"
            className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-black bg-white font-mono"
            placeholder="sk-ant-..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          {apiKey && (
            <button
              onClick={() => { setApiKey(''); localStorage.removeItem('showrunr-claude-key'); sessionStorage.removeItem('showrunr-claude-key'); }}
              className="px-2 py-2 text-xs text-red-500 hover:text-red-700"
            >
              Clear
            </button>
          )}
          <label className="flex items-center gap-1 text-xs text-gray-500 whitespace-nowrap">
            <input type="checkbox" checked={rememberKey} onChange={(e) => setRememberKey(e.target.checked)} />
            Remember
          </label>
        </div>
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
        <p className="text-sm text-red-600">{error}</p>
      )}

      {/* Input */}
      <div className="flex gap-2 items-end">
        <textarea
          className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-black bg-white resize-none"
          rows={2}
          placeholder={needsKey ? 'Enter API key above to continue...' : hasPendingTools ? 'Apply or reject pending changes first...' : messages.length > 0 ? 'Reply or ask a follow-up...' : 'Describe your band, lineup, and stage layout...'}
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
              Mix {String(m.mix)}: {String(m.name)} — {String(m.needs)}
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
  googleToken,
  googleError,
  onDisconnectGoogle,
  showId,
  ownerId,
  isOwner,
  isEditor,
}: {
  config: AppConfig;
  updateConfig: (fn: (prev: AppConfig) => AppConfig) => void;
  googleToken: GoogleToken | null;
  googleError?: string;
  onDisconnectGoogle: () => void;
  showId: string | null;
  ownerId: string | null;
  isEditor?: boolean;
  isOwner: boolean;
}) {
  const [sheetUrl, setSheetUrl] = useState('');
  const [sheetLoading, setSheetLoading] = useState(false);
  const [sheetError, setSheetError] = useState('');
  const [driveSetupLoading, setDriveSetupLoading] = useState(false);
  const [driveError, setDriveError] = useState('');
  const [folderIdInput, setFolderIdInput] = useState(config.chartsRootFolderId ?? '');
  const [chartsResolving, setChartsResolving] = useState(false);
  const [chartsError, setChartsError] = useState('');

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
      updateConfig((p) => {
        const newSetlist = [...p.setlist];
        for (const r of data.results) {
          if (newSetlist[r.idx]) {
            newSetlist[r.idx] = { ...newSetlist[r.idx], charts: r.charts };
          }
        }
        return { ...p, setlist: newSetlist };
      });
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
    // Clear charts and invalidate in-flight requests when Drive is disconnected
    if (!config.chartsRootFolderId) {
      resolveVersionRef.current++;
      const hasCharts = config.setlist.some((s) => s.charts);
      if (hasCharts) {
        updateConfig((p) => ({
          ...p,
          setlist: p.setlist.map((s) => ({ ...s, charts: undefined })),
        }));
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
  }, [resolveSignature, canResolveCharts, resolveCharts, config.chartsRootFolderId, config.setlist, updateConfig]);

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

  const handleLoadSheet = async () => {
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
      updateConfig((prev) => ({
        ...prev,
        setlist: (data as { position: number; title: string; lead: string; notes: string }[]).map((s) => ({
          id: crypto.randomUUID(),
          position: s.position,
          title: s.title,
          lead: s.lead,
          notes: s.notes,
        })),
      }));
      // Auto-resolve charts after setlist import (fires on next render via effect)
    } catch {
      setSheetError('Network error');
    } finally {
      setSheetLoading(false);
    }
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
              onMove={(fromPos, toPos) => updateConfig((p) => {
                const arr = p.stagePlot.map((s) => ({ ...s }));
                const fromIdx = arr.findLastIndex((s) => s.pos === fromPos);
                const toIdx = arr.findLastIndex((s) => s.pos === toPos);
                if (fromIdx === -1) return p;
                if (toIdx !== -1) {
                  // Swap positions
                  arr[toIdx] = { ...arr[toIdx], pos: fromPos };
                }
                arr[fromIdx] = { ...arr[fromIdx], pos: toPos };
                return { ...p, stagePlot: arr };
              })}
            />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left px-2 py-2 text-xs font-bold text-gray-500 min-w-[100px]">Name</th>
                  <th className="text-left px-2 py-2 text-xs font-bold text-gray-500">Position</th>
                  <th className="text-left px-2 py-2 text-xs font-bold text-gray-500 min-w-[100px]">Role</th>
                  <th className="text-left px-2 py-2 text-xs font-bold text-gray-500 w-16">Mix</th>
                  <th className="text-center px-2 py-2 text-xs font-bold text-gray-500 w-14">Power</th>
                  <th className="text-center px-2 py-2 text-xs font-bold text-gray-500 w-14">Feat.</th>
                  <th className="w-10"></th>
                </tr>
              </thead>
              <tbody>
                {config.stagePlot.map((slot, idx) => (
                  <tr key={idx} className="border-b border-gray-100">
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
                      <select
                        className={inputCls}
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
                      <input
                        type="number"
                        className={inputCls}
                        value={slot.mix}
                        onChange={(e) =>
                          updateConfig((p) => {
                            const arr = [...p.stagePlot];
                            arr[idx] = { ...arr[idx], mix: Number(e.target.value) };
                            return { ...p, stagePlot: arr };
                          })
                        }
                      />
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
                    <td className="px-2 py-1 text-center">
                      <input
                        type="checkbox"
                        checked={slot.featured ?? false}
                        onChange={(e) =>
                          updateConfig((p) => {
                            const arr = [...p.stagePlot];
                            arr[idx] = { ...arr[idx], featured: e.target.checked };
                            return { ...p, stagePlot: arr };
                          })
                        }
                      />
                    </td>
                    <td className="px-2 py-1">
                      <button
                        className={btnRemove}
                        onClick={() =>
                          updateConfig((p) => ({
                            ...p,
                            stagePlot: p.stagePlot.filter((_, i) => i !== idx),
                          }))
                        }
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
                  { name: '', pos: 'DSC' as StagePosition, role: '', mix: p.stagePlot.length + 1 },
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
            onReorder={(from, to) => updateConfig((p) => ({ ...p, inputs: moveInput(p.inputs, from, to) }))}
            onUpdate={(idx, field, value) => updateConfig((p) => {
              const arr = [...p.inputs];
              arr[idx] = { ...arr[idx], [field]: field === 'ch' ? Number(value) : value };
              return { ...p, inputs: arr };
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
              <li>Create a Google Sheet with columns: <strong>#</strong> (or Position), <strong>Title</strong> (or Song), <strong>Lead</strong> (or Singer), and optionally <strong>Notes</strong>.</li>
              <li>Make the sheet publicly viewable: <em>Share &rarr; Anyone with the link &rarr; Viewer</em>.</li>
              <li>Copy the sheet URL and paste it below.</li>
            </ol>
          </details>

          {/* Google Sheet loader */}
          <div className="flex flex-col sm:flex-row gap-2 mb-4 p-3 bg-gray-50 rounded-lg border border-gray-200">
            <input
              className={`${inputCls} flex-1`}
              placeholder="Google Sheet URL..."
              value={sheetUrl}
              onChange={(e) => setSheetUrl(e.target.value)}
            />
            <button
              className="px-4 py-1.5 text-xs font-bold bg-green-600 text-white rounded hover:bg-green-700 transition-colors disabled:opacity-50 whitespace-nowrap"
              onClick={handleLoadSheet}
              disabled={sheetLoading}
            >
              {sheetLoading ? 'Loading...' : 'Load from Google Sheet'}
            </button>
          </div>
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
            onAddSong={(song) => updateConfig((p) => ({
              ...p,
              setlist: [...p.setlist, {
                id: crypto.randomUUID(),
                songId: song.songId,
                position: p.setlist.length + 1,
                title: song.title,
                key: song.key,
                lead: song.lead || '',
                notes: song.notes,
              }],
            }))}
            isEditor={isEditor}
            onChartUpload={(songTitle) => {
              const input = document.createElement('input');
              input.type = 'file';
              input.accept = '.pdf,.png,.jpg,.jpeg';
              input.onchange = async () => {
                const file = input.files?.[0];
                if (!file) return;
                const roles = ['Guitar', 'Lyrics', 'Keys', 'Bass', 'Horns', 'Drums'];
                const nameLower = file.name.toLowerCase();
                let detected = 'Other';
                for (const r of roles) { if (nameLower.includes(r.toLowerCase())) { detected = r; break; } }
                const role = prompt(`Chart role for "${songTitle}":`, detected);
                if (!role) return;
                try {
                  const formData = new FormData();
                  formData.append('file', file);
                  formData.append('song_title', songTitle);
                  formData.append('role', role);
                  const res = await fetch('/api/charts/upload', { method: 'POST', body: formData });
                  if (res.ok) {
                    const chart = await res.json();
                    updateConfig((prev) => ({
                      ...prev,
                      setlist: prev.setlist.map((s) =>
                        s.title === songTitle
                          ? { ...s, charts: [...(s.charts || []).filter((c) => c.role !== chart.role), { role: chart.role, url: chart.url, fileId: chart.id, mimeType: chart.mime_type, modifiedTime: chart.updated_at, label: chart.file_name }] }
                          : s
                      ),
                    }));
                  } else {
                    const err = await res.json().catch(() => ({ error: 'Upload failed' }));
                    alert(res.status === 401
                      ? 'Chart upload failed — you need to sign in first.'
                      : `Chart upload failed: ${err.error || 'Unknown error'}`);
                  }
                } catch {
                  alert('Chart upload failed — network error.');
                }
              };
              input.click();
            }}
            onChartDelete={async (chartId, songTitle, role) => {
              if (!confirm(`Delete ${role} chart for "${songTitle}"?`)) return;
              const res = await fetch('/api/charts/delete', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chart_id: chartId }),
              });
              if (res.ok) {
                updateConfig((prev) => ({
                  ...prev,
                  setlist: prev.setlist.map((s) =>
                    s.title === songTitle
                      ? { ...s, charts: (s.charts || []).filter((c) => c.fileId !== chartId) }
                      : s
                  ),
                }));
              }
            }}
          />
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

        {/* ── 8. Offline Access ──────────────────────────────────────────── */}
        <OfflineSection
          charts={config.setlist.flatMap((s) => s.charts ?? [])}
          googleToken={googleToken}
        />

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
