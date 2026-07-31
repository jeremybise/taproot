import {
  UserError,
  createPasswordResetToken,
  disableTwoFactor,
  findUserById,
  invalidateOtherSessions,
  recordAuditEntry,
  setUserActive,
  setUserRole,
  type UserRole,
} from '@taproot/core';

import { apiError, handle, json } from '../_shared.js';
import { setupLinkCookie } from './linkCookie.js';

const ROLES: UserRole[] = ['viewer', 'contributor', 'editor', 'admin'];

/**
 * Role changes, deactivation, and generating a set-password link.
 *
 * One POST rather than three routes because all three are a form on the users screen, and the
 * admin is server-rendered so they have to be form posts. `action` names which.
 */
export const POST = handle(
  async ({ context, taproot, user }) => {
    const id = context.params.id!;
    const form = await context.request.formData();
    const action = String(form.get('action') ?? '');

    const back = (params: Record<string, string>) =>
      context.redirect(`/admin/settings/users?${new URLSearchParams(params)}`, 303);

    const target = await findUserById(taproot.db.db, id);
    if (!target) return apiError(404, 'User not found.');

    try {
      switch (action) {
        case 'role': {
          const role = String(form.get('role') ?? '');
          if (!ROLES.includes(role as UserRole)) return back({ error: 'Unknown role.' });

          /**
           * Demoting yourself is allowed, and deliberately so — an admin tidying up their own
           * account is a legitimate thing to do, and the last-admin guard already stops it being
           * catastrophic. What is refused is leaving the site with no administrator at all.
           */
          const previous = target.role;
          await setUserRole(taproot.db.db, id, role as UserRole);
          await recordAuditEntry(taproot.db.db, {
            action: 'user.role_changed',
            subjectType: 'user',
            subjectId: id,
            subjectLabel: target.email,
            actor: user,
            detail: { from: previous, to: role },
          });
          return back({ updated: target.email });
        }

        case 'activate':
        case 'deactivate': {
          await setUserActive(taproot.db.db, id, action === 'activate');
          await recordAuditEntry(taproot.db.db, {
            action: action === 'activate' ? 'user.activated' : 'user.deactivated',
            subjectType: 'user',
            subjectId: id,
            subjectLabel: target.email,
            actor: user,
          });
          return back({ updated: target.email });
        }

        /**
         * Clear someone else's two-factor.
         *
         * The case this exists for: a lost phone *and* lost recovery codes locks an account
         * permanently, and until now the only fix was a database console. "Ask an administrator"
         * was written on the sign-in screen while no administrator could actually do it.
         *
         * Refused on yourself, and that is not an oversight. Your own is behind a password check
         * on the account screen, and letting an admin clear their own from here would route
         * around it — turning an unattended admin session into a way to strip the protection off
         * the account it belongs to. The last remaining admin who loses both phone and codes is
         * the residual case, and it is what recovery codes exist to prevent.
         */
        case 'clear-two-factor': {
          if (id === user.id) {
            return back({
              error:
                'Use Your account to change your own two-factor — it asks for your password, which this does not.',
            });
          }

          await disableTwoFactor(taproot.db.db, id);
          /**
           * The entry that matters most in this file. Clearing someone's second factor is the one
           * admin power that removes a protection from an account the admin does not own, and the
           * only thing standing between that being a support action and a quiet takeover is a
           * record that it happened.
           */
          await recordAuditEntry(taproot.db.db, {
            action: 'user.two_factor_cleared',
            subjectType: 'user',
            subjectId: id,
            subjectLabel: target.email,
            actor: user,
          });
          return back({ updated: `${target.email} (two-factor cleared)` });
        }

        /**
         * End someone's sessions.
         *
         * For a lost or stolen device. Deactivating would also do it, but that takes the account
         * away rather than the device, and the person on the phone to you still needs to work.
         */
        case 'sign-out': {
          const dropped = await invalidateOtherSessions(
            taproot.db.db,
            id,
            // Signing yourself out everywhere should mean the *other* places, not the browser you
            // are holding. Signing yourself out for taking a precaution teaches you not to.
            id === user.id ? taproot.sessionToken : undefined,
          );

          await recordAuditEntry(taproot.db.db, {
            action: 'user.sessions_ended',
            subjectType: 'user',
            subjectId: id,
            subjectLabel: target.email,
            actor: user,
            detail: { sessions: dropped },
          });

          return back({
            updated: `${target.email} (${dropped} session${dropped === 1 ? '' : 's'} ended)`,
          });
        }

        case 'reset': {
          const { token, expiresAt } = await createPasswordResetToken(taproot.db.db, id, {
            createdBy: user.id,
          });

          await recordAuditEntry(taproot.db.db, {
            action: 'user.password_link_issued',
            subjectType: 'user',
            subjectId: id,
            subjectLabel: target.email,
            actor: user,
          });

          const response = back({ linked: target.email });
          response.headers.append(
            'set-cookie',
            setupLinkCookie(
              { email: target.email, token, expiresAt: expiresAt.toISOString() },
              { secure: taproot.auth.secureCookies },
            ),
          );
          return response;
        }

        default:
          return apiError(400, 'Unsupported form action.');
      }
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
      return back({ error: error.message });
    }
  },
  { role: 'admin' },
);

export const GET = handle(
  async ({ context, taproot }) => {
    const target = await findUserById(taproot.db.db, context.params.id!);
    if (!target) return apiError(404, 'User not found.');
    return json({ user: target });
  },
  { role: 'admin' },
);
