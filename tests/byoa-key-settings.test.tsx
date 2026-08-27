// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ByoaKeySettings } from '../components/ByoaKeySettings';
import { BYOA_KEY } from '../lib/byoa-key-storage';

// design-single-backend §3.1, §9 T22 + T24, chunk 4.
//
// This is the ONE component behind both presentations of "manage your key" — the
// standalone /dashboard/settings page and the show-page overlay. The overlay wires
// the host to it through two callbacks; these assert that a key entered here reaches
// those callbacks (so the host updates with no remount, T22) and that the standalone
// render — no callbacks, no host — still works (T24).

const VALID_KEY = 'sk-ant-test-DEVICEKEYVALUE-abcd';
const ACCOUNT_HINT = 'sk-ant-…wxyz';

/** Route fetch by method so load/save/remove can be driven independently. */
function stubFetch(overrides: {
  get?: () => unknown;
  put?: () => { ok: boolean; body: unknown };
  del?: () => { ok: boolean; body: unknown };
} = {}) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url: String(url), method });
      if (method === 'GET') {
        return { ok: true, json: async () => overrides.get?.() ?? { hint: null } } as Response;
      }
      if (method === 'PUT') {
        const r = overrides.put?.() ?? { ok: true, body: { hint: ACCOUNT_HINT } };
        return { ok: r.ok, json: async () => r.body } as Response;
      }
      // DELETE
      const r = overrides.del?.() ?? { ok: true, body: {} };
      return { ok: r.ok, json: async () => r.body } as Response;
    }),
  );
  return calls;
}

// This jsdom build ships node's experimental (and here, non-functional) Storage —
// getItem/setItem throw. The component reaches for `window.localStorage` directly, so
// install a working Map-backed fake, the same shape tests/byoa-key-storage.test.ts
// drives the pure functions with.
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: (i) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', { value: fakeStorage(), configurable: true });
  Object.defineProperty(window, 'sessionStorage', { value: fakeStorage(), configurable: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ByoaKeySettings — standalone, no host (§9 T24)', () => {
  it('renders the key UI with no callbacks wired', async () => {
    stubFetch();
    render(<ByoaKeySettings />);

    // Waits out the async load pass, then the full UI is present.
    expect(await screen.findByText('Claude API key')).toBeTruthy();
    expect(screen.getByPlaceholderText('sk-ant-...')).toBeTruthy();
    // Exact text: "Save to my account" also appears inside the consent paragraph,
    // so a substring regex would match two nodes.
    expect(screen.getByText('Remember on this device')).toBeTruthy();
    expect(screen.getByText('Save to my account')).toBeTruthy();
    // §4.6.5 consent copy travels with the component into either presentation.
    expect(screen.getByText(/deleting your account deletes\s+it too/i)).toBeTruthy();
  });
});

describe('ByoaKeySettings — a device key reaches the host (§9 T22)', () => {
  it('saves to localStorage AND fires onDeviceKeyChange with the key', async () => {
    stubFetch();
    const onDeviceKeyChange = vi.fn();
    const onAccountKeyChange = vi.fn();
    render(
      <ByoaKeySettings onDeviceKeyChange={onDeviceKeyChange} onAccountKeyChange={onAccountKeyChange} />,
    );

    fireEvent.change(await screen.findByPlaceholderText('sk-ant-...'), { target: { value: VALID_KEY } });
    // 'Remember on this device' is the default choice; Save is enabled once there is input.
    fireEvent.click(screen.getByRole('button', { name: /save key/i }));

    await waitFor(() => expect(onDeviceKeyChange).toHaveBeenCalledWith(VALID_KEY));
    // The host learns the key; the account callback is NOT fired for a device save.
    expect(onAccountKeyChange).not.toHaveBeenCalled();
    // And it landed in the store the host reads at mount.
    expect(window.localStorage.getItem(BYOA_KEY)).toBe(VALID_KEY);
  });

  it('a malformed key is rejected before any callback or write', async () => {
    stubFetch();
    const onDeviceKeyChange = vi.fn();
    render(<ByoaKeySettings onDeviceKeyChange={onDeviceKeyChange} />);

    fireEvent.change(await screen.findByPlaceholderText('sk-ant-...'), { target: { value: 'not-a-key' } });
    fireEvent.click(screen.getByRole('button', { name: /save key/i }));

    // No prefix ⇒ the format guard fires; the host is never told a bad key was saved.
    expect(await screen.findByText(/Anthropic keys start with/i)).toBeTruthy();
    expect(onDeviceKeyChange).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(BYOA_KEY)).toBeNull();
  });

  it('removing the device key fires onDeviceKeyChange with an empty string', async () => {
    // Seed a device key so the Remove control renders on load.
    window.localStorage.setItem(BYOA_KEY, VALID_KEY);
    stubFetch();
    const onDeviceKeyChange = vi.fn();
    render(<ByoaKeySettings onDeviceKeyChange={onDeviceKeyChange} />);

    fireEvent.click(await screen.findByRole('button', { name: /remove/i }));

    expect(onDeviceKeyChange).toHaveBeenCalledWith('');
    expect(window.localStorage.getItem(BYOA_KEY)).toBeNull();
  });
});

describe('ByoaKeySettings — an account key reaches the host (§9 T22, §3.2)', () => {
  it('PUTs the key and fires onAccountKeyChange, so the host re-probes', async () => {
    const calls = stubFetch();
    const onDeviceKeyChange = vi.fn();
    const onAccountKeyChange = vi.fn();
    render(
      <ByoaKeySettings onDeviceKeyChange={onDeviceKeyChange} onAccountKeyChange={onAccountKeyChange} />,
    );

    fireEvent.change(await screen.findByPlaceholderText('sk-ant-...'), { target: { value: VALID_KEY } });
    fireEvent.click(screen.getByLabelText(/Save to my account/i));
    fireEvent.click(screen.getByRole('button', { name: /save key/i }));

    await waitFor(() => expect(onAccountKeyChange).toHaveBeenCalledTimes(1));
    // The account save is a server write, not a browser one — nothing hit localStorage,
    // and the device callback is untouched.
    expect(calls.some((c) => c.method === 'PUT' && c.url === '/api/settings/byoa')).toBe(true);
    expect(onDeviceKeyChange).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(BYOA_KEY)).toBeNull();
    // Masked hint only — the key itself is never rendered back (§5.3).
    expect(await screen.findByText(ACCOUNT_HINT)).toBeTruthy();
    expect(screen.queryByText(VALID_KEY)).toBeNull();
  });

  it('removing an account key fires onAccountKeyChange', async () => {
    const calls = stubFetch({ get: () => ({ hint: ACCOUNT_HINT }) });
    const onAccountKeyChange = vi.fn();
    render(<ByoaKeySettings onAccountKeyChange={onAccountKeyChange} />);

    // The account hint loads, giving its own Remove control.
    fireEvent.click(await screen.findByRole('button', { name: /remove/i }));

    await waitFor(() => expect(onAccountKeyChange).toHaveBeenCalledTimes(1));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
  });
});
