import {
  UserError,
  createPasswordResetToken,
  createUser,
  listUsers,
  recordAuditEntry,
  type UserRole,
} from '@taproot/core';
import { z } from 'zod';

import { apiError, handle, json } from '../_shared.js';
import { setupLinkCookie } from './linkCookie.js';

export const GET = handle(
  async ({ taproot }) => json({ users: await listUsers(taproot.db.db) }),
  { role: 'admin' },
);

const createSchema = z.strictObject({
  email: z.string().email(),
  name: z.string().min(1).max(120),
  role: z.enum(['viewer', 'contributor', 'editor', 'admin']),
});

/**
 * Create a user.
 *
 * No password is set here, and an admin is never asked for one. They generate a link and hand it
 * over; the person sets their own. That way no administrator knows a colleague's password, and
 * there is no temporary password to store in plaintext or send through a channel nobody controls.
 */
export const POST = handle(
  async ({ context, taproot, user }) => {
    const isForm = (context.request.headers.get('content-type') ?? '').includes('form');
    const raw = isForm
      ? Object.fromEntries(await context.request.formData())
      : await context.request.json();

    const back = (params: Record<string, string>) =>
      context.redirect(`/admin/settings/users?${new URLSearchParams(params)}`, 303);

    const parsed = createSchema.safeParse(raw);
    if (!parsed.success) {
      const message = 'Enter a name, a valid email address, and a role.';
      return isForm ? back({ error: message }) : apiError(422, message);
    }

    let created;
    try {
      created = await createUser(taproot.db.db, {
        email: parsed.data.email,
        name: parsed.data.name,
        role: parsed.data.role as UserRole,
      });
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
      return isForm ? back({ error: error.message }) : apiError(409, error.message);
    }

    const { token, expiresAt } = await createPasswordResetToken(taproot.db.db, created.id, {
      createdBy: user.id,
    });

    await recordAuditEntry(taproot.db.db, {
      action: 'user.created',
      subjectType: 'user',
      subjectId: created.id,
      subjectLabel: created.email,
      actor: user,
      detail: { role: created.role },
    });

    if (isForm) {
      const response = back({ created: created.email });
      response.headers.append(
        'set-cookie',
        setupLinkCookie(
          { email: created.email, token, expiresAt: expiresAt.toISOString() },
          { secure: taproot.auth.secureCookies },
        ),
      );
      return response;
    }

    return json({ user: created, setPasswordToken: token }, { status: 201 });
  },
  { role: 'admin' },
);
