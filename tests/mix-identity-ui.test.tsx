// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MixTab, SetupMonitorTable } from '../app/[owner]/[show]/page';
import type { BandConfig, MonitorMix, StageSlot } from '../lib/types';

// design-core-path-tier1 §3.2 / §3.3 / §3.5 — the surfaces of mix identity.

afterEach(cleanup);

function mon(mix: number, name = `M${mix}`): MonitorMix {
  return { id: `m-${mix}`, mix, name, needs: '' };
}

describe('OccupantChip on the rider — §3.5, the badge must stop lying', () => {
  function band(stagePlot: StageSlot[], monitors: MonitorMix[]): BandConfig {
    return { slug: 's', name: 'B', lineup: '', stagePlot, inputs: [], monitors, notes: [], setlist: [] };
  }
  function renderRider(b: BandConfig) {
    return render(
      <MixTab
        band={b}
        setlist={[]}
        printSections={{ stagePlot: true, inputList: true, monitorMixes: true, notes: true, setlist: true }}
        showInfo={{ bandName: 'B', eventDate: '', venue: '' }}
        isOffline={false}
        slug="s"
        owner="o"
        isOwner
        onReorder={vi.fn()}
      />,
    );
  }

  it('a slot on a removed mix is badged as removed, not as a confident "MIX 7"', () => {
    renderRider(band([{ id: 'a', name: 'Ann', pos: 'DSC', role: '', mix: 7 }], [mon(1)]));

    expect(screen.getByText(/MIX 7 REMOVED/)).toBeTruthy();
  });

  it('COUNTEREXAMPLE: a slot on a live mix keeps the plain badge', () => {
    // Without this, flagging every badge would pass the test above.
    renderRider(band([{ id: 'a', name: 'Ann', pos: 'DSC', role: '', mix: 1 }], [mon(1)]));

    expect(screen.getByText('MIX 1')).toBeTruthy();
    expect(screen.queryByText(/REMOVED/)).toBeNull();
  });

  it('the rider monitor list prints in aux order, whatever the array order', () => {
    renderRider(band([], [mon(5, 'Horns'), mon(1, 'Drums')]));
    const headings = screen.getAllByText(/^Mix \d+:$/).map((el) => el.textContent);
    expect(headings).toEqual(['Mix 1:', 'Mix 5:']);
  });
});

describe('SetupMonitorTable — §3.2 no drag, §3.3 editable Mix #', () => {
  function renderTable(monitors: MonitorMix[], onRenumber = vi.fn(() => null as string | null)) {
    const handlers = { onRenumber, onUpdate: vi.fn(), onDelete: vi.fn(), onAdd: vi.fn() };
    render(<SetupMonitorTable monitors={monitors} {...handlers} />);
    return handlers;
  }

  it('rows render sorted by mix and there is no reorder affordance', () => {
    renderTable([mon(5), mon(1), mon(3)]);
    const cells = screen.getAllByLabelText(/Mix number/) as HTMLInputElement[];

    expect(cells.map((c) => c.value)).toEqual(['1', '3', '5']);
    expect(screen.queryByTitle(/move up|move down/i)).toBeNull();
    expect(screen.queryByText('☰')).toBeNull();
  });

  it('edits commit on blur, not per keystroke — typing "12" never routes through "1"', () => {
    const { onRenumber } = renderTable([mon(3)]);
    const cell = screen.getByLabelText(/Mix number/);

    fireEvent.change(cell, { target: { value: '1' } });
    fireEvent.change(cell, { target: { value: '12' } });
    expect(onRenumber).not.toHaveBeenCalled();

    fireEvent.blur(cell);
    expect(onRenumber).toHaveBeenCalledTimes(1);
    expect(onRenumber).toHaveBeenCalledWith(3, 12);
  });

  it('a rejected renumber is SHOWN and the cell reverts (I8: no silent path)', () => {
    renderTable([mon(1), mon(2)], vi.fn(() => 'mix 2 already exists'));
    const cell = screen.getAllByLabelText(/Mix number/)[0] as HTMLInputElement;

    fireEvent.change(cell, { target: { value: '2' } });
    fireEvent.blur(cell);

    expect(screen.getByRole('alert').textContent).toMatch(/mix 2 already exists/);
    expect(cell.value).toBe('1');
  });

  it('a cancelled confirm reverts silently — the user said no, that is not an error', () => {
    renderTable([mon(1)], vi.fn(() => 'cancelled'));
    const cell = screen.getByLabelText(/Mix number/) as HTMLInputElement;

    fireEvent.change(cell, { target: { value: '4' } });
    fireEvent.blur(cell);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(cell.value).toBe('1');
  });

  it('an emptied cell is sent as NaN (rejected), never as 0 or a silent no-op', () => {
    const { onRenumber } = renderTable([mon(2)]);
    const cell = screen.getByLabelText(/Mix number/);

    fireEvent.change(cell, { target: { value: '  ' } });
    fireEvent.blur(cell);

    expect(Number.isNaN((onRenumber.mock.calls[0] as unknown as [number, number])[1])).toBe(true);
  });

  it('Escape abandons the draft without renumbering', () => {
    const { onRenumber } = renderTable([mon(2)]);
    const cell = screen.getByLabelText(/Mix number/) as HTMLInputElement;

    fireEvent.change(cell, { target: { value: '9' } });
    fireEvent.keyDown(cell, { key: 'Escape' });
    fireEvent.blur(cell);

    expect(onRenumber).not.toHaveBeenCalled();
    expect(cell.value).toBe('2');
  });

  it('delete hands the MONITOR (by identity) to the handler, not an array index', () => {
    // Sorted rows: the second row on screen is Mix 3 but monitors[1] is Mix 1.
    // An index-based handler would delete the wrong mix.
    const { onDelete } = renderTable([mon(5), mon(1), mon(3)]);
    fireEvent.click(screen.getAllByRole('button', { name: 'X' })[1]);

    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'm-3', mix: 3 }));
  });
});
