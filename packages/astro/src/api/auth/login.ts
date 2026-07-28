import type { APIContext } from 'astro';
import { buildSessionCookie, createSession, verifyCredentials } from '@taproot/core';
import { z } from 'zod';

import { apiError, json, mapError } from '../_shared.js';
import { getTaproot } from '../../runtime/guards.js';

const loginSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
  /** Where to send the browser after a successful sign-in. */
  redirectTo: z.string().optional(),
});

/**
 * Development credential sign-in.
 *
 * Gated on `auth.devCredentialsEnabled`, which `resolveAuthConfig` only sets in development with
 * an explicit opt-in — and which makes the app refuse to boot if it is requested anywhere else.
 * The check is repeated here rather than trusted from configuration alone, because this endpoint
 * existing at all in production would be the actual vulnerability.
 */
export async function POST(context: APIContext): Promise<Response> {
  try {
    const taproot = getTaproot(context.locals);

    if (!taproot.auth.devCredentialsEnabled) {
      return apiError(404, 'Password sign-in is not available.');
    }

    const contentType = context.request.headers.get('content-type') ?? '';
    const input = contentType.includes('application/json')
      ? loginSchema.parse(await context.request.json())
      : loginSchema.parse(Object.fromEntries(await context.request.formData()));

    const user = await verifyCredentials(taproot.db.db, input.email, input.password);
    if (!user) {
      // One message for every failure mode, so this cannot be used to enumerate accounts.
      const message = 'That email and password combination was not recognised.';
      return wantsHtml(context)
        ? context.redirect(`/admin/login?error=${encodeURIComponent(message)}`, 303)
        : apiError(401, message);
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
