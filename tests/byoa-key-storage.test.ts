import { describe, it, expect } from 'vitest';
import {
  BYOA_KEY,
  readKey,
  initialRemember,
  persistKey,
  type KeyStore,
} from '../lib/byoa-key-storage';

// A fake Storage. Deliberately not jsdom's — these rules are about which of TWO
// stores a value lands in, and a fake makes both directly assertable.
const store = (initial?: string): KeyStore & { value: string | null } => ({
  value: initial ?? null,
  getItem(k: string) {
    return k === BYOA_KEY ? this.value : null;
  },
  setItem(k: string, v: string) {
    if (k === BYOA_KEY) this.value = v;
  },
  removeItem(k: string) {
    if (k === BYOA_KEY) this.value = null;
  },
});

const KEY = 'sk-ant-graham';

describe('readKey', () => {
  it('prefers the remembered (local) key', () => {
    expect(readKey(store(KEY), store('sk-ant-stale'))).toBe(KEY);
  });

  it('falls back to the session key — a path that could never fire before', () => {
    // Nothing wrote to sessionStorage, so this branch was dead code.
    expect(readKey(store(), store(KEY))).toBe(KEY);
  });

  it('returns empty when neither store has one', () => {
    expect(readKey(store(), store())).toBe('');
  });
});

describe('initialRemember — §5 ships the box CHECKED', () => {
  it('is CHECKED on a first visit, so a pasted key survives the next login', () => {
    // The regression: this returned false, so the persist effect took its
    // destructive branch and the key was never written anywhere.
    expect(initialRemember(store(), store())).toBe(true);
  });

  it('is checked when a remembered key is already stored', () => {
    expect(initialRemember(store(KEY), store())).toBe(true);
  });

  it('is UNCHECKED when the key is session-scoped, honouring that choice', () => {
    expect(initialRemember(store(), store(KEY))).toBe(false);
  });
});

describe('persistKey', () => {
  it('remembered: writes to local and leaves nothing in session', () => {
    const local = store();
    const session = store();

    persistKey(local, session, KEY, true);

    expect(local.value).toBe(KEY);
    expect(session.value).toBe(null);
  });

  it('not remembered: writes to SESSION rather than nowhere', () => {
    const local = store();
    const session = store();

    persistKey(local, session, KEY, false);

    // The bug: this branch used to store the key in neither, so the very next
    // reload sent an unauthenticated request and burned the shared try-it quota.
    expect(session.value).toBe(KEY);
    expect(local.value).toBe(null);
  });

  it('unchecking Remember MOVES a saved key, it does not destroy it', () => {
    const local = store(KEY);
    const session = store();

    persistKey(local, session, KEY, false);

    expect(session.value).toBe(KEY);
    expect(local.value).toBe(null);
    expect(readKey(local, session)).toBe(KEY);
  });

  it('clears both stores once the key is gone', () => {
    const local = store(KEY);
    const session = store(KEY);

    persistKey(local, session, '', true);

    expect(local.value).toBe(null);
    expect(session.value).toBe(null);
  });

  it('never leaves the key in both stores at once', () => {
    const local = store(KEY);
    const session = store(KEY);

    persistKey(local, session, KEY, true);
    expect([local.value, session.value]).toEqual([KEY, null]);

    persistKey(local, session, KEY, false);
    expect([local.value, session.value]).toEqual([null, KEY]);
  });
});

describe('round trips — the behaviour the user actually reported', () => {
  it('remembered key survives closing the browser and logging back in', () => {
    const local = store();

    // Session one: first visit, paste a key, defaults apply.
    const first = store();
    const remember = initialRemember(local, first);
    persistKey(local, first, KEY, remember);

    // Session two: new tab, so a FRESH sessionStorage; localStorage persists.
    const second = store();
    expect(readKey(local, second)).toBe(KEY);
    expect(initialRemember(local, second)).toBe(true);
  });

  it('session-scoped key survives a reload but not a new session', () => {
    const local = store();
    const session = store();

    persistKey(local, session, KEY, false);

    // Reload: same tab, same sessionStorage.
    expect(readKey(local, session)).toBe(KEY);
    // New tab: sessionStorage starts empty, and we correctly have no key.
    expect(readKey(local, store())).toBe('');
  });
});
