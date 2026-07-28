import type { Kysely } from 'kysely';

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

/**
 * A real PBKDF2 hash of a value nobody knows, verified when no user matches so that the timing of
 * a failed login does not disclose whether the email exists.
 */
const DUMMY_HASH =
  'pbkdf2$210000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
