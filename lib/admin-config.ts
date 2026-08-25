/**
 * The outcome of a config read.
 *
 * TWO states, not four (design-single-backend §3.2). Config resolves from
 * `process.env` alone, so `'store'` and `error` are states no code can produce:
 * there is nothing to store a value, and `process.env` is a synchronous
 * in-process read with no failure mode — an environment variable cannot be
 * unreachable.
 *
 * The narrowing is deliberate rather than a reserved member kept "just in case".
 * An unreachable union member is the same class of trap as the `__DISABLED__`
 * sentinel deleted alongside it: the type says the state is possible, so a
 * future reader writes a branch for it that can never run. If a store ever
 * returns, adding the member back is one line.
 */
export type ConfigRead =
  | { status: 'ok'; value: string; source: 'env' }
  | { status: 'none' };

/**
 * Read an admin config value from the environment.
 *
 * `claude_tryit_key` → `CLAUDE_TRYIT_KEY`, and so on. Empty string is `none`,
 * not `ok` — an env var set to '' is unconfigured, matching how every caller
 * already treats a falsy value.
 *
 * Async because four routes and `lib/agent-key.ts` await it. The read itself is
 * synchronous; the signature is what keeps this a Redis removal rather than a
 * call-site rewrite.
 */
export async function readAdminConfig(key: string): Promise<ConfigRead> {
  // Trimmed, and this is load-bearing rather than tidiness. A key pasted into
  // the Vercel dashboard with a trailing newline is indistinguishable from a
  // correct one by eye and by `/admin` (which only tests non-empty) — it ships
  // straight to Anthropic and 401s. Every consumer degrades silently on that,
  // so it surfaces as "the AI is bad at charts", not as an error. Cost us a
  // debugging session on 2026-08-25. `admin-auth.ts:31` already trims; this
  // closes the asymmetry.
  const value = process.env[key.toUpperCase()]?.trim();
  // Whitespace-only is unconfigured, not a value — `''` is falsy after trim.
  return value ? { status: 'ok', value, source: 'env' } : { status: 'none' };
}

/**
 * Read an admin config value. Returns null if unconfigured.
 *
 * A thin wrapper over readAdminConfig — one lookup, two shapes. Five callers
 * (auth/google, auth/google/callback, agent chat via agent-key, charts/convert,
 * charts/roadmap/parse, admin/backfill-chart-overlays) collapse every non-`ok`
 * status to null here; callers needing the distinction use readAdminConfig.
 */
export async function getAdminConfig(key: string): Promise<string | null> {
  const read = await readAdminConfig(key);
  return read.status === 'ok' ? read.value : null;
}

/**
 * Read all admin config values (masked for display).
 *
 * All three keys still have live consumers: `google_client_id` and
 * `google_client_secret` by `/api/auth/google` and its callback — PR #153
 * retired Drive in the DESIGN only, and the OAuth routes plus their entry point
 * at `app/[owner]/[show]/page.tsx` are still on main — and `claude_tryit_key`
 * by the three AI routes.
 */
export async function getAllAdminConfig(): Promise<Record<string, { configured: boolean; masked: string }>> {
  const keys = ['google_client_id', 'google_client_secret', 'claude_tryit_key'] as const;
  const result: Record<string, { configured: boolean; masked: string }> = {};

  for (const key of keys) {
    const val = await getAdminConfig(key);
    result[key] = {
      configured: !!val,
      masked: val ? maskSecret(key, val) : '',
    };
  }
  return result;
}

function maskSecret(key: string, value: string): string {
  if (key === 'google_client_id') {
    return value.length > 20 ? `${value.slice(0, 15)}...${value.slice(-10)}` : value;
  }
  if (value.length <= 8) return '••••••••';
  return `${value.slice(0, 7)}...${value.slice(-4)}`;
}
