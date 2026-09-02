import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import type { Chart } from './types';
import { getCachedChartBlob, versionedChartUrl, cacheChart } from './chart-cache';
import { sniffPdf } from './chart-converter';
import { hashPdfBytes } from './chart-calibration';

// Lazy-init pdf.js to avoid SSR issues
let pdfjsLib: typeof import('pdfjs-dist') | null = null;

async function getPdfjs() {
  if (pdfjsLib) return pdfjsLib;
  pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
  return pdfjsLib;
}

// ─── In-memory PDF document cache ─────────────────────────────────────────
// Keyed by fileId:modifiedTime to match offline cache versioning.
// Max 5 docs in memory — evicts least recently accessed.

interface CachedDoc {
  doc: PDFDocumentProxy;
  sourceHash: string; // SHA-256 of the fetched bytes — the calibration key
  lastAccess: number;
}

// What loadPdfDoc resolves to: the parsed PDF plus the SHA-256 of the exact
// bytes it was parsed from. The hash is computed BEFORE the bytes are handed to
// pdf.js (which detaches the buffer), and is the same hash the converter uses,
// so viewer and converter agree on calibration identity.
export interface LoadedPdf {
  doc: PDFDocumentProxy;
  sourceHash: string;
}

const docCache = new Map<string, CachedDoc>();
const failedKeys = new Set<string>(); // negative cache for failed loads
const MAX_CACHED_DOCS = 5;

function cacheKey(chart: Chart): string {
  return `${chart.fileId}:${chart.modifiedTime ?? ''}`;
}

function evictOldest() {
  if (docCache.size < MAX_CACHED_DOCS) return;
  let oldest: string | null = null;
  let oldestTime = Infinity;
  for (const [key, entry] of docCache) {
    if (entry.lastAccess < oldestTime) {
      oldestTime = entry.lastAccess;
      oldest = key;
    }
  }
  if (oldest) {
    const entry = docCache.get(oldest)!;
    entry.doc.destroy();
    docCache.delete(oldest);
  }
}

// Fetch the chart's raw bytes — offline cache first, then network (Supabase
// public URL direct, or the Drive proxy). Returns the ArrayBuffer the document
// will be parsed from, so the hash and the parse share identical bytes.
// Exported for the share button (tier-1 file share reuses this exact
// cache/proxy path — do NOT duplicate it).
export async function fetchChartBytes(chart: Chart, accessToken?: string): Promise<ArrayBuffer | null> {
  // The cache READ is guarded too (Codex R1-3 on chunk 8). `caches` is absent outside a
  // secure context and `caches.open()` can reject in private browsing; before this guard
  // that rejection escaped uncaught — ahead of the try below — and failed the render
  // outright rather than degrading to the network. A cache problem must never be fatal in
  // either direction.
  try {
    const cachedBlob = await getCachedChartBlob(chart);
    if (cachedBlob) return await cachedBlob.arrayBuffer();
  } catch {
    // fall through to the network
  }

  try {
    let res: Response;

    // Supabase Storage charts have a direct public URL — fetch directly
    // (version-stamped so CDN/browser caches bust on object replace, keeping
    // the hashed bytes in parity with the authoritative object).
    if (chart.url && chart.url.includes('/storage/v1/object/public/')) {
      res = await fetch(versionedChartUrl(chart));
    } else {
      // Legacy Drive charts — go through the proxy
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
      res = await fetch('/api/drive/download', {
        method: 'POST',
        headers,
        body: JSON.stringify({ fileId: chart.fileId, mimeType: chart.mimeType }),
      });
    }

    // Strictly 200, not res.ok (Codex R1-2 on chunk 8). res.ok spans all of 2xx, so a 204
    // No Content or a 206 Partial Content would pass, and persisting either would poison
    // the cache with a truncated or empty body that every later read prefers over the
    // network. We never send a Range request, so 200 is the only success we expect.
    if (res.status !== 200) return null;
    const bytes = await res.arrayBuffer();

    // Relay chunk 8 — persist on fetch (design-relay-cloud.md §9.1).
    // Before this, every persistent write went through downloadAllCharts. Supabase charts
    // got that automatically on show open (page.tsx:557), but LEGACY DRIVE charts had no
    // auto-cache at all, and a silently-failed Supabase warm left no second chance either.
    // In both cases a chart could render perfectly online and be absent offline. Both
    // network branches funnel through here, so the write has exactly one home.
    //
    // Fire-and-forget, and it must stay that way: a cache failure (quota exceeded, private
    // browsing, no Cache API) must never fail the render the caller is awaiting. Offline
    // availability is strictly a bonus over a render that already succeeded.
    //
    // The Response is built SYNCHRONOUSLY here, before `bytes` is returned — body
    // extraction copies the buffer, so pdf.js detaching it later cannot corrupt the cached
    // copy. Content-Length is set explicitly because a Response built from an ArrayBuffer
    // carries no such header, and getCacheStats (chart-cache.ts:184) reads it to size the
    // download manager — without it these entries would count but weigh 0.
    // Codex R2: status 200 is NOT proof of a chart. A Drive HTML interstitial or a bad
    // storage body arrives as a perfectly good 200; caching it poisons the cache STICKILY,
    // because every later read prefers the cache over the network and pdf.js only discovers
    // the problem after. Sniff the magic bytes — the repo already owns this decision
    // (chart-converter.ts:21, "classify by the leading bytes of the FETCHED object, never
    // the claimed MIME"). Non-PDF bytes are still RETURNED (the share path is a legitimate
    // caller and v1 storage is PDF-only by policy, not by guarantee) — they are just never
    // persisted.
    if (sniffPdf(new Uint8Array(bytes, 0, Math.min(8, bytes.byteLength)))) {
      void cacheChart(
        chart,
        new Response(bytes, {
          headers: {
            'Content-Type': chart.mimeType || 'application/pdf',
            'Content-Length': String(bytes.byteLength),
          },
        }),
      ).catch(() => {});
    }

    return bytes;
  } catch {
    return null;
  }
}

export async function loadPdfDoc(chart: Chart, accessToken?: string): Promise<LoadedPdf | null> {
  if (!chart.fileId) return null;

  const key = cacheKey(chart);

  // Skip known-failed loads (prevents retry churn on private files)
  if (failedKeys.has(key)) return null;

  const cached = docCache.get(key);
  if (cached) {
    cached.lastAccess = Date.now();
    return { doc: cached.doc, sourceHash: cached.sourceHash };
  }

  const bytes = await fetchChartBytes(chart, accessToken);
  if (!bytes) {
    failedKeys.add(key);
    return null;
  }

  // Hash the fetched bytes BEFORE handing them to pdf.js (getDocument detaches
  // the buffer). hashPdfBytes slices internally, so the parse below still sees
  // the full data. This is the shared viewer/converter calibration key.
  const sourceHash = await hashPdfBytes(bytes);

  try {
    const pdfjs = await getPdfjs();
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes) });
    const doc = await loadingTask.promise;

    evictOldest();
    docCache.set(key, { doc, sourceHash, lastAccess: Date.now() });

    return { doc, sourceHash };
  } catch {
    return null;
  }
}

// ─── Render serialization ─────────────────────────────────────────────────
// Only one render per canvas at a time. Cancel previous if a new one starts.

let activeRenderTask: RenderTask | null = null;

export async function renderPage(
  doc: PDFDocumentProxy,
  pageNum: number,
  canvas: HTMLCanvasElement,
): Promise<void> {
  if (pageNum < 1 || pageNum > doc.numPages) return;

  // Cancel any in-flight render on this canvas
  if (activeRenderTask) {
    activeRenderTask.cancel();
    activeRenderTask = null;
  }

  const page = await doc.getPage(pageNum);
  const dpr = window.devicePixelRatio || 1;

  const container = canvas.parentElement;
  if (!container) return;
  const containerWidth = container.clientWidth;
  const containerHeight = container.clientHeight;

  const viewport = page.getViewport({ scale: 1 });
  const scaleW = containerWidth / viewport.width;
  const scaleH = containerHeight / viewport.height;
  const scale = Math.min(scaleW, scaleH) * dpr;

  const scaledViewport = page.getViewport({ scale });

  canvas.width = scaledViewport.width;
  canvas.height = scaledViewport.height;
  canvas.style.width = `${scaledViewport.width / dpr}px`;
  canvas.style.height = `${scaledViewport.height / dpr}px`;

  const task = page.render({ canvas, viewport: scaledViewport });
  activeRenderTask = task;

  try {
    await task.promise;
  } catch {
    // Render was cancelled — expected during fast navigation
  } finally {
    if (activeRenderTask === task) activeRenderTask = null;
  }
}

// Render a page to a fresh, detached canvas at an EXPLICIT scale. Unlike
// renderPage this owns a local render task (no module-global activeRenderTask to
// stomp the on-screen viewer) and needs no DOM parent — it's the offscreen
// substrate the CV barline-snap reads pixels from. Caller owns the returned
// canvas; nothing is appended to the document.
export async function renderPageOffscreen(
  doc: PDFDocumentProxy,
  pageNum: number,
  scale: number,
): Promise<HTMLCanvasElement | null> {
  if (pageNum < 1 || pageNum > doc.numPages) return null;
  const page = await doc.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const task: RenderTask = page.render({ canvas, viewport });
  try {
    await task.promise;
  } catch {
    return null;
  }
  return canvas;
}

export function destroyAllDocs() {
  if (activeRenderTask) {
    activeRenderTask.cancel();
    activeRenderTask = null;
  }
  for (const entry of docCache.values()) {
    entry.doc.destroy();
  }
  docCache.clear();
  failedKeys.clear();
}

export function prefetchChart(chart: Chart, accessToken?: string) {
  loadPdfDoc(chart, accessToken).catch(() => {});
}
