import { describe, it, expect } from 'vitest';
import {
  LEGACY_BYOA_KEY,
  byoaKeyName,
  readKey,
  initialRemember,
  persistKey,
  forgetKeyOnSignOut,
  type KeyStore,
} from '../lib/byoa-key-storage';

// A fake Storage. Deliberately not jsdom's — these rules are about which of TWO
// stores a value lands in, and under WHICH NAME, and a fake makes both directly
// assertable.
const store = (initial: Record<string, string> = {}): KeyStore & { map: Map<string, string> } => {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
};

const KEY = 'sk-ant-graham';
const A = 'user-a';
const B = 'user-b';
const at = (userId: string, value = KEY) => ({ [byoaKeyName(userId)]: value });

describe('readKey', () => {
  it('prefers the remembered (local) key', () => {
    expect(readKey(store(at(A)), store(at(A, 'sk-ant-stale')), A)).toBe(KEY);
  });

  it('falls back to the session key — a path that could never fire before', () => {
    // Nothing wrote to sessionStorage, so this branch was dead code.
    expect(readKey(store(), store(at(A)), A)).toBe(KEY);
  });

  it('returns empty when neither store has one', () => {
    expect(readKey(store(), store(), A)).toBe('');
  });

  it('returns empty with no signed-in account', () => {
    expect(readKey(store(at(A)), store(), '')).toBe('');
  });
});

// ★ #134 / UAT S11 — the shared-browser inheritance.
describe('scoped to the account (#134)', () => {
  it('a different account on the same browser does NOT see the key', () => {
    const local = store();
    const session = store();
    persistKey(local, session, A, KEY, true);

    // Before: one fixed entry, so B read A's key and spent on A's bill.
    expect(readKey(local, session, B)).toBe('');
    expect(readKey(local, session, A)).toBe(KEY);
  });

  it('sign-out REMOVES the leaving account\'s key from both stores, not just hides it', () => {
    const local = store(at(A));
    const session = store(at(A));
    forgetKeyOnSignOut(local, session, A);
    expect(local.map.size).toBe(0);
    expect(session.map.size).toBe(0);
  });

  it('sign-out leaves another account\'s key alone', () => {
    const local = store({ ...at(A), ...at(B, 'sk-ant-b') });
    forgetKeyOnSignOut(local, store(), A);
    expect(readKey(local, store(), B)).toBe('sk-ant-b');
  });

  it('the legacy un-namespaced key is DELETED on read, never adopted', () => {
    // Nobody can say whose it was; adopting it is the inheritance being fixed.
    const local = store({ [LEGACY_BYOA_KEY]: KEY });
    const session = store({ [LEGACY_BYOA_KEY]: KEY });
    expect(readKey(local, session, A)).toBe('');
    expect(local.map.has(LEGACY_BYOA_KEY)).toBe(false);
    expect(session.map.has(LEGACY_BYOA_KEY)).toBe(false);
  });

  it('the legacy key goes on read even with no account, and on sign-out', () => {
    const local = store({ [LEGACY_BYOA_KEY]: KEY });
    readKey(local, store(), '');
    expect(local.map.has(LEGACY_BYOA_KEY)).toBe(false);

    const again = store({ [LEGACY_BYOA_KEY]: KEY });
    forgetKeyOnSignOut(again, store(), '');
    expect(again.map.has(LEGACY_BYOA_KEY)).toBe(false);
  });

  it('a write with no account throws rather than saving a key nobody can read', () => {
    expect(() => persistKey(store(), store(), '', KEY, true)).toThrow(/signed-in account/);
  });
});

describe('initialRemember — §5 ships the box CHECKED', () => {
  it('is CHECKED on a first visit, so a pasted key survives the next login', () => {
    // The regression: this returned false, so the persist effect took its
    // destructive branch and the key was never written anywhere.
    expect(initialRemember(store(), store(), A)).toBe(true);
  });

  it('is checked when a remembered key is already stored', () => {
    expect(initialRemember(store(at(A)), store(), A)).toBe(true);
  });

  it('is UNCHECKED when the key is session-scoped, honouring that choice', () => {
    expect(initialRemember(store(), store(at(A)), A)).toBe(false);
  });
});

describe('persistKey', () => {
  const name = byoaKeyName(A);

  it('remembered: writes to local and leaves nothing in session', () => {
    const local = store();
    const session = store();

    persistKey(local, session, A, KEY, true);

    expect(local.getItem(name)).toBe(KEY);
    expect(session.getItem(name)).toBe(null);
  });

  it('not remembered: writes to SESSION rather than nowhere', () => {
    const local = store();
    const session = store();

    persistKey(local, session, A, KEY, false);

    // The bug: this branch used to store the key in neither, so the very next
    // reload sent an unauthenticated request and burned the shared try-it quota.
    expect(session.getItem(name)).toBe(KEY);
    expect(local.getItem(name)).toBe(null);
  });

  it('unchecking Remember MOVES a saved key, it does not destroy it', () => {
    const local = store(at(A));
    const session = store();

    persistKey(local, session, A, KEY, false);

    expect(session.getItem(name)).toBe(KEY);
    expect(local.getItem(name)).toBe(null);
    expect(readKey(local, session, A)).toBe(KEY);
  });

  it('clears both stores once the key is gone', () => {
    const local = store(at(A));
    const session = store(at(A));

    persistKey(local, session, A, '', true);

    expect(local.getItem(name)).toBe(null);
    expect(session.getItem(name)).toBe(null);
  });

  it('never leaves the key in both stores at once', () => {
    const local = store(at(A));
    const session = store(at(A));

    persistKey(local, session, A, KEY, true);
    expect([local.getItem(name), session.getItem(name)]).toEqual([KEY, null]);

    persistKey(local, session, A, KEY, false);
    expect([local.getItem(name), session.getItem(name)]).toEqual([null, KEY]);
  });
});

describe('round trips — the behaviour the user actually reported', () => {
  it('remembered key survives closing the browser and logging back in', () => {
    const local = store();

    // Session one: first visit, paste a key, defaults apply.
    const first = store();
    const remember = initialRemember(local, first, A);
    persistKey(local, first, A, KEY, remember);

    // Session two: new tab, so a FRESH sessionStorage; localStorage persists.
    const second = store();
    expect(readKey(local, second, A)).toBe(KEY);
    expect(initialRemember(local, second, A)).toBe(true);
  });

  it('session-scoped key survives a reload but not a new session', () => {
    const local = store();
    const session = store();

    persistKey(local, session, A, KEY, false);

    // Reload: same tab, same sessionStorage.
    expect(readKey(local, session, A)).toBe(KEY);
    // New tab: sessionStorage starts empty, and we correctly have no key.
    expect(readKey(local, store(), A)).toBe('');
  });
});
