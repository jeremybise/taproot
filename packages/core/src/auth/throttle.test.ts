import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import {
  MAX_ATTEMPTS,
  MAX_RESET_REQUESTS,
  WINDOW_MS,
  checkThrottle,
  clearAttempts,
  emailKey,
  ipKey,
  purgeExpiredAttempts,
  resetEmailKey,
  resetIpKey,
  recordFailedAttempt,
} from './throttle.js';
import { newId } from '../ids.js';

/**
 * Sign-in throttling.
 *
 * There was none while password sign-in was a local convenience. As the production front door it
 * is what stands between a password and unlimited guesses — PBKDF2 makes each attempt expensive
 * for the server and does nothing to limit how many an attacker makes.
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

const email = emailKey('someone@campus.edu');
const ip = ipKey('203.0.113.4');

/** Write a failure with a chosen age, for the window-boundary cases. */
async function failureAt(identifier: string, msAgo: number) {
  await handle.db
    .insertInto('login_attempts')
    .values({
      id: newId(),
      identifier,
      created_at: new Date(Date.now() - msAgo).toISOString(),
    })
    .execute();
}

describe('counting', () => {
  it('allows attempts below the limit', async () => {
    for (let i = 0; i < MAX_ATTEMPTS - 1; i += 1) {
      await recordFailedAttempt(handle.db, [email]);
    }

    const status = await checkThrottle(handle.db, [email]);
    expect(status.blocked).toBe(false);
    expect(status.attempts).toBe(MAX_ATTEMPTS - 1);
  });

  it('blocks at the limit', async () => {
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      await recordFailedAttempt(handle.db, [email]);
    }

    expect((await checkThrottle(handle.db, [email])).blocked).toBe(true);
  });

  it('normalises the email so case and spacing cannot dodge the count', async () => {
    // Otherwise `Someone@Campus.edu` is a fresh allowance for the same account.
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      await recordFailedAttempt(handle.db, [emailKey('  SOMEONE@campus.EDU ')]);
    }

    expect((await checkThrottle(handle.db, [email])).blocked).toBe(true);
  });

  it('does not confuse an email with an address', async () => {
    // Both live in one table, so the kind prefix is what keeps them separate.
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      await recordFailedAttempt(handle.db, [email]);
    }

    expect((await checkThrottle(handle.db, [ip])).blocked).toBe(false);
  });
});

describe('the two identifiers', () => {
  it('blocks when either one is over, not only when both are', async () => {
    /**
     * The per-IP half exists for password spraying: one guess against a thousand addresses trips
     * no per-account counter anywhere, which is why per-email limiting alone is the classic gap.
     */
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      await recordFailedAttempt(handle.db, [ip]);
    }

    const status = await checkThrottle(handle.db, [emailKey('fresh@campus.edu'), ip]);
    expect(status.blocked).toBe(true);
  });

  it('records against every identifier given', async () => {
    await recordFailedAttempt(handle.db, [email, ip]);

    expect((await checkThrottle(handle.db, [email])).attempts).toBe(1);
    expect((await checkThrottle(handle.db, [ip])).attempts).toBe(1);
  });

  it('copes with no trustworthy address at all', async () => {
    // `clientIp` returns nothing when there is no `CF-Connecting-IP`, which leaves the per-email
    // limit doing the work rather than throttling everyone behind one proxy as a single client.
    await expect(recordFailedAttempt(handle.db, [])).resolves.toBeUndefined();
    expect(await checkThrottle(handle.db, [])).toEqual({
      blocked: false,
      attempts: 0,
      retryAfterSeconds: 0,
    });
  });
});

describe('the window', () => {
  it('ignores failures older than the window', async () => {
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      await failureAt(email, WINDOW_MS + 60_000);
    }

    expect((await checkThrottle(handle.db, [email])).blocked).toBe(false);
  });

  it('lets the lock lift on its own as the oldest failure ages out', async () => {
    /**
     * The property that makes this usable without an administrator: someone who stops guessing
     * recovers by waiting. A fixed lockout that only an admin could clear would turn a mistyped
     * password into a support ticket.
     */
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      await failureAt(email, WINDOW_MS - 60_000);
    }

    const status = await checkThrottle(handle.db, [email]);
    expect(status.blocked).toBe(true);
    expect(status.retryAfterSeconds).toBeGreaterThan(0);
    expect(status.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('counts a partly-aged run correctly', async () => {
    // Half outside the window, half inside: only the recent ones count, so this is under the limit.
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) await failureAt(email, WINDOW_MS + 1000);
    for (let i = 0; i < MAX_ATTEMPTS - 1; i += 1) await recordFailedAttempt(handle.db, [email]);

    expect((await checkThrottle(handle.db, [email])).blocked).toBe(false);
  });
});

describe('clearing', () => {
  it('resets the count after a successful sign-in', async () => {
    // Someone who mistypes their password four times and then gets it right starts from zero.
    for (let i = 0; i < MAX_ATTEMPTS - 1; i += 1) {
      await recordFailedAttempt(handle.db, [email, ip]);
    }

    await clearAttempts(handle.db, [email, ip]);
    expect((await checkThrottle(handle.db, [email, ip])).attempts).toBe(0);
  });

  it('leaves other identifiers alone', async () => {
    const other = emailKey('someone-else@campus.edu');
    await recordFailedAttempt(handle.db, [email]);
    await recordFailedAttempt(handle.db, [other]);

    await clearAttempts(handle.db, [email]);
    expect((await checkThrottle(handle.db, [other])).attempts).toBe(1);
  });

  it('purges only what has aged out', async () => {
    await failureAt(email, WINDOW_MS + 60_000);
    await recordFailedAttempt(handle.db, [email]);

    expect(await purgeExpiredAttempts(handle.db)).toBe(1);
    expect((await checkThrottle(handle.db, [email])).attempts).toBe(1);
  });
});

describe('password-reset requests', () => {
  it('do not count against signing in', async () => {
    /**
     * The reason the keyspace is separate at all. Sharing `email:` would hand anyone a denial of
     * service: fire a handful of reset requests at a colleague's address and they can no longer
     * sign in for fifteen minutes, having done nothing and received nothing but junk mail.
     */
    const email = 'staff@campus.edu';
    const resetIds = [resetEmailKey(email), resetIpKey('203.0.113.9')];

    for (let i = 0; i < MAX_RESET_REQUESTS * 3; i += 1) {
      await recordFailedAttempt(handle.db, resetIds);
    }

    expect((await checkThrottle(handle.db, resetIds, MAX_RESET_REQUESTS)).blocked).toBe(true);
    // And the sign-in counters for the very same person and address are untouched.
    expect(
      (await checkThrottle(handle.db, [emailKey(email), ipKey('203.0.113.9')])).blocked,
    ).toBe(false);
  });

  it('block at their own lower limit', async () => {
    // Nobody mistypes a form with one field on it, so the allowance is smaller than sign-in's.
    const ids = [resetEmailKey('staff@campus.edu')];

    for (let i = 0; i < MAX_RESET_REQUESTS; i += 1) {
      await recordFailedAttempt(handle.db, ids);
    }

    expect((await checkThrottle(handle.db, ids, MAX_RESET_REQUESTS)).blocked).toBe(true);
    // The same rows are well short of the sign-in limit, which is the point of passing one.
    expect((await checkThrottle(handle.db, ids)).blocked).toBe(false);
  });

  it('separate one address from another', async () => {
    for (let i = 0; i < MAX_RESET_REQUESTS; i += 1) {
      await recordFailedAttempt(handle.db, [resetEmailKey('staff@campus.edu')]);
    }

    expect(
      (await checkThrottle(handle.db, [resetEmailKey('other@campus.edu')], MAX_RESET_REQUESTS))
        .blocked,
    ).toBe(false);
  });

  it('normalise case the way the sign-in key does', async () => {
    expect(resetEmailKey('  Staff@Campus.edu ')).toBe(resetEmailKey('staff@campus.edu'));
  });
});
