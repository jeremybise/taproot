import type { Kysely } from 'kysely';

import type { Database, User } from '../db/schema.js';
import { now } from '../db/values.js';
import { findUserById } from './users.js';
import { hashSessionToken } from './session.js';
import { findTotpStep, generateTotpSecret, totpUri } from './totp.js';

/**
 * Two-factor authentication, wiring up the TOTP core.
 *
 * That core has been implemented and verified against the RFC 6238 test vectors since Phase 0, and
 * reachable from nothing: no enrolment, no challenge at sign-in, so every export in `totp.ts` was
 * dead. It matters more now than it did then — email and password is the front door, and a
 * password is one secret.
 *
 * Three pieces beyond the algorithm, each of which is what separates a demo from something worth
 * turning on:
 *
 *  - **Enrolment is two-step.** The secret is stored unverified, and only a correct code marks it
 *    live. Trusting a scan would let someone lock themselves out by mis-scanning, and the account
 *    would demand a code from an authenticator that never got the secret.
 *  - **A spent code cannot be replayed** — see `last_used_step`.
 *  - **Recovery codes exist.** The failure mode 2FA introduces is a lost phone, and without
 *    recovery that means an administrator resetting it, or a database console for the last admin.
 */

/** How many recovery codes are issued at enrolment. */
export const RECOVERY_CODE_COUNT = 10;

/** How long a half-finished sign-in stays open. */
export const CHALLENGE_TTL_MS = 10 * 60 * 1000;

export class TwoFactorError extends Error {
  override name = 'TwoFactorError';
  constructor(
    message: string,
    readonly code: 'invalid_code' | 'not_enrolled' | 'already_enrolled',
  ) {
    super(message);
  }
}

export interface TwoFactorStatus {
  /** Enrolment finished: sign-in will ask for a code. */
  enabled: boolean;
  /** A secret exists but was never confirmed. Offering to start again is the right response. */
  pending: boolean;
  recoveryCodesRemaining: number;
}

export async function twoFactorStatus(
  db: Kysely<Database>,
  userId: string,
): Promise<TwoFactorStatus> {
  const secret = await db
    .selectFrom('totp_secrets')
    .select('verified_at')
    .where('user_id', '=', userId)
    .executeTakeFirst();

  const remaining = await db
    .selectFrom('totp_recovery_codes')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('user_id', '=', userId)
    .where('used_at', 'is', null)
    .executeTakeFirst();

  return {
    enabled: Boolean(secret?.verified_at),
    pending: Boolean(secret && !secret.verified_at),
    recoveryCodesRemaining: Number(remaining?.count ?? 0),
  };
}

/**
 * Start enrolment: mint a secret and return what an authenticator needs.
 *
 * Replaces any unconfirmed secret, so abandoning a half-finished attempt and starting again works
 * rather than wedging. A *confirmed* one is refused — turning 2FA off is a separate, deliberate
 * action, and silently replacing a working secret would be a way to take an account over from a
 * session someone left open.
 */
export async function beginTwoFactorEnrolment(
  db: Kysely<Database>,
  user: User,
): Promise<{ secret: string; uri: string }> {
  const existing = await db
    .selectFrom('totp_secrets')
    .select('verified_at')
    .where('user_id', '=', user.id)
    .executeTakeFirst();

  if (existing?.verified_at) {
    throw new TwoFactorError(
      'Two-factor authentication is already on for this account. Turn it off first.',
      'already_enrolled',
    );
  }

  const secret = generateTotpSecret();
  const timestamp = now();

  await db
    .insertInto('totp_secrets')
    .values({
      user_id: user.id,
      secret,
      verified_at: null,
      last_used_step: null,
      created_at: timestamp,
    })
    .onConflict((oc) =>
      oc.column('user_id').doUpdateSet({
        secret,
        verified_at: null,
        last_used_step: null,
        created_at: timestamp,
      }),
    )
    .execute();

  return { secret, uri: totpUri(secret, user.email) };
}

/**
 * Finish enrolment with a code from the authenticator, and issue recovery codes.
 *
 * The codes are returned once, in plain text, and stored only as hashes — so the screen showing
 * them is the only chance to keep them. That is the point rather than a limitation: a set of
 * recovery codes the server could read back is a set an attacker with database access could read
 * back too.
 */
export async function confirmTwoFactorEnrolment(
  db: Kysely<Database>,
  userId: string,
  code: string,
): Promise<string[]> {
  const row = await db
    .selectFrom('totp_secrets')
    .selectAll()
    .where('user_id', '=', userId)
    .executeTakeFirst();

  if (!row) throw new TwoFactorError('Start setting up two-factor first.', 'not_enrolled');

  const step = await findTotpStep(row.secret, code);
  if (step === null) {
    throw new TwoFactorError(
      'That code is not right. Check your authenticator and try the current one.',
      'invalid_code',
    );
  }

  await db
    .updateTable('totp_secrets')
    .set({ verified_at: now(), last_used_step: step })
    .where('user_id', '=', userId)
    .execute();

  return regenerateRecoveryCodes(db, userId);
}

/** Issue a fresh set, replacing any that remain. */
export async function regenerateRecoveryCodes(
  db: Kysely<Database>,
  userId: string,
): Promise<string[]> {
  await db.deleteFrom('totp_recovery_codes').where('user_id', '=', userId).execute();

  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode());
  const timestamp = now();

  await db
    .insertInto('totp_recovery_codes')
    .values(
      await Promise.all(
        codes.map(async (code) => ({
          id: await hashSessionToken(normalizeRecoveryCode(code)),
          user_id: userId,
          used_at: null,
          created_at: timestamp,
        })),
      ),
    )
    .execute();

  return codes;
}

/**
 * Check a code at sign-in — either from the authenticator or a recovery code.
 *
 * One function for both because the caller should not have to decide which the user typed, and
 * because a caller that checked them in two places would eventually check only one.
 */
export async function verifyTwoFactor(
  db: Kysely<Database>,
  userId: string,
  code: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('totp_secrets')
    .selectAll()
    .where('user_id', '=', userId)
    .executeTakeFirst();

  if (!row?.verified_at) return false;

  const step = await findTotpStep(row.secret, code);
  if (step !== null) {
    // Replay: the code is still inside its acceptance window but this step is already spent.
    if (row.last_used_step !== null && step <= row.last_used_step) return false;

    await db
      .updateTable('totp_secrets')
      .set({ last_used_step: step })
      .where('user_id', '=', userId)
      .execute();
    return true;
  }

  return consumeRecoveryCode(db, userId, code);
}

async function consumeRecoveryCode(
  db: Kysely<Database>,
  userId: string,
  code: string,
): Promise<boolean> {
  const id = await hashSessionToken(normalizeRecoveryCode(code));

  /**
   * Marked used by a conditional update whose row count is checked, rather than read-then-write.
   * Two requests racing the same code would otherwise both see it unused and both be let in.
   */
  const result = await db
    .updateTable('totp_recovery_codes')
    .set({ used_at: now() })
    .where('id', '=', id)
    .where('user_id', '=', userId)
    .where('used_at', 'is', null)
    .executeTakeFirst();

  return Number(result.numUpdatedRows ?? 0) === 1;
}

/** Turn two-factor off, dropping the secret and every remaining recovery code. */
export async function disableTwoFactor(db: Kysely<Database>, userId: string): Promise<void> {
  await db.deleteFrom('totp_recovery_codes').where('user_id', '=', userId).execute();
  await db.deleteFrom('totp_secrets').where('user_id', '=', userId).execute();
}

// ---------------------------------------------------------------------------
// The half-finished sign-in
// ---------------------------------------------------------------------------

export async function createLoginChallenge(
  db: Kysely<Database>,
  userId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);

  // One outstanding challenge per user: signing in again from another tab should invalidate the
  // first, not leave two doors ajar.
  await db.deleteFrom('login_challenges').where('user_id', '=', userId).execute();

  await db
    .insertInto('login_challenges')
    .values({
      id: await hashSessionToken(token),
      user_id: userId,
      expires_at: expiresAt.toISOString(),
      created_at: now(),
    })
    .execute();

  return { token, expiresAt };
}

/** The user a challenge is for, if it is still open. Does not consume it. */
export async function resolveLoginChallenge(
  db: Kysely<Database>,
  token: string,
): Promise<User | undefined> {
  const row = await db
    .selectFrom('login_challenges')
    .select(['user_id', 'expires_at'])
    .where('id', '=', await hashSessionToken(token))
    .executeTakeFirst();

  if (!row) return undefined;
  if (Date.now() >= new Date(row.expires_at).getTime()) return undefined;

  const user = await findUserById(db, row.user_id);
  // Deactivated between password and code: the half-finished sign-in must not outlive the account.
  return user?.is_active ? user : undefined;
}

export async function consumeLoginChallenge(db: Kysely<Database>, token: string): Promise<void> {
  await db.deleteFrom('login_challenges').where('id', '=', await hashSessionToken(token)).execute();
}

/** Drop challenges that have expired. Safe to call on a schedule. */
export async function purgeExpiredChallenges(db: Kysely<Database>): Promise<number> {
  const result = await db
    .deleteFrom('login_challenges')
    .where('expires_at', '<', now())
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0);
}

// ---------------------------------------------------------------------------

/**
 * Crockford-ish base32 without the characters people mistype.
 *
 * No `I`, `L`, `O`, `U`, or `0`/`1` — these get written on paper and read back later, and `0`/`O`
 * is the classic way a recovery code fails when it is needed most. Ten characters from a 27-symbol
 * alphabet is a little under 48 bits, which is far beyond guessing for a single-use secret.
 */
const RECOVERY_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

function generateRecoveryCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const body = [...bytes].map((b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join('');
  // Grouped for transcription; the separator is stripped on the way back in.
  return `${body.slice(0, 5)}-${body.slice(5)}`;
}

/** Accept a code however it was written down: spaced, hyphenated, lower case. */
export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}
