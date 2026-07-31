import { sql, type Kysely } from 'kysely';

import type { Database, User, UsersTable } from '../db/schema.js';
import { fromBool, now } from '../db/values.js';
import { hashPassword, needsRehash, verifyPassword } from './password.js';
import { newId } from '../ids.js';

export type UserRole = UsersTable['role'];

export interface CreateUserInput {
  email: string;
  name: string;
  role?: UserRole;
  avatarUrl?: string | null;
  /** When present, a credential row is written so the user can sign in with a password. */
  password?: string;
}

export async function findUserByEmail(
  db: Kysely<Database>,
  email: string,
): Promise<User | undefined> {
  return db
    .selectFrom('users')
    .selectAll()
    .where('email', '=', normalizeEmail(email))
    .executeTakeFirst();
}

export async function findUserById(db: Kysely<Database>, id: string): Promise<User | undefined> {
  return db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
}

export async function createUser(db: Kysely<Database>, input: CreateUserInput): Promise<User> {
  const timestamp = now();
  const id = newId();

  /**
   * Checked rather than left to the unique index.
   *
   * Now that an admin creates accounts by hand, "that address is already here" is an ordinary
   * mistake with a useful answer, not a constraint violation to surface as a 500.
   */
  const existing = await findUserByEmail(db, input.email);
  if (existing) {
    throw new UserError(`Someone with the address ${existing.email} already exists.`, 'duplicate_email');
  }

  const user: User = {
    id,
    email: normalizeEmail(input.email),
    name: input.name,
    avatar_url: input.avatarUrl ?? null,
    role: input.role ?? 'viewer',
    is_active: fromBool(true),
    created_at: timestamp,
    updated_at: timestamp,
  };

  await db.insertInto('users').values(user).execute();

  if (input.password) {
    await setPassword(db, id, input.password);
  }

  return user;
}

export async function setPassword(
  db: Kysely<Database>,
  userId: string,
  password: string,
): Promise<void> {
  const hash = await hashPassword(password);
  const timestamp = now();

  await db
    .insertInto('user_credentials')
    .values({
      user_id: userId,
      password_hash: hash,
      created_at: timestamp,
      updated_at: timestamp,
    })
    .onConflict((oc) =>
      oc.column('user_id').doUpdateSet({ password_hash: hash, updated_at: timestamp }),
    )
    .execute();
}

/**
 * Verify an email/password pair.
 *
 * Returns `undefined` for every failure mode — unknown user, no password set, wrong password —
 * so the caller cannot accidentally surface which one occurred. A dummy hash is verified when the
 * user does not exist so that the response time does not reveal whether an account is registered.
 */
export async function verifyCredentials(
  db: Kysely<Database>,
  email: string,
  password: string,
): Promise<User | undefined> {
  const user = await findUserByEmail(db, email);

  const credential = user
    ? await db
        .selectFrom('user_credentials')
        .select('password_hash')
        .where('user_id', '=', user.id)
        .executeTakeFirst()
    : undefined;

  if (!user || !credential) {
    await verifyPassword(password, DUMMY_HASH);
    return undefined;
  }

  const valid = await verifyPassword(password, credential.password_hash);
  if (!valid) return undefined;
  if (!user.is_active) return undefined;

  // Transparently upgrade the stored hash if the iteration count has since been raised.
  if (needsRehash(credential.password_hash)) {
    await setPassword(db, user.id, password);
  }

  return user;
}

/**
 * Find or create the local user behind an OAuth identity.
 *
 * Links to an existing account by verified email so a user who was invited by email and then signs
 * in with Google lands in the same account instead of getting a duplicate.
 */
export async function upsertOAuthUser(
  db: Kysely<Database>,
  params: {
    provider: 'google' | 'github' | 'microsoft';
    providerUserId: string;
    email: string;
    name: string;
    avatarUrl?: string | null;
    /** Role for a first-time user. Existing users keep the role they already have. */
    defaultRole?: UserRole;
  },
): Promise<User> {
  const existingLink = await db
    .selectFrom('oauth_accounts')
    .select('user_id')
    .where('provider', '=', params.provider)
    .where('provider_user_id', '=', params.providerUserId)
    .executeTakeFirst();

  if (existingLink) {
    const user = await findUserById(db, existingLink.user_id);
    if (user) return user;
  }

  const byEmail = await findUserByEmail(db, params.email);
  const user =
    byEmail ??
    (await createUser(db, {
      email: params.email,
      name: params.name,
      avatarUrl: params.avatarUrl ?? null,
      role: params.defaultRole ?? 'viewer',
    }));

  await db
    .insertInto('oauth_accounts')
    .values({
      provider: params.provider,
      provider_user_id: params.providerUserId,
      user_id: user.id,
      created_at: now(),
    })
    .onConflict((oc) => oc.columns(['provider', 'provider_user_id']).doNothing())
    .execute();

  return user;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function countUsers(db: Kysely<Database>): Promise<number> {
  const row = await db
    .selectFrom('users')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

export async function listUsers(db: Kysely<Database>): Promise<User[]> {
  return db.selectFrom('users').selectAll().orderBy('created_at').execute();
}

/**
 * Create the very first admin, and only if there is no user at all.
 *
 * This backs the first-run setup screen, which is the one **unauthenticated write path** in the
 * whole admin — it exists because a fresh deployment with password sign-in has no OAuth land-grab
 * to bootstrap from and no account to sign in with. Everything about it has to be exactly right.
 *
 * The check and the insert are one statement. A `count()` followed by an `insert` is a race with a
 * window wide enough to matter here: the screen is reachable by anyone who finds the URL in the
 * seconds after a deploy, and two requests arriving together would both read zero and both create
 * an admin — one of them an attacker's. `INSERT ... SELECT ... WHERE NOT EXISTS` cannot do that,
 * and the row count tells the loser it lost.
 *
 * Raw SQL rather than the query builder because this shape has no Kysely spelling that stays
 * readable, and it is identical on SQLite, D1, and Postgres.
 */
export async function createFirstAdmin(
  db: Kysely<Database>,
  input: { email: string; name: string; password: string },
): Promise<User | undefined> {
  const id = newId();
  const email = normalizeEmail(input.email);
  const timestamp = now();

  const result = await sql`
    INSERT INTO users (id, email, name, avatar_url, role, is_active, created_at, updated_at)
    SELECT ${id}, ${email}, ${input.name}, NULL, 'admin', ${fromBool(true)}, ${timestamp}, ${timestamp}
    WHERE NOT EXISTS (SELECT 1 FROM users)
  `.execute(db);

  // Zero rows means somebody else got there first, which is a refusal rather than an error: the
  // caller's job is to stop offering the screen, not to retry.
  if (Number(result.numAffectedRows ?? 0) === 0) return undefined;

  await setPassword(db, id, input.password);

  return findUserById(db, id);
}

/**
 * Change a user's role, refusing to remove the last admin.
 *
 * A CMS with no administrator cannot be administered back into having one — every screen that
 * could fix it is behind the role that just went away, and the setup screen refuses to help
 * because users exist. Demoting yourself by accident is an easy click; recovering from it means a
 * database console.
 */
export async function setUserRole(
  db: Kysely<Database>,
  userId: string,
  role: UserRole,
): Promise<void> {
  if (role !== 'admin') await assertNotLastAdmin(db, userId);
  await db.updateTable('users').set({ role, updated_at: now() }).where('id', '=', userId).execute();
}

/** Deactivate or reactivate. Deactivating drops the user's sessions immediately. */
export async function setUserActive(
  db: Kysely<Database>,
  userId: string,
  isActive: boolean,
): Promise<void> {
  if (!isActive) await assertNotLastAdmin(db, userId);

  await db
    .updateTable('users')
    .set({ is_active: fromBool(isActive), updated_at: now() })
    .where('id', '=', userId)
    .execute();

  if (!isActive) {
    // `validateSession` also refuses an inactive user, so this is belt and braces — but a session
    // row that outlives the account it belongs to is not a thing worth keeping either way.
    await db.deleteFrom('sessions').where('user_id', '=', userId).execute();
  }
}

export class UserError extends Error {
  override name = 'UserError';
  constructor(
    message: string,
    readonly code: 'duplicate_email' | 'last_admin' | 'not_found',
  ) {
    super(message);
  }
}

async function assertNotLastAdmin(db: Kysely<Database>, userId: string): Promise<void> {
  const user = await findUserById(db, userId);
  if (!user || user.role !== 'admin') return;

  const others = await db
    .selectFrom('users')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('role', '=', 'admin')
    .where('is_active', '=', fromBool(true))
    .where('id', '!=', userId)
    .executeTakeFirst();

  if (Number(others?.count ?? 0) === 0) {
    throw new UserError(
      'This is the only active administrator. Promote someone else to admin first, or there ' +
        'would be nobody able to manage the site.',
      'last_admin',
    );
  }
}

/**
 * A real PBKDF2 hash of a value nobody knows, verified when no user matches so that the timing of
 * a failed login does not disclose whether the email exists.
 */
const DUMMY_HASH =
  'pbkdf2$210000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
