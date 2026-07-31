import type { Kysely } from 'kysely';

import type { Database, User } from '../db/schema.js';
import { now } from '../db/values.js';
import { hashSessionToken } from './session.js';
import { setPassword } from './users.js';
import { invalidateUserSessions } from './session.js';

/**
 * Single-use tokens for setting a password.
 *
 * An admin does **not** choose someone else's password. They generate a link and hand it over,
 * and the person sets their own — so no administrator ever knows a colleague's password, and no
 * temporary password is stored anywhere in plaintext or sent through a channel nobody controls.
 *
 * It is also the shape self-service reset already needs: "forgot password" is this exact flow with
 * a different way of delivering the link and no `created_by`. That is why the table has that
 * column now rather than later — adding email means adding a sender, not reshaping a table or
 * re-testing the token semantics.
 *
 * The token is hashed at rest with the same helper sessions use. The raw value exists only in the
 * link, so a database dump is not a set of live password resets.
 */

/** How long a generated link stays usable. */
export const RESET_TOKEN_TTL_MS = 48 * 60 * 60 * 1000;

export class PasswordResetError extends Error {
  override name = 'PasswordResetError';
  constructor(
    message: string,
    readonly code: 'invalid' | 'weak_password',
  ) {
    super(message);
  }
}

/**
 * The minimum a password has to clear.
 *
 * Length only, and deliberately so. Composition rules — a digit, a symbol, mixed case — push people
 * towards `Password1!` and are worse than useless; length is the property that actually costs an
 * attacker something. NIST dropped composition requirements for the same reason.
 */
export const MIN_PASSWORD_LENGTH = 12;

export function assertUsablePassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordResetError(
      `Passwords must be at least ${MIN_PASSWORD_LENGTH} characters. A passphrase of a few ` +
        'unrelated words is easier to remember and harder to guess than a short complicated one.',
      'weak_password',
    );
  }
}

export interface GeneratedResetToken {
  /** The raw token. Exists only here and in the link — never stored, never logged. */
  token: string;
  expiresAt: Date;
}

export async function createPasswordResetToken(
  db: Kysely<Database>,
  userId: string,
  options: { createdBy?: string | null } = {},
): Promise<GeneratedResetToken> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

  /**
   * Any outstanding token for this user is dropped first.
   *
   * Generating a second link has to mean the first one is dead — otherwise an admin who reissues a
   * link because the last one "went to the wrong person" has changed nothing at all.
   */
  await db.deleteFrom('password_reset_tokens').where('user_id', '=', userId).execute();

  await db
    .insertInto('password_reset_tokens')
    .values({
      id: await hashSessionToken(token),
      user_id: userId,
      expires_at: expiresAt.toISOString(),
      created_by: options.createdBy ?? null,
      used_at: null,
      created_at: now(),
    })
    .execute();

  return { token, expiresAt };
}

/** The user a token is for, if it is valid. Does not consume it. */
export async function resolvePasswordResetToken(
  db: Kysely<Database>,
  token: string,
): Promise<User | undefined> {
  const row = await db
    .selectFrom('password_reset_tokens')
    .innerJoin('users', 'users.id', 'password_reset_tokens.user_id')
    .selectAll('users')
    .select('password_reset_tokens.expires_at as token_expires_at')
    .select('password_reset_tokens.used_at as token_used_at')
    .where('password_reset_tokens.id', '=', await hashSessionToken(token))
    .executeTakeFirst();

  if (!row) return undefined;
  if (row.token_used_at !== null) return undefined;
  if (Date.now() >= new Date(row.token_expires_at).getTime()) return undefined;
  // A deactivated account's outstanding link must stop working, the same way its sessions do.
  if (!row.is_active) return undefined;

  const { token_expires_at: _e, token_used_at: _u, ...user } = row;
  return user as User;
}

/**
 * Set a password using a token, and burn the token.
 *
 * Every session for the user is dropped as well. Someone setting a password because they lost
 * control of the account gains nothing if the session that took it stays live — and that is the
 * likeliest reason for a reset to be happening at all.
 */
export async function consumePasswordResetToken(
  db: Kysely<Database>,
  token: string,
  password: string,
): Promise<User> {
  assertUsablePassword(password);

  const user = await resolvePasswordResetToken(db, token);
  if (!user) {
    throw new PasswordResetError(
      'That link is no longer valid. It may have expired, already been used, or been replaced by ' +
        'a newer one. Ask an administrator for another.',
      'invalid',
    );
  }

  const id = await hashSessionToken(token);

  /**
   * Marked used by a conditional update, and the result is checked.
   *
   * Two requests arriving with the same link would otherwise both pass the read above and both set
   * a password. Only one can move `used_at` from null, so the loser is told the link is spent
   * rather than silently overwriting the winner's password.
   */
  const marked = await db
    .updateTable('password_reset_tokens')
    .set({ used_at: now() })
    .where('id', '=', id)
    .where('used_at', 'is', null)
    .executeTakeFirst();

  if (Number(marked.numUpdatedRows ?? 0) === 0) {
    throw new PasswordResetError('That link has already been used.', 'invalid');
  }

  await setPassword(db, user.id, password);
  await invalidateUserSessions(db, user.id);

  return user;
}

/** Drop tokens that have expired or been used. Safe to call on a schedule. */
export async function purgeStaleResetTokens(db: Kysely<Database>): Promise<number> {
  const result = await db
    .deleteFrom('password_reset_tokens')
    .where((eb) =>
      eb.or([eb('expires_at', '<', now()), eb('used_at', 'is not', null)]),
    )
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0);
}
