// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { ChordLabel } from '../components/ChordLabel';

// The builder preview draws the SAME NNS segments as the saved PDF (backlog #204).
afterEach(cleanup);

describe('ChordLabel', () => {
  it('★ numbers: the 7 is a <sup>, never "57" inline', () => {
    const { container } = render(<ChordLabel cell={{ degree: 5, quality: '7', beats: 4 }} mode="numbers" renderKey="G" />);
    expect(container.textContent).toBe('57');
    expect(container.querySelector('sup')?.textContent).toBe('7');
  });
  it('numbers: maj7 is △ + raised 7; minor is a dash; a flat root keeps its ♭', () => {
    const tri = render(<ChordLabel cell={{ degree: 1, quality: 'maj7', beats: 4 }} mode="numbers" renderKey="G" />);
    expect(tri.container.textContent).toBe('1△7');
    cleanup();
    const m = render(<ChordLabel cell={{ degree: 7, alter: -1, quality: 'm', beats: 4 }} mode="numbers" renderKey="G" />);
    expect(m.container.textContent).toBe('♭7–');
  });
  it('letters are unchanged lead-sheet spelling', () => {
    const { container } = render(<ChordLabel cell={{ degree: 6, quality: 'm7', beats: 4 }} mode="letters" renderKey="D" />);
    expect(container.textContent).toBe('Bm7');
    expect(container.querySelector('sup')).toBeNull();
  });
});
