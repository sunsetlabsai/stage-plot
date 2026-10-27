// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { PerformTab } from '../app/[owner]/[show]/page';

// UAT S1, second half: a new show lands on Perform with "No setlist yet." and
// nothing pointing at where songs are added. The first half — no panel renders
// from the demo band before the show loads — is the page's `showReady` gate,
// which no harness can render (the page is one 7000-line component).

afterEach(cleanup);

const base = {
  setlist: [],
  setlistReady: true,
  showInfo: { bandName: 'B', eventDate: '', venue: '' },
  isOffline: false,
  slug: 's',
  owner: 'o',
};

describe('PerformTab empty setlist', () => {
  it('the owner gets a link to Config', () => {
    const onOpenConfig = vi.fn();
    render(<PerformTab {...base} isOwner onOpenConfig={onOpenConfig} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add songs in Config' }));
    expect(onOpenConfig).toHaveBeenCalledTimes(1);
  });

  it('a viewer is told the band has no songs, with no Config link', () => {
    render(<PerformTab {...base} isOwner={false} />);
    expect(screen.getByText('No setlist yet.')).toBeTruthy();
    expect(screen.getByText("The band hasn't added any songs.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add songs in Config' })).toBeNull();
  });
});
