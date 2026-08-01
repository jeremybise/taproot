/**
 * Handing a freshly generated set-password link back to the admin who asked for it.
 *
 * Through a short-lived cookie rather than the query string, which is the obvious alternative and
 * the wrong one: a URL lands in browser history, in the `Referer` of anything the page loads, and
 * in every access log between the browser and the origin. That is a poor place for a credential
 * that grants control of an account for the next two days.
 *
 * The cookie is read once by the users screen and cleared in the same response, so it lives for
 * one render. `HttpOnly` because only the server reads it, and a five-minute `Max-Age` so a
 * forgotten tab does not keep it around.
 */

export const SETUP_LINK_COOKIE = 'taproot_setup_link';

export interface SetupLink {
  email: string;
  token: string;
  expiresAt: string;
}

const MAX_AGE_SECONDS = 300;

export function setupLinkCookie(link: SetupLink, options: { secure: boolean }): string {
  // Base64 so a token containing nothing exotic still cannot break cookie parsing, and so the
  // value is not casually readable over someone's shoulder.
  const value = btoa(JSON.stringify(link));

  const parts = [
    `${SETUP_LINK_COOKIE}=${value}`,
    'Path=/admin/settings/users',
    `Max-Age=${MAX_AGE_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSetupLinkCookie(options: { secure: boolean }): string {
  const parts = [
    `${SETUP_LINK_COOKIE}=`,
    'Path=/admin/settings/users',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/** Decode the cookie, treating anything malformed as absent. */
export function readSetupLink(value: string | undefined): SetupLink | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(atob(value)) as Partial<SetupLink>;
    if (!parsed.email || !parsed.token || !parsed.expiresAt) return null;
    return parsed as SetupLink;
  } catch {
    return null;
  }
}
