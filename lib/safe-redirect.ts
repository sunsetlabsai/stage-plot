// Where a `?redirect=` parameter is allowed to send someone.
//
// ★ WHY THIS IS NOT A `startsWith` CHECK. /sign-in used to guard with
// `raw.startsWith('/') && !raw.startsWith('//')` and hand the result straight to
// the browser. That guard reasons about the STRING; the browser reasons with the
// WHATWG URL parser, which normalises backslashes to slashes and strips tab, CR
// and LF before parsing. So every one of these passed the old guard and resolved
// to `http://evil.example` — measured in a real Chrome against a production
// build, not theorised:
//
//     /\evil.example      /\\evil.example     /%5Cevil.example
//     /%5C%5Cevil.example                     /<TAB>/evil.example
//
// The only guard that agrees with the browser is the browser's own parser. Parse
// the candidate against our origin, demand the result IS our origin, and rebuild
// the path from the parsed parts rather than passing the caller's string through.
//
// Pulled into lib/ rather than inlined so it can be unit-tested with those
// vectors — the component it serves cannot be driven by this suite.

/** Where an absent, malformed, or off-origin redirect lands. */
export const DEFAULT_REDIRECT = '/dashboard';

/**
 * A same-origin path safe to hand to `window.location.assign`.
 *
 * Returns a path, never an absolute URL, so the result cannot carry an origin
 * even if a future caller concatenates it.
 *
 * @param raw    the untrusted `?redirect=` value
 * @param origin the current `window.location.origin`
 */
export function internalRedirect(raw: string | null | undefined, origin: string): string {
  if (!raw) return DEFAULT_REDIRECT;

  let url: URL;
  try {
    url = new URL(raw, origin);
  } catch {
    // Unparseable is not a path we should guess at.
    return DEFAULT_REDIRECT;
  }

  // Navigable schemes only, checked BEFORE the origin comparison.
  //
  // `blob:` and `filesystem:` URLs carry an inner origin, so a same-origin
  // `blob:https://showrunr.ai/id` PASSES an origin check — and then its
  // `pathname` is the whole string `"https://showrunr.ai/id"`, not a path. That
  // is not an escape (it is still our origin), but it would return an absolute
  // URL from a function whose contract is "always a path", and a future caller
  // concatenating it would be the real bug. Found by Codex on PR #159.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return DEFAULT_REDIRECT;

  // The whole check. `url.origin` is what the browser would actually navigate
  // to, so anything that disagrees with ours is off-origin however it was spelt.
  if (url.origin !== origin) return DEFAULT_REDIRECT;

  // Rebuilt from parsed parts — the caller's string is never echoed back.
  return `${url.pathname}${url.search}${url.hash}`;
}
