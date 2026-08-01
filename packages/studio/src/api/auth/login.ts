import type { APIContext } from 'astro';
import {
  buildSessionCookie,
  checkThrottle,
  clearAttempts,
  createLoginChallenge,
  createSession,
  emailKey,
  ipKey,
  recordFailedAttempt,
  twoFactorStatus,
  verifyCredentials,
} from '@taproot/core';
import { z } from 'zod';

import { apiError, json, mapError } from '../_shared.js';
import { getTaproot } from '../../runtime/guards.js';
import { buildChallengeCookie } from './challengeCookie.js';

const loginSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
  /** Where to send the browser after a successful sign-in. */
  redirectTo: z.string().optional(),
});

/**
 * Email and password sign-in.
 *
 * This was a development-only provider that returned 404 unless an env var switched it on. It is
 * now the primary way in, which changes what the route owes: a throttle, and an honest 404 only
 * when password auth has actually been turned off.
 *
 * The configuration check stays, and still checks configuration rather than trusting the caller —
 * a deployment that has chosen OAuth-only should not have a password endpoint quietly answering.
 */
export async function POST(context: APIContext): Promise<Response> {
  try {
    const taproot = getTaproot(context.locals);

    if (!taproot.auth.passwordAuthEnabled) {
      return apiError(404, 'Password sign-in is not available.');
    }

    const contentType = context.request.headers.get('content-type') ?? '';
    const input = contentType.includes('application/json')
      ? loginSchema.parse(await context.request.json())
      : loginSchema.parse(Object.fromEntries(await context.request.formData()));

    /**
     * Both identifiers, so neither gap is left open: per-email stops one account being ground
     * down, per-IP stops one client trying a common password against every address it can name.
     */
    const identifiers = [emailKey(input.email), ...clientIp(context).map(ipKey)];

    /**
     * Checked before the password is verified, not after.
     *
     * Verification is 210,000 PBKDF2 iterations by design. Doing that work and *then* refusing
     * would turn the throttle into an amplifier — an attacker past the limit would still be
     * spending the server's CPU on every request.
     */
    const throttle = await checkThrottle(taproot.db.db, identifiers);
    if (throttle.blocked) {
      const message =
        'Too many sign-in attempts. Wait a few minutes and try again.';
      return wantsHtml(context)
        ? context.redirect(`/admin/login?error=${encodeURIComponent(message)}`, 303)
        : apiError(429, message);
    }

    const user = await verifyCredentials(taproot.db.db, input.email, input.password);
    if (!user) {
      await recordFailedAttempt(taproot.db.db, identifiers);

      // One message for every failure mode, so this cannot be used to enumerate accounts — and
      // the throttle status is not disclosed either, for the same reason.
      const message = 'That email and password combination was not recognised.';
      return wantsHtml(context)
        ? context.redirect(`/admin/login?error=${encodeURIComponent(message)}`, 303)
        : apiError(401, message);
    }

    await clearAttempts(taproot.db.db, identifiers);

    /**
     * A correct password is not a session when a second factor is enrolled.
     *
     * The half-finished sign-in becomes a short-lived, single-use, revocable challenge row, and
     * the browser gets a cookie naming it rather than a session. Issuing the session first and
     * "checking 2FA later" would mean the password alone had already granted access.
     */
    if ((await twoFactorStatus(taproot.db.db, user.id)).enabled) {
      const challenge = await createLoginChallenge(taproot.db.db, user.id);
      const cookie = buildChallengeCookie(challenge.token, challenge.expiresAt, {
        secure: taproot.auth.secureCookies,
      });

      if (wantsHtml(context)) {
        const response = context.redirect(
          `/admin/verify?next=${encodeURIComponent(safeRedirect(input.redirectTo))}`,
          303,
        );
        response.headers.append('set-cookie', cookie);
        return response;
      }

      return json({ twoFactorRequired: true }, { status: 202, headers: { 'set-cookie': cookie } });
    }

    const { token, expiresAt } = await createSession(taproot.db.db, user.id);
    const cookie = buildSessionCookie(token, expiresAt, { secure: taproot.auth.secureCookies });

    if (wantsHtml(context)) {
      const response = context.redirect(safeRedirect(input.redirectTo), 303);
      response.headers.append('set-cookie', cookie);
      return response;
    }

    return json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } }, {
      headers: { 'set-cookie': cookie },
    });
  } catch (error) {
    return mapError(error);
  }
}

/**
 * The client address, as far as it can be trusted.
 *
 * `CF-Connecting-IP` is set by Cloudflare and cannot be spoofed by the client on that path, which
 * is the production target. `X-Forwarded-For` is *not* consulted: any client can send it, so
 * throttling on it would let an attacker rotate a header to reset their own counter — and worse,
 * lock out an innocent address by claiming it.
 *
 * Returns an empty list when there is no trustworthy address, which leaves the per-email limit
 * doing the work rather than throttling every request behind one proxy as if it were one client.
 */
function clientIp(context: APIContext): string[] {
  const address = context.request.headers.get('cf-connecting-ip');
  return address ? [address] : [];
}

function wantsHtml(context: APIContext): boolean {
  const contentType = context.request.headers.get('content-type') ?? '';
  return contentType.includes('form');
}

/**
 * Only allow redirects to a path on this site.
 *
 * Without this, `?redirectTo=https://evil.example` would turn the login form into an open
 * redirect that phishing can hang off.
 */
function safeRedirect(target: string | undefined): string {
  if (!target) return '/admin';
  if (!target.startsWith('/') || target.startsWith('//')) return '/admin';
  return target;
}
