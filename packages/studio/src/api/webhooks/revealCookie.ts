/**
 * Handing a freshly minted signing secret back to the admin who created it.
 *
 * The third instance of this mechanism, after `users/linkCookie.ts` and `api-keys/revealCookie.ts`,
 * and deliberately a third copy rather than a shared helper — for the reason the second one states:
 * they differ in cookie name, path scope and payload, and the shared part is four lines of string
 * building. Merging them would couple three credential-handling paths so a change made for one
 * silently applies to the others.
 *
 * There is one difference worth stating, because it looks like an inconsistency. An API key is
 * *unreadable* afterwards — its row holds a hash — so the cookie is the only chance anyone gets. A
 * webhook secret is stored recoverable, because signing needs it, and this screen still shows it
 * exactly once. Holding a secret is not a reason to display it: a reveal control is a live
 * credential on screen behind whatever unattended session opens the page, and the recovery is
 * rotation, which costs the same two minutes as looking it up would have.
 */

export const WEBHOOK_REVEAL_COOKIE = 'taproot_webhook_secret';

export interface RevealedSecret {
  label: string;
  secret: string;
  /** Whether this is a replacement, so the screen can say what just stopped working. */
  rotated?: boolean;
}

const MAX_AGE_SECONDS = 300;

export function revealCookie(revealed: RevealedSecret, options: { secure: boolean }): string {
  // Base64 so a secret cannot break cookie parsing, and so the value is not casually readable over
  // somebody's shoulder.
  const value = btoa(JSON.stringify(revealed));

  const parts = [
    `${WEBHOOK_REVEAL_COOKIE}=${value}`,
    'Path=/admin/settings/webhooks',
    `Max-Age=${MAX_AGE_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearRevealCookie(options: { secure: boolean }): string {
  const parts = [
    `${WEBHOOK_REVEAL_COOKIE}=`,
    'Path=/admin/settings/webhooks',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/** Decode the cookie, treating anything malformed as absent. */
export function readRevealedSecret(value: string | undefined): RevealedSecret | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(atob(value)) as Partial<RevealedSecret>;
    if (!parsed.label || !parsed.secret) return null;
    return parsed as RevealedSecret;
  } catch {
    return null;
  }
}
