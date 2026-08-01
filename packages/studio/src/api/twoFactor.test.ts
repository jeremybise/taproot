import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_ATTEMPTS,
  beginTwoFactorEnrolment,
  confirmTwoFactorEnrolment,
  createUser,
  generateTotpCode,
  setPassword,
  twoFactorStatus,
  type User,
} from '@taprootcms/core';

import { createHarness, body, location, type Harness } from './testHarness.js';
import { POST as login } from './auth/login.js';
import { POST as verify } from './auth/verify.js';
import { POST as twoFactor } from './auth/two-factor.js';
import { CHALLENGE_COOKIE } from './auth/challengeCookie.js';
import { RECOVERY_COOKIE, readRecoveryCodes } from './auth/recoveryCookie.js';

/**
 * The two-factor sign-in path.
 *
 * The core is covered separately; what these pin down is the boundary between a correct password
 * and a session — the step where getting it wrong means the password alone lets someone in.
 */

let h: Harness;
let user: User;

const PASSWORD = 'a sufficiently long passphrase';

beforeEach(async () => {
  h = await createHarness();
  user = await createUser(h.db.db, { email: 'staff@campus.edu', name: 'Staff' });
  await setPassword(h.db.db, user.id, PASSWORD);
});

afterEach(async () => {
  await h.destroy();
});

function cookieValue(response: Response, name: string): string | undefined {
  const raw = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  if (!raw) return undefined;
  return raw.slice(name.length + 1, raw.indexOf(';') === -1 ? undefined : raw.indexOf(';'));
}

/** Enrol the user and return their secret. */
async function enrol(): Promise<string> {
  const { secret } = await beginTwoFactorEnrolment(h.db.db, user);
  await confirmTwoFactorEnrolment(h.db.db, user.id, await generateTotpCode(secret));
  return secret;
}

describe('signing in with a second factor', () => {
  it('does not issue a session for the password alone', async () => {
    /**
     * The whole point. If the session were created first and the code checked afterwards, the
     * password by itself would already have granted access — and the second factor would be a
     * screen rather than a control.
     */
    await enrol();

    const response = await login(
      h.context({ json: { email: 'staff@campus.edu', password: PASSWORD } }),
    );

    expect(response.status).toBe(202);
    expect(cookieValue(response, 'taproot_session')).toBeUndefined();
    expect(cookieValue(response, CHALLENGE_COOKIE)).toBeDefined();
    expect((await body(response)).twoFactorRequired).toBe(true);
  });

  it('sends a form login to the verify screen, keeping where they were headed', async () => {
    await enrol();

    const response = await login(
      h.context({
        form: { email: 'staff@campus.edu', password: PASSWORD, redirectTo: '/admin/media' },
      }),
    );

    expect(location(response)).toBe('/admin/verify?next=/admin/media');
  });

  it('issues the session once a correct code arrives', async () => {
    const secret = await enrol();
    const started = await login(
      h.context({ json: { email: 'staff@campus.edu', password: PASSWORD } }),
    );
    const challenge = cookieValue(started, CHALLENGE_COOKIE)!;

    const response = await verify(
      h.context({
        json: { code: await generateTotpCode(secret, Date.now() + 30_000) },
        headers: { cookie: `${CHALLENGE_COOKIE}=${challenge}` },
      }),
    );

    expect(response.status).toBe(200);
    expect(cookieValue(response, 'taproot_session')).toBeDefined();
    // And the challenge cookie is cleared, so a spent one cannot linger.
    expect(response.headers.getSetCookie().some((c) => c.startsWith(`${CHALLENGE_COOKIE}=;`))).toBe(
      true,
    );
  });

  it('refuses a wrong code without spending the challenge', async () => {
    // A mistyped digit must not cost someone their sign-in; the throttle bounds the retries.
    const secret = await enrol();
    const started = await login(
      h.context({ json: { email: 'staff@campus.edu', password: PASSWORD } }),
    );
    const headers = { cookie: `${CHALLENGE_COOKIE}=${cookieValue(started, CHALLENGE_COOKIE)}` };

    expect((await verify(h.context({ json: { code: '000000' }, headers }))).status).toBe(401);

    const second = await verify(
      h.context({ json: { code: await generateTotpCode(secret, Date.now() + 30_000) }, headers }),
    );
    expect(second.status).toBe(200);
  });

  it('refuses with no challenge at all', async () => {
    await enrol();
    const response = await verify(h.context({ json: { code: '123456' } }));

    expect(response.status).toBe(401);
    expect((await body(response)).error).toMatch(/timed out/);
  });

  it('does not accept a challenge twice', async () => {
    const secret = await enrol();
    const started = await login(
      h.context({ json: { email: 'staff@campus.edu', password: PASSWORD } }),
    );
    const headers = { cookie: `${CHALLENGE_COOKIE}=${cookieValue(started, CHALLENGE_COOKIE)}` };

    await verify(
      h.context({ json: { code: await generateTotpCode(secret, Date.now() + 30_000) }, headers }),
    );

    const replay = await verify(
      h.context({ json: { code: await generateTotpCode(secret, Date.now() + 60_000) }, headers }),
    );
    expect(replay.status).toBe(401);
  });

  it('throttles the code step as well as the password step', async () => {
    /**
     * Six digits is a million possibilities, which is nothing to a script. Without a limit here,
     * the second factor would be a speed bump on an account whose password was already phished.
     */
    await enrol();
    const started = await login(
      h.context({ json: { email: 'staff@campus.edu', password: PASSWORD } }),
    );
    const headers = { cookie: `${CHALLENGE_COOKIE}=${cookieValue(started, CHALLENGE_COOKIE)}` };

    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      await verify(h.context({ json: { code: '000000' }, headers }));
    }

    expect((await verify(h.context({ json: { code: '000000' }, headers }))).status).toBe(429);
  });

  it('leaves accounts without a second factor alone', async () => {
    const response = await login(
      h.context({ json: { email: 'staff@campus.edu', password: PASSWORD } }),
    );

    expect(response.status).toBe(200);
    expect(cookieValue(response, 'taproot_session')).toBeDefined();
  });
});

describe('managing it from the account screen', () => {
  beforeEach(() => h.as(user));

  it('enrols, confirms, and hands the recovery codes back in a cookie', async () => {
    await twoFactor(h.context({ form: { action: 'begin' } }));

    const secret = (await h.db.db
      .selectFrom('totp_secrets')
      .select('secret')
      .where('user_id', '=', user.id)
      .executeTakeFirstOrThrow()).secret;

    const response = await twoFactor(
      h.context({ form: { action: 'confirm', code: await generateTotpCode(secret) } }),
    );

    expect(location(response)).toBe('/admin/account?enabled=1');
    // Not in the URL: ten working recovery codes in browser history is not a trade worth making.
    expect(location(response)).not.toMatch(/[A-Z]{5}-/);
    expect(readRecoveryCodes(cookieValue(response, RECOVERY_COOKIE))).toHaveLength(10);
    expect((await twoFactorStatus(h.db.db, user.id)).enabled).toBe(true);
  });

  it('needs the current password to turn a live second factor off', async () => {
    // A second factor that whoever finds an unlocked laptop can switch off is not a second factor.
    await enrol();

    const wrong = await twoFactor(h.context({ form: { action: 'disable', password: 'nope' } }));
    expect(location(wrong)).toMatch(/not your current password/);
    expect((await twoFactorStatus(h.db.db, user.id)).enabled).toBe(true);

    const right = await twoFactor(
      h.context({ form: { action: 'disable', password: PASSWORD } }),
    );
    expect(location(right)).toBe('/admin/account?disabled=1');
    expect((await twoFactorStatus(h.db.db, user.id)).enabled).toBe(false);
  });

  it('does not ask for a password to abandon a half-finished setup', async () => {
    // An unconfirmed secret protects nothing, so discarding it takes nothing away.
    await twoFactor(h.context({ form: { action: 'begin' } }));

    const response = await twoFactor(h.context({ form: { action: 'disable' } }));
    expect(location(response)).toBe('/admin/account?disabled=cancelled');
    expect((await twoFactorStatus(h.db.db, user.id)).pending).toBe(false);
  });

  it('needs the current password to reissue recovery codes', async () => {
    await enrol();

    const wrong = await twoFactor(h.context({ form: { action: 'regenerate', password: 'nope' } }));
    expect(location(wrong)).toMatch(/not your current password/);

    const right = await twoFactor(
      h.context({ form: { action: 'regenerate', password: PASSWORD } }),
    );
    expect(readRecoveryCodes(cookieValue(right, RECOVERY_COOKIE))).toHaveLength(10);
  });

  it('refuses to re-enrol over a working secret', async () => {
    await enrol();
    const response = await twoFactor(h.context({ form: { action: 'begin' } }));
    expect(location(response)).toMatch(/already on/);
  });

  it('rejects an unknown action', async () => {
    expect((await twoFactor(h.context({ form: { action: 'something' } }))).status).toBe(400);
  });

  it('needs a signed-in user', async () => {
    h.as(undefined);
    expect((await twoFactor(h.context({ form: { action: 'begin' } }))).status).toBe(401);
  });
});
