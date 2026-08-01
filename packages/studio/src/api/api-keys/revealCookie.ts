/**
 * Handing a freshly minted API key back to the admin who created it.
 *
 * The same mechanism as `users/linkCookie.ts`, for the same reason and against the same tempting
 * alternative: a URL lands in browser history, in the `Referer` of anything the page loads, and in
 * every access log between the browser and the origin. A key placed there is a credential that
 * reads content until somebody revokes it.
 *
 * This is the only moment the raw token exists outside the request that generated it — nothing
 * stores it and no endpoint can read it back, so if the admin loses it the answer is a new key
 * rather than a lookup. The cookie is read once by the screen and cleared in the same response.
 *
 * Deliberately *not* generalised with `linkCookie.ts` into one helper. They differ in cookie name,
 * path scope, and payload, and the shared part is four lines of string building — merging them
 * would couple two credential-handling paths so that a change made for one silently applies to the
 * other.
 */

export const API_KEY_REVEAL_COOKIE = 'taproot_api_key';

export interface RevealedKey {
  label: string;
  token: string;
}

const MAX_AGE_SECONDS = 300;

export function revealCookie(revealed: RevealedKey, options: { secure: boolean }): string {
  // Base64 so a token cannot break cookie parsing, and so the value is not casually readable over
  // somebody's shoulder.
  const value = btoa(JSON.stringify(revealed));

  const parts = [
    `${API_KEY_REVEAL_COOKIE}=${value}`,
    'Path=/admin/settings/api-keys',
    `Max-Age=${MAX_AGE_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearRevealCookie(options: { secure: boolean }): string {
  const parts = [
    `${API_KEY_REVEAL_COOKIE}=`,
    'Path=/admin/settings/api-keys',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/** Decode the cookie, treating anything malformed as absent. */
export function readRevealedKey(value: string | undefined): RevealedKey | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(atob(value)) as Partial<RevealedKey>;
    if (!parsed.label || !parsed.token) return null;
    return parsed as RevealedKey;
  } catch {
    return null;
  }
}
