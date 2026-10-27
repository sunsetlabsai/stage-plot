// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import RoadmapBuilder from '../components/RoadmapBuilder';
import type { RoadmapSpec } from '../lib/roadmap-spec';

// Two builder bugs reported from UAT on "9 to 5" (2026-08-28), both on the Review
// screen, both invisible from the outside:
//
//   1. A failed Regenerate produced NO feedback. `error`/`specErrors` were set by
//      generate() but passed only to Compose, so on Review the button flipped
//      Generating… → Regenerate and the chart sat unchanged — indistinguishable from
//      a dead button. That is exactly how it was reported: "didn't seem to do
//      anything."
//   2. Regenerate sent Compose's `composeKey`, a value the Review screen never shows,
//      so changing the key in the Review toolbar and regenerating silently discarded
//      the change.
//
// Both are about what crosses the Compose→Review boundary, so they are driven through
// the real component rather than asserted on a helper.

const SPEC: RoadmapSpec = {
  version: 1,
  timeSig: { beats: 4, unit: 4 },
  renderKey: 'F',
  sections: [
    { id: 'intro', label: 'Intro', bars: 4, changes: [{ bar: 1, chords: [{ degree: 1 }] }] },
    { id: 'turnaround', label: 'Turnaround', bars: 2 },
  ],
};

function mockFetchOnce(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({ ok, json: async () => body });
}

// Drive Compose → Review with a successful parse, and hand back the fetch mock so a
// test can re-point it before exercising Regenerate.
async function renderInReview() {
  const fetchMock = mockFetchOnce({ ok: true, spec: SPEC });
  vi.stubGlobal('fetch', fetchMock);

  render(<RoadmapBuilder songTitle="9 to 5" charts={[]} onClose={vi.fn()} onSaved={vi.fn()} />);

  fireEvent.change(screen.getByRole('textbox'), { target: { value: '4/4 in F. 4-bar intro, 2-bar turnaround.' } });
  fireEvent.click(screen.getByRole('button', { name: /generate chart/i }));

  await screen.findByRole('button', { name: /regenerate/i });
  return fetchMock;
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>, callIndex: number) {
  return JSON.parse(fetchMock.mock.calls[callIndex][1].body as string);
}

beforeEach(() => {
  // Regenerate is behind a confirm(); jsdom's returns undefined, which would abort
  // every regenerate and make these tests pass for the wrong reason.
  vi.stubGlobal('confirm', () => true);
  // jsdom has no ResizeObserver, which the preview's fit-to-width hook constructs on
  // mount. A no-op stub leaves the measured width at 0, so the layout falls back to
  // its 4-bars/line default — deterministic, and none of these assertions touch wrap.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RoadmapBuilder — Regenerate surfaces failure', () => {
  it('shows a transport error raised by a Regenerate on the Review screen', async () => {
    const fetchMock = await renderInReview();

    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: 'Parser is temporarily unavailable.' }) });
    fireEvent.click(screen.getByRole('button', { name: /regenerate/i }));

    expect(await screen.findByText('Parser is temporarily unavailable.')).toBeInTheDocument();
  });

  it('shows spec-validation errors raised by a Regenerate on the Review screen', async () => {
    const fetchMock = await renderInReview();

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: false, errors: ['sections[1].bars must be an integer >= 1'] }),
    });
    fireEvent.click(screen.getByRole('button', { name: /regenerate/i }));

    expect(await screen.findByText(/produced an invalid chart/i)).toBeInTheDocument();
    expect(screen.getByText('sections[1].bars must be an integer >= 1')).toBeInTheDocument();
  });

  it('clears a previous error once a Regenerate succeeds', async () => {
    const fetchMock = await renderInReview();

    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: 'Could not reach the parser.' }) });
    fireEvent.click(screen.getByRole('button', { name: /regenerate/i }));
    await screen.findByText('Could not reach the parser.');

    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, spec: SPEC }) });
    fireEvent.click(screen.getByRole('button', { name: /regenerate/i }));

    await waitFor(() => {
      expect(screen.queryByText('Could not reach the parser.')).not.toBeInTheDocument();
    });
  });
});

describe('RoadmapBuilder — Regenerate carries the key the Review screen is showing', () => {
  it('sends the toolbar key, not the stale Compose selector', async () => {
    const fetchMock = await renderInReview();

    // The Compose selector was left on Auto, so a regression here re-reads it as
    // undefined and the assertion below fails loudly rather than silently passing.
    expect(bodyOf(fetchMock, 0).key).toBeUndefined();

    // Change the key in the Review toolbar — the picker showing the chart's renderKey.
    fireEvent.change(screen.getByDisplayValue('F'), { target: { value: 'F#' } });
    fireEvent.click(screen.getByRole('button', { name: /regenerate/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(bodyOf(fetchMock, 1).key).toBe('F#');
  });

  it('offers F# in the Review key picker at all — the reported gap', async () => {
    await renderInReview();

    const picker = screen.getByDisplayValue('F') as HTMLSelectElement;
    const offered = Array.from(picker.options).map((o) => o.value);
    expect(offered).toContain('F#');
    expect(offered).toContain('F#m');
    // 12 majors + 12 minors, and no stray blank/placeholder option on this picker.
    expect(offered).toHaveLength(24);
  });
});

// The rhythm strip is drawn by BOTH the preview (here) and the PDF, from the ONE
// shared slashBeats rule, so held-suppression can't drift between them. These pin
// the preview end; roadmap-rhythm.test.ts pins the rule, roadmap-render.test.ts
// pins the PDF end. A suppressed beat renders an empty span, so it never matches
// the ╱ query — the count IS the number of struck beats.
describe('RoadmapBuilder — rhythm slashes follow the shared beat→slash rule', () => {
  async function renderSpecInReview(spec: RoadmapSpec) {
    const fetchMock = mockFetchOnce({ ok: true, spec });
    vi.stubGlobal('fetch', fetchMock);
    render(<RoadmapBuilder songTitle="X" charts={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'anything' } });
    fireEvent.click(screen.getByRole('button', { name: /generate chart/i }));
    await screen.findByRole('button', { name: /regenerate/i });
  }

  it('draws one slash per beat for every struck / inherited bar', async () => {
    // SPEC: 4 + 2 bars at 4/4, all struck or inherited → 24 slashes, none suppressed.
    await renderSpecInReview(SPEC);
    expect(screen.getAllByText('╱')).toHaveLength(6 * 4);
  });

  it('suppresses all four slashes under a held whole-bar chord (the ring)', async () => {
    const held: RoadmapSpec = {
      version: 1,
      timeSig: { beats: 4, unit: 4 },
      renderKey: 'F',
      sections: [
        { id: 'intro', label: 'Intro', bars: 4, changes: [{ bar: 1, chords: [{ degree: 1, held: true }] }] },
        { id: 'turn', label: 'Turn', bars: 2 },
      ],
    };
    // Bar 1 held → its 4 beats blank; the other 5 bars keep 4 each.
    await renderSpecInReview(held);
    expect(screen.getAllByText('╱')).toHaveLength(5 * 4);
  });

  it('suppresses only the held half of a split bar', async () => {
    const split: RoadmapSpec = {
      version: 1,
      timeSig: { beats: 4, unit: 4 },
      renderKey: 'F',
      sections: [
        {
          id: 'only',
          label: 'Only',
          bars: 1,
          changes: [{ bar: 1, chords: [{ degree: 4, beats: 2 }, { degree: 5, beats: 2, held: true }] }],
        },
      ],
    };
    // One bar: beats 1-2 struck, 3-4 held → exactly 2 slashes.
    await renderSpecInReview(split);
    expect(screen.getAllByText('╱')).toHaveLength(2);
  });
});

// PR B — persist the prompt (design-roadmap-prompt-persistence.md). Re-opening a
// saved chart seeds the refine box from the stored prompt so Regenerate is live;
// a legacy chart (no stored prompt) keeps today's empty-box behavior; and a save
// round-trips the current box text back as source_prompt.
describe('RoadmapBuilder — re-open pre-fills the refine box from the stored prompt', () => {
  function renderEdit(sourcePrompt?: string, sourceNotation?: 'numbers' | 'letters') {
    render(
      <RoadmapBuilder
        songTitle="9 to 5"
        charts={[]}
        editChart={{ chartId: 'c1', role: 'guitar', spec: SPEC, updatedAt: '2026-08-29T00:00:00Z', sourcePrompt, sourceNotation }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
  }

  it('seeds the box and ENABLES Regenerate when a prompt was stored', () => {
    renderEdit('4/4 in F. 4-bar intro, 2-bar turnaround.');
    expect((screen.getByRole('textbox', { name: /refine description/i }) as HTMLTextAreaElement).value).toBe(
      '4/4 in F. 4-bar intro, 2-bar turnaround.',
    );
    expect(screen.getByRole('button', { name: /regenerate/i })).toBeEnabled();
  });

  it('opens EMPTY with Regenerate disabled for a legacy chart (no stored prompt)', () => {
    renderEdit(undefined);
    expect((screen.getByRole('textbox', { name: /refine description/i }) as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByRole('button', { name: /regenerate/i })).toBeDisabled();
  });

  it('sends the current refine-box text as source_prompt on save', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ chart_id: 'c1', role: 'guitar', url: 'u', song_key: 'k' }) });
    vi.stubGlobal('fetch', fetchMock);

    renderEdit('original prompt');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.source_prompt).toBe('original prompt');
    // …and the stale-edit precondition still rides along on the edit path.
    expect(body.expected_chart_id).toBe('c1');
  });
});

// Notation toggle (design-roadmap-notation-toggle.md). The toggle drives the SAVE
// (one PDF, baked in the chosen notation) and re-open SEEDS the toggle from the
// stored notation — so a save that never touched the toggle can't silently re-bake
// numbers over a letters chart. Both assertions read the save body, the boundary
// that reaches the render route.
describe('RoadmapBuilder — the notation toggle drives save, and re-open seeds it', () => {
  function renderEdit(sourceNotation?: 'numbers' | 'letters') {
    render(
      <RoadmapBuilder
        songTitle="9 to 5"
        charts={[]}
        editChart={{ chartId: 'c1', role: 'guitar', spec: SPEC, updatedAt: '2026-08-29T00:00:00Z', sourceNotation }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
  }
  function saveMock() {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ chart_id: 'c1', role: 'guitar', url: 'u', song_key: 'k' }) });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  const notationOf = (m: ReturnType<typeof vi.fn>) => JSON.parse(m.mock.calls[0][1].body as string).notation;

  it('re-opens a letters chart on Letters and saves letters WITHOUT re-toggling (silent-flip guard)', async () => {
    const fetchMock = saveMock();
    renderEdit('letters');
    // No toggle interaction — the seed alone must carry the notation through save.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(notationOf(fetchMock)).toBe('letters');
  });

  it('re-opens a legacy chart (no stored notation) on Numbers', async () => {
    const fetchMock = saveMock();
    renderEdit();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(notationOf(fetchMock)).toBe('numbers');
  });

  it('flipping the toggle to Letters bakes letters on the next save', async () => {
    const fetchMock = saveMock();
    renderEdit('numbers');
    fireEvent.click(screen.getByRole('button', { name: 'Letters' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(notationOf(fetchMock)).toBe('letters');
  });

  it('hands the baked notation to onSaved so live state is correct before any reload', async () => {
    // The save route response omits notation; the badge would read undefined→numbers
    // and print the live song.key over a letters chart until a full show GET. So the
    // built Chart must carry notation itself (Codex code-review, Medium 1).
    saveMock();
    const onSaved = vi.fn();
    render(
      <RoadmapBuilder
        songTitle="9 to 5"
        charts={[]}
        editChart={{ chartId: 'c1', role: 'guitar', spec: SPEC, updatedAt: '2026-08-29T00:00:00Z', sourceNotation: 'letters' }}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onSaved.mock.calls[0][0]).toMatchObject({ is_builder: true, notation: 'letters' });
  });
});

// Chart export (reuse the show-mode Share): the Review screen can share the SAVED
// artifact out of the app. It appears once a stored URL exists — on re-open, or
// after a save produces one — and never for a fresh build with nothing saved yet.
const STORED_URL = 'https://x.supabase.co/storage/v1/object/public/charts/u/9-to-5/guitar/h.pdf';
describe('RoadmapBuilder — Review can Share the saved chart', () => {
  function renderReviewEdit(url?: string) {
    render(
      <RoadmapBuilder
        songTitle="9 to 5"
        charts={[]}
        editChart={{ chartId: 'c1', role: 'guitar', spec: SPEC, updatedAt: '2026-08-29T00:00:00Z', url }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
  }

  it('shows Share on re-open when the stored URL is known', () => {
    renderReviewEdit(STORED_URL);
    expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument();
  });

  it('a fresh build has nothing to share until it is saved', async () => {
    await renderInReview();
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();
  });

  it('reveals Share once a save returns a URL', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ chart_id: 'c1', role: 'guitar', url: STORED_URL, song_key: '9-to-5' }) });
    vi.stubGlobal('fetch', fetchMock);

    renderReviewEdit(undefined);
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument());
  });

  it('hides Share while a save is in flight, then restores it (Codex Low)', async () => {
    // A re-save moves the content-addressed URL and deletes the old object, so
    // sharing mid-save could copy a URL about to 404. Share must vanish while saving.
    let release!: (v: unknown) => void;
    const fetchMock = vi.fn().mockReturnValue(new Promise((r) => (release = r)));
    vi.stubGlobal('fetch', fetchMock);

    renderReviewEdit(STORED_URL);
    expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Share' })).toBeNull());

    release({ ok: true, json: async () => ({ chart_id: 'c1', role: 'guitar', url: STORED_URL, song_key: '9-to-5' }) });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument());
  });
});

// UAT 2026-10-26: on Review the read-back took the panel's height and squeezed the
// refine box to one line. It now collapses to a one-line summary there (the chart
// shows the same read); on Compose it only appears beside a failed parse, where it
// is the diagnosis, so it stays open.
describe('RoadmapBuilder — the read-back collapses on Review', () => {
  const TALLY = ['Intro: 4 bars — 1×4', 'Turnaround: 2 bars — 1×2'];
  const readBack = () => screen.getByText(/^Read-back · 2 sections$/).closest('details') as HTMLDetailsElement;

  it('is collapsed after a successful parse, and expands on click', async () => {
    vi.stubGlobal('fetch', mockFetchOnce({ ok: true, spec: SPEC, tally: TALLY }));
    render(<RoadmapBuilder songTitle="9 to 5" charts={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '4/4 in F. 4-bar intro, 2-bar turnaround.' } });
    fireEvent.click(screen.getByRole('button', { name: /generate chart/i }));
    await screen.findByRole('button', { name: /regenerate/i });

    expect(readBack().open).toBe(false);
    fireEvent.click(screen.getByText(/^Read-back · 2 sections$/));
    await waitFor(() => expect(readBack().open).toBe(true));
  });

  it('is open on Compose beside a failed parse', async () => {
    vi.stubGlobal('fetch', mockFetchOnce({ ok: false, errors: ['Intro: 3 bars, expected 4'], tally: TALLY }));
    render(<RoadmapBuilder songTitle="9 to 5" charts={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '4/4 in F. 4-bar intro, 2-bar turnaround.' } });
    fireEvent.click(screen.getByRole('button', { name: /generate chart/i }));

    await screen.findByText(/^Read-back · 2 sections$/);
    expect(readBack().open).toBe(true);
  });
});

// Structure editing PR B (design-roadmap-structure-editing.md §5.3): the bar action
// row and the bar-count field both go through the op layer. Asserted at the save
// body — the spec that actually reaches the render route.
describe('RoadmapBuilder — bar structure edits', () => {
  const STRUCT: RoadmapSpec = {
    version: 1,
    timeSig: { beats: 4, unit: 4 },
    renderKey: 'C',
    sections: [
      { id: 'tag', label: 'Tag', bars: 1 },
      { id: 'verse', label: 'Verse', bars: 2, changes: [{ bar: 1, chords: [{ degree: 4 }, { degree: 5 }] }] },
      { id: 'chorus', label: 'Chorus', bars: 3 },
    ],
    navigation: { fine: { section: 2, bar: 3 } },
  };

  function renderEdit() {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ chart_id: 'c1', role: 'guitar', url: 'u', song_key: 'k' }) });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <RoadmapBuilder
        songTitle="X"
        charts={[]}
        editChart={{ chartId: 'c1', role: 'guitar', spec: STRUCT, updatedAt: '2026-10-26T00:00:00Z' }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    return fetchMock;
  }

  async function savedSpec(fetchMock: ReturnType<typeof vi.fn>): Promise<RoadmapSpec> {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    return JSON.parse(fetchMock.mock.calls[0][1].body as string).spec;
  }

  const barsField = (i: number) => screen.getAllByRole('spinbutton', { name: 'Bars' })[i] as HTMLInputElement;

  it('a tap on a bar reaches the action row, and Split turns `4 5` into two bars', async () => {
    const fetchMock = renderEdit();
    fireEvent.click(screen.getAllByTitle('2 beats')[0]); // the `4` of the Verse's `4 5`
    fireEvent.click(screen.getByRole('button', { name: 'Split into bars' }));
    expect(barsField(1).value).toBe('3');
    const spec = await savedSpec(fetchMock);
    expect(spec.sections[1]).toEqual({
      id: 'verse',
      label: 'Verse',
      bars: 3,
      changes: [
        { bar: 1, chords: [{ degree: 4 }] },
        { bar: 2, chords: [{ degree: 5 }] },
      ],
    });
  });

  it('Split is disabled on a blank bar, and acts on what is typed', async () => {
    renderEdit();
    fireEvent.click(screen.getAllByText('＋')[0]); // the Tag's only bar
    const split = screen.getByRole('button', { name: 'Split into bars' });
    expect(split).toBeDisabled();
    const input = screen.getAllByRole('textbox').find((el) => el.tagName === 'INPUT')!;
    fireEvent.change(input, { target: { value: '1 5' } });
    expect(split).toBeEnabled();
    fireEvent.click(split);
    expect(barsField(0).value).toBe('2');
  });

  it('Delete on a section’s only bar is refused, with the reason under the bar', async () => {
    renderEdit();
    fireEvent.click(screen.getAllByText('＋')[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete this bar' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/at least one bar/);
    expect(barsField(0).value).toBe('1');
  });

  it('the bar count commits on blur, not per keystroke', () => {
    const confirmMock = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmMock);
    renderEdit();
    fireEvent.change(barsField(2), { target: { value: '1' } });
    expect(confirmMock).not.toHaveBeenCalled(); // mid-typing: nothing applied yet
    fireEvent.change(barsField(2), { target: { value: '5' } });
    fireEvent.blur(barsField(2));
    expect(confirmMock).not.toHaveBeenCalled(); // growing removes nothing
    expect(barsField(2).value).toBe('5');
  });

  it('shrinking past a marker confirms, naming it; declining keeps the bars and the marker', async () => {
    const confirmMock = vi.fn(() => false);
    vi.stubGlobal('confirm', confirmMock);
    const fetchMock = renderEdit();
    fireEvent.change(barsField(2), { target: { value: '2' } });
    fireEvent.blur(barsField(2));
    expect(confirmMock).toHaveBeenCalledWith('Change Chorus to 2 bars? This also removes the Fine.');
    expect(barsField(2).value).toBe('3');
    const spec = await savedSpec(fetchMock);
    expect(spec.sections[2].bars).toBe(3);
    expect(spec.navigation).toEqual({ fine: { section: 2, bar: 3 } });
  });

  it('accepting the confirm saves the shorter section without the marker', async () => {
    vi.stubGlobal('confirm', () => true);
    const fetchMock = renderEdit();
    fireEvent.change(barsField(2), { target: { value: '2' } });
    fireEvent.blur(barsField(2));
    const spec = await savedSpec(fetchMock);
    expect(spec.sections[2].bars).toBe(2);
    expect(spec.navigation).toBeUndefined();
  });

  it('removing a section that holds a marker confirms, naming it', () => {
    const confirmMock = vi.fn(() => false);
    vi.stubGlobal('confirm', confirmMock);
    renderEdit();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Chorus' }));
    expect(confirmMock).toHaveBeenCalledWith('Remove Chorus? This also removes the Fine.');
    expect(screen.getAllByRole('spinbutton', { name: 'Bars' })).toHaveLength(3);
  });
});

// Structure editing PR C (design-roadmap-structure-editing.md §5.1): the section's
// repeat control and Write out, asserted at the save body.
describe('RoadmapBuilder — section repeat control', () => {
  const REP: RoadmapSpec = {
    version: 1,
    timeSig: { beats: 4, unit: 4 },
    renderKey: 'C',
    sections: [
      { id: 'tag', label: 'Tag', bars: 1 },
      { id: 'verse', label: 'Verse', bars: 2, repeat: { kind: 'plain', times: 2 }, changes: [{ bar: 1, chords: [{ degree: 1 }] }] },
      {
        id: 'chorus',
        label: 'Chorus',
        bars: 3,
        repeat: {
          kind: 'volta',
          endings: [
            { bars: { start: 2, count: 1 }, passes: [1] },
            { bars: { start: 3, count: 1 }, passes: [2] },
          ],
        },
      },
    ],
  };

  function renderEdit(spec: RoadmapSpec = REP) {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ chart_id: 'c1', role: 'guitar', url: 'u', song_key: 'k' }) });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <RoadmapBuilder
        songTitle="X"
        charts={[]}
        editChart={{ chartId: 'c1', role: 'guitar', spec, updatedAt: '2026-10-26T00:00:00Z' }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    return fetchMock;
  }

  async function savedSpec(fetchMock: ReturnType<typeof vi.fn>): Promise<RoadmapSpec> {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    return JSON.parse(fetchMock.mock.calls[0][1].body as string).spec;
  }

  const repeatOf = (label: string) => screen.getByRole('combobox', { name: `Repeat ${label}` }) as HTMLSelectElement;

  it('shows each section’s repeat, and is disabled on a 1-bar section', () => {
    renderEdit();
    expect(repeatOf('Tag')).toBeDisabled();
    expect(repeatOf('Verse').value).toBe('2');
    expect(repeatOf('Chorus').value).toBe('volta');
    expect(repeatOf('Chorus').selectedOptions[0].textContent).toBe('2 endings');
  });

  it('changing the count saves the new plain repeat', async () => {
    const fetchMock = renderEdit();
    fireEvent.change(repeatOf('Verse'), { target: { value: '3' } });
    const spec = await savedSpec(fetchMock);
    expect(spec.sections[1].repeat).toEqual({ kind: 'plain', times: 3 });
  });

  it('replacing endings with a count confirms, naming them; declining keeps them', async () => {
    const confirmMock = vi.fn(() => false);
    vi.stubGlobal('confirm', confirmMock);
    const fetchMock = renderEdit();
    fireEvent.change(repeatOf('Chorus'), { target: { value: '2' } });
    expect(confirmMock).toHaveBeenCalledWith('Repeat Chorus ×2? This also removes the 2 endings.');
    const spec = await savedSpec(fetchMock);
    expect(spec.sections[2].repeat?.kind).toBe('volta');
  });

  it('Write out turns Verse ×2 into two Verse sections', async () => {
    const fetchMock = renderEdit();
    fireEvent.click(screen.getByRole('button', { name: 'Write out' }));
    const spec = await savedSpec(fetchMock);
    expect(spec.sections.map((s) => [s.id, s.label, s.bars, s.repeat])).toEqual([
      ['tag', 'Tag', 1, undefined],
      ['verse', 'Verse', 2, undefined],
      ['verse-2', 'Verse', 2, undefined],
      ['chorus', 'Chorus', 3, REP.sections[2].repeat],
    ]);
  });

  it('Write out is refused, with the reason, when a D.C. replays the repeat', () => {
    renderEdit({
      ...REP,
      sections: [REP.sections[1], { id: 'outro', label: 'Outro', bars: 1 }],
      navigation: { jump: { at: { section: 1, bar: 1 }, from: 'capo', until: 'end' } },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Write out' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'this repeat is replayed by the D.C.; writing it out would change what is played',
    );
    expect(screen.getAllByRole('spinbutton', { name: 'Bars' })).toHaveLength(2);
  });
});

// Structure editing PR D (design-roadmap-structure-editing.md §5.2 / §5.4):
// endings from the repeat control, markers from the bar's Marker menu.
describe('RoadmapBuilder — endings and markers', () => {
  const MK: RoadmapSpec = {
    version: 1,
    timeSig: { beats: 4, unit: 4 },
    renderKey: 'C',
    sections: [
      { id: 'verse', label: 'Verse', bars: 2, repeat: { kind: 'plain', times: 2 }, changes: [{ bar: 1, chords: [{ degree: 1 }] }] },
      { id: 'outro', label: 'Outro', bars: 2, changes: [{ bar: 1, chords: [{ degree: 5 }] }] },
    ],
  };

  function renderEdit(spec: RoadmapSpec = MK) {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ chart_id: 'c1', role: 'guitar', url: 'u', song_key: 'k' }) });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <RoadmapBuilder
        songTitle="X"
        charts={[]}
        editChart={{ chartId: 'c1', role: 'guitar', spec, updatedAt: '2026-10-26T00:00:00Z' }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    return fetchMock;
  }

  async function savedSpec(fetchMock: ReturnType<typeof vi.fn>): Promise<RoadmapSpec> {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    return JSON.parse(fetchMock.mock.calls[0][1].body as string).spec;
  }

  const marker = () => screen.getByRole('combobox', { name: 'Marker' }) as HTMLSelectElement;
  const optionLabels = (el: HTMLSelectElement) => [...el.options].map((o) => o.textContent);
  // Open a bar by its chord text (numbers mode): '1' is Verse bar 1, '5' Outro bar 1.
  const openBar = (text: string) => fireEvent.click(screen.getAllByText(text).find((el) => el.tagName === 'SPAN' && el.closest('.group'))!);

  it('the Marker menu offers only what the validator accepts', () => {
    renderEdit();
    openBar('1');
    expect(optionLabels(marker())).toEqual(['Marker…', 'Segno', 'Coda', 'Fine', 'D.C.']);
  });

  it('placing a Segno saves it on that bar and tags the bar in the preview', async () => {
    const fetchMock = renderEdit();
    openBar('5');
    fireEvent.change(marker(), { target: { value: 'm:segno' } });
    // The tag over the bar (the right panel's marker chip also says Segno).
    expect(screen.getAllByText('Segno').some((el) => el.className.includes('absolute'))).toBe(true);
    const spec = await savedSpec(fetchMock);
    expect(spec.navigation).toEqual({ segno: { section: 1, bar: 1 } });
  });

  it('removing a marker confirms, naming what depends on it', () => {
    const confirmMock = vi.fn(() => false);
    vi.stubGlobal('confirm', confirmMock);
    renderEdit({
      ...MK,
      navigation: { segno: { section: 1, bar: 1 }, jump: { at: { section: 1, bar: 2 }, from: 'segno', until: 'end' } },
    });
    openBar('5');
    expect(optionLabels(marker())).toContain('Remove Segno');
    fireEvent.change(marker(), { target: { value: 'r:segno' } });
    expect(confirmMock).toHaveBeenCalledWith('Remove the Segno? This also removes the D.S.');
  });

  it('a placement that would never fire is refused under the bar', () => {
    renderEdit({
      ...MK,
      sections: [
        {
          ...MK.sections[0],
          bars: 3,
          repeat: {
            kind: 'volta',
            endings: [
              { bars: { start: 2, count: 1 }, passes: [1] },
              { bars: { start: 3, count: 1 }, passes: [2] },
            ],
          },
          changes: [
            { bar: 1, chords: [{ degree: 1 }] },
            { bar: 2, chords: [{ degree: 4 }] },
          ],
        },
        MK.sections[1],
      ],
    });
    openBar('4'); // the 1st ending's only bar
    fireEvent.change(marker(), { target: { value: 'j:capo:end' } });
    expect(screen.getByRole('alert')).toHaveTextContent('the D.C. would never be played with the markers placed like this');
  });

  it('1st/2nd endings from the repeat control: the last bar becomes ending 1, a 2nd is appended', async () => {
    const fetchMock = renderEdit();
    fireEvent.change(screen.getByRole('combobox', { name: 'Repeat Verse' }), { target: { value: 'e:1' } });
    expect(screen.getByText('1.')).toBeInTheDocument();
    expect(screen.getByText('2.')).toBeInTheDocument();
    const spec = await savedSpec(fetchMock);
    expect(spec.sections[0]).toMatchObject({
      bars: 3,
      repeat: {
        kind: 'volta',
        endings: [
          { bars: { start: 2, count: 1 }, passes: [1] },
          { bars: { start: 3, count: 1 }, passes: [2] },
        ],
      },
    });
  });

  it('Remove endings confirms, naming the bars it deletes', () => {
    const confirmMock = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmMock);
    renderEdit();
    fireEvent.change(screen.getByRole('combobox', { name: 'Repeat Verse' }), { target: { value: 'e:1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove endings' }));
    expect(confirmMock).toHaveBeenCalledWith('Remove the endings on Verse? This also removes the later ending (bar 3).');
    expect((screen.getAllByRole('spinbutton', { name: 'Bars' })[0] as HTMLInputElement).value).toBe('2');
  });
});
