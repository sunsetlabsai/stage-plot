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
// 2026-10-26). The key used to live under one fixed name, so signing in as a
// second account on the same browser — every UAT tester with a test account —
// quietly spent the first account's key. Two rules:
//   1. The entry is named per account (`byoaKeyName`), so another account never
//      reads it.
//   2. A key read into memory is re-checked at SEND time against who is signed
//      in now (`keyForSend`). An open tab outlives a sign-in in another tab, and
//      the cross-tab auth broadcast is best-effort (Codex R1 on #197).
// ⚠ A browser SHARED BETWEEN PEOPLE is not designed for (Graham, 2026-10-26).
// The key survives sign-out — that is the convenience #133 bought — and stays on
// disk, readable in devtools, until it is removed in Settings.
// The old un-namespaced localStorage entry is MIGRATED to the first account that
// reads it: on a one-person browser that account is its owner, and nobody
// re-enters a remembered key. A session-scoped one is deleted (see migrateLegacy).

/** The pre-#134 single entry, shared by every account on the browser. Read only to migrate it. */
export const LEGACY_BYOA_KEY = 'showrunr-claude-key';

/** The storage entry for one account's device key. */
export function byoaKeyName(userId: string): string {
  return `${LEGACY_BYOA_KEY}:${userId}`;
}

/** The slice of the DOM Storage API these rules need — so tests can fake it. */
export type KeyStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * Claim the pre-#134 entry for this account — from localStorage ONLY.
 *
 * ★ Codex R2 on #197: sessionStorage is not one store. A tab opened from another
 * gets an independent COPY of it (HTML Standard, document sequences), so "move
 * it once" cannot hold there — each copy would migrate to whichever account
 * reads it in that tab, handing one key to two accounts. localStorage is one
 * store per origin, and two tabs cannot be signed in to different accounts at
 * the same moment (the session is a shared cookie), so a move there happens
 * once. The session-scoped legacy entry is a key the person chose NOT to keep;
 * it is deleted, at the cost of re-entering it once in that tab.
 */
function migrateLegacy(local: KeyStore, session: KeyStore, userId: string): void {
  session.removeItem(LEGACY_BYOA_KEY);
  const legacy = local.getItem(LEGACY_BYOA_KEY);
  if (legacy === null) return;
  const name = byoaKeyName(userId);
  if (!local.getItem(name) && !session.getItem(name)) local.setItem(name, legacy);
  local.removeItem(LEGACY_BYOA_KEY);
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
  if (!userId) return '';
  migrateLegacy(local, session, userId);
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
  migrateLegacy(local, session, userId);
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

/** What a send may carry, decided at the moment of sending (rule 3). */
export type SendKey =
  /** Identity unchanged: send with this key ('' ⇒ no device key; server resolves the rest). */
  | { ok: true; key: string }
  /** Someone else is signed in now, or nobody is: this tab is stale. Send nothing. */
  | { ok: false };

/**
 * Re-check a send against the account signed in NOW, not the one the tab mounted with.
 *
 * `liveUserId` is the session's user id read at send time ('' if none). A mismatch
 * refuses outright rather than sending without the key: the whole tab — owner
 * gate, config, transcript — belongs to the mounted account. On a match the key
 * is re-read from storage, so a removal in another tab's Settings is honoured
 * even though this tab still holds a copy in memory.
 */
export function keyForSend(
  local: KeyStore,
  session: KeyStore,
  mountedUserId: string,
  liveUserId: string,
): SendKey {
  if (!mountedUserId || liveUserId !== mountedUserId) return { ok: false };
  return { ok: true, key: readKey(local, session, mountedUserId) };
}
