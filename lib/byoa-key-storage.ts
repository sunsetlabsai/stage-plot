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
//
// ★ SCOPED TO THIS BROWSER *AND* THIS ACCOUNT (issue #134, UAT S11, ruled
// 2026-10-26). The key used to live under one fixed name, so whoever signed in
// next on a shared browser inherited the previous person's key and spent
// against their Anthropic bill. Two rules close that, and each covers a case the
// other misses:
//   1. The entry is named per account (`byoaKeyName`), so a different user never
//      reads it — including when nobody signed out first.
//   2. An explicit sign-out removes the leaving user's entry
//      (`forgetKeyOnSignOut`), so it is not left on disk for the next person to
//      lift out of devtools. Namespacing alone hides a key; it does not remove it.
// The old un-namespaced entry cannot be attributed to anyone, so it is DELETED on
// first read rather than adopted by whoever signs in first — adopting it is the
// exact inheritance this fixes. Cost: one re-entry per existing device key.

/** The pre-#134 single entry, shared by every account on the browser. Read only to delete it. */
export const LEGACY_BYOA_KEY = 'showrunr-claude-key';

/** The storage entry for one account's device key. */
export function byoaKeyName(userId: string): string {
  return `${LEGACY_BYOA_KEY}:${userId}`;
}

/** The slice of the DOM Storage API these rules need — so tests can fake it. */
export type KeyStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function dropLegacy(local: KeyStore, session: KeyStore): void {
  local.removeItem(LEGACY_BYOA_KEY);
  session.removeItem(LEGACY_BYOA_KEY);
}

function requireUser(userId: string): void {
  // Every writer is a signed-in surface (AI tab is owner-only, settings is behind
  // the /dashboard guard). An empty id here would write a key nobody can read,
  // after the UI said "Saved" — fail loudly instead.
  if (!userId) throw new Error('byoa-key-storage: a device key needs a signed-in account');
}

/**
 * The key to start the session with, for this account. No account ⇒ no key.
 *
 * localStorage wins: it is the "remembered" store, and `persistKey` guarantees
 * a key is never in both at once, so the order only matters if something else
 * wrote one.
 */
export function readKey(local: KeyStore, session: KeyStore, userId: string): string {
  dropLegacy(local, session);
  if (!userId) return '';
  const name = byoaKeyName(userId);
  return local.getItem(name) || session.getItem(name) || '';
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
export function initialRemember(local: KeyStore, session: KeyStore, userId: string): boolean {
  if (!userId) return true;
  const name = byoaKeyName(userId);
  if (local.getItem(name)) return true;
  if (session.getItem(name)) return false;
  return true;
}

/**
 * Write this account's key to exactly one store, and never leave a copy in the other.
 *
 * Unchecking Remember now MOVES the key to sessionStorage — it survives a
 * reload and dies with the tab. Previously it destroyed the key outright,
 * which is how a saved key could vanish and every send after it fall back to
 * the shared per-IP try-it quota.
 */
export function persistKey(
  local: KeyStore,
  session: KeyStore,
  userId: string,
  apiKey: string,
  remember: boolean,
): void {
  requireUser(userId);
  dropLegacy(local, session);
  const name = byoaKeyName(userId);
  if (!apiKey) {
    local.removeItem(name);
    session.removeItem(name);
    return;
  }
  if (remember) {
    local.setItem(name, apiKey);
    session.removeItem(name);
  } else {
    session.setItem(name, apiKey);
    local.removeItem(name);
  }
}

/**
 * An explicit sign-out: the leaving account's device key goes with it (rule 2 above).
 *
 * Only an explicit sign-out — NOT a token expiry or a SIGNED_OUT auth event,
 * which can fire without the person leaving the browser. "Save to my account" is
 * the option that follows you between sign-ins.
 */
export function forgetKeyOnSignOut(local: KeyStore, session: KeyStore, userId: string): void {
  dropLegacy(local, session);
  if (!userId) return;
  const name = byoaKeyName(userId);
  local.removeItem(name);
  session.removeItem(name);
}
