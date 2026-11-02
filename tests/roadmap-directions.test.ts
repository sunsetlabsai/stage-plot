import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as V from '../lib/roadmap-view';
import { specToView, viewToSpec, setNote, setOpen, type ViewModel, type OpResult } from '../lib/roadmap-view';
import { validateRoadmapSpec, unprintableChars, NOTE_MAX, type RoadmapSection, type RoadmapSpec } from '../lib/roadmap-spec';
import { mergeRepeatedSections } from '../lib/roadmap-merge';
import { tallySpec } from '../lib/roadmap-authoring';
import { renderRoadmap, buildCalibration } from '../lib/roadmap-render';
import { layoutRoadmap, noteLineText, CONTENT_W, NOTE_LINE_H, SYSTEM_LABEL_H, PAGE_H } from '../lib/roadmap-layout';
import { assertSpecCalibrationParity } from '../lib/roadmap-save';

// docs/design-song-form-from-lyrics.md §2.4.3–2.4.5 — performance directions
// (`note`) and open sections (`open`) on RoadmapSection: chunk D.

function spec(sections: RoadmapSection[], extra: Partial<RoadmapSpec> = {}): RoadmapSpec {
  return { version: 1, timeSig: { beats: 4, unit: 4 }, renderKey: 'C', sections, ...extra };
}
const one = (bar = 1) => [{ bar, chords: [{ degree: 1 }] }];
const split = () => [{ bar: 1, chords: [{ degree: 1, beats: 2 }, { degree: 4, beats: 2 }] }];
const errorsOf = (s: RoadmapSpec) => {
  const v = validateRoadmapSpec(s);
  return v.ok ? [] : v.errors;
};

describe('validateRoadmapSpec — note + open', () => {
  it('accepts a note, an open section, and both together', () => {
    expect(errorsOf(spec([{ id: 'a', label: 'Solo', bars: 8, open: true, note: 'until keys signal' }]))).toEqual([]);
    expect(errorsOf(spec([{ id: 'a', label: 'Chorus', bars: 8, note: '(CLAPS)' }]))).toEqual([]);
    expect(errorsOf(spec([{ id: 'a', label: 'Vamp', bars: 4, open: true }]))).toEqual([]);
  });

  it('accepts a note exactly NOTE_MAX long and rejects one longer', () => {
    expect(errorsOf(spec([{ id: 'a', label: 'X', bars: 1, note: 'a'.repeat(NOTE_MAX) }]))).toEqual([]);
    expect(errorsOf(spec([{ id: 'a', label: 'X', bars: 1, note: 'a'.repeat(NOTE_MAX + 1) }])).join()).toMatch(/at most 52/);
  });

  it('rejects an empty, blank, untrimmed or non-string note', () => {
    for (const note of ['', '   ', ' lead', 'lead ', 7]) {
      expect(errorsOf(spec([{ id: 'a', label: 'X', bars: 1, note } as unknown as RoadmapSection])).join()).toMatch(/note must be/);
    }
  });

  it('rejects a note the PDF font cannot print, naming the character', () => {
    expect(errorsOf(spec([{ id: 'a', label: 'X', bars: 1, note: 'SOLO → KEYS' }])).join()).toMatch(/can't print →/);
    expect(errorsOf(spec([{ id: 'a', label: 'X', bars: 1, note: 'café — “loud” • 2×' }]))).toEqual([]);
  });

  it('rejects open other than true', () => {
    for (const open of [false, 'yes', 1]) {
      expect(errorsOf(spec([{ id: 'a', label: 'X', bars: 1, open } as unknown as RoadmapSection])).join()).toMatch(/open must be true/);
    }
  });

  it('rejects open with a plain repeat and with endings', () => {
    const plain: RoadmapSection = { id: 'a', label: 'X', bars: 4, open: true, repeat: { kind: 'plain', times: 2 } };
    const volta: RoadmapSection = {
      id: 'a', label: 'X', bars: 4, open: true,
      repeat: { kind: 'volta', endings: [{ bars: { start: 3, count: 1 }, passes: [1] }, { bars: { start: 4, count: 1 }, passes: [2] }] },
    };
    expect(errorsOf(spec([plain])).join()).toMatch(/open section can't also have a repeat/);
    expect(errorsOf(spec([volta])).join()).toMatch(/open section can't also have a repeat/);
  });

  it('the printable set is exactly what pdf-lib Helvetica encodes', async () => {
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    for (let c = 0x20; c <= 0x2122; c += 1) {
      const ch = String.fromCodePoint(c);
      let encodes = true;
      try { font.encodeText(ch); } catch { encodes = false; }
      // 0x7F–0x9F are control codes; never printable even where pdf-lib maps them.
      if (c >= 0x7f && c <= 0x9f) continue;
      expect([ch, unprintableChars(ch).length === 0]).toEqual([ch, encodes]);
    }
  });

  it('NOTE_MAX holds on the worst-case glyph: no direction line can pass the content width', async () => {
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    let widest = '';
    let w = 0;
    for (let c = 0x20; c <= 0x2122; c += 1) {
      const ch = String.fromCodePoint(c);
      if (unprintableChars(ch).length > 0) continue;
      const cw = font.widthOfTextAtSize(ch, 9);
      if (cw > w) { w = cw; widest = ch; }
    }
    const line = noteLineText({ open: true, note: widest.repeat(NOTE_MAX) })!;
    expect(font.widthOfTextAtSize(line, 9)).toBeLessThanOrEqual(CONTENT_W);
  });
});

describe('view model — the §2.4.5 property: every op keeps note + open', () => {
  // A fixture where every section carries a direction: an open one, a repeating
  // one, and a plain one. Every op runs on each section it applies to.
  const base = spec(
    [
      { id: 'i', label: 'Intro', bars: 4, changes: split(), note: 'quiet' },
      { id: 's', label: 'Solo', bars: 8, changes: split(), open: true, note: 'until keys signal' },
      { id: 'c', label: 'Chorus', bars: 4, changes: split(), note: '(CLAPS)', repeat: { kind: 'plain', times: 2 } },
      { id: 'o', label: 'Outro', bars: 4, changes: split() },
    ],
    { navigation: { segno: { section: 0, bar: 1 } } },
  );
  const NOTES: Record<string, string | undefined> = { i: 'quiet', s: 'until keys signal', c: '(CLAPS)', o: undefined };
  const OPEN: Record<string, boolean> = { i: false, s: true, c: false, o: false };

  // Every OpResult-returning export, by name. The guard test below fails when an
  // op is added to roadmap-view without a row here, so a seventh rebuild site
  // can't slip past the property.
  type Case = { op: string; run: (v: ViewModel) => OpResult; refused?: RegExp };
  const CASES: Case[] = [];
  for (const id of ['i', 's', 'c', 'o']) {
    CASES.push(
      { op: 'splitBar', run: (v) => V.splitBar(v, id, 1) },
      { op: 'insertBar', run: (v) => V.insertBar(v, id, 2, 'after') },
      { op: 'deleteBar', run: (v) => V.deleteBar(v, id, 2) },
      { op: 'setBarCount', run: (v) => V.setBarCount(v, id, 6) },
      { op: 'setNote', run: (v) => V.setNote(v, id, NOTES[id] ?? '') },
      { op: 'setOpen', run: (v) => V.setOpen(v, id, OPEN[id]) },
      { op: 'setMarker', run: (v) => V.setMarker(v, id, 2, 'fine') },
      { op: 'setJump', run: (v) => V.setJump(v, id, 4, { from: 'capo', until: 'end' }) },
    );
  }
  CASES.push(
    { op: 'removeSection', run: (v) => V.removeSection(v, 'o') },
    { op: 'removeMarker', run: (v) => V.removeMarker(v, 'segno') },
    { op: 'setPlainRepeat', run: (v) => V.setPlainRepeat(v, 'c', 3) },
    { op: 'setPlainRepeat', run: (v) => V.setPlainRepeat(v, 'c', null) },
    { op: 'setPlainRepeat', run: (v) => V.setPlainRepeat(v, 'i', 2) },
    { op: 'setPlainRepeat', run: (v) => V.setPlainRepeat(v, 's', 2), refused: /open section/ },
    { op: 'unrollRepeat', run: (v) => V.unrollRepeat(v, 'c') },
    { op: 'addEndings', run: (v) => V.addEndings(v, 'c', 1) },
    { op: 'addEndings', run: (v) => V.addEndings(v, 'i', 1) },
    { op: 'addEndings', run: (v) => V.addEndings(v, 's', 1), refused: /open section/ },
    { op: 'removeEndings', run: (v) => {
      const r = V.addEndings(v, 'c', 1);
      if (!r.ok) throw new Error(r.reason);
      return V.removeEndings(r.view, 'c');
    } },
    { op: 'setOpen', run: (v) => V.setOpen(v, 'c', true), refused: /repeating section/ },
  );

  it('the case table covers every OpResult op roadmap-view exports', () => {
    const NOT_OPS = new Set([
      'parseBarInput', 'cellsToRaw', 'cellsToChordHits', 'chordHitsToCells', 'specToView', 'viewToSpec',
      'markerOptions', 'markersAt', 'markerLabel', 'degreeLetter', 'parseLetterChord', 'renderCell',
    ]);
    const exported = Object.entries(V).filter(([, f]) => typeof f === 'function').map(([n]) => n).filter((n) => !NOT_OPS.has(n));
    expect(new Set(CASES.map((c) => c.op))).toEqual(new Set(exported));
  });

  it.each(CASES.map((c, n) => [`${c.op} #${n}`, c] as const))('%s', (_name, c) => {
    const view = specToView(base);
    const r = c.run(view);
    if (c.refused) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(c.refused);
      return;
    }
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Every surviving section — copies made by unroll included — carries its
    // source section's direction, and the spec round-trip keeps it.
    const out = viewToSpec(r.view);
    expect(validateRoadmapSpec(out).ok).toBe(true);
    for (const sec of out.sections) {
      const src = sec.id.split('-')[0];
      expect([sec.id, sec.note]).toEqual([sec.id, NOTES[src]]);
      expect([sec.id, sec.open === true]).toEqual([sec.id, OPEN[src]]);
    }
  });
});

describe('view model — setNote / setOpen', () => {
  const v = specToView(spec([{ id: 'a', label: 'Solo', bars: 8, changes: one() }]));
  const ok = (r: OpResult) => {
    if (!r.ok) throw new Error(r.reason);
    return viewToSpec(r.view).sections[0];
  };

  it('trims, sets and clears a note', () => {
    expect(ok(setNote(v, 'a', '  until keys signal ')).note).toBe('until keys signal');
    const noted = setNote(v, 'a', 'x');
    if (!noted.ok) throw new Error();
    expect('note' in ok(setNote(noted.view, 'a', '   '))).toBe(false);
  });

  it('refuses an over-long or unprintable note rather than truncating it', () => {
    const long = setNote(v, 'a', 'a'.repeat(NOTE_MAX + 1));
    expect(long.ok).toBe(false);
    const arrow = setNote(v, 'a', 'SOLO → KEYS');
    expect(arrow.ok).toBe(false);
    if (!arrow.ok) expect(arrow.reason).toMatch(/→/);
  });

  it('sets and clears open', () => {
    const opened = setOpen(v, 'a', true);
    expect(ok(opened).open).toBe(true);
    if (!opened.ok) throw new Error();
    expect('open' in ok(setOpen(opened.view, 'a', false))).toBe(false);
  });

  it('spec → view → spec keeps both fields exactly', () => {
    const s = spec([
      { id: 'a', label: 'Solo', bars: 8, changes: one(), open: true, note: 'until keys signal' },
      { id: 'b', label: 'Chorus', bars: 4, changes: one(), note: '(CLAPS)' },
    ]);
    expect(viewToSpec(specToView(s))).toEqual(s);
  });
});

describe('merge — §2.4.5 pairs stay separate', () => {
  const chorus = (id: string, extra: Partial<RoadmapSection> = {}): RoadmapSection => ({ id, label: 'Chorus', bars: 8, changes: one(), ...extra });

  it('closed + open, open + open, and different notes never merge', () => {
    for (const pair of [
      [chorus('a'), chorus('b', { open: true })],
      [chorus('a', { open: true }), chorus('b', { open: true })],
      [chorus('a', { note: 'soft' }), chorus('b', { note: 'loud' })],
      [chorus('a', { note: 'soft' }), chorus('b')],
    ]) {
      expect(mergeRepeatedSections(spec(pair)).sections).toHaveLength(2);
    }
  });

  it('same note merges into ×2 and keeps it; no notes still merge as before', () => {
    const noted = mergeRepeatedSections(spec([chorus('a', { note: 'claps' }), chorus('b', { note: 'claps' })]));
    expect(noted.sections).toEqual([chorus('a', { note: 'claps', repeat: { kind: 'plain', times: 2 } })]);
    expect(mergeRepeatedSections(spec([chorus('a'), chorus('b')])).sections).toHaveLength(1);
  });
});

describe('tallySpec — open reads as a minimum', () => {
  it('prints 8+ bars for an open section and 8 bars otherwise', () => {
    const t = tallySpec(spec([
      { id: 'a', label: 'Solo', bars: 8, changes: one(), open: true },
      { id: 'b', label: 'Chorus', bars: 8, changes: one() },
    ]));
    expect(t[0]).toMatch(/^Solo: 8\+ bars/);
    expect(t[1]).toMatch(/^Chorus: 8 bars/);
  });
});

describe('layout + render — the direction line', () => {
  // Hashes of main's renderer (22dd9de) on charts with no note/open: every
  // existing chart must lay out and print byte-identically.
  const GOLDEN: [string, RoadmapSpec, string, string][] = [
    ['linear', spec([
      { id: 'intro', label: 'Intro', bars: 4, changes: [{ bar: 1, chords: [{ degree: 1 }] }] },
      { id: 'verse', label: 'Verse', bars: 8 },
    ], { renderKey: 'G', barsPerLine: 4 }),
    'd3284db386d48d5112ec3cf1ad4c584225967207fe2c5facab142b482bd6d690', 'f1c4df9141a0a37d50c2cfb4fc04bec333efcc27eeae27fc9c80a9b8acb077c5'],
    ['nav', spec([
      { id: 'intro', label: 'Intro', bars: 4 },
      { id: 'verse', label: 'Verse', bars: 8, repeat: { kind: 'plain', times: 2 } },
      { id: 'chorus', label: 'Chorus', bars: 8, repeat: { kind: 'volta', endings: [
        { bars: { start: 7, count: 1 }, passes: [1] }, { bars: { start: 8, count: 1 }, passes: [2] }] } },
    ], { renderKey: 'Bb', navigation: { segno: { section: 1, bar: 1 }, jump: { at: { section: 2, bar: 8 }, from: 'segno', until: 'end' } } }),
    'b22ebe2b87bd7e3c9567dee1710e044918b29105dbf84cd01c04acb978bdc11f', '7b592c5f6198f60cdfd253962ca0b8db8c785683eb529994d660224621f8a17c'],
    ['long', { version: 1, timeSig: { beats: 3, unit: 4 }, renderKey: 'D', sections: Array.from({ length: 14 }, (_, i) => ({
      id: `s${i}`, label: `Section ${i + 1}`, bars: 8, changes: [{ bar: 1, chords: [{ degree: (i % 6) + 1 }] }] })) },
    '2d8885cdab9a73c285fbfd19502a4dfe8ede51910b6801ed92ea8eade82e618e', '558d52db22fd68f1c1fa6ffd28b61ad2bfb7d4229b74f7c538aad1bb43cf4937'],
  ];
  const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

  it.each(GOLDEN)('a chart with no direction prints byte-identically to before (%s)', async (_n, s, pdfHash, calHash) => {
    const { pdfBytes, calibration } = await renderRoadmap(s, { songTitle: 'Song' });
    expect(sha(pdfBytes)).toBe(pdfHash);
    expect(sha(JSON.stringify(calibration))).toBe(calHash);
  });

  it('a direction changes the PDF (positive control for the hashes above)', async () => {
    const s = structuredClone(GOLDEN[0][1]);
    s.sections[1].note = 'until keys signal';
    expect(sha((await renderRoadmap(s, { songTitle: 'Song' })).pdfBytes)).not.toBe(GOLDEN[0][2]);
  });

  it('only the noted section\'s first system grows, by NOTE_LINE_H', () => {
    const plain = spec([
      { id: 'a', label: 'Intro', bars: 4 },
      { id: 'b', label: 'Solo', bars: 8, open: true, note: 'until keys signal' },
      { id: 'c', label: 'Chorus', bars: 4 },
    ], { barsPerLine: 4 });
    const bare = structuredClone(plain);
    delete bare.sections[1].note;
    delete bare.sections[1].open;
    const a = layoutRoadmap(plain);
    const b = layoutRoadmap(bare);
    const dy = NOTE_LINE_H / PAGE_H;
    expect(a.systems.map((s) => s.noteLine)).toEqual([null, 'OPEN · until keys signal', null, null]);
    expect(a.systems[0]).toEqual(b.systems[0]);
    expect(a.systems[1].yTop - a.systems[1].labelYTop).toBeCloseTo((SYSTEM_LABEL_H + NOTE_LINE_H) / PAGE_H, 12);
    for (const i of [1, 2, 3]) expect(a.systems[i].yTop).toBeCloseTo(b.systems[i].yTop + dy, 12);
  });

  it('with a direction, the calibration is the layout and passes the save parity check', async () => {
    const s = spec([
      { id: 'a', label: 'Intro', bars: 4, note: 'quiet' },
      { id: 'b', label: 'Solo', bars: 8, open: true, note: 'until keys signal' },
      { id: 'c', label: 'Chorus', bars: 8, note: '(CLAPS)', repeat: { kind: 'plain', times: 2 } },
    ]);
    const layout = layoutRoadmap(s);
    const { calibration } = await renderRoadmap(s);
    expect(calibration).toEqual(buildCalibration(s, layout));
    expect(calibration.systems!.map((y) => [y.id, y.yTop, y.yBottom])).toEqual(
      layout.systems.map((y) => [y.id, y.yTop, y.yBottom]),
    );
    expect(calibration.sections).toEqual(layout.sections);
    expect(assertSpecCalibrationParity(s, calibration).ok).toBe(true);
  });

  it('noteLineText: OPEN · note, note, OPEN, or nothing', () => {
    expect(noteLineText({ open: true, note: 'x' })).toBe('OPEN · x');
    expect(noteLineText({ note: 'x' })).toBe('x');
    expect(noteLineText({ open: true })).toBe('OPEN');
    expect(noteLineText({})).toBeNull();
  });
});
