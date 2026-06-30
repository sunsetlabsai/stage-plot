'use client';

import { useEffect, useRef, useState } from 'react';
import { pickBarsPerLine, chunkIntoLines } from '@/lib/roadmap-layout';
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

// ── MOCKUP ONLY — Roadmap Builder UI (chunk 3 commit 2) ──────────────────────
// Standalone, fully stubbed. No API calls, no persistence. Purpose: let Graham
// SEE and iterate on the builder layout/flow via Tailscale before we wire it
// into ManageChartsModal + the real /parse and /save routes. Theme mirrors the
// app (zinc-950 dark, blue-600 accent).
//
// Two states:
//  1. COMPOSE  — big centered prompt (room to type; later, to talk).
//  2. REVIEW   — chart system is the hero (center): Nashville numerals over the
//                bars with beat slashes inside each measure, click-to-edit, and a
//                Numbers⇄Letters toggle that re-spells degrees into the render key
//                (the transposition payoff). Iterate rail left; structure right.

// A chord cell = a numeral that occupies `beats` beats of its measure. A bar is
// null (inherit the previous chord — sparse, like a real chart) or 1+ cells whose
// beats lay out left→right (width ∝ beats), snapped to the measure's beat slashes.
type Cell = { sym: string; beats: number };
type Bar = Cell[] | null;

type Spec = {
  renderKey: string;
  timeSig: string;
  // Authoring form: one entry per bar, null = inherit, else the bar's input string
  // ("1" whole bar, "5 4" even split, "1 - 4 5" = 2 of 1 / 1 of 4 / 1 of 5).
  sections: { label: string; bars: number; repeat: string | null; chords: (string | null)[] }[];
  nav: string[];
};

const SAMPLE: Spec = {
  renderKey: 'G',
  timeSig: '4/4',
  sections: [
    { label: 'Intro', bars: 4, repeat: null, chords: ['1', null, null, '5'] },
    { label: 'Verse', bars: 8, repeat: 'plain ×2', chords: ['1', null, null, null, '4', null, '1', '5'] },
    { label: 'Chorus', bars: 8, repeat: 'volta 1. / 2.', chords: ['4', '1', '4', '1', '6m', null, '5 4', '1'] },
    // Solo bar 5 shows a non-uniform split: 2 beats of 4, 1 of 1, 1 of 5.
    { label: 'Solo', bars: 8, repeat: null, chords: ['1', null, null, null, '4 - 1 5', null, '5', null] },
    { label: 'Outro', bars: 4, repeat: null, chords: ['1', null, '5', '1'] },
  ],
  nav: ['Segno @ Verse 1', 'To Coda @ Chorus 8', 'Coda @ Solo 1', 'D.S. al Coda @ Outro 4'],
};

const SAMPLE_DESCRIPTION =
  '4/4 in G. 4-bar intro, then an 8-bar verse played twice, an 8-bar chorus with ' +
  '1st and 2nd endings, an 8-bar solo, and a 4-bar outro. Segno on the verse, ' +
  'to-coda at the end of the chorus, coda at the solo, D.S. al coda at the outro.';

const ROLES = ['Guitar', 'Lyrics', 'Keys', 'Bass', 'Horns', 'Drums', 'Other'];
const KEYS = ['C', 'G', 'D', 'A', 'E', 'B', 'F', 'Bb', 'Eb', 'Ab', 'Am', 'Em', 'Dm', 'Bm'];

type EditSection = { id: string; label: string; bars: number; repeat: string | null; chords: Bar[] };

let _sectionSeq = 0;
const newSectionId = () => `sec-${++_sectionSeq}`;
const wholeBar = (sym = '1'): Cell[] => [{ sym, beats: 1 }];

// Keep the per-bar chord array the same length as the bar count (bars are
// authoritative — design decision). Growing pads with null (inherit); the first
// bar always shows something.
function fitChords(chords: Bar[], bars: number): Bar[] {
  const out = chords.slice(0, bars);
  while (out.length < bars) out.push(null);
  if (out.length > 0 && out[0] == null) out[0] = wholeBar();
  return out;
}

const toEditSections = (sections: Spec['sections']): EditSection[] =>
  sections.map((x) => ({
    id: newSectionId(),
    label: x.label,
    bars: x.bars,
    repeat: x.repeat,
    chords: fitChords(
      x.chords.map((c) => (c == null ? null : parseBar(c))),
      x.bars,
    ),
  }));

// ── Chord input grammar ──────────────────────────────────────────────────────
// One whitespace-separated slot per beat; a "-" extends (ties) the previous
// chord by a beat. So "1 - 4 5" → 2 beats of 1, 1 of 4, 1 of 5. Each chord token
// is normalized (roman→number, lowercase roman = minor) on the way in.
function parseBar(raw: string): Cell[] {
  const cells: Cell[] = [];
  for (const slot of raw.trim().split(/\s+/).filter(Boolean)) {
    if (slot === '-') {
      if (cells.length) cells[cells.length - 1].beats += 1;
      continue;
    }
    cells.push({ sym: normalizeToken(slot), beats: 1 });
  }
  return cells;
}

// Reconstruct the editable input string from cells (chord + N-1 ties).
function cellsToRaw(cells: Cell[]): string {
  return cells.map((c) => [c.sym, ...Array(Math.max(0, c.beats - 1)).fill('-')].join(' ')).join(' ');
}

export default function RoadmapBuilderMockup() {
  const [description, setDescription] = useState('');
  const [spec, setSpec] = useState<Spec | null>(null);
  const [generating, setGenerating] = useState(false);

  function generate() {
    if (!description.trim()) setDescription(SAMPLE_DESCRIPTION);
    setGenerating(true);
    setTimeout(() => {
      setSpec(SAMPLE);
      setGenerating(false);
    }, 600);
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-200 flex flex-col">
      <header className="border-b border-zinc-800 px-6 py-4 flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-lg font-bold text-white">Build a Chart</h1>
          <p className="text-xs text-zinc-500">
            Describe the song&apos;s structure — we render an exact, transposable chart.
          </p>
        </div>
        <span className="text-[10px] uppercase tracking-wide text-amber-400 border border-amber-500/40 rounded px-2 py-0.5">
          Mockup
        </span>
      </header>

      {!spec ? (
        <Compose
          description={description}
          setDescription={setDescription}
          generating={generating}
          onGenerate={generate}
        />
      ) : (
        <Review
          spec={spec}
          description={description}
          setDescription={setDescription}
          generating={generating}
          onRegenerate={generate}
        />
      )}
    </div>
  );
}

// ── State 1: COMPOSE — big centered prompt ───────────────────────────────────
function Compose({
  description,
  setDescription,
  generating,
  onGenerate,
}: {
  description: string;
  setDescription: (v: string) => void;
  generating: boolean;
  onGenerate: () => void;
}) {
  return (
    <main className="flex-1 flex items-center justify-center p-6">
      <div className="w-full max-w-2xl">
        <h2 className="text-2xl font-semibold text-white text-center mb-2">
          What does the song look like?
        </h2>
        <p className="text-sm text-zinc-500 text-center mb-6">
          Time signature, key, sections, bar counts, chord changes (Nashville numbers or roman
          numerals), repeats, and any roadmap markers (segno, coda, D.S./D.C., fine). Plain English
          is fine.
        </p>

        <div className="relative">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={7}
            autoFocus
            placeholder="e.g. 4/4 in G. 4-bar intro on the 1, 8-bar verse (4 of I, 2 of IV, then V) played twice, 8-bar chorus with 1st and 2nd endings, an 8-bar solo, then a 4-bar outro…"
            className="w-full bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-3 text-base text-white outline-none focus:border-blue-500 resize-none leading-relaxed"
          />
          <button
            title="Dictate (coming soon)"
            className="absolute bottom-3 right-3 w-9 h-9 rounded-full bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-blue-400 hover:border-blue-500 flex items-center justify-center"
          >
            🎙
          </button>
        </div>

        <div className="flex items-center justify-between mt-4">
          <button
            onClick={() => setDescription(SAMPLE_DESCRIPTION)}
            className="text-xs text-zinc-500 hover:text-blue-400"
          >
            Use a sample description
          </button>
          <button
            onClick={onGenerate}
            disabled={generating}
            className="px-6 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-40"
          >
            {generating ? 'Generating…' : 'Generate chart'}
          </button>
        </div>
      </div>
    </main>
  );
}

// ── State 2: REVIEW — chart system hero, iterate left, editorial right ────────
function Review({
  spec,
  description,
  setDescription,
  generating,
  onRegenerate,
}: {
  spec: Spec;
  description: string;
  setDescription: (v: string) => void;
  generating: boolean;
  onRegenerate: () => void;
}) {
  const [role, setRole] = useState('');
  const [saved, setSaved] = useState(false);
  const [sections, setSections] = useState<EditSection[]>(() => toEditSections(spec.sections));
  const [renderKey, setRenderKey] = useState(spec.renderKey);
  const [title, setTitle] = useState('Sample Song');
  const [artist, setArtist] = useState('A. Songwriter');
  const [mode, setMode] = useState<'numbers' | 'letters'>('numbers');
  const [editing, setEditing] = useState<string | null>(null); // `${sectionId}:${barIndex}`

  const beats = Number(spec.timeSig.split('/')[0]) || 4;

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    setSections((prev) => {
      const from = prev.findIndex((s) => s.id === active.id);
      const to = prev.findIndex((s) => s.id === over.id);
      return from === -1 || to === -1 ? prev : arrayMove(prev, from, to);
    });
  }

  function updateSection(id: string, patch: Partial<EditSection>) {
    setSections((prev) =>
      prev.map((s) => {
        if (s.id !== id) return s;
        const next = { ...s, ...patch };
        if (patch.bars !== undefined) next.chords = fitChords(next.chords, patch.bars);
        return next;
      }),
    );
  }

  function removeSection(id: string) {
    setSections((prev) => prev.filter((s) => s.id !== id));
  }

  function addSection() {
    setSections((prev) => [
      ...prev,
      { id: newSectionId(), label: 'New section', bars: 4, repeat: null, chords: [wholeBar(), null, null, null] },
    ]);
  }

  // Click-to-edit a bar: parse the input grammar, normalize romans→numbers, empty
  // = inherit. No run-length chips — you edit numerals right on the system.
  function commitBar(sectionId: string, barIndex: number, raw: string) {
    const cells = parseBar(raw);
    const value: Bar = cells.length > 0 ? cells : barIndex === 0 ? wholeBar() : null;
    setSections((prev) =>
      prev.map((s) => {
        if (s.id !== sectionId) return s;
        const chords = s.chords.slice();
        chords[barIndex] = value;
        return { ...s, chords };
      }),
    );
    setEditing(null);
  }

  return (
    <div className="flex-1 grid grid-cols-1 lg:grid-cols-[300px_1fr_340px] min-h-0">
      {/* Left — iterate / re-prompt */}
      <aside className="border-b lg:border-b-0 lg:border-r border-zinc-800 p-4 flex flex-col gap-3">
        <h3 className="text-xs uppercase tracking-wide text-zinc-500">Refine</h3>
        <p className="text-xs text-zinc-500">
          Adjust the description and regenerate, or tweak the structure on the right and chords on the
          chart.
        </p>
        <div className="relative">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={8}
            className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-blue-500 resize-none leading-relaxed"
          />
          <button
            title="Dictate (coming soon)"
            className="absolute bottom-2 right-2 w-7 h-7 rounded-full bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-blue-400 hover:border-blue-500 flex items-center justify-center text-xs"
          >
            🎙
          </button>
        </div>
        <button
          onClick={() => {
            setSaved(false);
            onRegenerate();
          }}
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
      <main className="min-h-[420px] p-6 bg-zinc-900/40 flex flex-col items-center gap-3 overflow-y-auto overflow-x-hidden">
        <PreviewToolbar mode={mode} setMode={setMode} renderKey={renderKey} setRenderKey={setRenderKey} />
        <ChartSheet
          title={title}
          setTitle={setTitle}
          artist={artist}
          setArtist={setArtist}
          renderKey={renderKey}
          beats={beats}
          mode={mode}
          sections={sections}
          editing={editing}
          setEditing={setEditing}
          onCommitBar={commitBar}
        />
      </main>

      {/* Right — editorial commands (structure + save) */}
      <aside className="border-t lg:border-t-0 lg:border-l border-zinc-800 flex flex-col min-h-0">
        <div className="flex-1 overflow-auto p-4 space-y-4">
          <div className="flex items-center gap-2 text-sm">
            <Field label="Key">
              <span className="font-mono text-white">{renderKey}</span>
            </Field>
            <Field label="Time">
              <span className="font-mono text-white">{spec.timeSig}</span>
            </Field>
          </div>

          <div>
            <h3 className="text-xs uppercase tracking-wide text-zinc-500 mb-2">Sections</h3>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={sections.map((s) => s.id)} strategy={verticalListSortingStrategy}>
                <div className="space-y-1.5">
                  {sections.map((s, i) => (
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
            <button
              onClick={addSection}
              className="text-xs text-zinc-500 hover:text-blue-400 px-1 mt-1.5"
            >
              + Add section
            </button>
          </div>

          <div>
            <h3 className="text-xs uppercase tracking-wide text-zinc-500 mb-2">Roadmap markers</h3>
            <div className="flex flex-wrap gap-1.5">
              {spec.nav.map((n) => (
                <span
                  key={n}
                  className="text-[10px] px-2 py-1 rounded-md bg-zinc-800 border border-zinc-700 text-zinc-300"
                >
                  {n}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="border-t border-zinc-800 p-4 space-y-2 shrink-0">
          <label className="block text-xs text-zinc-500">Save as role</label>
          <div className="flex gap-2">
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-white outline-none focus:border-blue-500"
            >
              <option value="">Choose role…</option>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <button
              onClick={() => setSaved(true)}
              disabled={!role}
              className="px-3 py-1.5 rounded bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-40"
            >
              Save
            </button>
          </div>
          {saved && (
            <p className="text-xs text-green-400">
              (mock) Saved — would render server-side, verify parity, and persist.
            </p>
          )}
        </div>
      </aside>
    </div>
  );
}

// One reorderable section row. The grip (⠿) carries the drag listeners so the
// label/bars inputs stay fully clickable; the row only moves when you grab it.
function SortableSectionRow({
  section,
  index,
  onChange,
  onRemove,
}: {
  section: EditSection;
  index: number;
  onChange: (patch: Partial<EditSection>) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: section.id,
  });
  const style = { transform: CSS.Transform.toString(transform), transition };

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
      {section.repeat && (
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-300 border border-blue-500/30 whitespace-nowrap">
          {section.repeat}
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
          value={renderKey}
          onChange={(e) => setRenderKey(e.target.value)}
          className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm text-white outline-none focus:border-blue-500"
        >
          {KEYS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </label>
      {mode === 'letters' && (
        <span className="text-[11px] text-zinc-600">re-spelled in {renderKey}</span>
      )}
    </div>
  );
}

// Track an element's content-box width so the preview can pick a fit-to-width
// bars/line tier responsively (design §4.2/§4.3).
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
  setTitle,
  artist,
  setArtist,
  renderKey,
  beats,
  mode,
  sections,
  editing,
  setEditing,
  onCommitBar,
}: {
  title: string;
  setTitle: (v: string) => void;
  artist: string;
  setArtist: (v: string) => void;
  renderKey: string;
  beats: number;
  mode: 'numbers' | 'letters';
  sections: EditSection[];
  editing: string | null;
  setEditing: (k: string | null) => void;
  onCommitBar: (sectionId: string, barIndex: number, raw: string) => void;
}) {
  const [barsRef, barsWidth] = useContentWidth<HTMLDivElement>();
  const barsPerLine = barsWidth > 0 ? pickBarsPerLine(barsWidth) : 4;
  return (
    <div className="w-full max-w-[920px] mx-auto bg-white rounded shadow-2xl p-7 text-black">
      {/* Title + artist print at the top of the chart and are edited in place. */}
      <div className="text-center border-b border-zinc-200 pb-3 mb-3">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Song title"
          className="w-full text-center text-xl font-bold text-black bg-transparent outline-none rounded hover:bg-zinc-50 focus:bg-yellow-50 placeholder:text-zinc-300 placeholder:font-normal"
        />
        <input
          value={artist}
          onChange={(e) => setArtist(e.target.value)}
          placeholder="Artist / author"
          className="w-full text-center text-sm text-zinc-600 bg-transparent outline-none rounded hover:bg-zinc-50 focus:bg-yellow-50 placeholder:text-zinc-300"
        />
      </div>
      <div className="flex items-baseline justify-between">
        <div className="text-sm font-bold">Key of {renderKey}</div>
        <div className="text-[11px] text-zinc-500">Nashville Number System</div>
      </div>
      <div ref={barsRef} className="mt-5 space-y-5">
        {sections.map((s) => (
          <div key={s.id}>
            <div className="text-[11px] font-bold text-zinc-700 flex items-center gap-2 mb-1">
              {s.label}
              {s.repeat && <span className="text-[9px] text-blue-600">{s.repeat}</span>}
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
                      onCommit={(raw) => onCommitBar(s.id, bi, raw)}
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

// One measure: numeral(s) above, positioned + sized by beat weight (flex-grow ∝
// beats) so a 2/1/1 split aligns to the beats. Rhythm slashes (one per beat) sit
// inside as the beat grid. null bar = inherited, prints nothing. Click to edit.
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
  bar: Bar;
  beats: number;
  mode: 'numbers' | 'letters';
  renderKey: string;
  trailing: boolean; // last real bar on its line → draw the heavy system barline
  isEditing: boolean;
  onEdit: () => void;
  onCommit: (raw: string) => void;
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
      {/* numerals over the bar, each occupying its beat span */}
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
              {renderToken(c.sym, mode, renderKey)}
            </span>
          ))
        )}
      </div>
      {/* rhythm slashes inside the measure — the beat grid */}
      <div className="h-7 flex items-center justify-around border-t border-b border-black px-1">
        {Array.from({ length: beats }).map((_, b) => (
          <span key={b} className="text-zinc-400 text-sm leading-none select-none">
            ╱
          </span>
        ))}
      </div>
      {isEditing && (
        <BarEditor
          initialRaw={cellsToRaw(cells)}
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
  onCommit: (raw: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initialRaw);
  return (
    <div onClick={(e) => e.stopPropagation()} className="absolute -top-1 left-0 w-full z-10">
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onCommit(draft)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onCommit(draft);
          if (e.key === 'Escape') onCancel();
        }}
        placeholder="1   5 4   1 - 4 5"
        className="w-full text-[12px] font-bold text-center bg-yellow-100 border border-blue-500 rounded outline-none px-0.5 py-0.5"
      />
      <SplitPreview raw={draft} beats={beats} mode={mode} renderKey={renderKey} />
    </div>
  );
}

// Live carve of the bar as you type — shows each chord's beat span proportionally
// (width ∝ beats), so the terse `-` grammar is self-explaining. Blank = a single
// chord spanning the whole bar; with no `-`, chords split the bar evenly.
function SplitPreview({
  raw,
  beats,
  mode,
  renderKey,
}: {
  raw: string;
  beats: number;
  mode: 'numbers' | 'letters';
  renderKey: string;
}) {
  const cells = parseBar(raw);
  const slots = cells.reduce((n, c) => n + c.beats, 0); // tie-shares = explicit beats
  // Even split when no ties: each chord gets beats/count; otherwise honor shares.
  const even = cells.length > 0 && slots === cells.length;
  const tally = even
    ? `${cells.length} chord${cells.length > 1 ? 's' : ''}, even (${(beats / cells.length).toFixed(beats % cells.length ? 2 : 0)} beats each)`
    : `${slots} of ${beats} beats`;
  const off = !even && slots !== beats;
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
              style={{ flexGrow: even ? 1 : c.beats, flexBasis: 0 }}
              className="flex flex-col items-center justify-center bg-blue-600/25 border-x border-blue-500/40"
            >
              <span className="text-[11px] font-bold leading-none text-white">
                {renderToken(c.sym, mode, renderKey)}
              </span>
              <span className="text-[8px] leading-none text-blue-300/80">
                {even ? '·' : `${c.beats}b`}
              </span>
            </div>
          ))
        )}
      </div>
      <div className={`mt-0.5 text-center text-[9px] ${off ? 'text-amber-400' : 'text-zinc-500'}`}>
        {tally}
        {off && (slots < beats ? ' — last chord holds the rest' : ' — over the bar')}
      </div>
    </div>
  );
}

// ── Nashville token normalization (roman → number) ───────────────────────────
// Canonical storage is a numeric degree (1..7) + quality, so a chord typed in
// roman numerals is folded on commit (IV→4, IV7→47, vi→6m). Lowercase roman =
// functional-analysis minor → adds minor quality when none was given. Numeric
// input passes through unchanged. Quality and /bass ride along.
const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7 };

function normPart(s: string, allowQuality: boolean): string {
  const m = s.match(/^([b#]?)([IiVv]+|[1-7])(.*)$/);
  if (!m) return s;
  const [, acc, num, qualRaw] = m;
  let degree: number;
  let minorByCase = false;
  if (/^[1-7]$/.test(num)) {
    degree = Number(num);
  } else {
    const lower = num.toLowerCase();
    if (!(lower in ROMAN)) return s;
    degree = ROMAN[lower];
    minorByCase = num === lower; // all-lowercase roman = minor
  }
  let qual = qualRaw;
  if (minorByCase && qual === '' && allowQuality) qual = 'm';
  return `${acc}${degree}${qual}`;
}

// Normalize one chord token (main + optional /bass).
function normalizeToken(tok: string): string {
  const [main, bass] = tok.split('/');
  const head = normPart(main, true);
  return bass != null ? `${head}/${normPart(bass, false)}` : head;
}

// ── Nashville degree → letter, in a key (mock-grade) ─────────────────────────
const CHROM_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const CHROM_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10];

function keyRootPc(key: string): number {
  const k = key.replace(/m$/, '');
  let pc = LETTER_PC[k[0]] ?? 0;
  if (k[1] === '#') pc += 1;
  if (k[1] === 'b') pc -= 1;
  return (pc + 12) % 12;
}

function degreeLetter(degree: number, accidental: string, key: string): string {
  const steps = /m$/.test(key) ? MINOR_STEPS : MAJOR_STEPS;
  let pc = (keyRootPc(key) + steps[degree - 1]) % 12;
  if (accidental === '#') pc = (pc + 1) % 12;
  if (accidental === 'b') pc = (pc + 11) % 12;
  const names = /b/.test(key) || /^F/.test(key.replace(/m$/, '')) ? CHROM_FLAT : CHROM_SHARP;
  return names[pc];
}

// Render a (already-normalized, numeric) token for the chosen mode.
function renderToken(tok: string, mode: 'numbers' | 'letters', key: string): string {
  if (mode === 'numbers') return tok;
  const [main, bass] = tok.split('/');
  const m = main.match(/^([b#]?)([1-7])(.*)$/);
  if (!m) return tok;
  const [, acc, deg, qual] = m;
  let out = degreeLetter(Number(deg), acc, key) + qual;
  if (bass) {
    const bm = bass.match(/^([b#]?)([1-7])$/);
    if (bm) out += '/' + degreeLetter(Number(bm[2]), bm[1], key);
  }
  return out;
}
