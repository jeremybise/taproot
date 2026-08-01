import type { APIContext } from 'astro';
import {
  buildSessionCookie,
  checkThrottle,
  clearAttempts,
  consumeLoginChallenge,
  createSession,
  emailKey,
  ipKey,
  recordFailedAttempt,
  resolveLoginChallenge,
  verifyTwoFactor,
} from '@taprootcms/core';

import { apiError, json, mapError } from '../_shared.js';
import { getTaproot } from '../../runtime/guards.js';
import { CHALLENGE_COOKIE, clearChallengeCookie } from './challengeCookie.js';

/**
 * The second factor.
 *
 * Throttled with the same counters the password step uses, and that is not belt and braces: a
 * six-digit code is a million possibilities, which is nothing to a script. Without a limit here,
 * two-factor authentication would be a speed bump on an account whose password had already been
 * guessed or phished.
 *
 * The challenge is consumed on success and left alone on failure, so a mistyped digit does not
 * cost someone their sign-in — the throttle is what bounds the retries instead.
 */
export async function POST(context: APIContext): Promise<Response> {
  try {
    const taproot = getTaproot(context.locals);

    const isForm = (context.request.headers.get('content-type') ?? '').includes('form');
    const raw = isForm
      ? Object.fromEntries(await context.request.formData())
      : await context.request.json();

    const code = String((raw as { code?: unknown }).code ?? '');
    const next = safeRedirect(String((raw as { next?: unknown }).next ?? ''));

    const challengeToken = context.request.headers
      .get('cookie')
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${CHALLENGE_COOKIE}=`))
      ?.slice(CHALLENGE_COOKIE.length + 1);

    const expired = () => {
      const message = 'That sign-in timed out. Enter your email and password again.';
      const response = isForm
        ? context.redirect(`/admin/login?error=${encodeURIComponent(message)}`, 303)
        : apiError(401, message);
      response.headers.append(
        'set-cookie',
        clearChallengeCookie({ secure: taproot.auth.secureCookies }),
      );
      return response;
    };

    if (!challengeToken) return expired();

    const user = await resolveLoginChallenge(taproot.db.db, challengeToken);
    if (!user) return expired();

    const identifiers = [emailKey(user.email), ...clientIp(context).map(ipKey)];

    const throttle = await checkThrottle(taproot.db.db, identifiers);
    if (throttle.blocked) {
      const message = 'Too many attempts. Wait a few minutes and try again.';
      return isForm
        ? context.redirect(`/admin/verify?error=${encodeURIComponent(message)}`, 303)
        : apiError(429, message);
    }

    if (!(await verifyTwoFactor(taproot.db.db, user.id, code))) {
      await recordFailedAttempt(taproot.db.db, identifiers);

      const message = 'That code is not right. Try the current one, or a recovery code.';
      return isForm
        ? context.redirect(`/admin/verify?error=${encodeURIComponent(message)}`, 303)
        : apiError(401, message);
    }

    await clearAttempts(taproot.db.db, identifiers);
    await consumeLoginChallenge(taproot.db.db, challengeToken);

    const { token, expiresAt } = await createSession(taproot.db.db, user.id);
    const response = isForm
      ? context.redirect(next, 303)
      : json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });

    response.headers.append(
      'set-cookie',
      buildSessionCookie(token, expiresAt, { secure: taproot.auth.secureCookies }),
    );
    response.headers.append(
      'set-cookie',
      clearChallengeCookie({ secure: taproot.auth.secureCookies }),
    );
    return response;
  } catch (error) {
    return mapError(error);
  }
}

function clientIp(context: APIContext): string[] {
  const address = context.request.headers.get('cf-connecting-ip');
  return address ? [address] : [];
}

function safeRedirect(target: string): string {
  if (!target || !target.startsWith('/') || target.startsWith('//')) return '/admin';
  return target;
}
