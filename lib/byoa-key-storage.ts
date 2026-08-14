// Where a BYOA Claude key lives in the browser.
//
// Design docs/design-ai-key-availability.md §5. The key is "stored in this
// browser only" and §5's mock ships the Remember box CHECKED. The
// implementation defaulted it to unchecked for anyone who did not already have
// a key saved, and the unchecked branch wrote the key NOWHERE while clearing
// both stores — so the box was a footgun rather than a choice, and the
// sessionStorage read below could never fire.
//
// Pulled out of page.tsx because the storage rules are the whole feature and
// they lived inside a 6700-line component that no harness can drive.

export const BYOA_KEY = 'showrunr-claude-key';

/** The slice of the DOM Storage API these rules need — so tests can fake it. */
export type KeyStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * The key to start the session with.
 *
 * localStorage wins: it is the "remembered" store, and `persistKey` guarantees
 * a key is never in both at once, so the order only matters if something else
 * wrote one.
 */
export function readKey(local: KeyStore, session: KeyStore): string {
  return local.getItem(BYOA_KEY) || session.getItem(BYOA_KEY) || '';
}

/**
 * Whether the Remember box starts checked.
 *
 * A key in localStorage means the last choice was to remember it; a key in
 * sessionStorage means the choice was explicitly not to. Neither is a first
 * visit — and §5's mock ships that box checked, because someone who pastes a
 * key is telling us they want the AI tab to work, not that they want to paste
 * it again tomorrow.
 */
export function initialRemember(local: KeyStore, session: KeyStore): boolean {
  if (local.getItem(BYOA_KEY)) return true;
  if (session.getItem(BYOA_KEY)) return false;
  return true;
}

/**
 * Write the key to exactly one store, and never leave a copy in the other.
 *
 * Unchecking Remember now MOVES the key to sessionStorage — it survives a
 * reload and dies with the tab. Previously it destroyed the key outright,
 * which is how a saved key could vanish and every send after it fall back to
 * the shared per-IP try-it quota.
 */
export function persistKey(
  local: KeyStore,
  session: KeyStore,
  apiKey: string,
  remember: boolean,
): void {
  if (!apiKey) {
    local.removeItem(BYOA_KEY);
    session.removeItem(BYOA_KEY);
    return;
  }
  if (remember) {
    local.setItem(BYOA_KEY, apiKey);
    session.removeItem(BYOA_KEY);
  } else {
    session.setItem(BYOA_KEY, apiKey);
    local.removeItem(BYOA_KEY);
  }
}
