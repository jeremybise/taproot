import { afterEach, describe, expect, it, vi } from 'vitest';

import { MailError, passwordResetEmail, resolveMailer } from './index.js';

/**
 * The mailer, and the constraint it exists to satisfy without breaking.
 *
 * `delivers` is the property everything else hangs off: it is what decides whether the admin offers
 * a "forgot password" link at all, so a mailer that quietly claimed to deliver would produce a form
 * whose success message is a lie.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe('choosing a mailer', () => {
  it('falls back to the log with nothing configured, and admits it delivers nothing', () => {
    // The half that keeps `npm run dev` free of an external service. A fresh clone gets a working
    // mailer that needs no account, no key, and no network.
    const mailer = resolveMailer({});

    expect(mailer.name).toBe('log');
    expect(mailer.delivers).toBe(false);
  });

  it('treats a blank URL as unset', () => {
    // `TAPROOT_MAIL_WEBHOOK_URL=` in a `.env` is someone turning it off, not configuring an empty
    // endpoint — and the alternative is a fetch to '' on every reset request.
    expect(resolveMailer({ TAPROOT_MAIL_WEBHOOK_URL: '   ' }).delivers).toBe(false);
  });

  it('uses the webhook once a URL is set', () => {
    const mailer = resolveMailer({ TAPROOT_MAIL_WEBHOOK_URL: 'https://hooks.example/mail' });

    expect(mailer.name).toBe('webhook');
    expect(mailer.delivers).toBe(true);
  });
});

describe('the log mailer', () => {
  it('writes the message rather than sending it', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await resolveMailer({}).send({ to: 'a@example.edu', subject: 'Hi', text: 'Link here' });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(info.mock.calls[0]![0]).toContain('a@example.edu');
    // The body included, link and all. Safe only because this mailer never reaches a deployment
    // that can send — `delivers` is false, so no reset request gets this far in production.
    expect(info.mock.calls[0]![0]).toContain('Link here');
  });
});

describe('the webhook mailer', () => {
  it('posts a flat JSON body and carries the from address', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 202 }));

    await resolveMailer({
      TAPROOT_MAIL_WEBHOOK_URL: 'https://hooks.example/mail',
      TAPROOT_MAIL_FROM: 'cms@campus.edu',
    }).send({ to: 'a@example.edu', subject: 'Hi', text: 'Body', html: '<p>Body</p>' });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hooks.example/mail');
    expect(JSON.parse(String(init.body))).toEqual({
      from: 'cms@campus.edu',
      to: 'a@example.edu',
      subject: 'Hi',
      text: 'Body',
      html: '<p>Body</p>',
    });
  });

  it('sends no authorization header when no token is set', async () => {
    // A secret path is a legitimate way to secure a webhook. Sending `Bearer undefined` would be
    // worse than sending nothing.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));

    await resolveMailer({ TAPROOT_MAIL_WEBHOOK_URL: 'https://hooks.example/mail' }).send({
      to: 'a@example.edu',
      subject: 'Hi',
      text: 'Body',
    });

    const headers = (fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it('attaches a bearer token when one is set', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));

    await resolveMailer({
      TAPROOT_MAIL_WEBHOOK_URL: 'https://hooks.example/mail',
      TAPROOT_MAIL_WEBHOOK_TOKEN: 's3cret',
    }).send({ to: 'a@example.edu', subject: 'Hi', text: 'Body' });

    const headers = (fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer s3cret');
  });

  it('throws on a non-2xx rather than reporting success', async () => {
    /**
     * The caller must be able to tell. Swallowing this would let the reset flow say "check your
     * inbox" about a message the webhook rejected — a user who believes they are being ignored,
     * and an operator with nothing in the logs.
     */
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));

    await expect(
      resolveMailer({ TAPROOT_MAIL_WEBHOOK_URL: 'https://hooks.example/mail' }).send({
        to: 'a@example.edu',
        subject: 'Hi',
        text: 'Body',
      }),
    ).rejects.toBeInstanceOf(MailError);
  });
});

describe('the reset message', () => {
  const message = passwordResetEmail({
    to: 'a@campus.edu',
    resetUrl: 'https://cms.campus.edu/admin/set-password?token=abc123',
    expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
    host: 'cms.campus.edu',
  });

  it('always has a plain-text part carrying the link', () => {
    // Some clients strip HTML entirely, and a reset link that only exists in markup is a reset
    // link those recipients cannot use.
    expect(message.text).toContain('https://cms.campus.edu/admin/set-password?token=abc123');
  });

  it('repeats the URL as text inside the HTML part', () => {
    // A styled button is unreachable in a client that blocks the anchor styling or renders it
    // oddly; the pasteable URL underneath is the fallback that always works.
    expect(message.html).toContain('Choose a new password');
    expect(message.html?.match(/token=abc123/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('names no account in the subject, which is visible on a lock screen', () => {
    expect(message.subject).toBe('Reset your password on cms.campus.edu');
    expect(message.subject).not.toContain('a@campus.edu');
  });

  it('says the request may not have been theirs, and that nothing has happened yet', () => {
    // The message reaches people who did not ask for it, by design — that is what an unauthenticated
    // form guarantees. Telling them their password still works is the difference between a reset
    // link and a phishing scare.
    expect(message.text).toMatch(/current password still works/);
  });
});
