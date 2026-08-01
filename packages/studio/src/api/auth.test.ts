import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_ATTEMPTS,
  beginTwoFactorEnrolment,
  confirmTwoFactorEnrolment,
  countUserSessions,
  countUsers,
  createPasswordResetToken,
  createSession,
  createUser,
  generateTotpCode,
  setPassword,
  twoFactorStatus,
  verifyCredentials,
  type User,
} from '@taprootcms/core';

import { createHarness, body, location, type Harness } from './testHarness.js';
import { POST as login } from './auth/login.js';
import { POST as setup } from './auth/setup.js';
import { POST as setPasswordRoute } from './auth/set-password.js';
import { POST as changePassword } from './auth/change-password.js';
import { POST as createUserRoute } from './users/index.js';
import { POST as userAction } from './users/[id].js';
import { SETUP_LINK_COOKIE, readSetupLink } from './users/linkCookie.js';

/**
 * The sign-in surface, now that email and password is the primary way in rather than a local
 * convenience.
 *
 * The parts worth pinning down are the ones that only matter once this is the front door: the
 * throttle, the first-run screen's refusal to run twice, and the fact that an admin can add a
 * colleague without ever learning their password.
 */

let h: Harness;

const PASSWORD = 'a sufficiently long passphrase';

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.destroy();
});

/** Pull a `set-cookie` off a response by name. */
function cookie(response: Response, name: string): string | undefined {
  return response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${name}=`));
}

describe('signing in', () => {
  async function staff(): Promise<User> {
    const user = await createUser(h.db.db, { email: 'staff@campus.edu', name: 'Staff' });
    await setPassword(h.db.db, user.id, PASSWORD);
    return user;
  }

  it('issues a session for the right password', async () => {
    await staff();
    const response = await login(
      h.context({ json: { email: 'staff@campus.edu', password: PASSWORD } }),
    );

    expect(response.status).toBe(200);
    expect(cookie(response, 'taproot_session')).toMatch(/HttpOnly/);
  });

  it('gives the same answer for a wrong password and an unknown address', async () => {
    // Otherwise the form is an account-enumeration oracle for a campus directory.
    await staff();

    const wrongPassword = await login(
      h.context({ json: { email: 'staff@campus.edu', password: 'nope' } }),
    );
    const unknownUser = await login(
      h.context({ json: { email: 'nobody@campus.edu', password: 'nope' } }),
    );

    expect(wrongPassword.status).toBe(unknownUser.status);
    expect((await body(wrongPassword)).error).toBe((await body(unknownUser)).error);
  });

  it('redirects a form post rather than answering with JSON', async () => {
    await staff();
    const response = await login(
      h.context({ form: { email: 'staff@campus.edu', password: PASSWORD, redirectTo: '/admin/media' } }),
    );

    expect(response.status).toBe(303);
    expect(location(response)).toBe('/admin/media');
  });

  it('refuses to redirect off-site', async () => {
    // `?redirectTo=https://evil.example` would make the login form a phishing hop.
    await staff();
    for (const target of ['https://evil.example', '//evil.example', 'javascript:alert(1)']) {
      const response = await login(
        h.context({ form: { email: 'staff@campus.edu', password: PASSWORD, redirectTo: target } }),
      );
      expect(location(response)).toBe('/admin');
    }
  });

  it('refuses a deactivated account', async () => {
    const user = await staff();
    await h.db.db.updateTable('users').set({ is_active: 0 }).where('id', '=', user.id).execute();

    expect(
      (await login(h.context({ json: { email: 'staff@campus.edu', password: PASSWORD } }))).status,
    ).toBe(401);
  });
});

describe('throttling', () => {
  it('starts refusing after enough failures, without saying so differently', async () => {
    await createUser(h.db.db, { email: 'staff@campus.edu', name: 'Staff' });

    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      await login(h.context({ json: { email: 'staff@campus.edu', password: 'wrong' } }));
    }

    const response = await login(
      h.context({ json: { email: 'staff@campus.edu', password: 'wrong' } }),
    );
    expect(response.status).toBe(429);
  });

  it('refuses before checking the password, so a correct one does not get through', async () => {
    /**
     * Also why the check runs first at all: verification is 210,000 PBKDF2 iterations, and doing
     * that work before refusing would turn the throttle into its own amplifier.
     */
    const user = await createUser(h.db.db, { email: 'staff@campus.edu', name: 'Staff' });
    await setPassword(h.db.db, user.id, PASSWORD);

    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      await login(h.context({ json: { email: 'staff@campus.edu', password: 'wrong' } }));
    }

    const response = await login(
      h.context({ json: { email: 'staff@campus.edu', password: PASSWORD } }),
    );
    expect(response.status).toBe(429);
  });

  it('clears the count on a successful sign-in', async () => {
    const user = await createUser(h.db.db, { email: 'staff@campus.edu', name: 'Staff' });
    await setPassword(h.db.db, user.id, PASSWORD);

    for (let i = 0; i < MAX_ATTEMPTS - 1; i += 1) {
      await login(h.context({ json: { email: 'staff@campus.edu', password: 'wrong' } }));
    }
    await login(h.context({ json: { email: 'staff@campus.edu', password: PASSWORD } }));

    // Back to zero, so a run of typos followed by success does not leave someone one slip from a
    // lockout.
    expect(
      await h.db.db.selectFrom('login_attempts').selectAll().execute(),
    ).toHaveLength(0);
  });

  it('counts a spray across accounts against the address', async () => {
    // Per-email limiting alone misses this entirely: one guess against many accounts trips no
    // per-account counter anywhere.
    const headers = { 'cf-connecting-ip': '203.0.113.4' };

    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      await login(
        h.context({ json: { email: `person${i}@campus.edu`, password: 'Password1!' }, headers }),
      );
    }

    const response = await login(
      h.context({ json: { email: 'someone-new@campus.edu', password: 'Password1!' }, headers }),
    );
    expect(response.status).toBe(429);
  });
});

describe('first-run setup', () => {
  it('creates an admin and signs them in', async () => {
    const response = await setup(
      h.context({ json: { email: 'first@campus.edu', name: 'First', password: PASSWORD } }),
    );

    expect(response.status).toBe(201);
    expect(cookie(response, 'taproot_session')).toBeDefined();
    expect((await body<{ user: { role: string } }>(response)).user.role).toBe('admin');
  });

  it('refuses once anyone exists', async () => {
    // Any user, not just an admin: a deployment with one viewer has been set up.
    await createUser(h.db.db, { email: 'someone@campus.edu', name: 'Someone' });

    const response = await setup(
      h.context({ json: { email: 'attacker@evil.example', name: 'Nope', password: PASSWORD } }),
    );

    expect(response.status).toBe(409);
    expect(await countUsers(h.db.db)).toBe(1);
  });

  it('enforces the password minimum', async () => {
    const response = await setup(
      h.context({ json: { email: 'first@campus.edu', name: 'First', password: 'short' } }),
    );

    expect(response.status).toBe(400);
    expect(await countUsers(h.db.db)).toBe(0);
  });

  it('sends a form submission to the admin, signed in', async () => {
    const response = await setup(
      h.context({ form: { email: 'first@campus.edu', name: 'First', password: PASSWORD } }),
    );

    expect(location(response)).toBe('/admin');
    expect(cookie(response, 'taproot_session')).toBeDefined();
  });
});

describe('adding a user', () => {
  async function admin(): Promise<User> {
    const user = await createUser(h.db.db, {
      email: 'admin@campus.edu',
      name: 'Admin',
      role: 'admin',
    });
    h.as(user);
    return user;
  }

  it('creates the account and returns a link, never a password', async () => {
    /**
     * The whole shape of the flow. An admin who could set a colleague's password would know it,
     * and a temporary password would have to be stored or sent somewhere.
     */
    await admin();
    const response = await createUserRoute(
      h.context({ json: { email: 'new@campus.edu', name: 'New', role: 'editor' } }),
    );

    expect(response.status).toBe(201);
    const payload = await body<{ setPasswordToken: string }>(response);
    expect(payload.setPasswordToken).toMatch(/^[0-9a-f]{64}$/);

    // No credential row yet — they have not chosen one.
    expect(await h.db.db.selectFrom('user_credentials').selectAll().execute()).toHaveLength(0);
  });

  it('hands the link back through a cookie, not the URL', async () => {
    // A URL lands in history, in `Referer`, and in access logs — a poor home for something that
    // grants control of an account for two days.
    await admin();
    const response = await createUserRoute(
      h.context({ form: { email: 'new@campus.edu', name: 'New', role: 'editor' } }),
    );

    expect(location(response)).toBe('/admin/settings/users?created=new@campus.edu');
    expect(location(response)).not.toMatch(/token/);

    const raw = cookie(response, SETUP_LINK_COOKIE)!;
    const value = raw.slice(raw.indexOf('=') + 1, raw.indexOf(';'));
    expect(readSetupLink(value)?.email).toBe('new@campus.edu');
    expect(raw).toMatch(/HttpOnly/);
  });

  it('refuses a duplicate address with a message rather than a crash', async () => {
    await admin();
    await createUserRoute(h.context({ json: { email: 'new@campus.edu', name: 'New', role: 'editor' } }));

    const response = await createUserRoute(
      h.context({ json: { email: 'NEW@campus.edu', name: 'Again', role: 'editor' } }),
    );
    expect(response.status).toBe(409);
  });

  it('needs the admin role', async () => {
    h.as(await h.user('editor'));
    expect(
      (await createUserRoute(h.context({ json: { email: 'x@y.edu', name: 'X', role: 'viewer' } })))
        .status,
    ).toBe(403);
  });

  it('clears a colleague’s two-factor, but never your own', async () => {
    /**
     * The lockout this exists for: a lost phone *and* lost recovery codes, where the only fix used
     * to be a database console while the sign-in screen said "ask an administrator".
     *
     * Refused on yourself because your own is behind a password check on the account screen, and
     * offering it here would route around that — turning an unattended admin session into a way to
     * strip the protection off the account it belongs to.
     */
    const me = await admin();
    const colleague = await createUser(h.db.db, { email: 'stuck@campus.edu', name: 'Stuck' });
    const { secret } = await beginTwoFactorEnrolment(h.db.db, colleague);
    await confirmTwoFactorEnrolment(h.db.db, colleague.id, await generateTotpCode(secret));

    const cleared = await userAction(
      h.context({ params: { id: colleague.id }, form: { action: 'clear-two-factor' } }),
    );
    expect(location(cleared)).toMatch(/two-factor cleared/);
    expect((await twoFactorStatus(h.db.db, colleague.id)).enabled).toBe(false);

    const own = await userAction(
      h.context({ params: { id: me.id }, form: { action: 'clear-two-factor' } }),
    );
    expect(location(own)).toMatch(/Use Your account/);
  });

  it('ends a colleague’s sessions without touching the account', async () => {
    // A lost laptop needs the sessions gone, not the account — the person on the phone to you
    // still has work to do.
    await admin();
    const colleague = await createUser(h.db.db, { email: 'lost@campus.edu', name: 'Lost' });
    await createSession(h.db.db, colleague.id);
    await createSession(h.db.db, colleague.id);

    const response = await userAction(
      h.context({ params: { id: colleague.id }, form: { action: 'sign-out' } }),
    );

    expect(location(response)).toMatch(/2 sessions ended/);
    expect(await countUserSessions(h.db.db, colleague.id)).toBe(0);
    // Still active, still able to sign in again.
    expect((await h.db.db.selectFrom('users').select('is_active').where('id', '=', colleague.id).executeTakeFirst())?.is_active).toBeTruthy();
  });

  it('signing yourself out everywhere keeps the browser you are holding', async () => {
    /**
     * Otherwise the safe, precautionary action logs you out for taking it — and people who get
     * punished for taking a precaution stop taking it.
     */
    const me = await admin();
    const { token } = await createSession(h.db.db, me.id);
    await createSession(h.db.db, me.id);

    const context = h.context({ params: { id: me.id }, form: { action: 'sign-out' } });
    (context.locals as { taproot: { sessionToken?: string } }).taproot.sessionToken = token;

    await userAction(context);

    expect(await countUserSessions(h.db.db, me.id)).toBe(1);
  });

  it('refuses to leave the site with no administrator', async () => {
    const me = await admin();
    const response = await userAction(
      h.context({ params: { id: me.id }, form: { action: 'role', role: 'editor' } }),
    );

    expect(location(response)).toMatch(/only active administrator/);
  });
});

describe('setting a password from a link', () => {
  it('sets it, signs in, and burns the token', async () => {
    const user = await createUser(h.db.db, { email: 'new@campus.edu', name: 'New' });
    const { token } = await createPasswordResetToken(h.db.db, user.id);

    const response = await setPasswordRoute(h.context({ json: { token, password: PASSWORD } }));

    expect(response.status).toBe(200);
    expect(cookie(response, 'taproot_session')).toBeDefined();
    expect(await verifyCredentials(h.db.db, 'new@campus.edu', PASSWORD)).toBeDefined();

    const again = await setPasswordRoute(h.context({ json: { token, password: PASSWORD } }));
    expect(again.status).toBe(400);
  });

  it('refuses a mismatched confirmation before spending the token', async () => {
    const user = await createUser(h.db.db, { email: 'new@campus.edu', name: 'New' });
    const { token } = await createPasswordResetToken(h.db.db, user.id);

    await setPasswordRoute(
      h.context({ form: { token, password: PASSWORD, confirm: 'something else' } }),
    );

    // Still usable — a typo must not cost them the link.
    const response = await setPasswordRoute(h.context({ json: { token, password: PASSWORD } }));
    expect(response.status).toBe(200);
  });
});

describe('changing your own password', () => {
  it('requires the current one', async () => {
    const user = await createUser(h.db.db, { email: 'staff@campus.edu', name: 'Staff' });
    await setPassword(h.db.db, user.id, PASSWORD);
    h.as(user);

    const response = await changePassword(
      h.context({
        form: { currentPassword: 'wrong', newPassword: 'another long passphrase', confirmPassword: 'another long passphrase' },
      }),
    );

    expect(location(response)).toMatch(/not your current password/);
    expect(await verifyCredentials(h.db.db, 'staff@campus.edu', PASSWORD)).toBeDefined();
  });

  it('changes it and keeps this session while ending the others', async () => {
    const user = await createUser(h.db.db, { email: 'staff@campus.edu', name: 'Staff' });
    await setPassword(h.db.db, user.id, PASSWORD);
    h.as(user);

    const next = 'a different long passphrase';
    const response = await changePassword(
      h.context({
        form: { currentPassword: PASSWORD, newPassword: next, confirmPassword: next },
      }),
    );

    expect(location(response)).toBe('/admin/account?changed=1');
    // Exactly one session: the sweep dropped everything, then this browser was reissued one.
    expect(await h.db.db.selectFrom('sessions').selectAll().execute()).toHaveLength(1);
    expect(await verifyCredentials(h.db.db, 'staff@campus.edu', next)).toBeDefined();
  });

  it('refuses a mismatch and a too-short password', async () => {
    const user = await createUser(h.db.db, { email: 'staff@campus.edu', name: 'Staff' });
    await setPassword(h.db.db, user.id, PASSWORD);
    h.as(user);

    const mismatch = await changePassword(
      h.context({ form: { currentPassword: PASSWORD, newPassword: 'aaaaaaaaaaaaaa', confirmPassword: 'bbbbbbbbbbbbbb' } }),
    );
    expect(location(mismatch)).toMatch(/do not match/);

    const short = await changePassword(
      h.context({ form: { currentPassword: PASSWORD, newPassword: 'short', confirmPassword: 'short' } }),
    );
    expect(location(short)).toMatch(/at least/);
  });

  it('is available to every role, not just admins', async () => {
    // It is on the account screen rather than under Settings for exactly this reason.
    const user = await createUser(h.db.db, { email: 'v@campus.edu', name: 'V', role: 'viewer' });
    await setPassword(h.db.db, user.id, PASSWORD);
    h.as(user);

    const next = 'yet another long passphrase';
    const response = await changePassword(
      h.context({ form: { currentPassword: PASSWORD, newPassword: next, confirmPassword: next } }),
    );

    expect(location(response)).toBe('/admin/account?changed=1');
  });
});
