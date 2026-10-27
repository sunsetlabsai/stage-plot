import { describe, it, expect } from 'vitest';
import {
  specToView,
  viewToSpec,
  splitBar,
  insertBar,
  deleteBar,
  setBarCount,
  removeSection,
  type ViewModel,
  type ViewNavigation,
  type ViewBar,
  type OpResult,
} from '../lib/roadmap-view';
import { validateRoadmapSpec, type RoadmapSpec, type ChordHit } from '../lib/roadmap-spec';
import { navLive } from '../lib/roadmap-calibration';

// design-roadmap-structure-editing.md §3 / §5.3 / §6 — the structure-edit op layer.

const h = (degree: number, beats?: number): ChordHit => (beats ? { degree, beats } : { degree });

function view(spec: RoadmapSpec): ViewModel {
  const v = validateRoadmapSpec(spec);
  if (!v.ok) throw new Error(`fixture invalid: ${v.errors.join('; ')}`);
  return specToView(spec);
}

function applied(r: OpResult): Extract<OpResult, { ok: true }> {
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r;
}

const sec = (v: ViewModel, id: string) => v.sections.find((s) => s.id === id)!;
// Bar contents as degree lists (null = blank) — the shape the assertions read.
const degrees = (v: ViewModel, id: string) => sec(v, id).chords.map((b) => (b ? b.map((c) => c.degree) : null));

function expectValid(v: ViewModel) {
  const r = validateRoadmapSpec(viewToSpec(v));
  expect(r.ok ? [] : r.errors).toEqual([]);
}

// Verse ×2 with a split first bar; a Chorus holding the Fine; D.C. al Fine on the Outro.
const PLAIN: RoadmapSpec = {
  version: 1,
  timeSig: { beats: 4, unit: 4 },
  renderKey: 'D',
  sections: [
    { id: 'intro', label: 'Intro', bars: 2, changes: [{ bar: 1, chords: [h(1)] }] },
    {
      id: 'verse',
      label: 'Verse',
      bars: 4,
      repeat: { kind: 'plain', times: 2 },
      changes: [
        { bar: 1, chords: [h(2), h(3)] },
        { bar: 2, chords: [h(5)] },
        { bar: 4, chords: [h(1)] },
      ],
    },
    {
      id: 'chorus',
      label: 'Chorus',
      bars: 4,
      changes: [
        { bar: 1, chords: [h(4)] },
        { bar: 3, chords: [h(1, 2), h(4, 1), h(5, 1)] },
      ],
    },
    { id: 'outro', label: 'Outro', bars: 2, changes: [{ bar: 1, chords: [h(1)] }] },
  ],
  navigation: {
    fine: { section: 2, bar: 4 },
    jump: { at: { section: 3, bar: 2 }, from: 'capo', until: 'fine' },
  },
};

// A volta Verse whose endings are listed OUT of position order (2nd ending first),
// with To Coda in its body, a Segno in the Intro, and D.S. al Coda on the Bridge.
const VOLTA: RoadmapSpec = {
  version: 1,
  timeSig: { beats: 4, unit: 4 },
  renderKey: 'G',
  sections: [
    { id: 'intro', label: 'Intro', bars: 2, changes: [{ bar: 2, chords: [h(1)] }] },
    {
      id: 'verse',
      label: 'Verse',
      bars: 5,
      repeat: {
        kind: 'volta',
        endings: [
          { bars: { start: 5, count: 1 }, passes: [2] },
          { bars: { start: 3, count: 2 }, passes: [1] },
        ],
      },
      changes: [
        { bar: 1, chords: [h(1), h(4)] },
        { bar: 2, chords: [h(6)] },
        { bar: 3, chords: [h(2), h(5)] },
        { bar: 5, chords: [h(1)] },
      ],
    },
    { id: 'bridge', label: 'Bridge', bars: 2, changes: [{ bar: 1, chords: [h(4), h(5)] }] },
    { id: 'coda', label: 'Coda', bars: 2, changes: [{ bar: 1, chords: [h(1)] }] },
  ],
  navigation: {
    segno: { section: 0, bar: 2 },
    toCoda: { section: 1, bar: 2 },
    coda: { section: 3, bar: 1 },
    jump: { at: { section: 2, bar: 2 }, from: 'segno', until: 'coda' },
  },
};

// No navigation: the `C, G, blank` bar run (§5.3) plus split-able bars.
const PLAIN_BARS: RoadmapSpec = {
  version: 1,
  timeSig: { beats: 4, unit: 4 },
  renderKey: 'C',
  sections: [
    {
      id: 'verse',
      label: 'Verse',
      bars: 3,
      changes: [
        { bar: 1, chords: [h(1)] },
        { bar: 2, chords: [h(5)] },
      ],
    },
    {
      id: 'chorus',
      label: 'Chorus',
      bars: 3,
      changes: [
        { bar: 1, chords: [h(4), h(5)] },
        { bar: 2, chords: [h(1, 3), h(5, 1)] },
      ],
    },
  ],
};

// Every marker on a multi-chord bar, so the random walk splits marker bars (the
// start-edge → first / end-edge → last rule is otherwise unexercised: inserted bars
// are blank, and no op writes chords).
const MARKERS_ON_SPLITS: RoadmapSpec = {
  version: 1,
  timeSig: { beats: 4, unit: 4 },
  renderKey: 'E',
  sections: [
    { id: 'a', label: 'Intro', bars: 2, changes: [{ bar: 1, chords: [h(1), h(5)] }] },
    {
      id: 'b',
      label: 'Verse',
      bars: 3,
      repeat: { kind: 'plain', times: 2 },
      changes: [
        { bar: 2, chords: [h(4), h(5)] },
        { bar: 3, chords: [h(1, 2), h(6, 1), h(5, 1)] },
      ],
    },
    {
      id: 'c',
      label: 'Coda',
      bars: 2,
      changes: [
        { bar: 1, chords: [h(2), h(5)] },
        { bar: 2, chords: [h(1), h(4)] },
      ],
    },
  ],
  navigation: {
    segno: { section: 0, bar: 1 },
    toCoda: { section: 1, bar: 2 },
    coda: { section: 2, bar: 1 },
    fine: { section: 2, bar: 2 },
    jump: { at: { section: 1, bar: 3 }, from: 'segno', until: 'coda' },
  },
};

// Codex PR B R1: D.C. on the FIRST bar of a two-bar 1st ending. Live as written
// (pass 1 plays bar 2 and the D.C. fires mid-ending). Delete the unmarked bar 3 and
// bar 2 becomes the ending's last bar: the volta exit pre-empts the D.C. on pass 1,
// pass 2 skips the ending — the D.C. never fires. Every reference still lands.
const DC_IN_ENDING: RoadmapSpec = {
  version: 1,
  timeSig: { beats: 4, unit: 4 },
  renderKey: 'A',
  sections: [
    {
      id: 'verse',
      label: 'Verse',
      bars: 4,
      repeat: {
        kind: 'volta',
        endings: [
          { bars: { start: 2, count: 2 }, passes: [1] },
          { bars: { start: 4, count: 1 }, passes: [2] },
        ],
      },
      changes: [
        { bar: 1, chords: [h(1)] },
        { bar: 2, chords: [h(4), h(5)] },
        { bar: 4, chords: [h(1)] },
      ],
    },
    { id: 'outro', label: 'Outro', bars: 2, changes: [{ bar: 1, chords: [h(5)] }] },
  ],
  navigation: { jump: { at: { section: 0, bar: 2 }, from: 'capo', until: 'end' } },
};

describe('navLive — §3 second rule', () => {
  it('is live for every fixture as written', () => {
    for (const f of [PLAIN, VOLTA, PLAIN_BARS, MARKERS_ON_SPLITS, DC_IN_ENDING]) expect(navLive(f)).toEqual({ live: true });
  });

  it('is dead when the D.C. sits on the last bar of a 1st ending (the exit pre-empts it)', () => {
    const dead = viewToSpec(
      (() => {
        const v = view(DC_IN_ENDING);
        // Same chart with bar 3 gone, built by hand — no op, so no gate.
        const s = v.sections[0];
        return {
          ...v,
          sections: [
            {
              ...s,
              bars: 3,
              chords: [s.chords[0], s.chords[1], s.chords[3]],
              repeat: {
                kind: 'volta' as const,
                endings: [
                  { bars: { start: 2, count: 1 }, passes: [1] },
                  { bars: { start: 3, count: 1 }, passes: [2] },
                ],
              },
            },
            v.sections[1],
          ],
        };
      })(),
    );
    expect(validateRoadmapSpec(dead).ok).toBe(true); // valid — only the walk can see it
    expect(navLive(dead)).toEqual({ live: false, dead: 'jump' });
  });

  it('is dead when al Coda fires but the Coda sits in an ending the walk now skips (Codex R5 shape)', () => {
    const spec: RoadmapSpec = {
      version: 1,
      timeSig: { beats: 4, unit: 4 },
      renderKey: 'C',
      sections: [
        { id: 'intro', label: 'Intro', bars: 2 },
        {
          id: 'verse',
          label: 'Verse',
          bars: 3,
          repeat: {
            kind: 'volta',
            endings: [
              { bars: { start: 2, count: 1 }, passes: [1] },
              { bars: { start: 3, count: 1 }, passes: [2] },
            ],
          },
        },
        { id: 'outro', label: 'Outro', bars: 2 },
      ],
      navigation: {
        toCoda: { section: 0, bar: 2 },
        coda: { section: 1, bar: 2 },
        jump: { at: { section: 2, bar: 2 }, from: 'capo', until: 'coda' },
      },
    };
    expect(validateRoadmapSpec(spec).ok).toBe(true);
    // toCodaFired flips, but the next bar played is not the Coda bar.
    expect(navLive(spec)).toEqual({ live: false, dead: 'toCoda' });
  });
});

describe('the liveness gate on ops', () => {
  it('refuses Codex’s repro: deleting the unmarked bar that would silence the D.C.', () => {
    expect(deleteBar(view(DC_IN_ENDING), 'verse', 3)).toEqual({
      ok: false,
      reason: 'this would stop the D.C. from being played — move it first',
    });
  });

  it('allows the same delete when the D.C. is outside the section', () => {
    const v = view({
      ...DC_IN_ENDING,
      navigation: { jump: { at: { section: 1, bar: 2 }, from: 'capo', until: 'end' } },
    });
    expect(deleteBar(v, 'verse', 3).ok).toBe(true);
  });

  it('gates the bar-count field on its END state, not each step on the way', () => {
    // Shrinking the Verse to 2 bars deletes bars 4 then 3: the endings go (confirmed),
    // and the D.C. on bar 2 plays again — live at the end, so allowed.
    const r = applied(setBarCount(view(DC_IN_ENDING), 'verse', 2));
    expect(r.removes).toEqual(['the 2 endings']);
    expect(navLive(viewToSpec(r.view))).toEqual({ live: true });
  });

  it('does not block edits on a chart that was already not live', () => {
    const v = view(DC_IN_ENDING);
    const dead = applied(setBarCount(v, 'outro', 3)).view; // harmless warm-up
    // Hand-break it (no gate), then edit elsewhere.
    const s = dead.sections[0];
    const broken: ViewModel = {
      ...dead,
      sections: [
        {
          ...s,
          bars: 3,
          chords: [s.chords[0], s.chords[1], s.chords[3]],
          repeat: {
            kind: 'volta',
            endings: [
              { bars: { start: 2, count: 1 }, passes: [1] },
              { bars: { start: 3, count: 1 }, passes: [2] },
            ],
          },
        },
        dead.sections[1],
      ],
    };
    expect(navLive(viewToSpec(broken)).live).toBe(false);
    expect(insertBar(broken, 'outro', 1, 'after').ok).toBe(true);
  });
});

describe('splitBar', () => {
  it('turns `D E` into `D | E`, each chord a whole bar', () => {
    const r = applied(splitBar(view(PLAIN), 'verse', 1));
    expect(degrees(r.view, 'verse')).toEqual([[2], [3], [5], null, [1]]);
    expect(sec(r.view, 'verse').chords[0]![0].beats).toBe(4);
    expect(sec(r.view, 'verse').chords[1]![0].beats).toBe(4);
    expect(r.removes).toEqual([]);
    expectValid(r.view);
  });

  it('splits an uneven bar into one bar per chord', () => {
    const r = applied(splitBar(view(PLAIN), 'chorus', 3));
    expect(degrees(r.view, 'chorus')).toEqual([[4], null, [1], [4], [5], null]);
    // The Fine was on bar 4, after the split bar — it follows its bar to 6.
    expect(r.view.navigation?.fine).toEqual({ sectionId: 'chorus', bar: 6 });
  });

  it('is refused on a one-chord or blank bar', () => {
    expect(splitBar(view(PLAIN), 'verse', 2)).toEqual({ ok: false, reason: expect.stringMatching(/two or more chords/) });
    expect(splitBar(view(PLAIN), 'verse', 3).ok).toBe(false);
  });

  it('sends a start-edge marker to the FIRST new bar and an end-edge one to the LAST', () => {
    const v = view(VOLTA);
    // Put the Segno (start edge) and To Coda (end edge) on the same split-able bar.
    v.navigation = { ...v.navigation!, segno: { sectionId: 'verse', bar: 1 }, toCoda: { sectionId: 'verse', bar: 1 } };
    const r = applied(splitBar(v, 'verse', 1));
    expect(r.view.navigation?.segno).toEqual({ sectionId: 'verse', bar: 1 });
    expect(r.view.navigation?.toCoda).toEqual({ sectionId: 'verse', bar: 2 });
    expectValid(r.view);
  });

  it('keeps a split ending bar inside its ending, and grows the ending', () => {
    const r = applied(splitBar(view(VOLTA), 'verse', 3));
    const rep = sec(r.view, 'verse').repeat;
    expect(rep).toEqual({
      kind: 'volta',
      endings: [
        { bars: { start: 6, count: 1 }, passes: [2] },
        { bars: { start: 3, count: 3 }, passes: [1] },
      ],
    });
    expectValid(r.view);
  });
});

describe('insertBar', () => {
  it('inserts a BLANK bar; before moves the bar (and its marker) right, after leaves it', () => {
    const before = applied(insertBar(view(PLAIN), 'chorus', 4, 'before'));
    expect(degrees(before.view, 'chorus')).toEqual([[4], null, [1, 4, 5], null, null]);
    expect(before.view.navigation?.fine).toEqual({ sectionId: 'chorus', bar: 5 });
    const after = applied(insertBar(view(PLAIN), 'chorus', 4, 'after'));
    expect(after.view.navigation?.fine).toEqual({ sectionId: 'chorus', bar: 4 });
    expectValid(before.view);
    expectValid(after.view);
  });

  it('a new bar joins the group of the bar it was inserted relative to', () => {
    // Before the 1st ending's first bar (bar 3) → joins the 1st ending, not the body.
    const r = applied(insertBar(view(VOLTA), 'verse', 3, 'before'));
    expect(sec(r.view, 'verse').repeat).toEqual({
      kind: 'volta',
      endings: [
        { bars: { start: 6, count: 1 }, passes: [2] },
        { bars: { start: 3, count: 3 }, passes: [1] },
      ],
    });
    // After the last body bar (bar 2) → joins the body; both endings shift right.
    const b = applied(insertBar(view(VOLTA), 'verse', 2, 'after'));
    expect(sec(b.view, 'verse').repeat).toEqual({
      kind: 'volta',
      endings: [
        { bars: { start: 6, count: 1 }, passes: [2] },
        { bars: { start: 4, count: 2 }, passes: [1] },
      ],
    });
    expectValid(r.view);
    expectValid(b.view);
  });
});

describe('deleteBar', () => {
  it('`C, G, blank` minus the G is `C, blank` — no chord moves into the blank', () => {
    const r = applied(deleteBar(view(PLAIN_BARS), 'verse', 2));
    expect(degrees(r.view, 'verse')).toEqual([[1], null]);
    expect(r.removes).toEqual([]);
  });

  it('is refused on the section’s only bar', () => {
    const one = view({ ...PLAIN_BARS, sections: [{ id: 'x', label: 'Tag', bars: 1 }] });
    expect(deleteBar(one, 'x', 1)).toEqual({ ok: false, reason: expect.stringMatching(/at least one bar/) });
  });

  it('is refused on the last body bar of a volta section', () => {
    const r = applied(deleteBar(view(VOLTA), 'verse', 1));
    expect(sec(r.view, 'verse').repeat).toEqual({
      kind: 'volta',
      endings: [
        { bars: { start: 4, count: 1 }, passes: [2] },
        { bars: { start: 2, count: 2 }, passes: [1] },
      ],
    });
    // Bar 1 is now the To Coda bar AND the only body bar.
    expect(deleteBar(r.view, 'verse', 1)).toEqual({
      ok: false,
      reason: 'the repeat needs a bar before its endings — remove the endings first',
    });
  });

  it('a marker on the deleted bar is removed with its dependents, and named', () => {
    // To Coda sits on Verse bar 2; the D.S. al Coda needs it.
    const r = applied(deleteBar(view(VOLTA), 'verse', 2));
    expect(r.removes).toEqual(['the To Coda', 'the D.S. al Coda']);
    expect(r.view.navigation).toEqual({ segno: { sectionId: 'intro', bar: 2 }, coda: { sectionId: 'coda', bar: 1 } });
    // The rest of the navigation survives the save — not the old "drop the whole block".
    expect(viewToSpec(r.view).navigation).toEqual({ segno: { section: 0, bar: 2 }, coda: { section: 3, bar: 1 } });
    expectValid(r.view);
  });

  it('removing the Coda takes the To Coda and an al-Coda jump with it', () => {
    const r = applied(deleteBar(view(VOLTA), 'coda', 1));
    expect(r.removes).toEqual(['the Coda', 'the To Coda', 'the D.S. al Coda']);
    expect(r.view.navigation).toEqual({ segno: { sectionId: 'intro', bar: 2 } });
    expectValid(r.view);
  });

  it('deleting the only bar of an ending removes the endings', () => {
    const r = applied(deleteBar(view(VOLTA), 'verse', 5));
    expect(r.removes).toEqual(['the 2 endings']);
    expect(sec(r.view, 'verse').repeat).toBeUndefined();
    expect(sec(r.view, 'verse').bars).toBe(4);
    expectValid(r.view);
  });

  it('leaving a plain repeat at 1 bar drops the repeat', () => {
    const two = view({
      ...PLAIN_BARS,
      sections: [{ id: 'v', label: 'Vamp', bars: 2, repeat: { kind: 'plain', times: 3 } }],
    });
    const r = applied(deleteBar(two, 'v', 2));
    expect(r.removes).toEqual(['the ×3 repeat']);
    expect(sec(r.view, 'v').repeat).toBeUndefined();
    expectValid(r.view);
  });

  it('a marker AFTER the deleted bar shifts left with its bar', () => {
    const r = applied(deleteBar(view(PLAIN), 'chorus', 2));
    expect(r.view.navigation?.fine).toEqual({ sectionId: 'chorus', bar: 3 });
    expect(r.removes).toEqual([]);
  });
});

describe('setBarCount — the bar-count field through the same ops', () => {
  it('grows with blank bars at the end', () => {
    const r = applied(setBarCount(view(PLAIN_BARS), 'verse', 5));
    expect(degrees(r.view, 'verse')).toEqual([[1], [5], null, null, null]);
  });

  it('closes the nav-shrink edge: shrinking past the Fine removes it (and the al Fine) instead of an invalid save', () => {
    const r = applied(setBarCount(view(PLAIN), 'chorus', 2));
    expect(r.removes).toEqual(['the Fine', 'the D.C. al Fine']);
    expect(r.view.navigation).toBeUndefined();
    expectValid(r.view);
  });

  it('shrinking ahead of a marker keeps it', () => {
    const v = view(PLAIN);
    const r = applied(setBarCount(v, 'outro', 3));
    expect(r.view.navigation?.jump?.at).toEqual({ sectionId: 'outro', bar: 2 });
    const back = applied(setBarCount(r.view, 'outro', 2));
    expect(back.removes).toEqual([]);
  });

  it('shrinking a volta section from the end takes the endings first, then what its bars held', () => {
    // Verse: body 1-2, endings 3-4 and 5. Deleting from the end empties the 2nd
    // ending before any body bar is reached, so the body refusal never fires here.
    const r = applied(setBarCount(view(VOLTA), 'verse', 1));
    expect(r.removes).toEqual(['the 2 endings', 'the To Coda', 'the D.S. al Coda']);
    expect(sec(r.view, 'verse').repeat).toBeUndefined();
    expectValid(r.view);
  });

  it('refuses fewer than one bar', () => {
    expect(setBarCount(view(VOLTA), 'verse', 0)).toEqual({ ok: false, reason: 'a section needs at least one bar' });
    expect(setBarCount(view(VOLTA), 'verse', Number.NaN).ok).toBe(false);
  });
});

describe('removeSection', () => {
  it('names the markers it takes and keeps the rest (no silent whole-block drop)', () => {
    const r = applied(removeSection(view(VOLTA), 'intro'));
    expect(r.removes).toEqual(['the Segno', 'the D.S. al Coda']);
    expect(viewToSpec(r.view).navigation).toEqual({ coda: { section: 2, bar: 1 }, toCoda: { section: 0, bar: 2 } });
    expectValid(r.view);
  });

  it('refuses the last section (a chart with no sections cannot be saved)', () => {
    const one = view({ ...PLAIN_BARS, sections: [PLAIN_BARS.sections[0]] });
    expect(removeSection(one, 'verse')).toEqual({ ok: false, reason: 'a chart needs at least one section' });
  });

  it('removes nothing else when no marker is inside', () => {
    const r = applied(removeSection(view(PLAIN), 'verse'));
    expect(r.removes).toEqual([]);
    expect(viewToSpec(r.view).navigation).toEqual({
      fine: { section: 1, bar: 4 },
      jump: { at: { section: 2, bar: 2 }, from: 'capo', until: 'fine' },
    });
  });
});

// ── §6 property test ─────────────────────────────────────────────────────────
// Random op sequences over the fixtures. Each bar carries a SYNTHETIC stable id
// carried through the op's own bar map (rendered bar ids are positional, so they
// can't prove a ref stayed on its musical bar). After every applied step:
//   (a) the spec validates and navigation is not silently dropped on lowering;
//   (b) every surviving marker is on the same musical bar, at the right edge of a
//       split; a vanished marker had its bar deleted or depended on one that did,
//       and is named in `removes`;
//   (c) chords.length === bars;
//   (d) no chord is written into or read out of a blank bar;
//   (e) every bar keeps its volta group; an inserted bar joins its neighbour's;
//   (f) no step turns a live chart not-live (§3), and the only section is never removed.

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Key = 'segno' | 'coda' | 'toCoda' | 'fine' | 'jump';
const KEYS: Key[] = ['segno', 'coda', 'toCoda', 'fine', 'jump'];
const EDGE: Record<Key, 'start' | 'end'> = { segno: 'start', coda: 'start', toCoda: 'end', fine: 'end', jump: 'end' };
const refOf = (nav: ViewNavigation | undefined, k: Key) => (k === 'jump' ? nav?.jump?.at : nav?.[k]);

// Each bar's group: 'b' body, 'e<i>' ending i, '-' neither — read from the view.
function groupsOf(v: ViewModel, id: string): string[] {
  const s = sec(v, id);
  const r = s.repeat;
  if (r?.kind !== 'volta') return s.chords.map(() => 'b');
  const earliest = Math.min(...r.endings.map((e) => e.bars.start));
  return s.chords.map((_, i) => {
    const bar = i + 1;
    if (bar < earliest) return 'b';
    const e = r.endings.findIndex((x) => bar >= x.bars.start && bar < x.bars.start + x.bars.count);
    return e === -1 ? '-' : `e${e}`;
  });
}

const sameBar = (a: ViewBar, b: ViewBar) => JSON.stringify(a) === JSON.stringify(b);

describe('structure ops — property test (§6)', () => {
  it('random op sequences keep every reference on its musical bar', () => {
    const fixtures = [PLAIN, VOLTA, PLAIN_BARS, MARKERS_ON_SPLITS, DC_IN_ENDING];
    const rand = mulberry32(0x5eed);
    const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
    const stats = { applied: new Set<string>(), refused: 0, removed: 0, deadRefused: 0, lastSectionRefused: 0 };
    let fresh = 0;

    for (let run = 0; run < 300; run += 1) {
      let v = view(pick(fixtures));
      const ids: Record<string, string[]> = {};
      for (const s of v.sections) ids[s.id] = s.chords.map((_, i) => `${s.id}.${i}`);

      for (let step = 0; step < 20; step += 1) {
        const s = pick(v.sections);
        const bar = 1 + Math.floor(rand() * s.bars);
        const op = pick(['split', 'before', 'after', 'delete', 'delete', 'count', 'remove'] as const);
        const r =
          op === 'split'
            ? splitBar(v, s.id, bar)
            : op === 'before' || op === 'after'
              ? insertBar(v, s.id, bar, op)
              : op === 'delete'
                ? deleteBar(v, s.id, bar)
                : op === 'count'
                  ? setBarCount(v, s.id, 1 + Math.floor(rand() * (s.bars + 3)))
                  : removeSection(v, s.id);
        // The only section can never be removed (Codex PR B R1).
        if (op === 'remove' && v.sections.length === 1) {
          expect(r.ok).toBe(false);
          stats.lastSectionRefused += 1;
        }
        const wasLive = navLive(viewToSpec(v)).live;
        if (!r.ok) {
          stats.refused += 1;
          if (/from being played|from being taken|at the Fine|no end/.test(r.reason)) {
            // A liveness refusal only ever protects a chart that was live.
            expect(wasLive).toBe(true);
            stats.deadRefused += 1;
          }
          continue;
        }
        // §3 second rule: no applied step turns a live chart not-live.
        if (wasLive) expect(navLive(viewToSpec(r.view))).toEqual({ live: true });
        stats.applied.add(op);
        const prev = v;
        const next = r.view;

        // Carry the synthetic ids through the op's bar map. A split's children get
        // `<id>/0 … <id>/k-1`, so each new bar still has an id of its own.
        const counts = new Map<number, number>();
        for (const src of r.edit?.src ?? []) if (src != null) counts.set(src, (counts.get(src) ?? 0) + 1);
        const nextIds: Record<string, string[]> = {};
        for (const ns of next.sections) {
          if (!r.edit || r.edit.sectionId !== ns.id) {
            nextIds[ns.id] = ids[ns.id];
            continue;
          }
          const seen = new Map<number, number>();
          nextIds[ns.id] = r.edit.src.map((src) => {
            if (src == null) return `new.${fresh++}`;
            const j = seen.get(src) ?? 0;
            seen.set(src, j + 1);
            return counts.get(src)! > 1 ? `${ids[ns.id][src]}/${j}` : ids[ns.id][src];
          });
        }
        // Where a marker on old bar `src` of the edited section must land.
        const expectedId = (sectionId: string, oldIndex: number, edge: 'start' | 'end') => {
          const id = ids[sectionId][oldIndex];
          if (r.edit?.sectionId !== sectionId) return id;
          const k = counts.get(oldIndex) ?? 0;
          return k > 1 ? `${id}/${edge === 'start' ? 0 : k - 1}` : id;
        };

        // (a)
        const spec = viewToSpec(next);
        const valid = validateRoadmapSpec(spec);
        expect(valid.ok ? [] : valid.errors).toEqual([]);
        expect(!!spec.navigation).toBe(!!next.navigation);

        // (c)
        for (const ns of next.sections) expect(ns.chords.length).toBe(ns.bars);

        // (b)
        const gone: Key[] = [];
        for (const k of KEYS) {
          const was = refOf(prev.navigation, k);
          const now = refOf(next.navigation, k);
          if (!was) {
            expect(now).toBeUndefined(); // no op adds a marker
            continue;
          }
          if (now) {
            expect(now.sectionId).toBe(was.sectionId);
            expect(nextIds[now.sectionId][now.bar - 1]).toBe(expectedId(was.sectionId, was.bar - 1, EDGE[k]));
          } else {
            gone.push(k);
          }
        }
        if (gone.length > 0) {
          stats.removed += 1;
          const barGone = (k: Key) => {
            const was = refOf(prev.navigation, k)!;
            if (!nextIds[was.sectionId]) return true; // section removed
            return r.edit?.sectionId === was.sectionId && !counts.has(was.bar - 1);
          };
          for (const k of gone) {
            const dependent =
              (k === 'toCoda' && gone.includes('coda')) ||
              (k === 'jump' && gone.some((g) => g !== 'jump'));
            expect(barGone(k) || dependent).toBe(true);
          }
          expect(r.removes.length).toBeGreaterThanOrEqual(gone.length);
        }

        // (d) + (e)
        if (r.edit) {
          const id = r.edit.sectionId;
          const oldSec = sec(prev, id);
          const newSec = sec(next, id);
          r.edit.src.forEach((src, i) => {
            const nb = newSec.chords[i];
            if (src == null) return expect(nb).toBeNull();
            const ob = oldSec.chords[src];
            if (ob == null) return expect(nb).toBeNull();
            if ((counts.get(src) ?? 0) === 1) return expect(sameBar(nb, ob)).toBe(true);
            expect(nb).toHaveLength(1); // a split child holds one of its bar's chords
            expect(ob.map((c) => c.degree)).toContain(nb![0].degree);
          });

          if (oldSec.repeat?.kind === 'volta' && newSec.repeat?.kind === 'volta') {
            const og = groupsOf(prev, id);
            const ng = groupsOf(next, id);
            r.edit.src.forEach((src, i) => {
              if (src != null) expect(ng[i]).toBe(og[src]);
              // A new bar joins the group of the bar it was inserted relative to.
              else if (op === 'before' || op === 'after') expect(ng[i]).toBe(og[bar - 1]);
            });
          }
        }

        v = next;
        for (const k of Object.keys(ids)) delete ids[k];
        Object.assign(ids, nextIds);
      }
    }

    // A property test that never exercised the hard paths would pass vacuously.
    expect([...stats.applied].sort()).toEqual(['after', 'before', 'count', 'delete', 'remove', 'split']);
    expect(stats.refused).toBeGreaterThan(0);
    expect(stats.removed).toBeGreaterThan(0);
    expect(stats.deadRefused).toBeGreaterThan(0);
    expect(stats.lastSectionRefused).toBeGreaterThan(0);
  });
});
