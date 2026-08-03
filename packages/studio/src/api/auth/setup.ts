import type { APIContext } from 'astro';
import {
  assertUsablePassword,
  buildSessionCookie,
  countUsers,
  createFirstAdmin,
  createSession,
  PasswordResetError,
} from '@taprootcms/core';
import { z } from 'zod';

import { apiError, json, mapError } from '../_shared.js';
import { getTaproot } from '../../runtime/guards.js';

const setupSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(120),
  password: z.string().min(1),
});

/**
 * Create the first administrator on an empty install.
 *
 * **The only unauthenticated write path in the admin.** It exists because email/password sign-in
 * has no equivalent of the OAuth land-grab that used to bootstrap a deployment: with no OAuth and
 * no self-signup, a fresh database has no account and no way to make one.
 *
 * Three things keep it safe, and all three are necessary:
 *
 *  1. `createFirstAdmin` does the check and the insert in **one statement**, so two requests
 *     arriving together cannot both succeed. The guard is there and not here, because a check in a
 *     route is a check with a gap after it.
 *  2. It is refused the moment *any* user exists — not any admin. A deployment with a single
 *     viewer in it has been set up.
 *  3. The password has to clear the same minimum as every other one.
 *
 * The successful caller is signed in immediately. Leaving them to type the password they just
 * chose into a login form adds nothing: they demonstrably know it, and the alternative is a
 * redirect that looks like a failure.
 */
export async function POST(context: APIContext): Promise<Response> {
  try {
    const taproot = getTaproot(context.locals);

    if (!taproot.auth.passwordAuthEnabled) {
      return apiError(404, 'Password sign-in is not available.');
    }

    const isForm = (context.request.headers.get('content-type') ?? '').includes('form');
    const raw = isForm
      ? Object.fromEntries(await context.request.formData())
      : await context.request.json();

    const back = (message: string) =>
      isForm
        ? context.redirect(`/admin/setup?error=${encodeURIComponent(message)}`, 303)
        : apiError(400, message);

    // Cheap pre-check so the common "already set up" case gets a clear answer rather than a
    // silent no-op. The real guarantee is still the conditional insert below.
    if ((await countUsers(taproot.db.db)) > 0) {
      return isForm
        ? context.redirect('/admin/login', 303)
        : apiError(409, 'Taproot has already been set up.');
    }

    const parsed = setupSchema.safeParse(raw);
    if (!parsed.success) {
      return back('Enter a name, a valid email address, and a password.');
    }

    try {
      assertUsablePassword(parsed.data.password);
    } catch (error) {
      if (!(error instanceof PasswordResetError)) throw error;
      return back(error.message);
    }

    const user = await createFirstAdmin(taproot.db, parsed.data);
    if (!user) {
      // Lost the race. Somebody else set this up between the check above and now.
      return isForm
        ? context.redirect('/admin/login', 303)
        : apiError(409, 'Taproot has already been set up.');
    }

    const { token, expiresAt } = await createSession(taproot.db.db, user.id);
    const cookie = buildSessionCookie(token, expiresAt, { secure: taproot.auth.secureCookies });

    if (isForm) {
      const response = context.redirect('/admin', 303);
      response.headers.append('set-cookie', cookie);
      return response;
    }

    return json(
      { user: { id: user.id, email: user.email, name: user.name, role: user.role } },
      { status: 201, headers: { 'set-cookie': cookie } },
    );
  } catch (error) {
    return mapError(error);
  }
}
