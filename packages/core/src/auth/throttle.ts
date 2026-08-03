import type { Kysely } from 'kysely';

import type { Database } from '../db/schema.js';
import { now } from '../db/values.js';
import { newId } from '../ids.js';

/**
 * Sign-in throttling.
 *
 * There was none while password sign-in was a local convenience, which was defensible: an attacker
 * who can reach your laptop's dev server has already won. As the production front door it is the
 * difference between a password and no password at all — PBKDF2 at 100k iterations makes each
 * guess expensive for the *server*, and does nothing to stop an attacker making millions of them.
 *
 * Two identifiers, counted separately and both enforced:
 *
 * - **by email**, which stops one account being ground down; and
 * - **by IP**, which stops the same client spraying one guess across every account it can name.
 *   Per-email limiting alone is the classic gap — "password123" against a thousand addresses trips
 *   no per-account counter anywhere.
 *
 * Deliberately in the database rather than in memory. A Worker isolate is per-request and short
 * lived, so an in-process map would reset constantly and protect nothing; and two isolates would
 * each keep their own count. One indexed query per attempt is the price of a limit that is real.
 */

/** Failures allowed per identifier before sign-in is refused. */
export const MAX_ATTEMPTS = 10;

/** How far back failures are counted, and therefore how long a lockout lasts. */
export const WINDOW_MS = 15 * 60 * 1000;

export interface ThrottleStatus {
  blocked: boolean;
  /** Failures counted in the window, for the caller to log. Never shown to the client. */
  attempts: number;
  /** When the oldest counted failure ages out, so a caller can say how long to wait. */
  retryAfterSeconds: number;
}

export function emailKey(email: string): string {
  return `email:${email.trim().toLowerCase()}`;
}

export function ipKey(ip: string): string {
  return `ip:${ip.trim()}`;
}

/** Failed reset requests allowed per identifier. Lower than sign-in: nobody mistypes this form. */
export const MAX_RESET_REQUESTS = 5;

/**
 * Password-reset requests count in their own keyspace, not against sign-in.
 *
 * Sharing the `email:` key would hand anyone a denial of service: fire ten reset requests at an
 * address and its owner can no longer sign in for fifteen minutes, having done nothing and
 * received nothing but junk mail. The counters have to be separate for the limit on one to not be
 * a weapon against the other.
 */
export function resetEmailKey(email: string): string {
  return `reset-email:${email.trim().toLowerCase()}`;
}

export function resetIpKey(ip: string): string {
  return `reset-ip:${ip.trim()}`;
}

/**
 * Whether any of these identifiers is currently over the limit.
 *
 * Checked *before* verifying the password, so a locked-out attempt costs one indexed count rather
 * than a 100,000-iteration key derivation. That matters: without it, the throttle would make the
 * server do the expensive work anyway and become its own denial-of-service amplifier.
 */
export async function checkThrottle(
  db: Kysely<Database>,
  identifiers: string[],
  limit: number = MAX_ATTEMPTS,
): Promise<ThrottleStatus> {
  if (identifiers.length === 0) {
    return { blocked: false, attempts: 0, retryAfterSeconds: 0 };
  }

  const since = new Date(Date.now() - WINDOW_MS).toISOString();

  const rows = await db
    .selectFrom('login_attempts')
    .select(['identifier', 'created_at'])
    .where('identifier', 'in', identifiers)
    .where('created_at', '>=', since)
    .execute();

  let worst = 0;
  let oldestOfWorst: string | undefined;

  for (const identifier of identifiers) {
    const forThis = rows.filter((row) => row.identifier === identifier);
    if (forThis.length <= worst) continue;
    worst = forThis.length;
    oldestOfWorst = forThis.reduce(
      (oldest, row) => (row.created_at < oldest ? row.created_at : oldest),
      forThis[0]!.created_at,
    );
  }

  if (worst < limit) {
    return { blocked: false, attempts: worst, retryAfterSeconds: 0 };
  }

  // The lock lifts as the oldest counted failure ages out of the window, so a client that stops
  // guessing recovers on its own rather than needing an administrator.
  const freeAt = new Date(oldestOfWorst!).getTime() + WINDOW_MS;
  return {
    blocked: true,
    attempts: worst,
    retryAfterSeconds: Math.max(1, Math.ceil((freeAt - Date.now()) / 1000)),
  };
}

/** Record a failure against each identifier. */
export async function recordFailedAttempt(
  db: Kysely<Database>,
  identifiers: string[],
): Promise<void> {
  if (identifiers.length === 0) return;

  const timestamp = now();
  await db
    .insertInto('login_attempts')
    .values(
      identifiers.map((identifier) => ({ id: newId(), identifier, created_at: timestamp })),
    )
    .execute();
}

/**
 * Clear the counters after a successful sign-in.
 *
 * Only for the identifiers that just succeeded. Someone who mistypes their password four times and
 * then gets it right should start from zero — but the IP is cleared too, deliberately, because an
 * attacker who guesses one password correctly has a session and no longer needs the login form.
 */
export async function clearAttempts(
  db: Kysely<Database>,
  identifiers: string[],
): Promise<void> {
  if (identifiers.length === 0) return;
  await db.deleteFrom('login_attempts').where('identifier', 'in', identifiers).execute();
}

/** Drop attempts that have aged out. Safe to call on a schedule. */
export async function purgeExpiredAttempts(db: Kysely<Database>): Promise<number> {
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const result = await db
    .deleteFrom('login_attempts')
    .where('created_at', '<', since)
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0);
}
