/**
 * Handing a fresh set of recovery codes back to the account screen that asked for them.
 *
 * Same reasoning as the set-password link: a query string would put ten working codes into browser
 * history, into `Referer`, and into every access log on the way. Read once by the next render and
 * cleared in that same response, so they exist in transit and nowhere else — the server keeps only
 * their hashes, which is exactly why the screen showing them is the one chance to write them down.
 */

export const RECOVERY_COOKIE = 'taproot_recovery_codes';

const MAX_AGE_SECONDS = 300;

export function buildRecoveryCookie(codes: string[], options: { secure: boolean }): string {
  const parts = [
    `${RECOVERY_COOKIE}=${btoa(JSON.stringify(codes))}`,
    'Path=/admin/account',
    `Max-Age=${MAX_AGE_SECONDS}`,
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearRecoveryCookie(options: { secure: boolean }): string {
  const parts = [
    `${RECOVERY_COOKIE}=`,
    'Path=/admin/account',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/** Decode the cookie, treating anything malformed as absent. */
export function readRecoveryCodes(value: string | undefined): string[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(atob(value)) as unknown;
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) return null;
    return parsed as string[];
  } catch {
    return null;
  }
}
