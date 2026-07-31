/**
 * Sending mail, and the standing constraint it had to be reconciled with.
 *
 * SCOPE recorded that Taproot sends no email, on the reasoning that an external service dependency
 * is what would stop `npm run dev` working from a fresh clone. That reasoning is right and is kept
 * here — what was wrong was reading it as "no mail, ever", because self-service password reset is
 * *defined* by reaching someone who cannot sign in. There is no non-email version of it: an admin
 * handing over a link is the flow that already exists, and it is not self-service.
 *
 * So the constraint is honoured where it actually bites. With nothing configured the mailer writes
 * the message to the server log, which needs no account, no key, and no network — a developer sees
 * the reset link in the terminal and the whole flow works on a laptop. Configuring a webhook is
 * what turns it into real delivery.
 *
 * **No vendor is built in.** Resend, Postmark, SES and SendGrid each have their own payload shape,
 * auth header, and error semantics, and a CMS that ships no block templates and holds no opinion
 * about term URLs should not be maintaining four of them. A webhook reaches all of them through a
 * handful of lines on the operator's side, and adding a first-party provider later is additive.
 */

export interface MailMessage {
  to: string;
  subject: string;
  /** Always present. Some recipients strip HTML, and a reset link must survive that. */
  text: string;
  html?: string;
}

export interface Mailer {
  /**
   * Reported on Settings → System, so an operator can see which one is live.
   *
   * A free string rather than a union of the two built in, because the point of the interface is
   * that it has more than two implementations — a test double is already a third.
   */
  readonly name: string;
  /**
   * Whether mail actually leaves the building.
   *
   * The log mailer is a working mailer for development and a dead end in production, and the
   * difference decides whether the admin offers a "forgot password" link at all — a link that
   * silently posts into a log nobody reads is worse than no link.
   */
  readonly delivers: boolean;
  send(message: MailMessage): Promise<void>;
}

export class MailError extends Error {
  override name = 'MailError';
}

export interface MailEnv {
  /** Where to POST the message. Its presence is what switches real delivery on. */
  TAPROOT_MAIL_WEBHOOK_URL?: string;
  /** Sent as `authorization: Bearer …`, if set. Optional — a secret path is a valid choice too. */
  TAPROOT_MAIL_WEBHOOK_TOKEN?: string;
  /** The `from` address, passed through to the webhook so it does not have to hardcode one. */
  TAPROOT_MAIL_FROM?: string;
}

/**
 * Writes the message where a developer will see it and goes no further.
 *
 * The body is logged in full, reset link included. That is a deliberate exception to keeping
 * credentials out of logs, and it is safe only because `delivers` is false — this mailer is
 * unreachable on a deployment that has configured one, and on one that has not, no reset request
 * can be made in the first place.
 */
function logMailer(): Mailer {
  return {
    name: 'log',
    delivers: false,
    async send(message) {
      console.info(
        `[taproot] mail not sent — no TAPROOT_MAIL_WEBHOOK_URL configured.\n` +
          `  to:      ${message.to}\n` +
          `  subject: ${message.subject}\n` +
          `${message.text.replace(/^/gm, '  ')}`,
      );
    },
  };
}

/**
 * POSTs `{ from, to, subject, text, html }` as JSON and expects a 2xx.
 *
 * Flat and boring on purpose: the receiving end is five lines in front of whichever sender the
 * operator already pays for, and a shape with no nesting is one they can map without reading these
 * docs twice.
 */
function webhookMailer(url: string, token: string | undefined, from: string | undefined): Mailer {
  return {
    name: 'webhook',
    delivers: true,
    async send(message) {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ from, ...message }),
      });

      /**
       * A failure throws rather than returning false.
       *
       * The one caller is password reset, which must not tell someone to check their inbox for a
       * message that was never accepted. Swallowing this would turn a broken webhook into a user
       * who believes they are being ignored.
       */
      if (!response.ok) {
        throw new MailError(
          `Mail webhook responded ${response.status}. The message was not delivered.`,
        );
      }
    },
  };
}

export function resolveMailer(env: MailEnv): Mailer {
  const url = env.TAPROOT_MAIL_WEBHOOK_URL?.trim();
  if (!url) return logMailer();
  return webhookMailer(url, env.TAPROOT_MAIL_WEBHOOK_TOKEN?.trim(), env.TAPROOT_MAIL_FROM?.trim());
}
