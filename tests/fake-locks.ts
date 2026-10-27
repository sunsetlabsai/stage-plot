// A minimal in-memory Web Locks manager (exclusive mode only) for tests: grant,
// queue, ifAvailable, steal, and signal-abort, per the spec's observable behaviour.
// One instance stands for one browser; every "tab" in a test shares it.

type Callback = (lock: { name: string } | null) => unknown;

interface Waiter {
  cb: Callback;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

interface Holder {
  id: number;
  reject: (e: unknown) => void;
}

const abortError = () => new DOMException('The lock request was aborted.', 'AbortError');

export function fakeLocks() {
  const holders = new Map<string, Holder | null>();
  const queues = new Map<string, Waiter[]>();
  let ids = 0;

  function grant(name: string, w: Waiter) {
    const id = ++ids;
    holders.set(name, { id, reject: w.reject });
    Promise.resolve()
      .then(() => w.cb({ name }))
      .then(
        (v) => {
          if (holders.get(name)?.id === id) { holders.set(name, null); next(name); }
          w.resolve(v);
        },
        (e) => {
          if (holders.get(name)?.id === id) { holders.set(name, null); next(name); }
          w.reject(e);
        },
      );
  }

  function next(name: string) {
    const q = queues.get(name) ?? [];
    const w = q.shift();
    if (w) grant(name, w);
  }

  const manager = {
    request(
      name: string,
      optsOrCb: { ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal } | Callback,
      maybeCb?: Callback,
    ): Promise<unknown> {
      const opts = typeof optsOrCb === 'function' ? {} : optsOrCb;
      const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb)!;
      return new Promise((resolve, reject) => {
        const w: Waiter = { cb, resolve, reject };
        const q = queues.get(name) ?? [];
        queues.set(name, q);
        if (opts.steal) {
          const h = holders.get(name);
          if (h) { holders.set(name, null); h.reject(abortError()); }
          grant(name, w);
          return;
        }
        if (holders.get(name) || q.length > 0) {
          if (opts.ifAvailable) {
            Promise.resolve().then(() => cb(null)).then(resolve, reject);
            return;
          }
          q.push(w);
          opts.signal?.addEventListener('abort', () => {
            const i = q.indexOf(w);
            if (i >= 0) { q.splice(i, 1); reject(abortError()); }
          });
          return;
        }
        grant(name, w);
      });
    },
    /** Test helper: is anyone holding `name`? */
    held(name: string) {
      return !!holders.get(name);
    },
  };
  return manager;
}
