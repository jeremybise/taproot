import {
  PasswordResetError,
  assertUsablePassword,
  buildSessionCookie,
  createSession,
  invalidateUserSessions,
  setPassword,
  verifyCredentials,
} from '@taprootcms/core';

import { handle } from '../_shared.js';

/**
 * Change your own password.
 *
 * The current password is required even though the session already proves who this is. It is not
 * belt and braces: it is what stops an unattended browser being turned into a permanent takeover
 * by someone walking past, and it is the reason this is safe to leave un-throttled — an attacker
 * who can reach this form already has the session.
 *
 * Every *other* session is dropped, and this one is reissued. Changing a password because you
 * think someone else has it achieves nothing if their session survives — and logging yourself out
 * in the process would make the safe action feel like a punishment.
 */
export const POST = handle(async ({ context, taproot, user }) => {
  const form = await context.request.formData();
  const current = String(form.get('currentPassword') ?? '');
  const next = String(form.get('newPassword') ?? '');
  const confirm = String(form.get('confirmPassword') ?? '');

  const back = (params: Record<string, string>) =>
    context.redirect(`/admin/account?${new URLSearchParams(params)}`, 303);

  if (next !== confirm) return back({ error: 'Those two passwords do not match.' });

  try {
    assertUsablePassword(next);
  } catch (error) {
    if (!(error instanceof PasswordResetError)) throw error;
    return back({ error: error.message });
  }

  const verified = await verifyCredentials(taproot.db.db, user.email, current);
  if (!verified) {
    return back({ error: 'That is not your current password.' });
  }

  await setPassword(taproot.db.db, user.id, next);
  await invalidateUserSessions(taproot.db.db, user.id);

  // Reissued after the sweep, so this browser stays signed in and every other one does not.
  const { token, expiresAt } = await createSession(taproot.db.db, user.id);
  const response = back({ changed: '1' });
  response.headers.append(
    'set-cookie',
    buildSessionCookie(token, expiresAt, { secure: taproot.auth.secureCookies }),
  );
  return response;
});
