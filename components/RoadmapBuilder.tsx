'use client';

import { useEffect, useRef, useState } from 'react';
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
import { pickBarsPerLine, chunkIntoLines } from '@/lib/roadmap-layout';

// ── Roadmap Builder — describe a song's structure, render an exact chart ─────
// Full-screen overlay launched from ManageChartsModal. Compose (big prompt) →
// the AI parse route proposes a validated RoadmapSpec → Review (chart system is
// the editor: Nashville numerals over the bars with the live `-` split preview,
// section CRUD, Numbers⇄Letters key toggle) → Save re-derives the spec and the
// /save route re-validates + re-renders {pdf, born-verified calibration}. The
// view↔spec bridge (lib/roadmap-view) is the only place the editor's beat-weight
// model meets the canonical ChordHit contract.

const KEYS = ['C', 'G', 'D', 'A', 'E', 'B', 'F', 'Bb', 'Eb', 'Ab', 'Am', 'Em', 'Dm', 'Bm'];

// Re-opening a saved builder chart for editing. The spec + slot identity come from
// the GET read door; the builder mounts straight into Review with the role locked
// to overwrite, and threads the slot identity into save as the stale-edit
// precondition (§4.3/§4.4).
export interface EditChart {
  chartId: string;
  role: string;
  spec: RoadmapSpec;
  updatedAt: string;
}

interface Props {
  songTitle: string;          // fixed: this builder authors charts for THIS song
  charts: Chart[];            // existing charts → which roles are still free
  editChart?: EditChart;      // present = re-open an existing builder chart to edit
  onClose: () => void;
  onSaved: (chart: Chart) => void;
}

export default function RoadmapBuilder({ songTitle, charts, editChart, onClose, onSaved }: Props) {
  const [description, setDescription] = useState('');
  const [composeKey, setComposeKey] = useState(''); // '' = Auto (let L0 resolve)
  // Edit mode seeds the view from the saved spec → mounts directly in Review,
  // skipping Compose. A fresh build starts null (Compose first). The refine box
  // stays empty on re-open (v1): the manual editor is the default, Regenerate is
  // opt-in (§5).
  const [view, setView] = useState<ViewModel | null>(editChart ? specToView(editChart.spec) : null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [specErrors, setSpecErrors] = useState<string[]>([]);
  const [tally, setTally] = useState<string[]>([]); // L4 read-back echo

  async function generate(reset: boolean) {
    const text = description.trim();
    if (!text || generating) return;
    if (reset && view && !confirm('Regenerate will replace your manual edits. Continue?')) return;
    setGenerating(true);
    setError('');
    setSpecErrors([]);
    setTally([]);
    try {
      const res = await fetch('/api/charts/roadmap/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: text, key: composeKey || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Could not reach the parser.');
        return;
      }
      if (Array.isArray(data.tally)) setTally(data.tally);
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
          <h1 className="text-lg font-bold text-white">{editChart ? 'Edit Chart' : 'Build a Chart'}</h1>
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
          composeKey={composeKey}
          setComposeKey={setComposeKey}
          generating={generating}
          error={error}
          specErrors={specErrors}
          tally={tally}
          onGenerate={() => generate(false)}
        />
      ) : (
        <Review
          songTitle={songTitle}
          charts={charts}
          editChart={editChart}
          view={view}
          setView={setView}
          description={description}
          setDescription={setDescription}
          generating={generating}
          tally={tally}
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
  composeKey,
  setComposeKey,
  generating,
  error,
  specErrors,
  tally,
  onGenerate,
}: {
  description: string;
  setDescription: (v: string) => void;
  composeKey: string;
  setComposeKey: (v: string) => void;
  generating: boolean;
  error: string;
  specErrors: string[];
  tally: string[];
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
        {tally.length > 0 && <ReadBack tally={tally} />}
        <div className="flex items-center justify-between mt-4">
          <label className="inline-flex items-center gap-2 text-xs text-zinc-500">
            Key
            <select
              value={composeKey}
              onChange={(e) => setComposeKey(e.target.value)}
              className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white outline-none focus:border-blue-500"
            >
              <option value="">Auto</option>
              {KEYS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
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
  editChart,
  view,
  setView,
  description,
  setDescription,
  generating,
  tally,
  onRegenerate,
  onSaved,
}: {
  songTitle: string;
  charts: Chart[];
  editChart?: EditChart;
  view: ViewModel;
  setView: React.Dispatch<React.SetStateAction<ViewModel | null>>;
  description: string;
  setDescription: (v: string) => void;
  generating: boolean;
  tally: string[];
  onRegenerate: () => void;
  onSaved: (chart: Chart) => void;
}) {
  // Edit mode locks the role to the chart being overwritten; a fresh build picks a
  // free role at save time.
  const [role, setRole] = useState<ChartRole | ''>(editChart ? canonicalizeRole(editChart.role) : '');
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
        body: JSON.stringify({
          spec,
          song_title: songTitle,
          role,
          // Edit mode threads the stale-edit precondition (§4.4); a fresh build
          // omits it and the save route applies no precondition.
          ...(editChart
            ? { expected_chart_id: editChart.chartId, expected_updated_at: editChart.updatedAt }
            : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 409 = the slot changed under this edit (Replace / another edit landed).
        // The precondition is one-shot, so the loaded updatedAt is now stale —
        // tell the owner to reopen rather than retry against a moving target.
        setSaveError(
          res.status === 409
            ? data.error || 'This chart changed since you opened it — close and reopen to edit the latest.'
            : data.error
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
        // Re-key (Option A): a builder chart is Nashville/key-invariant. Mark it so
        // the viewer/preview chrome surfaces the live key; authored_key = the spec's
        // renderKey (informational). Persisted source_spec rehydrates the same on reload.
        is_builder: true,
        authored_key: spec.renderKey,
        charted_key: null,
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
        {tally.length > 0 && <ReadBack tally={tally} />}
        <p className="text-[11px] text-zinc-600 mt-auto">
          Tip: click a bar — &ldquo;1&rdquo; or &ldquo;IV&rdquo; for a whole bar, &ldquo;5 4&rdquo; to
          split evenly, &ldquo;1 - 4 5&rdquo; to tie (2 of 1, then 4, then 5).
        </p>
      </aside>

      {/* Center — chart system hero. overflow-Y only: the chart is fit-to-width,
          so a horizontal scrollbar must NEVER appear (design §4.3). */}
      <main className="min-h-[420px] p-6 bg-zinc-900/40 flex flex-col items-center gap-3 overflow-y-auto overflow-x-hidden">
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
          explicitBarsPerLine={view.barsPerLine}
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
          <label className="block text-xs text-zinc-500">{editChart ? 'Saving to role' : 'Save as role'}</label>
          {editChart ? (
            // Edit overwrites one chart — role is fixed, not a free-role pick.
            <div className="flex items-center gap-2">
              <span className="flex-1 px-2 py-1.5 text-sm text-white bg-zinc-800 border border-zinc-700 rounded">
                {displayRole(canonicalizeRole(editChart.role))}
              </span>
              <button
                onClick={save}
                disabled={saving}
                className="px-3 py-1.5 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-40"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          ) : free.length === 0 ? (
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

// L4 read-back echo: the per-section bar totals the parse produced, straight from
// the SpanList — so a dropped span shows up as a wrong total before you ever save.
function ReadBack({ tally }: { tally: string[] }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 space-y-1">
      <h4 className="text-[11px] uppercase tracking-wide text-zinc-500">Read-back</h4>
      <ul className="space-y-0.5 text-xs text-zinc-300">
        {tally.map((line, i) => (
          <li key={i} className="font-mono leading-snug">
            {line}
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-zinc-600">Check the bar counts. If a section is short, refine and regenerate.</p>
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

// Track an element's content-box width so the preview can pick a fit-to-width
// bars/line tier responsively (design §4.2/§4.3). Content-box width excludes
// padding, so it's the true bar-rendering width.
function useContentWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

// ── The chart: a real Nashville system ───────────────────────────────────────
function ChartSheet({
  title,
  renderKey,
  timeSig,
  mode,
  sections,
  explicitBarsPerLine,
  editing,
  setEditing,
  onCommitBar,
}: {
  title: string;
  renderKey: string;
  timeSig: { beats: number; unit: number };
  mode: 'numbers' | 'letters';
  sections: ViewSection[];
  explicitBarsPerLine?: number;
  editing: string | null;
  setEditing: (k: string | null) => void;
  onCommitBar: (sectionId: string, barIndex: number, cells: ViewBar) => void;
}) {
  const beats = timeSig.beats;
  // Fit-to-width: an explicit spec.barsPerLine wins (Q1, mirrors the PDF resolver);
  // otherwise pick a bars/line tier from the measured bar area, never letting a
  // line overflow (design §4.3). Default 4 until the first measure lands.
  const [barsRef, barsWidth] = useContentWidth<HTMLDivElement>();
  const barsPerLine =
    explicitBarsPerLine && explicitBarsPerLine > 0
      ? explicitBarsPerLine
      : barsWidth > 0
        ? pickBarsPerLine(barsWidth)
        : 4;
  return (
    <div className="w-full max-w-[920px] mx-auto bg-white rounded shadow-2xl p-7 text-black">
      <div className="text-center border-b border-zinc-200 pb-3 mb-3">
        <div className="text-xl font-bold text-black">{title}</div>
      </div>
      <div className="flex items-baseline justify-between">
        <div className="text-sm font-bold">Key of {renderKey}</div>
        <div className="text-[11px] text-zinc-500">
          {beats}/{timeSig.unit} · Nashville Number System
        </div>
      </div>
      <div ref={barsRef} className="mt-5 space-y-5">
        {sections.map((s) => (
          <div key={s.id}>
            <div className="text-[11px] font-bold text-zinc-700 flex items-center gap-2 mb-1">
              {s.label}
              {repeatLabel(s.repeat) && <span className="text-[9px] text-blue-600">{repeatLabel(s.repeat)}</span>}
            </div>
            {/* One system row per line of `barsPerLine` bars. Constant-width grid
                columns (NOT flex-fill): a partial last line keeps bar width and
                left-aligns; the trailing barline tracks the last real bar. */}
            <div className="space-y-1">
              {chunkIntoLines(s.chords.map((bar, bi) => ({ bar, bi })), barsPerLine).map((line, li) => (
                <div
                  key={li}
                  className="grid border-l-2 border-black"
                  style={{ gridTemplateColumns: `repeat(${barsPerLine}, minmax(0, 1fr))` }}
                >
                  {line.map(({ bar, bi }, idx) => (
                    <Measure
                      key={bi}
                      bar={bar}
                      beats={beats}
                      mode={mode}
                      renderKey={renderKey}
                      trailing={idx === line.length - 1}
                      isEditing={editing === `${s.id}:${bi}`}
                      onEdit={() => setEditing(`${s.id}:${bi}`)}
                      onCommit={(cells) => onCommitBar(s.id, bi, cells)}
                      onCancel={() => setEditing(null)}
                    />
                  ))}
                </div>
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
  trailing,
  isEditing,
  onEdit,
  onCommit,
  onCancel,
}: {
  bar: ViewBar;
  beats: number;
  mode: 'numbers' | 'letters';
  renderKey: string;
  trailing: boolean; // last real bar on its line → draw the heavy system barline
  isEditing: boolean;
  onEdit: () => void;
  onCommit: (cells: ViewBar) => void;
  onCancel: () => void;
}) {
  const cells = bar ?? [];
  // Width comes from the parent grid column (constant), not flex-grow. A light
  // zinc divider separates interior bars; the line's last real bar carries the
  // heavy black system barline so a partial line's edge tracks it.
  return (
    <div
      onClick={isEditing ? undefined : onEdit}
      className={`group relative border-r cursor-pointer hover:bg-blue-50 ${
        trailing ? 'border-r-2 border-black' : 'border-zinc-300'
      }`}
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
  const parse = parseBarInput(draft, beats, renderKey);

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
