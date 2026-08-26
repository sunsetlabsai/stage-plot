// Shape rules for a BYOA Claude key, shared by the settings UI and the server
// route so the browser and the database cannot disagree about what is storable.
//
// Design: docs/design-single-backend.md §4.5, §4.6.
//
// This exists because of a real incident, not a hypothetical: a local 401 was
// once chased as a bad key and turned out to be a CARRIAGE RETURN in a pasted
// value. Copying a key out of a terminal or an email routinely carries \r, \n
// or a trailing space, and every one of those produces an auth failure whose
// message says nothing about whitespace. Normalising here means that class of
// bug cannot reach the Vault, the Anthropic client, or a support conversation.

/** Anthropic key prefix. Keys that do not carry it are not Anthropic keys. */
export const ANTHROPIC_KEY_PREFIX = 'sk-ant-';

/**
 * Shortest key we will store.
 *
 * Mirrors the `length(p_key) < 20` guard in `set_user_secret`
 * (`015_user_secrets_vault.sql`). Below this the masked hint —
 * `left(key,7) + '…' + right(key,4)` — would reveal most of the value, so the
 * mask stops being a mask. The two limits must move together.
 */
export const MIN_KEY_LENGTH = 20;

export type KeyFormatFailure = 'empty' | 'whitespace' | 'prefix' | 'too-short';

export type KeyFormatResult =
  | { ok: true; key: string }
  | { ok: false; reason: KeyFormatFailure };

/**
 * Normalise and validate a pasted key.
 *
 * Surrounding whitespace is STRIPPED rather than rejected — that is the common
 * paste artifact and silently fixing it is the kind thing to do. Whitespace in
 * the MIDDLE is rejected instead: it cannot be a formatting artifact of a
 * single-token credential, so it means the paste is wrong (two values, a
 * truncated copy, a wrapped line) and quietly deleting characters from
 * someone's credential would be worse than telling them.
 */
export function normalizeKey(raw: string): KeyFormatResult {
  const key = raw.trim();

  if (!key) return { ok: false, reason: 'empty' };
  if (/\s/.test(key)) return { ok: false, reason: 'whitespace' };
  if (!key.startsWith(ANTHROPIC_KEY_PREFIX)) return { ok: false, reason: 'prefix' };
  if (key.length < MIN_KEY_LENGTH) return { ok: false, reason: 'too-short' };

  return { ok: true, key };
}

/**
 * User-facing copy for each rejection.
 *
 * No branch echoes the key back — these strings end up in a DOM node and
 * potentially in a screenshot on a support thread (§4.6.3).
 */
export function keyFormatMessage(reason: KeyFormatFailure): string {
  switch (reason) {
    case 'empty':
      return 'Paste your Anthropic API key.';
    case 'whitespace':
      return 'That looks like it contains a line break or a space. Copy the key on its own.';
    case 'prefix':
      return `Anthropic keys start with ${ANTHROPIC_KEY_PREFIX}`;
    case 'too-short':
      return 'That key looks incomplete.';
  }
}
