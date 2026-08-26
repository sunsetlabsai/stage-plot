import { describe, it, expect } from 'vitest';
import { visibleTab, type ShowTab } from '../lib/show-tabs';

// design-single-backend.md §3.3c — "the show UI exposes no edit affordance to a
// collaborator". Codex R1 HIGH on chunk 6.
//
// THE DEFECT THIS PINS: `tab` is component state on a /[owner]/[show] route, so
// navigating from a show you OWN to one you only collaborate on reuses the
// component and keeps the tab. The tab BUTTONS were gated on !isReadOnly, but
// the panels rendered from `tab` alone — so an owner sitting on Config who moved
// to someone else's show kept the whole editor: ConfigTab inputs, setlist row
// edit/delete, stage-plot editing. Server persistence was already closed by
// useShow's isReadOnly, so nothing would have SAVED — but §3.3c's requirement is
// about the affordance, not just the write.

const ALL: ShowTab[] = ['perform', 'mix', 'config', 'ai'];

describe('visibleTab — a read-only viewer cannot hold an owner-only tab', () => {
  it('sends a read-only viewer on Config back to Perform', () => {
    expect(visibleTab('config', true)).toBe('perform');
  });

  it('sends a read-only viewer on AI back to Perform', () => {
    expect(visibleTab('ai', true)).toBe('perform');
  });

  it('never resolves to an owner-only tab for a read-only viewer, from ANY tab', () => {
    // Enumerated rather than spot-checked: a fifth tab added later must be
    // classified deliberately, and this fails until it is.
    for (const tab of ALL) {
      expect(['perform', 'mix']).toContain(visibleTab(tab, true));
    }
  });
});

describe('visibleTab — the counterexample: an owner keeps every tab', () => {
  it('leaves all four tabs untouched for an owner', () => {
    // ★ THE COUNTEREXAMPLE. A guard that over-corrects — returning 'perform'
    // unconditionally, or treating every tab as owner-only — passes every
    // assertion above and fails only here. Without it, locking the owner out of
    // their own editor reads as success.
    for (const tab of ALL) {
      expect(visibleTab(tab, false)).toBe(tab);
    }
  });
});

describe('visibleTab — the view-only tabs stay reachable', () => {
  it('leaves Perform and Mix alone for a read-only viewer', () => {
    // Collaborators are VIEW ONLY, not shut out — §3.3c keeps membership
    // precisely so an invited show is reachable and readable.
    expect(visibleTab('perform', true)).toBe('perform');
    expect(visibleTab('mix', true)).toBe('mix');
  });
});
