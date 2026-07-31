import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import { createUser, verifyCredentials } from './users.js';
import { createSession, validateSession } from './session.js';
import {
  MIN_PASSWORD_LENGTH,
  RESET_TOKEN_TTL_MS,
  consumePasswordResetToken,
  createPasswordResetToken,
  requestPasswordReset,
  purgeStaleResetTokens,
  resolvePasswordResetToken,
} from './passwordReset.js';
import { hashSessionToken } from './session.js';

/**
 * Single-use tokens for setting a password.
 *
 * An admin generates a link rather than choosing someone's password, so no administrator ever
 * knows a colleague's password and no temporary one is stored in plaintext. The same table and the
 * same semantics serve an email-delivered reset later — only the delivery and `created_by` differ.
 */

let handle: TaprootDb;
let userId: string;
let adminId: string;

const GOOD_PASSWORD = 'correct horse battery staple';

beforeEach(async () => {
  handle = await createDb({ driver: 'sqlite', location: ':memory:' });
  const result = await migrateToLatest(handle.db);
  if (result.error) throw result.error;

  userId = (await createUser(handle.db, { email: 'staff@campus.edu', name: 'Staff' })).id;
  adminId = (await createUser(handle.db, { email: 'admin@campus.edu', name: 'Admin', role: 'admin' }))
    .id;
});

afterEach(async () => {
  await handle.destroy();
});

describe('generating', () => {
  it('never stores the raw token', async () => {
    // The same model as sessions: a database dump must not be a set of live password resets.
    const { token } = await createPasswordResetToken(handle.db, userId);

    const rows = await handle.db.selectFrom('password_reset_tokens').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).not.toBe(token);
    expect(rows[0]!.id).toBe(await hashSessionToken(token));
  });

  it('records who generated it, and tolerates nobody', async () => {
    /**
     * The seam for email-delivered reset. An admin-generated link records the admin; a future
     * "forgot password" link records nobody, and nothing else about the flow differs.
     */
    const byAdmin = await createPasswordResetToken(handle.db, userId, { createdBy: adminId });
    expect(
      (await handle.db.selectFrom('password_reset_tokens').select('created_by').executeTakeFirst())
        ?.created_by,
    ).toBe(adminId);

    await createPasswordResetToken(handle.db, userId);
    expect(
      (await handle.db.selectFrom('password_reset_tokens').select('created_by').executeTakeFirst())
        ?.created_by,
    ).toBeNull();

    // And the first one is dead, which is the next test's subject.
    expect(await resolvePasswordResetToken(handle.db, byAdmin.token)).toBeUndefined();
  });

  it('invalidates any outstanding token for that user', async () => {
    // Reissuing because the last link "went to the wrong person" has to actually kill the old one.
    const first = await createPasswordResetToken(handle.db, userId);
    const second = await createPasswordResetToken(handle.db, userId);

    expect(await resolvePasswordResetToken(handle.db, first.token)).toBeUndefined();
    expect(await resolvePasswordResetToken(handle.db, second.token)).toBeDefined();
  });

  it('expires', async () => {
    const { expiresAt } = await createPasswordResetToken(handle.db, userId);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + RESET_TOKEN_TTL_MS);
  });
});

describe('resolving', () => {
  it('returns the user a valid token belongs to', async () => {
    const { token } = await createPasswordResetToken(handle.db, userId);
    expect((await resolvePasswordResetToken(handle.db, token))?.id).toBe(userId);
  });

  it('rejects an unknown token', async () => {
    expect(await resolvePasswordResetToken(handle.db, 'not-a-token')).toBeUndefined();
  });

  it('rejects an expired one', async () => {
    const { token } = await createPasswordResetToken(handle.db, userId);
    await handle.db
      .updateTable('password_reset_tokens')
      .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .execute();

    expect(await resolvePasswordResetToken(handle.db, token)).toBeUndefined();
  });

  it('rejects one belonging to a deactivated account', async () => {
    // An outstanding link has to stop working the same way that account's sessions do — otherwise
    // deactivating someone leaves them a way back in that nobody thought to revoke.
    const { token } = await createPasswordResetToken(handle.db, userId);
    await handle.db.updateTable('users').set({ is_active: 0 }).where('id', '=', userId).execute();

    expect(await resolvePasswordResetToken(handle.db, token)).toBeUndefined();
  });
});

describe('consuming', () => {
  it('sets the password so the user can sign in', async () => {
    const { token } = await createPasswordResetToken(handle.db, userId);
    await consumePasswordResetToken(handle.db, token, GOOD_PASSWORD);

    expect(await verifyCredentials(handle.db, 'staff@campus.edu', GOOD_PASSWORD)).toBeDefined();
  });

  it('burns the token', async () => {
    const { token } = await createPasswordResetToken(handle.db, userId);
    await consumePasswordResetToken(handle.db, token, GOOD_PASSWORD);

    await expect(
      consumePasswordResetToken(handle.db, token, 'another valid passphrase'),
    ).rejects.toThrow(/already been used|no longer valid/);
  });

  it('drops every existing session for that user', async () => {
    /**
     * Someone resetting because they lost control of the account gains nothing if the session that
     * took it stays live — and that is the likeliest reason a reset is happening.
     */
    const { token: sessionToken } = await createSession(handle.db, userId);
    expect(await validateSession(handle.db, sessionToken)).not.toBeNull();

    const { token } = await createPasswordResetToken(handle.db, userId);
    await consumePasswordResetToken(handle.db, token, GOOD_PASSWORD);

    expect(await validateSession(handle.db, sessionToken)).toBeNull();
  });

  it('refuses a password shorter than the minimum', async () => {
    const { token } = await createPasswordResetToken(handle.db, userId);
    await expect(
      consumePasswordResetToken(handle.db, token, 'a'.repeat(MIN_PASSWORD_LENGTH - 1)),
    ).rejects.toThrow(/at least/);
  });

  it('checks the password before spending the token', async () => {
    // Otherwise a typo that fails the length rule burns the link and the person has to ask for
    // another one.
    const { token } = await createPasswordResetToken(handle.db, userId);
    await expect(consumePasswordResetToken(handle.db, token, 'short')).rejects.toThrow();

    expect(await resolvePasswordResetToken(handle.db, token)).toBeDefined();
  });

  it('accepts a long passphrase without composition rules', async () => {
    /**
     * Length only, deliberately. Composition rules push people towards `Password1!`, which is
     * shorter and more guessable than four unrelated words; NIST dropped them for that reason.
     */
    const { token } = await createPasswordResetToken(handle.db, userId);
    await expect(
      consumePasswordResetToken(handle.db, token, 'all lowercase words no digits here'),
    ).resolves.toBeDefined();
  });

  it('lets only one of two concurrent uses win', async () => {
    /**
     * Both requests pass the read, and only one can move `used_at` off null. The loser is told the
     * link is spent rather than silently overwriting the winner's password — which is the outcome
     * that matters, because the winner is the person actually sitting at the form.
     */
    const { token } = await createPasswordResetToken(handle.db, userId);

    const results = await Promise.allSettled([
      consumePasswordResetToken(handle.db, token, 'first passphrase here'),
      consumePasswordResetToken(handle.db, token, 'second passphrase here'),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
});

describe('purging', () => {
  it('removes used and expired tokens, and leaves live ones', async () => {
    const live = await createPasswordResetToken(handle.db, userId);
    const other = (await createUser(handle.db, { email: 'other@campus.edu', name: 'Other' })).id;
    const spent = await createPasswordResetToken(handle.db, other);
    await consumePasswordResetToken(handle.db, spent.token, GOOD_PASSWORD);

    expect(await purgeStaleResetTokens(handle.db)).toBe(1);
    expect(await resolvePasswordResetToken(handle.db, live.token)).toBeDefined();
  });
});

describe('requesting one for yourself', () => {
  it('mints a working token for a known address', async () => {
    const result = await requestPasswordReset(handle.db, 'staff@campus.edu');

    expect(result).toBeDefined();
    expect((await resolvePasswordResetToken(handle.db, result!.token))?.id).toBe(userId);
  });

  it('records nobody as the author, which is what makes it self-service', async () => {
    // An admin-generated link names the admin. This one was authorised by no one — somebody merely
    // asked — and the nullable column existed for this before there was anything to put in it.
    await requestPasswordReset(handle.db, 'staff@campus.edu');

    const row = await handle.db
      .selectFrom('password_reset_tokens')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(row.created_by).toBeNull();
  });

  it('matches an address regardless of case', async () => {
    // People type their own address the way they feel like typing it, and a reset that silently
    // does nothing for `Staff@Campus.edu` is indistinguishable from a broken mailer.
    expect(await requestPasswordReset(handle.db, 'STAFF@campus.edu')).toBeDefined();
  });

  it('returns nothing for an address nobody holds', async () => {
    // The caller responds identically either way — this is what lets it, rather than the caller
    // having to know whether an error means "no account" or "something broke".
    expect(await requestPasswordReset(handle.db, 'nobody@campus.edu')).toBeUndefined();
  });

  it('returns nothing for a deactivated account', async () => {
    /**
     * The same rule `resolvePasswordResetToken` already applies to an outstanding link. Minting one
     * here would let a removed account be recovered by whoever still reads that mailbox — which is
     * precisely the person deactivation was aimed at.
     */
    await handle.db.updateTable('users').set({ is_active: 0 }).where('id', '=', userId).execute();

    expect(await requestPasswordReset(handle.db, 'staff@campus.edu')).toBeUndefined();
  });

  it('replaces an outstanding link rather than adding a second', async () => {
    // Asking twice has to kill the first link, or "I think that one went to the wrong place" has
    // no remedy.
    const first = await requestPasswordReset(handle.db, 'staff@campus.edu');
    const second = await requestPasswordReset(handle.db, 'staff@campus.edu');

    expect(await resolvePasswordResetToken(handle.db, first!.token)).toBeUndefined();
    expect(await resolvePasswordResetToken(handle.db, second!.token)).toBeDefined();
  });

  it('supersedes an admin-generated link too', async () => {
    // Both write the same row, so the newest wins whichever way it was created. Worth pinning:
    // two paths to one table is exactly where a second row would quietly appear.
    const byAdmin = await createPasswordResetToken(handle.db, userId, { createdBy: adminId });
    await requestPasswordReset(handle.db, 'staff@campus.edu');

    expect(await resolvePasswordResetToken(handle.db, byAdmin.token)).toBeUndefined();
  });
});
