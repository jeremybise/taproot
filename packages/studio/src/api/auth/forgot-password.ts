import type { APIContext } from 'astro';
import {
  MAX_RESET_REQUESTS,
  checkThrottle,
  passwordResetEmail,
  recordFailedAttempt,
  requestPasswordReset,
  resetEmailKey,
  resetIpKey,
} from '@taproot/core';
import { z } from 'zod';

import { apiError, json, mapError } from '../_shared.js';
import { getTaproot } from '../../runtime/guards.js';

const schema = z.object({ email: z.string().min(1) });

/**
 * "I forgot my password."
 *
 * Unauthenticated by definition — the person cannot sign in, which is the entire premise. Three
 * things carry the security of it, and none of them is the token, which `passwordReset.ts` already
 * makes single-use, hashed at rest, and short-lived.
 *
 * 1. **The response never varies.** Same status, same page, same wording whether the address
 *    belongs to somebody, belongs to a deactivated account, or belongs to nobody. A form that
 *    distinguishes them is a membership oracle, and on a CMS the membership list is a list of
 *    people with publishing rights — exactly who a phishing campaign wants named.
 * 2. **It is throttled in its own keyspace.** See `resetEmailKey`: counting these against sign-in
 *    would let anyone lock a colleague out by asking to reset their password ten times.
 * 3. **It is refused outright when no mailer can deliver.** With nothing configured the link goes
 *    to the server log, so offering the form would invite someone to wait for a message that is
 *    sitting in a terminal they cannot see.
 */
export async function POST(context: APIContext): Promise<Response> {
  try {
    const taproot = getTaproot(context.locals);

    const isForm = (context.request.headers.get('content-type') ?? '').includes('form');
    const raw = isForm
      ? Object.fromEntries(await context.request.formData())
      : await context.request.json();

    const parsed = schema.safeParse(raw);
    if (!parsed.success) return apiError(400, 'An email address is required.');

    const email = parsed.data.email.trim();

    /**
     * The same guard the page renders, repeated here because the page is not the boundary.
     *
     * Password auth off means there is no password to reset; no deliverable mailer means the link
     * has nowhere to go. Either way the request cannot succeed, and saying so is not an
     * enumeration risk — it is a fact about the deployment, not about any account.
     */
    if (!taproot.auth.passwordAuthEnabled) {
      return apiError(404, 'Password sign-in is turned off on this site.');
    }
    if (!taproot.mail.delivers) {
      return apiError(
        503,
        'This site cannot send email, so password reset links have to come from an administrator.',
      );
    }

    const ip = context.request.headers.get('cf-connecting-ip');
    const identifiers = [resetEmailKey(email), ...(ip ? [resetIpKey(ip)] : [])];

    const throttle = await checkThrottle(taproot.db.db, identifiers, MAX_RESET_REQUESTS);
    if (throttle.blocked) {
      const message = 'Too many reset requests. Wait a few minutes and try again.';
      return isForm
        ? context.redirect(`/admin/forgot-password?error=${encodeURIComponent(message)}`, 303)
        : apiError(429, message);
    }

    /**
     * Counted before we know whether the address exists, and never cleared.
     *
     * `login.ts` records a *failed* attempt, because there a success is proof of identity. Here
     * there is no success to speak of — the request is anonymous either way — so every request
     * counts, and clearing on "we sent one" would reintroduce the oracle through timing and
     * quota instead of through wording.
     */
    await recordFailedAttempt(taproot.db.db, identifiers);

    const result = await requestPasswordReset(taproot.db.db, email);

    if (result) {
      const resetUrl = new URL('/admin/set-password', taproot.auth.origin);
      resetUrl.searchParams.set('token', result.token);

      /**
       * A send failure is logged and swallowed rather than surfaced.
       *
       * Telling the requester "we could not send that" leaks that there was something to send —
       * an unknown address never reaches this line. The operator finds it in the logs, which is
       * where a broken webhook belongs; the person at the form is told to check their inbox and
       * will ask again when nothing arrives.
       */
      try {
        await taproot.mail.send(
          passwordResetEmail({
            to: result.user.email,
            resetUrl: resetUrl.toString(),
            expiresAt: result.expiresAt,
            host: new URL(taproot.auth.origin).host,
          }),
        );
      } catch (error) {
        console.error('[taproot] password reset email failed to send', error);
      }
    }

    // One response, one code path, whatever happened above.
    return isForm
      ? context.redirect('/admin/forgot-password?sent=1', 303)
      : json({ ok: true });
  } catch (error) {
    return mapError(error);
  }
}
