import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import {
  UserError,
  countUsers,
  createFirstAdmin,
  createUser,
  listUsers,
  setUserActive,
  setUserRole,
} from './users.js';
import { createSession, validateSession } from './session.js';
import { verifyCredentials } from './users.js';

/**
 * User administration, which arrived with password sign-in.
 *
 * Two things here are load-bearing rather than convenient: the first-admin insert is the only
 * unauthenticated write in the admin, and the last-admin guard is what stands between a
 * mis-click and a CMS nobody can administer.
 */

let handle: TaprootDb;

beforeEach(async () => {
  handle = await createDb({ driver: 'sqlite', location: ':memory:' });
  const result = await migrateToLatest(handle.db);
  if (result.error) throw result.error;
});

afterEach(async () => {
  await handle.destroy();
});

const FIRST = { email: 'first@campus.edu', name: 'First', password: 'a long enough passphrase' };

describe('createFirstAdmin', () => {
  it('creates an admin who can sign in', async () => {
    const user = await createFirstAdmin(handle.db, FIRST);

    expect(user?.role).toBe('admin');
    expect(await verifyCredentials(handle.db, FIRST.email, FIRST.password)).toBeDefined();
  });

  it('refuses once any user exists', async () => {
    await createUser(handle.db, { email: 'someone@campus.edu', name: 'Someone' });

    // Any user at all, not just an admin: a deployment with a viewer in it has been set up, and
    // the screen must stop offering to create an administrator to whoever asks.
    expect(await createFirstAdmin(handle.db, FIRST)).toBeUndefined();
    expect(await countUsers(handle.db)).toBe(1);
  });

  it('lets only one of two concurrent attempts win', async () => {
    /**
     * The reason this is one statement rather than a count followed by an insert.
     *
     * The setup screen is reachable by anyone who finds the URL in the seconds after a deploy. Two
     * requests arriving together would both read zero and both create an administrator — one of
     * them somebody else's. `INSERT ... SELECT ... WHERE NOT EXISTS` cannot do that.
     */
    const [a, b] = await Promise.all([
      createFirstAdmin(handle.db, FIRST),
      createFirstAdmin(handle.db, { ...FIRST, email: 'second@campus.edu', name: 'Second' }),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await countUsers(handle.db)).toBe(1);
  });

  it('does not leave a user without a password when it loses', async () => {
    // The loser must write nothing at all — a half-created account would occupy the address and
    // then be unable to sign in.
    await createUser(handle.db, { email: 'someone@campus.edu', name: 'Someone' });
    await createFirstAdmin(handle.db, FIRST);

    expect(await listUsers(handle.db)).toHaveLength(1);
    expect(
      await handle.db.selectFrom('user_credentials').selectAll().execute(),
    ).toHaveLength(0);
  });

  it('normalises the email', async () => {
    const user = await createFirstAdmin(handle.db, { ...FIRST, email: '  Admin@Campus.EDU ' });
    expect(user?.email).toBe('admin@campus.edu');
  });
});

describe('createUser', () => {
  it('refuses a duplicate address with a legible error', async () => {
    await createUser(handle.db, { email: 'staff@campus.edu', name: 'Staff' });

    await expect(
      createUser(handle.db, { email: 'STAFF@campus.edu', name: 'Again' }),
    ).rejects.toThrow(UserError);
  });

  it('defaults to the least privileged role', async () => {
    const user = await createUser(handle.db, { email: 'new@campus.edu', name: 'New' });
    expect(user.role).toBe('viewer');
  });
});

describe('the last-admin guard', () => {
  it('refuses to demote the only admin', async () => {
    /**
     * A CMS with no administrator cannot be administered back into having one: every screen that
     * could fix it sits behind the role that just went away, and the setup screen refuses because
     * users exist. Recovering means a database console.
     */
    const admin = await createUser(handle.db, {
      email: 'admin@campus.edu',
      name: 'Admin',
      role: 'admin',
    });

    await expect(setUserRole(handle.db, admin.id, 'editor')).rejects.toThrow(/only active/);
  });

  it('refuses to deactivate the only admin', async () => {
    const admin = await createUser(handle.db, {
      email: 'admin@campus.edu',
      name: 'Admin',
      role: 'admin',
    });

    await expect(setUserActive(handle.db, admin.id, false)).rejects.toThrow(/only active/);
  });

  it('allows it once there is a second admin', async () => {
    const first = await createUser(handle.db, { email: 'a@campus.edu', name: 'A', role: 'admin' });
    await createUser(handle.db, { email: 'b@campus.edu', name: 'B', role: 'admin' });

    await expect(setUserRole(handle.db, first.id, 'editor')).resolves.toBeUndefined();
  });

  it('does not count a deactivated admin as cover', async () => {
    // Someone who cannot sign in is not an administrator for this purpose, and counting them would
    // let the last usable one be demoted.
    const active = await createUser(handle.db, {
      email: 'a@campus.edu',
      name: 'A',
      role: 'admin',
    });
    const dormant = await createUser(handle.db, {
      email: 'b@campus.edu',
      name: 'B',
      role: 'admin',
    });
    await setUserActive(handle.db, dormant.id, false);

    await expect(setUserRole(handle.db, active.id, 'editor')).rejects.toThrow(/only active/);
  });

  it('does not obstruct changing a non-admin', async () => {
    await createUser(handle.db, { email: 'a@campus.edu', name: 'A', role: 'admin' });
    const editor = await createUser(handle.db, { email: 'e@campus.edu', name: 'E', role: 'editor' });

    await expect(setUserRole(handle.db, editor.id, 'viewer')).resolves.toBeUndefined();
    await expect(setUserActive(handle.db, editor.id, false)).resolves.toBeUndefined();
  });
});

describe('deactivating', () => {
  it('ends the user’s sessions there and then', async () => {
    // Not at expiry: someone who has just lost access should not keep it for up to thirty days.
    await createUser(handle.db, { email: 'a@campus.edu', name: 'A', role: 'admin' });
    const staff = await createUser(handle.db, { email: 's@campus.edu', name: 'S' });
    const { token } = await createSession(handle.db, staff.id);

    expect(await validateSession(handle.db, token)).not.toBeNull();
    await setUserActive(handle.db, staff.id, false);
    expect(await validateSession(handle.db, token)).toBeNull();
  });

  it('refuses their password too', async () => {
    await createUser(handle.db, { email: 'a@campus.edu', name: 'A', role: 'admin' });
    const staff = await createUser(handle.db, {
      email: 's@campus.edu',
      name: 'S',
      password: 'a long enough passphrase',
    });

    await setUserActive(handle.db, staff.id, false);
    expect(
      await verifyCredentials(handle.db, 's@campus.edu', 'a long enough passphrase'),
    ).toBeUndefined();
  });

  it('can be undone', async () => {
    await createUser(handle.db, { email: 'a@campus.edu', name: 'A', role: 'admin' });
    const staff = await createUser(handle.db, { email: 's@campus.edu', name: 'S' });

    await setUserActive(handle.db, staff.id, false);
    await setUserActive(handle.db, staff.id, true);

    expect((await listUsers(handle.db)).find((u) => u.id === staff.id)?.is_active).toBeTruthy();
  });
});
