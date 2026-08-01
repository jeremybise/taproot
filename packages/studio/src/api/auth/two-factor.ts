import {
  TwoFactorError,
  beginTwoFactorEnrolment,
  confirmTwoFactorEnrolment,
  disableTwoFactor,
  regenerateRecoveryCodes,
  twoFactorStatus,
  verifyCredentials,
} from '@taproot/core';

import { apiError, handle } from '../_shared.js';
import { buildRecoveryCookie } from './recoveryCookie.js';

/**
 * Turning two-factor authentication on and off, from the account screen.
 *
 * Every destructive action here — disabling, reissuing recovery codes — asks for the current
 * password. The session already proves who this is; what it does not prove is that the person at
 * the keyboard is the account holder rather than someone who found an unlocked laptop. Two-factor
 * that can be switched off by whoever is sitting there is not two-factor.
 *
 * `begin` deliberately does not, because it changes nothing that is live: it writes an unverified
 * secret, and the account is unprotected either way until a code confirms it.
 */
export const POST = handle(async ({ context, taproot, user }) => {
  const form = await context.request.formData();
  const action = String(form.get('action') ?? '');

  const back = (params: Record<string, string>) =>
    context.redirect(`/admin/account?${new URLSearchParams(params)}`, 303);

  /** Actions that change a live protection need the password, not just the session. */
  const confirmPassword = async (): Promise<boolean> => {
    const password = String(form.get('password') ?? '');
    return Boolean(await verifyCredentials(taproot.db.db, user.email, password));
  };

  try {
    switch (action) {
      case 'begin': {
        await beginTwoFactorEnrolment(taproot.db.db, user);
        return back({ enrolling: '1' });
      }

      case 'confirm': {
        const codes = await confirmTwoFactorEnrolment(
          taproot.db.db,
          user.id,
          String(form.get('code') ?? ''),
        );

        /**
         * The codes travel back in a one-render cookie, the same way a set-password link does —
         * a query string would put ten working recovery codes into browser history and every
         * access log between here and the browser.
         */
        const response = back({ enabled: '1' });
        response.headers.append(
          'set-cookie',
          buildRecoveryCookie(codes, { secure: taproot.auth.secureCookies }),
        );
        return response;
      }

      case 'regenerate': {
        if (!(await confirmPassword())) return back({ error: 'That is not your current password.' });

        const codes = await regenerateRecoveryCodes(taproot.db.db, user.id);
        const response = back({ regenerated: '1' });
        response.headers.append(
          'set-cookie',
          buildRecoveryCookie(codes, { secure: taproot.auth.secureCookies }),
        );
        return response;
      }

      case 'disable': {
        const status = await twoFactorStatus(taproot.db.db, user.id);

        /**
         * The password is required to switch off a *live* second factor, and not to abandon a
         * half-finished setup.
         *
         * An unconfirmed secret protects nothing — the account is exactly as exposed with it as
         * without — so discarding it takes nothing away and demanding a password to cancel would
         * be friction guarding an empty box. Turning off a confirmed one removes a real
         * protection, which is precisely when a session alone is not enough.
         */
        if (status.enabled && !(await confirmPassword())) {
          return back({ error: 'That is not your current password.' });
        }

        await disableTwoFactor(taproot.db.db, user.id);
        return back({ disabled: status.enabled ? '1' : 'cancelled' });
      }

      default:
        return apiError(400, 'Unsupported form action.');
    }
  } catch (error) {
    if (!(error instanceof TwoFactorError)) throw error;
    return back({ error: error.message });
  }
});
