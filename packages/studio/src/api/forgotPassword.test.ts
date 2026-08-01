import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_ATTEMPTS,
  MAX_RESET_REQUESTS,
  consumePasswordResetToken,
  createUser,
  emailKey,
  checkThrottle,
  setPassword,
  verifyCredentials,
} from '@taproot/core';

import { createHarness, body, location, type Harness } from './testHarness.js';
import { POST as forgotPassword } from './auth/forgot-password.js';

/**
 * Self-service password reset.
 *
 * The token semantics are `passwordReset.test.ts`'s job. What is only testable at the route is the
 * part that is easy to get subtly wrong and impossible to notice: that the response says the same
 * thing no matter who asked, and that asking cannot be turned into a weapon against the person
 * whose address was typed.
 */

let h: Harness;

const PASSWORD = 'a sufficiently long passphrase';

beforeEach(async () => {
  h = await createHarness();
  const user = await createUser(h.db.db, { email: 'staff@campus.edu', name: 'Staff' });
  await setPassword(h.db.db, user.id, PASSWORD);
});

afterEach(async () => {
  await h.destroy();
  vi.restoreAllMocks();
});

const ask = (email: string, form = false) =>
  forgotPassword(h.context(form ? { form: { email } } : { json: { email } }));

describe('what the requester is told', () => {
  it('answers a known address and an unknown one identically', async () => {
    /**
     * The single most important property here. A form that distinguishes them is a free membership
     * check against the CMS, and the membership list is the list of people with publishing rights —
     * exactly who a phishing campaign wants named.
     */
    const known = await ask('staff@campus.edu');
    const unknown = await ask('nobody@campus.edu');

    expect(known.status).toBe(unknown.status);
    expect(await body(known)).toEqual(await body(unknown));
  });

  it('answers a deactivated account identically too', async () => {
    // The third case, and the one most likely to be missed: a real row that must not receive a
    // link, whose response must still look like the other two.
    await h.db.db.updateTable('users').set({ is_active: 0 }).execute();

    const deactivated = await ask('staff@campus.edu');
    expect(deactivated.status).toBe(200);
    expect(h.mail.sent).toHaveLength(0);
  });

  it('sends a form post to the same page whoever asked', async () => {
    const known = await ask('staff@campus.edu', true);
    const unknown = await ask('nobody@campus.edu', true);

    expect(location(known)).toBe('/admin/forgot-password?sent=1');
    expect(location(unknown)).toBe(location(known));
  });
});

describe('the message', () => {
  it('goes to the address on the account, carrying a link that works once', async () => {
    await ask('staff@campus.edu');

    expect(h.mail.sent).toHaveLength(1);
    expect(h.mail.last!.to).toBe('staff@campus.edu');

    const token = new URL(h.mail.last!.text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;
    await consumePasswordResetToken(h.db.db, token, 'a brand new passphrase');

    expect(await verifyCredentials(h.db.db, 'staff@campus.edu', 'a brand new passphrase')).toBeDefined();
    // Spent, so a link read out of an inbox twice cannot be used twice.
    await expect(
      consumePasswordResetToken(h.db.db, token, 'another passphrase entirely'),
    ).rejects.toThrow();
  });

  it('points the link at the configured origin, not at the request', async () => {
    // The link is read in a mail client with no memory of which host produced it, so a relative
    // URL or one built from a spoofable `Host` header would be unusable or hostile.
    await ask('staff@campus.edu');
    expect(h.mail.last!.text).toContain('http://localhost:4321/admin/set-password?token=');
  });

  it('still reports success when the mailer fails', async () => {
    /**
     * Saying "we could not send that" would leak that there was something to send — an unknown
     * address never reaches the sending line at all. The operator finds it in the logs, which is
     * where a broken webhook belongs.
     */
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.mail.failure = new Error('webhook down');

    const response = await ask('staff@campus.edu');

    expect(response.status).toBe(200);
    expect(error).toHaveBeenCalled();
  });
});

describe('when the site cannot send mail', () => {
  it('refuses rather than accepting a request it cannot fulfil', async () => {
    // With the log mailer the link goes to a terminal the requester cannot see. Accepting the
    // request would promise a message that is never coming.
    h.mail.delivers = false;

    const response = await ask('staff@campus.edu');

    expect(response.status).toBe(503);
    expect(h.mail.sent).toHaveLength(0);
  });

  it('refuses when password sign-in is turned off', async () => {
    // Nothing to reset: the account signs in through OAuth.
    h.auth.passwordAuthEnabled = false;

    expect((await ask('staff@campus.edu')).status).toBe(404);
  });
});

describe('throttling', () => {
  it('blocks after a handful of requests for one address', async () => {
    for (let i = 0; i < MAX_RESET_REQUESTS; i += 1) {
      expect((await ask('staff@campus.edu')).status).toBe(200);
    }

    const blocked = await ask('staff@campus.edu');
    expect(blocked.status).toBe(429);
  });

  it('counts an unknown address too, so the limit is not itself an oracle', async () => {
    // If only real accounts were counted, an attacker could tell them apart by which addresses
    // start returning 429 — the enumeration the wording closes, reopened through the rate limit.
    for (let i = 0; i < MAX_RESET_REQUESTS; i += 1) {
      await ask('nobody@campus.edu');
    }

    expect((await ask('nobody@campus.edu')).status).toBe(429);
  });

  it('cannot be used to lock somebody out of signing in', async () => {
    /**
     * The reason reset requests count in their own keyspace. Sharing the sign-in counter would mean
     * anyone could deny a colleague access for fifteen minutes by asking to reset their password a
     * few times — a denial of service handed out by an unauthenticated form.
     */
    for (let i = 0; i < MAX_RESET_REQUESTS * 2; i += 1) {
      await ask('staff@campus.edu');
    }

    const signIn = await checkThrottle(h.db.db, [emailKey('staff@campus.edu')], MAX_ATTEMPTS);
    expect(signIn.blocked).toBe(false);
  });
});

describe('bad input', () => {
  it('rejects a request with no address', async () => {
    expect((await forgotPassword(h.context({ json: {} }))).status).toBe(400);
  });
});
