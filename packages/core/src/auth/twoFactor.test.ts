import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import { createUser } from './users.js';
import { generateTotpCode } from './totp.js';
import {
  RECOVERY_CODE_COUNT,
  TwoFactorError,
  beginTwoFactorEnrolment,
  confirmTwoFactorEnrolment,
  consumeLoginChallenge,
  createLoginChallenge,
  disableTwoFactor,
  normalizeRecoveryCode,
  purgeExpiredChallenges,
  regenerateRecoveryCodes,
  resolveLoginChallenge,
  twoFactorStatus,
  verifyTwoFactor,
} from './twoFactor.js';
import type { User } from '../db/schema.js';

/**
 * Two-factor authentication.
 *
 * The TOTP algorithm was already verified against the RFC 6238 vectors and reachable from nothing.
 * What these cover is everything around it that turns a correct algorithm into a usable control:
 * two-step enrolment, replay protection, recovery, and the half-finished sign-in.
 */

let handle: TaprootDb;
let user: User;

beforeEach(async () => {
  handle = await createDb({ driver: 'sqlite', location: ':memory:' });
  const result = await migrateToLatest(handle.db);
  if (result.error) throw result.error;
  user = await createUser(handle.db, { email: 'staff@campus.edu', name: 'Staff' });
});

afterEach(async () => {
  await handle.destroy();
});

/** Enrol fully and return the secret plus the recovery codes. */
async function enrol(): Promise<{ secret: string; codes: string[] }> {
  const { secret } = await beginTwoFactorEnrolment(handle.db, user);
  const codes = await confirmTwoFactorEnrolment(handle.db, user.id, await generateTotpCode(secret));
  return { secret, codes };
}

describe('enrolling', () => {
  it('is not live until a code confirms it', async () => {
    /**
     * The reason enrolment is two-step. Trusting the scan would let someone mis-scan and lock
     * themselves out of an account that then demands codes from an authenticator which never
     * received the secret.
     */
    const { secret } = await beginTwoFactorEnrolment(handle.db, user);

    expect(await twoFactorStatus(handle.db, user.id)).toMatchObject({
      enabled: false,
      pending: true,
    });
    expect(await verifyTwoFactor(handle.db, user.id, await generateTotpCode(secret))).toBe(false);
  });

  it('goes live once a correct code is given', async () => {
    await enrol();
    expect(await twoFactorStatus(handle.db, user.id)).toMatchObject({ enabled: true, pending: false });
  });

  it('refuses a wrong code and stays pending', async () => {
    await beginTwoFactorEnrolment(handle.db, user);
    await expect(confirmTwoFactorEnrolment(handle.db, user.id, '000000')).rejects.toThrow(
      TwoFactorError,
    );
    expect((await twoFactorStatus(handle.db, user.id)).enabled).toBe(false);
  });

  it('lets an abandoned attempt be restarted', async () => {
    // Half-finished enrolment must not wedge the account out of ever turning 2FA on.
    const first = await beginTwoFactorEnrolment(handle.db, user);
    const second = await beginTwoFactorEnrolment(handle.db, user);

    expect(second.secret).not.toBe(first.secret);
    await expect(
      confirmTwoFactorEnrolment(handle.db, user.id, await generateTotpCode(second.secret)),
    ).resolves.toHaveLength(RECOVERY_CODE_COUNT);
  });

  it('refuses to silently replace a working secret', async () => {
    /**
     * Turning 2FA off is a deliberate action. Without this, an unattended signed-in browser is a
     * way to re-enrol the account onto an attacker's authenticator.
     */
    await enrol();
    await expect(beginTwoFactorEnrolment(handle.db, user)).rejects.toThrow(/already on/);
  });

  it('offers a URI an authenticator can read', async () => {
    const { uri } = await beginTwoFactorEnrolment(handle.db, user);
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain(encodeURIComponent('Taproot:staff@campus.edu'));
  });
});

describe('verifying', () => {
  it('accepts the current code', async () => {
    const { secret } = await enrol();
    // Enrolment spends the current step, so verification is tested on the next one.
    const next = await generateTotpCode(secret, Date.now() + 30_000);
    expect(await verifyTwoFactor(handle.db, user.id, next)).toBe(true);
  });

  it('refuses a code that has already been used', async () => {
    /**
     * A code stays valid for its period plus the drift window, so without recording the step
     * spent, one observed over a shoulder — or relayed by a phishing page — works again for up to
     * ninety seconds.
     */
    const { secret } = await enrol();
    const code = await generateTotpCode(secret, Date.now() + 30_000);

    expect(await verifyTwoFactor(handle.db, user.id, code)).toBe(true);
    expect(await verifyTwoFactor(handle.db, user.id, code)).toBe(false);
  });

  it('refuses a wrong code, and anything that is not six digits', async () => {
    await enrol();
    for (const code of ['000000', 'abcdef', '12345', '1234567', '']) {
      expect(await verifyTwoFactor(handle.db, user.id, code)).toBe(false);
    }
  });

  it('refuses everything for an account that never enrolled', async () => {
    expect(await verifyTwoFactor(handle.db, user.id, '123456')).toBe(false);
  });
});

describe('recovery codes', () => {
  it('issues a set once, and never shows them again', async () => {
    const { codes } = await enrol();

    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);

    // Stored as hashes only: a set the server can read back is a set a database dump gives away.
    const stored = await handle.db.selectFrom('totp_recovery_codes').select('id').execute();
    expect(stored.map((row) => row.id)).not.toContain(codes[0]);
  });

  it('accepts one in place of a code, once', async () => {
    const { codes } = await enrol();

    expect(await verifyTwoFactor(handle.db, user.id, codes[0]!)).toBe(true);
    expect(await verifyTwoFactor(handle.db, user.id, codes[0]!)).toBe(false);
    expect((await twoFactorStatus(handle.db, user.id)).recoveryCodesRemaining).toBe(
      RECOVERY_CODE_COUNT - 1,
    );
  });

  it('accepts one however it was written down', async () => {
    // These get copied onto paper and typed back later, so spacing and case cannot matter.
    const { codes } = await enrol();
    const messy = ` ${codes[0]!.toLowerCase().replace('-', ' ')} `;

    expect(await verifyTwoFactor(handle.db, user.id, messy)).toBe(true);
  });

  it('avoids characters that get misread on paper', async () => {
    // 0/O and 1/I/L are how a recovery code fails at the moment it is actually needed. Checked
    // across a full set rather than one code, so a rare character cannot slip through.
    const { codes } = await enrol();
    const characters = new Set(codes.join('').replace(/-/g, ''));

    for (const confusable of ['0', '1', 'I', 'L', 'O', 'U']) {
      expect([...characters]).not.toContain(confusable);
    }
  });

  it('normalises separators and case on the way in', () => {
    expect(normalizeRecoveryCode(' abcde-fghij ')).toBe('ABCDEFGHIJ');
    expect(normalizeRecoveryCode('ABCDE FGHIJ')).toBe('ABCDEFGHIJ');
  });

  it('does not accept another account’s code', async () => {
    const { codes } = await enrol();
    const other = await createUser(handle.db, { email: 'other@campus.edu', name: 'Other' });
    const { secret } = await beginTwoFactorEnrolment(handle.db, other);
    await confirmTwoFactorEnrolment(handle.db, other.id, await generateTotpCode(secret));

    expect(await verifyTwoFactor(handle.db, other.id, codes[0]!)).toBe(false);
  });

  it('lets only one of two concurrent uses win', async () => {
    const { codes } = await enrol();

    const results = await Promise.all([
      verifyTwoFactor(handle.db, user.id, codes[0]!),
      verifyTwoFactor(handle.db, user.id, codes[0]!),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('can be reissued, invalidating the old set', async () => {
    const { codes } = await enrol();
    const fresh = await regenerateRecoveryCodes(handle.db, user.id);

    expect(await verifyTwoFactor(handle.db, user.id, codes[0]!)).toBe(false);
    expect(await verifyTwoFactor(handle.db, user.id, fresh[0]!)).toBe(true);
  });
});

describe('disabling', () => {
  it('removes the secret and the remaining codes', async () => {
    const { codes } = await enrol();
    await disableTwoFactor(handle.db, user.id);

    expect(await twoFactorStatus(handle.db, user.id)).toMatchObject({
      enabled: false,
      pending: false,
      recoveryCodesRemaining: 0,
    });
    expect(await verifyTwoFactor(handle.db, user.id, codes[0]!)).toBe(false);
  });
});

describe('the half-finished sign-in', () => {
  it('resolves to the user while it is open', async () => {
    const { token } = await createLoginChallenge(handle.db, user.id);
    expect((await resolveLoginChallenge(handle.db, token))?.id).toBe(user.id);
  });

  it('is consumed rather than left usable', async () => {
    const { token } = await createLoginChallenge(handle.db, user.id);
    await consumeLoginChallenge(handle.db, token);
    expect(await resolveLoginChallenge(handle.db, token)).toBeUndefined();
  });

  it('expires', async () => {
    const { token } = await createLoginChallenge(handle.db, user.id);
    await handle.db
      .updateTable('login_challenges')
      .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .execute();

    expect(await resolveLoginChallenge(handle.db, token)).toBeUndefined();
    expect(await purgeExpiredChallenges(handle.db)).toBe(1);
  });

  it('does not outlive the account being deactivated', async () => {
    // The password was right a moment ago; that must not carry someone past a deactivation that
    // happened in between.
    const { token } = await createLoginChallenge(handle.db, user.id);
    await handle.db.updateTable('users').set({ is_active: 0 }).where('id', '=', user.id).execute();

    expect(await resolveLoginChallenge(handle.db, token)).toBeUndefined();
  });

  it('keeps only the newest, so signing in twice does not leave two doors ajar', async () => {
    const first = await createLoginChallenge(handle.db, user.id);
    const second = await createLoginChallenge(handle.db, user.id);

    expect(await resolveLoginChallenge(handle.db, first.token)).toBeUndefined();
    expect(await resolveLoginChallenge(handle.db, second.token)).toBeDefined();
  });

  it('never stores the raw token', async () => {
    const { token } = await createLoginChallenge(handle.db, user.id);
    const rows = await handle.db.selectFrom('login_challenges').select('id').execute();
    expect(rows[0]!.id).not.toBe(token);
  });
});
