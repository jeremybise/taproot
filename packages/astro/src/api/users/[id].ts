import {
  UserError,
  createPasswordResetToken,
  findUserById,
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
          await setUserRole(taproot.db.db, id, role as UserRole);
          return back({ updated: target.email });
        }

        case 'activate':
        case 'deactivate': {
          await setUserActive(taproot.db.db, id, action === 'activate');
          return back({ updated: target.email });
        }

        case 'reset': {
          const { token, expiresAt } = await createPasswordResetToken(taproot.db.db, id, {
            createdBy: user.id,
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
