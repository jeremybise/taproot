import { z } from 'zod';

import { apiError, handle } from './_shared.js';
import { THEME_COOKIE_NAME } from '../admin/theme.js';

const themeSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']),
  /** The page the switcher was used on, so the round trip lands where it started. */
  redirectTo: z.string().optional(),
});

/**
 * Store the admin's colour theme.
 *
 * A form post rather than fetch, so the switcher works with JavaScript off — the same reason the
 * admin is server-rendered at all. Storing it in a cookie rather than `localStorage` is what lets
 * the *server* stamp `data-theme` on `<html>`: the attribute is in the markup before the first
 * byte of CSS, so there is no inline blocking script and no flash of the wrong palette on load.
 *
 * No role gate beyond being signed in. Every role sees the admin, and how it looks is nobody's
 * permission to grant.
 */
export const POST = handle(async ({ context, taproot }) => {
  const form = await context.request.formData();
  const parsed = themeSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return apiError(422, 'Unrecognised theme.');

  const { theme, redirectTo } = parsed.data;

  if (theme === 'system') {
    // Deleted rather than stored as `system`: an absent cookie already means "follow the OS", and
    // two encodings of one state is how they end up disagreeing.
    context.cookies.delete(THEME_COOKIE_NAME, { path: '/' });
  } else {
    context.cookies.set(THEME_COOKIE_NAME, theme, {
      path: '/',
      sameSite: 'lax',
      // A year: a theme choice going stale is not a security boundary, and re-picking it every
      // session would be the actual annoyance.
      maxAge: 60 * 60 * 24 * 365,
      httpOnly: false,
      secure: taproot.auth.secureCookies,
    });
  }

  return context.redirect(safeRedirect(redirectTo), 303);
});

/**
 * Only redirect to a path on this site.
 *
 * `redirectTo` arrives in a form field, so without this `?redirectTo=https://evil.example` would
 * turn the theme switcher into an open redirect — the same guard the login route needs, for the
 * same reason.
 */
function safeRedirect(target: string | undefined): string {
  if (!target) return '/admin';
  if (!target.startsWith('/') || target.startsWith('//')) return '/admin';
  return target;
}
