'use client';

import { useState, useRef, useEffect } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Chart } from '@/lib/types';
import { canonicalizeRole, displayRole, type ChartRole } from '@/lib/normalize';
import { uploadChart, ChartUploadError, type ConvertResult } from '@/lib/chart-upload';
import { availableRoles, applyUploadedChart, removeChartById } from '@/lib/chart-management';
import { loadPdfDoc, renderPage } from '@/lib/pdf-viewer';

const ACCEPT = '.pdf,.png,.jpg,.jpeg';

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
  const [addRole, setAddRole] = useState<ChartRole | ''>('');
  const [preview, setPreview] = useState<Chart | null>(null);
  const addFileRef = useRef<HTMLInputElement>(null);
  const replaceRoleRef = useRef<string | null>(null);
  const replaceFileRef = useRef<HTMLInputElement>(null);

  const free = availableRoles(charts);

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
      if (preview?.fileId === chartId) setPreview(null);
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
                  onClick={() => setPreview(c)}
                  className="text-xs text-zinc-400 hover:text-blue-400"
                >
                  Preview
                </button>
                {isOwner && (
                  <>
                    <button
                      onClick={() => startReplace(c.role)}
                      disabled={busy}
                      className="text-xs text-zinc-400 hover:text-blue-400 disabled:opacity-40"
                    >
                      Replace
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

            {error && <p className="text-sm text-amber-400 pt-1">{error}</p>}

            {/* Hidden file inputs drive both add + replace */}
            <input ref={addFileRef} type="file" accept={ACCEPT} className="hidden" onChange={onAddFile} />
            <input ref={replaceFileRef} type="file" accept={ACCEPT} className="hidden" onChange={onReplaceFile} />
          </div>

          {/* Right: preview pane */}
          <div className="p-4 min-h-[240px] md:min-h-0 flex items-center justify-center bg-zinc-950">
            {preview ? (
              <ChartPreview key={preview.fileId} chart={preview} />
            ) : (
              <p className="text-sm text-zinc-600">Select a chart to preview.</p>
            )}
          </div>
        </div>
      </div>
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
