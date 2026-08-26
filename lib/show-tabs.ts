// Show-page tab visibility. design-single-backend.md §3.3c: collaborators are
// VIEW ONLY, and the spec's last test is that the show UI exposes no edit
// affordance to a collaborator.
//
// ★ WHY THIS IS DERIVED AND NOT JUST A RESET. `tab` lives in state that SURVIVES
// a show change: the route is /[owner]/[show], so navigating from a show you own
// to one you merely collaborate on reuses the component instance rather than
// remounting it. Hiding the tab BUTTONS for a read-only user is not enough,
// because the panels render from the `tab` value alone — an owner sitting on
// Config who navigates to someone else's show would keep the full editor.
//
// The show-load reset now also snaps `tab` back, but that is a data-flow fix a
// future edit can silently regress. This derivation is the guarantee: the
// owner-only panels cannot render for a read-only viewer however `tab` got its
// value.

export type ShowTab = 'perform' | 'mix' | 'config' | 'ai';

/** Tabs carrying edit affordances. Owner-only. */
const OWNER_ONLY_TABS: ReadonlySet<ShowTab> = new Set<ShowTab>(['config', 'ai']);

/**
 * The tab that may actually render, given who is looking.
 *
 * Falls back to 'perform' rather than rendering nothing: a read-only viewer
 * holding an owner-only tab should land on the show, not on a blank page.
 */
export function visibleTab(tab: ShowTab, isReadOnly: boolean): ShowTab {
  return isReadOnly && OWNER_ONLY_TABS.has(tab) ? 'perform' : tab;
}
