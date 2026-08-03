import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The first administrator has to be created whole, or not at all.
 *
 * This is its own file because it mocks password hashing, which the rest of the user suite needs
 * to be real. What it reproduces is the exact production failure: `hashPassword` threw — workerd
 * refuses PBKDF2 above 100,000 iterations — *after* the user row had already been inserted, and
 * the deployment was left holding an administrator with no credential. That state has no way out.
 * The setup screen refuses because a user exists, and login cannot verify a password that was
 * never written, so the CMS is unreachable by every route it offers.
 *
 * The iteration count is fixed elsewhere. This pins the shape that turned a failed hash into an
 * unrecoverable install, because the next thing to fail here will not be PBKDF2.
 */
vi.mock('./password.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./password.js')>();
  return {
    ...actual,
    hashPassword: vi.fn(async () => {
      throw new Error('Pbkdf2 failed: iteration counts above 100000 are not supported');
    }),
  };
});

const { createDb } = await import('../db/client.js');
const { migrateToLatest } = await import('../db/migrations/index.js');
const { countUsers, createFirstAdmin } = await import('./users.js');

type Handle = Awaited<ReturnType<typeof createDb>>;

let handle: Handle;

beforeEach(async () => {
  handle = await createDb({ driver: 'sqlite', location: ':memory:' });
  const result = await migrateToLatest(handle.db);
  if (result.error) throw result.error;
});

afterEach(async () => {
  await handle.destroy();
});

describe('createFirstAdmin when hashing fails', () => {
  const FIRST = {
    email: 'first@campus.edu',
    name: 'First',
    password: 'a long enough passphrase',
  };

  it('writes nothing, leaving setup still available', async () => {
    await expect(createFirstAdmin(handle, FIRST)).rejects.toThrow(/Pbkdf2/);

    // The whole point. A user row here would occupy the install: setup refuses once any user
    // exists, and this one could never sign in.
    expect(await countUsers(handle.db)).toBe(0);
    expect(await handle.db.selectFrom('user_credentials').selectAll().execute()).toHaveLength(0);
  });

  it('leaves the install recoverable by simply trying again', async () => {
    await expect(createFirstAdmin(handle, FIRST)).rejects.toThrow();

    // With hashing working again the same request succeeds, which is only true because the failed
    // attempt wrote nothing at all.
    const { hashPassword } = await import('./password.js');
    vi.mocked(hashPassword).mockImplementation(async () => 'pbkdf2$100000$AAAA==$AAAA=');

    const user = await createFirstAdmin(handle, FIRST);

    expect(user?.email).toBe('first@campus.edu');
    expect(user?.role).toBe('admin');
    expect(await handle.db.selectFrom('user_credentials').selectAll().execute()).toHaveLength(1);
  });
});
