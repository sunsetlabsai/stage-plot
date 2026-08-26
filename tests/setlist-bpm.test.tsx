// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SetupSetlistTable, AddSongFromLibrary } from '../app/[owner]/[show]/page';
import type { SetlistSong } from '../lib/types';

// ── UX polish §3: in-show BPM authoring gate (jsdom) ─────────────────────────
// The BPM control writes the CANONICAL song row, so it is owner-only AND only for
// library-linked rows (a songId is the write target). These assert the render gate
// and the onBpmChange contract; the guarded PUT path is covered in bpm-writer.test.ts.

afterEach(cleanup);

function song(over: Partial<SetlistSong> = {}): SetlistSong {
  return { id: 'row1', position: 1, title: 'Song', lead: '', bpm: null, ...over };
}

function tableProps(over: Record<string, unknown> = {}) {
  return {
    setlist: [] as SetlistSong[],
    canResolveCharts: false,
    onReorder: vi.fn(),
    onUpdate: vi.fn(),
    onDelete: vi.fn(),
    onAddSong: vi.fn(),
    onBpmChange: vi.fn(),
    isOwner: true,
    ownerId: 'owner1',
    onManageCharts: vi.fn(),
    ...over,
  };
}

describe('SetupSetlistTable — BPM control gate', () => {
  it('shows the owner-only Tempo control + global-write hint for a library-linked row', () => {
    render(
      <SetupSetlistTable
        {...tableProps({
          setlist: [song({ id: 'r1', songId: 's1', title: 'Linked', bpm: 120 })],
        })}
      />,
    );
    expect(screen.getByText('Tempo')).toBeInTheDocument();
    expect(screen.getByText(/sets this song.s tempo everywhere/)).toBeInTheDocument();
  });

  it('omits the control for an inline row (no songId)', () => {
    render(
      <SetupSetlistTable
        {...tableProps({ setlist: [song({ id: 'r1', songId: undefined, title: 'Inline' })] })}
      />,
    );
    expect(screen.queryByText('Tempo')).toBeNull();
    expect(screen.queryByText(/sets this song.s tempo everywhere/)).toBeNull();
  });

  it('omits the control for a non-owner even on a library-linked row', () => {
    render(
      <SetupSetlistTable
        {...tableProps({
          isOwner: false,
          setlist: [song({ id: 'r1', songId: 's1', title: 'Linked', bpm: 120 })],
        })}
      />,
    );
    expect(screen.queryByText('Tempo')).toBeNull();
  });

  it('fires onBpmChange with the songId (not the row index) and the new tempo', () => {
    const onBpmChange = vi.fn();
    render(
      <SetupSetlistTable
        {...tableProps({
          onBpmChange,
          setlist: [song({ id: 'r1', songId: 's1', title: 'Linked', bpm: 120 })],
        })}
      />,
    );
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '130' } });
    expect(onBpmChange).toHaveBeenCalledWith('s1', 130);
  });
});

describe('AddSongFromLibrary — add-time BPM threading', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          songs: [{ id: 's1', title: 'Damn Time', key: 'C', lead: 'Rachel', notes: '', bpm: 118 }],
        }),
      })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('threads the selected library song bpm onto the onAddSong payload', async () => {
    const onAddSong = vi.fn();
    render(<AddSongFromLibrary onAddSong={onAddSong} isOwner ownerId="owner1" />);
    fireEvent.click(screen.getByRole('button', { name: /Add Song/ }));
    fireEvent.change(await screen.findByPlaceholderText(/Search library/), {
      target: { value: 'Damn' },
    });
    fireEvent.click(await screen.findByRole('button', { name: /Damn Time/ }));
    expect(onAddSong).toHaveBeenCalledWith(expect.objectContaining({ songId: 's1', bpm: 118 }));
  });
});
