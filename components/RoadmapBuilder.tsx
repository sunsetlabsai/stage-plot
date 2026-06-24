'use client';

import { useState } from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Chart } from '@/lib/types';
import { canonicalizeRole, displayRole, type ChartRole } from '@/lib/normalize';
import { availableRoles } from '@/lib/chart-management';
import {
  parseBarInput,
  cellsToRaw,
  renderCell,
  specToView,
  viewToSpec,
  fitBars,
  type ViewModel,
  type ViewSection,
  type ViewBar,
  type ViewNavigation,
} from '@/lib/roadmap-view';
import type { RoadmapSpec, SectionRepeat } from '@/lib/roadmap-spec';

// ── Roadmap Builder — describe a song's structure, render an exact chart ─────
// Full-screen overlay launched from ManageChartsModal. Compose (big prompt) →
// the AI parse route proposes a validated RoadmapSpec → Review (chart system is
// the editor: Nashville numerals over the bars with the live `-` split preview,
// section CRUD, Numbers⇄Letters key toggle) → Save re-derives the spec and the
// /save route re-validates + re-renders {pdf, born-verified calibration}. The
// view↔spec bridge (lib/roadmap-view) is the only place the editor's beat-weight
// model meets the canonical ChordHit contract.

const KEYS = ['C', 'G', 'D', 'A', 'E', 'B', 'F', 'Bb', 'Eb', 'Ab', 'Am', 'Em', 'Dm', 'Bm'];

interface Props {
  songTitle: string;          // fixed: this builder authors charts for THIS song
  charts: Chart[];            // existing charts → which roles are still free
  onClose: () => void;
  onSaved: (chart: Chart) => void;
}

export default function RoadmapBuilder({ songTitle, charts, onClose, onSaved }: Props) {
  const [description, setDescription] = useState('');
  const [view, setView] = useState<ViewModel | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [specErrors, setSpecErrors] = useState<string[]>([]);

  async function generate(reset: boolean) {
    const text = description.trim();
    if (!text || generating) return;
    if (reset && view && !confirm('Regenerate will replace your manual edits. Continue?')) return;
    setGenerating(true);
    setError('');
    setSpecErrors([]);
    try {
      const res = await fetch('/api/charts/roadmap/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Could not reach the parser.');
        return;
      }
      if (!data.ok) {
        setSpecErrors(Array.isArray(data.errors) ? data.errors : ['The parser returned an invalid chart.']);
        return;
      }
      setView(specToView(data.spec as RoadmapSpec));
    } catch {
      setError('Could not reach the parser.');
    } finally {
      setGenerating(false);
    }
  }

  return (
    // Stop propagation: this overlay is rendered inside ManageChartsModal's
    // backdrop (onClick=onClose), so clicks here must not close the host modal.
    <div
      onClick={(e) => e.stopPropagation()}
      className="fixed inset-0 z-[60] bg-zinc-950 text-zinc-200 flex flex-col"
    >
      <header className="border-b border-zinc-800 px-6 py-3 flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-lg font-bold text-white">Build a Chart</h1>
          <p className="text-xs text-zinc-500">{songTitle}</p>
        </div>
        <button onClick={onClose} className="text-zinc-500 hover:text-white text-2xl leading-none">
          &times;
        </button>
      </header>

      {!view ? (
        <Compose
          description={description}
          setDescription={setDescription}
          generating={generating}
          error={error}
          specErrors={specErrors}
          onGenerate={() => generate(false)}
        />
      ) : (
        <Review
          songTitle={songTitle}
          charts={charts}
          view={view}
          setView={setView}
          description={description}
          setDescription={setDescription}
          generating={generating}
          onRegenerate={() => generate(true)}
          onSaved={onSaved}
        />
      )}
    </div>
  );
}

// ── Compose ──────────────────────────────────────────────────────────────────
function Compose({
  description,
  setDescription,
  generating,
  error,
  specErrors,
  onGenerate,
}: {
  description: string;
  setDescription: (v: string) => void;
  generating: boolean;
  error: string;
  specErrors: string[];
  onGenerate: () => void;
}) {
  return (
    <main className="flex-1 flex items-center justify-center p-6 overflow-auto">
      <div className="w-full max-w-2xl">
        <h2 className="text-2xl font-semibold text-white text-center mb-2">
          What does the song look like?
        </h2>
        <p className="text-sm text-zinc-500 text-center mb-6">
          Time signature, key, sections, bar counts, chord changes (Nashville numbers or roman
          numerals), repeats, and any roadmap markers (segno, coda, D.S./D.C., fine). Plain English
          is fine.
        </p>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={7}
          autoFocus
          placeholder="e.g. 4/4 in G. 4-bar intro on the 1, 8-bar verse (4 of 1, 2 of 4, then 5) played twice, 8-bar chorus with 1st and 2nd endings, an 8-bar solo, then a 4-bar outro…"
          className="w-full bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-3 text-base text-white outline-none focus:border-blue-500 resize-none leading-relaxed"
        />
        {error && <p className="text-sm text-amber-400 mt-3">{error}</p>}
        {specErrors.length > 0 && (
          <div className="mt-3 text-sm text-amber-400 space-y-0.5">
            <p>The description was understood but produced an invalid chart:</p>
            <ul className="list-disc pl-5 text-amber-300/90">
              {specErrors.slice(0, 6).map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
            <p className="text-zinc-500">Try rephrasing and generate again.</p>
          </div>
        )}
        <div className="flex items-center justify-end mt-4">
          <button
            onClick={onGenerate}
            disabled={generating || !description.trim()}
            className="px-6 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-40"
          >
            {generating ? 'Generating…' : 'Generate chart'}
          </button>
        </div>
      </div>
    </main>
  );
}

// ── Review ───────────────────────────────────────────────────────────────────
function Review({
  songTitle,
  charts,
  view,
  setView,
  description,
  setDescription,
  generating,
  onRegenerate,
  onSaved,
}: {
  songTitle: string;
  charts: Chart[];
  view: ViewModel;
  setView: React.Dispatch<React.SetStateAction<ViewModel | null>>;
  description: string;
  setDescription: (v: string) => void;
  generating: boolean;
  onRegenerate: () => void;
  onSaved: (chart: Chart) => void;
}) {
  const [role, setRole] = useState<ChartRole | ''>('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [mode, setMode] = useState<'numbers' | 'letters'>('numbers');
  const [editing, setEditing] = useState<string | null>(null); // `${sectionId}:${barIndex}`

  const beats = view.timeSig.beats;
  const free = availableRoles(charts);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  // Mutate the sections array within the ViewModel.
  function patchSections(fn: (s: ViewSection[]) => ViewSection[]) {
    setView((prev) => (prev ? { ...prev, sections: fn(prev.sections) } : prev));
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    patchSections((prev) => {
      const from = prev.findIndex((s) => s.id === active.id);
      const to = prev.findIndex((s) => s.id === over.id);
      return from === -1 || to === -1 ? prev : arrayMove(prev, from, to);
    });
  }

  function updateSection(id: string, patch: Partial<Pick<ViewSection, 'label' | 'bars'>>) {
    patchSections((prev) =>
      prev.map((s) => {
        if (s.id !== id) return s;
        const next = { ...s, ...patch };
        if (patch.bars !== undefined) next.chords = fitBars(next.chords, patch.bars);
        return next;
      }),
    );
  }

  function removeSection(id: string) {
    patchSections((prev) => prev.filter((s) => s.id !== id));
  }

  function addSection() {
    patchSections((prev) => [
      ...prev,
      { id: `sec-${Date.now()}`, label: 'New section', bars: 4, chords: [null, null, null, null] },
    ]);
  }

  // Click-to-edit a bar: parseBarInput has already validated; empty clears the
  // bar (inherit). No run-length chips — numerals are edited on the system.
  function commitBar(sectionId: string, barIndex: number, cells: ViewBar) {
    patchSections((prev) =>
      prev.map((s) => {
        if (s.id !== sectionId) return s;
        const chords = s.chords.slice();
        chords[barIndex] = cells;
        return { ...s, chords };
      }),
    );
    setEditing(null);
  }

  async function save() {
    if (!role || saving) return;
    setSaving(true);
    setSaveError('');
    try {
      const spec = viewToSpec(view);
      const res = await fetch('/api/charts/roadmap/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec, song_title: songTitle, role }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSaveError(
          data.error
            ? data.details
              ? `${data.error}: ${(data.details as string[]).slice(0, 3).join('; ')}`
              : data.error
            : 'Save failed.',
        );
        return;
      }
      const canonical = canonicalizeRole(data.role ?? role);
      const chart: Chart = {
        role: canonical,
        url: data.url,
        fileId: data.chart_id,
        mimeType: 'application/pdf',
        modifiedTime: new Date().toISOString(),
        label: `${data.song_key ?? ''}-${canonical}.pdf`,
      };
      onSaved(chart);
    } catch {
      setSaveError('Save failed.');
    } finally {
      setSaving(false);
    }
  }

  const markers = navMarkers(view.navigation);

  return (
    <div className="flex-1 grid grid-cols-1 lg:grid-cols-[300px_1fr_340px] min-h-0">
      {/* Left — refine / re-prompt */}
      <aside className="border-b lg:border-b-0 lg:border-r border-zinc-800 p-4 flex flex-col gap-3 overflow-auto">
        <h3 className="text-xs uppercase tracking-wide text-zinc-500">Refine</h3>
        <p className="text-xs text-zinc-500">
          Adjust the description and regenerate, or tweak the structure on the right and the chords on
          the chart.
        </p>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={8}
          className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-blue-500 resize-none leading-relaxed"
        />
        <button
          onClick={onRegenerate}
          disabled={generating || !description.trim()}
          className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-40"
        >
          {generating ? 'Generating…' : 'Regenerate'}
        </button>
        <p className="text-[11px] text-zinc-600 mt-auto">
          Tip: click a bar — &ldquo;1&rdquo; or &ldquo;IV&rdquo; for a whole bar, &ldquo;5 4&rdquo; to
          split evenly, &ldquo;1 - 4 5&rdquo; to tie (2 of 1, then 4, then 5).
        </p>
      </aside>

      {/* Center — chart system hero */}
      <main className="min-h-[420px] p-6 bg-zinc-900/40 flex flex-col items-center gap-3 overflow-auto">
        <PreviewToolbar
          mode={mode}
          setMode={setMode}
          renderKey={view.renderKey}
          setRenderKey={(k) => setView((prev) => (prev ? { ...prev, renderKey: k } : prev))}
        />
        <ChartSheet
          title={songTitle}
          renderKey={view.renderKey}
          timeSig={view.timeSig}
          mode={mode}
          sections={view.sections}
          editing={editing}
          setEditing={setEditing}
          onCommitBar={commitBar}
        />
      </main>

      {/* Right — structure + save */}
      <aside className="border-t lg:border-t-0 lg:border-l border-zinc-800 flex flex-col min-h-0">
        <div className="flex-1 overflow-auto p-4 space-y-4">
          <div className="flex items-center gap-2 text-sm">
            <Field label="Key">
              <span className="font-mono text-white">{view.renderKey}</span>
            </Field>
            <Field label="Time">
              <span className="font-mono text-white">{beats}/{view.timeSig.unit}</span>
            </Field>
          </div>

          <div>
            <h3 className="text-xs uppercase tracking-wide text-zinc-500 mb-2">Sections</h3>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={view.sections.map((s) => s.id)} strategy={verticalListSortingStrategy}>
                <div className="space-y-1.5">
                  {view.sections.map((s, i) => (
                    <SortableSectionRow
                      key={s.id}
                      section={s}
                      index={i}
                      onChange={(patch) => updateSection(s.id, patch)}
                      onRemove={() => removeSection(s.id)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
            <button onClick={addSection} className="text-xs text-zinc-500 hover:text-blue-400 px-1 mt-1.5">
              + Add section
            </button>
          </div>

          {markers.length > 0 && (
            <div>
              <h3 className="text-xs uppercase tracking-wide text-zinc-500 mb-2">Roadmap markers</h3>
              <div className="flex flex-wrap gap-1.5">
                {markers.map((m) => (
                  <span
                    key={m}
                    className="text-[10px] px-2 py-1 rounded-md bg-zinc-800 border border-zinc-700 text-zinc-300"
                  >
                    {m}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="border-t border-zinc-800 p-4 space-y-2 shrink-0">
          <label className="block text-xs text-zinc-500">Save as role</label>
          {free.length === 0 ? (
            <p className="text-xs text-zinc-500">All roles already have a chart for this song.</p>
          ) : (
            <div className="flex gap-2">
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as ChartRole)}
                disabled={saving}
                className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white outline-none focus:border-blue-500"
              >
                <option value="">Choose role…</option>
                {free.map((r) => (
                  <option key={r} value={r}>
                    {displayRole(r)}
                  </option>
                ))}
              </select>
              <button
                onClick={save}
                disabled={!role || saving}
                className="px-3 py-1.5 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-40"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          )}
          {saveError && <p className="text-xs text-amber-400">{saveError}</p>}
        </div>
      </aside>
    </div>
  );
}

// Short human label for a section's repeat badge.
function repeatLabel(repeat: SectionRepeat | undefined): string | null {
  if (!repeat) return null;
  if (repeat.kind === 'plain') return `repeat ×${repeat.times}`;
  return `${repeat.endings.length} endings`;
}

// Read-only summary of the global roadmap navigation as marker chips.
function navMarkers(nav: ViewNavigation | undefined): string[] {
  if (!nav) return [];
  const out: string[] = [];
  if (nav.segno) out.push('Segno');
  if (nav.coda) out.push('Coda');
  if (nav.toCoda) out.push('To Coda');
  if (nav.fine) out.push('Fine');
  if (nav.jump) {
    const from = nav.jump.from === 'segno' ? 'D.S.' : 'D.C.';
    const until = nav.jump.until === 'coda' ? ' al Coda' : nav.jump.until === 'fine' ? ' al Fine' : '';
    out.push(`${from}${until}`);
  }
  return out;
}

// One reorderable section row. The grip carries the drag listeners so the inputs
// stay clickable; the row only moves when grabbed.
function SortableSectionRow({
  section,
  index,
  onChange,
  onRemove,
}: {
  section: ViewSection;
  index: number;
  onChange: (patch: Partial<Pick<ViewSection, 'label' | 'bars'>>) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: section.id,
  });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const repeat = repeatLabel(section.repeat);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-2 px-2.5 py-2 rounded-lg border bg-zinc-900 ${
        isDragging ? 'border-blue-500 opacity-80 shadow-lg z-10 relative' : 'border-zinc-800'
      }`}
    >
      <button
        {...attributes}
        {...listeners}
        title="Drag to reorder"
        className="text-zinc-600 hover:text-zinc-300 cursor-grab active:cursor-grabbing leading-none touch-none"
      >
        ⠿
      </button>
      <span className="text-zinc-600 text-[11px] w-4">{index + 1}</span>
      <input
        value={section.label}
        onChange={(e) => onChange({ label: e.target.value })}
        className="bg-transparent text-white text-sm w-20 outline-none focus:text-blue-300"
      />
      <input
        value={section.bars}
        type="number"
        onChange={(e) => onChange({ bars: Math.max(1, Number(e.target.value) || 1) })}
        className="w-11 bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5 text-center text-xs text-white outline-none focus:border-blue-500"
      />
      {repeat && (
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-300 border border-blue-500/30 whitespace-nowrap">
          {repeat}
        </span>
      )}
      <button
        onClick={onRemove}
        title="Remove section"
        className="ml-auto text-[11px] text-zinc-600 hover:text-red-400"
      >
        ✕
      </button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-zinc-900 border border-zinc-800">
      <span className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</span>
      {children}
    </span>
  );
}

// ── Preview toolbar: the transposition payoff ────────────────────────────────
function PreviewToolbar({
  mode,
  setMode,
  renderKey,
  setRenderKey,
}: {
  mode: 'numbers' | 'letters';
  setMode: (m: 'numbers' | 'letters') => void;
  renderKey: string;
  setRenderKey: (k: string) => void;
}) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <div className="inline-flex rounded-lg border border-zinc-700 overflow-hidden">
        {(['numbers', 'letters'] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`px-3 py-1.5 text-xs font-medium ${
              mode === m ? 'bg-blue-600 text-white' : 'bg-zinc-900 text-zinc-400 hover:text-white'
            }`}
          >
            {m === 'numbers' ? 'Numbers' : 'Letters'}
          </button>
        ))}
      </div>
      <label className="inline-flex items-center gap-1.5 text-xs text-zinc-500">
        Key
        <select
          value={KEYS.includes(renderKey) ? renderKey : ''}
          onChange={(e) => setRenderKey(e.target.value)}
          className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm text-white outline-none focus:border-blue-500"
        >
          {!KEYS.includes(renderKey) && <option value={renderKey}>{renderKey}</option>}
          {KEYS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </label>
      {mode === 'letters' && <span className="text-[11px] text-zinc-600">re-spelled in {renderKey}</span>}
    </div>
  );
}

// ── The chart: a real Nashville system ───────────────────────────────────────
function ChartSheet({
  title,
  renderKey,
  timeSig,
  mode,
  sections,
  editing,
  setEditing,
  onCommitBar,
}: {
  title: string;
  renderKey: string;
  timeSig: { beats: number; unit: number };
  mode: 'numbers' | 'letters';
  sections: ViewSection[];
  editing: string | null;
  setEditing: (k: string | null) => void;
  onCommitBar: (sectionId: string, barIndex: number, cells: ViewBar) => void;
}) {
  const beats = timeSig.beats;
  return (
    <div className="w-full max-w-[560px] bg-white rounded shadow-2xl p-7 text-black">
      <div className="text-center border-b border-zinc-200 pb-3 mb-3">
        <div className="text-xl font-bold text-black">{title}</div>
      </div>
      <div className="flex items-baseline justify-between">
        <div className="text-sm font-bold">Key of {renderKey}</div>
        <div className="text-[11px] text-zinc-500">
          {beats}/{timeSig.unit} · Nashville Number System
        </div>
      </div>
      <div className="mt-5 space-y-5">
        {sections.map((s) => (
          <div key={s.id}>
            <div className="text-[11px] font-bold text-zinc-700 flex items-center gap-2 mb-1">
              {s.label}
              {repeatLabel(s.repeat) && <span className="text-[9px] text-blue-600">{repeatLabel(s.repeat)}</span>}
            </div>
            <div className="flex border-l-2 border-r-2 border-black overflow-x-auto">
              {s.chords.map((bar, bi) => (
                <Measure
                  key={bi}
                  bar={bar}
                  beats={beats}
                  mode={mode}
                  renderKey={renderKey}
                  isEditing={editing === `${s.id}:${bi}`}
                  onEdit={() => setEditing(`${s.id}:${bi}`)}
                  onCommit={(cells) => onCommitBar(s.id, bi, cells)}
                  onCancel={() => setEditing(null)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// One measure: numeral(s) over the bar sized by beat weight, rhythm slashes
// inside. null bar = inherited (prints nothing). Click to edit.
function Measure({
  bar,
  beats,
  mode,
  renderKey,
  isEditing,
  onEdit,
  onCommit,
  onCancel,
}: {
  bar: ViewBar;
  beats: number;
  mode: 'numbers' | 'letters';
  renderKey: string;
  isEditing: boolean;
  onEdit: () => void;
  onCommit: (cells: ViewBar) => void;
  onCancel: () => void;
}) {
  const cells = bar ?? [];
  return (
    <div
      onClick={isEditing ? undefined : onEdit}
      className="group relative flex-1 min-w-[64px] border-r border-zinc-300 last:border-r-0 cursor-pointer hover:bg-blue-50"
    >
      <div className="h-5 flex items-stretch">
        {isEditing ? null : cells.length === 0 ? (
          <span className="flex-1 text-transparent group-hover:text-zinc-300 text-xs text-center">＋</span>
        ) : (
          cells.map((c, i) => (
            <span
              key={i}
              style={{ flexGrow: c.beats, flexBasis: 0 }}
              title={c.beats > 1 ? `${c.beats} beats` : undefined}
              className={`text-[13px] font-bold leading-none text-black pl-0.5 ${
                i > 0 ? 'border-l border-dashed border-zinc-300' : ''
              }`}
            >
              {renderCell(c, mode, renderKey)}
            </span>
          ))
        )}
      </div>
      <div className="h-7 flex items-center justify-around border-t border-b border-black px-1">
        {Array.from({ length: beats }).map((_, b) => (
          <span key={b} className="text-zinc-400 text-sm leading-none select-none">
            ╱
          </span>
        ))}
      </div>
      {isEditing && (
        <BarEditor
          initialRaw={cellsToRaw(cells, beats)}
          beats={beats}
          mode={mode}
          renderKey={renderKey}
          onCommit={onCommit}
          onCancel={onCancel}
        />
      )}
    </div>
  );
}

// The in-place bar editor. Mounts fresh each time a bar opens (parent renders it
// only while editing), so its draft seeds from the committed bar with no effect —
// a bar reopened after roman→number normalization shows its canonical form.
// Commit is blocked while the input doesn't parse (the live preview shows why).
function BarEditor({
  initialRaw,
  beats,
  mode,
  renderKey,
  onCommit,
  onCancel,
}: {
  initialRaw: string;
  beats: number;
  mode: 'numbers' | 'letters';
  renderKey: string;
  onCommit: (cells: ViewBar) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initialRaw);
  const parse = parseBarInput(draft, beats);

  function commit() {
    if (!parse.ok) return;
    onCommit(parse.cells.length > 0 ? parse.cells : null);
  }

  return (
    <div onClick={(e) => e.stopPropagation()} className="absolute -top-1 left-0 w-full z-10">
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => (parse.ok ? commit() : onCancel())}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') onCancel();
        }}
        placeholder="1   5 4   1 - 4 5"
        className={`w-full text-[12px] font-bold text-center bg-yellow-100 border rounded outline-none px-0.5 py-0.5 ${
          parse.ok ? 'border-blue-500' : 'border-amber-500'
        }`}
      />
      <SplitPreview parse={parse} mode={mode} renderKey={renderKey} />
    </div>
  );
}

// Live carve of the bar as you type — each chord a block whose width ∝ its beats,
// so the terse `-` grammar is self-explaining. Surfaces the parse error inline.
function SplitPreview({
  parse,
  mode,
  renderKey,
}: {
  parse: ReturnType<typeof parseBarInput>;
  mode: 'numbers' | 'letters';
  renderKey: string;
}) {
  if (!parse.ok) {
    return (
      <div className="mt-1 rounded border border-amber-500/60 bg-zinc-900 p-1 shadow-lg">
        <p className="text-center text-[9px] text-amber-400">{parse.error}</p>
      </div>
    );
  }
  const cells = parse.cells;
  const total = cells.reduce((n, c) => n + c.beats, 0);
  return (
    <div className="mt-1 rounded border border-zinc-700 bg-zinc-900 p-1 shadow-lg">
      <div className="flex h-6 gap-px overflow-hidden rounded-sm">
        {cells.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-[10px] text-zinc-500 bg-zinc-800">
            inherits previous chord
          </div>
        ) : (
          cells.map((c, i) => (
            <div
              key={i}
              style={{ flexGrow: c.beats, flexBasis: 0 }}
              className="flex flex-col items-center justify-center bg-blue-600/25 border-x border-blue-500/40"
            >
              <span className="text-[11px] font-bold leading-none text-white">{renderCell(c, mode, renderKey)}</span>
              <span className="text-[8px] leading-none text-blue-300/80">{c.beats}b</span>
            </div>
          ))
        )}
      </div>
      {cells.length > 0 && (
        <div className="mt-0.5 text-center text-[9px] text-zinc-500">
          {total} beat{total === 1 ? '' : 's'}
        </div>
      )}
    </div>
  );
}
