'use client';

import { useState, useRef, useEffect } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Chart } from '@/lib/types';
import { canonicalizeRole, displayRole, type ChartRole } from '@/lib/normalize';
import { uploadChart, ChartUploadError, type ConvertResult } from '@/lib/chart-upload';
import { availableRoles, applyUploadedChart, removeChartById } from '@/lib/chart-management';
import { loadPdfDoc, renderPage } from '@/lib/pdf-viewer';
import RoadmapBuilder, { type EditChart } from '@/components/RoadmapBuilder';

// PDF only: the in-show viewer renders to a canvas via pdf.js and has NO image
// branch, so an accepted .png uploaded fine, showed a role chip and a working
// preview HERE, and then gave every performer a blank canvas
// (design-core-path-tier1 §1.2). This is the hint; /api/charts/upload sniffs the
// bytes and is the actual boundary.
const ACCEPT = '.pdf';

interface Props {
  songTitle: string;
  charts: Chart[];
  isOwner: boolean;
  onClose: () => void;
  // Caller updates its own local state (library song / all matching setlist rows)
  // and derives chart_count from the new array length.
  onChartsChanged: (charts: Chart[]) => void;
}

// Shared Manage-Charts surface, opened from the library row and the in-show "+"
// chip. The library is the authority (charts key by owner+normalize(title)+role),
// so both callers mutate the same chart_library rows through here.
export default function ManageChartsModal({ songTitle, charts, isOwner, onClose, onChartsChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [building, setBuilding] = useState(false);
  // The builder chart being re-opened for edit (its spec + slot identity loaded
  // lazily from the GET read door); null = not editing.
  const [editTarget, setEditTarget] = useState<EditChart | null>(null);
  const [addRole, setAddRole] = useState<ChartRole | ''>('');
  // Track the previewed chart by id and derive the chart from the latest list:
  // Replace preserves chart_library.id but swaps the file, so deriving keeps the
  // pane in sync with a re-uploaded chart instead of pinning a stale object.
  const [previewId, setPreviewId] = useState<string | null>(null);
  const addFileRef = useRef<HTMLInputElement>(null);
  const replaceRoleRef = useRef<string | null>(null);
  const replaceFileRef = useRef<HTMLInputElement>(null);

  const free = availableRoles(charts);
  const preview = charts.find((c) => c.fileId === previewId) ?? null;

  async function doUpload(file: File, role: string) {
    setBusy(true);
    setError('');
    try {
      const { chart, overlay } = await uploadChart(file, songTitle, role);
      reportOverlay(overlay);
      const next = applyUploadedChart(charts, {
        role: chart.role,
        url: chart.url,
        fileId: chart.id,
        mimeType: chart.mime_type,
        modifiedTime: chart.updated_at,
        label: chart.file_name,
      });
      onChartsChanged(next);
      setAddRole('');
    } catch (e) {
      setError(
        e instanceof ChartUploadError
          ? e.status === 401
            ? 'You need to sign in first.'
            : e.message || 'Upload failed'
          : 'Upload failed',
      );
    } finally {
      setBusy(false);
    }
  }

  // Surface a non-fatal overlay outcome (the chart uploaded either way).
  function reportOverlay(overlay: ConvertResult | null) {
    if (!overlay) return;
    if (!overlay.generated && overlay.reason && overlay.reason !== 'exists') {
      const msg: Record<string, string> = {
        unsupported_type: 'Chart uploaded — overlay skipped (unsupported file type).',
        too_large: 'Chart uploaded — overlay skipped (file too large).',
        failed: 'Chart uploaded — overlay could not be generated.',
      };
      setError(msg[overlay.reason] ?? '');
    }
  }

  // A chart built (or edited) from a RoadmapSpec is persisted server-side by the
  // builder's /save route; we only fold the returned chart into the live list
  // (replacing any existing chart for that role, like an upload).
  function onBuilt(chart: Chart) {
    onChartsChanged(applyUploadedChart(charts, chart));
    setBuilding(false);
    setEditTarget(null);
  }

  // Re-open a builder chart for editing: lazily fetch its source_spec + slot
  // identity from the owner-gated read door, then mount the builder in edit mode.
  // Non-builder charts have no Edit affordance, so this is only reached for charts
  // that carry a spec.
  async function startEdit(chart: Chart) {
    if (!chart.fileId) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/charts/roadmap/${chart.fileId}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Could not open this chart for editing.');
        return;
      }
      setEditTarget({
        chartId: data.chart_id,
        role: data.role,
        spec: data.source_spec,
        updatedAt: data.updated_at,
      });
    } catch {
      setError('Could not open this chart for editing.');
    } finally {
      setBusy(false);
    }
  }

  function onAddFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file && addRole) doUpload(file, addRole);
  }

  function onReplaceFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    const role = replaceRoleRef.current;
    e.target.value = '';
    replaceRoleRef.current = null;
    if (file && role) doUpload(file, role);
  }

  function startReplace(role: string) {
    replaceRoleRef.current = role;
    replaceFileRef.current?.click();
  }

  async function handleDelete(chartId: string) {
    if (!confirm('Delete this chart?')) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/charts/delete', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chart_id: chartId }),
      });
      if (!res.ok) {
        setError('Delete failed — chart not found or permission denied.');
        return;
      }
      onChartsChanged(removeChartById(charts, chartId));
      if (previewId === chartId) setPreviewId(null);
    } catch {
      setError('Delete failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-3xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-5 py-3 border-b border-zinc-800">
          <div>
            <h2 className="text-lg font-bold text-white">Manage Charts</h2>
            <p className="text-xs text-zinc-500">{songTitle}</p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-white text-xl leading-none">
            &times;
          </button>
        </header>

        <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-2">
          {/* Left: role slots + add */}
          <div className="p-4 overflow-auto border-b md:border-b-0 md:border-r border-zinc-800 space-y-2">
            {charts.length === 0 && (
              <p className="text-sm text-zinc-500">No charts yet for this song.</p>
            )}
            {charts.map((c) => (
              <div
                key={c.fileId}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${
                  preview?.fileId === c.fileId
                    ? 'border-blue-600 bg-zinc-800'
                    : 'border-zinc-800 bg-zinc-900'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white">{displayRole(canonicalizeRole(c.role))}</p>
                  <p className="text-xs text-zinc-500 truncate">{c.label}</p>
                </div>
                <button
                  onClick={() => setPreviewId(c.fileId ?? null)}
                  className="text-xs text-zinc-400 hover:text-blue-400"
                >
                  Preview
                </button>
                {isOwner && (
                  <>
                    {/* Edit (spec) is offered only for builder charts — an
                        uploaded/converted chart has no source_spec to edit. */}
                    {c.is_builder && (
                      <button
                        onClick={() => startEdit(c)}
                        disabled={busy}
                        className="text-xs text-zinc-400 hover:text-blue-400 disabled:opacity-40"
                      >
                        Edit
                      </button>
                    )}
                    <button
                      onClick={() => startReplace(c.role)}
                      disabled={busy}
                      className="text-xs text-zinc-400 hover:text-blue-400 disabled:opacity-40"
                    >
                      {/* Reworded on builder rows so "Edit" (spec) vs file-replace
                          reads unambiguously (§4.1). */}
                      {c.is_builder ? 'Replace with file' : 'Replace'}
                    </button>
                    <button
                      onClick={() => c.fileId && handleDelete(c.fileId)}
                      disabled={busy}
                      className="text-xs text-zinc-400 hover:text-red-400 disabled:opacity-40"
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            ))}

            {isOwner && free.length > 0 && (
              <div className="flex items-center gap-2 pt-2">
                <select
                  value={addRole}
                  onChange={(e) => setAddRole(e.target.value as ChartRole)}
                  disabled={busy}
                  className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white outline-none focus:border-blue-500"
                >
                  <option value="">Add chart for…</option>
                  {free.map((r) => (
                    <option key={r} value={r}>
                      {displayRole(r)}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => addFileRef.current?.click()}
                  disabled={busy || !addRole}
                  className="px-3 py-1.5 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-40"
                >
                  {busy ? 'Working…' : 'Choose file'}
                </button>
              </div>
            )}

            {isOwner && free.length > 0 && (
              <div className="flex items-center gap-2 pt-1">
                <div className="flex-1 h-px bg-zinc-800" />
                <span className="text-[10px] uppercase tracking-wide text-zinc-600">or</span>
                <div className="flex-1 h-px bg-zinc-800" />
              </div>
            )}

            {isOwner && free.length > 0 && (
              <button
                onClick={() => setBuilding(true)}
                disabled={busy}
                className="w-full px-3 py-1.5 rounded border border-blue-600/50 text-blue-300 text-sm font-medium hover:bg-blue-600/10 disabled:opacity-40"
              >
                Build a chart with AI
              </button>
            )}

            {error && <p className="text-sm text-amber-400 pt-1">{error}</p>}

            {/* Hidden file inputs drive both add + replace */}
            <input ref={addFileRef} type="file" accept={ACCEPT} className="hidden" onChange={onAddFile} />
            <input ref={replaceFileRef} type="file" accept={ACCEPT} className="hidden" onChange={onReplaceFile} />
          </div>

          {/* Right: preview pane */}
          <div className="p-4 min-h-[240px] md:min-h-0 flex items-center justify-center bg-zinc-950">
            {preview ? (
              <ChartPreview key={`${preview.fileId}:${preview.url}`} chart={preview} />
            ) : (
              <p className="text-sm text-zinc-600">Select a chart to preview.</p>
            )}
          </div>
        </div>
      </div>

      {(building || editTarget) && (
        <RoadmapBuilder
          songTitle={songTitle}
          charts={charts}
          editChart={editTarget ?? undefined}
          onClose={() => {
            setBuilding(false);
            setEditTarget(null);
          }}
          onSaved={onBuilt}
        />
      )}
    </div>
  );
}

// Read-only preview: PDF.js canvas for PDFs (with page controls), <img> for images.
function ChartPreview({ chart }: { chart: Chart }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pageNum, setPageNum] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [failed, setFailed] = useState(false);

  const isPdf =
    (chart.mimeType ?? '').includes('pdf') || (chart.label ?? '').toLowerCase().endsWith('.pdf');

  // The component is keyed on chart.fileId by the caller, so it remounts per
  // chart — state starts fresh and this effect only needs to load the doc.
  useEffect(() => {
    if (!isPdf) return;
    let cancelled = false;
    loadPdfDoc(chart).then((loaded) => {
      if (cancelled) return;
      if (!loaded) {
        setFailed(true);
        return;
      }
      setDoc(loaded.doc);
      setNumPages(loaded.doc.numPages);
    });
    return () => {
      cancelled = true;
    };
  }, [chart, isPdf]);

  useEffect(() => {
    if (doc && canvasRef.current) renderPage(doc, pageNum, canvasRef.current);
  }, [doc, pageNum]);

  if (!isPdf) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={chart.url} alt={chart.label ?? 'chart'} className="max-w-full max-h-full object-contain" />;
  }
  if (failed) return <p className="text-sm text-zinc-500">Could not load preview.</p>;

  return (
    <div className="flex flex-col h-full w-full">
      {/* Re-key (Option A): a builder chart's PDF no longer bakes "Key:". With no
          setlist here (standalone library preview), the live key falls back to
          the chart's authored_key. */}
      {chart.is_builder && chart.authored_key && (
        <div className="pb-2 text-center">
          <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-xs font-bold text-zinc-200">
            Key {chart.authored_key}
          </span>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center">
        <canvas ref={canvasRef} />
      </div>
      {numPages > 1 && (
        <div className="flex items-center justify-center gap-3 pt-2 text-sm text-zinc-400">
          <button
            onClick={() => setPageNum((p) => Math.max(1, p - 1))}
            disabled={pageNum <= 1}
            className="px-2 hover:text-white disabled:opacity-30"
          >
            ‹ Prev
          </button>
          <span>
            {pageNum} / {numPages}
          </span>
          <button
            onClick={() => setPageNum((p) => Math.min(numPages, p + 1))}
            disabled={pageNum >= numPages}
            className="px-2 hover:text-white disabled:opacity-30"
          >
            Next ›
          </button>
        </div>
      )}
    </div>
  );
}
