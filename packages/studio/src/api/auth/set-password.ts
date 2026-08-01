import type { APIContext } from 'astro';
import {
  PasswordResetError,
  buildSessionCookie,
  consumePasswordResetToken,
  createSession,
} from '@taproot/core';
import { z } from 'zod';

import { apiError, json, mapError } from '../_shared.js';
import { getTaproot } from '../../runtime/guards.js';

const schema = z.object({
  token: z.string().min(1),
  password: z.string().min(1),
  confirm: z.string().optional(),
});

/**
 * Set a password using a one-time link.
 *
 * Unauthenticated, and safely so — the token *is* the authentication, it is single-use, it expires,
 * and consuming it drops every existing session for that account.
 *
 * Signing the person in afterwards is deliberate. They have just proved control of the link and
 * chosen a password; bouncing them to a login form to type it again is friction with no security
 * value, and a new session is issued *after* the old ones are dropped so the account is not left
 * with a live session belonging to whoever prompted the reset.
 */
export async function POST(context: APIContext): Promise<Response> {
  try {
    const taproot = getTaproot(context.locals);

    const isForm = (context.request.headers.get('content-type') ?? '').includes('form');
    const raw = isForm
      ? Object.fromEntries(await context.request.formData())
      : await context.request.json();

    const parsed = schema.safeParse(raw);
    if (!parsed.success) return apiError(400, 'A token and a password are required.');

    const { token, password, confirm } = parsed.data;

    const back = (message: string) =>
      isForm
        ? context.redirect(
            `/admin/set-password?token=${encodeURIComponent(token)}&error=${encodeURIComponent(message)}`,
            303,
          )
        : apiError(400, message);

    // Checked here rather than only in the browser, because the browser is not the boundary and
    // a mismatched confirmation is the one mistake that locks someone out of the account they
    // were just given.
    if (confirm !== undefined && confirm !== password) {
      return back('Those two passwords do not match.');
    }

    let user;
    try {
      user = await consumePasswordResetToken(taproot.db.db, token, password);
    } catch (error) {
      if (!(error instanceof PasswordResetError)) throw error;
      return error.code === 'invalid' && isForm
        ? // An invalid token cannot be retried with the same link, so the error belongs on the
          // login page rather than on a form that will fail again.
          context.redirect(`/admin/login?error=${encodeURIComponent(error.message)}`, 303)
        : back(error.message);
    }

    const { token: sessionToken, expiresAt } = await createSession(taproot.db.db, user.id);
    const cookie = buildSessionCookie(sessionToken, expiresAt, {
      secure: taproot.auth.secureCookies,
    });

    if (isForm) {
      const response = context.redirect('/admin', 303);
      response.headers.append('set-cookie', cookie);
      return response;
    }

    return json({ ok: true }, { headers: { 'set-cookie': cookie } });
  } catch (error) {
    return mapError(error);
  }
}
