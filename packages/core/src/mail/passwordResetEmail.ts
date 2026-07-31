import type { MailMessage } from './mailer.js';

/**
 * The one message Taproot sends.
 *
 * Composed in core rather than in the route for the reason `resolveSeo` is: there is already a
 * second caller in prospect — an admin who wants the same link mailed rather than copied — and two
 * copies of this text would drift, with the divergence showing up in somebody's inbox rather than
 * in a test.
 *
 * **No user-supplied content goes in.** Not the recipient's name, not the site title, nothing an
 * editor can type. The HTML part is assembled by hand and never escaped, so the way to be sure it
 * cannot carry markup is for there to be nothing in it that could — `host` comes from
 * `AuthConfig.origin`, which is an environment variable, and the URL is a hex token on a path this
 * code wrote.
 */
export function passwordResetEmail(options: {
  to: string;
  resetUrl: string;
  expiresAt: Date;
  /** Hostname of the site, from configured origin — for "you asked on X", not decoration. */
  host: string;
}): MailMessage {
  const { to, resetUrl, expiresAt, host } = options;

  const hours = Math.round((expiresAt.getTime() - Date.now()) / (60 * 60 * 1000));
  const validFor = `This link works once and expires in about ${hours} hours.`;

  const text = [
    `Someone asked to reset the password for this address on ${host}.`,
    '',
    'Open this link to choose a new one:',
    resetUrl,
    '',
    validFor,
    '',
    'If it was not you, nothing has happened yet and you can ignore this message. Your',
    'current password still works and no one has been signed in.',
  ].join('\n');

  /**
   * Inline styles and a table-free layout, because email clients are not browsers: no external
   * stylesheet is fetched, `<style>` blocks are stripped by several of them, and a bare `<a>` with
   * the URL repeated below it survives everywhere including a client that renders no HTML at all.
   */
  const html = [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a">',
    `<p>Someone asked to reset the password for this address on <strong>${host}</strong>.</p>`,
    `<p><a href="${resetUrl}" style="display:inline-block;padding:10px 18px;background:#1a1a1a;color:#ffffff;border-radius:6px;text-decoration:none">Choose a new password</a></p>`,
    `<p style="font-size:13px;color:#555">Or paste this into your browser:<br><span style="word-break:break-all">${resetUrl}</span></p>`,
    `<p style="font-size:13px;color:#555">${validFor}</p>`,
    '<p style="font-size:13px;color:#555">If it was not you, nothing has happened yet and you can ignore this message. Your current password still works and no one has been signed in.</p>',
    '</div>',
  ].join('');

  return {
    to,
    // Deliberately says nothing about which account or whether one exists — a subject line is
    // visible on a lock screen.
    subject: `Reset your password on ${host}`,
    text,
    html,
  };
}
