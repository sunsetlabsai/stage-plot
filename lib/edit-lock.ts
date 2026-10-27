// One editing tab per show per browser (docs/design-version-checked-save.md §4.0).
//
// The show's storage entry is shared by every tab; each tab's pending edit is not.
// So only the tab holding `showrunr-edit-{id}` writes the entry or sends saves.
// The browser releases the lock when the holding tab closes; a waiting tab then
// takes it. "Edit here" steals it, and the old tab is told at once.

export type LockState =
  /** Asking: nothing may be written yet. */
  | 'pending'
  /** This tab edits. */
  | 'held'
  /** Another tab of this browser edits this show; this one is view-only. */
  | 'elsewhere'
  /** No Web Locks (old browser, non-HTTPS): edit as before — a documented limit (§4.0 item 6). */
  | 'unsupported';

export interface EditLock {
  /** Take the lock from the tab holding it (after the owner confirms). */
  steal(): void;
  /** Stop holding or waiting (unmount, show change). */
  release(): void;
}

type Locks = Pick<LockManager, 'request'>;

export const lockName = (showId: string) => `showrunr-edit-${showId}`;

/**
 * Hold the show's edit lock for as long as this returns un-released.
 * `onChange` is called synchronously with every state, so a caller can stop
 * writing in the same task the lock is lost.
 */
export function acquireEditLock(
  showId: string,
  onChange: (state: LockState) => void,
  locks: Locks | null | undefined = typeof navigator !== 'undefined' ? navigator.locks : undefined,
): EditLock {
  if (!locks || typeof locks.request !== 'function') {
    onChange('unsupported');
    return { steal() {}, release() {} };
  }

  const lm: Locks = locks;
  const name = lockName(showId);
  let done = false;
  // Resolving this ends the current hold; each grant gets a fresh one.
  let letGo: (() => void) | null = null;
  // Aborts a queued (waiting) request on release.
  const waiting = new AbortController();
  // Bumped per request, so a superseded request's callbacks are ignored.
  let generation = 0;

  const hold = (gen: number) => new Promise<void>((resolve) => {
    letGo = resolve;
    if (done || gen !== generation) { resolve(); return; }
    onChange('held');
  });

  // A stolen hold rejects its request with AbortError: this tab no longer edits.
  const lost = (gen: number) => () => {
    if (done || gen !== generation) return;
    onChange('elsewhere');
    wait();
  };

  function wait() {
    const gen = ++generation;
    lm.request(name, { signal: waiting.signal }, () => hold(gen)).catch(lost(gen));
  }

  onChange('pending');
  const first = ++generation;
  lm.request(name, { ifAvailable: true }, (lock) => {
    if (lock) return hold(first);
    if (!done && first === generation) {
      onChange('elsewhere');
      wait();
    }
    return undefined;
  }).catch(lost(first));

  return {
    steal() {
      if (done) return;
      const gen = ++generation;
      lm.request(name, { steal: true }, () => hold(gen)).catch(lost(gen));
    },
    release() {
      if (done) return;
      done = true;
      waiting.abort();
      letGo?.();
    },
  };
}
