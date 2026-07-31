import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type TaprootDb } from '../db/client.js';
import { migrateToLatest } from '../db/migrations/index.js';
import { hashPassword, needsRehash, timingSafeEqual, verifyPassword } from './password.js';
import {
  buildSessionCookie,
  createSession,
  invalidateSession,
  invalidateUserSessions,
  purgeExpiredSessions,
  validateSession,
} from './session.js';
import { createUser, upsertOAuthUser, verifyCredentials, normalizeEmail } from './users.js';
import { AuthConfigError, resolveAuthConfig } from './config.js';
import { base32Decode, base32Encode, generateTotpCode, generateTotpSecret, verifyTotpCode } from './totp.js';

let handle: TaprootDb;

beforeEach(async () => {
  handle = await createDb({ driver: 'sqlite', location: ':memory:' });
  const result = await migrateToLatest(handle.db);
  if (result.error) throw result.error;
});

afterEach(async () => {
  await handle.destroy();
});

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword('correct horse battery staple', hash)).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword('Correct horse battery staple', hash)).resolves.toBe(false);
  });

  it('produces a different hash each time (salted)', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    expect(a).not.toBe(b);
  });

  it('returns false for malformed hashes instead of throwing', async () => {
    for (const bad of ['', 'nonsense', 'pbkdf2$notanumber$a$b', 'bcrypt$1$a$b', 'pbkdf2$1$$']) {
      await expect(verifyPassword('x', bad)).resolves.toBe(false);
    }
  });

  it('flags hashes with a weaker iteration count for upgrade', async () => {
    const weak = await hashPassword('x', 1000);
    expect(needsRehash(weak)).toBe(true);
    const current = await hashPassword('x');
    expect(needsRehash(current)).toBe(false);
  });

  it('compares byte arrays safely', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

describe('credentials', () => {
  it('authenticates a seeded user', async () => {
    await createUser(handle.db, {
      email: 'Admin@Example.com',
      name: 'Admin',
      role: 'admin',
      password: 'taproot-dev',
    });

    const user = await verifyCredentials(handle.db, 'admin@example.com', 'taproot-dev');
    expect(user?.role).toBe('admin');
  });

  it('normalizes email case and whitespace', () => {
    expect(normalizeEmail('  Admin@Example.COM ')).toBe('admin@example.com');
  });

  it('rejects a wrong password', async () => {
    await createUser(handle.db, { email: 'a@b.c', name: 'A', password: 'right' });
    await expect(verifyCredentials(handle.db, 'a@b.c', 'wrong')).resolves.toBeUndefined();
  });

  it('rejects an unknown user without disclosing that it is unknown', async () => {
    await expect(verifyCredentials(handle.db, 'nobody@example.com', 'x')).resolves.toBeUndefined();
  });

  it('rejects a user with no password set', async () => {
    await createUser(handle.db, { email: 'oauth@example.com', name: 'O' });
    await expect(verifyCredentials(handle.db, 'oauth@example.com', 'x')).resolves.toBeUndefined();
  });

  it('refuses a deactivated user', async () => {
    const user = await createUser(handle.db, { email: 'x@y.z', name: 'X', password: 'pw' });
    await handle.db.updateTable('users').set({ is_active: 0 }).where('id', '=', user.id).execute();
    await expect(verifyCredentials(handle.db, 'x@y.z', 'pw')).resolves.toBeUndefined();
  });
});

describe('sessions', () => {
  async function seedUser() {
    return createUser(handle.db, { email: 'a@b.c', name: 'A', role: 'admin' });
  }

  it('creates and validates a session', async () => {
    const user = await seedUser();
    const { token } = await createSession(handle.db, user.id);

    const result = await validateSession(handle.db, token);
    expect(result?.user.id).toBe(user.id);
    expect(result?.refreshed).toBe(false);
  });

  it('stores only the hash of the token, never the token itself', async () => {
    const user = await seedUser();
    const { token } = await createSession(handle.db, user.id);

    const rows = await handle.db.selectFrom('sessions').select('id').execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).not.toBe(token);
    expect(rows[0]?.id).toHaveLength(64); // sha-256 hex
  });

  it('rejects an unknown token', async () => {
    await expect(validateSession(handle.db, 'not-a-real-token')).resolves.toBeNull();
  });

  it('rejects and deletes an expired session', async () => {
    const user = await seedUser();
    const { token } = await createSession(handle.db, user.id);

    await handle.db
      .updateTable('sessions')
      .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .execute();

    await expect(validateSession(handle.db, token)).resolves.toBeNull();
    const remaining = await handle.db.selectFrom('sessions').selectAll().execute();
    expect(remaining).toHaveLength(0);
  });

  it('extends a session that is close to expiry', async () => {
    const user = await seedUser();
    const { token } = await createSession(handle.db, user.id);

    // Push expiry inside the refresh threshold (less than half the 30-day lifetime remaining).
    await handle.db
      .updateTable('sessions')
      .set({ expires_at: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString() })
      .execute();

    const result = await validateSession(handle.db, token);
    expect(result?.refreshed).toBe(true);
  });

  it('stops working the moment a user is deactivated', async () => {
    const user = await seedUser();
    const { token } = await createSession(handle.db, user.id);
    await handle.db.updateTable('users').set({ is_active: 0 }).where('id', '=', user.id).execute();

    await expect(validateSession(handle.db, token)).resolves.toBeNull();
  });

  it('invalidates a single session', async () => {
    const user = await seedUser();
    const { token } = await createSession(handle.db, user.id);
    await invalidateSession(handle.db, token);
    await expect(validateSession(handle.db, token)).resolves.toBeNull();
  });

  it('invalidates every session for a user', async () => {
    const user = await seedUser();
    const a = await createSession(handle.db, user.id);
    const b = await createSession(handle.db, user.id);
    await invalidateUserSessions(handle.db, user.id);

    await expect(validateSession(handle.db, a.token)).resolves.toBeNull();
    await expect(validateSession(handle.db, b.token)).resolves.toBeNull();
  });

  it('purges expired sessions in bulk', async () => {
    const user = await seedUser();
    await createSession(handle.db, user.id);
    await handle.db
      .updateTable('sessions')
      .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .execute();

    await expect(purgeExpiredSessions(handle.db)).resolves.toBe(1);
  });

  it('builds a hardened cookie', () => {
    const cookie = buildSessionCookie('tok', new Date('2030-01-01'), { secure: true });
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
  });

  it('omits Secure for local http development', () => {
    const cookie = buildSessionCookie('tok', new Date('2030-01-01'), { secure: false });
    expect(cookie).not.toContain('Secure');
  });
});

describe('oauth account linking', () => {
  it('links a new provider identity to an existing account by email', async () => {
    const existing = await createUser(handle.db, {
      email: 'staff@campus.edu',
      name: 'Staff',
      role: 'editor',
    });

    const linked = await upsertOAuthUser(handle.db, {
      provider: 'google',
      providerUserId: 'g-123',
      email: 'staff@campus.edu',
      name: 'Staff Member',
    });

    // Same account, not a duplicate — and the existing role is preserved.
    expect(linked.id).toBe(existing.id);
    expect(linked.role).toBe('editor');
    const users = await handle.db.selectFrom('users').selectAll().execute();
    expect(users).toHaveLength(1);
  });

  it('returns the same user on repeat sign-in', async () => {
    const first = await upsertOAuthUser(handle.db, {
      provider: 'github',
      providerUserId: 'gh-1',
      email: 'new@campus.edu',
      name: 'New',
    });
    const second = await upsertOAuthUser(handle.db, {
      provider: 'github',
      providerUserId: 'gh-1',
      email: 'new@campus.edu',
      name: 'New',
    });

    expect(second.id).toBe(first.id);
    const links = await handle.db.selectFrom('oauth_accounts').selectAll().execute();
    expect(links).toHaveLength(1);
  });
});

describe('auth config guard', () => {
  it('enables password sign-in by default, in production as well as development', () => {
    // The reversal. This used to be a development-only provider that made the app refuse to boot
    // if requested anywhere else; it is now the primary way in, and OAuth is the addition.
    expect(resolveAuthConfig({ NODE_ENV: 'production' }).passwordAuthEnabled).toBe(true);
    expect(resolveAuthConfig({ NODE_ENV: 'development' }).passwordAuthEnabled).toBe(true);
  });

  it('lets a deployment turn it off for OAuth only', () => {
    const config = resolveAuthConfig({
      NODE_ENV: 'production',
      TAPROOT_PASSWORD_AUTH: '0',
      GITHUB_CLIENT_ID: 'id',
      GITHUB_CLIENT_SECRET: 'secret',
    });

    expect(config.passwordAuthEnabled).toBe(false);
    expect(config.providers.github).toBeDefined();
  });

  it('refuses to boot with no way in at all', () => {
    // Password sign-in off and no provider configured is a locked building. Cheaper to say so at
    // startup than to discover it at a login page with no buttons on it.
    expect(() =>
      resolveAuthConfig({ NODE_ENV: 'production', TAPROOT_PASSWORD_AUTH: '0' }),
    ).toThrow(AuthConfigError);
    expect(() =>
      resolveAuthConfig({ NODE_ENV: 'development', TAPROOT_PASSWORD_AUTH: '0' }),
    ).toThrow(AuthConfigError);
  });

  it('refuses to boot on the retired flag rather than ignoring it', () => {
    /**
     * `TAPROOT_DEV_AUTH` used to mean "switch the password provider on, local only". Silently
     * ignoring it now would leave an operator believing they had scoped something — and for the
     * `=0` case, believing they had turned something off that is in fact on.
     */
    expect(() =>
      resolveAuthConfig({ NODE_ENV: 'development', TAPROOT_DEV_AUTH: '1' }),
    ).toThrow(/no longer used/);
    expect(() =>
      resolveAuthConfig({ NODE_ENV: 'development', TAPROOT_DEV_AUTH: '0' }),
    ).toThrow(/no longer used/);
  });

  it('still sets secure cookies outside development', () => {
    expect(resolveAuthConfig({ NODE_ENV: 'production' }).secureCookies).toBe(true);
    expect(resolveAuthConfig({ NODE_ENV: 'development' }).secureCookies).toBe(false);
  });

  it('accepts an OAuth provider alongside passwords', () => {
    const config = resolveAuthConfig({
      NODE_ENV: 'production',
      GITHUB_CLIENT_ID: 'id',
      GITHUB_CLIENT_SECRET: 'secret',
    });

    expect(config.providers.github).toBeDefined();
    expect(config.passwordAuthEnabled).toBe(true);
  });
});

describe('totp', () => {
  it('round-trips base32', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });

  it('accepts a freshly generated code', async () => {
    const secret = generateTotpSecret();
    const code = await generateTotpCode(secret);
    await expect(verifyTotpCode(secret, code)).resolves.toBe(true);
  });

  it('rejects a code from a different secret', async () => {
    const code = await generateTotpCode(generateTotpSecret());
    await expect(verifyTotpCode(generateTotpSecret(), code)).resolves.toBe(false);
  });

  it('tolerates one period of clock drift but not more', async () => {
    const secret = generateTotpSecret();
    const base = 1_800_000_000_000;
    const code = await generateTotpCode(secret, base);

    await expect(verifyTotpCode(secret, code, { atMs: base + 30_000 })).resolves.toBe(true);
    await expect(verifyTotpCode(secret, code, { atMs: base + 120_000 })).resolves.toBe(false);
  });

  it('rejects malformed input', async () => {
    const secret = generateTotpSecret();
    for (const bad of ['', '12345', '1234567', 'abcdef']) {
      await expect(verifyTotpCode(secret, bad)).resolves.toBe(false);
    }
  });

  it('matches the RFC 6238 SHA-1 test vector', async () => {
    // RFC 6238 Appendix B uses the ASCII secret "12345678901234567890".
    const secret = base32Encode(new TextEncoder().encode('12345678901234567890'));
    await expect(generateTotpCode(secret, 59_000)).resolves.toBe('287082');
    await expect(generateTotpCode(secret, 1_111_111_109_000)).resolves.toBe('081804');
  });
});
