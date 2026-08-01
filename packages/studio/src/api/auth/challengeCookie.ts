/**
 * The cookie that carries a half-finished sign-in between the password and the second factor.
 *
 * A separate cookie from the session, and separately named, so the two can never be confused: this
 * one means "the password was right", which is most of the way in and not the whole way. The
 * server-side row is what actually authorises anything — this only names it.
 *
 * `Path=/` rather than scoped to the verify screen, because the browser has to send it to the
 * verify *endpoint* too, and those live under different prefixes.
 */

export const CHALLENGE_COOKIE = 'taproot_login_challenge';

export function buildChallengeCookie(
  token: string,
  expiresAt: Date,
  options: { secure: boolean },
): string {
  const parts = [
    `${CHALLENGE_COOKIE}=${token}`,
    'Path=/',
    `Expires=${expiresAt.toUTCString()}`,
    'HttpOnly',
    // Strict rather than Lax, unlike the session cookie: nothing legitimately arrives at the
    // verify step from another origin, and the session's Lax exists only for the OAuth round trip.
    'SameSite=Strict',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearChallengeCookie(options: { secure: boolean }): string {
  const parts = [
    `${CHALLENGE_COOKIE}=`,
    'Path=/',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}
