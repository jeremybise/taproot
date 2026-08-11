import { describe, expect, it } from 'vitest';

import {
  WEBHOOK_TIMESTAMP_TOLERANCE,
  signWebhook,
  verifyWebhookSignature,
} from './signature.js';

/**
 * The one piece of this feature that runs on both sides of the wire.
 *
 * A verifier that disagrees with the signer does not deliver wrong events — it delivers none, and
 * the failure is a 401 in somebody else's log while the CMS reports every delivery as failed. So
 * these tests are written against the properties rather than against a fixed digest: a golden hex
 * string would pass just as happily if both halves were wrong in the same way.
 */

const SECRET = 'whsec_0123456789abcdef';
const BODY = JSON.stringify({ id: 'd1', event: 'item.published' });

describe('webhook signatures', () => {
  it('verifies what it signed', async () => {
    const header = await signWebhook(SECRET, BODY);

    expect(await verifyWebhookSignature({ secret: SECRET, body: BODY, header })).toBe(true);
  });

  it('refuses a body that changed by one character', async () => {
    const header = await signWebhook(SECRET, BODY);

    expect(
      await verifyWebhookSignature({
        secret: SECRET,
        body: BODY.replace('item.published', 'item.unpublished'),
        header,
      }),
    ).toBe(false);
  });

  it('refuses a different secret', async () => {
    const header = await signWebhook(SECRET, BODY);

    expect(
      await verifyWebhookSignature({ secret: `${SECRET}x`, body: BODY, header }),
    ).toBe(false);
  });

  /**
   * The property the whole timestamp scheme exists for, and the one a body-only signature loses.
   *
   * An attacker who captured a request replays it with a fresh `t` so the tolerance check passes.
   * If the timestamp were merely *beside* the signature rather than inside the signed message, the
   * digest would still verify and the replay would succeed — which is exactly what this asserts
   * cannot happen. Proven by mutation: signing `body` alone instead of `${t}.${body}` makes this
   * the only test that fails.
   */
  it('cannot be replayed by restamping the header with a fresh timestamp', async () => {
    const signedAt = 1_000_000;
    const original = await signWebhook(SECRET, BODY, signedAt);
    const digest = original.split('v1=')[1]!;

    const now = signedAt + 86_400;
    const restamped = `t=${now},v1=${digest}`;

    expect(
      await verifyWebhookSignature({ secret: SECRET, body: BODY, header: restamped, now }),
    ).toBe(false);
  });

  it('refuses a signature older than the tolerance', async () => {
    const signedAt = 1_000_000;
    const header = await signWebhook(SECRET, BODY, signedAt);

    expect(
      await verifyWebhookSignature({
        secret: SECRET,
        body: BODY,
        header,
        now: signedAt + WEBHOOK_TIMESTAMP_TOLERANCE + 1,
      }),
    ).toBe(false);

    // And accepts one inside it, or the assertion above would pass for a verifier that refuses
    // everything.
    expect(
      await verifyWebhookSignature({
        secret: SECRET,
        body: BODY,
        header,
        now: signedAt + WEBHOOK_TIMESTAMP_TOLERANCE - 1,
      }),
    ).toBe(true);
  });

  /**
   * Bounded in the future as well, which is the half that gets skipped.
   *
   * "Not older than five minutes" alone lets a signature stamped a year ahead sit inside the window
   * forever — a replay window with no end, produced by a check that reads as though it has one.
   */
  it('refuses a signature stamped in the future', async () => {
    const now = 1_000_000;
    const header = await signWebhook(SECRET, BODY, now + WEBHOOK_TIMESTAMP_TOLERANCE + 60);

    expect(await verifyWebhookSignature({ secret: SECRET, body: BODY, header, now })).toBe(false);
  });

  it('treats a malformed or absent header as unsigned', async () => {
    for (const header of [null, undefined, '', 'v1=deadbeef', 't=abc,v1=deadbeef', 'garbage']) {
      expect(await verifyWebhookSignature({ secret: SECRET, body: BODY, header })).toBe(false);
    }
  });
});
